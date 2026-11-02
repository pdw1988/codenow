import type { CaseRunResult } from '../types'

/**
 * 局部重跑（单发 / 单接口 / 单 Controller / 只重跑失败）的结果并进现有结果：
 * 同 caseId 的旧结果去掉、新结果排到最后（调试卡取「最近一条」能看到刚跑的），
 * 没重跑到的保持原样。不改入参。
 */
export function mergeResults(prev: CaseRunResult[], fresh: CaseRunResult[]): CaseRunResult[] {
  if (!fresh.length) return prev
  const ids = new Set(fresh.map((r) => r.caseId))
  return [...prev.filter((r) => !ids.has(r.caseId)), ...fresh]
}
