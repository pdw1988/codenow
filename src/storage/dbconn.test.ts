/**
 * 连接历史 blob 读写的回归。这里钉两条硬规则：
 * 密码字段就算混进存档也要在读入时洗掉；同地址只留一条且提到最前。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canPersistPass, credTarget, DB_CONN_LIMIT, DB_SAVED_LIMIT, type DbConn } from '../types/dbconn'
import {
  DBCONNS_KEY,
  namedConns,
  parseDbConns,
  removeDbConn,
  touchDbConn,
  upsertDbConn,
  upsertSavedDbConn,
} from './dbconn'

const conn = (over: Partial<DbConn> = {}): DbConn => ({
  host: 'localhost',
  port: '3306',
  user: 'root',
  db: 'test_db',
  ...over,
})

test('parseDbConns: 空值、坏 JSON、非数组都返回空列表，坏条目逐条跳过', () => {
  assert.deepEqual(parseDbConns(null), [])
  assert.deepEqual(parseDbConns(''), [])
  assert.deepEqual(parseDbConns('{oops'), [])
  assert.deepEqual(parseDbConns('"a string"'), [])
  const list = parseDbConns(JSON.stringify([conn(), { host: '缺一半' }, 42]))
  assert.equal(list.length, 1)
})

test('读档时把空白和多余字段洗掉——万一哪天误存过密码，读进来就没了', () => {
  const raw = JSON.stringify([
    { host: ' 10.0.0.8 ', port: ' 3306', user: 'root ', db: ' mall ', password: 'leaked' },
  ])
  const list = parseDbConns(raw)
  assert.deepEqual(list.map((c) => ({ host: c.host, port: c.port, user: c.user, db: c.db })), [
    { host: '10.0.0.8', port: '3306', user: 'root', db: 'mall' },
  ])
  assert.ok(list[0]!.id, '缺 id 的老记录载入时补一个（连接下拉的 key/value 靠它唯一）')
})

test('读档保留名称和环境，密码仍然洗掉', () => {
  const raw = JSON.stringify([
    {
      host: '10.0.1.8',
      port: '1521',
      user: 'SCOTT',
      db: 'ORCL',
      kind: 'oracle',
      id: 'c1',
      name: ' 测试 ORCL ',
      env: 'test',
      remark: '11g',
      password: 'leaked',
    },
  ])
  assert.deepEqual(parseDbConns(raw), [
    {
      host: '10.0.1.8',
      port: '1521',
      user: 'SCOTT',
      db: 'ORCL',
      kind: 'oracle',
      id: 'c1',
      name: '测试 ORCL',
      env: 'test',
      remark: '11g',
    },
  ])
})

test('读档保留 kind；没有 kind 的老记录仍能过（按 oracle 认）', () => {
  const withKind = parseDbConns(
    JSON.stringify([{ host: 'h', port: '1521', user: 'u', db: 'ORCL', kind: 'oracle' }]),
  )
  assert.equal(withKind[0]?.kind, 'oracle')
  const legacy = parseDbConns(JSON.stringify([{ host: 'h', port: '1521', user: 'u', db: 'ORCL' }]))
  assert.equal(legacy[0]?.kind, undefined)
})

test('同地址不同 kind 是两笔历史', () => {
  const ora = conn({ port: '1521', kind: 'oracle' })
  const my = conn({ port: '1521', kind: 'mysql' })
  const next = upsertDbConn([ora], my)
  assert.equal(next.length, 2)
})

test('DBCONNS_KEY 与模板/草稿/收藏/优化记录的键互不相同——清空缓存的白名单靠它区分', () => {
  for (const other of ['templates', 'configDrafts', 'favoriteSql', 'sqlAdviseLog']) {
    assert.notEqual(DBCONNS_KEY, other)
  }
})

test('upsertDbConn: 同地址提到最前而不是重复记一笔，超上限裁尾部，不改入参', () => {
  const a = conn({ host: 'a' })
  const b = conn({ host: 'b' })
  const next = upsertDbConn([a, b], conn({ host: 'a', db: 'test_db' }))
  assert.deepEqual(next.map((c) => c.host), ['a', 'b'])

  const many: DbConn[] = Array.from({ length: DB_CONN_LIMIT }, (_, i) => conn({ host: `h${i}` }))
  const kept = upsertDbConn(many, conn({ host: 'new' }))
  assert.equal(kept.length, DB_CONN_LIMIT)
  assert.equal(kept[0].host, 'new')
  assert.equal(kept.at(-1)!.host, `h${DB_CONN_LIMIT - 2}`) // 最旧的被裁掉
})

test('touchDbConn: 同地址的我的连接保住名字，只挪到前面', () => {
  const saved: DbConn = {
    id: 'c1',
    name: '测试 ORCL',
    env: 'test',
    host: '10.0.1.8',
    port: '1521',
    user: 'SCOTT',
    db: 'ORCL',
    kind: 'oracle',
  }
  const next = touchDbConn([saved], {
    host: '10.0.1.8',
    port: '1521',
    user: 'SCOTT',
    db: 'ORCL',
    kind: 'oracle',
  })
  assert.equal(next.length, 1)
  assert.equal(next[0]?.name, '测试 ORCL')
  assert.equal(next[0]?.id, 'c1')
})

test('upsertSavedDbConn: 按 id 改，没有 id 新建；超上限裁有名字的', () => {
  const a = upsertSavedDbConn([], conn({ name: '本地', host: 'a' }))
  assert.equal(namedConns(a).length, 1)
  assert.ok(a[0]?.id)
  const edited = upsertSavedDbConn(a, { ...a[0]!, name: '本地改名' })
  assert.equal(edited.length, 1)
  assert.equal(edited[0]?.name, '本地改名')
  assert.equal(edited[0]?.id, a[0]?.id)

  let many: DbConn[] = []
  for (let i = 0; i < DB_SAVED_LIMIT; i++) {
    many = upsertSavedDbConn(many, conn({ name: `n${i}`, host: `h${i}` }))
  }
  const overflow = upsertSavedDbConn(many, conn({ name: 'new', host: 'new' }))
  assert.equal(namedConns(overflow).length, DB_SAVED_LIMIT)
  assert.equal(overflow[0]?.name, 'new')
})

test('upsertSavedDbConn: 同地址的无名最近记录并进有名字的那条', () => {
  const recent = conn({ host: '10.0.1.8', port: '1521', user: 'SCOTT', db: 'ORCL', kind: 'oracle' })
  const next = upsertSavedDbConn([recent], {
    ...recent,
    name: '测试 ORCL',
    env: 'test',
  })
  assert.equal(next.length, 1)
  assert.equal(next[0]?.name, '测试 ORCL')
  assert.ok(next[0]?.id)
})

test('生产连接不准写系统凭据', () => {
  assert.equal(canPersistPass('prod'), false)
  assert.equal(canPersistPass('test'), true)
  assert.equal(canPersistPass('local'), true)
  assert.equal(canPersistPass(undefined), true)
})

test('凭据键不含控制字符，同地址稳定', () => {
  const a = credTarget({ kind: 'oracle', host: '10.0.1.8', port: '1521', user: 'SCOTT', db: 'ORCL' })
  assert.equal(a, 'oracle|10.0.1.8|1521|SCOTT|ORCL')
  assert.ok(!a.includes('\0'))
  const b = credTarget({ kind: 'oracle', host: '10.0.1.8', port: '1521', user: 'SCOTT', db: 'ORCL' })
  assert.equal(a, b)
})

test('removeDbConn: 按 id 删，不影响没 id 的最近记录', () => {
  const list: DbConn[] = [
    { id: 'c1', name: 'A', host: 'a', port: '1521', user: 'u', db: 'd' },
    conn({ host: 'recent' }),
  ]
  const next = removeDbConn(list, 'c1')
  assert.equal(next.length, 1)
  assert.equal(next[0]?.host, 'recent')
})

test('老存档没有 id：载入逐条补齐且互不相同——连接下拉的 key 不再撞空串', () => {
  const list = parseDbConns(
    JSON.stringify([
      { host: 'a', port: '1521', user: 'u', db: 'd' },
      { host: 'b', port: '3306', user: 'u', db: 'd' },
    ]),
  )
  assert.ok(list[0]!.id && list[1]!.id)
  assert.notEqual(list[0]!.id, list[1]!.id)
})

test('touchDbConn: 连库入口的 addr 不带 id，入列时现补一个；同地址重连保住这个 id', () => {
  // lib/dbLive 的连库地址就是这个形状：四项地址 + kind，没有 id
  const addr = { kind: 'oracle' as const, host: '10.0.0.1', port: '1521', user: 'SCOTT', db: 'ORCLPDB1' }
  const first = touchDbConn([], addr)
  assert.ok(first[0]!.id, '没 id 的连接入列时补 id，环境页下拉不再出现两个空 option')
  const again = touchDbConn(first, addr)
  assert.equal(again.length, 1)
  assert.equal(again[0]!.id, first[0]!.id, '同地址重连走 hit 分支，id 不换')
})
