/**
 * 跑一条用例前的数据准备（全量回归和单条发送共用），按「查/增/改/删」分路：
 *  · 查询：借一条真实数据填 id（只读）。GET 借不到仍造行（老行为），POST 查询不造；
 *  · 新增：造关联数据，不回填主键（回填反而撞唯一键）；
 *  · 修改 / 删除：造一行，id 对准这一行；
 *  · 认不出：按请求方法走老办法。
 * 「按 xxx 查」从关联表取这个条件的真实值，取不到就跳过这条用例。
 * 前置数据只给正常用例：边界 0/-1、异常假数据就是去打「数据不存在」的分支。
 */
import type { ApiMethod, TableRelation, TestCase } from '../types'
import { applyReadBackfill, type FixtureSession } from '../data/prepare'
import { parsePreservingBig, stringifyPreservingBig } from '../../bigIntJson'
import { apiActionOf, isCallbackApi } from '../cases/apiAction'

export interface PreparedCase {
  testCase: TestCase
  log: string[]
  /** 有值 = 这条不发，记一条跳过结果，原因给人看 */
  skip?: string
}

const NUMERIC = /^(int|integer|long|short|byte|double|float|bigdecimal|biginteger)$/i

/** 把「按 xxx 查」的真实值落进请求：query 直接填，body 写进顶层字段（数值字段给 JSON 数字） */
export function applyQueryValue(api: ApiMethod, tc: TestCase, value: string): TestCase {
  const q = tc.queryBy!
  if (q.position === 'query') return { ...tc, parameters: { ...tc.parameters, [q.field]: value } }
  let body: Record<string, unknown> = {}
  if (typeof tc.parameters.__body === 'string') {
    try {
      const b: unknown = parsePreservingBig(tc.parameters.__body)
      if (b && typeof b === 'object' && !Array.isArray(b)) body = b as Record<string, unknown>
    } catch {
      body = {}
    }
  }
  const jt = api.requestBodyFields.find((f) => f.name === q.field)?.javaType ?? ''
  const n = Number(value)
  body[q.field] = NUMERIC.test(jt.trim()) && value.trim() !== '' && Number.isSafeInteger(n) ? n : value
  return { ...tc, parameters: { ...tc.parameters, __body: stringifyPreservingBig(body) } }
}

export async function prepareCaseData(
  api: ApiMethod,
  testCase: TestCase,
  relations: TableRelation[],
  fx: FixtureSession | undefined,
): Promise<PreparedCase> {
  const log: string[] = []
  let tc = testCase
  if (fx && isCallbackApi(api)) return { testCase: tc, log: ['回调接口：发送前不借数造数'] }
  if (tc.queryBy) {
    if (!fx) return { testCase: tc, log, skip: `没取到真实值：没连库，「按 ${tc.queryBy.field} 查」不发` }
    const got = await fx.queryValueFor(relations, tc.queryBy.field)
    log.push(...got.log)
    if (got.value === undefined) {
      return { testCase: tc, log, skip: `没取到真实值：关联表里对不上 ${tc.queryBy.field} 这一列，或者表是空的` }
    }
    log.push(`按条件查：${tc.queryBy.field}=${got.value}（取自 ${got.table}.${got.col}）`)
    return { testCase: applyQueryValue(api, tc, got.value), log }
  }
  if (!fx || tc.type !== 'normal' || tc.probeNotFound) return { testCase: tc, log }

  const action = apiActionOf(api)
  const canBorrow = action === 'query' || (action === 'unknown' && api.httpMethod === 'GET')
  if (canBorrow) {
    const b = await fx.borrowFor(api, relations)
    log.push(...b.log)
    if (b.backfill) {
      const applied = applyReadBackfill(tc.parameters, b.backfill)
      log.push(...applied.filled)
      if (applied.filled.length) return { testCase: { ...tc, parameters: applied.values }, log }
    }
    // POST 查询借不到就算了：为一条查询往库里造行是白写库
    if (action === 'query' && api.httpMethod !== 'GET') return { testCase: tc, log }
  }
  log.push(...(await fx.prepareFor(api, relations, tc.parameters)))
  // 打在自己造的行上：改删把 id 形字段对准刚造的行（inject：body 里没有也写进去）。
  // 新增是 create 语义，回填主键反而撞唯一键；认不出的 POST 同此（老行为）
  const aim = action === 'update' || action === 'delete' || (action !== 'insert' && api.httpMethod !== 'POST')
  if (aim) {
    const applied = applyReadBackfill(tc.parameters, fx.fillsFor(api.id), true)
    log.push(...applied.filled)
    if (applied.filled.length) tc = { ...tc, parameters: applied.values }
    else if (action === 'update' || action === 'delete') {
      log.push('没对准自己造的行：id 保持不存在的值，这条不会改到库里的真数据（多半会报「不存在」）')
    }
  }
  return { testCase: tc, log }
}
