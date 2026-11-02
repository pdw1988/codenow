import test from 'node:test'
import assert from 'node:assert/strict'
import { checkExpectations, reportToJunitXml } from './junit'
import { assembleReport } from '../report'
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

const report = () =>
  assembleReport('E:/demo', [
    r({}),
    r({ caseId: 'c2', apiId: 'a2', ok: false, httpStatus: 500, caseName: '异常·<缺 id>', responsePreview: '<script>x</script>' }),
  ], 120)

test('JUnit XML：按 Controller 分 suite，总数/失败数/耗时齐，HTML 字符转义', () => {
  const xml = reportToJunitXml(report(), { suiteOf: (id) => (id === 'a1' ? 'UserController' : 'OrderController') })
  assert.match(xml, /<testsuites name="码上测" tests="2" failures="1" time="0\.120">/)
  assert.match(xml, /<testsuite name="UserController" tests="1" failures="0"/)
  assert.match(xml, /<testsuite name="OrderController" tests="1" failures="1"/)
  assert.match(xml, /<failure message="HTTP 500"/)
  assert.doesNotMatch(xml, /<script>x<\/script>/)
  assert.match(xml, /&lt;script&gt;x&lt;\/script&gt;/)
  // 转义不能吃掉用例名里的尖括号语义：名字也要转义
  assert.match(xml, /异常·&lt;缺 id&gt;/)
})

test('checkExpectations：+N/-N/0 对照库变更汇总，非法 spec 报看不懂', () => {
  const rep = assembleReport('E:/demo', [], 0)
  // 空汇总：什么期望都违约
  assert.match(checkExpectations({ user: '+1' }, rep)[0], /数据库期望 user 新增 1，实际 新增 0 \/ 更新 0 \/ 删除 0/)
  assert.equal(checkExpectations({ user: '0' }, rep).length, 0, '空跑等于无写变更，0 期望应通过')
  assert.match(checkExpectations({ user: 'x' }, rep)[0], /看不懂/)
})

test('checkExpectations：汇总命中 +1 通过', () => {
  const rep = assembleReport(
    'E:/demo',
    [
      r({
        dbChanges: [
          {
            tableName: 't_user',
            op: 'insert',
            rowsInserted: 1,
            rowsUpdated: 0,
            rowsDeleted: 0,
            insertedIds: ['1'],
            deletedIds: [],
            updatedIds: [],
            fieldDiffs: [],
          },
        ],
      }),
    ],
    0,
  )
  // 汇总键是表名；关联表名带前缀时配置写同名才对得上
  assert.equal(checkExpectations({ t_user: '+1' }, rep).length, 0)
  assert.equal(checkExpectations({ t_user: '-1' }, rep).length, 1)
})

test('extraFailures：严格模式期望违约并进独立闸门 suite，计入总数', () => {
  const xml = reportToJunitXml(report(), {
    extraFailures: [{ name: '数据库期望·user +1', message: '期望新增 1，实际 0' }],
  })
  assert.match(xml, /<testsuite name="码上测 闸门" tests="1" failures="1"/)
  assert.match(xml, /<testsuites name="码上测" tests="3" failures="2"/)
})

test('体断言失败：message 用首条断言而不是误导的「HTTP 200」，正文逐条列出', () => {
  // BizException：HTTP 全绿、业务全红。error 为空，message 若还兜底到
  // 「HTTP 200」，CI 失败列表里就只剩一句谁也看不懂的话
  const rep = assembleReport('E:/demo', [
    r({ ok: false, httpStatus: 200, responsePreview: '{"level":"error"}', assertFails: ['$.level：期望不存在，实际 error', '$.code：期望 0，实际 500'] }),
  ], 0)
  const xml = reportToJunitXml(rep)
  assert.match(xml, /<failure message="\$\.level：期望不存在/)
  assert.match(xml, /断言失败：\$\.level：期望不存在，实际 error/)
  assert.match(xml, /断言失败：\$\.code：期望 0，实际 500/)
  assert.doesNotMatch(xml, /message="HTTP 200"/)
})
