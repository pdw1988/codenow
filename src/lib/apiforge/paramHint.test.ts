import test from 'node:test'
import assert from 'node:assert/strict'
import { paramHint } from './paramHint'

test('paramHint：扫描到的说明优先', () => {
  assert.equal(paramHint({ name: 'keyword', description: '自定义说明' }), '自定义说明')
})

test('paramHint：旧缓存没说明时按常见名兜底', () => {
  assert.match(paramHint({ name: 'keyword' }), /关键字/)
  assert.match(paramHint({ name: 'flowStatus' }), /流程状态/)
  assert.match(paramHint({ name: 'createBy' }), /发起人/)
  assert.match(paramHint({ name: 'pageNum' }), /页码/)
  assert.match(paramHint({ name: 'pageSize' }), /每页/)
})

test('paramHint：认不出的名字给空串，不瞎猜', () => {
  assert.equal(paramHint({ name: 'fooBar' }), '')
})
