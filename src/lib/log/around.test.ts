import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aroundView, centerTop } from './around'
import type { LogRecord } from './records'

const rec = (index: number, thread: string | null): LogRecord => ({
  index,
  raw: `line ${index}`,
  ts: null,
  level: 'INFO',
  thread,
  logger: null,
  msg: `line ${index}`,
  stack: [],
  mdc: {},
})

const all = [rec(0, 'a'), rec(1, 'b'), rec(2, 'a'), rec(3, null)]
const idx = (rs: LogRecord[]) => rs.map((r) => r.index)

test('查周边：不套筛选，全量按原顺序', () => {
  assert.deepEqual(idx(aroundView(all, { index: 2, thread: 'a', sameThread: false }, false)), [0, 1, 2, 3])
})

test('查周边：降序倒过来，不动原数组', () => {
  assert.deepEqual(idx(aroundView(all, { index: 2, thread: 'a', sameThread: false }, true)), [3, 2, 1, 0])
  assert.deepEqual(idx(all), [0, 1, 2, 3])
})

test('查周边：只看同线程', () => {
  assert.deepEqual(idx(aroundView(all, { index: 2, thread: 'a', sameThread: true }, false)), [0, 2])
})

test('查周边：锚点没线程名时「同线程」不生效，退回全量', () => {
  assert.equal(aroundView(all, { index: 3, thread: null, sameThread: true }, false).length, 4)
})

test('查周边：锚点滚到可视区中间，靠顶时贴顶', () => {
  assert.equal(centerTop(100, 28, 588), 100 * 28 - 280)
  assert.equal(centerTop(3, 28, 588), 0)
})
