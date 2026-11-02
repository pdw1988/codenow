import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toCurl } from './curl'

test('toCurl：不带 body 只有方法、地址和 Content-Type', () => {
  assert.equal(
    toCurl('get', 'http://h/api?id=1'),
    "curl -X GET 'http://h/api?id=1' \\\n  -H 'Content-Type: application/json'",
  )
})

test('toCurl：body 里的单引号按 shell 规则转义', () => {
  const out = toCurl('POST', 'http://h/api', `{"name":"O'Neil"}`)
  assert.ok(out.endsWith(`-d '{"name":"O'\\''Neil"}'`))
  assert.ok(out.startsWith("curl -X POST 'http://h/api'"))
})
