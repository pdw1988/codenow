/**
 * 单用例执行编排，技术方案 §2.5「单 API / 单用例」。
 *
 * 顺序是产品命门（PRD 模块 4.3）：先快照 → 发请求 → 再快照 → diff。
 * 快照的 SQL 生成与 diff 全在 dbdiff 纯函数里，这里只负责把 IO 串起来。
 *
 * 闸门约束（技术方案 §三）：快照只走 query（只读），造数清理走
 * execSql/insertRows，绝不混淆。
 */
import type {
  ApiMethod,
  DbChangeSummary,
  EnvironmentConfig,
  TableRelation,
  TestCase,
} from '../types'
import type { LiveDbDialect } from '../../dbDialect'
import { buildRequest, sendRequest, type BuiltRequest } from '../http/request'
import { fullBodyOf, previewOf } from '../http/prettyJson'
import { buildSnapshot, diffTables, planSnapshot, type SnapshotInputs } from '../dbdiff/dbdiff'
import { applyReadBackfill, type FixtureSession } from '../data/prepare'
import { isMissingTableError, missingTableNote } from './missingTable'
import { isCallbackApi, isReadAction } from '../cases/apiAction'
import { parsePreservingBig, unwrapSentinelStrings } from '../../bigIntJson'
import { dbHintOf } from './dbHint'
import type { GenDialect } from '../../sqlgen/dialect'
import type { TypeDict } from '../scan/bodyFields'

/** 主键列查询入口：先查出句的表结构缓存，没有再问库。注入进来便于测试 */
export type PkLookup = (table: string) => Promise<string[]>

export interface RunCaseDeps {
  env: EnvironmentConfig
  /** 已连接的出句方言（query 只读）。null = 未连库，dbChanges 记快照错误 */
  live: LiveDbDialect | null
  dialect: GenDialect
  pkLookup: PkLookup
  token: string | null
  /**
   * 跑批中途 401 自救（runner/relogin）：配了登录接口才有，编排层（runRegression）
   * 据此把发送口包一层——收到 401 重登一次重试，新 token 写回 deps.token。
   * 缺省 = 不自救（试跑单条、老调用方行为不变）。
   */
  relogin?: () => Promise<string | null>
  /**
   * 编排层注入的发送口（401 自救层挂在这里，整轮只包一次）；缺省 sendRequest。
   * fire 与异常学习后的重发共用同一条路，所以自救对两者都生效。
   */
  send?: (req: BuiltRequest, timeoutMs: number) => Promise<{ status: number | null; bodyText: string }>
  /**
   * 类简名 → 字段字典（dictOfScan 产出），给响应结构断言（schemaAssert）用。
   * 缺省 = 不做结构校验：老调用方（CI 构造、单测夹具）零迁移。
   */
  dict?: TypeDict
  /**
   * 库前置数据会话（PRD 4.4）。由编排层（runner/regression、apiforgeRun）负责
   * 「造 → 跑 → 清」的时机，runCase 自己不碰它 —— 时机错了报告全是噪音。
   */
  fixture?: FixtureSession
  /**
   * 确认「库里不存在」的表集合，命中后整轮跳过它的快照。挂在 deps 上是因为
   * deps 一次回归只建一份（makeDeps）：第一个用例发现表缺失，后面几十个用例
   * 不再对着同一张不存在的表各砸一遍 ORA-00942 —— 报告的红应该是接口的真失败，
   * 不是环境错配的复读机。换连接重跑会重新发现一次（一轮一条，不是一堆）。
   */
  skipTables?: Set<string>
}

export interface RunCaseOutput {
  httpStatus: number | null
  responsePreview: string
  /** 实际发出的请求体（pretty 后截断，同响应的 previewOf 规则）。null = 没带 body。
   *  之前只存 URL，报告里「请求」栏对不上「参数到底发的啥」——排查 400 得回试跑卡猜。 */
  requestBodyPreview: string | null
  /** 完整请求体；只在 preview 被截断时给 */
  requestBodyFull?: string
  /** 响应体原始文本（截 BODY_TEXT_MAX），体断言（judgeCase）吃它。
   *  responsePreview 是 pretty + 截断过的展示件，断言不能拿展示件当输入。 */
  responseBodyText: string | null
  durationMs: number
  error?: string
  dbChanges: DbChangeSummary
  /** 每一步的人话日志（报告「数据日志」列） */
  log: string[]
  /** 增改删的库变化提示（dbHint.ts），只提示不判失败 */
  dbHint?: string
}

/** 原始响应体留多少：跟收包上限一致，调试卡「展开全部」和体断言都要完整 JSON，
 *  截半截 parse 不回来 */
const BODY_TEXT_MAX = 2_000_000

/**
 * 请求里能当主键值的参数：path 里叫 id / xxxId 的那个（技术方案 §2.3 UPDATE 补强）。
 * path 里没有就看 body 顶层的 id：SHOP 的改删是 POST + {id}，不对准这一行的话，
 * 大表里「最新 200 行」的样本未必包含它，字段变化就看不到
 */
export function guessTargetPk(
  api: ApiMethod,
  values?: Record<string, unknown>,
): string | undefined {
  const p = api.parameters.find(
    (p) => p.position === 'path' && /^(id|.+_id|.*Id)$/i.test(p.name),
  )
  if (p) {
    const v = values?.[p.name]
    return v === undefined || v === null || v === '' ? undefined : String(v)
  }
  if (!api.requestBodyFields.some((f) => f.name === 'id') || typeof values?.__body !== 'string') return undefined
  try {
    const b: unknown = parsePreservingBig(values.__body)
    if (!b || typeof b !== 'object' || Array.isArray(b)) return undefined
    const v: unknown = unwrapSentinelStrings((b as Record<string, unknown>).id)
    return (typeof v === 'string' && v !== '') || typeof v === 'number' ? String(v) : undefined
  } catch {
    return undefined
  }
}

/**
 * 对关联表做一轮快照。表不存在（查询报错）记进 errors，不当成 0 行 ——
 * 「表还没建」和「表被清空了」是两码事。
 */
export async function snapshotTables(
  live: LiveDbDialect,
  dialect: GenDialect,
  pkLookup: PkLookup,
  relations: TableRelation[],
  api: ApiMethod,
  values: Record<string, unknown> | undefined,
  log: string[],
  skipTables?: Set<string>,
): Promise<{
  snapshots: Map<string, import('../types').TableSnapshot>
  errors: { tableName: string; message: string }[]
}> {
  const snapshots = new Map<string, import('../types').TableSnapshot>()
  const errors: { tableName: string; message: string }[] = []
  const targetPk = guessTargetPk(api, values)

  for (const rel of relations) {
    if (!rel.enabled) continue
    const table = rel.tableName
    // 已确认库里没有的表直接跳过：快照查它只会再炸一次，报告要的是接口的真失败
    if (skipTables?.has(table)) continue
    let pks: string[] = []
    try {
      pks = await pkLookup(table)
    } catch {
      pks = []
    }
    const plan = planSnapshot(dialect, table, pks, targetPk)
    const runOne = async (sql: string | null) => {
      if (!sql) return null
      try {
        return await live.query(sql)
      } catch (e) {
        throw new Error(`快照查询失败：${String(e)}`)
      }
    }
    try {
      const countGrid = await runOne(plan.countSql)
      const sampleGrid = plan.sampleSql ? await runOne(plan.sampleSql) : null
      const targetedGrid = plan.targetedSql ? await runOne(plan.targetedSql) : null
      const inputs: SnapshotInputs = { countGrid, sampleGrid, targetedGrid }
      const snap = buildSnapshot(table, plan, inputs)
      if (!plan.pkCols.length) {
        log.push(`${table}：无主键，只对比行数`)
      }
      snapshots.set(table, snap)
    } catch (e) {
      const msg = String(e)
      if (isMissingTableError(msg)) {
        // 第一发现人：记一句可行动的话，此后本轮不再快照这张表
        skipTables?.add(table)
        const note = missingTableNote(table)
        errors.push({ tableName: table, message: note })
        log.push(note)
      } else {
        errors.push({ tableName: table, message: msg })
        log.push(`${table}：快照失败 ${msg}`)
      }
    }
  }
  return { snapshots, errors }
}

/** 执行单个用例的完整闭环。HTTP 失败不抛出：结果进 error 字段，报告照常展示 */
export async function runCase(
  api: ApiMethod,
  testCase: TestCase,
  relations: TableRelation[],
  deps: RunCaseDeps,
): Promise<RunCaseOutput> {
  const log: string[] = []
  // 查询接口不动库：发送前后都不查表对比，省掉两轮查库
  const readOnly = isReadAction(api)
  const callback = isCallbackApi(api)
  const live = readOnly || callback ? null : deps.live
  if (readOnly && deps.live && relations.some((r) => r.enabled)) {
    log.push('查询接口：不查库对比（发送前后都不查关联表）')
  } else if (callback && deps.live) {
    log.push('回调接口：不查库对比（发送前后都不查关联表）')
  }

  const tBefore = Date.now()
  const before = live
    ? await snapshotTables(live, deps.dialect, deps.pkLookup, relations, api, testCase.parameters, log, deps.skipTables)
    : { snapshots: new Map(), errors: [] }
  const beforeMs = Date.now() - tBefore

  const req = buildRequest(deps.env, api, testCase, deps.token)
  if (!req) {
    return {
      httpStatus: null,
      responsePreview: '',
      requestBodyPreview: null,
      responseBodyText: null,
      durationMs: 0,
      error: '路径参数缺失，请求没发出去',
      dbChanges: { changes: [], snapshotErrors: before.errors },
      log,
    }
  }
  log.push(`${req.method} ${req.url}`)

  /**
   * 发一次请求。结果**返回**而不是写外层变量：闭包里改 let，TS 的类型收窄
   * 会把初始 null 一路带到函数尾（bodyText 曾被收窄成 never 编译不过）。
   * 首次发送与异常学习后的重发共用同一条路。
   */
  const fire = async (
    tc: TestCase,
  ): Promise<{
    status: number | null
    bodyText: string | null
    preview: string
    body: string | null
    error?: string
    ms: number
  } | null> => {
    const r = buildRequest(deps.env, api, tc, deps.token)
    if (!r) return null
    const t0 = Date.now()
    try {
      const resp = await (deps.send ?? sendRequest)(r, deps.env.timeoutMs)
      return {
        status: resp.status,
        bodyText: resp.bodyText,
        preview: previewOf(resp.bodyText),
        body: r.body,
        ms: Date.now() - t0,
      }
    } catch (e) {
      return { status: null, bodyText: null, preview: '', body: r.body, error: String(e), ms: Date.now() - t0 }
    }
  }

  let res = await fire(testCase)
  let durationMs = res?.ms ?? 0

  /*
   * 异常学习重试（2026-09-19）：接口回话里说缺数据（「品牌商不存在」）时，会话
   * 认表借/造一条真实 id 回填重发。只对正常用例——异常/边界用例就是要打不存在
   * 的值，修好反而破坏用例语义。封顶两次：治「品牌商补好了又报分类不在」的
   * 连环依赖；第一次的报错原文留在日志里，补了什么、重发到哪都可查。
   */
  // 回调接口重发等于让对方再推一次，不做
  if (deps.fixture && !callback && testCase.type === 'normal' && !testCase.probeNotFound) {
    let cur = testCase
    for (let i = 0; i < 2; i++) {
      if (!res?.bodyText) break
      const repair = await deps.fixture.repairMissing(api.id, api, res.bodyText, cur.parameters)
      if (!repair) break
      log.push(...repair.log)
      if (!repair.fills.length) break
      const applied = applyReadBackfill(cur.parameters, repair.fills, true)
      if (!applied.filled.length) break
      log.push(...applied.filled)
      cur = { ...cur, parameters: applied.values }
      const next = buildRequest(deps.env, api, cur, deps.token)
      if (!next) break
      log.push(`重发 ${next.method} ${next.url}`)
      const again = await fire(cur)
      if (!again) break
      durationMs += again.ms
      res = again
    }
  }

  const tAfter = Date.now()
  const after = live
    ? await snapshotTables(live, deps.dialect, deps.pkLookup, relations, api, testCase.parameters, log, deps.skipTables)
    : { snapshots: new Map(), errors: [] }
  // 「发送」慢的时候看这一行：是接口本身慢，还是前后查库慢
  if (live && before.snapshots.size + before.errors.length > 0) {
    log.push(`耗时：发送前查库 ${beforeMs}ms · 请求 ${durationMs}ms · 发送后查库 ${Date.now() - tAfter}ms`)
  }

  const changes = []
  for (const [table, b] of before.snapshots) {
    const a = after.snapshots.get(table)
    if (!a) continue
    changes.push(diffTables(b, a))
  }
  const snapshotErrors = [...before.errors, ...after.errors]
  // 没连库 / 关联表都没勾：没什么可核对的，不提示
  const dbHint = live && relations.some((r) => r.enabled)
    ? dbHintOf({
        testCase,
        httpStatus: res?.status ?? null,
        error: res?.error,
        bodyText: res?.bodyText,
        snapshotted: before.snapshots.size,
        changes,
      })
    : undefined
  return {
    ...(dbHint ? { dbHint } : {}),
    httpStatus: res?.status ?? null,
    responsePreview: res?.preview ?? '',
    requestBodyPreview: res?.body ? previewOf(res.body) : null,
    requestBodyFull: fullBodyOf(res?.body),
    responseBodyText: res?.bodyText ? res.bodyText.slice(0, BODY_TEXT_MAX) : null,
    durationMs,
    error: res?.error,
    dbChanges: { changes, snapshotErrors },
    log,
  }
}

/** 方言从连接 kind 来；没连库给 mysql 兜底（反正不会真执行） */
export function dialectOfKind(kind: string | undefined): GenDialect {
  const known: GenDialect[] = ['oracle', 'mysql', 'postgresql', 'sqlite']
  return known.includes((kind ?? '') as GenDialect) ? (kind as GenDialect) : 'mysql'
}
