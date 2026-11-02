import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COUNT_PK,
  COUNT_STAR,
  defaultPickNames,
  pickAggFlags,
  primaryKeyForCount,
  selectExprsFromPick,
  splitPickColumns,
  withAggToggle,
} from './columnPick'

const col = (
  name: string,
  opts: { pk?: boolean; unique?: boolean; indexed?: boolean; type?: string } = {},
) => ({
  name,
  isPrimaryKey: !!opts.pk,
  isUnique: opts.unique,
  isIndexed: opts.indexed,
  type: opts.type,
  comment: undefined as string | undefined,
})

test('默认可见：PK/UK/IDX/日期；其余进加载更多', () => {
  const { shown, more } = splitPickColumns([
    col('status'),
    col('id', { pk: true }),
    col('email', { unique: true }),
    col('user_id', { indexed: true }),
    col('created_at', { type: 'DATETIME' }),
    col('amount'),
  ])
  assert.deepEqual(
    shown.map((c) => c.name),
    ['id', 'email', 'user_id', 'created_at'],
  )
  assert.deepEqual(
    more.map((c) => c.name),
    ['amount', 'status'],
  )
})

test('认不出主键时不藏列——避免 id 掉进加载更多', () => {
  const { shown, more } = splitPickColumns([
    col('id'),
    col('name'),
    col('status'),
  ])
  assert.equal(more.length, 0)
  assert.deepEqual(
    shown.map((c) => c.name),
    ['id', 'name', 'status'],
  )
})

test('默认勾选只含露出来的列，「加载更多」里的不勾', () => {
  const cols = [
    col('status'),
    col('id', { pk: true }),
    col('created_at', { type: 'DATETIME' }),
    col('amount'),
  ]
  assert.deepEqual(defaultPickNames(cols), ['id', 'created_at'])
  // 认不出主键时一列不藏，默认就是全部
  assert.deepEqual(defaultPickNames([col('id'), col('name')]), ['id', 'name'])
})

test('COUNT 默认不勾：null 时 pickAggFlags 全 false', () => {
  assert.deepEqual(pickAggFlags(null), { star: false, pk: false })
  assert.deepEqual(pickAggFlags(undefined), { star: false, pk: false })
  assert.deepEqual(pickAggFlags(['id', 'name']), { star: false, pk: false })
})

test('从全选勾上 COUNT(*) 收成只勾聚合，避免 GROUP BY 全列', () => {
  assert.deepEqual(withAggToggle(null, ['id', 'name'], COUNT_STAR, true), [COUNT_STAR])
  assert.deepEqual(withAggToggle(['id'], ['id', 'name'], COUNT_STAR, true), ['id', COUNT_STAR])
  assert.deepEqual(withAggToggle(['id', COUNT_STAR], ['id', 'name'], COUNT_STAR, false), ['id'])
})

test('selectExprs：只有 COUNT(*) / COUNT(主键)', () => {
  const cols = [col('id', { pk: true }), col('name')]
  const r = selectExprsFromPick('mysql', [COUNT_STAR, COUNT_PK], cols)
  assert.equal(r.onlyAgg, true)
  assert.deepEqual(r.groupBy, [])
  assert.match(r.exprs.map((e) => e.text).join('|'), /COUNT\(\*\) AS `cnt`/)
  assert.match(r.exprs.map((e) => e.text).join('|'), /COUNT\(`id`\) AS `id_cnt`/)
})

test('selectExprs：维度列 + COUNT 要 GROUP BY', () => {
  const cols = [col('id', { pk: true }), col('channel'), col('name')]
  const r = selectExprsFromPick('mysql', ['channel', COUNT_STAR], cols)
  assert.equal(r.onlyAgg, false)
  assert.deepEqual(r.groupBy, ['channel'])
  assert.equal(r.exprs[0]?.text, '`channel`')
})

test('没有主键就不给 COUNT(主键) 目标列', () => {
  assert.equal(primaryKeyForCount([col('name')]), null)
  assert.equal(primaryKeyForCount([col('id', { pk: true })])?.name, 'id')
})
