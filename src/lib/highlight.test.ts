/**
 * 着色器的回归测试。
 *
 * 最重要的一条是「token 拼回去等于原文」：着色只准改颜色，不准改内容。
 * 少一个字符的表现是「界面上显示的 SQL 跟复制走的 SQL 不一样」，
 * 而复制用的是原始字符串，肉眼几乎发现不了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { highlight, type Lang, type Token } from './highlight'

const join = (tokens: Token[]) => tokens.map((t) => t.text).join('')
const clsOf = (tokens: Token[], text: string) => tokens.find((t) => t.text === text)?.cls

/** 某一类里被着色的片段 */
const pick = (tokens: Token[], cls: string) => tokens.filter((t) => t.cls === cls).map((t) => t.text)

test('无损：三种语言的 token 拼回去都等于原文', () => {
  const cases: Array<[Lang, string]> = [
    ['sql', "INSERT INTO `user` (id, name) VALUES (1, 'it''s me'); -- 备注里有 ' 号\n"],
    ['xml', '<select id="q" resultType="User">\n  SELECT * FROM user WHERE id = #{id}\n</select>'],
    ['json', '{"code": 0, "list": [1, -2.5, true, null], "msg": "ok"}'],
    ['text', '随便一段中文，带 <尖括号> 和 "引号"'],
  ]
  for (const [lang, src] of cases) {
    assert.equal(join(highlight(src, lang)), src, `${lang} 丢字符了`)
  }
})

test('SQL：行注释里的单引号不会把后面的代码带偏', () => {
  // 叠加式替换（先换注释再换字符串）在这里会把 `\n SELECT 1` 当成字符串内容
  const tokens = highlight("-- 这里有个 ' 号\nSELECT 1", 'sql')
  assert.equal(clsOf(tokens, "-- 这里有个 ' 号"), 'c')
  assert.equal(clsOf(tokens, 'SELECT'), 'k')
  assert.equal(clsOf(tokens, '1'), 'n')
  assert.deepEqual(pick(tokens, 's'), [], '不该有任何字符串片段')
})

test('SQL：两个单引号是转义，整段算一个字符串', () => {
  const tokens = highlight("WHERE remark = 'it''s' AND id = 1", 'sql')
  assert.deepEqual(pick(tokens, 's'), ["'it''s'"])
})

test('SQL：#{} 和 ? 都算占位符，跟数字分开', () => {
  const tokens = highlight('WHERE id = #{userId} AND age > ? AND n = 18', 'sql')
  assert.deepEqual(pick(tokens, 'f'), ['#{userId}', '?'])
  assert.deepEqual(pick(tokens, 'n'), ['18'])
})

test('SQL：字符串里的关键字不着色', () => {
  const tokens = highlight("SELECT 'select from where'", 'sql')
  assert.deepEqual(pick(tokens, 'k'), ['SELECT'])
})

test('XML：属性值里的尖括号不会截断标签', () => {
  const tokens = highlight('<result column="a>b" property="x"/>', 'xml')
  assert.deepEqual(pick(tokens, 's'), ['"a>b"', '"x"'])
  assert.deepEqual(pick(tokens, 'f'), ['column', 'property'])
  assert.deepEqual(pick(tokens, 'k'), ['result'])
})

test('XML：注释整段算注释', () => {
  const tokens = highlight('<!-- <select id="x"> -->', 'xml')
  assert.deepEqual(pick(tokens, 'c'), ['<!-- <select id="x"> -->'])
  assert.deepEqual(pick(tokens, 'k'), [])
})

test('JSON：键和字符串值要能分开', () => {
  const tokens = highlight('{"msg": "ok"}', 'json')
  assert.deepEqual(pick(tokens, 'k'), ['"msg"'], '键')
  assert.deepEqual(pick(tokens, 's'), ['"ok"'], '值')
})

test('JSON：true/false/null 跟数字分开', () => {
  const tokens = highlight('[1, 2.5, true, false, null]', 'json')
  assert.deepEqual(pick(tokens, 'n'), ['1', '2.5'])
  assert.deepEqual(pick(tokens, 'f'), ['true', 'false', 'null'])
})

test('空串不炸，返回空数组', () => {
  assert.deepEqual(highlight('', 'sql'), [])
})

test('YAML：键、字符串值、注释、数字各归各位（键不含冒号，冒号不带色）', () => {
  const tokens = highlight("spring:\n  port: '8080'   # 端口\n  n: 10", 'yaml')
  assert.deepEqual(pick(tokens, 'k'), ['spring', '  port', '  n'])
  assert.deepEqual(pick(tokens, 's'), ["'8080'"])
  assert.equal(clsOf(tokens, '# 端口'), 'c')
  assert.deepEqual(pick(tokens, 'n'), ['10'])
})

test('YAML：引号里的 # 不算注释（单趟扫描按位置优先级裁决）', () => {
  const tokens = highlight("u: 'has # hash'", 'yaml')
  assert.deepEqual(pick(tokens, 's'), ["'has # hash'"])
  assert.deepEqual(pick(tokens, 'c'), [])
})

test('Properties：键含点/中括号整体算键，= 不带色', () => {
  const tokens = highlight('# app\na.b[0]=x\nserver.port=8080', 'props')
  // a.b[0] 被键规则整体吃掉，里面的 0 不会再按数字着色
  assert.deepEqual(pick(tokens, 'k'), ['a.b[0]', 'server.port'])
  assert.deepEqual(pick(tokens, 'c'), ['# app'])
  assert.deepEqual(pick(tokens, 'n'), ['8080'])
})

test('无损：yaml 和 props 也拼得回去', () => {
  const ysrc = "spring:\n  url: 'jdbc:mysql://h:3306/x'   # 库\nservers:\n  - a\n  - b"
  assert.equal(join(highlight(ysrc, 'yaml')), ysrc)
  const psrc = '# c\nspring.datasource.url=jdbc:mysql://localhost:3306/t\np=a\\nb'
  assert.equal(join(highlight(psrc, 'props')), psrc)
})
