import test from 'node:test'
import assert from 'node:assert/strict'
import { clearPages, emptyHistory, isKnown, noteResult, parseHistory, setKnown, trendCounts, trendRank, unmarkedFails } from './history'
import type { PageRunResult } from '../types'

const r = (caseId: string, status: PageRunResult['status']): PageRunResult => ({ caseId, pageId: caseId.split('#')[0], status }) as PageRunResult

test('noteResult：第一次失败算新失败，再失败是一直失败，通过后是修好了', () => {
  let h = emptyHistory()
  let x = noteResult(r('a#patrol', 'fail'), h, 1)
  assert.equal(x.result.trend, 'new')
  h = x.history
  x = noteResult(r('a#patrol', 'fail'), h, 2)
  assert.equal(x.result.trend, 'still')
  h = x.history
  x = noteResult(r('a#patrol', 'pass'), h, 3)
  assert.equal(x.result.trend, 'fixed')
  x = noteResult(r('a#patrol', 'pass'), x.history, 4)
  assert.equal(x.result.trend, undefined)
})

test('noteResult：跳过不改记录；上次通过这次失败是新失败', () => {
  let h = noteResult(r('a#q:x', 'pass'), emptyHistory(), 1).history
  h = noteResult(r('a#q:x', 'skip'), h, 2).history
  assert.equal(h.last['a#q:x']?.status, 'pass')
  assert.equal(noteResult(r('a#q:x', 'fail'), h, 3).result.trend, 'new')
})

test('已知问题：通过一次自动取消，之后再失败算新失败', () => {
  let h = noteResult(r('a#patrol', 'fail'), emptyHistory(), 1).history
  h = setKnown(h, ['a#patrol'], true, 2)
  assert.equal(isKnown(r('a#patrol', 'fail'), h), true)
  h = noteResult(r('a#patrol', 'pass'), h, 3).history
  assert.equal(h.known['a#patrol'], undefined)
  assert.equal(noteResult(r('a#patrol', 'fail'), h, 4).result.trend, 'new')
})

test('trendRank / trendCounts：已知问题排在一直失败后面、不算新失败', () => {
  const h = setKnown(emptyHistory(), ['k#patrol'], true)
  const rows = [
    { ...r('f#patrol', 'pass'), trend: 'fixed' as const },
    { ...r('k#patrol', 'fail'), trend: 'new' as const },
    { ...r('s#patrol', 'fail'), trend: 'still' as const },
    { ...r('n#patrol', 'fail'), trend: 'new' as const },
  ]
  assert.deepEqual(
    [...rows].sort((a, b) => trendRank(a, h) - trendRank(b, h)).map((x) => x.caseId),
    ['n#patrol', 's#patrol', 'k#patrol', 'f#patrol'],
  )
  assert.deepEqual(trendCounts(rows, h), { newFail: 1, fixed: 1, known: 1 })
})

test('clearPages 只清这些页；parseHistory 坏数据当空', () => {
  let h = noteResult(r('a#patrol', 'fail'), emptyHistory(), 1).history
  h = noteResult(r('ab#patrol', 'fail'), h, 1).history
  h = setKnown(h, ['a#patrol'], true)
  const c = clearPages(h, ['a'])
  assert.deepEqual(Object.keys(c.last), ['ab#patrol'])
  assert.deepEqual(c.known, {})
  assert.deepEqual(parseHistory('{坏'), emptyHistory())
  assert.deepEqual(parseHistory(JSON.stringify(h)), h)
})

test('unmarkedFails：只算这些页上次失败、没标已知的', () => {
  // 真实的页面编号是「工程#地址」，本身带 #
  let h = noteResult(r('g#/a#patrol', 'fail'), emptyHistory(), 1).history
  h = noteResult(r('g#/a#q:x', 'fail'), h, 1).history
  h = noteResult(r('g#/a#q:y', 'pass'), h, 1).history
  h = noteResult(r('g#/ab#patrol', 'fail'), h, 1).history
  h = setKnown(h, ['g#/a#q:x'], true)
  assert.deepEqual(unmarkedFails(h, ['g#/a']), ['g#/a#patrol'])
  assert.deepEqual(unmarkedFails(h, ['g#/a', 'g#/ab']).sort(), ['g#/a#patrol', 'g#/ab#patrol'])
})
