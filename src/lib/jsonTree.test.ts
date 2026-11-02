import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePreservingBig } from './bigIntJson'
import {
  ancestors,
  copyText,
  defaultOpen,
  findHits,
  indexTree,
  KID_PAGE,
  leafText,
  preview,
  revealShown,
  splitHit,
  summary,
  visibleRows,
} from './jsonTree'

const SRC = `{"code":0,"data":{"total":2,"list":[{"id":1987654321098765431,"name":"Alice","tags":["a","b"]},{"id":7,"name":"bob","tags":[]}]},"a b":null}`
const idx = indexTree(parsePreservingBig(SRC))

test('路径当 id：普通键用点，特殊键用方括号，数组用下标', () => {
  assert.ok(idx.has('$.data.list[0].name'))
  assert.ok(idx.has('$["a b"]'))
  assert.equal(idx.get('$.data.list[1]')!.last, true)
  assert.equal(idx.get('$.code')!.last, false)
})

test('大整数按数字显示，不丢精度', () => {
  const n = idx.get('$.data.list[0].id')!
  assert.equal(n.kind, 'number')
  assert.equal(leafText(n), '1987654321098765431')
  assert.match(copyText(idx.get('$.data.list[0]')!), /"id": 1987654321098765431,/)
})

test('父节点概况与折叠预览', () => {
  assert.equal(summary(idx, idx.get('$.data')!), '2 个字段')
  assert.equal(summary(idx, idx.get('$.data.list')!), '2 项 · 对象')
  assert.equal(summary(idx, idx.get('$.data.list[0].tags')!), '2 项 · 字符串')
  assert.equal(summary(idx, idx.get('$.data.list[1].tags')!), '空数组')
  assert.equal(preview(idx, idx.get('$.data.list')!), '[ { id, name, tags } × 2 ]')
  assert.equal(preview(idx, idx.get('$.data.list[0].tags')!), '[ "a", "b" ]')
  assert.equal(preview(idx, idx.get('$')!), '{ code, data, a b }')
})

test('展开的容器多一行闭括号，折起的不展开子节点', () => {
  const rows = visibleRows(idx, new Set(['$']))
  assert.deepEqual(
    rows.map((r) => `${r.t}:${r.node.id}`),
    ['node:$', 'node:$.code', 'node:$.data', 'node:$["a b"]', 'close:$'],
  )
  assert.ok(defaultOpen(idx).has('$.data.list'))
  assert.ok(!defaultOpen(idx).has('$.data.list[0]'))
})

test('大数组：子节点只画前 KID_PAGE 个，默认展开不超行数预算，搜索跳转放出目标', () => {
  const big = indexTree(Array.from({ length: 20000 }, (_, i) => ({ id: i, dept: { id: i, name: 'd', code: 'c' } })))
  const open = defaultOpen(big)
  assert.ok(open.has('$') && open.has('$[0]') && !open.has('$[0].dept'))
  const rows = visibleRows(big, open)
  assert.ok(rows.length < 1500)
  const more = rows.find((r) => r.t === 'more')
  assert.deepEqual(more && more.t === 'more' ? [more.node.id, more.rest] : null, ['$', 20000 - KID_PAGE])

  const shown = revealShown(big, '$[19999].id', new Map())
  assert.equal(shown.get('$'), 20000)
  assert.ok(visibleRows(big, new Set(['$', '$[19999]']), shown).some((r) => r.node.id === '$[19999].id'))
})

test('搜索：字段名或值，不分大小写，按显示顺序；$ 开头按路径', () => {
  assert.deepEqual(findHits(idx, 'alice'), ['$.data.list[0].name'])
  assert.deepEqual(findHits(idx, 'NAME'), ['$.data.list[0].name', '$.data.list[1].name'])
  assert.deepEqual(findHits(idx, '8765431'), ['$.data.list[0].id'])
  assert.deepEqual(findHits(idx, '$.data.list[1]'), ['$.data.list[1]'])
  assert.deepEqual(findHits(idx, '  '), [])
  assert.deepEqual(findHits(idx, '"name": "bob"'), ['$.data.list[1].name'])
  assert.deepEqual(ancestors(idx, '$.data.list[1].name'), ['$.data.list[1]', '$.data.list', '$.data', '$'])
})

test('高亮切片', () => {
  assert.deepEqual(splitHit('"Alice al"', 'al'), [
    ['"', false],
    ['Al', true],
    ['ice ', false],
    ['al', true],
    ['"', false],
  ])
  assert.deepEqual(splitHit('abc', ''), [['abc', false]])
})
