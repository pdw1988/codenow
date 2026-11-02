/**
 * 生成器回归测试。用 node:test（Node 自带，不引测试框架）+ tsx 跑：
 *   pnpm test
 *
 * 这里每条断言都对应一个实际踩过的坑，不是为覆盖率写的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDdl } from '../ddlParser'
import { generateSingleTable } from './singleTable'
import { generateMultiTable, type JoinLink } from './multiTable'
import { generateMultiTableXml, generateSingleTableXml, DEFAULT_MYBATIS_OPTIONS } from './mybatis'
import { DIALECT_OPTIONS } from './dialect'
import type { TableInfo } from '../../types/schema'

const DDL = `
CREATE TABLE \`user\` (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键',
  username VARCHAR(50) NOT NULL COMMENT '用户名',
  status TINYINT DEFAULT 1 COMMENT '状态',
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id)
) COMMENT='用户表';
CREATE TABLE \`order\` (
  id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '订单ID',
  user_id BIGINT NOT NULL COMMENT '下单用户',
  total_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '总额',
  status TINYINT DEFAULT 0 COMMENT '订单状态',
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

/** 测别名冲突等要全列；未传 selectedColumns 现在是默认关键列 */
function allColsPick(...tables: TableInfo[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const t of tables) out[t.name] = t.columns.map((c) => c.name)
  return out
}

test('解析：字段属性、注释、默认值都拿到了', () => {
  assert.deepEqual(parsed.errors, [])
  assert.equal(parsed.tables.length, 3)

  const user = get('user')
  assert.equal(user.comment, '用户表')
  assert.equal(user.javaClass, 'User')

  const id = user.columns.find((c) => c.name === 'id')!
  assert.equal(id.isPrimaryKey, true)
  assert.equal(id.isAutoIncrement, true)
  // 主键隐含 NOT NULL，即使 DDL 里没写在字段上
  assert.equal(id.nullable, false)
  assert.equal(id.javaType, 'Long')

  // DEFAULT CURRENT_TIMESTAMP 不能被渲染成 CURRENT_TIMESTAMP()
  const ct = user.columns.find((c) => c.name === 'create_time')!
  assert.equal(ct.defaultValue, 'CURRENT_TIMESTAMP')
  // javaType 存全限定名，界面上再截短显示
  assert.equal(ct.javaType, 'java.time.LocalDateTime')
  assert.equal(ct.javaField, 'createTime')

  // tinyint 不该变成 Boolean（只有 tinyint(1) 才是）
  assert.equal(user.columns.find((c) => c.name === 'status')!.javaType, 'Integer')
})

test('解析：真外键和命名推断分得开', () => {
  const real = parsed.foreignKeys.filter((f) => f.confidence === 'constraint')
  const guessed = parsed.foreignKeys.filter((f) => f.confidence === 'naming')

  assert.equal(real.length, 1)
  assert.equal(real[0].constraintName, 'fk_order_user')
  // user_role.user_id 没有约束，只能靠命名推断
  assert.ok(guessed.some((f) => f.fromTable === 'user_role' && f.toTable === 'user'))
  // 推断出来的必须给出 warning，不能悄悄用
  assert.ok(parsed.warnings.some((w) => w.includes('推断')))
})

test('单表：逗号在行尾注释之前，否则逗号会被注释掉', () => {
  const sql = generateSingleTable(get('user'), {
    dialect: 'mysql',
    kinds: ['insert', 'update', 'select'],
    withHeader: false,
  })

  // 反例形态：`col`  -- 注释,
  assert.doesNotMatch(sql, /--[^\n]*,\s*$/m, '有逗号落在注释后面，生成的 SQL 跑不通')
  assert.match(sql, /`username`,\s+-- 用户名/)
  // 自增主键不进 INSERT 列表
  const insertBlock = sql.slice(sql.indexOf('INSERT'), sql.indexOf('UPDATE'))
  assert.doesNotMatch(insertBlock, /`id`/)
  // 主键不进 SET，但要进 WHERE
  const updateBlock = sql.slice(sql.indexOf('UPDATE'), sql.indexOf('SELECT'))
  const setClause = updateBlock.slice(updateBlock.indexOf('SET'), updateBlock.indexOf('WHERE'))
  assert.doesNotMatch(setClause, /`id` =/)
  assert.match(updateBlock, /WHERE `id` = #\{id\}/)
})

test('单表：无主键时不生成裸 UPDATE / DELETE', () => {
  const sql = generateSingleTable(get('user_role'), {
    dialect: 'mysql',
    kinds: ['update', 'delete'],
    withHeader: false,
  })

  assert.match(sql, /⚠️/)
  // 不能出现可直接执行的全表 UPDATE / DELETE
  assert.doesNotMatch(sql, /^DELETE FROM/m)
  assert.doesNotMatch(sql, /^UPDATE `user_role` SET[\s\S]*^;/m)
})

test('方言选项含 SQLite，顺序是 oracle → mysql → postgresql → sqlite', () => {
  assert.deepEqual(
    DIALECT_OPTIONS.map((o) => o.value),
    ['oracle', 'mysql', 'postgresql', 'sqlite'],
  )
})

test('方言：分页语法和标识符引用跟着方言变', () => {
  const opts = { kinds: ['select'] as const, withHeader: false }
  const mysql = generateSingleTable(get('user'), { ...opts, kinds: ['select'], dialect: 'mysql' })
  const pg = generateSingleTable(get('user'), { ...opts, kinds: ['select'], dialect: 'postgresql' })
  const oracle = generateSingleTable(get('user'), { ...opts, kinds: ['select'], dialect: 'oracle' })
  const sqlite = generateSingleTable(get('user'), { ...opts, kinds: ['select'], dialect: 'sqlite' })

  assert.match(mysql, /LIMIT #\{offset\}, #\{limit\}/)
  assert.match(mysql, /`username`/)
  assert.match(pg, /LIMIT #\{limit\} OFFSET #\{offset\}/)
  assert.match(pg, /"username"/)
  assert.match(oracle, /ROWNUM <= #\{offset\} \+ #\{limit\}/)
  assert.doesNotMatch(oracle, /FETCH NEXT/)
  assert.match(sqlite, /LIMIT #\{limit\} OFFSET #\{offset\}/)
  assert.match(sqlite, /"username"/)
})

/** 三表都参与，触发 order.user_id 与 user.id 的输出名冲突 */
function threeTableResult() {
  const links: JoinLink[] = parsed.foreignKeys.map((fk) => ({
    fk,
    joinType: 'LEFT',
    enabled: true,
  }))
  return generateMultiTable({
    dialect: 'mysql',
    mainTable: get('order'),
    tables: byName,
    links,
    withHeader: false,
    selectedColumns: allColsPick(get('order'), get('user'), get('user_role')),
  })
}

test('多表：输出列名全局唯一（user.id 不能也叫 user_id）', () => {
  const result = threeTableResult()

  const outNames = [...result.aliasByKey.values()]
  assert.equal(
    new Set(outNames).size,
    outNames.length,
    `输出列名重复：${outNames.filter((n, i) => outNames.indexOf(n) !== i).join(', ')}`,
  )

  // 这个 fixture 里 user_id 同时存在于 order 和 user_role，所以两边都要限定前缀；
  // 关键是 user.id 绝不能也占用 user_id，那会跟 order.user_id 的语义撞车
  assert.notEqual(result.aliasByKey.get('user.id'), 'user_id')
  assert.notEqual(result.aliasByKey.get('order.user_id'), result.aliasByKey.get('user.id'))
  // 前缀用表别名（o_/u_/ur_），不是表名
  assert.equal(result.aliasByKey.get('order.user_id'), 'o_user_id')
  assert.equal(result.aliasByKey.get('user_role.user_id'), 'ur_user_id')

  // SELECT 里实际输出的名字要和 aliasByKey 一致
  const listBlock = result.sql.slice(0, result.sql.indexOf('-- 2.'))
  const emitted = [...listBlock.matchAll(/AS `([^`]+)`/g)].map((m) => m[1])
  assert.equal(new Set(emitted).size, emitted.length, 'SELECT 里有重复的 AS 别名')
})

test('多表：只 JOIN 两张表时不做多余的别名限定', () => {
  // 只留 order → user 这条真外键，user_id 就只出现在 order 一张表里，
  // 不该被无谓地改名成 o_user_id
  const real = parsed.foreignKeys.filter((f) => f.confidence === 'constraint')
  const result = generateMultiTable({
    dialect: 'mysql',
    mainTable: get('order'),
    tables: byName,
    links: real.map((fk) => ({ fk, joinType: 'LEFT' as const, enabled: true })),
    withHeader: false,
    selectedColumns: allColsPick(get('order'), get('user')),
  })

  assert.deepEqual(result.joined, ['order', 'user'])
  assert.equal(result.aliasByKey.get('order.user_id'), 'user_id')
  // id / status / create_time 三张表都有，必须限定
  assert.equal(result.aliasByKey.get('order.id'), 'o_id')
  assert.equal(result.aliasByKey.get('user.id'), 'u_id')

  const outNames = [...result.aliasByKey.values()]
  assert.equal(new Set(outNames).size, outNames.length)
})

test('多表：JOIN 按拓扑序输出，引用的别名必须已经在链上', () => {
  const result = threeTableResult()
  assert.equal(result.droppedLinks.length, 0)

  const fromBlock = result.sql.slice(result.sql.indexOf('FROM'))
  const lines = fromBlock.split('\n').filter((l) => /^(FROM|LEFT JOIN|INNER JOIN)/.test(l))

  const declared = new Set<string>()
  for (const line of lines) {
    // FROM `order` o  /  LEFT JOIN `user` u ON o.`user_id` = u.`id`
    const alias = /^(?:FROM|\w+ JOIN) `[^`]+` (\w+)/.exec(line)?.[1]
    assert.ok(alias, `解析不出别名：${line}`)
    declared.add(alias)
    for (const ref of [...line.matchAll(/ (\w+)\.`/g)].map((m) => m[1])) {
      assert.ok(declared.has(ref), `${line} 引用了还没声明的别名 ${ref}`)
    }
  }
})

test('多表：孤立关联被丢掉而不是拼出跑不通的 SQL', () => {
  const result = generateMultiTable({
    dialect: 'mysql',
    mainTable: get('user'),
    tables: byName,
    links: [
      {
        // order_item 表根本不存在于 fixture，且两端都跟 user 无关
        fk: { fromTable: 'ghost_a', fromColumn: 'x', toTable: 'ghost_b', toColumn: 'y', confidence: 'naming' },
        joinType: 'LEFT',
        enabled: true,
      },
    ],
    withHeader: false,
  })

  assert.equal(result.droppedLinks.length, 1)
  assert.doesNotMatch(result.sql, /ghost_/)
})

test('多表：SUM 不落在外键列上', () => {
  const result = threeTableResult()
  const agg = result.sql.slice(result.sql.indexOf('-- 3.'))
  if (agg) {
    assert.doesNotMatch(agg, /SUM\([^)]*user_id/)
    assert.doesNotMatch(agg, /SUM\([^)]*role_id/)
  }
})

test('多表：未传 selectedColumns 只勾默认露出列', () => {
  const links: JoinLink[] = parsed.foreignKeys
    .filter((f) => f.confidence === 'constraint')
    .map((fk) => ({ fk, joinType: 'LEFT' as const, enabled: true }))
  const result = generateMultiTable({
    dialect: 'mysql',
    mainTable: get('order'),
    tables: byName,
    links,
    withHeader: false,
  })
  // order.total_amount / status 不在默认档，不该进 SELECT（除非降级补 JOIN 键）
  assert.ok(result.aliasByKey.has('order.id'))
  assert.ok(!result.aliasByKey.has('order.total_amount'))
  assert.ok(!result.aliasByKey.has('order.status'))
  // user.create_time 是日期档，默认勾；username/status 不是
  assert.ok(result.aliasByKey.has('user.create_time'))
  assert.ok(!result.aliasByKey.has('user.username'))
})

test('多表：勾选列只进 SELECT；全不选降级为主键和 JOIN 键', () => {
  const links: JoinLink[] = parsed.foreignKeys.map((fk) => ({
    fk,
    joinType: 'LEFT',
    enabled: true,
  }))
  const slim = generateMultiTable({
    dialect: 'mysql',
    mainTable: get('order'),
    tables: byName,
    links,
    withHeader: false,
    selectedColumns: {
      order: ['id', 'user_id'],
      user: ['username'],
      user_role: [],
    },
  })
  const list = slim.sql.slice(0, slim.sql.indexOf('-- 2.'))
  const selectOnly = list.slice(0, list.indexOf('\nFROM '))
  assert.match(selectOnly, /o\.`id`/)
  assert.match(selectOnly, /u\.`username`/)
  assert.doesNotMatch(selectOnly, /ur\./, 'user_role 全不选且别的表有列时，SELECT 不该再出 ur 列')
  assert.ok(slim.aliasByKey.has('order.id'))
  assert.ok(slim.aliasByKey.has('user.username'))
  assert.ok(!slim.aliasByKey.has('user_role.user_id'))

  const empty = generateMultiTable({
    dialect: 'mysql',
    mainTable: get('order'),
    tables: byName,
    links,
    withHeader: false,
    selectedColumns: { order: [], user: [], user_role: [] },
  })
  const emptyList = empty.sql.slice(0, empty.sql.indexOf('-- 2.'))
  assert.match(emptyList, /SELECT/)
  assert.ok(empty.aliasByKey.has('order.id'), '全不选应至少留下主表主键')
  // JOIN 键 order.user_id / user.id 也应留下
  assert.ok(empty.aliasByKey.has('order.user_id') || empty.aliasByKey.has('user.id'))
})

test('多表：列表查询条数、排序、分组', () => {
  const links: JoinLink[] = parsed.foreignKeys
    .filter((fk) => fk.fromTable === 'order' || fk.toTable === 'order')
    .map((fk) => ({ fk, joinType: 'LEFT', enabled: true }))
  const r = generateMultiTable({
    dialect: 'mysql',
    mainTable: get('order'),
    tables: byName,
    links,
    withHeader: false,
    pageSize: 50,
    orderBy: { column: 'user.username', dir: 'asc' },
  })
  const list = r.sql.slice(0, r.sql.indexOf('-- 2.'))
  assert.match(list, /ORDER BY u\.`username` ASC/)
  assert.match(list, /LIMIT 0, 50/)

  const g = generateMultiTable({
    dialect: 'mysql',
    mainTable: get('order'),
    tables: byName,
    links,
    withHeader: false,
    pageSize: 10,
    groupBy: 'user.username',
    orderBy: { column: 'cnt', dir: 'desc' },
  })
  const glist = g.sql.slice(0, g.sql.indexOf('-- 2.'))
  assert.match(glist, /GROUP BY u\.`username`/)
  assert.match(glist, /COUNT\(\*\) AS `cnt`/)
  assert.match(glist, /ORDER BY `cnt` DESC/)
  assert.match(glist, /LIMIT 0, 10/)
  assert.doesNotMatch(glist.slice(0, glist.indexOf('\nFROM ')), /o\.`id`/, '分组时列表 SELECT 不应再出其它勾选列')
})

test('多表：条件字段进 WHERE，全不选只留 1=1', () => {
  const links: JoinLink[] = parsed.foreignKeys
    .filter((fk) => fk.fromTable === 'order' || fk.toTable === 'order')
    .map((fk) => ({ fk, joinType: 'LEFT', enabled: true }))
  const def = generateMultiTable({
    dialect: 'mysql',
    mainTable: get('order'),
    tables: byName,
    links,
    withHeader: false,
  })
  const dlist = def.sql.slice(0, def.sql.indexOf('-- 2.'))
  assert.match(dlist, /WHERE o\.`id` = #\{o_id\}/)

  const extra = generateMultiTable({
    dialect: 'mysql',
    mainTable: get('order'),
    tables: byName,
    links,
    withHeader: false,
    selectConditions: ['order.id', 'user.username'],
  })
  const elist = extra.sql.slice(0, extra.sql.indexOf('-- 2.'))
  assert.match(elist, /WHERE o\.`id` = #\{o_id\}/)
  assert.match(elist, /AND u\.`username` = #\{u_username\}/)

  const none = generateMultiTable({
    dialect: 'mysql',
    mainTable: get('order'),
    tables: byName,
    links,
    withHeader: false,
    selectConditions: [],
  })
  const nlist = none.sql.slice(0, none.sql.indexOf('-- 2.'))
  assert.match(nlist, /WHERE 1 = 1/)
  assert.doesNotMatch(nlist, /#\{o_id\}/)
})

test('多表：字面量条件带默认值与比较符（跟单表可执行）', () => {
  const links: JoinLink[] = parsed.foreignKeys
    .filter((fk) => fk.fromTable === 'order' || fk.toTable === 'order')
    .map((fk) => ({ fk, joinType: 'LEFT', enabled: true }))
  const def = generateMultiTable({
    dialect: 'mysql',
    mainTable: get('order'),
    tables: byName,
    links,
    withHeader: false,
    conditionStyle: 'literal',
  })
  const dlist = def.sql.slice(0, def.sql.indexOf('-- 2.'))
  assert.match(dlist, /WHERE o\.`id` = 1/)
  assert.doesNotMatch(dlist, /#\{/)

  const extra = generateMultiTable({
    dialect: 'mysql',
    mainTable: get('order'),
    tables: byName,
    links,
    withHeader: false,
    conditionStyle: 'literal',
    selectConditions: ['order.id', 'user.username'],
    selectValues: { 'user.username': '甲' },
    cmpOps: { 'user.username': 'ne' },
  })
  const elist = extra.sql.slice(0, extra.sql.indexOf('-- 2.'))
  assert.match(elist, /WHERE o\.`id` = 1/)
  assert.match(elist, /AND u\.`username` <> '甲'/)
})

test('MyBatis 单表：主键用 <id>，自增主键回填', () => {
  const xml = generateSingleTableXml(get('user'), DEFAULT_MYBATIS_OPTIONS)

  assert.match(xml, /<id column="id" property="id" \/>/)
  assert.match(xml, /useGeneratedKeys="true" keyProperty="id"/)
  assert.match(xml, /<if test="username != null">/)
  // 标签必须闭合成对
  for (const tag of ['mapper', 'resultMap', 'insert', 'update', 'delete', 'select']) {
    const open = (xml.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length
    const close = (xml.match(new RegExp(`</${tag}>`, 'g')) ?? []).length
    assert.equal(open, close, `<${tag}> 没有闭合`)
  }
})

test('MyBatis 单表：无主键时不编出 update/delete', () => {
  const xml = generateSingleTableXml(get('user_role'), DEFAULT_MYBATIS_OPTIONS)
  assert.doesNotMatch(xml, /<update/)
  assert.doesNotMatch(xml, /<delete/)
  assert.match(xml, /无主键/)
})

test('MyBatis 多表：resultMap 的 column 用 SELECT 的输出别名', () => {
  const result = threeTableResult()
  const xml = generateMultiTableXml(get('order'), byName, result, DEFAULT_MYBATIS_OPTIONS)

  const columns = [...xml.matchAll(/column="([^"]+)"/g)].map((m) => m[1])
  assert.equal(new Set(columns).size, columns.length, 'resultMap 里有重复的 column')

  // 每个 column 都必须是 SELECT 真正输出的名字，否则映射不上
  const emitted = new Set(result.aliasByKey.values())
  for (const c of columns) {
    assert.ok(emitted.has(c), `resultMap 的 column="${c}" 在 SELECT 输出里不存在`)
  }

  assert.match(xml, /<collection property="userList"/)
  // XML 里不该残留 SQL 行尾注释
  assert.doesNotMatch(xml, /^\s*--/m)
})
