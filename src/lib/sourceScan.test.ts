/**
 * 方式三「扫描项目源码」解析引擎的回归。
 *
 * 扫描的失败模式全是安静的：排除目录漏了就白扫几千个文件、上下文窗口串了
 * 列名就悄悄导错、可信度合并反了残缺表就混进完整堆里——用例钉住这些语义，
 * 不钉「函数能返回东西」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  camelToSnake,
  entityColumnsToDomain,
  entityNameToTable,
  mergeScanned,
  parseEntity,
  parseMapperXml,
  pickScanFiles,
  SCAN_MAX_FILES,
  sqlTypeFromJava,
} from './sourceScan'

const meta = (path: string, size = 100) => ({ path, size })
const ALL_ON = { sql: true, ent: true, xml: true }

/* ================= 文件挑选与防护 ================= */

test('挑选：三类扩展名各归各，来源开关关掉的那类直接不挑', () => {
  const files = [
    meta('src/main/resources/sql/schema.sql'),
    meta('src/main/java/com/mall/entity/User.java'),
    meta('src/main/resources/mapper/UserMapper.xml'),
    meta('README.md'),
  ]
  const r = pickScanFiles(files, ALL_ON)
  assert.deepEqual(
    r.picks.map((p) => p.kind),
    ['sql', 'ent', 'xml'],
  )
  const off = pickScanFiles(files, { sql: true, ent: false, xml: true })
  assert.deepEqual(
    off.picks.map((p) => p.kind),
    ['sql', 'xml'],
  )
})

test('防护：target / node_modules / .git / dist / build 整目录跳过，Windows 反斜杠也认', () => {
  const files = [
    meta('project\\target\\classes\\App.class'),
    meta('project/node_modules/vue/index.js'),
    meta('project/.git/config'),
    meta('project/build/libs/app.jar'),
    meta('project/src/main/java/App.java'),
  ]
  const r = pickScanFiles(files, ALL_ON)
  assert.deepEqual(r.picks, [{ path: 'project/src/main/java/App.java', kind: 'ent' }])
  assert.equal(r.skippedByDir, 4)
})

test('防护：单文件超 2MB 跳过并计数；总数超上限中途停下且 overflow 要亮出来', () => {
  const big = pickScanFiles([meta('a/big.sql', 3 * 1024 * 1024), meta('b/ok.sql')], ALL_ON)
  assert.equal(big.skippedBig, 1)
  assert.deepEqual(
    big.picks.map((p) => p.path),
    ['b/ok.sql'],
  )

  const many = Array.from({ length: SCAN_MAX_FILES + 10 }, (_, i) => meta(`d/f${i}.java`))
  const over = pickScanFiles(many, ALL_ON)
  assert.equal(over.overflow, true)
  assert.ok(over.picks.length <= SCAN_MAX_FILES)
})

/* ================= 命名换算 ================= */

test('camelToSnake：普通驼峰和连续大写缩写都对，已是下划线的原样', () => {
  assert.equal(camelToSnake('userName'), 'user_name')
  assert.equal(camelToSnake('UserID'), 'user_id')
  assert.equal(camelToSnake('user_name'), 'user_name')
})

test('entityNameToTable：常见后缀剥掉再转下划线——UserEntity→user、OrderDO→order', () => {
  assert.equal(entityNameToTable('UserEntity'), 'user')
  assert.equal(entityNameToTable('OrderDO'), 'order')
  assert.equal(entityNameToTable('StockLog'), 'stock_log')
})

test('sqlTypeFromJava：类型是猜的要敢承认——全限定名剥包、认不出退 VARCHAR(255)', () => {
  assert.equal(sqlTypeFromJava('String'), 'VARCHAR(255)')
  assert.equal(sqlTypeFromJava('Long'), 'BIGINT')
  assert.equal(sqlTypeFromJava('java.time.LocalDateTime'), 'DATETIME')
  assert.equal(sqlTypeFromJava('java.math.BigDecimal'), 'DECIMAL(20,2)')
  assert.equal(sqlTypeFromJava('byte[]'), 'BLOB')
  assert.equal(sqlTypeFromJava('SomeWeirdType'), 'VARCHAR(255)')
})

/* ================= @Entity 解析 ================= */

const ENTITY_SRC = `package com.mall.entity;

import javax.persistence.*;

/** 用户实体 */
@Entity
@Table(name = "t_user")
public class User {

    /** 主键 */
    @Id
    @Column(name = "id", nullable = false)
    private Long id;

    // 用户名
    @Column(name = "user_name")
    private String userName;

    /** 年龄 */
    private Integer age;

    @Transient
    private String tmpCache;

    public static final int MAX_RETRY = 3;

    @Column(name = "status", nullable = false)
    private Integer status;
}`

test('@Entity：@Table 表名、@Id 主键、@Column 列名与 nullable、注释三种写法都收', () => {
  const e = parseEntity(ENTITY_SRC)
  assert.ok(e)
  assert.equal(e.table, 't_user')
  assert.equal(e.javaClass, 'User')
  assert.deepEqual(
    e.columns.map((c) => c.column),
    ['id', 'user_name', 'age', 'status'], // tmpCache 被 @Transient 排除，常量不进
  )
  const [id, name, age, status] = e.columns
  assert.equal(id.isPrimaryKey, true)
  assert.equal(id.nullable, false)
  assert.equal(id.comment, '主键')
  assert.equal(name.comment, '用户名') // 行注释也算一路
  assert.equal(age.column, 'age') // 没有 @Column 时驼峰转下划线兜底
  assert.equal(status.nullable, false)
  assert.equal(status.comment, undefined)
})

test('没有注解的普通类返回 null——项目里大多数类不是实体', () => {
  assert.equal(parseEntity('public class UserService {\n  private UserMapper mapper;\n}'), null)
})

test('相邻字段不吃上一条成员的注解：orderNo 的 @Column 不能串到 userId 头上', () => {
  const src = `@Entity
public class Order {
    @Column(name = "order_no")
    private String orderNo;
    private Long userId;
}`
  const e = parseEntity(src)!
  assert.equal(e.columns[0].column, 'order_no')
  assert.equal(e.columns[1].column, 'user_id')
})

test('entityColumnsToDomain：SQL 类型是猜的但 Java 映射是真的（原样保留）', () => {
  const cols = entityColumnsToDomain([
    { column: 'user_name', javaField: 'userName', javaType: 'String', nullable: true, isPrimaryKey: false },
  ])
  assert.equal(cols[0].type, 'VARCHAR(255)')
  assert.equal(cols[0].javaType, 'String')
  assert.equal(cols[0].isAutoIncrement, false)
})

/* ================= Mapper XML ================= */

test('Mapper XML：resultMap 的列去重保序，type 类名转表名；insert into 直接收表名和列清单', () => {
  const xml = `<?xml version="1.0"?>
<mapper namespace="com.mall.mapper.OrderMapper">
  <resultMap id="BaseMap" type="com.mall.entity.Order">
    <id column="id" property="id"/>
    <result column="order_no" property="orderNo"/>
    <result column="id" property="id"/>
    <result column="user_id" property="userId"/>
  </resultMap>
  <insert id="insert">
    INSERT INTO \`order\` (id, user_id, order_no) VALUES (#{id}, #{userId}, #{orderNo})
  </insert>
</mapper>`
  const hits = parseMapperXml(xml)
  assert.deepEqual(hits, [
    { table: 'order', columns: ['id', 'order_no', 'user_id'], via: 'resultMap' },
    { table: 'order', columns: ['id', 'user_id', 'order_no'], via: 'insert' },
  ])
})

/* ================= 可信度合并 ================= */

const rawOf = (name: string, kind: 'sql' | 'ent' | 'xml', nCols: number) => ({
  name,
  comment: `${name} 注释`,
  columns: Array.from({ length: nCols }, (_, i) => ({
    name: `c${i}`,
    type: 'INT',
    nullable: true,
    isPrimaryKey: i === 0,
    isAutoIncrement: false,
    javaField: `c${i}`,
    javaType: 'Integer',
  })),
  kind: kind as 'sql' | 'ent' | 'xml',
})

test('合并：同名表内容取最高可信度来源（SQL > Entity > XML），来源标签全保留且按可信度排序', () => {
  const merged = mergeScanned([
    rawOf('order', 'xml', 4), // XML 只有 4 列
    rawOf('order', 'ent', 8), // 实体 8 列
    rawOf('coupon', 'ent', 5),
    rawOf('coupon', 'sql', 7), // SQL 脚本最全，赢
  ])
  const order = merged.find((t) => t.name === 'order')!
  assert.equal(order.columns.length, 8) // 内容是实体的，不是 XML 的 4 列
  assert.deepEqual(order.srcs, ['ent', 'xml'])
  assert.equal(order.complete, true)
  const coupon = merged.find((t) => t.name === 'coupon')!
  assert.equal(coupon.columns.length, 7)
  assert.deepEqual(coupon.srcs, ['sql', 'ent'])
})

test('合并：只有 Mapper XML 来源的表标不完整——缺多少列根本不知道，默认不勾就是为它准备的', () => {
  const merged = mergeScanned([rawOf('payment', 'xml', 4), rawOf('user', 'ent', 6)])
  assert.equal(merged.find((t) => t.name === 'payment')!.complete, false)
  assert.equal(merged.find((t) => t.name === 'user')!.complete, true)
  // 完整的排前面，残缺的沉底但不藏
  assert.deepEqual(
    merged.map((t) => t.name),
    ['user', 'payment'],
  )
})
