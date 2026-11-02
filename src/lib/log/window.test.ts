import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inputFromWindow, padWindow, windowFromInput } from './window'

test('windowFromInput：标准 datetime-local 值按本地时区转毫秒', () => {
  const ts = windowFromInput('2026-10-02T14:32:05')
  const d = new Date(ts!)
  assert.equal(d.getFullYear(), 2026)
  assert.equal(d.getMonth(), 9)
  assert.equal(d.getDate(), 2)
  assert.equal(d.getHours(), 14)
  assert.equal(d.getMinutes(), 32)
  assert.equal(d.getSeconds(), 5)
})

test('windowFromInput：无秒也收，空串和残缺给 null（输入框打到一半不报错）', () => {
  assert.ok(windowFromInput('2026-10-02T14:32') !== null)
  assert.equal(windowFromInput(''), null)
  assert.equal(windowFromInput('2026-10-02'), null)
  assert.equal(windowFromInput('2026-10-02T14:'), null)
  assert.equal(windowFromInput('abc'), null)
})

test('windowFromInput：2 月 30 日这类不存在的一天给 null，不静默进位', () => {
  assert.equal(windowFromInput('2026-02-30T10:00'), null)
})

test('inputFromWindow：与 windowFromInput 互逆，null 给空串', () => {
  const ts = windowFromInput('2026-10-02T08:05:09')!
  assert.equal(inputFromWindow(ts), '2026-10-02T08:05:09')
  assert.equal(inputFromWindow(null), '')
})

test('padWindow：两端各垫余量，跑批起止都被包进窗里', () => {
  const w = padWindow(1_000_000, 2_000_000, 60_000, 9_000_000)
  assert.equal(w.since, 940_000)
  assert.equal(w.until, 2_060_000)
})

test('padWindow：until 没收口按 now 收，两端大小颠倒也能摆正', () => {
  assert.deepEqual(padWindow(1_000_000, null, 30_000, 1_500_000), { since: 970_000, until: 1_530_000 })
  assert.deepEqual(padWindow(2_000_000, 1_000_000, 10_000, 2_000_000), { since: 990_000, until: 2_010_000 })
})
