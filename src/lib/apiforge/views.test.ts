import test from 'node:test'
import assert from 'node:assert/strict'
import { isAdvancedView, resolveView, runEnvOf, scanKinds, soloVueId, viewShown } from './views'
import type { EnvironmentConfig } from './types'

test('scanKinds / resolveView：纯页面工程藏接口页签，纯接口工程藏页面测试；没扫描全显示', () => {
  const api = { controllers: [{ methods: [1] }], pages: [] }
  const ui = { controllers: [], pages: [1] }
  assert.deepEqual(scanKinds(null), { apis: true, pages: true })
  assert.deepEqual(scanKinds({ projects: [ui] }), { apis: false, pages: true })
  assert.deepEqual(scanKinds({ projects: [api] }), { apis: true, pages: false })
  assert.deepEqual(scanKinds({ projects: [api, ui] }), { apis: true, pages: true })
  const pageOnly = { apis: false, pages: true }
  const apiOnly = { apis: true, pages: false }
  for (const v of ['apis', 'report', 'tables', 'bench'] as const) assert.equal(viewShown(v, pageOnly), false)
  assert.equal(viewShown('pages', apiOnly), false)
  assert.equal(viewShown('env', pageOnly), true)
  assert.equal(resolveView('apis', { advanced: true, hasScan: true, kinds: pageOnly }), 'pages')
  assert.equal(resolveView('report', { advanced: true, hasScan: true, kinds: pageOnly }), 'pages')
  assert.equal(resolveView('tables', { advanced: false, hasScan: true, kinds: pageOnly }), 'pages')
  assert.equal(resolveView('pages', { advanced: true, hasScan: true, kinds: apiOnly }), 'apis')
  assert.equal(resolveView('env', { advanced: true, hasScan: true, kinds: pageOnly }), 'env')
})

test('soloVueId：只有一个 Vue 工程且没有接口才算', () => {
  const vue = { projectId: 'v', vue: {}, controllers: [], pages: [1] }
  const ftl = { projectId: 'f', controllers: [], pages: [1] }
  const api = { projectId: 'a', controllers: [{ methods: [1] }], pages: [] }
  assert.equal(soloVueId(null), null)
  assert.equal(soloVueId({ projects: [vue] }), 'v')
  assert.equal(soloVueId({ projects: [ftl] }), null)
  assert.equal(soloVueId({ projects: [vue, ftl] }), null)
  assert.equal(soloVueId({ projects: [vue, api] }), null)
  assert.equal(soloVueId({ projects: [{ ...vue, controllers: [{ methods: [1] }] }] }), null)
})

test('resolveView：旧名 home 落到扫描页', () => {
  assert.equal(resolveView('home', { advanced: true, hasScan: true }), 'scan')
  assert.equal(resolveView('home', { advanced: false, hasScan: false }), 'scan')
})

test('resolveView：关联表、场景、数据驱动、压测暂时藏起，开了高级也回落', () => {
  const all = { apis: true, pages: true }
  for (const v of ['tables', 'scenario', 'data', 'bench'] as const) {
    assert.equal(viewShown(v, all), false)
    assert.equal(resolveView(v, { advanced: true, hasScan: true }), 'apis')
    assert.equal(resolveView(v, { advanced: true, hasScan: false }), 'scan')
  }
})

test('resolveView：开关关着时高级页回落，有扫描去接口页、没有去扫描页', () => {
  for (const v of ['tables', 'scenario', 'data', 'bench'] as const) {
    assert.equal(resolveView(v, { advanced: false, hasScan: true }), 'apis')
    assert.equal(resolveView(v, { advanced: false, hasScan: false }), 'scan')
  }
})

test('resolveView：主线页、页面测试不受开关影响', () => {
  for (const v of ['scan', 'apis', 'report', 'env', 'pages'] as const) {
    assert.equal(resolveView(v, { advanced: false, hasScan: false }), v)
    assert.equal(isAdvancedView(v), false)
  }
})

test('runEnvOf：断言严格度、执行顺序藏着时，开不开高级都按观察、默认顺序跑', () => {
  const env = { baseUrl: 'x', assertMode: 'strict', methodOrder: ['DELETE'] } as EnvironmentConfig
  const off = runEnvOf(env, false)
  assert.equal(off.assertMode, 'observe')
  assert.equal(off.methodOrder, undefined)
  assert.equal(off.baseUrl, 'x')
  const on = runEnvOf(env, true)
  assert.equal(on.assertMode, 'observe', '断言严格度暂时藏着，开了高级也按观察')
  assert.equal(on.methodOrder, undefined, '执行顺序暂时藏着，开了高级也按默认')
})

test('runEnvOf：认证只留粘 Token，以前填的登录接口不再自动登录', () => {
  const env = { baseUrl: 'x', loginApi: '/login' } as EnvironmentConfig
  assert.equal(runEnvOf(env, false).loginApi, '')
  assert.equal(runEnvOf(env, true).loginApi, '')
})

test('runEnvOf：只跑查询开着时关掉数据准备；高级关着时只跑查询不生效', () => {
  const env = { baseUrl: 'x', autoPrepare: true, readOnlyRun: true } as EnvironmentConfig
  const on = runEnvOf(env, true)
  assert.equal(on.readOnlyRun, true)
  assert.equal(on.autoPrepare, false)
  const off = runEnvOf(env, false)
  assert.equal(off.readOnlyRun, undefined)
  assert.equal(off.autoPrepare, true)
})
