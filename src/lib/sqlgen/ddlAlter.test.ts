/**
 * 增量 DDL（编辑表结构弹窗的 ALTER 生成）的回归测试。
 *
 * 这层的失败模式跟全量导出一样「不报错只是错」：类型翻译和全量导出各写一份、
 * 主键行的可空性归一化没对齐就天天报假变更、SQLite 的改列语句看似能跑实际根本不存在。
 * 所以除了比形态，SQLite 那段真交给 node:sqlite 执行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import type { Column } from '../../types/schema'
import { diffColumns, buildAlterDdl, hasChanges } from './ddlAlter'
import { translateType } from './ddlExport'

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

const alterLines = (ddl: string): string[] => ddl.split('\n').filter((l) => /^ALTER /.test(l))

test('diff：加/改/删各归各类，没动的只字不提', () => {
  const original = [col('id', 'BIGINT'), col('name', 'VARCHAR(50)'), col('tmp', 'VARCHAR(10)')]
  const current = [
    col('id', 'BIGINT'),
    col('name', 'VARCHAR(100)'), // 只改了类型
    col('extra', 'INT'), // 新加
  ]
  const d = diffColumns(original, current)
  assert.deepEqual(d.added.map((c) => c.name), ['extra'])
  assert.deepEqual(d.changed.map((x) => x.to.name), ['name'])
  assert.deepEqual(d.dropped.map((c) => c.name), ['tmp'])
  assert.deepEqual(d.manual, [])
  assert.ok(hasChanges(d))
})

test('diff：主键行在界面上可空勾着，也不许报「可空性变了」（主键隐含 NOT NULL）', () => {
  // 缓存里的主键保存时归一化成 nullable:false；弹窗里勾选框显示的是 nullable && !pk，
  // state 里没动过的主键行还是 nullable:true——不按有效值比，每次改别的都带出一条假 MODIFY
  const original = [col('id', 'BIGINT', { nullable: false, isPrimaryKey: true })]
  const current = [col('id', 'BIGINT', { nullable: true, isPrimaryKey: true })]
  const d = diffColumns(original, current)
  assert.equal(d.changed.length, 0)
  assert.equal(hasChanges(d), false)
})

test('diff：主键/自增的变化不生成语句，进 manual 清单', () => {
  const original = [col('id', 'BIGINT'), col('flag', 'TINYINT(1)')]
  const current = [
    col('id', 'BIGINT', { isPrimaryKey: true, isAutoIncrement: true }), // 现有字段补了主键
    col('key', 'BIGINT', { isPrimaryKey: true }), // 新字段直接带主键
  ]
  const d = diffColumns(original, current)
  assert.equal(d.changed.length, 1) // flag→id 那条照常报改
  assert.equal(d.added.length, 1)
  assert.equal(d.manual.length, 2)
  assert.ok(d.manual.every((m) => m.includes('手工')))
})

test('diff：删掉的字段里有主键，manual 要点名（约束的删除语句生成不了）', () => {
  const d = diffColumns([col('id', 'BIGINT', { isPrimaryKey: true })], [])
  assert.deepEqual(d.dropped.map((c) => c.name), ['id'])
  assert.equal(d.manual.length, 1)
})

test('没有任何变更时 buildAlterDdl 返回空串（界面靠它决定显不显示）', () => {
  const same = [col('id', 'BIGINT', { nullable: false, isPrimaryKey: true })]
  assert.equal(buildAlterDdl('t', diffColumns(same, same), 'mysql'), '')
})

test('MySQL：ADD 带全内联（NOT NULL/DEFAULT/COMMENT），MODIFY 整份重定义，DROP 单列一条', () => {
  const original = [col('name', 'VARCHAR(50)'), col('old', 'INT')]
  const current = [
    col('name', 'VARCHAR(200)', { comment: '收货人' }), // 改类型
    col('age', 'INT', { nullable: false, defaultValue: '0', comment: '年龄' }), // 加
  ]
  const ddl = buildAlterDdl('ORDER', diffColumns(original, current), 'mysql')

  assert.match(ddl, /ALTER TABLE `ORDER` ADD COLUMN `age` INT DEFAULT 0 NOT NULL COMMENT '年龄';/)
  // 注释必须跟着 MODIFY 一起内联：单独执行一条不带注释的 MODIFY 等于把注释清掉
  assert.match(ddl, /ALTER TABLE `ORDER` MODIFY COLUMN `name` VARCHAR\(200\) COMMENT '收货人';/)
  assert.match(ddl, /ALTER TABLE `ORDER` DROP COLUMN `old`;/)
  // 头部说清楚对照基准，用户才知道这份语句跟着弹窗走
  assert.match(ddl, /-- 对照的是打开弹窗时的字段/)
  assert.match(ddl, /加 1 · 改 1 · 删 1/)
})

test('MySQL：自增主键改类型，MODIFY 里 AUTO_INCREMENT 不丢', () => {
  const original = [col('id', 'BIGINT', { nullable: false, isPrimaryKey: true, isAutoIncrement: true })]
  const current = [col('id', 'BIGINT', { nullable: false, isPrimaryKey: true, isAutoIncrement: true })].map(
    (c) => ({ ...c, type: 'INT' }),
  )
  const ddl = buildAlterDdl('t', diffColumns(original, current), 'mysql')
  assert.match(ddl, /MODIFY COLUMN `id` INT AUTO_INCREMENT NOT NULL;/)
})

test('Oracle：ADD/MODIFY 走括号形式，注释单独发 COMMENT ON，类型翻译和全量导出同一套', () => {
  const original = [col('status', 'TINYINT', { nullable: false }), col('memo', 'VARCHAR(100)', { comment: '旧备注' })]
  const current = [
    col('status', 'BIGINT', { nullable: false, comment: '状态' }), // 类型翻译要跟 translateType 一致
    col('memo', 'VARCHAR(100)'), // 注释被清掉
  ]
  const ddl = buildAlterDdl('ORDER', diffColumns(original, current), 'oracle')

  const expected = translateType('BIGINT', 'oracle').type
  assert.equal(expected, 'NUMBER(19)')
  // 类型文本里有括号，直接塞进 RegExp 的话 (19) 是捕获组，匹配的是 NUMBER19——必须转义
  assert.match(
    ddl,
    new RegExp(`ALTER TABLE "ORDER" MODIFY \\("status" ${expected.replace(/([()])/g, '\\$1')} NOT NULL\\);`),
  )
  assert.match(ddl, /COMMENT ON COLUMN "ORDER"\."status" IS '状态';/)
  // Oracle 清注释只能设空串
  assert.match(ddl, /COMMENT ON COLUMN "ORDER"\."memo" IS '';/)
})

test('PostgreSQL：改列按属性拆条，TYPE / SET DEFAULT / DROP NOT NULL 各自独立可执行', () => {
  const original = [col('c', 'VARCHAR(50)', { nullable: false, defaultValue: 'x' })]
  const current = [col('c', 'VARCHAR(100)', { nullable: true })]
  const ddl = buildAlterDdl('t', diffColumns(original, current), 'postgresql')

  assert.match(ddl, /ALTER TABLE "t" ALTER COLUMN "c" TYPE VARCHAR\(100\);/)
  assert.match(ddl, /ALTER COLUMN "c" DROP NOT NULL;/)
  assert.match(ddl, /ALTER COLUMN "c" DROP DEFAULT;/)
  assert.doesNotMatch(ddl, /SET DEFAULT/)
  assert.doesNotMatch(ddl, /SET NOT NULL/)
})

test('SQLite：改列只出说明不出假语句，加列/删列的语句在真 SQLite 上跑得过', () => {
  const original = [col('id', 'INTEGER', { isPrimaryKey: true }), col('a', 'TEXT')]
  const current = [col('id', 'INTEGER', { isPrimaryKey: true }), col('a', 'VARCHAR(80)'), col('b', 'TEXT')]
  const ddl = buildAlterDdl('t', diffColumns(original, current), 'sqlite')

  // 改列只能是注释说明；能执行的部分只有 ADD / DROP
  assert.match(ddl, /-- 字段 a 改了定义（TEXT → VARCHAR\(80\)）/)
  assert.match(ddl, /⚠️ SQLite 只支持加列 \/ 删列/)
  const run = alterLines(ddl).join('\n')
  assert.match(run, /ADD COLUMN "b" TEXT;/)

  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE "t" ("id" INTEGER PRIMARY KEY, "a" TEXT)')
    db.exec(run)
    const cols = (db.prepare('PRAGMA table_info("t")').all() as Array<{ name: string }>).map((r) => r.name)
    assert.ok(cols.includes('b'), '加列语句没生效')
    assert.deepEqual(cols, ['id', 'a', 'b'])
  } finally {
    db.close()
  }
})

test('Oracle：加字段 DEFAULT 必须在 NOT NULL 前面（ADD 括号里的列片段跟全量导出同一套）', () => {
  const ddl = buildAlterDdl(
    'T',
    diffColumns([], [col('flag', 'TINYINT(1)', { nullable: false, defaultValue: '0' })]),
    'oracle',
  )
  assert.match(ddl, /ALTER TABLE "T" ADD \("flag" NUMBER\(1\) DEFAULT 0 NOT NULL\);/)
  assert.doesNotMatch(ddl, /NOT NULL DEFAULT/)
})

test('Oracle：加字段带注释时，ADD 和 COMMENT ON 是两条语句', () => {
  const ddl = buildAlterDdl('T', diffColumns([], [col('remark', 'VARCHAR(200)', { comment: "it's 备注" })]), 'oracle')
  const stmts = ddl.split('\n\n').slice(1)
  assert.deepEqual(stmts, [
    'ALTER TABLE "T" ADD ("remark" VARCHAR2(200));',
    `COMMENT ON COLUMN "T"."remark" IS 'it''s 备注';`,
  ])
})
