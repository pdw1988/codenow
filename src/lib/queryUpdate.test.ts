import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  assertPkUpdate,
  buildCellUpdate,
  buildUpdateFromGrid,
  gridCellSample,
  settableColumns,
} from './queryUpdate'
import type { Column } from '../types/schema'

function col(name: string, pk = false, javaType = 'String', type = 'VARCHAR(50)'): Column {
  return {
    name,
    type,
    nullable: !pk,
    isPrimaryKey: pk,
    isAutoIncrement: false,
    javaField: name,
    javaType,
  }
}

test('没有主键 / 没勾 SET / 主键进 SET 都拒', () => {
  assert.throws(
    () =>
      buildUpdateFromGrid({
        dialect: 'sqlite',
        table: 't',
        pkNames: [],
        columns: ['id', 'name'],
        rows: [['1', 'a']],
        indices: [0],
        sets: [{ column: col('name'), value: 'b' }],
      }),
    /没有主键/,
  )
  assert.throws(
    () =>
      buildUpdateFromGrid({
        dialect: 'sqlite',
        table: 't',
        pkNames: ['id'],
        columns: ['id', 'name'],
        rows: [['1', 'a']],
        indices: [0],
        sets: [],
      }),
    /勾要改的字段/,
  )
  assert.throws(
    () =>
      buildUpdateFromGrid({
        dialect: 'sqlite',
        table: 't',
        pkNames: ['id'],
        columns: ['id', 'name'],
        rows: [['1', 'a']],
        indices: [0],
        sets: [{ column: col('id', true, 'Integer', 'INT'), value: '9' }],
      }),
    /勾要改的字段/,
  )
})

test('勾选行按主键改一列，能在 sqlite 里跑；重复主键只算一次', () => {
  const status = col('status', false, 'Integer', 'INT')
  const plan = buildUpdateFromGrid({
    dialect: 'sqlite',
    table: 't',
    pkNames: ['id'],
    columns: ['id', 'status', 'name'],
    rows: [
      ['1', '0', '张三'],
      ['2', '0', '李四'],
      ['1', '0', '张三'],
    ],
    indices: [0, 1, 2],
    sets: [{ column: status, value: '9' }],
  })
  assert.match(plan.sql, /WHERE/i)
  assert.match(plan.sql, /SET/)
  assert.equal(plan.rowCount, 2)
  assert.doesNotThrow(() => assertPkUpdate(plan.sql))
  assert.doesNotMatch(plan.sql, /"id" = 9/)

  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, status INT, name TEXT)')
  db.exec("INSERT INTO t VALUES (1, 0, '张三'), (2, 0, '李四'), (3, 1, '王五')")
  db.exec(plan.sql)
  const rows = db.prepare('SELECT id, status FROM t ORDER BY id').all() as {
    id: number
    status: number
  }[]
  assert.deepEqual(
    rows.map((r) => [r.id, r.status]),
    [
      [1, 9],
      [2, 9],
      [3, 1],
    ],
  )
})

test('VARCHAR 看起来像数字也加引号；留空是 NULL', () => {
  const name = col('name')
  const remark = col('remark')
  const quoted = buildUpdateFromGrid({
    dialect: 'sqlite',
    table: 't',
    pkNames: ['id'],
    columns: ['id', 'name'],
    rows: [['1', 'a']],
    indices: [0],
    sets: [{ column: name, value: '123' }],
  })
  assert.match(quoted.sql, /'123'/)

  const nulled = buildUpdateFromGrid({
    dialect: 'sqlite',
    table: 't',
    pkNames: ['id'],
    columns: ['id', 'remark'],
    rows: [['1', 'old']],
    indices: [0],
    sets: [{ column: remark, value: '  ' }],
  })
  assert.match(nulled.sql, /"remark" = NULL/)

  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, remark TEXT)')
  db.exec("INSERT INTO t VALUES (1, 'old')")
  db.exec(nulled.sql)
  const row = db.prepare('SELECT remark FROM t').get() as { remark: string | null }
  assert.equal(row.remark, null)
})

test('Oracle 日期走 TO_DATE；schema.table 按段加引号', () => {
  const ts: Column = {
    ...col('create_time'),
    type: 'DATE',
    javaType: 'java.time.LocalDateTime',
  }
  const plan = buildUpdateFromGrid({
    dialect: 'oracle',
    table: 'audit.logs',
    pkNames: ['id'],
    columns: ['id', 'create_time'],
    rows: [['9', '2020-01-01 00:00:00']],
    indices: [0],
    sets: [{ column: ts, value: '2026-08-22 10:30:00' }],
  })
  assert.match(plan.sql, /UPDATE "audit"\."logs"/)
  assert.match(plan.sql, /TO_DATE\('2026-08-22 10:30:00', 'YYYY-MM-DD HH24:MI:SS'\)/)
})

test('复合主键用 AND；结果缺主键列就拒', () => {
  const v = col('v')
  const plan = buildUpdateFromGrid({
    dialect: 'sqlite',
    table: 'pair',
    pkNames: ['a', 'b'],
    columns: ['a', 'b', 'v'],
    rows: [['1', 'x', 'old']],
    indices: [0],
    sets: [{ column: v, value: 'new' }],
  })
  assert.match(plan.sql, /"a" = 1/)
  assert.match(plan.sql, /"b" = 'x'/)
  assert.match(plan.sql, /AND/)

  assert.throws(
    () =>
      buildUpdateFromGrid({
        dialect: 'sqlite',
        table: 'pair',
        pkNames: ['a', 'b'],
        columns: ['a', 'v'],
        rows: [['1', 'old']],
        indices: [0],
        sets: [{ column: v, value: 'new' }],
      }),
    /没有主键列 b/,
  )
})

test('闸门：没有 WHERE / SET / 不是 UPDATE / 第二段都拒', () => {
  assert.throws(() => assertPkUpdate('UPDATE t SET a = 1'), /WHERE/)
  assert.throws(() => assertPkUpdate('UPDATE t WHERE id = 1'), /SET/)
  assert.throws(() => assertPkUpdate('DELETE FROM t WHERE id = 1'), /UPDATE/)
  assert.throws(
    () => assertPkUpdate('UPDATE t SET a = 1 WHERE id = 1; UPDATE t SET a = 2 WHERE id = 2'),
    /一条/,
  )
  assert.doesNotThrow(() => assertPkUpdate("UPDATE t SET name = 'a;b' WHERE id = 1"))
})

test('settableColumns 排除主键；gridCellSample 能看出各行不同', () => {
  assert.deepEqual(
    settableColumns([col('id', true), col('name'), col('aid', true)]).map((c) => c.name),
    ['name'],
  )
  assert.equal(gridCellSample(['id', 'name'], [['1', 'a'], ['2', 'a']], [0, 1], 'name').kind, 'same')
  assert.equal(gridCellSample(['id', 'name'], [['1', 'a'], ['2', 'b']], [0, 1], 'name').kind, 'mixed')
  assert.equal(gridCellSample(['id'], [['1']], [0], 'name').kind, 'missing')
})

/* ================= 双击改格子（buildCellUpdate） ================= */

test('buildCellUpdate: 一列一个值，WHERE 钉死这一行主键', () => {
  const plan = buildCellUpdate({
    dialect: 'sqlite',
    table: 't_user',
    dictColumns: [col('id', true), col('status'), col('note')],
    pkNames: ['id'],
    gridColumns: ['ID', 'STATUS', 'NOTE'],
    rows: [['1942968769561371279', '0', 'hello']],
    row: 0,
    colName: 'STATUS',
    value: '1',
  })
  assert.match(plan.sql, /^UPDATE "t_user"/)
  assert.match(plan.sql, /SET "status" = '1'/)
  assert.match(plan.sql, /WHERE "ID" = 1942968769561371279/)
  assert.equal(plan.rowCount, 1)
})

test('buildCellUpdate: 四种拒绝——无主键 / 结果缺主键列 / 列不在字典 / 主键列', () => {
  const dict = [col('id', true), col('status')]
  const base = {
    dialect: 'sqlite' as const,
    table: 't_user',
    dictColumns: dict,
    gridColumns: ['ID', 'STATUS'],
    rows: [['1', '0']],
    row: 0,
  }
  assert.throws(
    () => buildCellUpdate({ ...base, pkNames: [], colName: 'STATUS', value: '1' }),
    /没有主键/,
  )
  assert.throws(
    () =>
      buildCellUpdate({
        ...base,
        pkNames: ['id'],
        gridColumns: ['STATUS', 'NOTE'],
        colName: 'STATUS',
        value: '1',
      }),
    /没有主键列/,
  )
  assert.throws(
    () => buildCellUpdate({ ...base, pkNames: ['id'], colName: 'NOT_IN_DICT', value: '1' }),
    /不在表字典里/,
  )
  assert.throws(
    () => buildCellUpdate({ ...base, pkNames: ['id'], colName: 'id', value: '2' }),
    /主键列不支持直接编辑/,
  )
})

test('buildCellUpdate: 清空格子 = 置 NULL；表名认不出直接拒', () => {
  const plan = buildCellUpdate({
    dialect: 'sqlite',
    table: 't_user',
    dictColumns: [col('id', true), col('note')],
    pkNames: ['id'],
    gridColumns: ['ID', 'NOTE'],
    rows: [['1', 'hello']],
    row: 0,
    colName: 'note',
    value: '',
  })
  assert.match(plan.sql, /SET "note" = NULL/)
  assert.throws(
    () =>
      buildCellUpdate({
        dialect: 'sqlite',
        table: '  ',
        dictColumns: [col('id', true)],
        pkNames: ['id'],
        gridColumns: ['ID'],
        rows: [['1']],
        row: 0,
        colName: 'id',
        value: 'x',
      }),
    /认不出表名/,
  )
})
