/**
 * CI 报告与闸门，PRD v0.5 模块 4.6「CI 模式」+ 4.10.2。
 *
 * JUnit XML：Jenkins / GitLab CI 原生解析。用例按 Controller 分 suite，
 * 失败用例的 message 给人话结论，正文带请求、响应（截断）和数据库变更 ——
 * 在 CI 界面里不点开 HTML 也能看出「接口坏了还是库不对」。
 *
 * checkExpectations：严格模式的数据库期望（user: +1）对整场回归的库变更
 * 汇总做判定，违约项由 CLI 并进退出码和 JUnit（落地约束 3）。
 */
import type { CaseRunResult, RegressionReport } from '../types'
import { changeLine } from '../report'
import { attributeFailure } from '../attribution'
import { countResults } from '../runner/resultState'

export const escXml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

export const junitTime = (ms: number): string => (ms / 1000).toFixed(3)

/** 失败用例的正文：在 CI 日志里不点开链接也能定位的那种信息量 */
function failureBody(r: CaseRunResult, baseUrl?: string): string {
  const b: string[] = []
  const a = attributeFailure(r, baseUrl)
  if (a) b.push(`归因：${a.bucket} —— ${a.hint}`)
  b.push(`请求：${r.requestUrl || `${r.httpMethod} ${r.apiPath}`}`)
  if (r.error) b.push(`错误：${r.error}`)
  // 体断言失败是独立于 error 的失败原因（BizException 回 200 + 错误信封，
  // error 为空、状态码全绿），不单列的话 CI 里只见「HTTP 200」一条失败
  for (const f of r.assertFails ?? []) b.push(`断言失败：${f}`)
  // 结构差异同理：观察模式不判失败但 CI 里该看得见，严格模式下就是失败原因
  for (const s of r.schemaIssues ?? []) b.push(`结构差异：${s}`)
  if (r.responsePreview) b.push(`响应（截断）：${r.responsePreview.slice(0, 500)}`)
  b.push(`数据库变更：${changeLine(r).replace(/\n/g, ' / ')}`)
  return b.join('\n')
}

export interface JunitOptions {
  /** apiId → suite 名（Controller 类名）。缺省全部进 APIForge 一个 suite */
  suiteOf?: (apiId: string) => string
  /** 严格模式期望违约（checkExpectations 的产物），并成独立 suite 进报告 */
  extraFailures?: { name: string; message: string }[]
  /** 环境配置的 Base URL：填错的真因，进「服务连不上 / 404」的归因建议 */
  baseUrl?: string
}

export function reportToJunitXml(report: RegressionReport, opts: JunitOptions = {}): string {
  const suites = new Map<string, CaseRunResult[]>()
  for (const r of report.results) {
    const name = opts.suiteOf?.(r.apiId) || '码上测'
    const list = suites.get(name) ?? []
    list.push(r)
    suites.set(name, list)
  }

  const suiteXml = [...suites.entries()].map(([name, results]) => {
    const { failed: failures, skipped } = countResults(results)
    const time = results.reduce((n, r) => n + r.durationMs, 0)
    const cases = results
      .map((r) =>
        r.skipped
          ? `    <testcase name="${escXml(r.caseName)}" classname="${escXml(r.apiPath)}" time="0">
      <skipped message="已禁用"/>
    </testcase>`
          : r.ok
          ? `    <testcase name="${escXml(r.caseName)}" classname="${escXml(r.apiPath)}" time="${junitTime(r.durationMs)}"/>`
          : `    <testcase name="${escXml(r.caseName)}" classname="${escXml(r.apiPath)}" time="${junitTime(r.durationMs)}">
      <failure message="${escXml(r.error || r.assertFails?.[0] || `HTTP ${r.httpStatus ?? '无响应'}`)}">${escXml(failureBody(r, opts.baseUrl))}</failure>
    </testcase>`,
      )
      .join('\n')
    return `  <testsuite name="${escXml(name)}" tests="${results.length}" failures="${failures}"${skipped ? ` skipped="${skipped}"` : ''} time="${junitTime(time)}">
${cases}
  </testsuite>`
  })

  const allXml: string[] = [...suiteXml]
  if (opts.extraFailures?.length) {
    const cases = opts.extraFailures
      .map(
        (f) => `    <testcase name="${escXml(f.name)}" classname="apiforge 闸门" time="0">
      <failure message="${escXml(f.message)}">${escXml(f.message)}</failure>
    </testcase>`,
      )
      .join('\n')
    allXml.push(`  <testsuite name="码上测 闸门" tests="${opts.extraFailures.length}" failures="${opts.extraFailures.length}" time="0">
${cases}
  </testsuite>`)
  }

  const total = report.summary.total + (opts.extraFailures?.length ?? 0)
  const failed = report.summary.failed + (opts.extraFailures?.length ?? 0)
  const skippedAll = report.summary.skipped ?? 0
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="码上测" tests="${total}" failures="${failed}"${skippedAll ? ` skipped="${skippedAll}"` : ''} time="${junitTime(report.summary.durationMs)}">
${allXml.join('\n')}
</testsuites>
`
}

/**
 * 严格模式的库变更期望。`+N` 期望新增 N 条、`-N` 期望删除 N 条、`0` 期望无写变更，
 * 对照整场回归的库变更汇总（PRD 4.3：期望如 user +1）。返回违约描述，空数组 = 全过。
 */
export function checkExpectations(
  expectations: Record<string, string>,
  report: RegressionReport,
): string[] {
  const violations: string[] = []
  for (const [table, spec] of Object.entries(expectations)) {
    const row = report.dbChangeSummary.find((t) => t.tableName === table)
    const ins = row?.totalInserted ?? 0
    const upd = row?.totalUpdated ?? 0
    const del = row?.totalDeleted ?? 0
    const m = spec.match(/^([+-]?\d+)$/)
    if (!m) {
      violations.push(`数据库期望 ${table}: ${spec} 看不懂（支持 +N / -N / 0）`)
      continue
    }
    const n = Number(m[1])
    const actual =
      n > 0 ? ins : n < 0 ? del : ins + upd + del
    const want =
      n > 0 ? `新增 ${n}` : n < 0 ? `删除 ${-n}` : '无写变更'
    const got = `新增 ${ins} / 更新 ${upd} / 删除 ${del}`
    if (actual !== Math.abs(n)) {
      violations.push(`数据库期望 ${table} ${want}，实际 ${got}`)
    }
  }
  return violations
}
