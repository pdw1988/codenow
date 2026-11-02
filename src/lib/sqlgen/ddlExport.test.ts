/**
 * 导出 DDL 的回归测试。
 *
 * 这里刻意不只比字符串——那只能证明「输出没变」，证明不了「输出能跑」：
 *   - MySQL 方言：导出的 DDL 再喂回 parseDdl，字段/主键/注释要能原样还原
 *   - 真建表：内部 sqlite 生成交给 node:sqlite 执行，语法错误当场暴露
 * 其余产品方言本机没有可执行的引擎，只能查关键翻译结果。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { parseDdl } from '../ddlParser'
import { exportDdl, translateType } from './ddlExport'
import type { TableInfo } from '../../types/schema'

const DDL = `
CREATE TABLE \`user\` (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键',
  username VARCHAR(50) NOT NULL COMMENT '用户名',
  balance DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '余额',
  is_vip TINYINT(1) DEFAULT 0 COMMENT '是否 VIP',
  bio TEXT COMMENT '简介',
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id)
) COMMENT='用户表';
CREATE TABLE \`order\` (
  id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '订单ID',
  user_id BIGINT NOT NULL COMMENT '下单用户',
  CONSTRAINT fk_order_user FOREIGN KEY (user_id) REFERENCES \`user\`(id)
) COMMENT='订单表';
CREATE TABLE user_role (
  user_id BIGINT NOT NULL,
  role_id BIGINT NOT NULL
);
`

const parsed = parseDdl(DDL, 'mysql')
const byName = new Map(parsed.tables.map((t) => [t.name, t]))
const get = (n: string): TableInfo => {
  const t = byName.get(n)
  assert.ok(t, `fixture 缺少表 ${n}`)
  return t
}

test('MySQL：导出的 DDL 能被解析回等价的表结构（round-trip）', () => {
  const user = get('user')
  const ddl = exportDdl(user, { dialect: 'mysql' })

  const back = parseDdl(ddl, 'mysql')
  assert.deepEqual(back.errors, [], `导出的 DDL 解析失败：${back.errors.join('; ')}`)
  assert.equal(back.tables.length, 1)

  const again = back.tables[0]
  assert.equal(again.name, user.name)
  assert.equal(again.comment, user.comment)
  assert.equal(again.columns.length, user.columns.length)

  for (const before of user.columns) {
    const after = again.columns.find((c) => c.name === before.name)
    assert.ok(after, `字段 ${before.name} 在 round-trip 后不见了`)
    assert.equal(after.type.toUpperCase(), before.type.toUpperCase(), `${before.name} 类型变了`)
    assert.equal(after.isPrimaryKey, before.isPrimaryKey, `${before.name} 主键标记变了`)
    assert.equal(after.isAutoIncrement, before.isAutoIncrement, `${before.name} 自增标记变了`)
    assert.equal(!!after.isUnique, !!before.isUnique, `${before.name} 唯一索引标记变了`)
    assert.equal(after.nullable, before.nullable, `${before.name} 可空性变了`)
    assert.equal(after.comment, before.comment, `${before.name} 注释变了`)
    assert.equal(after.defaultValue, before.defaultValue, `${before.name} 默认值变了`)
  }
})

test('MySQL：注释里的单引号被转义，不会把 DDL 截断', () => {
  const table: TableInfo = {
    ...get('user'),
    comment: "user's table",
    columns: [{ ...get('user').columns[1], comment: "it's a name" }],
  }
  const ddl = exportDdl(table, { dialect: 'mysql' })

  assert.match(ddl, /COMMENT 'it''s a name'/)
  const back = parseDdl(ddl, 'mysql')
  assert.deepEqual(back.errors, [])
  assert.equal(back.tables[0].columns[0].comment, "it's a name")
})

test('SQLite：导出的 DDL 能被真正的 SQLite 引擎执行', () => {
  const db = new DatabaseSync(':memory:')
  try {
    // 先建主表再建从表：从表带 FOREIGN KEY，引用的表得先存在
    for (const name of ['user', 'order', 'user_role']) {
      const ddl = exportDdl(get(name), { dialect: 'sqlite', foreignKeys: parsed.foreignKeys })
      db.exec(ddl)
    }

    // 自增主键真的能省略：插入不给 id，SQLite 自己填
    db.exec("INSERT INTO `user` (`username`, `balance`) VALUES ('alice', 1.5)")
    const row = db.prepare('SELECT `id`, `username` FROM `user`').get() as {
      id: number
      username: string
    }
    assert.equal(row.id, 1)
    assert.equal(row.username, 'alice')
  } finally {
    db.close()
  }
})

test('SQLite：自增写成 INTEGER PRIMARY KEY AUTOINCREMENT，且不再出第二个 PRIMARY KEY', () => {
  const ddl = exportDdl(get('user'), { dialect: 'sqlite' })
  // SQLite 走双引号，不是 MySQL 的反引号
  assert.match(ddl, /"id" INTEGER PRIMARY KEY AUTOINCREMENT/)
  // 只认这一种自增写法，再补一个表级 PRIMARY KEY 子句会直接报错
  assert.equal(ddl.match(/PRIMARY KEY/g)?.length, 1)
  assert.doesNotMatch(ddl, /AUTO_INCREMENT/)
  // SQLite 没有 COMMENT，注释只能落到行注释里
  assert.doesNotMatch(ddl, /^\s*"\w+"[^\n]*COMMENT /m)
  assert.match(ddl, /--\s+create_time: 创建时间/)
})

test('SQLite：复合主键表退回表级 PRIMARY KEY 子句', () => {
  // user_role 没有主键，构造一个复合主键版本
  const base = get('user_role')
  const table: TableInfo = {
    ...base,
    columns: base.columns.map((c) => ({ ...c, isPrimaryKey: true, nullable: false })),
  }
  const ddl = exportDdl(table, { dialect: 'sqlite' })

  assert.match(ddl, /PRIMARY KEY \("user_id", "role_id"\)/)
  assert.doesNotMatch(ddl, /AUTOINCREMENT/)

  const db = new DatabaseSync(':memory:')
  try {
    db.exec(ddl)
  } finally {
    db.close()
  }
})

test('PostgreSQL：MySQL 专有类型被翻译，注释改走 COMMENT ON', () => {
  const ddl = exportDdl(get('user'), { dialect: 'postgresql' })

  assert.match(ddl, /"create_time" TIMESTAMP/)
  assert.match(ddl, /"bio" TEXT/)
  assert.match(ddl, /"balance" NUMERIC\(10,2\)/)
  // tinyint(1) 是 MySQL 的布尔惯用写法
  assert.match(ddl, /"is_vip" BOOLEAN/)
  // identity 跟 DEFAULT 同一槽位，必须在 NOT NULL 前面（Oracle 语法要求；PG 两种都能跑）
  assert.match(ddl, /"id" BIGINT GENERATED BY DEFAULT AS IDENTITY NOT NULL/)

  // 列上不能带 COMMENT，要单独发语句
  assert.doesNotMatch(ddl, /^\s*"\w+"[^\n]*COMMENT /m)
  assert.match(ddl, /COMMENT ON TABLE "user" IS '用户表';/)
  assert.match(ddl, /COMMENT ON COLUMN "user"\."username" IS '用户名';/)
})

test('Oracle：VARCHAR → VARCHAR2，整型宽度换成 NUMBER 精度', () => {
  const ddl = exportDdl(get('user'), { dialect: 'oracle', withDrop: true })

  assert.match(ddl, /"username" VARCHAR2\(50\)/)
  assert.match(ddl, /"id" NUMBER\(19\)/)
  assert.match(ddl, /"balance" NUMBER\(10,2\)/)
  assert.match(ddl, /"bio" CLOB/)
  // Oracle 老版本没有 IF EXISTS，得给出提示而不是悄悄生成一句会报错的语句
  assert.match(ddl, /DROP TABLE "user" CASCADE CONSTRAINTS;/)
  assert.match(ddl, /--[^\n]*IF EXISTS/)
})

test('带 CHAR/BYTE 长度单位的类型：导出只保留长度', () => {
  // 老缓存和粘贴导入可能还存着 NVARCHAR2(1000 CHAR)：NVARCHAR2 带 CHAR 不是合法
  // Oracle 语法，用户也确认过导出只要长度，各方言一视同仁
  const table: TableInfo = {
    ...get('user'),
    columns: [
      { ...get('user').columns[0], type: 'NVARCHAR2(1000 CHAR)' },
      { ...get('user').columns[1], type: 'NVARCHAR2(50 BYTE)' },
    ],
  }

  for (const dialect of ['mysql', 'postgresql', 'oracle', 'sqlite'] as const) {
    const ddl = exportDdl(table, { dialect })
    assert.match(ddl, /NVARCHAR2\(1000\)/, `${dialect} 没剥掉 CHAR 单位`)
    assert.match(ddl, /NVARCHAR2\(50\)/, `${dialect} 没剥掉 BYTE 单位`)
    assert.doesNotMatch(ddl, /\d\s+(CHAR|BYTE)/, `${dialect} 导出了长度单位`)
  }
})

test('DEFAULT 写在 NOT NULL 前面：各方言同一套，Oracle 写成反过来会 ORA-00907', () => {
  // 导入用的 MySQL 习惯是 NOT NULL DEFAULT 0；导出给 Oracle 必须反过来。
  // MySQL / PG 两种顺序都能跑，统一成 Oracle 那套，CREATE 和 ALTER 不会各写一份。
  const user = get('user')
  const balanceMysql = exportDdl(user, { dialect: 'mysql' })
    .split('\n')
    .find((l) => /`balance`/.test(l))
  assert.ok(balanceMysql)
  assert.match(balanceMysql, /DEFAULT 0\.00 NOT NULL/)
  assert.doesNotMatch(balanceMysql, /NOT NULL DEFAULT/)

  const oracle = exportDdl(user, { dialect: 'oracle' })
  assert.match(oracle, /"balance" NUMBER\(10,2\) DEFAULT 0\.00 NOT NULL/)
  assert.match(oracle, /"id" NUMBER\(19\) GENERATED BY DEFAULT AS IDENTITY NOT NULL/)
  assert.doesNotMatch(oracle, /NOT NULL DEFAULT/)

  const pg = exportDdl(user, { dialect: 'postgresql' })
  assert.match(pg, /"balance" NUMERIC\(10,2\) DEFAULT 0\.00 NOT NULL/)

  const sqlite = exportDdl(user, { dialect: 'sqlite' })
  assert.match(sqlite, /"balance" NUMERIC\(10,2\) DEFAULT 0\.00 NOT NULL/)
})

test('Oracle：主键走独立的 alter table add constraint，体内不再出内联 PRIMARY KEY', () => {
  const ddl = exportDdl(get('user'), { dialect: 'oracle' })

  // 团队执行的 Oracle 脚本里主键就长这样（PL/SQL Developer 导出形态），缺了它用户得手补
  assert.match(ddl, /ALTER TABLE "user" ADD CONSTRAINT "PK_user" PRIMARY KEY \("id"\);/)
  // CREATE TABLE 体内不能再有第二个 PRIMARY KEY，约束只在 alter 里建一次
  const create = ddl.slice(ddl.indexOf('CREATE TABLE'), ddl.indexOf('ALTER TABLE'))
  assert.doesNotMatch(create, /PRIMARY KEY/)
  // 导出的 alter 形态必须能被解析回主键标记（round-trip 的 Oracle 半边）
  const back = parseDdl(ddl, 'oracle')
  assert.deepEqual(back.errors, [])
  assert.equal(back.tables[0]?.columns.find((c) => c.name === 'id')?.isPrimaryKey, true)
})

test('自增列不带 DEFAULT：两者同时出现在 MySQL / PG 下都是语法错误', () => {
  const base = get('user')
  const table: TableInfo = {
    ...base,
    // 构造一个既自增又有默认值的脏数据，导出时必须丢掉 DEFAULT
    columns: base.columns.map((c) => (c.isAutoIncrement ? { ...c, defaultValue: '100' } : c)),
  }

  for (const dialect of ['mysql', 'postgresql'] as const) {
    const idLine = exportDdl(table, { dialect })
      .split('\n')
      .find((l) => /^\s*[`"]id[`"]/.test(l))
    assert.ok(idLine, `${dialect} 找不到 id 列`)
    // 不能直接查 /DEFAULT/：PG 的自增写法 GENERATED BY DEFAULT AS IDENTITY 里就带这个词
    assert.doesNotMatch(idLine, /DEFAULT 100/, `${dialect} 的自增列带上了 DEFAULT`)
  }
})

test('只导出真外键，命名推断的不写进 DDL', () => {
  const withConstraint = exportDdl(get('order'), {
    dialect: 'mysql',
    foreignKeys: parsed.foreignKeys,
  })
  assert.match(withConstraint, /CONSTRAINT `fk_order_user` FOREIGN KEY \(`user_id`\)/)

  // user_role.user_id → user.id 是命名推断出来的，不能写成约束
  const guessed = exportDdl(get('user_role'), {
    dialect: 'mysql',
    foreignKeys: parsed.foreignKeys,
  })
  assert.doesNotMatch(guessed, /FOREIGN KEY/)
})

test('无主键的表：不出 PRIMARY KEY 子句，且头部要有警告', () => {
  const ddl = exportDdl(get('user_role'), { dialect: 'mysql' })
  // 只看 CREATE TABLE 之后：头部的警告文案里也含「PRIMARY KEY」这几个字
  assert.doesNotMatch(ddl.slice(ddl.indexOf('CREATE TABLE')), /PRIMARY KEY/)
  assert.match(ddl, /-- ⚠️[^\n]*没有主键/)
})

test('翻译不了的类型原样输出，并在头部点名', () => {
  const base = get('user')
  const table: TableInfo = {
    ...base,
    columns: [{ ...base.columns[1], type: 'GEOMETRY', name: 'shape' }],
  }
  const ddl = exportDdl(table, { dialect: 'postgresql' })

  assert.match(ddl, /"shape" GEOMETRY/)
  assert.match(ddl, /-- ⚠️ 以下类型需要手动确认：/)
  assert.match(ddl, /GEOMETRY：PostgreSQL 下没有对应类型/)
})

test('translateType：目标类型自带精度时不再拼源类型的括号', () => {
  // NUMBER(19) 已经含精度，不能拼成 NUMBER(19)(20)
  assert.equal(translateType('BIGINT(20)', 'oracle').type, 'NUMBER(19)')
  // VARCHAR2 没有自带精度，要沿用源类型的
  assert.equal(translateType('VARCHAR(50)', 'oracle').type, 'VARCHAR2(50)')
  // 目标是 MySQL 时不翻译
  assert.equal(translateType('DATETIME', 'mysql').type, 'DATETIME')
})
