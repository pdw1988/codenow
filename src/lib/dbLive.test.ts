import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addrKey, type DbConn } from '../types/dbconn'
import { pickConnBlocked, sessionAddr } from './dbLive'

const conn = (over: Partial<DbConn> = {}): DbConn => ({
  host: '10.0.0.8',
  port: '3306',
  user: 'root',
  db: 'mall',
  kind: 'mysql',
  ...over,
})

test('addrKey：同地址不同类型是两把钥匙；trim 之后相同', () => {
  assert.equal(
    addrKey(conn()),
    addrKey({ ...conn(), host: ' 10.0.0.8 ', port: ' 3306' }),
  )
  assert.notEqual(addrKey(conn({ kind: 'mysql' })), addrKey(conn({ kind: 'oracle', port: '1521' })))
})

test('sessionAddr：同一个库不管大小写和空格都是同一串，换库就不同', () => {
  assert.equal(sessionAddr(conn()), sessionAddr({ ...conn(), host: ' 10.0.0.8 ', user: 'ROOT' }))
  assert.notEqual(sessionAddr(conn()), sessionAddr(conn({ db: 'mall_prod' })))
})

test('方言对不上就挡住，对上才放行', () => {
  assert.equal(pickConnBlocked('mysql', conn({ kind: 'mysql' })), null)
  const msg = pickConnBlocked('oracle', conn({ kind: 'mysql' }))
  assert.match(msg ?? '', /Oracle/)
  assert.match(msg ?? '', /MySQL/)
  assert.match(msg ?? '', /改成/)
})
