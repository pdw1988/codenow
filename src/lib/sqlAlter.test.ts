import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  alterDisabledReason,
  alterTableTargets,
  assertAlterStmt,
  hasCreateIndex,
  hasDropColumn,
  looksReadonly,
  planAlter,
  splitRunInput,
} from './sqlAlter'
import { buildAlterDdl, diffColumns } from './sqlgen/ddlAlter'
import type { Column } from '../types/schema'

const col = (name: string, type: string, extra: Partial<Column> = {}): Column => ({
  name,
  type,
  nullable: true,
  isPrimaryKey: false,
  isAutoIncrement: false,
  javaField: name,
  javaType: 'String',
  ...extra,
})

test('ALTER TABLE / COMMENT ON 放行；ALTER SESSION 和 DROP 拒', () => {
  assert.doesNotThrow(() => assertAlterStmt('ALTER TABLE t ADD (name VARCHAR2(50))'))
  assert.doesNotThrow(() => assertAlterStmt(`COMMENT ON COLUMN "t"."name" IS '姓名'`))
  assert.doesNotThrow(() => assertAlterStmt("COMMENT ON TABLE t IS '用户'"))
  assert.throws(() => assertAlterStmt("ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY'"), /ALTER TABLE/)
  assert.throws(() => assertAlterStmt('DROP TABLE t'), /不跑 DROP/)
  assert.throws(() => assertAlterStmt('CREATE TABLE t (id INT)'), /AS SELECT/)
  assert.doesNotThrow(() => assertAlterStmt('INSERT INTO t VALUES (1)'))
  assert.throws(() => assertAlterStmt('TRUNCATE TABLE t'), /不跑 TRUNCATE/)
  assert.throws(() => assertAlterStmt('COMMENT ON INDEX t_pk IS x'), /COMMENT ON/)
})

test('手写 UPDATE / DELETE / INSERT 放行；-- 注释不碍事（常见的一组改数语句）', () => {
  // 备份单据：数字长 ID 的 IN 清单不碍事
  assert.doesNotThrow(() =>
    assertAlterStmt(
      'CREATE TABLE TMP_APPLY_BAK_0924 AS\nSELECT * FROM T_SHOP_ORDER_APPLY WHERE ID IN (1900000000000000001, 1900000000000000002)',
    ),
  )
  assert.doesNotThrow(() => assertAlterStmt('CREATE TABLE t AS (SELECT * FROM u)'))
  // schema + IF NOT EXISTS + 长表名（数字会被拆段）也必须在 16 个词内判得出
  assert.doesNotThrow(() =>
    assertAlterStmt('CREATE TABLE IF NOT EXISTS SHOP.T_SHOP_ORDER_APPLY_0924 AS SELECT 1 FROM u'),
  )
  // SET 里夹注释行、注释里带引号：SET / WHERE 判据看的是裸代码
  assert.doesNotThrow(() =>
    assertAlterStmt(`UPDATE T_SHOP_ORDER_APPLY
   SET STATUS = 0,                        -- 0 = 待提交
       FLOW_INSTANCE_ID = NULL,
       CURR_NODE_ID = NULL,
       CURR_USER_CODE = NULL
     -- , USER_CODE = '1000002'         -- 需要换发起人时放开
 WHERE ID = 1900000000000000001`),
  )
  assert.doesNotThrow(() =>
    assertAlterStmt('DELETE FROM T_SHOP_ORDER_APPROVE_LOG WHERE APPLY_ID = 1900000000000000001'),
  )
  assert.doesNotThrow(() => assertAlterStmt('INSERT INTO t (a) VALUES (1)'))
  assert.doesNotThrow(() => assertAlterStmt('INSERT INTO t SELECT * FROM u WHERE id = 1'))
})

test('手写 DML 缺 WHERE / SET / INTO 拒；普通建表仍拒', () => {
  assert.throws(() => assertAlterStmt('UPDATE t SET a = 1'), /WHERE/)
  assert.throws(() => assertAlterStmt('UPDATE t WHERE id = 1'), /SET/)
  // 注释里的 WHERE 不算数
  assert.throws(() => assertAlterStmt('UPDATE t SET a = 1 -- WHERE id = 1'), /WHERE/)
  assert.throws(() => assertAlterStmt('DELETE FROM t'), /WHERE/)
  assert.throws(() => assertAlterStmt('DELETE FROM t -- WHERE id = 1'), /WHERE/)
  assert.throws(() => assertAlterStmt('INSERT t VALUES (1)'), /INTO/)
  assert.throws(() => assertAlterStmt('INSERT t /* INTO */ VALUES (1)'), /INTO/)
  assert.throws(() => assertAlterStmt('CREATE GLOBAL TEMPORARY TABLE t AS SELECT 1 FROM u'), /不跑/)
  assert.throws(() => assertAlterStmt('CREATE OR REPLACE TABLE t AS SELECT 1 FROM u'), /不跑/)
  assert.throws(() => assertAlterStmt('SELECT * FROM t'), /不跑 SELECT/)
})

test('CREATE INDEX / ANALYZE 放行；别的 CREATE 拒', () => {
  assert.doesNotThrow(() =>
    assertAlterStmt('CREATE INDEX idx_t_order_buyer_name ON t_order (buyer_name) ONLINE'),
  )
  assert.doesNotThrow(() => assertAlterStmt('CREATE UNIQUE INDEX uk_x ON t (a)'))
  assert.doesNotThrow(() => assertAlterStmt('CREATE BITMAP INDEX bx ON t (a)'))
  assert.doesNotThrow(() => assertAlterStmt('CREATE UNIQUE BITMAP INDEX bx ON t (a)'))
  assert.doesNotThrow(() => assertAlterStmt('CREATE INDEX CONCURRENTLY ix ON t (a)'))
  assert.doesNotThrow(() => assertAlterStmt('CREATE INDEX IF NOT EXISTS ix ON t (a)'))
  assert.doesNotThrow(() => assertAlterStmt('ALTER TABLE t ADD INDEX ix (a)'))
  assert.doesNotThrow(() => assertAlterStmt('ANALYZE'))
  assert.doesNotThrow(() => assertAlterStmt('ANALYZE TABLE t'))
  // 没有 INDEX 这个词的 CREATE 一条都不进
  assert.throws(() => assertAlterStmt('CREATE OR REPLACE VIEW v AS SELECT 1'), /CREATE/)
  assert.throws(() => assertAlterStmt('CREATE USER u IDENTIFIED BY x'), /CREATE/)
  assert.throws(() => assertAlterStmt('CREATE DATABASE d'), /CREATE/)
  // 注释里的 CREATE INDEX 不算数：真语句是 DROP TABLE，照拒
  assert.throws(() => assertAlterStmt('-- CREATE INDEX 说明\nDROP TABLE t'), /DROP/)
  // 建索引不改列：字段表不用重拉，但索引字典要作废
  assert.equal(hasCreateIndex('CREATE INDEX ix ON t (a)'), true)
  assert.equal(hasCreateIndex('-- CREATE INDEX 说明\nALTER TABLE t ADD (x INT)'), false)
  assert.equal(hasCreateIndex('CREATE TABLE t (id INT)'), false)
})

test('索引落地整份脚本能过闸门（SQLite 那条带 ANALYZE）', () => {
  // 「复制全部 DDL」的真实形状：每条前面一行来源注释，SQLite 建完还要 ANALYZE
  const sql = `-- t_order(buyer_name)：等值条件列没有索引
CREATE INDEX idx_t_order_buyer_name ON t_order (buyer_name);

-- t_order(buyer_name, created_at)：分组列不在索引里
CREATE INDEX idx_t_order_buyer_name_2 ON t_order (buyer_name, created_at);
ANALYZE;`
  const plan = planAlter(sql)
  assert.equal(plan.statements.length, 3)
  assert.equal(plan.drops, false)
  assert.match(plan.statements[2]!, /^ANALYZE$/)
  // 真在 sqlite 里跑一遍：建完索引 ANALYZE 完，表还在、索引真在
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t_order (buyer_name TEXT, created_at TEXT)')
  for (const s of plan.statements) db.exec(s)
  const idx = db.prepare(`PRAGMA index_list(t_order)`).all() as { name: string }[]
  assert.deepEqual(
    idx.map((i) => i.name).sort(),
    ['idx_t_order_buyer_name', 'idx_t_order_buyer_name_2'],
  )
})

test('looksReadonly：查询框分流的判据', () => {
  assert.equal(looksReadonly('SELECT * FROM t'), true)
  assert.equal(looksReadonly('WITH x AS (SELECT 1) SELECT * FROM x'), true)
  assert.equal(looksReadonly('SHOW TABLES'), true)
  assert.equal(looksReadonly('EXPLAIN SELECT * FROM t'), true)
  // 空段 / 纯注释按查询处理：让只读闸门去说「请输入一条 SELECT」
  assert.equal(looksReadonly(''), true)
  assert.equal(looksReadonly('-- 只是说明'), true)
  // 有一条不是查询，整份就走写路径——不悄悄挑出能跑的那几条
  assert.equal(looksReadonly('UPDATE t SET a = 1 WHERE id = 1'), false)
  assert.equal(looksReadonly('SELECT 1; UPDATE t SET a = 1 WHERE id = 1'), false)
  assert.equal(looksReadonly('CREATE TABLE t AS SELECT * FROM u'), false)
  // FOR UPDATE 是写意图，只读闸门认得出
  assert.equal(looksReadonly('SELECT * FROM t FOR UPDATE'), false)
  // SELECT 后面跟 COMMIT 也不算查询
  assert.equal(looksReadonly('SELECT 1; COMMIT'), false)
})

test('planAlter 分清 dml / ctas / drops，确认框按这个点名', () => {  const sql = `CREATE TABLE TMP_BAK AS SELECT * FROM t WHERE id = 1;
DELETE FROM t WHERE id = 999;
UPDATE t SET a = 1 WHERE id = 1;
COMMENT ON COLUMN t.a IS '说明';`
  const plan = planAlter(sql)
  assert.equal(plan.statements.length, 4)
  assert.equal(plan.ctas, 1)
  assert.equal(plan.dml, 2)
  assert.equal(plan.drops, false)
  const withDrop = planAlter('ALTER TABLE t DROP COLUMN old; UPDATE t SET a = 1 WHERE id = 1')
  assert.equal(withDrop.drops, true)
  assert.equal(withDrop.dml, 1)
})

test('一次只跑一条；行首注释不算第二段', () => {
  assert.throws(
    () => assertAlterStmt('ALTER TABLE t ADD (a INT); DROP TABLE t'),
    /第二段/,
  )
  assert.doesNotThrow(() =>
    assertAlterStmt(`-- 加一列
ALTER TABLE t ADD COLUMN extra INT`),
  )
})

test('buildAlterDdl 的产物能拆出来在 sqlite 里跑', () => {
  const d = diffColumns([col('id', 'INT')], [col('id', 'INT'), col('extra', 'INT')])
  const sql = buildAlterDdl('t', d, 'sqlite')
  const plan = planAlter(sql)
  assert.equal(plan.statements.length, 1)
  assert.equal(plan.drops, false)
  assert.match(plan.statements[0], /ALTER TABLE/)
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (id INTEGER)')
  db.exec(plan.statements[0])
  const cols = db.prepare(`PRAGMA table_info(t)`).all() as { name: string }[]
  assert.ok(cols.some((c) => c.name === 'extra'))
})

test('删列：DROP COLUMN 放行，能在 sqlite 里真删掉', () => {
  assert.equal(hasDropColumn('ALTER TABLE t DROP COLUMN old'), true)
  assert.equal(hasDropColumn('ALTER TABLE t DROP (old)'), true)
  assert.equal(hasDropColumn('ALTER TABLE t ADD COLUMN extra INT'), false)
  const d = diffColumns([col('id', 'INT'), col('old', 'INT')], [col('id', 'INT')])
  const sql = buildAlterDdl('t', d, 'sqlite')
  const plan = planAlter(sql)
  assert.equal(plan.drops, true)
  assert.equal(plan.statements.length, 1)
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (id INTEGER, old INTEGER)')
  db.exec(plan.statements[0])
  const cols = db.prepare(`PRAGMA table_info(t)`).all() as { name: string }[]
  assert.deepEqual(cols.map((c) => c.name), ['id'])
})

test('粘贴脚本：COMMIT / ROLLBACK 丢掉，ALTER + COMMENT ON 照跑', () => {
  const sql = `ALTER TABLE SHOP.T_SHOP_VIEW_VARIETY_ALY_DIL ADD (
    COUNTRY_ID    NUMBER(25)     NULL
);
COMMENT ON COLUMN SHOP.T_SHOP_VIEW_VARIETY_ALY_DIL.COUNTRY_ID IS '国家ID';
COMMIT;`
  const plan = planAlter(sql)
  assert.equal(plan.statements.length, 2)
  assert.match(plan.statements[0], /ALTER TABLE/)
  assert.match(plan.statements[1], /COMMENT ON COLUMN/)
  assert.equal(plan.drops, false)
  assert.throws(() => planAlter('COMMIT;'), /没有可执行/)
})

test('ALTER TABLE 后面的表名：带 schema、带引号', () => {
  assert.deepEqual(
    alterTableTargets('ALTER TABLE SHOP.T_SHOP_VIEW_VARIETY_ALY_DIL ADD (x INT)'),
    ['SHOP.T_SHOP_VIEW_VARIETY_ALY_DIL'],
  )
  assert.deepEqual(alterTableTargets('ALTER TABLE "USER" ADD (x INT)'), ['USER'])
  assert.deepEqual(
    alterTableTargets('COMMENT ON COLUMN t.x IS \'a\'; ALTER TABLE t ADD (y INT)'),
    ['t'],
  )
})

test('纯注释 / 只有主键变化：没有可执行语句', () => {
  assert.throws(() => planAlter('-- 只是说明\n-- 另一行'), /没有可执行/)
  // SQLite 改主键只出说明行；Oracle 的 MODIFY 会照常生成（约束语句才进 manual）
  const d = diffColumns(
    [col('id', 'BIGINT')],
    [col('id', 'BIGINT', { isPrimaryKey: true, isAutoIncrement: true })],
  )
  const sql = buildAlterDdl('t', d, 'sqlite')
  assert.throws(() => planAlter(sql), /没有可执行/)
})

test('没连上 / 方言对不上 / 浏览器：禁用并说明', () => {
  const sql = 'ALTER TABLE t ADD COLUMN extra INT'
  assert.match(
    alterDisabledReason({ sql, pageDialect: 'oracle', session: null, isTauri: true }) ?? '',
    /还没连库/,
  )
  assert.match(
    alterDisabledReason({
      sql,
      pageDialect: 'oracle',
      session: { kind: 'mysql' },
      isTauri: true,
    }) ?? '',
    /MySQL/,
  )
  assert.match(
    alterDisabledReason({
      sql,
      pageDialect: 'mysql',
      session: { kind: 'mysql' },
      isTauri: false,
    }) ?? '',
    /浏览器/,
  )
  assert.equal(
    alterDisabledReason({
      sql,
      pageDialect: 'mysql',
      session: { kind: 'mysql' },
      isTauri: true,
    }),
    null,
  )
  assert.match(
    alterDisabledReason({
      sql,
      pageDialect: 'mysql',
      session: { kind: 'mysql' },
      isTauri: true,
      invalid: '有字段名是空的',
    }) ?? '',
    /空的/,
  )
})

/* ================= 查询框写查混排分流（splitRunInput） ================= */

test('splitRunInput: 纯查询走查询路，不做任何拆分', () => {
  const r = splitRunInput('select * from t_user where id = 1')
  assert.equal(r.writes, null)
  assert.equal(r.lastSelect, null)
})

test('splitRunInput: 单条 UPDATE 整份进确认链，没有回查', () => {
  const r = splitRunInput("UPDATE t_user SET status = 1 WHERE id = 1942968769561371279")
  assert.match(r.writes!, /UPDATE t_user/)
  assert.equal(r.lastSelect, null)
})

test('splitRunInput: UPDATE + 回查 SELECT 混排——写进确认链，SELECT 留作回查', () => {
  const r = splitRunInput(
    "UPDATE t_user SET status = 1 WHERE id = 2;\nSELECT id, status FROM t_user WHERE id = 2;",
  )
  assert.match(r.writes!, /^UPDATE/)
  assert.equal(r.writes!.includes('SELECT'), false)
  assert.match(r.lastSelect!, /SELECT id, status FROM t_user/)
})

test('splitRunInput: 多条写语句 + 一条回查——写语句合并成一份，取最后一条 SELECT', () => {
  const r = splitRunInput(
    "DELETE FROM t_log WHERE ts < 100;\nUPDATE t_user SET status = 1 WHERE id = 2;\nSELECT 1 FROM dual;\nSELECT 2 FROM dual;",
  )
  assert.match(r.writes!, /DELETE/)
  assert.match(r.writes!, /UPDATE/)
  assert.equal(r.writes!.includes('SELECT'), false)
  assert.match(r.lastSelect!, /SELECT 2/)
})

test('splitRunInput: 烂语句两头都不收——跟写语句一起进确认链被点名', () => {
  const r = splitRunInput('SELCT * FROM x; UPDATE t_user SET status = 1 WHERE id = 2;')
  // SELCT 不是 SELECT，归进写语句，planAlter 会报「不跑 SELCT」
  assert.match(r.writes!, /SELCT/)
  assert.equal(r.lastSelect, null)
})

test('splitRunInput: UPDATE 后面没有 WHERE，照旧整份进确认链被拒', () => {
  const r = splitRunInput('UPDATE t_user SET status = 1;\nSELECT 1 FROM dual;')
  assert.match(r.writes!, /UPDATE/)
  assert.match(r.lastSelect!, /SELECT 1/)
  assert.throws(() => planAlter(r.writes!), /拒绝没有 WHERE 的 UPDATE/)
})
