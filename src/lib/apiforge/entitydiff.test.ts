/**
 * 实体/库表结构对账（PRD v0.6 模块 4.15）的单测：纯函数 diff，三类漂移。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Column, TableInfo } from '../../types/schema'
import type { EntityInfo } from './types'
import { diffEntities } from './entitydiff'

const col = (name: string, type: string): Column => ({
  name,
  type,
  nullable: true,
  isPrimaryKey: name === 'ID',
  isAutoIncrement: false,
  javaField: name,
  javaType: 'String',
})

const table = (name: string, columns: Column[]): TableInfo => ({
  name,
  source: 'sql' as const,
  columns,
  createdAt: '2026-09-26T00:00:00Z',
  updatedAt: '2026-09-26T00:00:00Z',
})

const entity = (className: string, tableName: string, fields: [string, string, string, boolean][]): EntityInfo => ({
  className,
  table: tableName,
  fields: fields.map(([name, column, javaType, pk]) => ({ name, column, javaType, pk })),
})

const T_ORDER = table('t_order', [
  col('ID', 'NUMBER(20)'),
  col('BUYER_NAME', 'VARCHAR2(50)'),
  col('STATUS', 'NUMBER(2)'),
])

test('对上账且两边一致：零漂移', () => {
  const e = entity('com.demo.Order', 't_order', [
    ['id', 'ID', 'Long', true],
    ['buyerName', 'buyer_name', 'String', false],
    ['status', 'STATUS', 'Integer', false],
  ])
  const r = diffEntities([e], [T_ORDER])
  assert.deepEqual(r.rows, [])
  assert.deepEqual(r.matched, ['t_order'])
  assert.deepEqual(r.missingTables, [])
})

test('codeOnly：实体字段映射的列库里没有', () => {
  const e = entity('com.demo.Order', 't_order', [
    ['id', 'ID', 'Long', true],
    ['channel', 'CHANNEL', 'String', false],
  ])
  const r = diffEntities([e], [T_ORDER])
  const row = r.rows.find((x) => x.kind === 'codeOnly')!
  assert.ok(row)
  assert.equal(row.field, 'channel')
  assert.equal(row.column, 'CHANNEL')
  assert.match(row.detail, /没执行 DDL/)
})

test('dbOnly：库列没有任何实体映射（跨实体并集判断）', () => {
  const e = entity('com.demo.Order', 't_order', [['id', 'ID', 'Long', true]])
  const r = diffEntities([e], [T_ORDER])
  const dbOnly = r.rows.filter((x) => x.kind === 'dbOnly')
  assert.equal(dbOnly.length, 2) // buyer_name、status 没人映射
  assert.ok(dbOnly.some((x) => x.field === 'BUYER_NAME'))
})

test('同表多实体：任一实体映射了就不算 dbOnly', () => {
  const a = entity('com.demo.Order', 't_order', [['buyerName', 'buyer_name', 'String', false]])
  const b = entity('com.demo.OrderLite', 'T_ORDER', [['status', 'STATUS', 'Integer', false]])
  const r = diffEntities([a, b], [T_ORDER])
  // 只有 ID 没人映射（两个实体分别映射了 buyer_name / status）
  assert.deepEqual(r.rows.filter((x) => x.kind === 'dbOnly').map((x) => x.field), ['ID'])
})

test('typeMismatch：Long 实体对 VARCHAR 列（家族对不上）', () => {
  const bad = table('t_order', [
    col('ID', 'VARCHAR2(32)'),
    col('BUYER_NAME', 'VARCHAR2(50)'),
    col('STATUS', 'NUMBER(2)'),
  ])
  const e = entity('com.demo.Order', 't_order', [['id', 'ID', 'Long', true]])
  const r = diffEntities([e], [bad])
  const row = r.rows.find((x) => x.kind === 'typeMismatch')!
  assert.ok(row)
  assert.match(row.detail, /number.*string|Long/)
})

test('类型家族一边 unknown 不比：备注列 COMMENT 对 String 不报', () => {
  const t = table('t_order', [
    col('ID', 'NUMBER(20)'),
    col('BUYER_NAME', 'VARCHAR2(50)'),
    col('STATUS', 'NUMBER(2)'),
    col('EXTRA', 'COMMENT'),
  ])
  const e = entity('com.demo.Order', 't_order', [['extra', 'EXTRA', 'Object', false]])
  const r = diffEntities([e], [t])
  assert.deepEqual(
    r.rows.filter((x) => x.kind === 'dbOnly').map((x) => x.field),
    ['ID', 'BUYER_NAME', 'STATUS'],
    'EXTRA 类型家族 unknown 不比；ID/BUYER_NAME/STATUS 没人映射报 dbOnly',
  )
})

test('实体指向缓存里没有的表：进 missingTables，不进 matched', () => {
  const e = entity('com.demo.Refund', 't_refund', [['id', 'ID', 'Long', true]])
  const r = diffEntities([e], [T_ORDER])
  assert.deepEqual(r.rows, [])
  assert.deepEqual(r.matched, [])
  assert.deepEqual(r.missingTables, [{ table: 't_refund', className: 'com.demo.Refund' }])
})

test('大小写不敏感对账：@TableName("T_ORDER") 对上缓存 t_order', () => {
  const e = entity('com.demo.Order', 'T_ORDER', [['id', 'id', 'Long', true]])
  const r = diffEntities([e], [T_ORDER])
  assert.deepEqual(r.matched, ['t_order'])
  assert.equal(r.rows.filter((x) => x.kind === 'codeOnly').length, 0)
})
