import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_ENVELOPE_EXPECTS, isEnvelopeFail, judgeCase } from './judge'

const FAIL = '{"msg":"品牌商不能为空","code":"500","level":"error"}'

test('默认信封检查：SHOP 成功 code=200 算过，500/501/level=error 算业务失败', () => {
  const ex = [...DEFAULT_ENVELOPE_EXPECTS]
  assert.equal(judgeCase([200], ex, 200, undefined, '{"msg":"操作成功","code":"200","data":1}').ok, true)
  assert.equal(judgeCase([200], ex, 200, undefined, '{"code":"501","msg":"x"}').ok, false)
  // 自定义的 498/499 不算失败
  assert.equal(judgeCase([200], ex, 200, undefined, '{"code":"499","msg":"已找到"}').ok, true)
  // 没有信封字段的响应不误判
  assert.equal(judgeCase([200], ex, 200, undefined, '[1,2]').ok, true)
  assert.equal(judgeCase([200], ex, 200, undefined, '{"code":200}').ok, true)
})

test('默认信封检查：失败原因直接写后端 msg，三条同时命中只报一次', () => {
  const j = judgeCase([200], [...DEFAULT_ENVELOPE_EXPECTS], 200, undefined, FAIL)
  assert.equal(j.ok, false)
  assert.deepEqual(j.assertFails, ['接口返回业务失败：品牌商不能为空'])
  // 没有 msg 时写字段和值
  const n = judgeCase([200], [...DEFAULT_ENVELOPE_EXPECTS], 200, undefined, '{"level":"error"}')
  assert.deepEqual(n.assertFails, ['接口返回业务失败：$.level = error'])
})

test('isEnvelopeFail：只认信封失败', () => {
  assert.equal(isEnvelopeFail(FAIL), true)
  assert.equal(isEnvelopeFail('{"code":"200"}'), false)
  assert.equal(isEnvelopeFail('{}'), false)
})
