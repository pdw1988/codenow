import test from 'node:test'
import assert from 'node:assert/strict'
import { caseOk, judgeCase } from './judge'
import type { BodyExpect } from '../types'

test('caseOk：期望命中算过，没命中算失败', () => {
  assert.equal(caseOk([200, 201], 200, undefined), true)
  assert.equal(caseOk([200, 201], 201, undefined), true)
  assert.equal(caseOk([200, 201], 500, undefined), false)
})

test('caseOk：空期望 = 不校验，200 必须算过（原来 [].includes(200) 恒 false，一律假失败）', () => {
  assert.equal(caseOk([], 200, undefined), true)
})

test('caseOk：空期望下 4xx/5xx 也放行——「不校验」就是不看状态码', () => {
  assert.equal(caseOk([], 400, undefined), true)
  assert.equal(caseOk([], 500, undefined), true)
})

test('caseOk：发不出去不能被「不校验」放行（连通性跟状态码是两回事）', () => {
  assert.equal(caseOk([], null, undefined), false)
  assert.equal(caseOk([], 200, 'ECONNREFUSED'), false)
  assert.equal(caseOk([200], 200, 'timeout'), false)
})

// ---- judgeCase：响应体断言 ----

const be = (path: string, op: BodyExpect['op'], value = ''): BodyExpect => ({ path, op, value })

/** saveApply 那类 BizException 信封：HTTP 全绿、业务全红——体断言立项要抓的就是它 */
const ENVELOPE_FAIL = '{"msg":"请选择品牌商","code":"500","level":"error"}'
const ENVELOPE_OK = '{"msg":"操作成功","code":"0","data":{"id":1001}}'

test('judgeCase：没配体断言时行为与 caseOk 完全一致（老用例零迁移）', () => {
  const j = judgeCase([200], undefined, 200, undefined, ENVELOPE_FAIL)
  assert.equal(j.ok, true)
  assert.deepEqual(j.assertFails, [])
})

test('judgeCase：HTTP 层失败时体断言不跑——一层一个原因，404 的信封断言是噪音', () => {
  const j = judgeCase([200], [be('$.level', 'notExists')], 404, undefined, '{"msg":"not found"}')
  assert.equal(j.ok, false)
  assert.deepEqual(j.assertFails, [])
})

test('judgeCase：notExists 抓 HTTP 200 的错误信封（本次立项的核心场景）', () => {
  const bad = judgeCase([200], [be('$.level', 'notExists')], 200, undefined, ENVELOPE_FAIL)
  assert.equal(bad.ok, false)
  assert.match(bad.assertFails[0], /\$\.level.*请选择品牌商|期望不存在/)

  const good = judgeCase([200], [be('$.level', 'notExists')], 200, undefined, ENVELOPE_OK)
  assert.equal(good.ok, true)
})

test('judgeCase：== 按肉眼所见比较，code 的数字 0 和字符串 "0" 必须算相等', () => {
  const j = judgeCase([200], [be('$.code', '==', '0')], 200, undefined, ENVELOPE_OK)
  assert.equal(j.ok, true)
  const bad = judgeCase([200], [be('$.code', '==', '0')], 200, undefined, ENVELOPE_FAIL)
  assert.equal(bad.ok, false)
  assert.match(bad.assertFails[0], /期望 0，实际 500/)
})

test('judgeCase：== 取不到值不放行——静默通过比失败更误导', () => {
  const j = judgeCase([200], [be('$.data.id', '==', '1001')], 200, undefined, '{"msg":"操作成功"}')
  assert.equal(j.ok, false)
  assert.match(j.assertFails[0], /取不到值/)
})

test('judgeCase：!= / notContains 在字段整个不存在时算过——信封字段成功时常常没了', () => {
  const j = judgeCase([200], [be('$.level', '!=', 'error')], 200, undefined, ENVELOPE_OK)
  assert.equal(j.ok, true)
  const j2 = judgeCase([200], [be('$.msg', 'notContains', '异常')], 200, undefined, ENVELOPE_OK)
  assert.equal(j2.ok, true)
  const bad = judgeCase([200], [be('$.level', '!=', 'error')], 200, undefined, ENVELOPE_FAIL)
  assert.equal(bad.ok, false)
})

test('judgeCase：exists 要求取得到值，contains 是子串不是全等', () => {
  assert.equal(judgeCase([200], [be('$.data.id', 'exists')], 200, undefined, ENVELOPE_OK).ok, true)
  const miss = judgeCase([200], [be('$.data.id', 'exists')], 200, undefined, ENVELOPE_FAIL)
  assert.equal(miss.ok, false)
  assert.match(miss.assertFails[0], /期望存在/)
  assert.equal(judgeCase([200], [be('$.msg', 'contains', '成功')], 200, undefined, ENVELOPE_OK).ok, true)
  assert.equal(judgeCase([200], [be('$.msg', 'contains', '成功')], 200, undefined, ENVELOPE_FAIL).ok, false)
})

test('judgeCase：响应不是合法 JSON 时明确失败，不静默放行', () => {
  const j = judgeCase([200], [be('$.level', 'notExists')], 200, undefined, '<html>gateway error</html>')
  assert.equal(j.ok, false)
  assert.match(j.assertFails[0], /不是合法 JSON/)
  // 体没抓到（null）同理：不能因为「没数据」就算断言通过
  const none = judgeCase([200], [be('$.level', 'notExists')], 200, undefined, null)
  assert.equal(none.ok, false)
})

test('judgeCase：BOM 不该让 parse 炸掉——抓包/代理最常见的杂质', () => {
  const j = judgeCase([200], [be('$.code', '==', '0')], 200, undefined, `\uFEFF${ENVELOPE_OK}`)
  assert.equal(j.ok, true)
})

test('judgeCase：路径命中多处按最严口径，一处不对整条断言失败', () => {
  const body = '{"errors":[{"code":"E1"},{"code":"E2"}]}'
  const j = judgeCase([200], [be('$.errors[*].code', '==', 'E1')], 200, undefined, body)
  assert.equal(j.ok, false)
  assert.match(j.assertFails[0], /E2/)
})

test('judgeCase：脚本表达式路径拒绝执行——断言是配置不是代码', () => {
  // eval:false 只在过滤器真正求值时才抛（体里要能走到 ?() 的数据），
  // 抛错被接住落「路径不合法」；绝不给它 eval 通道
  const j = judgeCase([200], [be('$..book[?(@.price<10)]', 'exists')], 200, undefined, '{"book":[{"price":5}]}')
  assert.equal(j.ok, false)
  assert.match(j.assertFails[0], /路径不合法/)
})

test('judgeCase：请求发不出去时体断言同样不跑（error 优先）', () => {
  const j = judgeCase([200], [be('$.level', 'notExists')], null, 'ECONNREFUSED', null)
  assert.equal(j.ok, false)
  assert.deepEqual(j.assertFails, [])
})

// ---- judgeCase：结构断言（第 6 参，scan/schemaAssert 出资格门与差异清单）----

const dict = new Map([
  ['UserVo', [
    { name: 'id', javaType: 'Long', required: true },
    { name: 'name', javaType: 'String', required: true },
  ]],
])

test('judgeCase：结构差异观察模式只记录不算失败（默认档不拦人）', () => {
  const j = judgeCase([200], undefined, 200, undefined, '{"id":1}', { responseType: 'UserVo', dict, strict: false })
  assert.equal(j.ok, true)
  assert.equal(j.schemaIssues.length, 1)
  assert.match(j.schemaIssues[0]!, /\$\.name：必填字段缺失/)
})

test('judgeCase：结构差异严格模式折进 ok', () => {
  const bad = judgeCase([200], undefined, 200, undefined, '{"id":1}', { responseType: 'UserVo', dict, strict: true })
  assert.equal(bad.ok, false)
  assert.equal(bad.assertFails.length, 0) // 失败原因在 schemaIssues，不混进体断言
  const good = judgeCase([200], undefined, 200, undefined, '{"id":1,"name":"a"}', { responseType: 'UserVo', dict, strict: true })
  assert.equal(good.ok, true)
})

test('judgeCase：HTTP 层失败时结构校验不跑（同体断言的分层）', () => {
  const j = judgeCase([200], undefined, 404, undefined, '{"x":1}', { responseType: 'UserVo', dict, strict: true })
  assert.equal(j.ok, false)
  assert.deepEqual(j.schemaIssues, [])
})

test('judgeCase：不传第 6 参时 schemaIssues 恒空（老调用点行为不变）', () => {
  const j = judgeCase([200], undefined, 200, undefined, '{"whatever":1}')
  assert.equal(j.ok, true)
  assert.deepEqual(j.schemaIssues, [])
})
