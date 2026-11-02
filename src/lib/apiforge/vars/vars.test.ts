import test from 'node:test'
import assert from 'node:assert/strict'
import { builtinVars, formatDate, formatTime, resolveVars } from './vars'

// ---- 内置动态变量 ----

// 本地时区构造：2026-09-29 14:30:05.123（不受 CI 时区影响）
const NOW = new Date(2026, 8, 29, 14, 30, 5, 123).getTime()

test('builtinVars：timestamp 是毫秒数字字符串，date/time 按本地时区格式化', () => {
  const v = builtinVars(NOW)
  assert.equal(v.timestamp, String(NOW))
  assert.equal(v.date, '2026-09-29')
  assert.equal(v.time, '14:30:05')
})

test('builtinVars：uuid 是 v4 形态且每次现算（两次调用互不相同）', () => {
  const a = builtinVars(NOW)
  const b = builtinVars(NOW)
  for (const u of [a.uuid!, b.uuid!]) {
    assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  }
  assert.notEqual(a.uuid, b.uuid)
  // 同一次调用的 timestamp/date/time 是同一组（整场跑批复用）
  assert.equal(a.timestamp, b.timestamp)
})

test('builtinVars：补零边界——1 月 2 日 3 点 4 分 5 秒', () => {
  const v = builtinVars(new Date(2026, 0, 2, 3, 4, 5).getTime())
  assert.equal(v.date, '2026-01-02')
  assert.equal(v.time, '03:04:05')
})

test('formatDate / formatTime：独立导出与内置变量同一口径', () => {
  assert.equal(formatDate(NOW), '2026-09-29')
  assert.equal(formatTime(NOW), '14:30:05')
})

// ---- 多层合并 ----

test('resolveVars：后面的池优先（越靠近这次请求的越可信），空白键与非字符串丢弃', () => {
  const merged = resolveVars(
    { timestamp: '1000', shopId: '66', '   ': 'x' },
    { shopId: '99' },
    { brandId: '7', bad: undefined as unknown as string },
  )
  assert.deepEqual(merged, { timestamp: '1000', shopId: '99', brandId: '7' })
})

test('resolveVars：undefined 池跳过，全空返回空表', () => {
  assert.deepEqual(resolveVars(undefined, undefined), {})
  assert.deepEqual(resolveVars(), {})
})
