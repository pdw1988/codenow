import test from 'node:test'
import assert from 'node:assert/strict'
import {
  comparableEntry,
  diffRuns,
  entryFromResults,
  parseHistory,
  REPORT_HISTORY_MAX,
  upsertEntry,
} from './reportHistory'
import type { CaseRunResult } from './types'

const caseResult = (over: Partial<CaseRunResult> & Pick<CaseRunResult, 'caseName' | 'ok'>): CaseRunResult =>
  ({
    caseId: `c-${over.caseName}`,
    apiId: 'a1',
    apiPath: '/api/brands/1',
    httpMethod: 'GET',
    durationMs: 10,
    responsePreview: '',
    dbChanges: [],
    snapshotErrors: [],
    dataLog: [],
    requestUrl: 'http://x/api/brands/1',
    ...over,
  }) as CaseRunResult

test('entryFromResults：summary 算对，key 用「方法 路径 · 用例名」', () => {
  const e = entryFromResults(
    'D:/demo',
    [
      caseResult({ caseName: '正常', ok: true }),
      caseResult({ caseName: '未找到', ok: false, httpMethod: 'POST', apiPath: '/api/brands' }),
    ],
    1234,
  )
  assert.equal(e.total, 2)
  assert.equal(e.passed, 1)
  assert.equal(e.failed, 1)
  assert.equal(e.scope, null, '不传 scope = 全量')
  assert.equal(e.durationMs, 1234)
  assert.deepEqual(
    e.cases.map((c) => c.key),
    ['GET /api/brands/1 · 正常', 'POST /api/brands · 未找到'],
  )
})

test(`upsertEntry：新的排最前，超过 ${REPORT_HISTORY_MAX} 份从队尾裁`, () => {
  const a = entryFromResults('D:/demo', [caseResult({ caseName: '正常', ok: true })], 1)
  const b = { ...a, ranAt: a.ranAt + 1 }
  const c = { ...a, ranAt: a.ranAt + 2 }
  let list = upsertEntry([], a)
  list = upsertEntry(list, b)
  assert.deepEqual(list.map((e) => e.ranAt), [b.ranAt, a.ranAt])
  list = upsertEntry(list, c)
  assert.equal(list.length, Math.min(3, REPORT_HISTORY_MAX))
})

test('parseHistory：往返无损；坏 JSON / 非数组 / 残缺条目不挡页面', () => {
  const good = entryFromResults('D:/demo', [caseResult({ caseName: '正常', ok: true })], 5, 'demo · BrandController')
  assert.deepEqual(parseHistory(JSON.stringify([good])), [good])

  assert.deepEqual(parseHistory(null), [])
  assert.deepEqual(parseHistory('不是 JSON'), [])
  assert.deepEqual(parseHistory('{"a":1}'), [])
  assert.deepEqual(
    parseHistory(JSON.stringify([{ ranAt: 'x' }, { ranAt: 1, projectRoot: 'D:/x' }, 'str'])),
    [],
    '缺 total / passed / cases 的条目逐条丢掉',
  )
  const partial = parseHistory(
    JSON.stringify([{ ranAt: 9, projectRoot: 'D:/x', total: 1, passed: 1, cases: [{ key: 'GET /a · 正常' }, null, { key: '' }] }]),
  )
  assert.equal(partial[0]!.cases.length, 1, '残缺 case 丢掉，好 case 保住')
  assert.equal(partial[0]!.cases[0]!.ok, false, '缺 ok 按失败算，宁可多报一条可疑')
  assert.equal(partial[0]!.scope, null)
})

test('comparableEntry：同工程同范围才可比；范围 / 工程换了不比', () => {
  const full = entryFromResults('D:/demo', [caseResult({ caseName: '正常', ok: true })], 1)
  const scoped = entryFromResults('D:/demo', [caseResult({ caseName: '正常', ok: true })], 1, 'demo · BrandController')
  const otherRoot = { ...full, projectRoot: 'D:/other' }

  const list = [scoped, full]
  assert.equal(comparableEntry(list, { ...full, ranAt: full.ranAt + 1 }), full, '全量配全量')
  assert.equal(comparableEntry(list, { ...scoped, ranAt: scoped.ranAt + 1 }), scoped, '范围配同范围')
  assert.equal(comparableEntry(list, otherRoot), null, '换了工程不可比')
  assert.equal(comparableEntry([], full), null, '首跑没有可比的')
})

test('diffRuns：翻转按 key 对号——挂了的在前，新进的不算翻转', () => {
  const prevCases = [
    caseResult({ caseName: '正常', ok: true, durationMs: 10 }),
    caseResult({ caseName: '异常', ok: false, durationMs: 20 }),
    caseResult({ caseName: '未找到', ok: true, durationMs: 30 }),
  ]
  const prev = entryFromResults('D:/demo', prevCases, 60)
  const curr = entryFromResults('D:/demo', [
    caseResult({ caseName: '正常', ok: false, durationMs: 99 }), // 过→挂
    caseResult({ caseName: '异常', ok: true, durationMs: 21 }), // 挂→过
    caseResult({ caseName: '未找到', ok: true, durationMs: 31 }), // 没变
    caseResult({ caseName: '新增用例', ok: true, durationMs: 5 }), // 上次没有
  ], 156)

  const d = diffRuns(prev, curr)
  assert.equal(d.prevRate, 67)
  assert.equal(d.currRate, 75)
  assert.deepEqual(
    d.regressed.map((f) => f.key),
    ['GET /api/brands/1 · 正常'],
  )
  assert.equal(d.regressed[0]!.prevMs, 10)
  assert.equal(d.regressed[0]!.currMs, 99)
  assert.deepEqual(
    d.fixed.map((f) => f.key),
    ['GET /api/brands/1 · 异常'],
  )
  assert.equal(d.newCount, 1)
  assert.equal(d.prevFailed, 1)
  assert.equal(d.currFailed, 1)
})

test('diffRuns：重扫后 apiId 变了不影响对号——key 只看方法/路径/用例名', () => {
  const prev = entryFromResults('D:/demo', [caseResult({ caseName: '正常', ok: false })], 1)
  const curr = entryFromResults('D:/demo', [caseResult({ caseName: '正常', ok: true, apiId: 'rescanned-id' })], 1)
  const d = diffRuns(prev, curr)
  assert.equal(d.fixed.length, 1)
  assert.equal(d.regressed.length, 0)
  assert.equal(d.newCount, 0)
})
