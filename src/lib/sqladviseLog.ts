/**
 * SQL 优化记录：连库查询页每跑一次查询（且真的有建议）就记一笔，
 * 「优化记录」页拿它当数据源。
 *
 * 记一笔 ≠ 加一行：同一条 SQL、同一套结论重复跑只把次数 +1（见 appendAdviceLog），
 * 一行代表「一种语句 + 一种结论」，这样 200 条额度装的是 200 种不同的情况。
 *
 * 分层同 `lib/apiforge/scan/history.ts`：这里只放纯函数（解析、聚合裁剪、统计），
 * 「存哪、什么时候存」归 `store/useSqlAdviseStore.ts`（键在 `storage/adviceLog.ts`），
 * 「什么时候触发」归 DbQuery 的 runText —— 三件事分开，单测才碰得到中间那层。
 */
import type { AdvSeverity, SqlAdvice } from './sqladvise'
import { isDbKind, type DbKind } from '../types/dbconn'
import { isFavoriteConn, type FavoriteConn } from '../types/favorite'

/**
 * 记录封顶 200 条。到顶淘汰最旧——同模板/收藏的裁剪思路。
 * 不设免费/专业版档位：这是「我看过什么」的回看，不是产出物，卡它没道理。
 */
export const ADVICE_LOG_MAX = 200

/**
 * 单条 SQL 只存前 2000 字。记录是为了「认得出当时那条语句」，
 * 不是拿它当 SQL 库使——真要存 SQL 是我的SQL库那条线（那边也不截断）。
 */
export const ADVICE_SQL_MAX = 2000

/** 单条记录最多带几条建议。`sqlAdvise` 返回时已按严重度排好，取前 10 就是最该看的 10 条 */
export const ADVICE_ITEMS_MAX = 10

export interface AdviceLogEntry {
  id: string
  /** 'YYYY-MM-DD HH:MM'，字典序即时间序，排序不用解析日期（同 lib/sqlfav.ts favNow）。
   *  这是**最近一次**跑的时间；第一次见的时间在 firstAt */
  at: string
  /** 第一次记下这条的时间。`at` 会随重跑往前挪，firstAt 不动 */
  firstAt: string
  /** 同一条 SQL、同一套结论累计跑过几次。≥2 时列表上显示「×N 次」 */
  runs: number
  dialect: DbKind
  /** 当时的连接。只存定位信息，密码永不存（FavoriteConn 本来就没有 password 字段） */
  conn: FavoriteConn
  /** 从 SQL 里认出来的主表，认不出就没这个字段 */
  table?: string
  sql: string
  advice: SqlAdvice[]
}

export interface AdviceLogSummary {
  /** 优化过的次数（各记录的 runs 求和）——真跑过的查询数，不是列表行数 */
  runs: number
  /** 记录条数 = 不同的「语句 + 结论」组合数 */
  entries: number
  /** 这些次优化一共报了多少条建议（按 runs 加权：同一条结论跑 3 次就是 3 份） */
  advice: number
  /** 其中 severity 为 high 的条数，同样按 runs 加权 */
  high: number
  /** 最近 7 天（含今天）跑过几次 */
  week: number
  /** 命中最多的规则，按次数降序封顶 5 条 */
  topRules: { id: string; title: string; count: number }[]
}

/** 本地时间的 'YYYY-MM-DD'。只取日期这一档——按天算「最近 7 天」够了 */
function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const SEVS: readonly AdvSeverity[] = ['high', 'mid', 'low', 'info']

/**
 * 洗一条建议。**缺字段给缺省值，不整条丢**：severity 没了按 info（最不惊扰），
 * why 没了按空串。fixKind 缺省按 'text' 而不是 'sql'——UI 会给「复制」而不是
 * 「复制 SQL」，宁可少一个诱人的标签，也不能把一段执行不了的说明标成 SQL。
 */
function sanitizeAdvice(v: unknown): SqlAdvice | null {
  if (!v || typeof v !== 'object') return null
  const a = v as Partial<SqlAdvice>
  if (typeof a.id !== 'string' || typeof a.title !== 'string') return null
  return {
    id: a.id,
    title: a.title,
    severity: SEVS.includes(a.severity as AdvSeverity) ? (a.severity as AdvSeverity) : 'info',
    why: typeof a.why === 'string' ? a.why : '',
    scene: typeof a.scene === 'string' ? a.scene : undefined,
    fix: typeof a.fix === 'string' ? a.fix : undefined,
    fixKind: typeof a.fix !== 'string' ? undefined : a.fixKind === 'sql' ? 'sql' : 'text',
  }
}

/**
 * 逐条校验外壳，坏的整条跳过。blob 是本应用自己写的、格式自洽，所以可以严格
 * （同 storage/favorites.ts 的理由）：id/时间/方言/SQL/建议数组缺一样就当这条不存在。
 */
function isEntry(v: unknown): v is AdviceLogEntry {
  if (!v || typeof v !== 'object') return false
  const e = v as Partial<AdviceLogEntry>
  return (
    typeof e.id === 'string' &&
    typeof e.at === 'string' &&
    isDbKind(e.dialect) &&
    isFavoriteConn(e.conn) &&
    typeof e.sql === 'string' &&
    Array.isArray(e.advice)
  )
}

/**
 * 读档。坏 JSON / 顶层不是数组都按空库处理——记录是回看用的便利功能，
 * 不能因为它打不开整个页（同 parseFavorites 的口径）。
 */
export function parseAdviceLog(raw: string | null): AdviceLogEntry[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEntry).map((e) => ({
      ...e,
      sql: e.sql.slice(0, ADVICE_SQL_MAX),
      advice: e.advice.map(sanitizeAdvice).filter((a): a is SqlAdvice => a !== null),
      // 升级前存的记录没有这两个字段：runs 按 1 次读回，firstAt 拿 at 顶上——
      // 缺字段给缺省值，同 sanitizeAdvice 的口径
      runs: typeof e.runs === 'number' && e.runs > 0 ? e.runs : 1,
      firstAt: typeof e.firstAt === 'string' ? e.firstAt : e.at,
    }))
  } catch {
    return []
  }
}

/**
 * 是不是同一条语句。**不含时间条件**——「同一分钟」那道老去重只挡得住手快连点两下，
 * 挡不住调试时连跑二三十遍，历史照样被同一种情况刷满。
 * 空白差异不算不同语句（SQL 里换行/缩进没有语义）。
 */
function sameRun(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, ' ') === b.trim().replace(/\s+/g, ' ')
}

/**
 * 两套建议是不是「同一个结论」。只比规则 id + 严重度，不比 why / fix 的措辞——
 * 文案改版不该让历史里多出一条。逐条排序后再拼：`sqlAdvise` 已按严重度排过，
 * 但保不准以后换排序，顺序不该算成「结论变了」。
 */
function sameAdvice(a: readonly SqlAdvice[], b: readonly SqlAdvice[]): boolean {
  if (a.length !== b.length) return false
  const key = (l: readonly SqlAdvice[]) => l.map((x) => `${x.id}/${x.severity}`).sort().join('|')
  return key(a) === key(b)
}

/**
 * 追加一条。**按「语句 + 结论」聚合，不按次聚合**——同 Query Store / pg_stat_statements
 * 的做法：同一条 SQL、同一套建议重复跑，只把计数 +1、末次时间往前挪，不再落一行。
 *
 * 为什么不每跑一次加一行：用户调试同一条 SELECT 时动不动跑二三十遍，落成二三十行
 * 一模一样的内容之后，200 条的额度被同一种情况占满，真正想对照的「上次是什么结论」
 * 被顶出去——这一页要回答的「老问题还在不在」反而看不出来了。
 *
 * 结论**变了**才落新的一条（列表最前面），旧的那条留着当对照。裁剪只发生在超过
 * ADVICE_LOG_MAX 时，砍最旧的。返回新数组，不改入参。
 */
export function appendAdviceLog(list: AdviceLogEntry[], entry: AdviceLogEntry): AdviceLogEntry[] {
  const hit = list.find((e) => sameRun(e.sql, entry.sql))
  if (hit && sameAdvice(hit.advice, entry.advice)) {
    const bumped = { ...hit, at: entry.at, runs: hit.runs + 1 }
    // 挪到最前：列表按最近一次跑排序，时间序才跟视觉顺序一致
    return [bumped, ...list.filter((e) => e.id !== hit.id)]
  }
  const next = [entry, ...list]
  return next.slice(0, ADVICE_LOG_MAX)
}

/**
 * 统计聚合。次数**按 runs 加权**：一条记录代表「同一条 SQL、同一套结论跑过 N 次」，
 * 不加权就等于把「跑过 20 次没人管的问题」和「只跑过一次的问题」算成一样重，
 * Top5 排出来的就不是「老犯」而是「碰巧多跑了几遍」。
 * TopN 平局按规则 id 排，与记录顺序无关——否则同一份数据换个插入先后
 * Top5 会抖，用户会以为数在变。
 */
export function summarizeAdviceLog(list: AdviceLogEntry[], now: Date = new Date()): AdviceLogSummary {
  const rules = new Map<string, { title: string; count: number }>()
  let runs = 0
  let advice = 0
  let high = 0
  for (const e of list) {
    runs += e.runs
    for (const a of e.advice) {
      advice += e.runs
      if (a.severity === 'high') high += e.runs
      const hit = rules.get(a.id)
      if (hit) hit.count += e.runs
      else rules.set(a.id, { title: a.title, count: e.runs })
    }
  }
  const cutoff = ymd(new Date(now.getTime() - 6 * 86400000))
  return {
    runs,
    entries: list.length,
    advice,
    high,
    week: list.filter((e) => e.at.slice(0, 10) >= cutoff).reduce((n, e) => n + e.runs, 0),
    topRules: [...rules]
      .map(([id, r]) => ({ id, ...r }))
      .sort((x, y) => y.count - x.count || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      .slice(0, 5),
  }
}

/** 记录用的 id。时间戳 + 随机后缀，理由同 lib/sqlfav.ts newFavoriteId：不上 randomUUID */
export function newAdviceLogId(): string {
  return `adv${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}
