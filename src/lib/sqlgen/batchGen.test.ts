/**
 * 批量生成的回归测试，PRD v6.3 §4.15 / §4.16（原型 `mockup/batch-gen.html`）。
 *
 * 和 executable.test.ts 同一条底线：四道闸门证明不了「生成的 SQL 能跑」，
 * 主力用例把批量 INSERT / CASE WHEN UPDATE 放进 node:sqlite 真执行一遍，
 * 断言行数、逐行值、以及**只有给定的主键被改**——WHERE 范围错了不报错，只对字符串看不出来。
 * 每条用例名对应一个真会踩的形状或拍板过的一条语义（batchGen.ts 文件头七项）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { parseDdl } from '../ddlParser'
import {
  displayCell,
  generateBatchInsert,
  generateBatchUpdate,
  parsePkList,
  ruleVaries,
  type FieldRule,
  type InsertOptions,
  type UpdateOptions,
} from './batchGen'

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

const insOpt = (over: Partial<InsertOptions> = {}): InsertOptions => ({
  dialect: 'mysql',
  count: 5,
  format: 'each',
  perStmt: 10,
  startId: null,
  headerComment: false,
  rules: {},
  ...over,
})

const updOpt = (over: Partial<UpdateOptions> = {}): UpdateOptions => ({
  dialect: 'mysql',
  setOn: {},
  rules: {},
  locator: { mode: 'pk', raw: '', outputFormat: 'each', batchSize: 20 },
  ...over,
})

/* ================= 主键列表解析 ================= */

test('主键列表：范围写法直接展开、混着分隔符保序去重', () => {
  const r = parsePkList('1-3, 7；1001，1005\n1001')
  assert.deepEqual(r.list, ['1', '2', '3', '7', '1001', '1005'])
  assert.equal(r.overRange, 0)
  // 倒着的范围也认：a-b 写反了按 b-a 展开，不是丢掉
  assert.deepEqual(parsePkList('9-8').list, ['8', '9'])
})

test('主键列表：跨度超过 2000 的范围整段跳过并计数——手滑 1-99999999 不能把页面卡死', () => {
  const r = parsePkList('1-50000, 42')
  assert.equal(r.overRange, 1)
  assert.deepEqual(r.list, ['42'])
})

/* ================= 批量INSERT ================= */

test('确定性：同配置两次生成逐字符一致，「随机」是 (行号, 字段) 的哈希不是真随机（拍板③）', () => {
  const rules: Record<string, FieldRule> = {
    order_no: { k: 'rstr', p: { a: '12', b: 'alnum' } },
    total: { k: 'rnum', p: { a: '10', b: '999' } },
    remark: { k: 'renum', p: { a: '甲，乙,丙' } },
  }
  const a = generateBatchInsert(table, insOpt({ count: 20, rules }))
  const b = generateBatchInsert(table, insOpt({ count: 20, rules }))
  assert.equal(a.sql, b.sql)
  // 行与行之间真的不同（不然「每条字段值不同」这条 MVP 验收就没满足）
  const vals = [...a.sql.matchAll(/'([A-Za-z0-9]{12})'/g)].map((m) => m[1])
  assert.ok(new Set(vals).size > 1)
})

test('自增列：默认整列跳过；给了起始ID 就回到列清单并从它起连续编号（§4.15）', () => {
  const skip = generateBatchInsert(table, insOpt({ count: 2 }))
  assert.match(skip.sql, /^INSERT INTO `order` \(`user_id`,/)
  assert.doesNotMatch(skip.sql, /\(id,|\(`id`/)

  const withSid = generateBatchInsert(table, insOpt({ count: 3, startId: 8000, headerComment: false }))
  assert.match(withSid.sql, /`id`, `user_id`/)
  // 值清单换行缩进在 VALUES 之后（与 s2u 同款排版），别写成同行的正则
  assert.match(withSid.sql, /VALUES\n\s*\(8000,/)
  assert.match(withSid.sql, /VALUES\n\s*\(8002,/)
})

test('非自增主键：没填起始ID 也要连号写入，不能走自动值散列（撞主键就插不进去）', () => {
  const t = parseDdl(`
    CREATE TABLE item (
      id BIGINT PRIMARY KEY COMMENT '主键',
      name VARCHAR(20) NOT NULL
    );
  `).tables[0]!
  const r = generateBatchInsert(t, insOpt({ count: 3, headerComment: false }))
  assert.match(r.sql, /INSERT INTO `item` \(`id`, `name`\)/)
  assert.match(r.sql, /VALUES\n\s*\(1,/)
  assert.match(r.sql, /VALUES\n\s*\(3,/)
  const ids = [...r.sql.matchAll(/VALUES\n\s*\((\d+),/g)].map((m) => m[1])
  assert.deepEqual(ids, ['1', '2', '3'])
  assert.equal(new Set(ids).size, 3)
})

test('单列唯一索引：INSERT 连号，20 行互不重复；列级 UNIQUE 和表级 UNIQUE 都能认', () => {
  const colLevel = parseDdl(`
    CREATE TABLE t1 (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      code VARCHAR(20) NOT NULL UNIQUE
    );
  `).tables[0]!
  assert.equal(colLevel.columns.find((c) => c.name === 'code')?.isUnique, true)

  const tblLevel = parseDdl(`
    CREATE TABLE t2 (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      code VARCHAR(20) NOT NULL,
      UNIQUE KEY uk_code (code)
    );
  `).tables[0]!
  assert.equal(tblLevel.columns.find((c) => c.name === 'code')?.isUnique, true)

  const r = generateBatchInsert(colLevel, insOpt({ count: 20, headerComment: false }))
  const codes = [...r.sql.matchAll(/VALUES\n\s*\('(\d+)'\)/g)].map((m) => m[1])
  // 自增 id 被排除，VALUES 里只剩 code
  assert.equal(codes.length, 20)
  assert.deepEqual(codes, Array.from({ length: 20 }, (_, i) => String(i + 1)))
  assert.equal(new Set(codes).size, 20)

  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL)')
  db.exec(r.sql.replaceAll('`', ''))
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM t1').get() as { n: number }).n, 20)
  db.close()
})

test('复合唯一不往单列打标：那是元组约束，外键列仍可重复', () => {
  const t = parseDdl(`
    CREATE TABLE pair (
      a INT NOT NULL,
      b INT NOT NULL,
      UNIQUE KEY uk (a, b)
    );
  `).tables[0]!
  assert.equal(!!t.columns.find((c) => c.name === 'a')?.isUnique, false)
  assert.equal(!!t.columns.find((c) => c.name === 'b')?.isUnique, false)
})

test('字面量口径：先看列类型再看值的形状——手机号形状的值进 VARCHAR 列必须带引号', () => {
  // order_no 是 VARCHAR(32)：裸数字在 MySQL 里隐式转一下看不出错，Oracle/PG 直接类型报错
  const r = generateBatchInsert(
    table,
    insOpt({ count: 2, rules: { order_no: { k: 'fixed', p: { a: '13812345678' } } } }),
  )
  assert.match(r.sql, /'13812345678',/)
  assert.doesNotMatch(r.sql, /[^(]'13812345678''/)

  // 数字列反过来：值裸着（user_id 是无起始ID时的第一个单元格）
  const num = generateBatchInsert(
    table,
    insOpt({ count: 1, headerComment: false, rules: { user_id: { k: 'fixed', p: { a: '42' } } } }),
  )
  assert.match(num.sql, /VALUES\n\s*\(42,/)
})

test('方言：Oracle 标识符双引号、日期走 TO_DATE、NOW 类字面量换 SYSDATE——规则只来自 DialectSpec', () => {
  const r = generateBatchInsert(
    table,
    insOpt({
      dialect: 'oracle',
      count: 1,
      rules: {
        create_time: { k: 'rdate', p: { a: '2026-03-01', b: '2026-03-31' } },
        remark: { k: 'now' },
      },
    }),
  )
  assert.match(r.sql, /INSERT INTO "order"/)
  assert.match(r.sql, /TO_DATE\('2026-03-\d{2}', 'YYYY-MM-DD'\)/)
  // remark 排在 create_time 前面；SYSDATE 是裸字面量（RAW_EXPRESSIONS），带引号反而错
  assert.match(r.sql, /SYSDATE, TO_DATE\(/)
  assert.doesNotMatch(r.sql, /'SYSDATE'/)
})

test('多VALUES：MySQL / SQLite 直接收；Oracle / PG lib 层再降级并警告', () => {
  const my = generateBatchInsert(table, insOpt({ format: 'multi', count: 3 }))
  assert.equal([...my.sql.matchAll(/^INSERT INTO/gm)].length, 1)
  assert.match(my.sql, /\),\n\(/)

  const sq = generateBatchInsert(table, insOpt({ dialect: 'sqlite', format: 'multi', count: 3 }))
  assert.equal([...sq.sql.matchAll(/^INSERT INTO/gm)].length, 1)
  assert.match(sq.sql, /\),\n\(/)

  const pg = generateBatchInsert(table, insOpt({ dialect: 'postgresql', format: 'multi', count: 3 }))
  assert.equal([...pg.sql.matchAll(/^INSERT INTO/gm)].length, 3)
  assert.ok(pg.warnings.some((w) => /降级为逐条/.test(w.msg)))
})

test('分批：每组到条数就收口；条数没到但超 1MB 提前收口（§4.15 分批 INSERT）', () => {
  // perStmt=100 用不满，逼出尺寸切分：每行 ~20 万字符，6 行就破 1MB
  const big = generateBatchInsert(
    table,
    insOpt({
      count: 18,
      format: 'chunk',
      perStmt: 100,
      rules: { remark: { k: 'fixed', p: { a: 'x'.repeat(200_000) } } },
    }),
  )
  const stmts = [...big.sql.matchAll(/^INSERT INTO/gm)].length
  // 每行 ≈20 万字符：加到第 6 行时拼串超 1MB，于是每组收在 5 条——18 ÷ 5 上取整 = 4 组
  assert.equal(stmts, 4)
  // 且每一组都没超限（组内行数 × 单行长度 + 前缀 必须 ≤ LIMIT）
  for (const stmt of big.sql.split('\n\n')) {
    if (!stmt.startsWith('INSERT INTO')) continue
    assert.ok(stmt.length <= 1_048_576 + 210_000)
  }

  // 正常路径按条数收口
  const byCount = generateBatchInsert(table, insOpt({ count: 25, format: 'chunk', perStmt: 10 }))
  assert.equal([...byCount.sql.matchAll(/^INSERT INTO/gm)].length, 3)
})

test('显式规则逐种出值：模板替换行号 / 固定值 / 区间 / 枚举候选 / NULL', () => {
  const rules: Record<string, FieldRule> = {
    order_no: { k: 'tpl', p: { a: 'NO_{n}' } },
    user_id: { k: 'rnum', p: { a: '5', b: '5' } }, // min=max=5：确定性下必是 5
    remark: { k: 'renum', p: { a: '甲,乙' } },
    status: { k: 'null' },
  }
  const r = generateBatchInsert(table, insOpt({ count: 3, rules }))
  assert.match(r.sql, /'NO_1'/)
  assert.match(r.sql, /'NO_3'/)
  assert.match(r.sql, /\(5, 'NO_1'/) // user_id 固定 5，且是无起始ID时的首格
  assert.match(r.sql, /, NULL,/) // status 整列 NULL
})

test('显式规则参数没填：那一格按 NULL 输出，但警告里点名，绝不静默', () => {
  const r = generateBatchInsert(table, insOpt({ count: 1, rules: { remark: { k: 'fixed', p: { a: '' } } } }))
  assert.match(r.sql, /NULL/)
  assert.ok(r.warnings.some((w) => w.msg.includes('remark') && /参数没填/.test(w.msg)))
})

test('真执行（MySQL 方言）：批量 INSERT 真插进去，起始ID 连号且逐行值落在对的列上', () => {
  const db = new DatabaseSync(':memory:')
  // 列要跟 TableInfo 对齐（total/remark/create_time 都会进列清单）；SQLite 没有 NOW()，
  // create_time 给日期区间规则，别让默认的 NOW() 字面量在这里炸
  db.exec(
    'CREATE TABLE `order` (id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT, user_id INTEGER, status INTEGER, total REAL, remark TEXT, create_time TEXT)',
  )
  const r = generateBatchInsert(
    table,
    insOpt({
      count: 30,
      startId: 500,
      rules: {
        order_no: { k: 'tpl', p: { a: 'B{n}' } },
        user_id: { k: 'rnum', p: { a: '1', b: '5' } },
        create_time: { k: 'rdate', p: { a: '2026-08-01', b: '2026-08-02' } },
      },
    }),
  )
  db.exec(r.sql)
  const rows = (
    db.prepare('SELECT id, order_no FROM `order` ORDER BY id').all() as Array<{ id: number; order_no: string }>
  ).map((x) => ({ ...x }))
  assert.equal(rows.length, 30)
  assert.deepEqual(
    rows.map((x) => x.id),
    Array.from({ length: 30 }, (_, i) => 500 + i),
  )
  assert.equal(rows[0].order_no, 'B1')
  assert.equal(rows[29].order_no, 'B30')
  db.close()
})

/* ================= 批量UPDATE · 主键列表 ================= */

test('主键定位·逐条：每个主键一条 UPDATE，批次注释分隔，SET 值随行号走', () => {
  const r = generateBatchUpdate(
    table,
    updOpt({
      setOn: { order_no: true },
      rules: { order_no: { k: 'tpl', p: { a: 'NEW_{n}' } } },
      locator: { mode: 'pk', raw: '101-104', outputFormat: 'each', batchSize: 2 },
    }),
  )
  assert.equal([...r.sql.matchAll(/UPDATE `order` SET/g)].length, 4)
  assert.match(r.sql, /-- ── 第 1 批（2 条）──/)
  assert.match(r.sql, /-- ── 第 2 批（2 条）──/)
  assert.match(r.sql, /`order_no` = 'NEW_1'\nWHERE `id` = 101;/)
  assert.match(r.sql, /WHERE `id` = 104;/)
})

test('CASE WHEN：随行变化的列进 CASE 块、固定列普通赋值；每 100 个主键一组（§4.16）', () => {
  const raw = Array.from({ length: 101 }, (_, i) => String(900 + i)).join(',')
  const r = generateBatchUpdate(
    table,
    updOpt({
      setOn: { status: true, remark: true },
      rules: { status: { k: 'fixed', p: { a: '1' } }, remark: { k: 'tpl', p: { a: 'R{n}' } } },
      locator: { mode: 'pk', raw, outputFormat: 'case', batchSize: 20 },
    }),
  )
  // 101 个主键 → 两组
  assert.equal([...r.sql.matchAll(/WHERE `id` IN \(/g)].length, 2)
  assert.match(r.sql, /CASE `id`\n    WHEN 900 THEN 'R1'/)
  assert.match(r.sql, /WHEN 901 THEN 'R2'/)
  // 固定值列不进 CASE：第一组末尾平铺 status = 1
  assert.match(r.sql, /    END,\n`status` = 1\nWHERE/)
})

test('复合主键表的警告连拒绝分支一起带上——不能等用户配完 SET 才说', () => {
  const ddl = `
  CREATE TABLE user_role (
    user_id BIGINT NOT NULL,
    role_id BIGINT NOT NULL,
    PRIMARY KEY (user_id, role_id)
  );`
  const t = parseDdl(ddl).tables[0]!
  const r = generateBatchUpdate(t, updOpt({ setOn: {}, locator: { mode: 'pk', raw: '1,2,3', outputFormat: 'each', batchSize: 20 } }))
  assert.equal(r.refused, true)
  assert.ok(r.warnings.some((w) => /复合主键/.test(w.msg)))
})

test('主键列表为空 / 一个 SET 都没勾：占位注释说明原因，不出空壳语句', () => {
  const noPk = generateBatchUpdate(table, updOpt({ setOn: { remark: true }, locator: { mode: 'pk', raw: '  ', outputFormat: 'each', batchSize: 20 } }))
  assert.equal(noPk.refused, true)
  assert.match(noPk.sql, /先粘贴主键列表/)

  const noSet = generateBatchUpdate(table, updOpt({ locator: { mode: 'pk', raw: '1,2', outputFormat: 'each', batchSize: 20 } }))
  assert.equal(noSet.refused, true)
  assert.match(noSet.sql, /先勾选 SET 字段/)
})

test('真执行（MySQL）：CASE WHEN 跑完只有给定主键被改，各行拿到各自的值', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE `order` (id INTEGER PRIMARY KEY, order_no TEXT, status INTEGER DEFAULT 0, remark TEXT)')
  const seed = Array.from({ length: 6 }, (_, i) => `(${900 + i}, 'X${i}', 0, 'old')`).join(', ')
  db.exec(`INSERT INTO \`order\` (id, order_no, status, remark) VALUES ${seed}, (777, 'outsider', 0, 'keep')`)

  const r = generateBatchUpdate(
    table,
    updOpt({
      setOn: { status: true },
      rules: { status: { k: 'tpl', p: { a: '{n}0' } } }, // 901..906 → '10','20',...
      locator: { mode: 'pk', raw: '900-905', outputFormat: 'case', batchSize: 20 },
    }),
  )
  db.exec(r.sql)
  const rows = (
    db.prepare('SELECT id, status, remark FROM `order` ORDER BY id').all() as Array<{
      id: number
      status: number
      remark: string
    }>
  ).map((x) => ({ ...x }))
  assert.deepEqual(rows, [
    { id: 777, status: 0, remark: 'keep' }, // 不在列表里的行一个字节都不动（ORDER BY id 下它排最前）
    { id: 900, status: 10, remark: 'old' },
    { id: 901, status: 20, remark: 'old' },
    { id: 902, status: 30, remark: 'old' },
    { id: 903, status: 40, remark: 'old' },
    { id: 904, status: 50, remark: 'old' },
    { id: 905, status: 60, remark: 'old' },
  ])
  db.close()
})

test('真执行（Oracle 引号风格）：双引号标识符 + 单引号翻倍的固定值真跑一遍', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE "order" (id INTEGER PRIMARY KEY, remark TEXT)')
  db.exec(`INSERT INTO "order" (id, remark) VALUES (1, 'a'), (2, 'b')`)
  const r = generateBatchUpdate(
    table,
    updOpt({
      dialect: 'oracle',
      setOn: { remark: true },
      rules: { remark: { k: 'fixed', p: { a: "O'Brien" } } },
      locator: { mode: 'pk', raw: '1,2', outputFormat: 'case', batchSize: 20 },
    }),
  )
  assert.match(r.sql, /"order"/)
  assert.match(r.sql, /'O''Brien'/)
  db.exec(r.sql)
  const rows = (db.prepare('SELECT remark FROM "order" ORDER BY id').all() as Array<{ remark: string }>).map(
    (x) => ({ ...x }),
  )
  assert.deepEqual(rows.map((x) => x.remark), ["O'Brien", "O'Brien"])
  db.close()
})

/* ================= 批量UPDATE · 条件字段 ================= */

test('条件字段：空值和字面 null 都是 IS NULL，永远不是 = NULL', () => {
  const r = generateBatchUpdate(
    table,
    updOpt({
      setOn: { status: true },
      rules: { status: { k: 'fixed', p: { a: '1' } } },
      locator: { mode: 'cond', conditions: { remark: '', user_id: 'null', status: '1' } },
    }),
  )
  assert.match(r.sql, /`remark` IS NULL/)
  assert.match(r.sql, /`user_id` IS NULL/)
  assert.match(r.sql, /`status` = 1/)
  assert.doesNotMatch(r.sql, /= NULL/)
})

test('条件字段一个都没勾：err 警告 + 拒绝生成——无 WHERE 改全表的事不悄悄做', () => {
  const r = generateBatchUpdate(table, updOpt({ locator: { mode: 'cond', conditions: {} } }))
  assert.equal(r.refused, true)
  assert.ok(r.warnings.some((w) => w.tone === 'err'))
})

test('条件定位没有行号概念：随行变化的 SET 统一取第 1 行的值，黄牌明示而不是装没看见', () => {
  const r = generateBatchUpdate(
    table,
    updOpt({
      setOn: { remark: true },
      rules: { remark: { k: 'tpl', p: { a: '统一_{n}' } } },
      locator: { mode: 'cond', conditions: { status: '0' } },
    }),
  )
  assert.match(r.sql, /`remark` = '统一_1'/)
  assert.doesNotMatch(r.sql, /统一_2/)
  assert.ok(r.warnings.some((w) => /取第 1 行的值/.test(w.msg)))
  assert.match(r.sql, /注意：SET 规则随行号变化/)
})

/* ================= 批量UPDATE · 固定条件 WHERE 1=1 ================= */

test('WHERE 1=1：未确认拒绝生成；确认后才放行并常驻全表更新警告（拍板⑤一道闸）', () => {
  const blocked = generateBatchUpdate(
    table,
    updOpt({ setOn: { status: true }, locator: { mode: 'fixed', confirmed: false } }),
  )
  assert.equal(blocked.refused, true)
  assert.match(blocked.sql, /我确认要更新这张表的全部行/)

  const ok = generateBatchUpdate(
    table,
    updOpt({ setOn: { status: true }, rules: { status: { k: 'fixed', p: { a: '9' } } }, locator: { mode: 'fixed', confirmed: true } }),
  )
  assert.equal(ok.refused, false)
  assert.match(ok.sql, /WHERE 1=1;/)
  assert.ok(ok.warnings.some((w) => /更新全表/.test(w.msg)))
})

/* ================= 规则引擎杂项 ================= */

test('ruleVaries：fixed/now/null 三种对每行同值，其余（含缺省 auto）都随行走', () => {
  assert.equal(ruleVaries(undefined), true)
  assert.equal(ruleVaries({ k: 'auto' }), true)
  assert.equal(ruleVaries({ k: 'fixed' }), false)
  assert.equal(ruleVaries({ k: 'now' }), false)
  assert.equal(ruleVaries({ k: 'null' }), false)
  assert.equal(ruleVaries({ k: 'tpl' }), true)
})

test('displayCell 的 auto 直接调 mockValue（§4.4 只有一份），同一行两次取值一致、跨行不同', () => {
  const col = table.columns.find((c) => c.name === 'order_no')!
  const a1 = displayCell(table, col, 1, {}, 'insert', 'mysql')
  const a1again = displayCell(table, col, 1, {}, 'insert', 'mysql')
  const a2 = displayCell(table, col, 2, {}, 'insert', 'mysql')
  assert.equal(a1, a1again)
  assert.notEqual(a1, '')
  assert.notEqual(a1, a2) // 行号参与散列：不同行的自动值不同（「每条字段值不同」的根基）
  // update 阶段的值和 insert 阶段不同——先插后改要能看出变化
  const u1 = displayCell(table, col, 1, {}, 'update', 'mysql')
  assert.notEqual(a1, u1)
})
