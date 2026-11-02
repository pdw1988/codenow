/**
 * mockValueOfField：APIForge 侧（HTTP 参数 / JSON body）的字段取值。
 *
 * 出句那条路（planValues → renderValue）的值被 oracleDdl.test.ts / sqlgen.test.ts
 * 钉着，改这批规则时必须两边一起绿：**共用同一张 NAME_RULES 和同一批生成器**，
 * 只是编排入口不同。这个文件只测新入口。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mockValueOfField, toSnake, usesFieldDictionary } from './mockValue'

const v = (name: string, javaType = 'String', description?: string) =>
  mockValueOfField({ name, javaType, description })

test('toSnake：camelCase 归一，缩略词不切碎', () => {
  assert.equal(toSnake('brandOwnerId'), 'brand_owner_id')
  // userPWD 不能切成 user_p_w_d，否则 /pwd$/ 失配，密码字段拿到一个人名
  assert.equal(toSnake('userPWD'), 'user_pwd')
  assert.equal(toSnake('isDeleted'), 'is_deleted')
  // 本来就是 snake_case 的列名是恒等变换：出句那条路逐字节不变
  assert.equal(toSnake('create_time'), 'create_time')
  assert.equal(toSnake('id'), 'id')
})

test('字段名语义：手机号/邮箱/身份证/金额/单号/人名各按语义出值', () => {
  assert.match(v('phone'), /^138\d{8}$/)
  assert.match(v('contactEmail'), /^[a-z]+@test\.com$/)
  assert.match(v('idCard'), /^1101011990\d{8}$/)
  assert.match(v('orderAmount'), /^\d{1,4}\.\d{2}$/)
  assert.match(v('orderNo'), /^T\d{8}$/)
  assert.match(v('userName'), /^(张三|李四|王五|赵六|孙七|周八)$/)
})

test('camelCase 字段名也命中规则（APIForge 的 DTO 字段全是 camelCase）', () => {
  // 外键值只能给小数字：给随机大数的话 INSERT 一碰外键约束就 1452
  assert.match(v('brandOwnerId'), /^[1-5]$/)
  // isDeleted → 0/1（Boolean 字段在别的分支按类型给 true，这条管 String 型标志位）
  assert.match(v('isDeleted'), /^[01]$/)
})

test('注释优先于字段名：字段名中性时靠注释拿语义', () => {
  // 实测国内工程把格式约束写在注释里、字段名是中性的（contact / attr / field1）
  assert.match(v('contact', 'String', '联系人手机号'), /^138\d{8}$/)
  assert.equal(v('contact', 'String', '品牌商id,必填。'), '测试文本')
  // 没有注释就没有可依据的语义
  assert.equal(v('contact'), '测试文本')
})

test('日期给字面量，不给 SQL 表达式 —— SYSDATE / NOW() 发进 HTTP 是非法参数', () => {
  assert.equal(v('createTime', 'LocalDateTime'), '2026-01-01 00:00:00')
  assert.equal(v('birthday', 'LocalDate'), '2026-01-01')
  assert.equal(v('startAt', 'Date'), '2026-01-01 00:00:00')
})

test('同一字段每次同一个值：用例可复现、导出的 diff 稳定', () => {
  assert.equal(v('phone'), v('phone'))
  assert.equal(v('phone', 'String', '手机号'), v('phone', 'String', '手机号'))
  // 不同字段要散得开，不能整张 DTO 一个值（五个同时撞车实际不可能）
  const many = ['phoneA', 'phoneB', 'phoneC', 'phoneD', 'phoneE'].map((n) => v(n))
  assert.ok(new Set(many).size > 1, '不同字段名不该给同一个值')
})

test('声明长度截断：VARCHAR(4) 塞不进 11 位手机号，不截会 1406 Data too long', () => {
  assert.equal(v('phone').length, 11)
  assert.equal(mockValueOfField({ name: 'phone', javaType: 'String', length: 4 }).length, 4)
})

test('usesFieldDictionary：只放字符串类 —— 数字/布尔进了字典直接是 400', () => {
  assert.equal(usesFieldDictionary('String'), true)
  assert.equal(usesFieldDictionary('char'), true)
  // 认不出的类型当字符串：扫描器认不出的基本都是枚举 / 泛型擦除后的串
  assert.equal(usesFieldDictionary(''), true)
  assert.equal(usesFieldDictionary('Long'), false)
  assert.equal(usesFieldDictionary('Boolean'), false)
  // Boolean 只认 true/false，字典给的 0/1 Spring 不认
  assert.equal(usesFieldDictionary('BigDecimal'), false)
  assert.equal(usesFieldDictionary('LocalDateTime'), false)
})
