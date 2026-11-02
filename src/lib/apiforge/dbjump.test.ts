import test from 'node:test'
import assert from 'node:assert/strict'
import { quickCheckSql } from './dbjump'
import type { TableChange } from './types'
import type { Column } from '../../types/schema'

const col = (name: string, pk = false): Column => ({
  name,
  type: 'VARCHAR(50)',
  nullable: !pk,
  isPrimaryKey: pk,
  isAutoIncrement: false,
  javaField: name,
  javaType: 'String',
})

const schema = (name: string, columns: Column[]) => ({ name, columns })

const chg = (over: Partial<TableChange> & { tableName: string }): TableChange => ({
  op: 'none',
  rowsInserted: 0,
  rowsUpdated: 0,
  rowsDeleted: 0,
  insertedIds: [],
  deletedIds: [],
  updatedIds: [],
  fieldDiffs: [],
  ...over,
})

test('挑表：真有行数变更的优先于启用关联表，WHERE 用快照主键值', () => {
  const out = quickCheckSql({
    changed: [chg({ tableName: 't_order', op: 'insert', rowsInserted: 1, insertedIds: ['1001'] })],
    enabledTables: ['t_user'],
    schemaTables: [schema('t_order', [col('id', true), col('order_no')])],
  })
  assert.equal(out?.table, 't_order')
  assert.equal(out?.sql, "SELECT * FROM t_order WHERE id IN ('1001')")
})

test('挑表：op=none 不算变更记录（落到启用表）；无任何变更时取第一张启用表', () => {
  const a = quickCheckSql({
    changed: [chg({ tableName: 't_log' })],
    enabledTables: ['t_a', 't_b'],
    schemaTables: [],
  })
  assert.equal(a?.table, 't_a')
  assert.equal(a?.sql, 'SELECT * FROM t_a')

  const b = quickCheckSql({ changed: [], enabledTables: ['t_b', 't_a'], schemaTables: [] })
  assert.equal(b?.table, 't_b')
})

test('WHERE：复合主键不拼、缓存里没有的表不拼、id 值里单引号翻倍', () => {
  const changed = [
    chg({ tableName: 't_multi', op: 'update', rowsUpdated: 2, updatedIds: ['a1', "b'2"] }),
  ]
  const multi = quickCheckSql({
    changed,
    enabledTables: [],
    schemaTables: [schema('t_multi', [col('a', true), col('b', true)])],
  })
  assert.equal(multi?.sql, 'SELECT * FROM t_multi')

  const unknown = quickCheckSql({ changed, enabledTables: [], schemaTables: [] })
  assert.equal(unknown?.sql, 'SELECT * FROM t_multi')

  const single = quickCheckSql({
    changed,
    enabledTables: [],
    schemaTables: [schema('t_multi', [col('pk', true), col('b')])],
  })
  assert.equal(single?.sql, "SELECT * FROM t_multi WHERE pk IN ('a1', 'b''2')")
})

test('IN 列表封顶 10 个；纯删除的表查出来是空（空即删干净）', () => {
  const ids = Array.from({ length: 15 }, (_, i) => String(i))
  const capped = quickCheckSql({
    changed: [chg({ tableName: 't', op: 'insert', rowsInserted: 15, insertedIds: ids })],
    enabledTables: [],
    schemaTables: [schema('t', [col('id', true)])],
  })
  assert.equal(capped?.sql, `SELECT * FROM t WHERE id IN (${ids.slice(0, 10).map((i) => `'${i}'`).join(', ')})`)

  const del = quickCheckSql({
    changed: [chg({ tableName: 't', op: 'delete', rowsDeleted: 1, deletedIds: ['9'] })],
    enabledTables: [],
    schemaTables: [schema('t', [col('id', true)])],
  })
  assert.equal(del?.sql, "SELECT * FROM t WHERE id IN ('9')")
})

test('没有表可查（无变更、无启用关联表）返回 null', () => {
  assert.equal(quickCheckSql({ changed: [], enabledTables: [], schemaTables: [] }), null)
})
