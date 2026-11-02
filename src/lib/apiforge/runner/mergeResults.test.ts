import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeResults } from './mergeResults'
import type { CaseRunResult } from '../types'

const r = (caseId: string, ok: boolean): CaseRunResult =>
  ({ caseId, apiId: `api-${caseId}`, ok }) as unknown as CaseRunResult

test('mergeResults：同 caseId 替换并移到最后，其余保持原顺序', () => {
  const prev = [r('a', false), r('b', true), r('c', false)]
  const out = mergeResults(prev, [r('a', true)])
  assert.deepEqual(out.map((x) => [x.caseId, x.ok]), [['b', true], ['c', false], ['a', true]])
})

test('mergeResults：新 caseId 追加，空的新结果原样返回', () => {
  const prev = [r('a', true)]
  assert.deepEqual(mergeResults(prev, [r('z', false)]).map((x) => x.caseId), ['a', 'z'])
  assert.equal(mergeResults(prev, []), prev)
})

test('mergeResults：不改入参', () => {
  const prev = [r('a', false)]
  mergeResults(prev, [r('a', true)])
  assert.equal(prev.length, 1)
  assert.equal(prev[0]!.ok, false)
})
