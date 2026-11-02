import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  GRID_COL_MAX,
  GRID_COL_MIN,
  GRID_GUTTER,
  buildInsertFromGrid,
  compareCells,
  defaultColWidth,
  defaultColWidths,
  expandColWidths,
  filterRows,
  gridLiteral,
  gridToTsv,
  gridWindow,
  guessTableFromSql,
  nextSort,
  sortRows,
} from './queryGrid'

test('排序：数字按数值，空值垫底', () => {
  assert.ok(compareCells('9', '10') < 0)
  assert.ok(compareCells('', 'a') > 0)
  const rows = [['10'], ['2'], [''], ['9']]
  const asc = sortRows(rows, { col: 0, dir: 'asc' })
  assert.deepEqual(asc.map((i) => rows[i][0]), ['2', '9', '10', ''])
})

test('点列头：升序 → 降序 → 取消', () => {
  assert.deepEqual(nextSort(null, 1), { col: 1, dir: 'asc' })
  assert.deepEqual(nextSort({ col: 1, dir: 'asc' }, 1), { col: 1, dir: 'desc' })
  assert.equal(nextSort({ col: 1, dir: 'desc' }, 1), null)
  assert.deepEqual(nextSort({ col: 0, dir: 'asc' }, 2), { col: 2, dir: 'asc' })
})

test('结果内筛选：任一格包含，不区分大小写', () => {
  const rows = [
    ['张三', '南京'],
    ['李四', '宁波'],
    ['王五', '南京'],
  ]
  const all = [0, 1, 2]
  assert.deepEqual(filterRows(rows, all, '南京'), [0, 2])
  assert.deepEqual(filterRows(rows, all, 'NING'), [])
  assert.deepEqual(filterRows(rows, all, '李'), [1])
  assert.deepEqual(filterRows(rows, all, ''), all)
})

test('从 SQL 认出表名；复制 TSV 带表头', () => {
  assert.equal(guessTableFromSql('SELECT * FROM "SYS_USER"'), 'SYS_USER')
  assert.equal(guessTableFromSql('select id from `order` where 1=1'), 'order')
  assert.equal(guessTableFromSql('SELECT * FROM audit.logs'), 'audit.logs')
  assert.equal(guessTableFromSql('SELECT 1'), null)
  assert.equal(gridToTsv(['A', 'B'], [['1', 'x'], ['2', 'y']], [1]), 'A\tB\n2\ty')
})

test('格子字面量：空是 NULL，数字不打引号，Oracle 日期走 TO_DATE', () => {
  assert.equal(gridLiteral('', 'oracle'), 'NULL')
  assert.equal(gridLiteral('18', 'mysql'), '18')
  assert.equal(gridLiteral("O'Brien", 'mysql'), "'O''Brien'")
  assert.match(gridLiteral('2026-08-30', 'oracle'), /TO_DATE/)
})

test('勾选行复制成 INSERT，能在 sqlite 里跑', () => {
  const sql = buildInsertFromGrid({
    dialect: 'sqlite',
    table: 't',
    columns: ['id', 'name', 'remark'],
    rows: [
      ['1', '张三', ''],
      ['2', "O'Brien", 'ok'],
    ],
    indices: [0, 1],
  })
  assert.match(sql, /INSERT INTO "t"/)
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (id INTEGER, name TEXT, remark TEXT)')
  db.exec(sql)
  const n = db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }
  assert.equal(n.n, 2)
  const row = db.prepare('SELECT remark FROM t WHERE id = 1').get() as { remark: string | null }
  assert.equal(row.remark, null)
})

test('列宽：短字段有下限，长字段封顶，中文按两格', () => {
  assert.equal(defaultColWidth('id', ['1']), GRID_COL_MIN)
  assert.equal(defaultColWidth('x', ['你'.repeat(80)]), GRID_COL_MAX)
  assert.ok(defaultColWidth('备注说明', ['你好世界同事']) > defaultColWidth('ab', ['ab']))
  assert.deepEqual(defaultColWidths(['id', 'name'], [['1', 'alice']]).length, 2)
})

test('列宽：视口有余量则均分铺满，已超出则不动', () => {
  const narrow = [96, 96, 96]
  const filled = expandColWidths(narrow, GRID_GUTTER + 600)
  assert.equal(filled.reduce((a, b) => a + b, 0), 600)
  assert.ok(filled.every((w) => w >= 96))
  const wide = [200, 200, 200]
  assert.deepEqual(expandColWidths(wide, GRID_GUTTER + 400), wide)
  assert.deepEqual(expandColWidths([], 800), [])
})

test('网格窗口：一万行只切出视口附近', () => {
  const empty = gridWindow({ scrollTop: 0, viewH: 400, n: 0 })
  assert.equal(empty.end, 0)
  const top = gridWindow({ scrollTop: 0, viewH: 400, n: 10_000, rowH: 28, overscan: 10 })
  assert.equal(top.start, 0)
  assert.ok(top.end < 50)
  assert.equal(top.padTop, 0)
  const mid = gridWindow({ scrollTop: 28 * 100, viewH: 400, n: 10_000, rowH: 28, overscan: 10 })
  assert.equal(mid.start, 90)
  assert.ok(mid.end - mid.start < 50)
  assert.equal(mid.padTop, 90 * 28)
  assert.ok(mid.padBot > 0)
})
