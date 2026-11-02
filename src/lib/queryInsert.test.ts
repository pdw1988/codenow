import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  assertRowInsert,
  buildInsertRow,
  defaultInsertOn,
  defaultInsertValue,
  insertColumnNote,
} from './queryInsert'
import type { Column } from '../types/schema'

function col(
  name: string,
  opts: Partial<Column> & { javaType?: string; type?: string } = {},
): Column {
  return {
    name,
    type: opts.type ?? 'VARCHAR(50)',
    nullable: opts.nullable ?? true,
    isPrimaryKey: opts.isPrimaryKey ?? false,
    isAutoIncrement: opts.isAutoIncrement ?? false,
    defaultValue: opts.defaultValue,
    javaField: name,
    javaType: opts.javaType ?? 'String',
  }
}

test('没勾字段 / 没表名都拒', () => {
  assert.throws(
    () => buildInsertRow({ dialect: 'sqlite', table: 't', sets: [] }),
    /勾要写入的字段/,
  )
  assert.throws(
    () =>
      buildInsertRow({
        dialect: 'sqlite',
        table: '  ',
        sets: [{ column: col('name'), value: 'a' }],
      }),
    /表名/,
  )
})

test('自增列默认不勾；写入非自增列能在 sqlite 里跑', () => {
  const id = col('id', {
    isPrimaryKey: true,
    isAutoIncrement: true,
    javaType: 'Integer',
    type: 'INT',
    nullable: false,
  })
  const name = col('name', { nullable: false })
  assert.equal(defaultInsertOn(id), false)
  assert.equal(defaultInsertOn(name), true)

  const plan = buildInsertRow({
    dialect: 'sqlite',
    table: 't',
    sets: [{ column: name, value: '张三' }],
  })
  assert.match(plan.sql, /INSERT INTO "t"/)
  assert.doesNotMatch(plan.sql, /"id"/)
  assert.doesNotThrow(() => assertRowInsert(plan.sql))

  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)')
  db.exec(plan.sql)
  const row = db.prepare('SELECT id, name FROM t').get() as { id: number; name: string }
  assert.equal(row.id, 1)
  assert.equal(row.name, '张三')
})

test('VARCHAR 看起来像数字也加引号；留空是 NULL', () => {
  const name = col('name')
  const remark = col('remark')
  const quoted = buildInsertRow({
    dialect: 'sqlite',
    table: 't',
    sets: [{ column: name, value: '123' }],
  })
  assert.match(quoted.sql, /'123'/)

  const nulled = buildInsertRow({
    dialect: 'sqlite',
    table: 't',
    sets: [{ column: remark, value: '  ' }],
  })
  assert.match(nulled.sql, /NULL/)

  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, remark TEXT)')
  db.exec(nulled.sql)
  const row = db.prepare('SELECT remark FROM t').get() as { remark: string | null }
  assert.equal(row.remark, null)
})

test('用户明确勾了自增列就会写进去；schema.table 按段加引号', () => {
  const id = col('id', {
    isPrimaryKey: true,
    isAutoIncrement: true,
    javaType: 'Integer',
    type: 'INT',
  })
  const plan = buildInsertRow({
    dialect: 'postgresql',
    table: 'audit.logs',
    sets: [{ column: id, value: '9' }],
  })
  assert.match(plan.sql, /INSERT INTO "audit"\."logs"/)
  assert.match(plan.sql, /"id"/)
  assert.match(plan.sql, /\b9\b/)
})

test('日期列默认 SYSDATE / NOW()，原样进 SQL 不加引号', () => {
  const ts = col('create_time', {
    type: 'DATE',
    javaType: 'java.time.LocalDateTime',
  })
  assert.equal(defaultInsertValue(ts, 'oracle'), 'SYSDATE')
  assert.equal(defaultInsertValue(ts, 'mysql'), 'NOW()')
  assert.equal(defaultInsertValue(col('name'), 'oracle'), '')

  const plan = buildInsertRow({
    dialect: 'oracle',
    table: 't',
    sets: [{ column: ts, value: defaultInsertValue(ts, 'oracle') }],
  })
  assert.match(plan.sql, /\bSYSDATE\b/)
  assert.doesNotMatch(plan.sql, /'SYSDATE'/)
})

test('用户手填时间戳仍走 TO_DATE', () => {
  const ts = col('create_time', {
    type: 'DATE',
    javaType: 'java.time.LocalDateTime',
  })
  const plan = buildInsertRow({
    dialect: 'oracle',
    table: 't',
    sets: [{ column: ts, value: '2026-08-22 10:30:00' }],
  })
  assert.match(plan.sql, /TO_DATE\('2026-08-22 10:30:00', 'YYYY-MM-DD HH24:MI:SS'\)/)
})

test('闸门：INSERT … SELECT / 没有 VALUES / 不是 INSERT / 第二段都拒', () => {
  assert.throws(() => assertRowInsert('INSERT INTO t SELECT * FROM t'), /SELECT/)
  assert.throws(() => assertRowInsert('INSERT INTO t'), /INTO|VALUES/)
  assert.throws(() => assertRowInsert('UPDATE t SET a = 1 WHERE id = 1'), /INSERT/)
  assert.throws(
    () => assertRowInsert('INSERT INTO t (a) VALUES (1); INSERT INTO t (a) VALUES (2)'),
    /一条/,
  )
  assert.doesNotThrow(() => assertRowInsert("INSERT INTO t (name) VALUES ('SELECT')"))
  assert.doesNotThrow(() => assertRowInsert("INSERT INTO t (name) VALUES ('a;b')"))
})

test('insertColumnNote 标出自增和必填', () => {
  assert.match(
    insertColumnNote(
      col('id', { isPrimaryKey: true, isAutoIncrement: true, nullable: false }),
    ),
    /自增/,
  )
  assert.match(insertColumnNote(col('name', { nullable: false })), /必填/)
})
