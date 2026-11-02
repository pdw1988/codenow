import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capLongLines, MAX_LINE_CHARS, sliceToLines } from './logIpc'

test('超长行截到上限并标明原长，正常行不动', () => {
  const long = 'x'.repeat(3 * 1024 * 1024)
  const out = capLongLines(['short', long])
  assert.equal(out[0], 'short')
  assert.ok(out[1]!.startsWith('x'.repeat(MAX_LINE_CHARS)))
  assert.ok(out[1]!.length < MAX_LINE_CHARS + 100)
  assert.match(out[1]!, /3\.0 M/)
})

test('服务器上截过的行：行尾标记换成中文说明', () => {
  const out = capLongLines([`abc\u0001CUT${10 * 1024 * 1024}`, 'x\u0001CUTy'])
  assert.equal(out[0], 'abc ……（这一行太长，共 10.0 MB，只显示前 60K）')
  assert.equal(out[1], 'x\u0001CUTy')
})

test('sliceToLines 也截超长行', () => {
  const bytes = new TextEncoder().encode(`a\n${'y'.repeat(MAX_LINE_CHARS + 1)}\nb\n`)
  const lines = sliceToLines(bytes, 'utf-8')
  assert.equal(lines.length, 3)
  assert.ok(lines[1]!.length < MAX_LINE_CHARS + 100)
  assert.equal(lines[2], 'b')
})
