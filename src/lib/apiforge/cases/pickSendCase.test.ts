import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pickSendCase } from './pickSendCase'
import type { TestCase } from '../types'

const c = (id: string, type: string, enabled: boolean): TestCase =>
  ({ id, type, enabled, name: id, parameters: {} }) as unknown as TestCase

test('pickSendCase：优先启用的正常用例', () => {
  const list = [c('b1', 'boundary', true), c('n1', 'normal', false), c('n2', 'normal', true)]
  assert.equal(pickSendCase(list)?.id, 'n2')
})

test('pickSendCase：正常用例全禁用时仍取正常用例，不落到边界用例', () => {
  const list = [c('b1', 'boundary', true), c('n1', 'normal', false)]
  assert.equal(pickSendCase(list)?.id, 'n1')
})

test('pickSendCase：没有正常用例取第一条，空列表返回 undefined', () => {
  assert.equal(pickSendCase([c('e1', 'error', true)])?.id, 'e1')
  assert.equal(pickSendCase([]), undefined)
})
