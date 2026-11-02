import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanBodyExpects,
  duplicateCase,
  markStale,
  newCaseId,
  originOf,
  parseExpectStatus,
  patchCase,
  regenerateKeeping,
} from './caseEdit'
import { skippedOf, resultState } from '../runner/resultState'
import type { CaseRunResult, TestCase } from '../types'

const tc = (id: string, over: Partial<TestCase> = {}): TestCase => ({
  id,
  name: id,
  type: 'normal',
  parameters: { a: '1' },
  expectedHttpStatus: [200],
  expectedDbChange: 'none',
  enabled: true,
  ...over,
})

const res = (caseId: string, over: Partial<CaseRunResult> = {}): CaseRunResult => ({
  caseId,
  apiId: 'api',
  apiPath: '/x',
  httpMethod: 'GET',
  caseName: caseId,
  caseType: 'normal',
  ok: true,
  httpStatus: 200,
  durationMs: 5,
  responsePreview: '{}',
  dbChanges: [],
  snapshotErrors: [],
  dataLog: [],
  requestUrl: '/x',
  ...over,
})

test('originOf：老用例没标记当自动生成', () => {
  assert.equal(originOf(tc('a')), 'auto')
  assert.equal(originOf(tc('a', { origin: 'user' })), 'user')
})

test('patchCase：自动的改过标 edited，手加的仍是 user，不改入参', () => {
  const a = tc('a')
  const p = patchCase(a, { name: '新名' })
  assert.equal(p.name, '新名')
  assert.equal(p.origin, 'edited')
  assert.equal(a.origin, undefined)
  assert.equal(patchCase(tc('u', { origin: 'user' }), { name: 'x' }).origin, 'user')
})

test('newCaseId / duplicateCase：id 不重复，副本名不撞，深拷贝、标 user、启用', () => {
  assert.notEqual(newCaseId('api'), newCaseId('api'))
  const src = tc('a', { name: '正常请求', enabled: false, expectBody: [{ path: '$.x', op: 'exists', value: '' }] })
  const taken = [src, tc('b', { name: '正常请求 副本' })]
  const d = duplicateCase(src, 'api', taken)
  assert.equal(d.name, '正常请求 副本 2')
  assert.equal(d.origin, 'user')
  assert.equal(d.enabled, true)
  assert.ok(d.id.startsWith('api#user#'))
  d.parameters.a = '2'
  d.expectBody![0]!.path = '$.y'
  assert.equal(src.parameters.a, '1')
  assert.equal(src.expectBody![0]!.path, '$.x')
})

test('regenerateKeeping：改过的顶替同名新用例、手加的放最后、自动的沿用旧 id 和启用状态', () => {
  const old = [
    tc('o1', { name: '正常请求', origin: 'edited', expectedHttpStatus: [201] }),
    tc('o2', { name: '缺必填', type: 'exception', enabled: false }),
    tc('o3', { name: '我的', origin: 'user' }),
    tc('o4', { name: '已不生成的自动用例' }),
  ]
  const fresh = [
    tc('f1', { name: '正常请求' }),
    tc('f2', { name: '缺必填', type: 'exception' }),
    tc('f3', { name: '新生成的' }),
  ]
  const out = regenerateKeeping(old, fresh)
  assert.deepEqual(
    out.map((c) => c.id),
    ['o1', 'o2', 'f3', 'o3'],
  )
  assert.deepEqual(out[0]!.expectedHttpStatus, [201])
  assert.equal(out[1]!.enabled, false)
})

test('regenerateKeeping：生成器序号撞上留下的 id 时换一个', () => {
  const old = [tc('api#normal#1', { name: '我的', origin: 'user' })]
  const fresh = [tc('api#normal#1', { name: '正常请求' })]
  const out = regenerateKeeping(old, fresh)
  assert.equal(out.length, 2)
  assert.equal(new Set(out.map((c) => c.id)).size, 2)
  assert.equal(out.find((c) => c.name === '我的')!.id, 'api#normal#1')
})

test('parseExpectStatus / cleanBodyExpects', () => {
  assert.deepEqual(parseExpectStatus('200, 201，404 abc 0'), [200, 201, 404])
  assert.deepEqual(parseExpectStatus(''), [])
  assert.deepEqual(
    cleanBodyExpects([
      { path: '', op: '==', value: '1' },
      { path: '', op: 'notExists', value: '' },
      { path: '$.a', op: '==', value: '1' },
    ]).map((x) => x.op),
    ['notExists', '=='],
  )
})

test('markStale：只标这条用例、不标跳过；没得标时返回原数组', () => {
  const list = [res('a'), res('b'), res('c', { ok: false, skipped: true })]
  const out = markStale(list, 'a')
  assert.equal(out[0]!.stale, true)
  assert.equal(out[1]!.stale, undefined)
  assert.equal(markStale(list, 'c'), list)
  assert.equal(markStale(out, 'a'), out)
})

test('skippedOf：禁用的用例造一条跳过结果', () => {
  const r = skippedOf({ id: 'api', path: '/x/{id}', httpMethod: 'DELETE' }, tc('d', { name: '删除', type: 'boundary' }))
  assert.equal(resultState(r), 'skip')
  assert.equal(r.caseId, 'd')
  assert.equal(r.caseName, '删除')
  assert.equal(r.caseType, 'boundary')
  assert.equal(r.httpMethod, 'DELETE')
  assert.equal(r.error, '已禁用')
})
