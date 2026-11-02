/**
 * 大整数安全 JSON 往返（bigIntJson）的单测。
 * 背景：Java Long 主键（雪花 id）19 位，JS Number 53 位安全整数，
 * parse→stringify 一往返就把 1987654321098765431 圆整成 1987654321098765300。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parsePreservingBig,
  stringifyPreservingBig,
  unwrapSentinelStrings,
} from './bigIntJson'

// 雪花 id 必须用字符串写进测试源码——写成 Number 字面量那一刻就圆整了，
// 那正是这个模块要防的事
const LONG = '1987654321098765431'

test('往返：大整数逐字节原样回来', () => {
  const src = `{"applyId": ${LONG}, "name":"张三"}`
  const out = stringifyPreservingBig(parsePreservingBig(src))
  assert.equal(out, '{"applyId":1987654321098765431,"name":"张三"}')
})

test('往返：普通小数字照旧是数字', () => {
  const out = stringifyPreservingBig(parsePreservingBig('{"a":1,"b":-2.5,"c":123}'))
  assert.equal(out, '{"a":1,"b":-2.5,"c":123}')
})

test('字符串值里的 19 位数字不被动（扫描器认字符串边界）', () => {
  const src = `{"note":"id 1987654321098765431, ok","ids":"1,${LONG}"}`
  const out = stringifyPreservingBig(parsePreservingBig(src))
  assert.equal(out, '{"note":"id 1987654321098765431, ok","ids":"1,1987654321098765431"}')
})

test('数组里的大整数也保真', () => {
  const src = `{"ids":[${LONG},123]}`
  const out = stringifyPreservingBig(parsePreservingBig(src))
  assert.equal(out, '{"ids":[1987654321098765431,123]}')
})

test('pretty 缩进往返（stringifyPreservingBig 的 indent 转发）', () => {
  const src = `{"applyId": ${LONG}}`
  const out = stringifyPreservingBig(parsePreservingBig(src), 2)
  assert.equal(out, '{\n  "applyId": 1987654321098765431\n}')
})

test('科学计数法 / 小数长数字不被包裹（JSON 数字 token 校验）', () => {
  const out = stringifyPreservingBig(parsePreservingBig('{"a":1.1987654321098765431e20,"b":12345678901234567e-3}'))
  // 非纯整数 token 走原生 Number 往返——文本形态变了但那是本来行为，这里只钉「不炸」
  assert.ok(out.includes('"a"'))
})

test('16 位不安全整数（> 2^53-1）也保真', () => {
  const src = '{"n": 9999999999999999}'
  const out = stringifyPreservingBig(parsePreservingBig(src))
  assert.equal(out, '{"n":9999999999999999}')
})

test('unwrapSentinelStrings：只读消费拿数字字符串，断言能对上', () => {
  const parsed = parsePreservingBig(`{"applyId": ${LONG}, "list":[${LONG}]}`) as {
    applyId: string
    list: string[]
  }
  const plain = unwrapSentinelStrings(parsed)
  assert.equal(plain.applyId, String(LONG))
  assert.equal(plain.list[0], String(LONG))
  assert.equal(typeof plain.applyId, 'string')
})

test('unwrapSentinelStrings：普通值原样（嵌套 / null / 字符串含哨兵样貌但非整串）', () => {
  const v = { a: 1, b: null, c: 'x', d: '@@BIGINT:12x3' }
  const out = unwrapSentinelStrings(v)
  assert.deepEqual(out, v)
})
