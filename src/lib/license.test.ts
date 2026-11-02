import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { canAiContextExport, canBatchCases, canPageTest } from './license'

describe('码上测付费点：能力闸', () => {
  it('免费只留单接口冒烟，批量与 AI 上下文全锁；专业版全放', () => {
    assert.equal(canBatchCases(false), false)
    assert.equal(canBatchCases(true), true)
    assert.equal(canAiContextExport(false), false)
    assert.equal(canAiContextExport(true), true)
  })
  it('页面测试单页多页都要专业版', () => {
    assert.equal(canPageTest(false), false)
    assert.equal(canPageTest(true), true)
  })
})
