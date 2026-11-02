import type { ApiMethod, CaseRunResult, TestCase } from '../types'

export type ResultState = 'pass' | 'fail' | 'skip'

/** 结果的三态。统计 / 显示一律走这里，别直接看 ok——跳过的 ok 是 false 但不算失败 */
export function resultState(r: Pick<CaseRunResult, 'ok' | 'skipped'>): ResultState {
  if (r.skipped) return 'skip'
  return r.ok ? 'pass' : 'fail'
}

export const isFailed = (r: Pick<CaseRunResult, 'ok' | 'skipped'>): boolean => resultState(r) === 'fail'

export interface ResultCounts {
  total: number
  passed: number
  failed: number
  skipped: number
}

export function countResults(results: readonly Pick<CaseRunResult, 'ok' | 'skipped'>[]): ResultCounts {
  let passed = 0
  let failed = 0
  let skipped = 0
  for (const r of results) {
    const s = resultState(r)
    if (s === 'pass') passed++
    else if (s === 'fail') failed++
    else skipped++
  }
  return { total: results.length, passed, failed, skipped }
}

/** 通过率百分数：通过 ÷（通过 + 失败），跳过的不进分母；没有跑过的返回 0 */
export function passRate(c: Pick<ResultCounts, 'passed' | 'failed'>): number {
  const n = c.passed + c.failed
  return n ? Math.round((c.passed / n) * 100) : 0
}

/** 禁用后的结果：只留「哪条用例」，旧的失败详情全清掉，免得导出里还像失败 */
export function toSkipped(r: CaseRunResult): CaseRunResult {
  return {
    caseId: r.caseId,
    apiId: r.apiId,
    apiPath: r.apiPath,
    httpMethod: r.httpMethod,
    caseName: r.caseName,
    caseType: r.caseType,
    ok: false,
    skipped: true,
    httpStatus: null,
    durationMs: 0,
    responsePreview: '',
    error: '已禁用',
    dbChanges: [],
    snapshotErrors: [],
    dataLog: [],
    requestUrl: r.requestUrl,
  }
}

/** 跑批时给禁用的用例补一条跳过结果：报告和 CI 里看得见哪些被禁了 */
export function skippedOf(api: Pick<ApiMethod, 'id' | 'path' | 'httpMethod'>, c: Pick<TestCase, 'id' | 'name' | 'type'>): CaseRunResult {
  return toSkipped({
    caseId: c.id,
    apiId: api.id,
    apiPath: api.path,
    httpMethod: api.httpMethod,
    caseName: c.name,
    caseType: c.type,
    ok: false,
    httpStatus: null,
    durationMs: 0,
    responsePreview: '',
    dbChanges: [],
    snapshotErrors: [],
    dataLog: [],
    requestUrl: api.path,
  })
}

/**
 * 启用 / 禁用一条用例后结果怎么跟：禁用 = 已有结果改成跳过；
 * 重新启用 = 去掉跳过那条（当没跑过）。没有结果就不动。不改入参。
 */
export function applyCaseEnabled(results: CaseRunResult[], caseId: string, enabled: boolean): CaseRunResult[] {
  if (!results.some((r) => r.caseId === caseId)) return results
  if (enabled) return results.filter((r) => !(r.caseId === caseId && r.skipped))
  return results.map((r) => (r.caseId === caseId && !r.skipped ? toSkipped(r) : r))
}
