/**
 * 响应结构断言：扫描字典里本来就躺着响应类型的字段清单（bodyFields 的 TypeDict，
 * 原本给响应 JSON 的 key 标含义用），拿它对实际响应做一层结构比对——「HTTP 200 +
 * 合法 JSON，但结构不对」的问题在这层现形：错误信封顶包成功、字段被悄悄改名、
 * 网关错误页，状态码校验不住的这里都能抓到。
 *
 * 口径（2026-09-28 拍板）：
 * - **只校验正常用例**（type==='normal' 且非 probeNotFound）：边界 0/-1、异常假数据、
 *   未找到配对本来就打错误分支，回错误信封是预期行为，校验它们全是噪音；
 * - 只报三类：必填字段缺失 / 必填字段为 null / 类型不符。**多余字段不报**——Java
 *   序列化的噪音（懒加载代理、基类审计字段）远多于真缺陷，报了没人看；
 * - 大整数按「数字字符串」放行：雪花 id 经 parsePreservingBig + unwrap 出来是
 *   字符串（bigIntJson 的口径），按 number 硬卡会天天误报；
 * - 日期类声明（Date/Timestamp）数字也放行：Jackson 默认把 java.util.Date 序列化成
 *   epoch 毫秒，是同一信息的另一种合法形态。
 *
 * 判不判失败归 judgeCase：观察模式（env.assertMode='observe'，默认）只记录进
 * schemaIssues 给报告看，严格模式折进 ok。
 */
import type { DtoField, TestCase } from '../types'
import type { TypeDict } from './bodyFields'
import { parsePreservingBig, unwrapSentinelStrings } from '../../bigIntJson'

/** judgeCase 的第 6 参：带上了就做结构校验；strict 决定差异是否折进 ok */
export interface SchemaAssertInput {
  responseType: string
  dict: TypeDict
  strict: boolean
}

/** 结构校验的资格门。返回 null = 这条用例不做结构校验（judgeCase 第 6 参传 null） */
export function schemaCheck(
  responseType: string | null | undefined,
  tc: Pick<TestCase, 'type' | 'probeNotFound'>,
  dict: TypeDict | undefined,
  strict: boolean,
): SchemaAssertInput | null {
  if (!dict || !responseType) return null
  if (tc.type !== 'normal' || tc.probeNotFound) return null
  const rt = simpleOf(responseType)
  // 字典里没有的类型（Map / String / 外部 jar 的 VO）没有字段清单可言
  if (!dict.has(rt)) return null
  return { responseType: rt, dict, strict }
}

/**
 * 按字典对响应做结构比对，返回人话差异清单（空 = 结构对得上 / 没得比）。
 * responseType 必须已在 dict 里（schemaCheck 把过关）；bodyText 是 runCase 抓的
 * 原始响应文本（未截断到断言不可用的程度，同体断言口径）。
 */
export function schemaIssuesFor(
  responseType: string,
  dict: TypeDict,
  bodyText: string | null | undefined,
): string[] {
  const rt = simpleOf(responseType)
  const fields = dict.get(rt)
  if (!fields || fields.length === 0) return []
  // 空体（204 / DELETE 回空）没有结构可言，不算违规
  if (!bodyText) return []
  let root: unknown
  try {
    // BOM / 大整数与体断言同一套处理：bigIntJson 的注释在这边不重复
    root = unwrapSentinelStrings(parsePreservingBig(bodyText.replace(/^\uFEFF/, '')))
  } catch {
    return [`响应不是合法 JSON，没法按 ${rt} 做结构比对`]
  }
  const ctx: Ctx = { dict, issues: [], shape: new Set(), overflow: 0 }
  if (Array.isArray(root)) {
    // 声明是 DTO、实际回数组：按「元素就是它」校验——List<X> 的泛型被老扫描器
    // 剥掉时 responseType 常只剩元素名，这个形态是真的存在
    validateArray(root, rt, '$', 1, new Set(), ctx)
  } else if (isPlainObject(root)) {
    let target: unknown = root
    let basePath = '$'
    // 根上没有一个声明字段时拨一层包装：Result<T>{code,msg,data}、分页{total,list}。
    // 拨错了顶多多报一行，不拨会整页误报「字段全缺」，所以只认这几个通用载体名
    if (!fields.some((f) => f.name in root)) {
      for (const k of WRAPPER_KEYS) {
        const w = (root as Record<string, unknown>)[k]
        if (isPlainObject(w) || Array.isArray(w)) {
          target = w
          basePath = `$.${k}`
          break
        }
      }
    }
    if (Array.isArray(target)) validateArray(target, rt, basePath, 1, new Set(), ctx)
    else validateObject(target, rt, fields, basePath, 1, new Set(), ctx)
  } else if (root !== null) {
    report(ctx, '$', 'scalar', `响应是标量（${describe(root)}），按 ${rt} 对不上结构`)
  }
  if (ctx.overflow > 0) ctx.issues.push(`（结构差异只列前 ${MAX_ISSUES} 条，其余 ${ctx.overflow} 条省略）`)
  return ctx.issues
}

/* ================= 内部：类型判别与递归校验 ================= */

const MAX_ISSUES = 10
const MAX_DEPTH = 4
const MAX_LIST_ELEMENTS = 10

/** 包装层的通用载体名：拨一层只认这几个，别的键名不敢乱进 */
const WRAPPER_KEYS = ['data', 'result', 'list', 'rows', 'records']

interface Ctx {
  dict: TypeDict
  issues: string[]
  /** 同形差异只报一条：数组 20 行都缺同一个必填字段时，不去把报告刷成 20 行 */
  shape: Set<string>
  overflow: number
}

function report(ctx: Ctx, path: string, kind: string, text: string): void {
  // 数组下标抹平再判重：$.list[3].id 和 $.list[7].id 的「缺失」是同一个差异。
  // 判重键用 kind 不用全文——差异文本里带着带下标的路径，按全文判重永远判不掉
  const key = `${path.replace(/\[\d+\]/g, '[*]')}|${kind}`
  if (ctx.shape.has(key)) return
  if (ctx.issues.length >= MAX_ISSUES) {
    ctx.overflow += 1
    return
  }
  ctx.shape.add(key)
  ctx.issues.push(text)
}

/** 类简名：字典按简名建（SysBrand），字段类型可能带包名（com.a.SysBrand）。
 *  只给非泛型类型用——泛型串里有点号，别拿它去切 */
function simpleOf(javaType: string): string {
  const t = javaType.trim()
  return t.includes('<') ? t : (t.split('.').pop() ?? t)
}

/** 集合泛型实参：List<X> / Xxx[] → X；裸 List（老扫描器剥过泛型）认不出，null = 元素类型未知 */
function elemTypeOf(javaType: string): string | null {
  const t = javaType.trim()
  const m = /^(?:list|set|collection|iterable|arraylist|linkedlist|hashset|linkedhashset|queue|deque|stack|vector)<(.+)>$/i.exec(
    t,
  )
  if (m) return m[1]!.trim()
  if (t.endsWith('[]')) return t.slice(0, -2).trim()
  return null
}

type JsonKind = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any'

const NUMBERY = /^(int|integer|short|long|biginteger|double|float|bigdecimal|number)$/
const STRINGY = /^(string|char|character|charsequence|uuid)$/
/** Jackson 默认把 java.util.Date 序列化成 epoch 毫秒：日期声明对数字放行 */
const DATISH = /^(date|timestamp|instant|localdate|localdatetime|localtime|zoneddatetime|offsetdatetime)$/
const COLLECTY = /^(?:list|set|collection|iterable|arraylist|linkedlist|hashset|linkedhashset|queue|deque|stack|vector)\b/i

function jsonKindOf(javaType: string): JsonKind {
  const raw = javaType.trim()
  if (raw.endsWith('[]') || COLLECTY.test(raw)) return 'array'
  const t = simpleOf(raw).toLowerCase()
  if (NUMBERY.test(t)) return 'number'
  if (t === 'boolean') return 'boolean'
  if (STRINGY.test(t) || DATISH.test(t)) return 'string'
  if (t === 'map' || raw.toLowerCase().startsWith('map<') || t === 'object' || t === 'jsonobject') return 'object'
  return 'any'
}

/** 数值字段的放行口径：真数字，或「数字字符串」——雪花 id unwrap 出来就是字符串 */
function looksNumeric(v: unknown): boolean {
  if (typeof v === 'number') return true
  if (typeof v === 'string' && v.trim() !== '') return Number.isFinite(Number(v))
  return false
}

/** 实际值给人看的一句话：类型 + 短样本，类型不符的原因一眼可读 */
function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return `数组（${v.length} 个元素）`
  if (typeof v === 'object') return '对象'
  if (typeof v === 'string') {
    const s = v.length > 40 ? `${v.slice(0, 39)}…` : v
    return `字符串 ${JSON.stringify(s)}`
  }
  return String(v)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 按字段清单校验一个对象。seen 只沿当前引用链记（A→B→A 的环到链上已见类型止步） */
function validateObject(
  value: unknown,
  typeName: string,
  fields: readonly DtoField[],
  path: string,
  depth: number,
  seen: Set<string>,
  ctx: Ctx,
): void {
  if (!isPlainObject(value)) {
    report(ctx, path, 'shape', `${path}：应按 ${typeName} 出对象，实际 ${describe(value)}`)
    return
  }
  if (depth > MAX_DEPTH || seen.has(typeName)) return
  seen.add(typeName)
  try {
    for (const f of fields) {
      const p = path === '$' ? `$.${f.name}` : `${path}.${f.name}`
      if (!(f.name in value)) {
        if (f.required) report(ctx, p, 'missing', `${p}：必填字段缺失（声明 ${f.javaType}）`)
        continue
      }
      const v = value[f.name]
      if (v === null || v === undefined) {
        if (f.required) report(ctx, p, 'null', `${p}：必填字段为 null`)
        continue
      }
      checkValue(v, f, p, depth, seen, ctx)
    }
    // 多余字段刻意不报：懒加载代理、基类审计字段这类序列化噪音远多于真缺陷
  } finally {
    seen.delete(typeName)
  }
}

/** 集合元素校验：元素是字典里的类型就整对象递归，是标量就按类型比对。只看前
 *  MAX_LIST_ELEMENTS 个——差异同形判重（report 的 [*] 抹平），列表长不长信号都一样 */
function validateArray(
  arr: unknown[],
  elemType: string,
  path: string,
  depth: number,
  seen: Set<string>,
  ctx: Ctx,
): void {
  const simple = simpleOf(elemType)
  const nested = ctx.dict.get(simple)
  const kind = jsonKindOf(elemType)
  const n = Math.min(arr.length, MAX_LIST_ELEMENTS)
  for (let i = 0; i < n; i++) {
    const ip = `${path}[${i}]`
    const v = arr[i]
    // 元素 null 不判：占位 / 删除标记这类语义太杂，报了多半是误会
    if (v === null || v === undefined) continue
    if (nested && nested.length) {
      validateObject(v, simple, nested, ip, depth + 1, seen, ctx)
      continue
    }
    if (kind === 'any' || kind === 'array' || kind === 'object') continue
    checkValue(v, { name: '', javaType: elemType, required: false }, ip, depth, seen, ctx)
  }
}

function checkValue(v: unknown, f: DtoField, p: string, depth: number, seen: Set<string>, ctx: Ctx): void {
  const jt = f.javaType.trim()
  // 集合先行：List<X> 的「简名」切出来是垃圾，必须在 simpleOf 之前处理
  const elem = elemTypeOf(jt)
  if (elem !== null) {
    if (!Array.isArray(v)) {
      report(ctx, p, 'type', `${p}：声明 ${jt}，实际 ${describe(v)}`)
      return
    }
    validateArray(v, elem, p, depth, seen, ctx)
    return
  }
  const simple = simpleOf(jt)
  const nested = ctx.dict.get(simple)
  if (nested && nested.length) {
    validateObject(v, simple, nested, p, depth + 1, seen, ctx)
    return
  }
  const kind = jsonKindOf(jt)
  switch (kind) {
    case 'number':
      if (!looksNumeric(v)) report(ctx, p, 'type', `${p}：声明 ${f.javaType}（数字），实际 ${describe(v)}`)
      return
    case 'boolean':
      if (typeof v !== 'boolean') report(ctx, p, 'type', `${p}：声明 ${f.javaType}（布尔），实际 ${describe(v)}`)
      return
    case 'string':
      if (typeof v === 'string') return
      if (DATISH.test(simple.toLowerCase()) && looksNumeric(v)) return
      report(ctx, p, 'type', `${p}：声明 ${f.javaType}（字符串），实际 ${describe(v)}`)
      return
    case 'array':
      if (!Array.isArray(v)) report(ctx, p, 'type', `${p}：声明 ${f.javaType}（数组），实际 ${describe(v)}`)
      return
    case 'object':
      if (!isPlainObject(v)) report(ctx, p, 'type', `${p}：声明 ${f.javaType}（对象），实际 ${describe(v)}`)
      return
    default:
      return // 字典和基础类型都认不出：不校验，不编
  }
}
