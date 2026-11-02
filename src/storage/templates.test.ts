/**
 * 模板存储的回归测试。
 *
 * 这层的价值不在「能存能取」，而在「坏数据不会把整个列表搞没」——模板存的是
 * 一个 JSON blob，可能来自旧版本、可能被手改过。所以测试重点是各种畸形输入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTemplates, upsertTemplate } from './templates'
import { isSqlTemplate, TEMPLATE_LIMIT, type SqlTemplate } from '../types/template'

function make(over: Partial<SqlTemplate> = {}): SqlTemplate {
  return {
    id: 't1',
    name: '用户订单查询',
    tags: ['电商'],
    mainTable: 'order',
    mode: 'multi',
    dialect: 'mysql',
    kinds: ['select'],
    columns: null,
    links: [{ key: 'order.user_id->user.id', joinType: 'LEFT', enabled: true }],
    withHeader: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

test('parseTemplates: 空值和非法 JSON 都返回空列表', () => {
  assert.deepEqual(parseTemplates(null), [])
  assert.deepEqual(parseTemplates(''), [])
  assert.deepEqual(parseTemplates('{ 这不是 json'), [])
  // 顶层不是数组也不能崩
  assert.deepEqual(parseTemplates('{"a":1}'), [])
  assert.deepEqual(parseTemplates('"字符串"'), [])
})

test('parseTemplates: 坏记录逐条跳过，好的留下', () => {
  const raw = JSON.stringify([
    make({ id: 'good1' }),
    null,
    'not an object',
    { id: 'missing-everything-else' },
    make({ id: 'good2', mode: 'nonsense' as SqlTemplate['mode'] }), // mode 非法 → 丢掉
    make({ id: 'good3', kinds: 'insert' as unknown as SqlTemplate['kinds'] }), // kinds 不是数组 → 丢掉
    make({ id: 'good4' }),
  ])
  const list = parseTemplates(raw)
  assert.deepEqual(
    list.map((t) => t.id).sort(),
    ['good1', 'good4'],
    '只有两条完全合法的记录该活下来',
  )
})

test('parseTemplates: 按 updatedAt 倒序，最近改的排最前', () => {
  const raw = JSON.stringify([
    make({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }),
    make({ id: 'new', updatedAt: '2026-08-01T00:00:00.000Z' }),
    make({ id: 'mid', updatedAt: '2026-05-01T00:00:00.000Z' }),
  ])
  assert.deepEqual(
    parseTemplates(raw).map((t) => t.id),
    ['new', 'mid', 'old'],
  )
})

test('isSqlTemplate: columns 允许 null 但不允许别的假值', () => {
  assert.ok(isSqlTemplate(make({ columns: null })))
  assert.ok(isSqlTemplate(make({ columns: ['id', 'name'] })))
  assert.ok(!isSqlTemplate(make({ columns: undefined as unknown as null })))
  assert.ok(!isSqlTemplate(make({ tags: undefined as unknown as string[] })))
  assert.ok(!isSqlTemplate(null))
  assert.ok(!isSqlTemplate([]))
  // 旧模板若存了 sqlite：产品已重新开放，应能套用
  assert.ok(isSqlTemplate(make({ dialect: 'sqlite' })))
})

test('upsertTemplate: 同 id 覆盖而不是追加，并提到最前', () => {
  const list = [make({ id: 'a' }), make({ id: 'b' }), make({ id: 'c' })]
  const next = upsertTemplate(list, make({ id: 'b', name: '改过的名字' }))
  assert.equal(next.length, 3, '覆盖不该增加条数')
  assert.equal(next[0].id, 'b')
  assert.equal(next[0].name, '改过的名字')
  assert.deepEqual(
    next.map((t) => t.id),
    ['b', 'a', 'c'],
  )
})

test('upsertTemplate: 不改入参', () => {
  const list = [make({ id: 'a' })]
  const snapshot = JSON.stringify(list)
  upsertTemplate(list, make({ id: 'z' }))
  assert.equal(JSON.stringify(list), snapshot)
})

test('upsertTemplate: 超上限时裁掉最旧的，新的一定保住', () => {
  const list = Array.from({ length: TEMPLATE_LIMIT }, (_, i) => make({ id: `t${i}` }))
  const next = upsertTemplate(list, make({ id: 'brand-new' }))
  assert.equal(next.length, TEMPLATE_LIMIT)
  assert.equal(next[0].id, 'brand-new', '新存的排最前，不该被裁掉')
  assert.ok(
    !next.some((t) => t.id === `t${TEMPLATE_LIMIT - 1}`),
    '被裁掉的应该是列表末尾那条',
  )
})
