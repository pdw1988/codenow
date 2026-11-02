import test from 'node:test'
import assert from 'node:assert/strict'
import { assembleReport, changeLine, reportToHtml, reportToMarkdown, reportToJson } from './report'
import type { CaseRunResult, TableChange } from './types'

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
  dbChanges: [
    {
      tableName: 't_user',
      op: 'insert',
      rowsInserted: 1,
      rowsUpdated: 0,
      rowsDeleted: 0,
      insertedIds: ['1001'],
      deletedIds: [],
      updatedIds: [],
      fieldDiffs: [],
    },
  ],
  snapshotErrors: [],
  dataLog: ['POST http://x/api/user/create'],
  requestUrl: 'http://x/api/user/create',
  ...over,
})

test('assembleReport：通过数/失败数/库变更汇总一次算齐', () => {
  const noChange = r({ ok: false, httpStatus: 500, dbChanges: [], snapshotErrors: [] })
  const report = assembleReport('E:/demo', [r({}), noChange], 100)
  assert.equal(report.summary.total, 2)
  assert.equal(report.summary.passed, 1)
  assert.equal(report.summary.failed, 1)
  const t = report.dbChangeSummary.find((x) => x.tableName === 't_user')
  assert.equal(t?.totalInserted, 1)
})

test('changeLine：带 id 的人话摘要；空变更显示占位而不是空串', () => {
  assert.match(changeLine(r({})), /t_user：新增 1 \(id=1001\)/)
  const empty = r({ dbChanges: [] })
  assert.match(changeLine(empty), /未关联表或未连库/)
})

test('changeLine：字段级前后值跟在表行下面，空串显式化、超长截断', () => {
  const lines = changeLine(r({ dbChanges: [UPD_CHANGE] })).split('\n')
  assert.match(lines[0], /t_user：更新 1 \(id=1001\)/)
  assert.match(lines[1], /· status: 0 → 1/)
  // 空串显式化成 ''，超长值截断到 40
  assert.match(lines[2], /· remark: '' → a{39}…$/)
  // 没有字段 diff 就不产生明细行
  assert.equal(changeLine(r({})).split('\n').length, 1)
})

/** 带 UPDATE 字段级 diff 的库变更（4.11 的素材） */
const UPD_CHANGE: TableChange = {
  tableName: 't_user',
  op: 'update',
  rowsInserted: 0,
  rowsUpdated: 1,
  rowsDeleted: 0,
  insertedIds: [],
  deletedIds: [],
  updatedIds: ['1001'],
  fieldDiffs: [
    { pk: '1001', field: 'status', before: '0', after: '1' },
    { pk: '1001', field: 'remark', before: '', after: 'a'.repeat(50) },
  ],
}

test('报告 Markdown：失败置顶、有库变更汇总表、Token 不会出现', () => {
  const report = assembleReport(
    'E:/demo',
    [r({}), r({ ok: false, caseName: '异常·缺 id', apiPath: '/api/x', dbChanges: [UPD_CHANGE] })],
    50,
  )
  const md = reportToMarkdown(report)
  const failIdx = md.indexOf('异常·缺 id')
  const okIdx = md.indexOf('正常·create')
  assert.ok(failIdx >= 0 && failIdx < okIdx, '失败用例必须排在通过用例前面')
  assert.match(md, /## 数据库变更汇总/)
  assert.match(md, /· status: 0 → 1/, '字段级明细要进 Markdown 报告')
  assert.doesNotMatch(md, /Bearer|token/i)
})

test('报告 Markdown：请求体块跟在请求行后面；没带 body 不出块', () => {
  const md = reportToMarkdown(
    assembleReport('E:/demo', [
      r({ requestBodyPreview: '{\n  "name": "test_demo"\n}' }),
    ], 5),
  )
  const bodyIdx = md.indexOf('- 请求体（截断）：')
  const reqIdx = md.indexOf('- 请求：`POST')
  assert.ok(reqIdx >= 0 && bodyIdx > reqIdx, '请求体要跟在请求行后面')
  assert.match(md, /```json\n  \{\n    "name"/, '请求体进 json 代码块')
  const noBody = reportToMarkdown(assembleReport('E:/demo', [r({ requestBodyPreview: null })], 0))
  assert.equal(noBody.includes('请求体（截断）'), false)
})

test('报告范围：指定服务/Controller 回归时范围进 MD/HTML 头部；全量不出这行', () => {
  const scoped = assembleReport('E:/demo', [r({})], 5, 'user-service · UserController')
  const md = reportToMarkdown(scoped)
  assert.match(md, /^- 范围：user-service · UserController$/m)
  assert.ok(md.indexOf('- 范围：') < md.indexOf('## 用例明细'), '范围在头部，不在明细里')
  assert.match(reportToHtml(scoped), /范围 <b>user-service · UserController<\/b>/)
  const full = assembleReport('E:/demo', [r({})], 5)
  assert.equal(reportToMarkdown(full).includes('- 范围：'), false)
  assert.equal(reportToHtml(full).includes('范围'), false)
})

test('报告 HTML：转义响应体里的 HTML 字符', () => {
  const report = assembleReport('E:/demo', [r({ responsePreview: '<script>alert(1)</script>' })], 0)
  const html = reportToHtml(report)
  assert.doesNotMatch(html, /<script>alert/)
  assert.match(html, /&lt;script&gt;/)
})

test('报告 HTML：造数/清理日志也在（用户打开看的是 HTML，不能只有 MD 有）', () => {
  const log = [
    '前置数据：INSERT INTO "emp" ("emp_name") VALUES (\'张三\')',
    '清理前置数据：DELETE FROM "emp" WHERE "id" = 1',
  ]
  const html = reportToHtml(assembleReport('E:/demo', [r({ dataLog: log })], 0))
  assert.match(html, /清理前置数据/)
  assert.match(html, /DELETE FROM &quot;emp&quot;/, '日志里的引号要走转义')

  // 超 20 行截断：日志进的是表格单元格，不截会把整张表撑到看不见别的列
  const long = Array.from({ length: 25 }, (_, i) => `前置数据：INSERT #${i}`)
  const capped = reportToHtml(assembleReport('E:/demo', [r({ dataLog: long })], 0))
  assert.match(capped, /其余 5 行省略/)
  assert.doesNotMatch(capped, /INSERT #24/)
})

test('报告 JSON：可原样 parse 回来', () => {
  const report = assembleReport('E:/demo', [r({})], 5)
  const parsed = JSON.parse(reportToJson(report))
  assert.equal(parsed.summary.total, 1)
})
