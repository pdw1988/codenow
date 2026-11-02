import test from 'node:test'
import assert from 'node:assert/strict'
import { PRETTY_MSG_MAX, prettyJsonInText } from './prettyMsg'

test('整行 JSON：缩进 2 空格', () => {
  assert.equal(prettyJsonInText('{"a":1,"b":[{"c":2}]}'), '{\n  "a": 1,\n  "b": [\n    {\n      "c": 2\n    }\n  ]\n}')
})

test('文字里嵌的 JSON：前后文字保留，JSON 独占几行', () => {
  const out = prettyJsonInText('提交订单开始,req::{"applyId":1} 结束')
  assert.equal(out, '提交订单开始,req::\n{\n  "applyId": 1\n}\n 结束')
})

test('多段 JSON 都格式化', () => {
  const out = prettyJsonInText('请求:{"a":1} 响应:{"b":2}')
  assert.equal(out, '请求:\n{\n  "a": 1\n}\n 响应:\n{\n  "b": 2\n}')
})

test('大整数（雪花 id）不被圆整', () => {
  assert.match(prettyJsonInText('{"id":1987654321098765431}'), /1987654321098765431/)
})

test('字符串里的括号不干扰配对', () => {
  assert.equal(prettyJsonInText('{"s":"a}b]{"}'), '{\n  "s": "a}b]{"\n}')
})

test('不是 JSON 的原样返回：方括号标记、toString、半截 JSON、占位符', () => {
  for (const s of [
    'MessageEntity [msgKey=1, tenantId=1001]',
    'TvlExpenseAddRequest(applyId=1, borrow=0)',
    '收到 {"a":1,"b"',
    '参数 {} 和 [1, 2]',
    '',
  ]) {
    assert.equal(prettyJsonInText(s), s)
  }
})

test('超长不格式化', () => {
  const s = `{"a":"${'x'.repeat(PRETTY_MSG_MAX)}"}`
  assert.equal(prettyJsonInText(s), s)
})
