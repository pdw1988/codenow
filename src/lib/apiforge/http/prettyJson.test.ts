import test from 'node:test'
import assert from 'node:assert/strict'
import { prettyJson, previewOf, RESPONSE_PREVIEW_MAX } from './prettyJson'

test('prettyJson：对象缩进 2 空格', () => {
  assert.equal(prettyJson('{"a":1,"b":{"c":2}}'), '{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}')
})

test('prettyJson：数组也缩进', () => {
  assert.equal(prettyJson('[1,2]'), '[\n  1,\n  2\n]')
})

test('prettyJson：真实响应（productCategory/list）的嵌套结构展开得开', () => {
  const raw =
    '{"msg":"操作成功！","code":"200","data":{"current":1,"pages":228,"records":[{"citySx":"wj","id":"1900000000000000010","name":"吴江"}],"size":10,"total":2276}}'
  const out = prettyJson(raw)
  assert.match(out, /^\{\n {2}"msg": "操作成功！",/)
  assert.match(out, /\n {6}\{\n {8}"citySx": "wj",/, 'records 里的对象要逐字段展开')
  // 无损：格式化完还能 parse 回去，字段不能丢
  assert.deepEqual(JSON.parse(out), JSON.parse(raw))
})

test('prettyJson：不是 JSON 的原样返回——不能因为格式化失败就把内容吞了', () => {
  assert.equal(prettyJson('<html><body>502 Bad Gateway</body></html>'), '<html><body>502 Bad Gateway</body></html>')
  assert.equal(prettyJson('OK'), 'OK')
  assert.equal(prettyJson(''), '')
  assert.equal(prettyJson('   '), '   ')
})

test('prettyJson：半截（被上游截过的）JSON 原样返回', () => {
  const half = '{"msg":"操作成功","data":{"records":[{"na'
  assert.equal(prettyJson(half), half)
})

test('prettyJson：字符串里的 \\n 不展开——保住合法 JSON（报告要能拷走直接 parse）', () => {
  const raw = '{"error":"java.lang.Exception\\n\\tat Foo.bar(Foo.java:1)"}'
  const out = prettyJson(raw)
  assert.match(out, /\\n\\tat Foo\.bar/)
  assert.equal(JSON.parse(out).error, 'java.lang.Exception\n\tat Foo.bar(Foo.java:1)')
})

test('previewOf：没超限就不加尾巴', () => {
  const out = previewOf('{"a":1}')
  assert.equal(out, '{\n  "a": 1\n}')
})

test('previewOf：超限截断并明说原文多长（以前是默默削掉）', () => {
  const raw = JSON.stringify({ list: Array.from({ length: 400 }, (_, i) => ({ i, name: `行${i}` })) })
  const out = previewOf(raw)
  assert.ok(out.length > RESPONSE_PREVIEW_MAX, '尾巴提示在上限之外')
  assert.ok(out.startsWith('{\n  "list": [\n'), '截断之前先格式化，开头就是缩进结构')
  assert.match(out, /…（已截断，原文 \d+ 字符）$/)
})

test('previewOf：先格式化再截断，不是先截断再格式化', () => {
  // 先截后 pretty 的话，半截 JSON parse 不了，结果会是一坨单行
  const raw = JSON.stringify({ k: 'x'.repeat(3000), n: 1 })
  const out = previewOf(raw)
  assert.ok(out.includes('\n'), '必须已经是多行结构')
  assert.ok(out.startsWith('{\n  "k": "xxx'))
})
