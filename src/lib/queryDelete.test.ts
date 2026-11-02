import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  assertPkDelete,
  buildDeleteFromGrid,
  matchPkColumns,
  pkColumnNames,
  quoteRelation,
} from './queryDelete'
import type { Column } from '../types/schema'

function col(name: string, pk = false): Column {
  return {
    name,
    type: 'INT',
    nullable: !pk,
    isPrimaryKey: pk,
    isAutoIncrement: false,
    javaField: name,
    javaType: 'Integer',
  }
}

test('没有主键就不能删，绝不拼不带 WHERE 的 DELETE', () => {
  const miss = matchPkColumns(['id', 'name'], [])
  assert.equal(miss.ok, false)
  if (!miss.ok) assert.match(miss.reason, /没有主键/)
  assert.throws(
    () =>
      buildDeleteFromGrid({
        dialect: 'sqlite',
        table: 't',
        pkNames: [],
        columns: ['id', 'name'],
        rows: [['1', 'a']],
        indices: [0],
      }),
    /没有主键/,
  )
})

test('结果对不上主键列则说明原因', () => {
  const miss = matchPkColumns(['name', 'age'], ['id'])
  assert.equal(miss.ok, false)
  if (!miss.ok) assert.match(miss.reason, /没有主键列 id/)
})

test('列名大小写不同也能对上', () => {
  const hit = matchPkColumns(['ID', 'NAME'], ['id'])
  assert.equal(hit.ok, true)
})

test('勾选行按主键删，能在 sqlite 里跑；重复主键只删一次', () => {
  const plan = buildDeleteFromGrid({
    dialect: 'sqlite',
    table: 't',
    pkNames: ['id'],
    columns: ['id', 'name'],
    rows: [
      ['1', '张三'],
      ['2', '李四'],
      ['1', '张三'],
    ],
    indices: [0, 1, 2],
  })
  assert.match(plan.sql, /WHERE/i)
  assert.equal(plan.rowCount, 2)
  assert.doesNotThrow(() => assertPkDelete(plan.sql))

  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
  db.exec("INSERT INTO t VALUES (1, '张三'), (2, '李四'), (3, '王五')")
  db.exec(plan.sql)
  const n = db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }
  assert.equal(n.n, 1)
  const left = db.prepare('SELECT id FROM t').get() as { id: number }
  assert.equal(left.id, 3)
})

test('复合主键用 AND，缺一列就拒', () => {
  const plan = buildDeleteFromGrid({
    dialect: 'sqlite',
    table: 'pair',
    pkNames: ['a', 'b'],
    columns: ['a', 'b', 'v'],
    rows: [['1', 'x', 'old']],
    indices: [0],
  })
  assert.match(plan.sql, /"a" = 1/)
  assert.match(plan.sql, /"b" = 'x'/)
  assert.match(plan.sql, /AND/)

  assert.throws(
    () =>
      buildDeleteFromGrid({
        dialect: 'sqlite',
        table: 'pair',
        pkNames: ['a', 'b'],
        columns: ['a', 'v'],
        rows: [['1', 'old']],
        indices: [0],
      }),
    /没有主键列 b/,
  )
})

test('主键是空的不能删；没勾选不能删', () => {
  assert.throws(
    () =>
      buildDeleteFromGrid({
        dialect: 'mysql',
        table: 't',
        pkNames: ['id'],
        columns: ['id'],
        rows: [['']],
        indices: [0],
      }),
    /主键是空的/,
  )
  assert.throws(
    () =>
      buildDeleteFromGrid({
        dialect: 'mysql',
        table: 't',
        pkNames: ['id'],
        columns: ['id'],
        rows: [['1']],
        indices: [],
      }),
    /勾选/,
  )
})

test('schema.table 按段加引号', () => {
  assert.equal(quoteRelation('postgresql', 'audit.logs'), '"audit"."logs"')
  const plan = buildDeleteFromGrid({
    dialect: 'postgresql',
    table: 'audit.logs',
    pkNames: ['id'],
    columns: ['id'],
    rows: [['9']],
    indices: [0],
  })
  assert.match(plan.sql, /DELETE FROM "audit"\."logs"/)
})

test('闸门：没有 WHERE / 不是 DELETE / 第二段都拒', () => {
  assert.throws(() => assertPkDelete('DELETE FROM t'), /WHERE/)
  assert.throws(() => assertPkDelete('SELECT * FROM t'), /DELETE/)
  assert.throws(() => assertPkDelete('DELETE FROM t WHERE id = 1; DELETE FROM t'), /一条/)
  assert.doesNotThrow(() => assertPkDelete("DELETE FROM t WHERE name = 'a;b'"))
})

test('pkColumnNames 只收主键', () => {
  assert.deepEqual(pkColumnNames([col('id', true), col('name'), col('aid', true)]), ['id', 'aid'])
})
