/**
 * 单条用例的判定。**四个调用点（试跑 / 全量回归 / 报告单条重跑 / 只重跑失败）
 * 必须共用 judgeCase 这一个函数**——原来状态码判定就是四份拷贝，于是
 * 「期望为空 = 不校验」这条语义四处都漏掉了：`[].includes(200)` 恒 false，
 * 界面写着「任意」，判定干的却是「什么都不对」，边界/异常用例一律假失败。
 *
 * 响应体断言（judgeCase 比 caseOk 多出的一层）补的是另一类假绿：
 * BizException 回 HTTP 200 + 错误信封（{msg, code, level:"error"}），
 * 状态码全绿、业务全是红的。体断言按 JSONPath 取值判定，抓的就是信封。
 *
 * 结构断言（第 6 参带上了才跑）补的是第三类：HTTP 200 + 合法 JSON，但结构
 * 对不上扫描字典里响应类型的字段清单——信封顶包成功、字段被悄悄改名。观察
 * 模式（env.assertMode='observe'，默认）差异只记录进 schemaIssues 不判失败，
 * 严格模式才折进 ok。资格门（只校验正常用例等口径）在 schemaCheck。
 */
import { JSONPath } from 'jsonpath-plus'
import type { BodyExpect } from '../types'
import { parsePreservingBig, unwrapSentinelStrings } from '../../bigIntJson'
import { schemaIssuesFor, type SchemaAssertInput } from '../scan/schemaAssert'
import { queryByFails, type QueryByCheck } from './queryBy'

export interface JudgeOutcome {
  ok: boolean
  /** 响应体断言失败明细。HTTP 层失败时恒为空 —— 一层一个原因，404 时信封断言是噪音 */
  assertFails: string[]
  /** 结构断言差异。观察模式只记录不算失败；HTTP 层失败时恒为空（同体断言） */
  schemaIssues: string[]
}

/**
 * 分层判定：
 * ① 请求层失败（`error` 有值 / 没拿到状态码）→ 不过，没体可断；
 * ② HTTP 不在期望 → 不过，体断言和结构断言都不跑；
 * ③ HTTP 过了才跑体断言 + 结构断言 —— 明细分别落 `assertFails` / `schemaIssues`，
 *    严格模式下结构差异也折进 ok。
 */
export function judgeCase(
  expectedHttpStatus: readonly number[],
  expectBody: readonly BodyExpect[] | undefined,
  httpStatus: number | null,
  error: string | undefined,
  bodyText: string | null | undefined,
  schema?: SchemaAssertInput | null,
  queryBy?: QueryByCheck | null,
): JudgeOutcome {
  if (!caseOk(expectedHttpStatus, httpStatus, error)) {
    return { ok: false, assertFails: [], schemaIssues: [] }
  }
  // 「按 xxx 查」先过信封再核对列表：接口都报错了，列表空不空不用再说
  const bodyFails = evalBodyExpects(expectBody ?? [], bodyText)
  const assertFails = bodyFails.length || !queryBy ? bodyFails : queryByFails(queryBy, bodyText)
  const schemaIssues = schema ? schemaIssuesFor(schema.responseType, schema.dict, bodyText) : []
  return {
    ok: assertFails.length === 0 && (!schema?.strict || schemaIssues.length === 0),
    assertFails,
    schemaIssues,
  }
}

/**
 * 期望列表为空 = **不校验状态码**，只要请求发出去了就算过。
 * 用在两种场合：用户在报告里手动清空期望（明确表示「这条我不断言」）、
 * 以及还没定下断言口径的用例类型。
 *
 * 发不出去（`error` 有值）或压根没拿到状态码（`httpStatus` 为 null）一律不算过——
 * 那是连通性问题，跟「期望什么状态码」是两回事，不能被「不校验」放行。
 */
export function caseOk(
  expectedHttpStatus: readonly number[],
  httpStatus: number | null,
  error: string | undefined,
): boolean {
  if (error !== undefined) return false
  if (httpStatus === null) return false
  if (expectedHttpStatus.length === 0) return true
  return expectedHttpStatus.includes(httpStatus)
}

/** 值归一：==/!= 按「用户肉眼所见」比较。信封 code 有数字有字符串，
 *  0 和 "0" 必须算相等——照 JSON.stringify 走会把字符串 "0" 变 "\"0\""，
 *  用户对着界面填 0 永远红。数组/对象 stringify（截断防刷屏）。 */
function normalize(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'object') {
    const s = JSON.stringify(v)
    return s.length > 120 ? `${s.slice(0, 119)}…` : s
  }
  return String(v)
}

/** 信封的成败字段：对它们的 != 断言失败就是业务失败 */
const ENVELOPE_PATHS = new Set(['$.level', '$.code'])
const BIZ_FAIL = '接口返回业务失败：'

/** 默认加到正常用例上的信封检查。常见的统一返回：成功 code="200"、失败 "500"、
 *  specialFail "501"；其它码（如自定义的 498/499）不算失败。没有这些字段的响应取不到值算过 */
export const DEFAULT_ENVELOPE_EXPECTS: readonly BodyExpect[] = [
  { path: '$.level', op: '!=', value: 'error' },
  { path: '$.code', op: '!=', value: '500' },
  { path: '$.code', op: '!=', value: '501' },
]

/** 响应是不是信封报的业务失败（库变化提示只在接口说成功时才给） */
export function isEnvelopeFail(bodyText: string | null | undefined): boolean {
  // 不是 JSON 的响应谈不上信封失败
  return evalBodyExpects(DEFAULT_ENVELOPE_EXPECTS, bodyText).some((s) => s.startsWith(BIZ_FAIL))
}

/** 逐条跑体断言。响应体在这里才 parse：runCase 抓包时只留了 preview（pretty + 截断），
 *  断言要的是原始文本，所以走 runCase 另带的 responseBodyText。 */
function evalBodyExpects(expects: readonly BodyExpect[], bodyText: string | null | undefined): string[] {
  if (!expects.length) return []
  let root: unknown
  try {
    // BOM 是抓包/代理最常见的杂质，strip 掉再 parse。
    // 大整数安全：雪花 id 当数字 parse 必丢精度（…1905 变 …2000），期望比对
    // 就永远对不上——哨兵字符串在这里换成数字字符串，按字符串比对能对上
    root = unwrapSentinelStrings(parsePreservingBig((bodyText ?? '').replace(/^\uFEFF/, '')))
  } catch {
    return ['响应不是合法 JSON，无法做响应体断言']
  }
  const fails: string[] = []
  // 信封失败（level=error / code=500）直接拿后端 msg 当原因；默认三条常一起命中，只报一次
  const msg = root && typeof root === 'object' && typeof (root as { msg?: unknown }).msg === 'string'
    ? ((root as { msg: string }).msg).trim()
    : ''
  let bizFailed = false
  for (const ex of expects) {
    const path = ex.path.trim() || '$'
    let hits: unknown[]
    try {
      // eval:false = 关掉路径里的脚本表达式 ?(...)（老版本叫 preventEval）——
      // 断言是配置不是代码，别给它执行通道。写错的表达式会 throw，落「路径不合法」
      hits = JSONPath({ path, json: root as object, wrap: true, eval: false }) as unknown[]
    } catch (e) {
      fails.push(`${path}：路径不合法（${String(e)}）`)
      continue
    }
    const want = ex.value.trim()
    switch (ex.op) {
      case 'exists':
        if (!hits.length) fails.push(`${path}：期望存在，实际取不到值`)
        break
      case 'notExists':
        if (hits.length) {
          fails.push(`${path}：期望不存在，实际 ${normalize(hits[0])}${hits.length > 1 ? `（共 ${hits.length} 处）` : ''}`)
        }
        break
      case '==':
      case 'contains': {
        // 取不到值没法比：给可读原因而不是静默放行
        if (!hits.length) {
          fails.push(`${path}：取不到值，没法跟「${want || '（空）'}」比对`)
          break
        }
        // 多匹配值全部须满足：一个 path 命中多处（$.errors[*].code）时按最严格口径，
        // 要「任一」请把路径写精确
        for (const h of hits) {
          const actual = normalize(h)
          if (ex.op === '==' && actual !== want) {
            fails.push(`${path}：期望 ${want || '（空）'}，实际 ${actual}`)
            break
          }
          if (ex.op === 'contains' && !actual.includes(want)) {
            fails.push(`${path}：期望包含 ${want}，实际 ${actual}`)
            break
          }
        }
        break
      }
      case '!=':
      case 'notContains': {
        // 取不到值时 !=/notContains 算过：信封字段成功时常常整个不存在，
        // ($.level != "error" 的本意就是「成功时这字段没了」)。要显式断存在用 exists
        for (const h of hits) {
          const actual = normalize(h)
          if (ex.op === '!=' && actual === want && ENVELOPE_PATHS.has(path)) {
            if (!bizFailed) fails.push(`${BIZ_FAIL}${msg || `${path} = ${actual}`}`)
            bizFailed = true
            break
          }
          if (ex.op === '!=' && actual === want) {
            fails.push(`${path}：期望不等于 ${want}，实际 ${actual}`)
            break
          }
          if (ex.op === 'notContains' && actual.includes(want)) {
            fails.push(`${path}：期望不包含 ${want}，实际 ${actual}`)
            break
          }
        }
        break
      }
    }
  }
  return fails
}
