import test from 'node:test'
import assert from 'node:assert/strict'
import { learnedToRecord, learnExpectations } from './learn'
import type { CaseRunResult, TableChange } from '../types'

const change = (over: Partial<TableChange>): TableChange => ({
  tableName: 't_user',
  op: 'insert',
  rowsInserted: 1,
  rowsUpdated: 0,
  rowsDeleted: 0,
  insertedIds: ['1001'],
  deletedIds: [],
  updatedIds: [],
  fieldDiffs: [],
  ...over,
})

const r = (changes: TableChange[], over: Partial<CaseRunResult> = {}): CaseRunResult => ({
  caseId: 'c1',
  apiId: 'a1',
  apiPath: '/api/user/create',
  httpMethod: 'POST',
  caseName: '正常·create',
  caseType: 'normal',
  ok: true,
  httpStatus: 200,
  durationMs: 12,
  responsePreview: '',
  dbChanges: changes,
  snapshotErrors: [],
  dataLog: [],
  requestUrl: 'http://x/api/user/create',
  ...over,
})

test('learnExpectations：整场一致的 insert/delete 学成 +N/-N', () => {
  const learned = learnExpectations([
    r([change({})]),
    r([change({ tableName: 't_order', op: 'delete', rowsInserted: 0, rowsDeleted: 2, insertedIds: [], deletedIds: ['1', '2'] })]),
    r([change({})]),
  ])
  const user = learned.find((l) => l.table === 't_user')
  assert.equal(user?.spec, '+1')
  assert.equal(user?.samples, 2)
  const order = learned.find((l) => l.table === 't_order')
  assert.equal(order?.spec, '-2')
  assert.deepEqual(learnedToRecord(learned), { t_user: '+1', t_order: '-2' })
})

test('变更量有出入的不学，原因写清楚', () => {
  const learned = learnExpectations([r([change({ rowsInserted: 1 })]), r([change({ rowsInserted: 3 })])])
  const user = learned.find((l) => l.table === 't_user')
  assert.equal(user?.spec, '')
  assert.match(user?.note ?? '', /有出入/)
  assert.deepEqual(learnedToRecord(learned), {})
})

test('混合变更（新增+更新 / 更新-only）期望语法表达不了，不硬凑', () => {
  const upd = (n: number): TableChange =>
    change({ op: 'update', rowsInserted: 0, rowsUpdated: n, insertedIds: [], updatedIds: ['1'] })
  const learned = learnExpectations([
    r([upd(1)]),
    r([upd(1)]),
    r([upd(1), change({ tableName: 't_log', op: 'update', rowsInserted: 0, rowsUpdated: 4, insertedIds: [], updatedIds: ['9'] })]),
  ])
  const user = learned.find((l) => l.table === 't_user')
  assert.equal(user?.spec, '')
  assert.match(user?.note ?? '', /混合变更/)
  const log = learned.find((l) => l.table === 't_log')
  assert.equal(log?.spec, '')
})

test('op=none 的表不参与学习；无变更结果返回空', () => {
  assert.equal(learnExpectations([r([change({ op: 'none', rowsInserted: 0, insertedIds: [] })])]).length, 0)
  assert.equal(learnExpectations([r([])]).length, 0)
})
