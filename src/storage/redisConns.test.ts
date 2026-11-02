import test from 'node:test'
import assert from 'node:assert/strict'
import { DBCONNS_KEY } from './dbconn'
import { parseRedisConns, redisCredTarget, removeRedisConn, upsertRedisConn, REDIS_CONNS_KEY, REDIS_SAVED_LIMIT } from './redisConns'

const base = { name: '测试', host: '10.0.0.1', port: '6379', user: '', db: 0, tls: false, env: 'test' as const, kind: 'single' as const, master: '', jump: null }

test('存档里误存的密码读进来就洗掉，坏条目逐条跳过', () => {
  const raw = JSON.stringify([
    { ...base, id: 'a', password: 'secret' },
    { ...base, id: 'b', port: '六千' },
    { id: 'c', name: '', host: 'h', port: '1' },
    'junk',
  ])
  const list = parseRedisConns(raw)
  assert.equal(list.length, 1)
  assert.equal('password' in list[0]!, false)
  assert.deepEqual(parseRedisConns('{not json'), [])
})

test('老条目缺字段补默认：库 0、不加密、测试环境、单机、不走跳板机', () => {
  const [c] = parseRedisConns(JSON.stringify([{ id: 'a', name: 'x', host: 'h', port: '6379' }]))
  assert.deepEqual(c, { id: 'a', name: 'x', host: 'h', port: '6379', user: '', db: 0, tls: false, env: 'test', kind: 'single', master: '', jump: null })
})

test('哨兵 / 跳板机字段：跳板机密码也洗掉，坏的跳板机整条丢', () => {
  const raw = JSON.stringify([
    { ...base, id: 'a', kind: 'sentinel', master: ' mymaster ', jump: { host: 'j', port: 22, user: 'ops', password: 'x' } },
    { ...base, id: 'b', kind: 'raft' },
    { ...base, id: 'c', jump: { host: 'j', port: '22', user: 'ops' } },
  ])
  const list = parseRedisConns(raw)
  assert.equal(list.length, 1)
  assert.equal(list[0]!.master, 'mymaster')
  assert.deepEqual(list[0]!.jump, { host: 'j', port: 22, user: 'ops' })
  // 同一地址单机和哨兵是两条不同的连接
  const two = upsertRedisConn(upsertRedisConn([], { ...base }), { ...base, kind: 'sentinel', master: 'm' })
  assert.equal(two.length, 2)
})

test('同地址只记一笔，新的排最前，超上限裁尾部', () => {
  let list = upsertRedisConn([], { ...base, id: 'a' })
  list = upsertRedisConn(list, { ...base, name: '改名' })
  assert.equal(list.length, 1)
  assert.equal(list[0]!.name, '改名')
  for (let i = 0; i < REDIS_SAVED_LIMIT + 3; i++) list = upsertRedisConn(list, { ...base, host: `h${i}` })
  assert.equal(list.length, REDIS_SAVED_LIMIT)
  assert.equal(list[0]!.host, `h${REDIS_SAVED_LIMIT + 2}`)
  assert.equal(removeRedisConn(list, list[0]!.id).length, REDIS_SAVED_LIMIT - 1)
})

test('凭据键不含库号，跟数据库的凭据键不会撞', () => {
  assert.equal(redisCredTarget({ host: ' h ', port: '6379', user: 'a|b' }), 'redis|h|6379|a_b')
  assert.notEqual(REDIS_CONNS_KEY, DBCONNS_KEY)
})
