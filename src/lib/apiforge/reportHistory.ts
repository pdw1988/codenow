/**
 * 回归报告的历史 + 「和上次比」（复盘短板 ③）。
 *
 * 报告页原来只看得到「这一次」：通过率多高、几条失败。上一轮是多少、哪些用例
 * 从过变挂——「回归」的本职就是抓这种倒退，却全靠用户脑子记。这里把每次回归
 * 收尾折成一条小摘要落进 meta blob（apiforge.reportHistory，最多 10 份，新的
 * 在前），报告页拿当前这份跟同基线的上一次 diff。
 *
 * 为什么 diff 的 key 不用 caseId：用例 id 里带 apiId（f.java#get#1），重扫后
 * apiId 会变、现场重生成的用例 id 也不保证跨轮一致；`GET /path · 用例名` 是
 * 人眼认用例的方式，跨重扫也稳。diff 只算两边都有的用例——这次新出现的算
 * 「新进」，不跟上次比过挂（它上次压根没跑，红了也不知道是不是倒退）。
 *
 * 隐私不受影响：这里只存判定结果和耗时，不存请求 / 响应内容，Token 本来就
 * 不会进结果。
 */
import type { CaseRunResult } from './types'
import { countResults, passRate } from './runner/resultState'

/** 一条用例在历史里的最小说法：够 diff、够显示「哪条挂了」，不装别的 */
export interface ReportHistoryCase {
  /** 稳定身份：`GET /api/x · 用例名` */
  key: string
  ok: boolean
  durationMs: number
}

export interface ReportHistoryEntry {
  ranAt: number
  projectRoot: string
  /** 本次范围的人话（Controller 回归时是「工程 · Controller」）；null = 全量 */
  scope: string | null
  total: number
  passed: number
  failed: number
  /** 禁用跳过的条数，不进 cases、不进通过率分母；老历史缺省按 0 */
  skipped?: number
  durationMs: number
  cases: ReportHistoryCase[]
}

/** 最多留几份。一条 ≈ 1KB / 50 用例，10 份封顶防止天天跑把 meta 库无声撑肥 */
export const REPORT_HISTORY_MAX = 10

export function caseKeyOf(r: Pick<CaseRunResult, 'httpMethod' | 'apiPath' | 'caseName'>): string {
  return `${r.httpMethod} ${r.apiPath} · ${r.caseName}`
}

/** 回归收尾折一条。durationMs 用报告 summary 里那份（管线计的总耗时） */
export function entryFromResults(
  projectRoot: string,
  results: readonly CaseRunResult[],
  durationMs: number,
  scope?: string,
): ReportHistoryEntry {
  const { total, passed, failed, skipped } = countResults(results)
  return {
    ranAt: Date.now(),
    projectRoot,
    ...(scope ? { scope } : { scope: null }),
    total,
    passed,
    failed,
    ...(skipped ? { skipped } : {}),
    durationMs,
    cases: results
      .filter((r) => !r.skipped)
      .map((r) => ({ key: caseKeyOf(r), ok: r.ok, durationMs: r.durationMs })),
  }
}

/** 新的插队首。不做同条覆盖：ranAt 到毫秒，同一毫秒跑完两轮回归不存在 */
export function upsertEntry(
  list: readonly ReportHistoryEntry[],
  entry: ReportHistoryEntry,
): ReportHistoryEntry[] {
  return [entry, ...list].slice(0, REPORT_HISTORY_MAX)
}

/** 宽容解析：没存过 / 坏 JSON / 不是数组 / 条目残缺都当没有，坏一条丢一条不炸 */
export function parseHistory(raw: string | null): ReportHistoryEntry[] {
  if (!raw) return []
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(v)) return []
  const out: ReportHistoryEntry[] = []
  for (const x of v) {
    if (!x || typeof x !== 'object') continue
    const e = x as Partial<ReportHistoryEntry>
    if (typeof e.ranAt !== 'number' || typeof e.projectRoot !== 'string') continue
    if (typeof e.total !== 'number' || typeof e.passed !== 'number' || !Array.isArray(e.cases)) continue
    const cases: ReportHistoryCase[] = []
    for (const c of e.cases) {
      if (!c || typeof c !== 'object') continue
      const cc = c as Partial<ReportHistoryCase>
      if (typeof cc.key !== 'string' || !cc.key) continue
      cases.push({
        key: cc.key,
        ok: cc.ok === true,
        durationMs: typeof cc.durationMs === 'number' ? cc.durationMs : 0,
      })
    }
    out.push({
      ranAt: e.ranAt,
      projectRoot: e.projectRoot,
      scope: typeof e.scope === 'string' ? e.scope : null,
      total: e.total,
      passed: e.passed,
      failed: typeof e.failed === 'number' ? e.failed : e.total - e.passed,
      ...(typeof e.skipped === 'number' && e.skipped > 0 ? { skipped: e.skipped } : {}),
      durationMs: typeof e.durationMs === 'number' ? e.durationMs : 0,
      cases,
    })
  }
  return out
}

/**
 * 找可比的上一次：同工程 + 同范围才可比——全量和单 Controller 比涨跌没有意义，
 * 换了个工程的两次回归更没有。找不到返回 null（首次跑 / 范围换了都不出对比带）。
 */
export function comparableEntry(
  list: readonly ReportHistoryEntry[],
  entry: ReportHistoryEntry,
): ReportHistoryEntry | null {
  return (
    list.find((e) => e.scope === entry.scope && e.projectRoot === entry.projectRoot) ?? null
  )
}

/** 一条用例的翻转：上次耗时带出来，挂了能顺口说「比上次慢了」 */
export interface ReportFlip {
  key: string
  prevMs: number
  currMs: number
}

export interface ReportDiff {
  prevRanAt: number
  prevRate: number
  currRate: number
  prevFailed: number
  currFailed: number
  /** 过 → 挂。回归要抓的就是它们，放最前 */
  regressed: ReportFlip[]
  /** 挂 → 过 */
  fixed: ReportFlip[]
  /** 这次有、上次没有的用例数（首跑 / 新启用），不算翻转 */
  newCount: number
}

const rateOf = (e: ReportHistoryEntry): number => passRate(e)

export function diffRuns(prev: ReportHistoryEntry, curr: ReportHistoryEntry): ReportDiff {
  const prevMap = new Map(prev.cases.map((c) => [c.key, c]))
  const regressed: ReportFlip[] = []
  const fixed: ReportFlip[] = []
  let newCount = 0
  for (const c of curr.cases) {
    const p = prevMap.get(c.key)
    if (!p) {
      newCount++
      continue
    }
    if (p.ok && !c.ok) regressed.push({ key: c.key, prevMs: p.durationMs, currMs: c.durationMs })
    else if (!p.ok && c.ok) fixed.push({ key: c.key, prevMs: p.durationMs, currMs: c.durationMs })
  }
  return {
    prevRanAt: prev.ranAt,
    prevRate: rateOf(prev),
    currRate: rateOf(curr),
    prevFailed: prev.failed,
    currFailed: curr.failed,
    regressed,
    fixed,
    newCount,
  }
}
