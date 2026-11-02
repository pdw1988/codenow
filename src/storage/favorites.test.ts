/**
 * 收藏 blob 读写的回归（storage/templates.test.ts 同款分工）。
 * blob 是本应用自己写的，这里钉的是「损坏数据宁可丢一条不让整个列表崩」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FAVORITE_LIMIT, type FavoriteSql } from '../types/favorite'
import { parseFavorites, upsertFavorite, FAVORITES_KEY } from './favorites'

const fav = (over: Partial<FavoriteSql> = {}): FavoriteSql => ({
  id: 'f1',
  name: '查询订单',
  sql: 'SELECT 1',
  tables: [],
  tags: [],
  remark: '',
  createdAt: '2026-08-01 10:00',
  lastUsedAt: '2026-08-20 10:00',
  useCount: 0,
  ...over,
})

test('parseFavorites: 空值和非法 JSON 都返回空列表', () => {
  assert.deepEqual(parseFavorites(null), [])
  assert.deepEqual(parseFavorites(''), [])
  assert.deepEqual(parseFavorites('{oops'), [])
})

test('parseFavorites: 顶层不是数组、坏记录逐条跳过，好的留下', () => {
  assert.deepEqual(parseFavorites('"just a string"'), [])
  const raw = JSON.stringify([
    fav(),
    { id: 'bad' }, // 缺一大半字段
    fav({ id: 'no-name', name: '' }), // 必填项空白
    fav({ id: 'ok2' }),
  ])
  const list = parseFavorites(raw)
  assert.deepEqual(
    list.map((x) => x.id),
    ['f1', 'ok2'],
  )
})

test('parseFavorites: 旧收藏（没有 conn 字段）仍能读回——conn 是后加的，写成必填就把存档静默清空了', () => {
  const raw = JSON.stringify([fav({ id: 'legacy' })])
  const list = parseFavorites(raw)
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'legacy')
  assert.equal(list[0].conn, undefined)
})

test('parseFavorites: conn 存着且合格就原样读回', () => {
  const conn = { kind: 'mysql', host: '10.0.0.9', port: '3306', user: 'shop', db: 'shop' }
  const list = parseFavorites(JSON.stringify([{ ...fav(), conn }]))
  assert.deepEqual(list[0].conn, conn)
})

test('parseFavorites: conn 格式坏时只抹 conn、不丢整条——可选辅助字段不配搭掉手写的 SQL', () => {
  const raw = JSON.stringify([
    { ...fav({ id: 'bad-kind' }), conn: { kind: 'db2', host: 'h', port: '1', user: 'u', db: 'd' } },
    { ...fav({ id: 'half' }), conn: { host: 'h' } },
    { ...fav({ id: 'not-obj' }), conn: 'mysql://x' },
  ])
  const list = parseFavorites(raw)
  assert.deepEqual(
    list.map((x) => x.id),
    ['bad-kind', 'half', 'not-obj'],
    '三条都要保住',
  )
  for (const it of list) assert.equal(it.conn, undefined)
})

test('FAVORITES_KEY 与模板/草稿的键互不相同——清空缓存的白名单靠它区分', () => {
  assert.notEqual(FAVORITES_KEY, 'templates')
  assert.notEqual(FAVORITES_KEY, 'configDrafts')
})

test('upsertFavorite: 同 id 覆盖而不是追加，新的排前面，超上限裁掉尾部', () => {
  const list = [fav({ id: 'a' }), fav({ id: 'b' })]
  const next = upsertFavorite(list, fav({ id: 'a', name: '改名' }))
  assert.deepEqual(
    next.map((x) => x.id),
    ['a', 'b'],
  )
  assert.equal(next.find((x) => x.id === 'a')!.name, '改名')

  const many = Array.from({ length: FAVORITE_LIMIT }, (_, i) => fav({ id: `x${i}` }))
  const kept = upsertFavorite(many, fav({ id: 'new' }))
  assert.equal(kept.length, FAVORITE_LIMIT)
  assert.equal(kept[0].id, 'new')
  assert.equal(kept.at(-1)!.id, `x${FAVORITE_LIMIT - 2}`) // 最旧的被裁掉
})
