import test from 'node:test'
import assert from 'node:assert/strict'
import { makeReloginSend } from './relogin'
import type { BuiltRequest } from '../http/request'
import type { EnvironmentConfig } from '../types'

const env: EnvironmentConfig = {
  baseUrl: 'http://test',
  loginApi: '/login',
  username: 'u',
  tokenHeader: 'Authorization',
  tokenPrefix: 'Bearer',
  timeoutMs: 5000,
  connId: '',
  assertMode: 'observe',
}

const req = (token: string | null): BuiltRequest => ({
  url: 'http://test/api/ping',
  method: 'GET',
  headers: token ? { Authorization: `Bearer ${token}` } : {},
  body: null,
})

test('makeReloginSend：401 → 重登 → 换新 token 重发同一条请求，新 token 写回 holder', async () => {
  const seen: string[] = []
  let calls = 0
  const send = async (r: BuiltRequest) => {
    calls += 1
    seen.push(String(r.headers.Authorization))
    return calls === 1 ? { status: 401, bodyText: '{"msg":"token 过期"}' } : { status: 200, bodyText: '{"ok":1}' }
  }
  const holder: { token: string | null } = { token: 'T1' }
  const out = await makeReloginSend({ env, holder, send, relogin: async () => 'T2' })(req('T1'), 5000)
  assert.equal(out.status, 200)
  assert.deepEqual(seen, ['Bearer T1', 'Bearer T2'], '第二次是换过 token 的重发')
  assert.equal(holder.token, 'T2', '后续请求 buildRequest 读 holder.token 自动带上')
})

test('makeReloginSend：整轮只自救一次——重试还 401 就照实返回，不再死磕', async () => {
  let relogins = 0
  const send = async () => ({ status: 401, bodyText: '{}' })
  const rel = makeReloginSend({ env, holder: { token: 'T1' }, send, relogin: async () => { relogins += 1; return 'T2' } })
  const first = await rel(req('T1'), 5000)
  const second = await rel(req('T2'), 5000)
  assert.equal(first.status, 401)
  assert.equal(second.status, 401)
  assert.equal(relogins, 1, '两次 401 只重登了一次')
})

test('makeReloginSend：登录失败（null）不再重发；没配登录接口 / 非 401 都直通', async () => {
  let sends = 0
  const send = async () => {
    sends += 1
    return { status: 401, bodyText: '{}' }
  }
  const fail = await makeReloginSend({ env, holder: { token: 'T1' }, send, relogin: async () => null })(req('T1'), 5000)
  assert.equal(fail.status, 401)
  assert.equal(sends, 1, '拿不到新 token 不重发')

  let relogins = 0
  const noLogin = { ...env, loginApi: '' }
  const passthrough = makeReloginSend({ env: noLogin, holder: { token: null }, send, relogin: async () => { relogins += 1; return 'T' } })
  await passthrough(req(null), 5000)
  const ok = await makeReloginSend({ env, holder: { token: null }, send: async () => ({ status: 500, bodyText: '{}' }), relogin: async () => { relogins += 1; return 'T' } })(req(null), 5000)
  assert.equal(relogins, 0, '没配登录接口 / 非 401 都不触发重登')
  assert.equal(ok.status, 500)
})
