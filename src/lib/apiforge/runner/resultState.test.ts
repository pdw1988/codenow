import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCaseEnabled, countResults, isFailed, passRate, resultState, toSkipped } from './resultState'
import { mergeResults } from './mergeResults'
import { assembleReport, reportToHtml, reportToMarkdown } from '../report'
import { reportToJunitXml } from '../ci/junit'
import { entryFromResults, diffRuns } from '../reportHistory'
import { attributeFailure } from '../attribution'
import type { CaseRunResult } from '../types'

const r = (over: Partial<CaseRunResult>): CaseRunResult => ({
  caseId: 'c1',
  apiId: 'a1',
  apiPath: '/api/user/create',
  httpMethod: 'POST',
  caseName: '正常·create',
  caseType: 'normal',
  ok: true,
  httpStatus: 200,
  durationMs: 12,
  responsePreview: '{"code":0}',
  dbChanges: [],
  snapshotErrors: [],
  dataLog: [],
  requestUrl: 'http://x/api/user/create',
  ...over,
})

const failed = r({ caseId: 'c2', ok: false, httpStatus: 500, error: '服务器错误', assertFails: ['$.code 期望 0'] })

test('resultState：跳过优先于 ok，其余按 ok 分通过 / 失败', () => {
  assert.equal(resultState(r({})), 'pass')
  assert.equal(resultState(failed), 'fail')
  assert.equal(resultState(toSkipped(failed)), 'skip')
  assert.equal(isFailed(toSkipped(failed)), false)
})

test('countResults / passRate：跳过不算通过也不算失败，不进通过率分母', () => {
  const c = countResults([r({}), failed, toSkipped(r({ caseId: 'c3' }))])
  assert.deepEqual(c, { total: 3, passed: 1, failed: 1, skipped: 1 })
  assert.equal(passRate(c), 50)
  assert.equal(passRate({ passed: 0, failed: 0 }), 0)
})

test('toSkipped：清掉旧失败详情，ok 为 false，不进失败归因', () => {
  const s = toSkipped(failed)
  assert.equal(s.ok, false)
  assert.equal(s.skipped, true)
  assert.equal(s.httpStatus, null)
  assert.equal(s.error, '已禁用')
  assert.equal(s.assertFails, undefined)
  assert.equal(attributeFailure(s), null)
})

test('applyCaseEnabled：禁用把结果改跳过，重新启用去掉跳过那条，不改入参', () => {
  const prev = [r({}), failed]
  const off = applyCaseEnabled(prev, 'c2', false)
  assert.equal(resultState(off[1]!), 'skip')
  assert.equal(resultState(prev[1]!), 'fail')
  const on = applyCaseEnabled(off, 'c2', true)
  assert.deepEqual(on.map((x) => x.caseId), ['c1'])
  // 没有结果的用例不动
  assert.equal(applyCaseEnabled(prev, 'zz', false), prev)
})

test('合并结果：手动发了已禁用的用例，新结果顶掉跳过那条', () => {
  const prev = [toSkipped(failed)]
  const out = mergeResults(prev, [r({ caseId: 'c2', ok: false, httpStatus: 400 })])
  assert.equal(out.length, 1)
  assert.equal(resultState(out[0]!), 'fail')
})

test('报告：summary 单独计跳过；MD / HTML 写「已禁用」不带旧失败详情，排在最后', () => {
  const rep = assembleReport('E:/demo', [toSkipped(failed), r({}), r({ caseId: 'c4', ok: false, httpStatus: 500 })], 100)
  assert.deepEqual(
    { ...rep.summary, durationMs: 0 },
    { total: 3, passed: 1, failed: 1, skipped: 1, durationMs: 0 },
  )
  const md = reportToMarkdown(rep)
  assert.match(md, /1 通过 \/ 1 失败 \/ 1 跳过 \/ 共 3 条/)
  assert.match(md, /⏭ \/api\/user\/create/)
  assert.match(md, /已禁用/)
  assert.doesNotMatch(md, /\$\.code 期望 0/)
  assert.ok(md.indexOf('⏭') > md.indexOf('✅'))
  const html = reportToHtml(rep)
  assert.match(html, /<tr class="skip">/)
  assert.match(html, /已禁用（跳过）/)
  // 没有跳过时 summary 不带 skipped，老格式不变
  assert.equal('skipped' in assembleReport('E:/demo', [r({})], 1).summary, false)
})

test('JUnit：跳过输出 <skipped/>，不算 failures，suite / 总表写 skipped 计数', () => {
  const rep = assembleReport('E:/demo', [r({}), toSkipped(failed)], 10)
  const xml = reportToJunitXml(rep)
  assert.match(xml, /<testsuites name="码上测" tests="2" failures="0" skipped="1"/)
  assert.match(xml, /<testsuite name="码上测" tests="2" failures="0" skipped="1"/)
  assert.match(xml, /<skipped message="已禁用"\/>/)
  assert.doesNotMatch(xml, /<failure/)
})

test('报告历史：跳过的不进 cases、不进通过率分母', () => {
  const e = entryFromResults('E:/demo', [r({}), toSkipped(failed)], 10)
  assert.equal(e.skipped, 1)
  assert.equal(e.failed, 0)
  assert.equal(e.cases.length, 1)
  const d = diffRuns(e, e)
  assert.equal(d.currRate, 100)
})
