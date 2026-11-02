import test from 'node:test'
import assert from 'node:assert/strict'
import { annotateJsonKeys } from './annotateJson'

const hint = (k: string) => (k === 'code' ? '状态码' : k === 'msg' ? '提示信息' : '')

test('annotateJsonKeys：在 key 行末加含义，不改值', () => {
  const src = '{\n  "code": "200",\n  "msg": "ok"\n}'
  const out = annotateJsonKeys(src, hint)
  assert.match(out, /"code": "200",  \/\/ 状态码/)
  assert.match(out, /"msg": "ok"  \/\/ 提示信息/)
})

test('annotateJsonKeys：没有含义的 key 原样', () => {
  assert.equal(annotateJsonKeys('{\n  "x": 1\n}', hint), '{\n  "x": 1\n}')
})

test('annotateJsonKeys：已经标过的不再叠一层', () => {
  const once = annotateJsonKeys('{\n  "code": "200"\n}', hint)
  assert.equal(annotateJsonKeys(once, hint), once)
})

test('annotateJsonKeys：不是 JSON 结构的行不动', () => {
  assert.equal(annotateJsonKeys('not json', hint), 'not json')
})
