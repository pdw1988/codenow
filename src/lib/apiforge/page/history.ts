/**
 * 页面测试「跟上一次比」：每条用例记上次通过还是失败，跑出结果时打上新失败 / 一直失败 / 修好了；
 * 已知问题是人标的，通过一次就自动取消。按用例逐条记，单跑一页不冲掉别的页。
 */
import type { PageRunResult, PageTrend } from '../types'

export interface PageHistory {
  /** 用例编号 → 上次结果（跳过不记，不覆盖之前的通过 / 失败） */
  last: Record<string, { status: 'pass' | 'fail'; at: number }>
  /** 用例编号 → 标为已知问题的时间 */
  known: Record<string, number>
}

export const emptyHistory = (): PageHistory => ({ last: {}, known: {} })

export function parseHistory(raw: string | null): PageHistory {
  if (!raw) return emptyHistory()
  try {
    const j = JSON.parse(raw) as Partial<PageHistory>
    return { last: j.last && typeof j.last === 'object' ? j.last : {}, known: j.known && typeof j.known === 'object' ? j.known : {} }
  } catch {
    return emptyHistory()
  }
}

/** 跟上次比的结论；第一次跑就失败也算新失败 */
export function trendOf(r: Pick<PageRunResult, 'caseId' | 'status'>, h: PageHistory): PageTrend | undefined {
  const prev = h.last[r.caseId]?.status
  if (r.status === 'fail') return prev === 'fail' ? 'still' : 'new'
  if (r.status === 'pass' && prev === 'fail') return 'fixed'
  return undefined
}

/** 记下一条结果：返回带结论的结果和新记录。通过了就把已知问题标记去掉 */
export function noteResult(r: PageRunResult, h: PageHistory, now = Date.now()): { result: PageRunResult; history: PageHistory } {
  const trend = trendOf(r, h)
  if (r.status === 'skip') return { result: r, history: h }
  const known = { ...h.known }
  if (r.status === 'pass') delete known[r.caseId]
  return {
    result: trend ? { ...r, trend } : r,
    history: { last: { ...h.last, [r.caseId]: { status: r.status, at: now } }, known },
  }
}

export const isKnown = (r: Pick<PageRunResult, 'caseId' | 'status'>, h: PageHistory): boolean =>
  r.status === 'fail' && h.known[r.caseId] !== undefined

/** 没被标为已知的新失败 */
export const isNewFail = (r: PageRunResult, h: PageHistory): boolean => r.status === 'fail' && r.trend === 'new' && !isKnown(r, h)

/** 结果排序：新失败 → 一直失败 → 已知问题 → 修好了 → 其余 */
export function trendRank(r: PageRunResult, h: PageHistory): number {
  if (r.status === 'fail') return isKnown(r, h) ? 2 : r.trend === 'still' ? 1 : 0
  return r.trend === 'fixed' ? 3 : 4
}

/** 汇总行：新失败 / 修好了 / 已知问题 各几条 */
export function trendCounts(results: PageRunResult[], h: PageHistory): { newFail: number; fixed: number; known: number } {
  let newFail = 0
  let fixed = 0
  let known = 0
  for (const r of results) {
    if (isKnown(r, h)) known++
    else if (isNewFail(r, h)) newFail++
    else if (r.trend === 'fixed') fixed++
  }
  return { newFail, fixed, known }
}

/** 这些页上次失败、还没标为已知的用例；按记录算，单跑一页顶掉「本轮结果」也还在 */
export function unmarkedFails(h: PageHistory, pageIds: string[]): string[] {
  // 页面编号本身带 #（工程#地址），只能按前缀对
  const hit = (caseId: string) => pageIds.some((p) => caseId.startsWith(`${p}#`))
  return Object.entries(h.last)
    .filter(([id, v]) => v.status === 'fail' && h.known[id] === undefined && hit(id))
    .map(([id]) => id)
}

export function setKnown(h: PageHistory, caseIds: string[], on: boolean, now = Date.now()): PageHistory {
  const known = { ...h.known }
  for (const id of caseIds) {
    if (on) known[id] = now
    else delete known[id]
  }
  return { ...h, known }
}

/** 清掉某个工程的记录：用例编号以「页面 id#」开头 */
export function clearPages(h: PageHistory, pageIds: string[]): PageHistory {
  const hit = (caseId: string) => pageIds.some((p) => caseId.startsWith(`${p}#`))
  const keep = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).filter(([k]) => !hit(k)))
  return { last: keep(h.last), known: keep(h.known) }
}
