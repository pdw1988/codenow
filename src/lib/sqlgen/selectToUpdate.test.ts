/**
 * SELECT转UPDATE 的回归测试，PRD v6.4 §4.16。
 *
 * 和 executable.test.ts 同一条底线：「复制出去就能跑」是唯一验收标准，
 * 所以主力用例把生成的 UPDATE 放进 node:sqlite 真执行一遍，断言库里的数据真的变了、
 * 且**只有该变的行变了**——WHERE 范围错了不报错，只对字符串的话永远看不出来。
 * 每条用例对应原型评审拍板过的一条语义（文件头三条）或一个真会踩的形状。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { parseDdl } from '../ddlParser'
import {
  buildSelectToUpdate,
  cellOf,
  detectPk,
  fieldUsable,
  includedIndices,
  parsePastedTable,
  resolveFormat,
  resolvePk,
  uniformAcross,
  type S2uOptions,
} from './selectToUpdate'

/* order 表第 2 列是 user_id —— 无表头按位置对齐的用例全靠它抓「想当然的列序」 */
const DDL = `
CREATE TABLE \`order\` (
  id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键',
  user_id BIGINT NOT NULL COMMENT '下单用户',
  order_no VARCHAR(32) NOT NULL COMMENT '订单号',
  total DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '订单金额',
  status TINYINT NOT NULL DEFAULT 0 COMMENT '状态 0待付 1已付',
  remark VARCHAR(200) COMMENT '备注',
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '下单时间',
  CONSTRAINT pk_order PRIMARY KEY (id)
);`
const table = parseDdl(DDL).tables[0]!

/** 原型评审用的那份示例：status 有 0 有 1（演示统一改 1），total 每行不同（演示 CASE WHEN） */
const PASTE = [
  'id | order_no | status | total',
  '101 | NO001 | 0 | 99.00',
  '102 | NO002 | 1 | 199.00',
  '103 | NO003 | 0 | 59.50',
].join('\n')

const opts = (over: Partial<S2uOptions> = {}): S2uOptions => ({
  dialect: 'mysql',
  format: 'auto',
  targets: {},
  checked: {},
  ...over,
})

test('解析：带表头的竖线表格认出列名，并挂上缓存里的字段元数据', () => {
  const p = parsePastedTable(PASTE, table)!
  assert.deepEqual(
    p.cols.map((c) => c.name),
    ['id', 'order_no', 'status', 'total'],
  )
  assert.equal(p.header, true)
  assert.equal(p.single, false)
  // 元数据命中：字面量类型跟着真字段走（total 是 DECIMAL，值裸着不带引号）
  assert.equal(p.cols.find((c) => c.name === 'total')?.column?.type, 'DECIMAL(12,2)')
})

test('解析：表头小写对上大写字段后，主键和 WHERE 都走缓存列名', () => {
  const upper = parseDdl(`
    CREATE TABLE T (
      ID BIGINT PRIMARY KEY,
      STATUS TINYINT NOT NULL
    );
  `).tables[0]!
  const p = parsePastedTable('id | status\n1541374300316110848 | 0', upper)!
  assert.deepEqual(p.cols.map((c) => c.name), ['ID', 'STATUS'])
  assert.equal(detectPk(p, upper).name, 'ID')
  assert.equal(cellOf(p, 'ID', 0), '1541374300316110848')
  const r = buildSelectToUpdate(upper, p, 'ID', opts({ checked: { status: true }, targets: { status: '1' } }))
  assert.match(r.sql, /1541374300316110848/)
  assert.match(r.sql, /STATUS/)
})

test('解析：没 Tab 时 JSON 里的竖线不当分隔符', () => {
  // 格子数远超表字段才会拒绝竖线；两三段坐标不够，要够碎才说明不是表格
  const json = '{"c":"1|2|3|4|5|6|7|8|9|10|11"}'
  const p = parsePastedTable(json, table)!
  assert.equal(p.single, true)
  assert.equal(p.rows[0][0], json)
})

test('解析：结果网格是 Tab，格子里的竖线、逗号、空格不能当分隔符', () => {
  // 例：从客户端复制一行，ext JSON 里有 coordinate 的 `|`、条件里有空格、
  // 中间还有空格子。旧解析先按竖线切再按空白切，整行碎成几十列，对到错的字段上。
  const json = '{"orderAmount":100,"coordinate":"442,200|442,200","skip":"a >= 50"}'
  const row = ['101', '', json, '2026-08-24 09:11:10.000', '0'].join('\t')
  const p = parsePastedTable(row, table)!
  assert.equal(p.header, false)
  assert.equal(p.single, false)
  assert.equal(p.rows[0][0], '101')
  assert.equal(p.rows[0][1], '')
  assert.equal(p.rows[0][2], json)
  assert.equal(p.rows[0][3], '2026-08-24 09:11:10.000')
  assert.equal(p.rows[0][4], '0')
  assert.equal(p.cols.length, 5)
})

test('解析：首行全是数字不是表头，按位置对齐表的真实列序（第 2 列是 user_id）', () => {
  const p = parsePastedTable('201 8 NO004 77.00 1', table)!
  assert.equal(p.header, false)
  assert.deepEqual(
    p.cols.map((c) => c.name),
    ['id', 'user_id', 'order_no', 'total', 'status'],
  )
})

test('解析：单列粘贴识别成主键列表，列名借缓存主键', () => {
  const p = parsePastedTable('301\n302\n303', table)!
  assert.equal(p.single, true)
  assert.deepEqual(p.cols.map((c) => c.name), ['id'])
  assert.equal(p.rows.length, 3)
})

test('主键三级优先：缓存主键 > 字段名含 id > 兜底第一列；手动指定的失效后回落自动', () => {
  const withHeader = parsePastedTable(PASTE, table)!
  assert.deepEqual(detectPk(withHeader, table), { name: 'id', source: 'cache' })

  // 结果里没有真主键 id，但有个长得像 id 的列
  const noId = parsePastedTable('user_id | status\n7 | 0', table)!
  assert.deepEqual(detectPk(noId, table), { name: 'user_id', source: 'idName' })

  // 兜底第一列：表头命中过（才进得了表头模式）但既不是缓存主键也不带 id 后缀。
  // 注意不能拿「无表头的陌生列名」来测——那种粘贴走的是按位置对齐，列名根本不会是 code
  const nothing = parsePastedTable('order_no | status\nNO9 | 0', table)!
  assert.deepEqual(detectPk(nothing, table), { name: 'order_no', source: 'first' })

  assert.equal(resolvePk(noId, table, null).source, 'idName')
  assert.equal(resolvePk(noId, table, 'user_id').manual, true)
  // 换了一次粘贴后手动选的列不在了 → 回落自动，不能拿旧选择硬拼 WHERE
  assert.equal(resolvePk(noId, table, 'order_no').name, 'user_id')
})

test('目标值统一填 1：只把值有变化的行放进 IN，已是目标值的行跳过（拍板语义 1）', () => {
  const parsed = parsePastedTable(PASTE, table)!
  const r = buildSelectToUpdate(table, parsed, 'id', opts({ checked: { status: true }, targets: { status: '1' } }))
  assert.equal(r.includedCount, 2)
  assert.equal(r.skippedCount, 1)
  assert.equal(r.resolved.kind, 'in')
  assert.match(r.sql, /WHERE `id` IN \(101, 103\);/)
  assert.doesNotMatch(r.sql, /\b102\b/)
})

test('以粘贴值为准：目标值留空 = 粘贴里的就是要改成的值，全部行进 SQL、自动选 CASE WHEN（拍板语义 2）', () => {
  const parsed = parsePastedTable(PASTE, table)!
  const r = buildSelectToUpdate(table, parsed, 'id', opts({ checked: { total: true } }))
  assert.equal(r.resolved.kind, 'case')
  assert.equal(r.resolved.auto, true)
  assert.equal(r.includedCount, 3)
  assert.match(r.sql, /`total` = CASE `id`\n    WHEN 101 THEN 99\.00/)
  assert.match(r.sql, /WHEN 102 THEN 199\.00/)
  assert.match(r.sql, /WHERE `id` IN \(101, 102, 103\);/)
})

test('IN 与 CASE WHEN 可以混在一条语句里：统一值直接 SET，逐行值的走 CASE 块', () => {
  const parsed = parsePastedTable(PASTE, table)!
  const r = buildSelectToUpdate(
    table,
    parsed,
    'id',
    opts({ checked: { status: true, total: true }, targets: { status: '1' } }),
  )
  assert.equal(r.resolved.kind, 'case')
  // SET 项按表定义序排（total 第 4 列在 status 第 5 列前），同配置两次生成可 diff：
  // 统一值的 status 本可以平铺，逐行值的 total 走 CASE 块，两项逗号相连
  assert.match(r.sql, /SET\n  `total` = CASE `id`\n    WHEN 101 THEN 99\.00/)
  assert.match(r.sql, /    END,\n  `status` = 1\nWHERE/)
})

test('手动指定 IN 但有字段逐行不同：降级 CASE WHEN 并给出原因，绝不静默换形状（拍板语义 3）', () => {
  const parsed = parsePastedTable(PASTE, table)!
  const varying = ['total'].filter((f) => !uniformAcross(parsed, {}, f, includedIndices(parsed, ['total'], {})))
  const r = resolveFormat('in', varying)
  assert.equal(r.kind, 'case')
  assert.match(r.warning ?? '', /IN 格式表达不了/)

  const ok = resolveFormat('in', [])
  assert.equal(ok.kind, 'in')
  assert.equal(ok.warning, undefined)
})

test('逐条格式：每个入选主键一条完整 UPDATE，跳过的行不出现', () => {
  const parsed = parsePastedTable(PASTE, table)!
  const r = buildSelectToUpdate(
    table,
    parsed,
    'id',
    opts({ format: 'each', checked: { status: true }, targets: { status: '1' } }),
  )
  assert.equal(r.resolved.kind, 'each')
  assert.equal([...r.sql.matchAll(/UPDATE `order` SET/g)].length, 2)
  assert.match(r.sql, /WHERE `id` = 101;/)
  assert.match(r.sql, /WHERE `id` = 103;/)
  assert.doesNotMatch(r.sql, /WHERE `id` = 102/)
})

test('单列模式：勾了表结构里的字段但没填目标值 → 明确排除并列出原因，而不是悄悄 SET NULL', () => {
  const parsed = parsePastedTable('301\n302', table)!
  // 单列模式下 order_no 没有粘贴格子：不填目标值就是「不可用」
  assert.equal(fieldUsable(parsed, {}, 'order_no'), false)
  const r = buildSelectToUpdate(table, parsed, 'id', opts({ checked: { order_no: true } }))
  assert.deepEqual(r.invalidFields, ['order_no'])
  assert.match(r.sql, /还不能生成/)
  // 填上目标值就有效了
  const r2 = buildSelectToUpdate(table, parsed, 'id', opts({ checked: { order_no: true }, targets: { order_no: 'NO9' } }))
  assert.deepEqual(r2.invalidFields, [])
  assert.match(r2.sql, /SET\n  `order_no` = 'NO9'/)
})

test('全部行都已是目标值时不出空壳语句，明说不需要更新', () => {
  // 注意不能拿示例数据配 target=0：那会改到 status=1 的第 102 行，是「有变化」不是「全一致」
  const parsed = parsePastedTable('id | status\n102 | 1\n105 | 1', table)!
  const r = buildSelectToUpdate(table, parsed, 'id', opts({ checked: { status: true }, targets: { status: '1' } }))
  assert.equal(r.includedCount, 0)
  assert.equal(r.skippedCount, 2)
  assert.match(r.sql, /所有记录都已是目标值/)
})

test('Oracle：标识符双引号、字符串内单引号翻倍、日期走 TO_DATE——方言规则只来自 DialectSpec', () => {
  const paste = ["id | remark | create_time", "401 | it's ok | 2026-08-01 10:00:00"].join('\n')
  const parsed = parsePastedTable(paste, table)!
  const r = buildSelectToUpdate(
    table,
    parsed,
    'id',
    opts({
      dialect: 'oracle',
      checked: { remark: true, create_time: true },
      targets: { remark: "done't" },
    }),
  )
  assert.match(r.sql, /UPDATE "order" SET/)
  assert.match(r.sql, /"remark" = 'done''t'/)
  assert.match(r.sql, /TO_DATE\('2026-08-01 10:00:00', 'YYYY-MM-DD HH24:MI:SS'\)/)
})

test('真执行（MySQL 方言）：IN 格式跑完，只有该变的行变了', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE `order` (id INTEGER PRIMARY KEY, order_no TEXT, status INTEGER DEFAULT 0, total REAL)')
  db.exec("INSERT INTO `order` (id, order_no, status, total) VALUES (101,'NO001',0,99), (102,'NO002',1,199), (103,'NO003',0,59.5)")

  const parsed = parsePastedTable(PASTE, table)!
  const r = buildSelectToUpdate(table, parsed, 'id', opts({ dialect: 'mysql', checked: { status: true }, targets: { status: '1' } }))
  db.exec(r.sql)

  // node:sqlite 给的是 null-prototype 行对象，deepStrictEqual 比不了原型——展开成普通对象
  const rows = (db.prepare('SELECT id, status FROM `order` ORDER BY id').all() as Array<{ id: number; status: number }>).map((r) => ({ ...r }))
  assert.deepEqual(rows, [
    { id: 101, status: 1 },
    { id: 102, status: 1 }, // 本来就是 1：不在 WHERE 里，也不该被改坏
    { id: 103, status: 1 },
  ])
  db.close()
})

test('真执行（Oracle 引号风格）：CASE WHEN 跑完每行拿到各自的值，字符串引号翻倍没翻车', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE "order" (id INTEGER PRIMARY KEY, remark TEXT, total REAL)')
  db.exec(`INSERT INTO "order" (id, remark, total) VALUES (601, 'a', 0), (602, 'b', 0)`)
  const paste = ['id | remark | total', "601 | done't | 11.50", '602 | fine | 22.00'].join('\n')
  const parsed = parsePastedTable(paste, table)!
  const r = buildSelectToUpdate(table, parsed, 'id', opts({ dialect: 'oracle', checked: { remark: true, total: true } }))
  db.exec(r.sql)

  const rows = (db.prepare('SELECT id, remark, total FROM "order" ORDER BY id').all() as Array<{ id: number; remark: string; total: number }>).map((r) => ({ ...r }))
  assert.deepEqual(rows, [
    { id: 601, remark: "done't", total: 11.5 },
    { id: 602, remark: 'fine', total: 22 },
  ])
  db.close()
})

test('cellOf 对不存在的列返回 null，includedIndices 在无目标值时包含全部行', () => {
  const parsed = parsePastedTable(PASTE, table)!
  assert.equal(cellOf(parsed, 'not_there', 0), null)
  assert.deepEqual(includedIndices(parsed, ['total'], {}), [0, 1, 2])
})
