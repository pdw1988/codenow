/**
 * 方言登记表的回归：壳靠 isLive 决定 Seg 能不能点。
 * 新方言接入后 live 数量会变，改这条断言即可，不要改 DbConnect。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dbKindOf, DEFAULT_DB_KIND, dialectEntry, isLiveDbKind, liveDialect, liveDialects } from './dbDialect'

test('缺省连库方言是登记表里第一个已接通的（Oracle）', () => {
  assert.equal(DEFAULT_DB_KIND, 'oracle')
  assert.equal(liveDialect('oracle')?.id, 'oracle')
  assert.ok(liveDialects().some((d) => d.id === 'oracle'))
})

test('MySQL 已接通：默认端口 3306，壳不用写 if (kind === mysql)', () => {
  const e = dialectEntry('mysql')
  assert.equal(isLiveDbKind(e), true)
  assert.equal(liveDialect('mysql')?.defaultPort, '3306')
  assert.equal(liveDialect('mysql')?.dbLabel, '数据库名')
  assert.ok(liveDialect('mysql')?.catalogHint)
  assert.ok(liveDialect('oracle')?.catalogHint)
})

test('PostgreSQL 已接通：默认端口 5432，壳不用写 if (kind === postgresql)', () => {
  const e = dialectEntry('postgresql')
  assert.equal(isLiveDbKind(e), true)
  assert.equal(liveDialect('postgresql')?.defaultPort, '5432')
  assert.equal(liveDialect('postgresql')?.dbLabel, '数据库名')
  assert.ok(liveDialect('postgresql')?.catalogHint)
})

test('已接通方言都有 deleteRows / updateRows / insertRows / execSql / execDdl，壳不用写 if (kind)', () => {
  for (const d of liveDialects()) {
    assert.equal(typeof d.deleteRows, 'function')
    assert.equal(typeof d.updateRows, 'function')
    assert.equal(typeof d.insertRows, 'function')
    assert.equal(typeof d.execSql, 'function')
    assert.equal(typeof d.execDdl, 'function')
  }
})

test('老历史没有 kind 按 oracle 认', () => {
  assert.equal(dbKindOf(undefined), 'oracle')
  assert.equal(dbKindOf('mysql'), 'mysql')
})
