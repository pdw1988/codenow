/**
 * 执行顺序编排（PRD v0.6 模块 4.20）的单测。
 * 编排是纯函数：默认顺序、自定义覆盖、未知方法兜底、组内稳定性都在这里钉死。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_METHOD_ORDER,
  describeOrder,
  effectiveMethodOrder,
  groupByMethodOrder,
  normalizeMethodOrder,
} from './order'

test('默认顺序：POST → GET → PUT → PATCH → DELETE（新增先跑建出数据）', () => {
  assert.deepEqual([...DEFAULT_METHOD_ORDER], ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'])
  assert.equal(describeOrder(), 'POST → GET → PUT → PATCH → DELETE')
})

test('groupByMethodOrder：代码顺序混排也按方法分组重排，组内保持代码顺序', () => {
  const runs = [
    { id: 'get-list', method: 'GET' },
    { id: 'post-create', method: 'POST' },
    { id: 'get-detail', method: 'GET' },
    { id: 'del-remove', method: 'DELETE' },
    { id: 'put-update', method: 'PUT' },
  ]
  const groups = groupByMethodOrder(runs, (x) => x.method)
  assert.deepEqual(
    groups.map((g) => [g.method, g.items.map((x) => x.id), g.concurrent]),
    [
      ['POST', ['post-create'], false],
      ['GET', ['get-list', 'get-detail'], true],
      ['PUT', ['put-update'], false],
      ['DELETE', ['del-remove'], false],
    ],
  )
})

test('自定义顺序：列出的先按给定序跑，没列的按默认顺序跟在后面', () => {
  const runs = [
    { id: 'a', method: 'GET' },
    { id: 'b', method: 'POST' },
    { id: 'c', method: 'PUT' },
    { id: 'd', method: 'DELETE' },
  ]
  const groups = groupByMethodOrder(runs, (x) => x.method, ['DELETE', 'GET'])
  assert.deepEqual(
    groups.map((g) => g.method),
    ['DELETE', 'GET', 'POST', 'PUT'],
  )
})

test('未知方法排在最后，彼此按首次出现顺序；同组并发标记只给 GET', () => {
  const runs = [
    { id: 'x', method: 'HEAD' },
    { id: 'y', method: 'OPTIONS' },
    { id: 'z', method: 'HEAD' },
  ]
  const groups = groupByMethodOrder(runs, (x) => x.method)
  assert.deepEqual(
    groups.map((g) => [g.method, g.concurrent, g.items.map((x) => x.id)]),
    [
      ['HEAD', false, ['x', 'z']],
      ['OPTIONS', false, ['y']],
    ],
  )
})

test('normalizeMethodOrder：大小写、中英文逗号、斜杠混着来都认；脏词丢弃', () => {
  assert.deepEqual(normalizeMethodOrder('post, get，put/delete'), ['POST', 'GET', 'PUT', 'DELETE'])
  assert.deepEqual(normalizeMethodOrder(['get', 'GET', 'bogus', 'post']), ['GET', 'POST'])
  assert.deepEqual(normalizeMethodOrder(undefined), [])
  assert.deepEqual(normalizeMethodOrder(''), [])
  assert.deepEqual(normalizeMethodOrder('乱写的'), [])
})

test('effectiveMethodOrder：空/缺省回默认；部分自定义补全默认剩余项', () => {
  assert.deepEqual(effectiveMethodOrder(undefined), [...DEFAULT_METHOD_ORDER])
  assert.deepEqual(effectiveMethodOrder([]), [...DEFAULT_METHOD_ORDER])
  assert.deepEqual(effectiveMethodOrder(['DELETE']), ['DELETE', 'POST', 'GET', 'PUT', 'PATCH'])
})

test('describeOrder 带自定义配置时反映用户顺序', () => {
  assert.equal(describeOrder(['get']), 'GET → POST → PUT → PATCH → DELETE')
})
