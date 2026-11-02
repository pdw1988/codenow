import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDateRelatedColumn, sortColumnsForUi } from './columnOrder'

const col = (
  name: string,
  opts: {
    pk?: boolean
    unique?: boolean
    indexed?: boolean
    type?: string
    javaType?: string
  } = {},
) => ({
  name,
  isPrimaryKey: !!opts.pk,
  isUnique: opts.unique,
  isIndexed: opts.indexed,
  type: opts.type,
  javaType: opts.javaType,
})

test('主键 → 唯一键 → 索引 → 日期 → 其余；每档内按字母', () => {
  const out = sortColumnsForUi([
    col('status'),
    col('updated_at', { type: 'DATETIME' }),
    col('user_id', { indexed: true }),
    col('email', { unique: true }),
    col('id', { pk: true }),
    col('created_at', { type: 'DATETIME' }),
    col('amount'),
    col('code', { unique: true }),
    col('org_id', { indexed: true }),
  ])
  assert.deepEqual(
    out.map((c) => c.name),
    ['id', 'code', 'email', 'org_id', 'user_id', 'created_at', 'updated_at', 'amount', 'status'],
  )
})

test('复合主键都在最前，主键之间也按字母', () => {
  const out = sortColumnsForUi([
    col('role_id', { pk: true }),
    col('name'),
    col('user_id', { pk: true }),
  ])
  assert.deepEqual(
    out.map((c) => c.name),
    ['role_id', 'user_id', 'name'],
  )
})

test('主键 / 唯一优先于普通索引：同列不掉档', () => {
  const out = sortColumnsForUi([
    col('code', { unique: true, indexed: true }),
    col('id', { pk: true, indexed: true }),
    col('ref_id', { indexed: true }),
  ])
  assert.deepEqual(
    out.map((c) => c.name),
    ['id', 'code', 'ref_id'],
  )
})

test('日期：靠类型 / javaType / 命名后缀都能认出', () => {
  assert.equal(isDateRelatedColumn(col('x', { type: 'TIMESTAMP(6) WITH TIME ZONE' })), true)
  assert.equal(isDateRelatedColumn(col('x', { javaType: 'java.time.LocalDate' })), true)
  assert.equal(isDateRelatedColumn(col('pay_time')), true)
  assert.equal(isDateRelatedColumn(col('timeout')), false)
  assert.equal(isDateRelatedColumn(col('status')), false)
})

test('大小写不敏感；col2 排在 col10 前', () => {
  const out = sortColumnsForUi([col('col10'), col('Col2'), col('id', { pk: true })])
  assert.deepEqual(
    out.map((c) => c.name),
    ['id', 'Col2', 'col10'],
  )
})

test('不改入参', () => {
  const src = [col('b'), col('a', { pk: true })]
  sortColumnsForUi(src)
  assert.deepEqual(
    src.map((c) => c.name),
    ['b', 'a'],
  )
})
