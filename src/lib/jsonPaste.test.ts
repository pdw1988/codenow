import test from 'node:test'
import assert from 'node:assert/strict'
import { extractJson } from './jsonPaste'

/** 不格式化，原样返回方便断言 */
const isJson = (s: string) => {
  try {
    JSON.parse(s)
    return s
  } catch {
    return null
  }
}

test('去掉 { 前面和 } 后面的文字', () => {
  assert.equal(
    extractJson('2026-10-29 10:00:01 [INFO] resp={"code":0,"data":[1,2]} cost=12ms', isJson),
    '{"code":0,"data":[1,2]}',
  )
})

test('对象抠不出来再试数组', () => {
  assert.equal(extractJson('list: [1, 2, 3] done', isJson), '[1, 2, 3]')
})

test('抠出来不是合法 JSON / 本来就没有多余文字：返回 null', () => {
  assert.equal(extractJson('a {"x": } b', isJson), null)
  assert.equal(extractJson('没有括号', isJson), null)
  assert.equal(extractJson('  {"x":1}  ', isJson), null)
})
