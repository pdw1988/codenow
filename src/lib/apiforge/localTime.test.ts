import test from 'node:test'
import assert from 'node:assert/strict'
import { fmtLocal } from './localTime'

test('fmtLocal: UTC 时间转成本地 MM-DD HH:mm', () => {
  // 按本地时区造一个时刻再转 ISO（带 Z），结果应还原成本地的月日时分，不受跑测试的机器时区影响
  const local = new Date(2026, 9, 13, 10, 30, 45)
  assert.equal(fmtLocal(local.toISOString()), '10-13 10:30')
})

test('fmtLocal: 个位数补零', () => {
  const local = new Date(2026, 0, 5, 8, 4)
  assert.equal(fmtLocal(local.toISOString()), '01-05 08:04')
})

test('fmtLocal: 空值和解析不了的串不抛错', () => {
  assert.equal(fmtLocal(''), '')
  assert.equal(fmtLocal(undefined), '')
  assert.equal(fmtLocal('not-a-date-xyz'), '-date-xyz')
})
