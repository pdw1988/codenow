import test from 'node:test'
import assert from 'node:assert/strict'
import { maskToken, parseAuthPaste, parseTokenText } from './parseTokenText'

const UUID = '44b443f3-98f1-4fc7-8a1a-d29a5ec88224'

test('maskToken：首 8 尾 6 + 长度——足够跟 Chrome 里的值过一眼', () => {
  // 门户式 sessionId（UUID 36 位）
  assert.equal(maskToken(UUID), '44b443f3…c88224（共 36 字）')
})

test('maskToken：短值不拆首尾（拆了等于全显）', () => {
  assert.equal(maskToken('abcd1234'), '••••••••（共 8 字）')
  // 16 是边界：还算短
  assert.equal(maskToken('a'.repeat(16)), `${'•'.repeat(16)}（共 16 字）`)
  assert.equal(maskToken('a'.repeat(17)), 'aaaaaaaa…aaaaaa（共 17 字）')
})

test('maskToken：空串给空串，不抛也不拼出「共 0 字」这种废话', () => {
  assert.equal(maskToken(''), '')
})

test('parseTokenText：门户跳转 URL 里的 token=', () => {
  const url =
    'http://192.168.1.10:8080/task-detail.html?token=11111111-2222-4333-8444-555555555555&origin=ADMIN_UI'
  assert.equal(parseTokenText(url), '11111111-2222-4333-8444-555555555555')
  assert.deepEqual(parseAuthPaste(url), {
    token: '11111111-2222-4333-8444-555555555555',
    header: 'token',
    prefix: '',
  })
})

test('parseTokenText：curl -H token', () => {
  const curl = `curl "http://x/api" -H "token: 11111111-2222-4333-8444-555555555555"`
  assert.equal(parseTokenText(curl), '11111111-2222-4333-8444-555555555555')
})

test('parseTokenText：Authorization Bearer', () => {
  assert.equal(parseTokenText('Authorization: Bearer abc.def.ghi'), 'abc.def.ghi')
  assert.equal(parseTokenText('Bearer abc.def.ghi'), 'abc.def.ghi')
  assert.deepEqual(parseAuthPaste('Authorization: Bearer abc.def.ghi'), {
    token: 'abc.def.ghi',
    header: 'Authorization',
    prefix: 'Bearer',
  })
})

test('parseTokenText：裸 UUID / 空串', () => {
  assert.equal(parseTokenText('11111111-2222-4333-8444-555555555555'), '11111111-2222-4333-8444-555555555555')
  assert.equal(parseTokenText('  '), null)
  assert.equal(parseTokenText('hello world no token'), null)
  assert.deepEqual(parseAuthPaste(UUID), { token: UUID, header: 'token', prefix: '' })
})

test('parseAuthPaste：Chrome 请求头两列复制（Tab，不是 token:xx）', () => {
  const tsv = [
    'Content-Length\t0',
    `Cookie\tlang=zh_CN, shiroCookie=${UUID}`,
    'Host\tsit.example.com:8703',
    'Origin\thttp://sit.example.com:8703',
    'Pragma\tno-cache',
    'Referer\thttp://sit.example.com:8703/shopflow/flow-definition.html',
    `Token\t${UUID}`,
    'User-Agent\tMozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  ].join('\n')
  assert.deepEqual(parseAuthPaste(tsv), { token: UUID, header: 'token', prefix: '' })
})

test('parseAuthPaste：只复制 Token 那一行（Tab 或冒号）', () => {
  assert.deepEqual(parseAuthPaste(`Token\t${UUID}`), { token: UUID, header: 'token', prefix: '' })
  assert.deepEqual(parseAuthPaste(`token: ${UUID}`), { token: UUID, header: 'token', prefix: '' })
})

test('parseAuthPaste：Copy request headers 冒号格式；Cookie 在 Token 前面也不要抢', () => {
  const dump = [
    'content-length: 0',
    `cookie: lang=zh_CN, shiroCookie=${UUID}`,
    'host: sit.example.com:8703',
    `token: ${UUID}`,
  ].join('\n')
  assert.deepEqual(parseAuthPaste(dump), { token: UUID, header: 'token', prefix: '' })
})

test('parseAuthPaste：没有 Token 头时用 Cookie 的 shiroCookie', () => {
  const onlyCookie = `Cookie: lang=zh_CN, shiroCookie=${UUID}`
  assert.deepEqual(parseAuthPaste(onlyCookie), { token: UUID, header: 'token', prefix: '' })
})

test('parseAuthPaste：Token 与值拆成两行', () => {
  assert.deepEqual(parseAuthPaste(`Token\n${UUID}`), { token: UUID, header: 'token', prefix: '' })
})

test('parseAuthPaste：HAR 头数组', () => {
  const har = `{"name":"token","value":"${UUID}"}`
  assert.deepEqual(parseAuthPaste(har), { token: UUID, header: 'token', prefix: '' })
})
