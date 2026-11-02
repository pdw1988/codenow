import assert from 'node:assert/strict'
import { test } from 'node:test'
import { jsonProblem } from './jsonCheck'

test('jsonProblem：合法或空串返回 null', () => {
  assert.equal(jsonProblem(''), null)
  assert.equal(jsonProblem('  \n '), null)
  assert.equal(jsonProblem('{"a": [1, 2]}'), null)
  // 字符串值里的中文标点是合法的，不能误报
  assert.equal(jsonProblem('{"a": "你好，世界：“引号”"}'), null)
})

test('jsonProblem：不合法时给出大致行号', () => {
  const bad = '{\n  "a": 1,\n  "b": 2,,\n  "c": 3\n}'
  const p = jsonProblem(bad)
  assert.ok(p)
  assert.equal(p.line, 3)
  assert.match(p.why ?? '', /多了一个逗号/)
})

test('jsonProblem：写到一半结束的，行号落在最后一行', () => {
  const p = jsonProblem('{\n  "a": 1,\n  "b": ')
  assert.ok(p)
  assert.equal(p.line, 3)
  assert.match(p.why ?? '', /没写完/)
})

test('jsonProblem：肉眼看不出的错给出原因', () => {
  const cases: [string, RegExp][] = [
    ['{\n  "a"：1\n}', /中文标点.*「:」/],
    ['{\n  "a": 1，\n  "b": 2\n}', /中文标点.*「,」/],
    ['{\n  “a”: 1\n}', /中文标点/],
    ['{\n  "a":\u00a01\n}', /看不见的特殊空格/],
    ["{\n  'a': 1\n}", /双引号/],
    ['{\n  "a": 1,\n}', /多了一个逗号/],
    ['{\n  "a": 1\n  "b": 2\n}', /少了一个逗号/],
    ['{\n  a: 1\n}', /字段名要用双引号/],
    ['{\n  // 注释\n  "a": 1\n}', /注释/],
  ]
  for (const [text, re] of cases) {
    const p = jsonProblem(text)
    assert.ok(p, text)
    assert.match(p.why ?? '', re, text)
  }
})
