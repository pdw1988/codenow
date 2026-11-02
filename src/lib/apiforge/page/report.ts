/**
 * 页面测试报告：汇总、落盘前去截图、JUnit XML。
 * 截图一张几十 KB，几十条失败就是几 MB，只留在本次内存里；重开应用看得到结论看不到图。
 */
import { escXml, junitTime } from '../ci/junit'
import type { PageRunReport, PageRunResult } from '../types'

export function pageReportOf(results: PageRunResult[], scope: string, ranAt: number, durationMs: number): PageRunReport {
  const count = (s: PageRunResult['status']) => results.filter((r) => r.status === s).length
  return {
    ranAt,
    scope,
    summary: { total: results.length, passed: count('pass'), failed: count('fail'), skipped: count('skip'), durationMs },
    results,
  }
}

export function withoutScreenshots(r: PageRunReport): PageRunReport {
  return {
    ...r,
    results: r.results.map((x) => {
      const { screenshot: _screenshot, ...rest } = x
      return rest
    }),
  }
}

/** 失败正文：不开软件也能定位——条件、请求实际带了什么、哪几行不对、脚本报错 */
function failureBody(r: PageRunResult): string {
  const b: string[] = [`页面：${r.pagePath}`]
  if (r.query) b.push(`查询条件：${r.query.field}=${r.query.value}（请求里实际带了：${r.query.sent ?? '没抓到'}）`)
  if (r.detail) b.push(`从「${r.detail.from}」第一行打开：${r.detail.url || '（没拼出地址）'}`)
  for (const x of r.write?.steps ?? []) b.push(`写操作：${x}`)
  for (const x of r.rowChecks) b.push(`行核对：${x}`)
  for (const x of r.jsErrors) b.push(`脚本报错：${x}`)
  for (const x of r.failedRequests) b.push(`请求失败：${x}`)
  for (const x of r.schemaIssues) b.push(`结构差异：${x}`)
  for (const x of r.blockedRequests) b.push(`只读保险拦下：${x}`)
  return b.join('\n')
}

export function pageReportToJunitXml(r: PageRunReport): string {
  const suites = new Map<string, PageRunResult[]>()
  for (const x of r.results) {
    const name = x.pageTitle ? `${x.pageTitle} ${x.pagePath}` : x.pagePath
    suites.set(name, [...(suites.get(name) ?? []), x])
  }
  const s = r.summary
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="页面测试" tests="${s.total}" failures="${s.failed}" skipped="${s.skipped}" time="${junitTime(s.durationMs)}">`,
  ]
  for (const [name, list] of suites) {
    const fails = list.filter((x) => x.status === 'fail').length
    const skips = list.filter((x) => x.status === 'skip').length
    const ms = list.reduce((n, x) => n + x.durationMs, 0)
    out.push(
      `  <testsuite name="${escXml(name)}" tests="${list.length}" failures="${fails}" skipped="${skips}" time="${junitTime(ms)}">`,
    )
    for (const x of list) {
      const head = `    <testcase classname="${escXml(x.pagePath)}" name="${escXml(x.caseName)}" time="${junitTime(x.durationMs)}"`
      if (x.status === 'pass') out.push(`${head}/>`)
      else if (x.status === 'skip') out.push(`${head}>`, `      <skipped message="${escXml(x.reason)}"/>`, '    </testcase>')
      else {
        out.push(
          `${head}>`,
          `      <failure message="${escXml(x.reason)}">${escXml(failureBody(x))}</failure>`,
          '    </testcase>',
        )
      }
    }
    out.push('  </testsuite>')
  }
  out.push('</testsuites>')
  return out.join('\n')
}
