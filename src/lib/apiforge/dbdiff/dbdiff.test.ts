import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSnapshot, diffTables, planSnapshot, summarizeChanges, type SnapshotInputs } from './dbdiff'
import type { TableSnapshot } from '../types'

const grid = (columns: string[], rows: string[][]) => ({ columns, rows, truncated: false, cap: 200 })

test('planSnapshot：有主键出 COUNT + 主键倒序抽样 + 定点查；无主键只有 COUNT', () => {
  const p1 = planSnapshot('mysql', 't_user', ['id'], '1001')
  assert.equal(p1.countSql, 'SELECT COUNT(*) AS N FROM `t_user`')
  assert.equal(p1.sampleSql, 'SELECT * FROM `t_user` ORDER BY `id` DESC\nLIMIT 0, 200')
  // Oracle 11g 没有 FETCH FIRST：外包 ROWNUM，排序在里层
  const po = planSnapshot('oracle', 'T_USER', ['ID'])
  assert.match(po.sampleSql ?? '', /ORDER BY "ID" DESC\n\) WHERE ROWNUM <= 200$/)
  assert.equal(p1.targetedSql, "SELECT * FROM `t_user` WHERE `id` = '1001'")

  const p2 = planSnapshot('oracle', 't_user', [], '1')
  assert.equal(p2.countSql, 'SELECT COUNT(*) AS N FROM "t_user"')
  assert.equal(p2.sampleSql, null)
  assert.equal(p2.targetedSql, null)
})

test('planSnapshot：主键值里的单引号翻倍', () => {
  const p = planSnapshot('mysql', 't', ['id'], "a'b")
  assert.equal(p.targetedSql, "SELECT * FROM `t` WHERE `id` = 'a''b'")
})

test('buildSnapshot：COUNT 结果非数字按失败处理，不当成 0 行', () => {
  const plan = planSnapshot('mysql', 't', [], undefined)
  const snap = buildSnapshot('t', plan, { countGrid: grid(['N'], [['abc']]) } as SnapshotInputs)
  assert.equal(snap.rowCount, null)
  assert.ok(snap.error)
})

test('buildSnapshot：按主键列名定位（SELECT * 的第一列不一定是主键）', () => {
  const plan = planSnapshot('mysql', 't_user', ['id'], undefined)
  const snap = buildSnapshot('t_user', plan, {
    countGrid: grid(['N'], [['2']]),
    sampleGrid: grid(['name', 'id'], [['张三', '1'], ['李四', '2']]),
  } as SnapshotInputs)
  assert.equal(snap.rowCount, 2)
  assert.deepEqual(snap.pkValues.sort(), ['1', '2'])
  assert.equal(snap.rows?.['1']?.name, '张三')
})

test('diffTables：INSERT 抓到新增主键；行数不变但字段变 = UPDATE（COUNT 抓不住的就是它）', () => {
  const base = (rows: Record<string, Record<string, string>>, count: number, pkValues: string[]): TableSnapshot => ({
    tableName: 't_user',
    rowCount: count,
    rows,
    pkValues,
    hasPk: true,
  })
  const before = base(
    { '1': { id: '1', name: '张三' }, '2': { id: '2', name: '李四' } },
    2,
    ['1', '2'],
  )
  // 同一主键改了字段：COUNT 都是 2，diff 必须抓到 UPDATE
  const afterUpdate = base(
    { '1': { id: '1', name: '王五' }, '2': { id: '2', name: '李四' } },
    2,
    ['1', '2'],
  )
  const upd = diffTables(before, afterUpdate)
  assert.equal(upd.op, 'update')
  assert.equal(upd.rowsUpdated, 1)
  assert.deepEqual(upd.updatedIds, ['1'])
  assert.deepEqual(upd.fieldDiffs, [{ pk: '1', field: 'name', before: '张三', after: '王五' }])

  // 新增主键 3
  const afterInsert = base(
    { '1': { id: '1', name: '张三' }, '2': { id: '2', name: '李四' }, '3': { id: '3', name: '赵六' } },
    3,
    ['1', '2', '3'],
  )
  const ins = diffTables(before, afterInsert)
  assert.equal(ins.op, 'insert')
  assert.deepEqual(ins.insertedIds, ['3'])

  // 主键 2 消失
  const afterDelete = base({ '1': { id: '1', name: '张三' } }, 1, ['1'])
  const del = diffTables(before, afterDelete)
  assert.equal(del.op, 'delete')
  assert.deepEqual(del.deletedIds, ['2'])
})

test('diffTables：无主键只有行数对比，note 说明局限', () => {
  const before: TableSnapshot = { tableName: 't', rowCount: 5, rows: null, pkValues: [], hasPk: false }
  const same: TableSnapshot = { tableName: 't', rowCount: 5, rows: null, pkValues: [], hasPk: false }
  const d = diffTables(before, same)
  assert.equal(d.op, 'none')
  assert.ok(d.note?.includes('无主键'))
  const grown = diffTables(before, { ...same, rowCount: 6 })
  assert.equal(grown.op, 'insert')
  assert.equal(grown.rowsInserted, 1)
})

test('diffTables：快照失败报 note 而不是编造 0 行', () => {
  const bad: TableSnapshot = { tableName: 't', rowCount: null, rows: null, pkValues: [], hasPk: true, error: '连不上' }
  const d = diffTables(bad, { ...bad })
  assert.equal(d.op, 'none')
  assert.ok(d.note?.includes('连不上'))
})

test('summarizeChanges：按表聚合三列', () => {
  const s = summarizeChanges([
    [
      { tableName: 't_user', op: 'insert', rowsInserted: 1, rowsUpdated: 0, rowsDeleted: 0, insertedIds: [], deletedIds: [], updatedIds: [], fieldDiffs: [] },
    ],
    [
      { tableName: 't_user', op: 'insert', rowsInserted: 2, rowsUpdated: 0, rowsDeleted: 0, insertedIds: [], deletedIds: [], updatedIds: [], fieldDiffs: [] },
      { tableName: 't_order', op: 'update', rowsInserted: 0, rowsUpdated: 1, rowsDeleted: 0, insertedIds: [], deletedIds: [], updatedIds: [], fieldDiffs: [] },
    ],
  ])
  assert.deepEqual(s, [
    { tableName: 't_order', totalInserted: 0, totalUpdated: 1, totalDeleted: 0 },
    { tableName: 't_user', totalInserted: 3, totalUpdated: 0, totalDeleted: 0 },
  ])
})

test('定点行并入窗口：UPDATE 目标行不在 top-200 也能 diff 到', () => {
  const plan = planSnapshot('mysql', 't', ['id'], '9')
  const before = buildSnapshot('t', plan, {
    countGrid: grid(['N'], [['3']]),
    sampleGrid: grid(['id', 'v'], [['1', 'a']]),
    targetedGrid: grid(['id', 'v'], [['9', 'old']]),
  } as SnapshotInputs)
  const after = buildSnapshot('t', plan, {
    countGrid: grid(['N'], [['3']]),
    sampleGrid: grid(['id', 'v'], [['1', 'a']]),
    targetedGrid: grid(['id', 'v'], [['9', 'new']]),
  } as SnapshotInputs)
  const d = diffTables(before, after)
  assert.equal(d.op, 'update')
  assert.deepEqual(d.fieldDiffs, [{ pk: '9', field: 'v', before: 'old', after: 'new' }])
})
