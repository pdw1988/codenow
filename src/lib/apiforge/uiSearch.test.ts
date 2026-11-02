import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capRows, hitParts, normalizeApiQuery, pathMatches } from './uiSearch'

test('normalizeApiQuery：完整地址只留路径，去掉查询串；普通词原样转小写', () => {
  assert.equal(normalizeApiQuery(' http://10.1.2.3:8080/shop/Apply/list?id=1#x '), '/shop/apply/list')
  assert.equal(normalizeApiQuery('https://a.com'), '')
  assert.equal(normalizeApiQuery('/user/get?id=2'), '/user/get')
  assert.equal(normalizeApiQuery('ApplyController'), 'applycontroller')
  assert.equal(normalizeApiQuery('保存?'), '保存?')
})

test('pathMatches：包含即中；带上下文路径、带 {id} 占位的完整路径也能中', () => {
  assert.equal(pathMatches('/apply/list', 'list'), true)
  assert.equal(pathMatches('/apply/list', '/shop/apply/list'), true)
  assert.equal(pathMatches('/apply/{id}/detail', '/shop/apply/42/detail'), true)
  assert.equal(pathMatches('/apply/{id}', '/shop/apply/42/'), true)
  assert.equal(pathMatches('/apply/list', '/shop/apply/listall'), false)
  assert.equal(pathMatches('/apply/{id}', '/shop/apply/42/detail'), false)
  assert.equal(pathMatches('/a.b', '/x/a.b'), true)
  assert.equal(pathMatches('/a.b', '/x/axb'), false)
  assert.equal(pathMatches('/apply/list', ''), false)
})

test('hitParts：空查询 / 空文本给整段不命中', () => {
  assert.deepEqual(hitParts('/api/zoo', ''), [{ text: '/api/zoo', hit: false }])
  assert.deepEqual(hitParts('', 'x'), [{ text: '', hit: false }])
})

test('hitParts：不区分大小写、多命中、首尾都命中', () => {
  assert.deepEqual(hitParts('/Api/zoO/api', 'api'), [
    { text: '/', hit: false },
    { text: 'Api', hit: true },
    { text: '/zoO/', hit: false },
    { text: 'api', hit: true },
  ])
  // 空格查询词（"detail list"）就当字面量找，切不出片段就算不命中
  assert.deepEqual(hitParts('/api/list', 'zz'), [{ text: '/api/list', hit: false }])
})

test('hitParts：正则元字符当字面量（a(b|c)* 不炸）', () => {
  assert.deepEqual(hitParts('x(a)*y', '(a)*'), [
    { text: 'x', hit: false },
    { text: '(a)*', hit: true },
    { text: 'y', hit: false },
  ])
  assert.deepEqual(hitParts('a.b', '.'), [
    { text: 'a', hit: false },
    { text: '.', hit: true },
    { text: 'b', hit: false },
  ])
})

test('hitParts：中文命中且相邻命中合并不重叠', () => {
  assert.deepEqual(hitParts('品牌商申请明细', '明细'), [
    { text: '品牌商申请', hit: false },
    { text: '明细', hit: true },
  ])
  assert.deepEqual(hitParts('aaaa', 'aa'), [
    { text: 'aa', hit: true },
    { text: 'aa', hit: true },
  ])
})

test('capRows：预算内原样、超出截断报数、预算打光给空', () => {
  const rows = [1, 2, 3, 4, 5]
  assert.deepEqual(capRows(rows, 5), { shown: [1, 2, 3, 4, 5], omitted: 0 })
  assert.deepEqual(capRows(rows, 3), { shown: [1, 2, 3], omitted: 2 })
  assert.deepEqual(capRows(rows, 0), { shown: [], omitted: 5 })
  assert.deepEqual(capRows([], 10), { shown: [], omitted: 0 })
})
