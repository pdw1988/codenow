/**
 * sqladvise 回归。分三层钉：
 * ① 文本规则在掩码解析下不能误报（字符串/注释里的内容、BETWEEN 的 AND、括号组）；
 * ② 结合目录的索引规则要认最左前缀、主键、复合索引顺序；
 * ③ 方言差异（Oracle IN 1000 上限、绑定变量、MySQL 函数索引、SQLite ANALYZE）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sqlAdvise, advise, applyAdvice, type AdvCtx, type IndexDef, type SqlAdvice } from './sqladvise'
import type { Column } from '../types/schema'

function col(name: string, type: string, extra: Partial<Column> = {}): Column {
  return {
    name,
    type,
    nullable: true,
    isPrimaryKey: false,
    isAutoIncrement: false,
    javaField: name,
    javaType: 'String',
    ...extra,
  }
}

const T_ORDER: Column[] = [
  col('id', 'NUMBER', { isPrimaryKey: true }),
  col('order_no', 'VARCHAR2(32)'),
  col('amount', 'NUMBER'),
  col('status', 'VARCHAR2(8)'),
  col('created_at', 'DATE'),
  col('buyer_name', 'VARCHAR2(64)'),
  col('remark', 'VARCHAR2(500)'),
]

const IDX: IndexDef[] = [
  { table: 't_order', name: 'uk_order_no', columns: ['order_no'], unique: true },
  { table: 't_order', name: 'ix_status_created', columns: ['status', 'created_at'], unique: false },
]

const baseCtx = (over: Partial<AdvCtx> = {}): AdvCtx => ({
  dialect: 'oracle',
  colsOf: (t) => (t.toLowerCase() === 't_order' ? T_ORDER : undefined),
  indexesOf: (t) => (t.toLowerCase() === 't_order' ? IDX : undefined),
  ...over,
})

const ids = (sql: string, ctx: AdvCtx) => sqlAdvise(sql, ctx).map((a) => a.id)
const find = (sql: string, ctx: AdvCtx, id: string) => sqlAdvise(sql, ctx).find((a) => a.id === id)

/* ================= 结构解析不误报 ================= */

test('字符串与注释里的内容不触发规则', () => {
  const sql = "SELECT id FROM t_order WHERE order_no = '%zz' -- like '%x' or in (select 1 from x)"
  const got = ids(sql, baseCtx())
  assert.ok(!got.includes('like-leading'), JSON.stringify(got))
  assert.ok(!got.includes('not-in-subquery'))
})

test('BETWEEN 的 AND 不被当条件分隔', () => {
  const got = find(
    "SELECT id FROM t_order WHERE created_at BETWEEN DATE '2026-01-01' AND DATE '2026-02-01'",
    baseCtx(),
    'range-no-index',
  )
  // created_at 没有索引 → low 范围建议，且只此一条 where 规则
  assert.ok(got)
  assert.equal(got!.severity, 'low')
})

test('括号包住的 OR 组正常剥壳', () => {
  const sql = "SELECT id FROM t_order WHERE (status = 'A' OR status = 'B') AND amount = 100"
  const got = ids(sql, baseCtx())
  assert.ok(got.includes('eq-no-index')) // amount 没索引
  assert.ok(!got.includes('or-mix')) // OR 内是同列
})

test('WITH 开头的查询 v1 不分析（宁缺毋滥）', () => {
  const sql = "WITH hot AS (SELECT id FROM t_order WHERE amount > 100) SELECT * FROM hot"
  assert.deepEqual(sqlAdvise(sql, baseCtx()), [])
})

test('UNION 只分析第一段', () => {
  const sql =
    "SELECT id FROM t_order WHERE order_no = 'x' UNION SELECT id FROM t_order WHERE order_no = 'y'"
  // 第一段 order_no 有唯一索引，等值无索引不该报
  assert.equal(find(sql, baseCtx(), 'eq-no-index'), undefined)
})

/* ================= 索引结合目录 ================= */

test('等值列无索引 → high + CREATE INDEX 修复', () => {
  const a = find("SELECT id FROM t_order WHERE buyer_name = '张三'", baseCtx(), 'eq-no-index')!
  assert.equal(a.severity, 'high')
  assert.match(a.fix!, /CREATE INDEX/i)
  assert.match(a.fix!, /t_order/)
  assert.match(a.fix!, /buyer_name/)
})

test('主键与有索引的列不报无索引', () => {
  const sql = "SELECT id FROM t_order WHERE id = 5 AND order_no = 'A001'"
  assert.equal(find(sql, baseCtx(), 'eq-no-index'), undefined)
})

test('复合索引非首位列报最左前缀', () => {
  const a = find(
    "SELECT id FROM t_order WHERE created_at = DATE '2026-01-01' AND status = 'A'",
    baseCtx(),
    'eq-no-index',
  )
  // status 是索引首位 → 不报；created_at 在复合索引第二位 → 报，说明走不到
  assert.ok(a, 'created_at 应报无索引')
  assert.match(a!.title, /非首位/)
})

test('函数包列：列有索引时升 high，给函数索引 DDL', () => {
  const a = find(
    "SELECT id FROM t_order WHERE UPPER(order_no) = 'A001'",
    baseCtx(),
    'func-on-col',
  )!
  assert.equal(a.severity, 'high')
  assert.match(a.fix!, /UPPER\(order_no\)/)
})

test('无目录时函数包列只给文本级建议且为 mid', () => {
  const a = find(
    "SELECT id FROM t_order WHERE UPPER(order_no) = 'A001'",
    baseCtx({ indexesOf: () => undefined, colsOf: () => undefined }),
    'func-on-col',
  )!
  assert.equal(a.severity, 'mid')
})

test('隐式转换：数字列 vs 带引号字面量（Oracle）', () => {
  const a = find("SELECT id FROM t_order WHERE id = '5'", baseCtx(), 'implicit-cast')!
  assert.equal(a.severity, 'high')
  assert.match(a.why, /TO_NUMBER/)
})

test('隐式转换：字符串列 vs 裸数字', () => {
  const a = find('SELECT id FROM t_order WHERE order_no = 12345', baseCtx(), 'implicit-cast')!
  assert.equal(a.severity, 'high')
  assert.match(a.fix!, /'12345'/)
})

test('绑定参数不做类型检查', () => {
  assert.equal(
    find('SELECT id FROM t_order WHERE order_no = #{orderNo}', baseCtx(), 'implicit-cast'),
    undefined,
  )
})

/* ================= 文本规则 ================= */

test('SELECT * 单表 mid，带目录时给显式列清单', () => {
  const a = find('SELECT * FROM t_order', baseCtx(), 'star')!
  assert.equal(a.severity, 'mid')
  assert.match(a.fix!, /order_no/)
})

test('SELECT * JOIN 下升 high', () => {
  const ctx = baseCtx({
    colsOf: (t) => (t.toLowerCase() === 'sku' ? [col('id', 'INT', { isPrimaryKey: true })] : T_ORDER),
  })
  const a = find('SELECT * FROM t_order o JOIN sku s ON s.id = o.id', ctx, 'star')!
  assert.equal(a.severity, 'high')
})

test('无 WHERE 全表 info；有聚合或 LIMIT 不报', () => {
  assert.ok(ids('SELECT id FROM t_order', baseCtx()).includes('no-where'))
  assert.equal(find('SELECT COUNT(*) FROM t_order', baseCtx(), 'no-where'), undefined)
  assert.equal(find('SELECT id FROM t_order LIMIT 100', baseCtx(), 'no-where'), undefined)
  assert.equal(find('SELECT id FROM t_order WHERE ROWNUM <= 100', baseCtx(), 'no-where'), undefined)
})

test('NOT IN 子查询给 NOT EXISTS 改写', () => {
  const a = find(
    'SELECT id FROM t_order WHERE id NOT IN (SELECT order_id FROM t_refuse)',
    baseCtx(),
    'not-in-subquery',
  )!
  assert.equal(a.severity, 'mid')
  assert.match(a.fix!, /NOT EXISTS/)
})

test('OR 跨列等值 low', () => {
  const ctx = baseCtx({ indexesOf: () => undefined })
  const a = find(
    "SELECT id FROM t_order WHERE buyer_name = 'x' OR remark = 'y'",
    ctx,
    'or-mix',
  )!
  assert.equal(a.severity, 'low')
})

test('LEFT JOIN 右表被 WHERE 过滤 low', () => {
  const ctx = baseCtx({ colsOf: (t) => (t.toLowerCase() === 'sku' ? [col('id', 'INT', { isPrimaryKey: true })] : T_ORDER) })
  const a = find(
    "SELECT o.id FROM t_order o LEFT JOIN sku s ON s.id = o.sku_id WHERE s.sku_code = 'x'",
    ctx,
    'left-join-where',
  )!
  assert.equal(a.severity, 'low')
})

test('JOIN 无 ON 报笛卡尔积；旧式逗号连接有 WHERE 不报', () => {
  const ctx = baseCtx({ colsOf: (t) => (t.toLowerCase() === 'sku' ? T_ORDER : T_ORDER) })
  assert.ok(find('SELECT o.id FROM t_order o JOIN sku s', ctx, 'cartesian'))
  assert.equal(find('SELECT o.id FROM t_order o, sku s WHERE o.id = s.id', ctx, 'cartesian'), undefined)
})

test('JOIN 关联列无索引 high', () => {
  const ctx = baseCtx({
    colsOf: (t) =>
      t.toLowerCase() === 'sku'
        ? [col('id', 'INT', { isPrimaryKey: true }), col('order_id', 'INT')]
        : T_ORDER,
    indexesOf: (t) => (t.toLowerCase() === 'sku' ? [] : IDX),
  })
  const a = find('SELECT o.id FROM t_order o JOIN sku s ON s.order_id = o.id', ctx, 'join-col-no-index')!
  assert.equal(a.severity, 'high')
  assert.match(a.fix!, /sku/)
  assert.match(a.fix!, /order_id/)
})

test('覆盖索引：引用列全在索引里给 info 提示', () => {
  const a = find(
    "SELECT status, created_at FROM t_order WHERE status = 'A'",
    baseCtx(),
    'covering',
  )!
  assert.equal(a.severity, 'info')
  assert.match(a.title, /ix_status_created/)
})

test('排序不在索引里给复合索引建议', () => {
  const a = find(
    "SELECT id FROM t_order WHERE buyer_name = 'x' ORDER BY created_at DESC",
    baseCtx({ indexesOf: () => undefined }),
    'order-no-index',
  )
  // buyer_name 没索引时 eq-no-index 先行，order-no-index 不重复出手
  assert.equal(a, undefined)
  const b = find(
    "SELECT id FROM t_order WHERE status = 'A' ORDER BY buyer_name",
    baseCtx(),
    'order-no-index',
  )!
  assert.match(b.fix!, /status, buyer_name/)
})

test('深分页给 keyset 改写；浅分页不报', () => {
  const a = find('SELECT id FROM t_order ORDER BY id LIMIT 20 OFFSET 5000', baseCtx(), 'deep-offset')!
  assert.match(a.fix!, /keyset|游标/)
  assert.equal(find('SELECT id FROM t_order ORDER BY id LIMIT 20 OFFSET 30', baseCtx(), 'deep-offset'), undefined)
})

test('SELECT 列表里的子查询 mid', () => {
  const a = find(
    'SELECT id, (SELECT name FROM t_user u WHERE u.id = o.buyer_id) FROM t_order o',
    baseCtx({ indexesOf: () => undefined }),
    'subquery-in-select',
  )!
  assert.equal(a.severity, 'mid')
})

test('宽行拉取：25 列以上 info', () => {
  const wide = Array.from({ length: 30 }, (_, i) => col(`c${i}`, 'VARCHAR2(8)'))
  const ctx = baseCtx({ colsOf: () => wide })
  const sql = `SELECT ${wide.map((c) => c.name).join(', ')} FROM t_order WHERE remark = 'x'`
  const a = find(sql, ctx, 'wide-select')!
  assert.match(a.title, /30 个/)
})

/* ================= 方言差异 ================= */

test('Oracle IN 满 1000 报 ORA-01795 high；MySQL 500 项 mid', () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => `'${i}'`).join(', ')
  const oracle = find(`SELECT id FROM t_order WHERE remark IN (${list(1000)})`, baseCtx(), 'in-long')!
  assert.equal(oracle.severity, 'high')
  assert.match(oracle.why, /ORA-01795/)
  const mysql = find(
    `SELECT id FROM t_order WHERE remark IN (${list(300)})`,
    baseCtx({ dialect: 'mysql' }),
    'in-long',
  )!
  assert.equal(mysql.severity, 'mid')
})

test('MySQL 缺索引修复用 ALTER TABLE 语法', () => {
  const a = find(
    "SELECT id FROM t_order WHERE buyer_name = 'x'",
    baseCtx({ dialect: 'mysql' }),
    'eq-no-index',
  )!
  assert.match(a.fix!, /ALTER TABLE/)
  assert.ok(!a.fix!.includes('ANALYZE'))
})

test('SQLite 缺索引修复带 ANALYZE', () => {
  const a = find(
    "SELECT id FROM t_order WHERE buyer_name = 'x'",
    baseCtx({ dialect: 'sqlite' }),
    'eq-no-index',
  )!
  assert.match(a.fix!, /ANALYZE/)
})

/* ================= 索引落地清单 ================= */

const T_LINE: Column[] = [
  col('id', 'NUMBER', { isPrimaryKey: true }),
  col('order_id', 'NUMBER'),
  col('qty', 'NUMBER'),
]

/**
 * 两张表、都没有索引。连库查询的真实输入就是这样：目录有、索引元数据空数组
 * （表建了没建索引），规则才肯出声。
 */
const twoCtx = baseCtx({
  colsOf: (t) =>
    t.toLowerCase() === 't_order' ? T_ORDER : t.toLowerCase() === 't_line' ? T_LINE : undefined,
  indexesOf: (t) => (t.toLowerCase() === 't_order' ? IDX : []),
})

test('同一个列被 WHERE 和 JOIN 同时指到，清单里只留一条', () => {
  const r = advise(
    'SELECT o.id, l.qty FROM t_order o JOIN t_line l ON l.order_id = o.id WHERE l.order_id = 100',
    twoCtx,
  )
  const need = r.indexes.filter(
    (n) => n.table.toLowerCase() === 't_line' && n.cols.join(',') === 'order_id',
  )
  assert.equal(need.length, 1)
  // 谁把它推出来的都要在：只留一条规则的话，用户以为只有一种改法
  assert.deepEqual(
    need[0]!.reasons.map((x) => x.id).sort(),
    ['eq-no-index', 'join-col-no-index'],
  )
  assert.ok(need[0]!.reasons.every((x) => x.title !== x.id))
})

test('清单里的 DDL 和建议里的 fix 是同一条语句', () => {
  const sql = "SELECT id FROM t_order WHERE buyer_name = 'x'"
  const r = advise(sql, baseCtx({ dialect: 'mysql' }))
  const a = r.advice.find((x) => x.id === 'eq-no-index')!
  assert.equal(r.indexes.length, 1)
  assert.equal(r.indexes[0]!.ddl, a.fix)
  assert.match(r.indexes[0]!.ddl, /^ALTER TABLE t_order ADD INDEX /)
})

/* ==== 索引名不能撞 ==== */

test('库里已有同名的索引（列序对不上），新目录名字后退一位', () => {
  // 表名取得长，为的是同时钉住「后缀也算进 30 字符」：先截短主干再补 _2，
  // 不是截满 30 再补，那样会超出 Oracle 的标识符上限
  const table = 't_customer_account_balance'
  const stem = `idx_${table}_code`
  const ctx = baseCtx({
    colsOf: () => [col('id', 'NUMBER', { isPrimaryKey: true }), col('code', 'VARCHAR2(16)')],
    indexesOf: () => [
      // 名字正好是我们要用的那个，但列是 (id, ...)——打头列不对，code 用不上它
      { table, name: stem.slice(0, 30), columns: ['id', 'code'], unique: false },
    ],
  })
  const a = find(`SELECT id FROM ${table} WHERE code = 'x'`, ctx, 'eq-no-index')!
  assert.ok(a, '列序对不上，这个索引照样要建')
  const name = a.fix!.match(/INDEX (\S+)/)![1]!
  assert.equal(name, stem.slice(0, 28) + '_2')
  assert.equal(name.length, 30)
})

/**
 * buyer_name 在 `ix_status_buyer` 的第二位。这个阵型下面同一条 SQL 会提两条索引：
 * 等值一条 `(buyer_name)`（最左前缀走不到，排第二位等于没有）、分组一条
 * `(buyer_name, created_at)`（现成索引第一列是 status，盖不住）。两条第一列相同，
 * 机械拼名字会给出两个 `idx_t_order_buyer_name`。
 */
const collideCtx = baseCtx({
  indexesOf: () => [
    { table: 't_order', name: 'ix_status_buyer', columns: ['status', 'buyer_name'], unique: false },
  ],
})

test('同一次分析给同一张表提两条，名字不能撞', () => {
  const r = advise(
    "SELECT buyer_name, COUNT(1) FROM t_order WHERE buyer_name = 'x' GROUP BY buyer_name, created_at",
    collideCtx,
  )
  const eq = r.indexes.find((n) => n.cols.join(',') === 'buyer_name')!
  const gp = r.indexes.find((n) => n.cols.join(',') === 'buyer_name,created_at')!
  assert.ok(eq && gp, JSON.stringify(r.indexes.map((n) => n.cols)))
  // 只躲库里现有的不够：这条 SQL 还没执行完，第二条已经在用同一个名字了
  assert.notEqual(eq.ddl, gp.ddl)
  assert.equal(eq.ddl, 'CREATE INDEX idx_t_order_buyer_name ON t_order (buyer_name) ONLINE;')
  assert.equal(
    gp.ddl,
    'CREATE INDEX idx_t_order_buyer_name_2 ON t_order (buyer_name, created_at) ONLINE;',
  )
})

test('分组建索引给整条 DDL，不再掺在解释里', () => {
  const a = find(
    'SELECT buyer_name, COUNT(1) FROM t_order GROUP BY buyer_name',
    baseCtx(),
    'group-no-index',
  )!
  assert.equal(a.fix, 'CREATE INDEX idx_t_order_buyer_name ON t_order (buyer_name) ONLINE;')
  assert.ok(!a.fix!.includes('经常'))
})

test('等值 + 排序列已被现成复合索引覆盖，清单不再重复建', () => {
  const r = advise(
    "SELECT id FROM t_order WHERE status = '1' ORDER BY created_at",
    twoCtx,
  )
  // ix_status_created 正好是 (status, created_at)，已经覆盖了就不要再建
  assert.equal(r.indexes.length, 0)
})

test('没有索引元数据（还没拉）时清单是空的，不猜', () => {
  const r = advise(
    'SELECT id FROM t_order WHERE buyer_name = ?',
    baseCtx({ indexesOf: () => undefined }),
  )
  assert.equal(r.indexes.length, 0)
})

test('Oracle 多字面量提示绑定变量', () => {
  const a = find(
    "SELECT id FROM t_order WHERE buyer_name = 'a' AND remark = 'b' AND status = 'c'",
    baseCtx(),
    'bind-vars',
  )!
  assert.equal(a.severity, 'info')
})

test('没目录也能出的纯文本规则照常工作', () => {
  const ctx = baseCtx({ colsOf: () => undefined, indexesOf: () => undefined })
  const got = ids("SELECT * FROM t_order WHERE order_no LIKE '%001'", ctx)
  assert.ok(got.includes('like-leading'))
  assert.ok(got.includes('star'))
  assert.ok(!got.includes('eq-no-index'))
})

test('解析不动的输入静默返回空', () => {
  assert.deepEqual(sqlAdvise('', baseCtx()), [])
  assert.deepEqual(sqlAdvise('UPDATE t SET a = 1', baseCtx()), [])
  assert.deepEqual(sqlAdvise('SELECT 1', baseCtx()), [])
})

/* ================= 定位与一键应用 ================= */

test('单表裸 *：定位到星号，一键展开成显式列', () => {
  const sql = "SELECT * FROM t_order WHERE buyer_name = 'x'"
  const a = find(sql, baseCtx(), 'star')!
  assert.ok(a.at, '应该带定位')
  assert.equal(sql.slice(a.at!.start, a.at!.end), '*')
  assert.ok(a.apply, '单表应该可以一键展开')
  const next = applyAdvice(sql, a)!
  assert.ok(
    next.startsWith('SELECT id, order_no, amount, status, created_at, buyer_name, remark FROM t_order'),
    next,
  )
})

test('alias.* 展开带别名前缀', () => {
  const sql = 'SELECT o.* FROM t_order o'
  const a = find(sql, baseCtx(), 'star')!
  assert.equal(a.apply!.find, 'o.*')
  assert.equal(
    applyAdvice(sql, a),
    'SELECT o.id, o.order_no, o.amount, o.status, o.created_at, o.buyer_name, o.remark FROM t_order o',
  )
})

test('JOIN 下的裸 * 只定位不给一键展开（列序 / 前缀不去猜）', () => {
  const ctx = baseCtx({
    colsOf: (t) => (t.toLowerCase() === 'sku' ? [col('id', 'INT', { isPrimaryKey: true })] : T_ORDER),
  })
  const a = find('SELECT * FROM t_order o JOIN sku s ON s.id = o.id', ctx, 'star')!
  assert.ok(a.at, 'JOIN 下仍可定位')
  assert.equal(a.apply, undefined)
})

test('count(*) 的星号不会中一键展开', () => {
  const sql = 'SELECT COUNT(*) FROM t_order'
  assert.equal(find(sql, baseCtx(), 'star'), undefined, 'count(*) 不是 star 规则的活')
  // 就算别的路径给了 apply，深度守卫也不能把 count(*) 里的星号换掉
  const fake: SqlAdvice = {
    id: 'star', severity: 'mid', title: 'x', why: 'y', apply: { find: '*', replace: 'id' },
  }
  assert.equal(applyAdvice(sql, fake), null)
})

test('SQL 改过别处仍能应用；星号没了返回 null', () => {
  const a = find('SELECT * FROM t_order', baseCtx(), 'star')!
  const next = applyAdvice('SELECT * FROM t_order WHERE id = 1', a)!
  assert.ok(next.includes('WHERE id = 1'), '别处加的条件不能丢')
  assert.equal(applyAdvice('SELECT id FROM t_order', a), null, '星号已经不在了')
  assert.equal(applyAdvice('', a), null)
})

test('WHERE 规则的定位选中的就是那条条件', () => {
  const sql = "SELECT id FROM t_order WHERE buyer_name = '张三' AND remark = 'x'"
  const a = find(sql, baseCtx(), 'eq-no-index')!
  assert.ok(a.at)
  assert.equal(sql.slice(a.at!.start, a.at!.end).trim(), "buyer_name = '张三'")
})

test('JOIN ON 条件的定位指向 ON 里那段', () => {
  const ctx = baseCtx({
    colsOf: (t) =>
      t.toLowerCase() === 'sku'
        ? [col('id', 'INT', { isPrimaryKey: true }), col('order_id', 'INT')]
        : T_ORDER,
    indexesOf: (t) => (t.toLowerCase() === 'sku' ? [] : IDX),
  })
  const sql = 'SELECT o.id FROM t_order o JOIN sku s ON s.order_id = o.id'
  const a = find(sql, ctx, 'join-col-no-index')!
  assert.ok(a.at)
  assert.equal(sql.slice(a.at!.start, a.at!.end), 's.order_id = o.id')
})
