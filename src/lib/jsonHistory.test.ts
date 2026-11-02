import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addJsonHistory,
  autoTitle,
  renameJsonHistory,
  historyTime,
  JSON_HISTORY_LIMIT,
  JSON_HISTORY_MAX_CHARS,
  matchJsonHistory,
  parseJsonHistory,
  type JsonHistoryEntry,
} from './jsonHistory'

const e = (json: string, from: string | null = null, id = json): JsonHistoryEntry => ({ id, json, from, at: '2026-10-09T08:00:00.000Z' })

test('同样内容只留一条并提到最前，沿用原 id 和已知来源', () => {
  let list = addJsonHistory([], e('{"a":1}', 'GET /user', 'x1'))
  list = addJsonHistory(list, e('{"b":2}'))
  list = addJsonHistory(list, e('{"a":1}', null, 'x9'))
  assert.deepEqual(list.map((x) => x.json), ['{"a":1}', '{"b":2}'])
  assert.equal(list[0]!.id, 'x1')
  assert.equal(list[0]!.from, 'GET /user')
})

test('超上限裁掉最旧的；太大的不记', () => {
  let list: JsonHistoryEntry[] = []
  for (let i = 0; i < JSON_HISTORY_LIMIT + 5; i++) list = addJsonHistory(list, e(`[${i}]`))
  assert.equal(list.length, JSON_HISTORY_LIMIT)
  assert.equal(list.at(-1)!.json, '[5]')
  assert.equal(addJsonHistory(list, e('x'.repeat(JSON_HISTORY_MAX_CHARS + 1))), list)
})

test('名字：同内容重记保留名字，改名 / 清名不动顺序', () => {
  let list = addJsonHistory([], { ...e('{"a":1}'), name: '用户详情' })
  list = addJsonHistory(list, e('{"b":2}'))
  list = addJsonHistory(list, e('{"a":1}', null, 'x9'))
  assert.equal(list[0]!.name, '用户详情')
  list = renameJsonHistory(list, list[1]!.id, '  订单  ')
  assert.deepEqual(list.map((x) => x.name), ['用户详情', '订单'])
  list = renameJsonHistory(list, list[0]!.id, ' ')
  assert.ok(!('name' in list[0]!))
})

test('超上限先裁最旧的未命名，起过名的留着', () => {
  let list = addJsonHistory([], { ...e('["keep"]'), name: '留着' })
  for (let i = 0; i < JSON_HISTORY_LIMIT + 5; i++) list = addJsonHistory(list, e(`[${i}]`))
  assert.equal(list.length, JSON_HISTORY_LIMIT)
  assert.equal(list.at(-1)!.json, '["keep"]')
  assert.equal(list.at(-2)!.json, '[6]')
})

test('自动标题：码上测用接口名，包装层往里看一层，数组报项数', () => {
  assert.equal(autoTitle(e('{"a":1}', 'GET /user')), 'GET /user')
  assert.equal(autoTitle(e('{"code":0,"msg":"ok","data":{"applyNo":"A1","status":2}}')), 'data → applyNo · status')
  assert.equal(autoTitle(e('[{"id":1,"name":"x"},{"id":2}]')), '2 项：id · name')
  assert.equal(autoTitle(e('{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6}')), 'a · b · c · d · e 等 6 个字段')
})

test('解析跳过坏条目，损坏返回空', () => {
  assert.deepEqual(parseJsonHistory('{坏'), [])
  assert.equal(parseJsonHistory(JSON.stringify([e('[1]'), { id: 1 }])).length, 1)
})

test('筛选与时间', () => {
  assert.ok(matchJsonHistory(e('{"orderNo":"NO1"}', 'GET /order'), 'order'))
  assert.ok(!matchJsonHistory(e('{"a":1}'), 'zzz'))
  const now = new Date(2026, 9, 9, 18, 0)
  assert.equal(historyTime(new Date(2026, 9, 9, 8, 5).toISOString(), now), '08:05')
  assert.equal(historyTime(new Date(2026, 9, 1, 8, 5).toISOString(), now), '10-01 08:05')
})
