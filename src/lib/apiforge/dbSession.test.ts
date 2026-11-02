import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionForConn, sessionMismatch } from './dbSession'

test('sessionForConn: 连的就是选的那条 → 可用', () => {
  const s = { kind: 'oracle', connId: 'a' }
  assert.equal(sessionForConn(s, 'a'), s)
  assert.equal(sessionMismatch(s, 'a'), false)
})

test('sessionForConn: 连的是另一条，或环境页选了「不连库」→ 按未连库', () => {
  const s = { kind: 'oracle', connId: 'a' }
  assert.equal(sessionForConn(s, 'b'), null)
  assert.equal(sessionForConn(s, ''), null)
  assert.equal(sessionForConn(s, undefined), null)
  assert.equal(sessionMismatch(s, 'b'), true)
})

test('sessionForConn: 会话没记 connId（别的页面连的）照旧可用；没连库还是 null', () => {
  const s = { kind: 'mysql' }
  assert.equal(sessionForConn(s, 'b'), s)
  assert.equal(sessionMismatch(s, 'b'), false)
  assert.equal(sessionForConn(null, 'b'), null)
})
