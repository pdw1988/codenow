import test from 'node:test'
import assert from 'node:assert/strict'
import { pageReportOf, pageReportToJunitXml, withoutScreenshots } from './report'
import type { PageRunResult } from '../types'

const r = (over: Partial<PageRunResult>): PageRunResult => ({
  caseId: 'p#/a#patrol', pageId: 'p#/a', pagePath: '/a', pageTitle: '采购申请单', caseName: '巡检', caseType: 'patrol',
  status: 'pass', reason: '页面打开正常', durationMs: 1200, jsErrors: [], failedRequests: [], blockedRequests: [],
  rowChecks: [], schemaIssues: [], ...over,
})

test('pageReportOf：按状态计数', () => {
  const rep = pageReportOf([r({}), r({ status: 'fail' }), r({ status: 'skip' }), r({ status: 'skip' })], '全部页面', 1, 9000)
  assert.deepEqual(rep.summary, { total: 4, passed: 1, failed: 1, skipped: 2, durationMs: 9000 })
  assert.equal(rep.scope, '全部页面')
})

test('withoutScreenshots：去掉截图再存，原对象不动', () => {
  const rep = pageReportOf([r({ status: 'fail', screenshot: 'data:image/jpeg;base64,xx' })], 's', 1, 1)
  const slim = withoutScreenshots(rep)
  assert.equal('screenshot' in slim.results[0]!, false)
  assert.equal(rep.results[0]!.screenshot, 'data:image/jpeg;base64,xx')
})

test('JUnit：按页面分 suite，失败带原因和明细、跳过写 skipped、特殊字符转义', () => {
  const xml = pageReportToJunitXml(
    pageReportOf(
      [
        r({}),
        r({ caseId: 'q', caseName: '查询：姓名', caseType: 'query', status: 'fail', reason: '有 1 行不符合 <姓名>', rowChecks: ['第 2 行 psnName=李四'], query: { field: 'psnName', value: '张三', sent: '张三' } }),
        r({ caseId: 's', caseName: '查询：部门', caseType: 'query', status: 'skip', reason: '没找到对应的结果列' }),
        r({ caseId: 'o', pageId: 'p#/b', pagePath: '/b', pageTitle: '' }),
      ],
      '全部页面',
      1,
      5000,
    ),
  )
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/)
  assert.match(xml, /<testsuites name="页面测试" tests="4" failures="1" skipped="1" time="5\.000">/)
  assert.match(xml, /<testsuite name="采购申请单 \/a" tests="3" failures="1" skipped="1"/)
  assert.match(xml, /<testsuite name="\/b" tests="1" failures="0" skipped="0"/)
  assert.match(xml, /<failure message="有 1 行不符合 &lt;姓名&gt;">/)
  assert.match(xml, /行核对：第 2 行 psnName=李四/)
  assert.match(xml, /查询条件：psnName=张三（请求里实际带了：张三）/)
  assert.match(xml, /<skipped message="没找到对应的结果列"\/>/)
})
