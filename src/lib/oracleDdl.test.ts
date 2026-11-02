/**
 * Oracle DDL 导入的回归测试（bug.txt bug2：「粘贴 create 语句直接出不来」）。
 *
 * 用户从 PL/SQL Developer 里导出一张 19 列的表粘进来，**三种方言随便选哪个，
 * 结果都是一张表都没有**——不是解析得不对，是整段直接判成解析失败。原因有三条，
 * 每条单独都足以让整批语句报废：node-sql-parser 的 `plsql` 直接抛「not supported」；
 * 它的 mysql 语法不认 `NUMBER` / `NVARCHAR2`；`comment on … is '…'` 是独立语句，
 * 任何方言都解析不了。修法见 `oracleDdl.ts`。
 *
 * 所以这里的断言分两类：
 *   1. 「出得来」——表、字段、主键、注释、默认值一个不少（bug 本身）
 *   2. 「出来的东西是用户写的那个」——类型文本原样保留、NUMBER 的精度决定 Java 类型。
 *      这一类同样重要：界面上显示成 `DECIMAL(25)` 的话，用户点一次「导出 DDL」
 *      就把人家 Oracle 表的类型改了，而且四道闸门全绿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { parseDdl } from './ddlParser'
import { prepareOracleDdl } from './oracleDdl'
import { exportDdl } from './sqlgen/ddlExport'
import { planValues, renderValue } from './sqlgen/mockValue'
import type { Dialect, TableInfo } from '../types/schema'

/**
 * 用户 bug.txt 里那段的等价缩减版（19 列取 8 列）。
 * 缩减但**不改形状**：`-- Create table` 这类行注释、字段块的缩进、
 * `comment on` 换行写在下一行、主键在最后一条独立的 alter 里，全部照原样留着——
 * 这几处每一个都曾经单独把解析弄坏过（行注释让 `/^create table/` 判断全落空，
 * 静默地一条修复都没生效）。
 */
const ORACLE_DDL = `-- Create table
create table T_SHOP_FLOW_DEFINITION
(
  id              NUMBER(25) not null,
  flow_code       NVARCHAR2(40) not null,
  model_value     NVARCHAR2(40) default 'CLASSICS' not null,
  is_publish      NUMBER(1) default 0 not null,
  activity_status NUMBER(1) default 1,
  create_time     DATE,
  create_by       NVARCHAR2(64) default '',
  tenant_id       NVARCHAR2(40)
);
-- Add comments to the table
comment on table T_SHOP_FLOW_DEFINITION
  is '流程定义表';
-- Add comments to the columns
comment on column T_SHOP_FLOW_DEFINITION.id
  is '主键id';
comment on column T_SHOP_FLOW_DEFINITION.flow_code
  is '流程编码';
comment on column T_SHOP_FLOW_DEFINITION.model_value
  is '设计器模型（CLASSICS经典模型 MIMIC仿钉钉模型）';
comment on column T_SHOP_FLOW_DEFINITION.is_publish
  is '是否发布 (0未发布 1已发布 9失效)';
comment on column T_SHOP_FLOW_DEFINITION.activity_status
  is '流程激活状态（0挂起 1激活）';
comment on column T_SHOP_FLOW_DEFINITION.create_time
  is '创建时间';
comment on column T_SHOP_FLOW_DEFINITION.create_by
  is '创建人';
comment on column T_SHOP_FLOW_DEFINITION.tenant_id
  is '租户id';
-- Create/Recreate primary, unique and foreign key constraints
alter table T_SHOP_FLOW_DEFINITION
  add constraint PK_SHOP_FLOW_DEFINITION_ID primary key (ID);
`

const DIALECTS: Dialect[] = ['mysql', 'postgresql', 'oracle', 'sqlite']

/** 解析并取出唯一那张表，顺手断言没有致命错误 */
function only(sql: string, dialect: Dialect = 'oracle'): TableInfo {
  const r = parseDdl(sql, dialect)
  assert.deepEqual(r.errors, [], `${dialect} 报了错：${r.errors.join(' / ')}`)
  assert.equal(r.tables.length, 1, `${dialect} 解析出 ${r.tables.length} 张表`)
  return r.tables[0]
}

const col = (table: TableInfo, name: string) => {
  const c = table.columns.find((x) => x.name.toLowerCase() === name)
  assert.ok(c, `没有字段 ${name}`)
  return c
}

/* ---------- 1. 出得来 ---------- */

test('PL/SQL Developer 导出的建表语句：表名、字段、主键、注释全都出来', () => {
  const t = only(ORACLE_DDL)
  assert.equal(t.name, 'T_SHOP_FLOW_DEFINITION')
  assert.equal(t.columns.length, 8, '字段数不对，说明字段块被存储子句或注释吃掉了一部分')
  assert.equal(t.comment, '流程定义表')
  assert.deepEqual(
    t.columns.filter((c) => c.isPrimaryKey).map((c) => c.name.toLowerCase()),
    ['id'],
  )
  assert.equal(t.javaClass, 'TShopFlowDefinition')
})

test('四种方言都得出得来：用户不会为了粘 Oracle DDL 先去改方言下拉框', () => {
  /*
   * 方言下拉框是给「生成什么 SQL」用的，不是给「粘进来的是什么」用的，
   * 所以三种都必须能解析。特别是选 Oracle 那一档：node-sql-parser 的 plsql 语法
   * 直接抛「plsql is not supported currently」，所以 DIALECT_MAP 里 oracle 故意映射成 mysql。
   */
  for (const dialect of DIALECTS) {
    const t = only(ORACLE_DDL, dialect)
    assert.equal(t.columns.length, 8, `${dialect} 少了字段`)
    assert.equal(t.comment, '流程定义表', `${dialect} 丢了表注释`)
    assert.ok(
      t.columns.some((c) => c.isPrimaryKey),
      `${dialect} 丢了主键`,
    )
  }
})

test('postgresql 方言下不能崩：它的 AST 把列名包成对象而不是字符串', () => {
  // 以前这个分支到不了（comment on 先让整段解析失败），修好之后立刻露出
  // `name.replace is not a function`。断言「解析出来的列名是干净的字符串」而不是「没抛异常」
  const t = only(ORACLE_DDL, 'postgresql')
  for (const c of t.columns) {
    assert.equal(typeof c.name, 'string')
    assert.match(c.name, /^\w+$/, `列名没解出来：${JSON.stringify(c.name)}`)
  }
})

test('comment on 摘出来的注释要贴回字段上：注释是这个工具的主要价值', () => {
  const t = only(ORACLE_DDL)
  assert.equal(col(t, 'id').comment, '主键id')
  assert.equal(col(t, 'flow_code').comment, '流程编码')
  // 全角括号、半角括号、里面还有空格和数字，都不能把注释截断
  assert.equal(col(t, 'model_value').comment, '设计器模型（CLASSICS经典模型 MIMIC仿钉钉模型）')
  assert.equal(col(t, 'is_publish').comment, '是否发布 (0未发布 1已发布 9失效)')
  assert.equal(
    t.columns.filter((c) => c.comment).length,
    8,
    '有字段没拿到注释——Oracle 的注释是独立语句，漏一条就是白丢一条',
  )
})

test("注释里 Oracle 的 '' 转义要还原成一个单引号", () => {
  // `[^']*` 会在 user''s 中间断开，剩下半截 SQL 继续参与解析，报的错还指向别处
  const t = only(`create table t_x (id NUMBER(10) not null);
comment on table t_x is 'user''s table';
comment on column t_x.id is 'user''s id';`)
  assert.equal(t.comment, "user's table")
  assert.equal(col(t, 'id').comment, "user's id")
})

test('表名是保留字、被双引号包着（create table "ORDER"）：注释和原样类型都不能丢', () => {
  /*
   * ORDER 是 Oracle 保留字，这张表**只能**建成 `"ORDER"`，从库里导出来就是这个样子
   * （裸写 `create table ORDER` 连解析都过不去：两条语句被当成「不认识的语句」跳过，
   * 界面上那张表整个不见）。导入页的 Oracle 示例就是这个形状。
   *
   * 而 `COMMENT_ON` 和 `readDeclaredTypes` 的标识符正则原来不允许**开头**是引号，
   * 于是这张表的注释一条都摘不到、declaredTypes 整份缺失——两个症状都不报错：
   * 注释栏只是莫名为空，类型显示成用户没写过的 `VARCHAR(32)`，点一次「导出 DDL」
   * 就把人家 Oracle 表的字段类型改了。
   */
  const t = only(`create table "ORDER"
(
  id       NUMBER(19) not null,
  order_no NVARCHAR2(32) not null
)
tablespace USERS;
comment on table "ORDER" is '订单表';
comment on column "ORDER".id is '主键';
comment on column "ORDER".order_no is '订单号';
alter table "ORDER" add constraint PK_ORDER primary key (ID);`)
  assert.equal(t.name, 'ORDER', '表名上的引号要脱掉，否则搜索和生成语句时到处都得再脱一次')
  assert.equal(t.comment, '订单表')
  assert.equal(col(t, 'order_no').comment, '订单号')
  assert.equal(col(t, 'order_no').type, 'NVARCHAR2(32)', 'declaredTypes 没盖回来')
  assert.equal(col(t, 'id').isPrimaryKey, true)
})

test('主键在独立的 alter table 里：丢了它整张表就没有主键', () => {
  /*
   * Oracle 导出的建表语句里没有主键，主键是后面一条
   * `alter table T add constraint PK_x primary key (ID)`。
   * 之前「只看 create table」的过滤把它直接丢掉，结果按主键 UPDATE/DELETE、
   * JOIN 推断全都做不了——而这些是 PRD 4.7/4.8 的主要功能。
   */
  const withoutAlter = ORACLE_DDL.slice(0, ORACLE_DDL.indexOf('-- Create/Recreate'))
  assert.ok(
    !only(withoutAlter).columns.some((c) => c.isPrimaryKey),
    'fixture 失效了：不带 alter 也有主键，这条就证明不了什么',
  )

  const id = col(only(ORACLE_DDL), 'id')
  assert.equal(id.isPrimaryKey, true)
  // 主键隐含 NOT NULL。补在收尾阶段而不是收表阶段，因为 Oracle 的主键是 ALTER 才带来的
  assert.equal(id.nullable, false)
})

test('tablespace / storage 这类存储子句要砍掉，否则整条语句解析失败', () => {
  const t = only(`create table t_x
(
  id   NUMBER(10) not null,
  name VARCHAR2(50)
)
tablespace TS_DATA
  pctfree 10
  initrans 1
  maxtrans 255
  storage
  (
    initial 64K
    next 1M
    minextents 1
    maxextents unlimited
  );
alter table t_x
  add constraint PK_T_X primary key (ID)
  using index
  tablespace TS_IDX;`)
  assert.equal(t.columns.length, 2)
  assert.equal(col(t, 'id').isPrimaryKey, true, 'using index tablespace 让 alter 解析失败了')
})

/* ---------- 2. 出来的东西是用户写的那个 ---------- */

test('类型显示用户原样写的 NUMBER(25) / NVARCHAR2(40)，不是替换后的 DECIMAL / VARCHAR', () => {
  /*
   * 替换类型词只是为了过解析。不盖回原样的话，界面上显示的是用户没写过的类型，
   * 他会以为解析错了；更糟的是点一次「导出 DDL」就按 DECIMAL 生成，
   * 拿去执行就把人家 Oracle 表的字段类型改掉了。
   */
  const t = only(ORACLE_DDL)
  assert.equal(col(t, 'id').type, 'NUMBER(25)')
  assert.equal(col(t, 'flow_code').type, 'NVARCHAR2(40)')
  assert.equal(col(t, 'is_publish').type, 'NUMBER(1)')
  assert.equal(col(t, 'create_time').type, 'DATE')
})

test('默认值原样保留：字符串带引号、数字裸写、空串也是有效默认值', () => {
  const t = only(ORACLE_DDL)
  assert.equal(col(t, 'model_value').type, 'NVARCHAR2(40)')
  assert.equal(col(t, 'model_value').defaultValue, "'CLASSICS'")
  assert.equal(col(t, 'is_publish').defaultValue, '0')
  assert.equal(col(t, 'activity_status').defaultValue, '1')
  assert.equal(col(t, 'create_by').defaultValue, "''")
  assert.equal(col(t, 'model_value').nullable, false)
  assert.equal(col(t, 'activity_status').nullable, true)
})

test('NUMBER 的精度决定 Java 类型：NUMBER(1) 不是 Boolean，NUMBER(25) 不能是 Long', () => {
  /*
   * 两条都会造成静默的数据错误：
   *   - NUMBER(1) 当 Boolean：这张表的 is_publish 是 0未发布 / 1已发布 / **9失效**，
   *     映射成 Boolean 之后 9 这个状态在 Java 侧根本表达不出来；
   *   - NUMBER(25) 当 Long：25 位十进制超出 long 的 19 位，溢出不报错，数字直接变成别的数。
   */
  const t = only(`create table t_n (
  a NUMBER(1), b NUMBER(9), c NUMBER(10), d NUMBER(18), e NUMBER(19),
  f NUMBER(25), g NUMBER(10,2), h NUMBER, i NUMBER(*,0)
);`)
  const jt = (name: string) => col(t, name).javaType
  assert.equal(jt('a'), 'Integer', 'NUMBER(1) 被当成 Boolean 了')
  assert.equal(jt('b'), 'Integer')
  assert.equal(jt('c'), 'Long', 'NUMBER(10) 超出 int 的 10 位安全范围')
  assert.equal(jt('d'), 'Long')
  assert.equal(jt('e'), 'java.math.BigDecimal', 'NUMBER(19) 可能超出 long 上界')
  assert.equal(jt('f'), 'java.math.BigDecimal')
  assert.equal(jt('g'), 'java.math.BigDecimal', '有小数位就必须是 BigDecimal')
  assert.equal(jt('h'), 'java.math.BigDecimal', '裸 NUMBER 是浮点，精度未知')
  assert.equal(jt('i'), 'java.math.BigDecimal')
})

test('Oracle 的 DATE 带时分秒 → LocalDateTime；MySQL 的 DATE 只有日期 → LocalDate', () => {
  /*
   * Oracle 的 DATE 是「年月日时分秒」，按通用规则映射成 LocalDate 会把时间部分悄悄丢掉，
   * create_time / update_time 这种字段最容易踩。但这条只能在**确认是 Oracle** 时应用，
   * 判据是 NUMBER / VARCHAR2 / comment on 这类 Oracle 独有写法（见 ORACLE_ONLY），
   * 不能拿 NCHAR / TIMESTAMP(6) 当证据——那是标准 SQL，MySQL 也这么写。
   */
  assert.equal(col(only(ORACLE_DDL), 'create_time').javaType, 'java.time.LocalDateTime')

  const mysql = only("CREATE TABLE t_m (id INT PRIMARY KEY, birthday DATE COMMENT '生日');", 'mysql')
  assert.equal(col(mysql, 'birthday').javaType, 'java.time.LocalDate', 'MySQL 的 DATE 被按 Oracle 解释了')
})

test('Oracle 其余类型词都认：CLOB / RAW / BINARY_DOUBLE / TIMESTAMP(6)', () => {
  const t = only(`create table t_t (
  a CLOB, b NCLOB, c RAW(16), d LONG RAW, e BINARY_DOUBLE, f BINARY_FLOAT,
  g TIMESTAMP(6), h VARCHAR2(20 char), i XMLTYPE
);`)
  assert.equal(t.columns.length, 9, '有类型词没换成 mysql 认识的等价词，整条语句就解析失败')
  assert.equal(col(t, 'a').type, 'CLOB', '类型文本没盖回用户写的')
  assert.equal(col(t, 'a').javaType, 'String')
  assert.equal(col(t, 'e').javaType, 'Double')
  assert.equal(col(t, 'g').javaType, 'java.time.LocalDateTime')
  assert.equal(col(t, 'c').javaType, 'byte[]')
  assert.equal(col(t, 'd').type, 'LONG RAW', '多词类型只截到了第一个词')
  assert.equal(col(t, 'd').javaType, 'byte[]', 'LONG RAW 被当成裸 LONG（大文本）了')
  // 长度单位 CHAR / BYTE 是 Oracle 特有写法，mysql 语法不认，但显示要保留用户写的
  assert.equal(col(t, 'h').type, 'VARCHAR2(20 char)')
  assert.equal(col(t, 'h').javaType, 'String')
})

test('多词类型不能只截第一个词：TIMESTAMP WITH TIME ZONE 丢了时区就是错的类型', () => {
  /*
   * 记「用户原样写的类型」时如果只截到 `TIMESTAMP(6)`，盖回去之后时区那半截凭空消失，
   * Java 类型也跟着退化成 LocalDateTime——偏移量悄悄丢掉，同一个瞬间在不同时区读出来
   * 差几个小时。INTERVAL 同理，它是一段时长，被 `^int` 规则抢走会变成 Integer。
   */
  const t = only(`create table t_z (
  a TIMESTAMP(6) WITH TIME ZONE,
  b TIMESTAMP WITH LOCAL TIME ZONE,
  c INTERVAL DAY(3) TO SECOND(6),
  d INTERVAL YEAR(4) TO MONTH,
  e DOUBLE PRECISION
);`)
  assert.equal(t.columns.length, 5)
  assert.equal(col(t, 'a').type, 'TIMESTAMP(6) WITH TIME ZONE')
  assert.equal(col(t, 'a').javaType, 'java.time.OffsetDateTime')
  assert.equal(col(t, 'b').javaType, 'java.time.OffsetDateTime')
  assert.equal(col(t, 'c').type, 'INTERVAL DAY(3) TO SECOND(6)')
  assert.equal(col(t, 'c').javaType, 'java.time.Duration', 'INTERVAL 被 ^int 规则当成 Integer 了')
  assert.equal(col(t, 'd').javaType, 'java.time.Period')
  assert.equal(col(t, 'e').javaType, 'Double')
})

test('全引号形态的 Oracle DDL 要能导入：工具自己导出的 DDL 得能导回来', () => {
  /*
   * node-sql-parser 的 mysql 语法把 `"col"` 当字符串字面量，`"id" NUMBER(19)` 整条报废。
   * 表名带双引号它倒认（`create table "ORDER"` 一直导得进来），唯独列名带引号必炸——
   * 而导出侧恰恰给每个列名都包了引号。统一成反引号之后，注释、原样类型、
   * 独立 alter 里的主键一样都不能少。
   */
  const t = only(`CREATE TABLE "user" (
  "id" NUMBER(19) NOT NULL,
  "name" VARCHAR2(50) NOT NULL
);
COMMENT ON COLUMN "user"."name" IS '名字';
ALTER TABLE "user" ADD CONSTRAINT "PK_user" PRIMARY KEY ("id");`)
  assert.equal(t.name, 'user')
  assert.equal(t.columns.length, 2)
  assert.equal(col(t, 'id').type, 'NUMBER(19)', '原样类型没盖回来')
  assert.equal(col(t, 'name').type, 'VARCHAR2(50)')
  assert.equal(col(t, 'name').comment, '名字')
  assert.equal(col(t, 'id').isPrimaryKey, true, '独立 alter 里的主键没回填')
})

test('字段上的 Oracle 子句要抹掉：identity / DEFAULT ON NULL / 具名 NOT NULL / ENABLE', () => {
  /*
   * 这些子句一个都不影响表结构，但每一个都会让整条 create table 报废——
   * mysql 语法遇到不认识的子句是**整条语句**失败，不是跳过那一列。
   * DBMS_METADATA 导出的 DDL 里这几种写法几乎必然出现。
   */
  const t = only(`create table t_c (
  id   NUMBER GENERATED BY DEFAULT ON NULL AS IDENTITY,
  a    NUMBER(10) DEFAULT ON NULL 0 NOT NULL ENABLE,
  b    VARCHAR2(20) CONSTRAINT nn_b NOT NULL,
  c    NUMBER(10) INVISIBLE,
  d    NUMBER AS (1 + 2) VIRTUAL
);`)
  assert.equal(t.columns.length, 5)
  // identity 换成 AUTO_INCREMENT 而不是删掉：这样自增列才会被 INSERT 自动排除（PRD 4.4）
  assert.equal(col(t, 'id').isAutoIncrement, true, 'Oracle 12c 的 identity 列没认出来是自增')
  assert.equal(col(t, 'a').nullable, false)
  assert.equal(col(t, 'a').defaultValue, '0')
  assert.equal(col(t, 'b').nullable, false, '具名的行内 NOT NULL 约束没生效')
  assert.equal(col(t, 'b').type, 'VARCHAR2(20)')
})

test('NUMBER(*,0) 的 * 是「最大精度」，不是语法错误', () => {
  const t = only('create table t_star (a NUMBER(*,0), b NUMBER(*));')
  assert.equal(col(t, 'a').type, 'NUMBER(*,0)')
  assert.equal(col(t, 'a').javaType, 'java.math.BigDecimal')
  assert.equal(col(t, 'b').javaType, 'java.math.BigDecimal')
})

/* ---------- 3. 纯 MySQL 的 DDL 不受影响 ---------- */

test('纯 MySQL 的 DDL 走同一条预处理不变形：表注释、TINYINT(1)、DECIMAL 都还在', () => {
  /*
   * 预处理是**无条件**跑的（不先猜方言），所以必须对 MySQL 是恒等变换。
   * 最容易被弄坏的是表注释：`ENGINE=InnoDB COMMENT='用户表'` 也在字段块右括号后面，
   * 如果按「砍掉右括号后面的东西」实现，表注释就没了——所以存储子句用的是白名单。
   */
  const t = only(
    `CREATE TABLE \`user\` (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键',
  username VARCHAR(50) NOT NULL COMMENT '用户名',
  balance DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '余额',
  is_vip TINYINT(1) DEFAULT 0 COMMENT '是否 VIP',
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户表';`,
    'mysql',
  )
  assert.equal(t.comment, '用户表')
  assert.equal(col(t, 'id').isAutoIncrement, true)
  assert.equal(col(t, 'is_vip').type, 'TINYINT(1)')
  assert.equal(col(t, 'is_vip').javaType, 'Boolean', 'MySQL 惯例里 TINYINT(1) 是布尔')
  assert.equal(col(t, 'balance').type, 'DECIMAL(10,2)')
  assert.equal(col(t, 'create_time').defaultValue, 'CURRENT_TIMESTAMP')
  assert.equal(col(t, 'create_time').javaType, 'java.time.LocalDateTime')
})

test('默认值里写着 NUMBER / VARCHAR2 这些词的字符串不能被当成类型替换掉', () => {
  // 替换只在「代码区」做（codeMask 掩掉字符串和注释），否则改的是用户的数据
  const prep = prepareOracleDdl(
    `CREATE TABLE t_s (kind VARCHAR(20) DEFAULT 'NUMBER', note VARCHAR(20) DEFAULT 'VARCHAR2');`,
  )
  assert.match(prep.sql, /'NUMBER'/)
  assert.match(prep.sql, /'VARCHAR2'/)
  assert.equal(prep.typesRepaired, false, '把字符串字面量当类型词替换了')
  assert.equal(prep.oracleSyntax, false, '把 MySQL 的 DDL 判成 Oracle 了')

  const t = only(`CREATE TABLE t_s (kind VARCHAR(20) DEFAULT 'NUMBER');`, 'mysql')
  assert.equal(col(t, 'kind').defaultValue, "'NUMBER'")
})

test('多条语句里有一条坏的：好的照样出来，坏的只给 warning', () => {
  const r = parseDdl(
    `${ORACLE_DDL}
create table 这不是合法的 DDL (((;
create table t_ok (id NUMBER(10) not null, name NVARCHAR2(20));`,
    'oracle',
  )
  assert.deepEqual(r.errors, [])
  assert.deepEqual(
    r.tables.map((t) => t.name).sort(),
    ['T_SHOP_FLOW_DEFINITION', 't_ok'],
    '一条语句写错就整批报废了',
  )
  assert.ok(r.warnings.length, '跳过了语句却没告诉用户')
})

/* ---------- 4. 真执行：解析出来的表能建、能插 ---------- */

test('SQLite 真执行：Oracle 表导出成 SQLite DDL 能建起来，生成的 INSERT 能插进去', () => {
  /*
   * 「解析出来了」不等于「拿到的结构是对的」。这里把整条链路走完：
   * Oracle DDL → TableInfo → 导出 SQLite DDL → 真建表 → 按结构造值 → 真插入。
   * 中间任何一步把类型/精度/非空弄错，这里都会当场报错而不是给出一条能跑的错 SQL。
   */
  const t = only(ORACLE_DDL)
  const db = new DatabaseSync(':memory:')
  db.exec(exportDdl(t, { dialect: 'sqlite' }))

  const plans = planValues(t, 'sqlite', 7).filter((p) => !p.excluded)
  const names = plans.map((p) => `"${p.column.name}"`).join(', ')
  const values = plans.map((p) => renderValue(p.column, p.auto, 'sqlite')).join(', ')
  db.exec(`INSERT INTO "${t.name}" (${names}) VALUES (${values})`)

  const row = db.prepare(`SELECT * FROM "${t.name}"`).get() as Record<string, unknown>
  assert.equal(Object.keys(row).length, 8)
  for (const p of plans) {
    // 非空字段必须真的非空，否则 Oracle 那边插的时候才报 ORA-01400
    if (!p.column.nullable) assert.notEqual(row[p.column.name], null, `${p.column.name} 是非空字段却给了 NULL`)
  }
  db.close()
})

test('NUMBER(1) 的测试值只能是一位数：给 99999 会 ORA-01438，而且是插入时才炸', () => {
  const t = only(ORACLE_DDL)
  for (let seed = 1; seed <= 40; seed += 1) {
    for (const phase of ['insert', 'update'] as const) {
      for (const p of planValues(t, 'oracle', seed, phase)) {
        if (p.auto === 'NULL' || p.column.type !== 'NUMBER(1)') continue
        assert.match(p.auto, /^\d$/, `${p.column.name} 在 seed=${seed} 给了 ${p.auto}，超出 NUMBER(1) 的精度`)
      }
    }
  }
})

test('NUMBER(25) 没写小数位就是整数列：给两位小数会被静默四舍五入', () => {
  // 不报错，回头对不上账还以为是自己算错了。没写括号的裸 NUMBER 才按浮点给
  const t = only('create table t_p (a NUMBER(25), b NUMBER(10,2), c NUMBER);')
  for (let seed = 1; seed <= 20; seed += 1) {
    const plan = planValues(t, 'oracle', seed)
    const auto = (name: string) => plan.find((p) => p.column.name === name)?.auto ?? ''
    if (auto('a') !== 'NULL') assert.match(auto('a'), /^\d+$/, `NUMBER(25) 给了小数：${auto('a')}`)
    if (auto('b') !== 'NULL') assert.match(auto('b'), /^\d+\.\d{2}$/, `NUMBER(10,2) 的小数位不对：${auto('b')}`)
  }
})
