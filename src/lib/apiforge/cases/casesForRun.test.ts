import test from 'node:test'
import assert from 'node:assert/strict'
import { casesForRun } from './casesForRun'
import type { TestCase } from '../types'

const tc = (id: string, enabled: boolean): TestCase =>
  ({ id, name: id, type: 'normal', parameters: {}, expectedHttpStatus: [200], expectedDbChange: null, enabled }) as unknown as TestCase

test('casesForRun：存过的只取启用的，不重新生成', () => {
  let called = 0
  const out = casesForRun([tc('a', true), tc('b', false)], () => {
    called++
    return []
  })
  assert.deepEqual(out.cases.map((c) => c.id), ['a'])
  assert.equal(out.generated, null)
  assert.equal(out.allDisabled, false)
  assert.equal(called, 0)
})

test('casesForRun：全部禁用不重新生成，标 allDisabled', () => {
  let called = 0
  const out = casesForRun([tc('a', false)], () => {
    called++
    return [tc('x', true)]
  })
  assert.deepEqual(out.cases, [])
  assert.equal(out.generated, null)
  assert.equal(out.allDisabled, true)
  assert.equal(called, 0)
})

test('casesForRun：没存过才生成，调用方要存盘', () => {
  const out = casesForRun(undefined, () => [tc('x', true), tc('y', false)])
  assert.deepEqual(out.cases.map((c) => c.id), ['x'])
  assert.deepEqual(out.generated?.map((c) => c.id), ['x', 'y'])
  assert.equal(casesForRun([], () => [tc('z', true)]).generated?.length, 1)
})
