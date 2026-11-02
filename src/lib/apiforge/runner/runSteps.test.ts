import test from 'node:test'
import assert from 'node:assert/strict'
import { runSteps } from './runSteps'

test('runSteps：跑到一半时第三步进行中、第四步等待', () => {
  const s = runSteps({ done: 3, total: 10 }, true)
  assert.deepEqual(s.map((x) => x.state), ['done', 'done', 'active', 'todo'])
  assert.equal(s[2]!.detail, '已跑 3 / 10')
  assert.equal(s[1]!.detail, '已登录')
})

test('runSteps：用例跑满后进入出报告；没配登录写免登录', () => {
  const s = runSteps({ done: 10, total: 10 }, false)
  assert.deepEqual(s.map((x) => x.state), ['done', 'done', 'done', 'active'])
  assert.equal(s[1]!.detail, '免登录')
})
