import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRequest, buildUrl, defaultParamValue, extractToken, resolveBaseUrl } from './request'
import type { ApiMethod, EnvironmentConfig, TestCase } from '../types'

const ENV: EnvironmentConfig = {
  baseUrl: 'http://localhost:8080/',
  loginApi: '',
  username: '',
  tokenHeader: 'Authorization',
  tokenPrefix: 'Bearer',
  timeoutMs: 5000,
  connId: '',
  assertMode: 'observe',
  projectBaseUrls: {},
}

const api = (over: Partial<ApiMethod>): ApiMethod => ({
  id: 'a1',
  methodName: 'get',
  httpMethod: 'GET',
  path: '/api/user/{id}',
  parameters: [{ name: 'id', javaType: 'Long', position: 'path', required: true }],
  requestBodyType: null,
  requestBodyFields: [],
  responseType: '',
  description: '',
  controllerClass: 'UserController',
  filePath: '',
  projectId: 'p',
  ...over,
})

const caseWith = (parameters: Record<string, unknown>): TestCase => ({
  id: 'c1',
  name: 't',
  type: 'normal',
  parameters,
  expectedHttpStatus: [200],
  expectedDbChange: 'none',
  enabled: true,
})

test('buildUrl：path 占位替换 + query 拼接 + baseUrl 尾斜杠去掉', () => {
  const url = buildUrl('http://localhost:8080/', '/api/user/{id}', api(api({})).parameters, { id: 1001, size: 10 })
  assert.equal(url, 'http://localhost:8080/api/user/1001')
})

test('buildUrl：path 参数缺失返回 null —— 半条路径不能发出去', () => {
  const url = buildUrl('http://x', '/api/user/{id}', api({}).parameters, {})
  assert.equal(url, null)
})

test('buildUrl：没被认领的 {xxx} 占位也算缺失', () => {
  const url = buildUrl('http://x', '/a/{unknown}', [], {})
  assert.equal(url, null)
})

test('defaultParamValue：数字/布尔/时间仍按类型给，不进语义字典', () => {
  assert.equal(defaultParamValue({ name: 'age', javaType: 'Integer', position: 'query' }), '1')
  assert.equal(defaultParamValue({ name: 'verbose', javaType: 'Boolean', position: 'query' }), 'true')
  assert.equal(
    defaultParamValue({ name: 'from', javaType: 'LocalDateTime', position: 'query' }),
    '2026-01-01 00:00:00',
  )
  // 既不是标量也不是字符串（认不出的类型）：没有任何语义可依据，给一眼看出是假的占位
  assert.equal(defaultParamValue({ name: 'file', javaType: 'MultipartFile', position: 'query' }), 'test_demo')
})

test('defaultParamValue：字符串按字段名/注释给合法值——test_demo 过不了 @Pattern，是假失败', () => {
  assert.match(defaultParamValue({ name: 'phone', javaType: 'String', position: 'query' }), /^138\d{8}$/)
  assert.match(defaultParamValue({ name: 'contactEmail', javaType: 'String', position: 'query' }), /@test\.com$/)
  // 字段名中性（contact）+ 注释写明「手机号」（国内工程的常见写法）→ 注释说了算
  assert.match(
    defaultParamValue({ name: 'contact', javaType: 'String', position: 'body', description: '联系人手机号' }),
    /^138\d{8}$/,
  )
  // 没有可依据的规则就是普通字符串，不编一个像真的业务值
  assert.equal(defaultParamValue({ name: 'contact', javaType: 'String', position: 'body' }), '测试文本')
  // path 参数是主键/外键值：给数字串（原来一律给 '1'，认不出是哪个字段）
  assert.match(defaultParamValue({ name: 'orderId', javaType: 'String', position: 'path' }), /^[1-5]$/)
})

test('buildRequest：token 按前缀注入；GET 不带 body', () => {
  const req = buildRequest(ENV, api({}), caseWith({ id: 1 }), 'tok123')
  assert.ok(req)
  assert.equal(req.headers.Authorization, 'Bearer tok123')
  assert.equal(req.body, null)
})

test('buildRequest：门户式裸 token 头（头名 token、无前缀）', () => {
  // 有的系统由过滤器读请求头 token，值是 Shiro sessionId，不是 Bearer JWT
  const env: EnvironmentConfig = { ...ENV, tokenHeader: 'token', tokenPrefix: '' }
  const req = buildRequest(env, api({}), caseWith({ id: 1 }), '11111111-2222-4333-8444-555555555555')
  assert.ok(req)
  assert.equal(req.headers.token, '11111111-2222-4333-8444-555555555555')
  assert.equal(req.headers.Authorization, undefined)
})

test('buildRequest：body 用例带 JSON 和 Content-Type', () => {
  const postApi = api({
    httpMethod: 'POST',
    path: '/api/user',
    parameters: [],
    requestBodyType: 'UserReq',
  })
  const req = buildRequest(ENV, postApi, caseWith({ __body: '{"a":1}' }), null)
  assert.ok(req)
  assert.equal(req.headers['Content-Type'], 'application/json')
  assert.equal(req.body, '{"a":1}')
})

test('buildRequest：声明了 @RequestBody 但用例没 __body → 补 {}，不空手发', () => {
  // 真实回归：/api/shop/productCategory/list 的缓存老用例就没 __body，
  // 空手发服务端回 500 + 堆栈（带 {} 是 200）
  const postApi = api({
    httpMethod: 'POST',
    path: '/api/shop/productCategory/list',
    parameters: [{ name: 'request', javaType: 'PurchaseCityQueryRequest', position: 'body', required: true }],
    requestBodyType: 'PurchaseCityQueryRequest',
    requestBodyFields: [],
  })
  const req = buildRequest(ENV, postApi, caseWith({}), null)
  assert.ok(req)
  assert.equal(req.body, '{}')
  assert.equal(req.headers['Content-Type'], 'application/json')
})

test('buildRequest：集合 body（List<X>）声明了但没 __body → 兜 []，不是 {}', () => {
  // List<UserReq> 的 JSON 契约是数组：发 {} 服务端反序列化直接 400
  const postApi = api({
    httpMethod: 'POST',
    path: '/api/x',
    parameters: [{ name: 'reqs', javaType: 'UserReq', position: 'body', required: true }],
    requestBodyType: 'List<UserReq>',
    requestBodyFields: [],
  })
  assert.equal(buildRequest(ENV, postApi, caseWith({}), null)?.body, '[]')
})

test('buildRequest：参数表里有 body 位、requestBodyType 没扫到 → 一样补 {}', () => {
  const postApi = api({
    httpMethod: 'POST',
    path: '/api/x',
    parameters: [{ name: 'req', javaType: 'SomeDto', position: 'body', required: true }],
    requestBodyType: null,
  })
  assert.equal(buildRequest(ENV, postApi, caseWith({}), null)?.body, '{}')
})

test('buildRequest：没声明 body 的 POST 仍然不带——别把能跑的接口塞坏', () => {
  const postApi = api({
    httpMethod: 'POST',
    path: '/api/shop/view/confirm',
    parameters: [{ name: 'id', javaType: 'Long', position: 'query', required: true }],
    requestBodyType: null,
  })
  const req = buildRequest(ENV, postApi, caseWith({ id: 1 }), null)
  assert.ok(req)
  assert.equal(req.body, null)
  assert.equal(req.headers['Content-Type'], undefined)
})

test('buildRequest：用例给了 __body 就用它，不拿 {} 盖掉', () => {
  const postApi = api({ httpMethod: 'POST', path: '/api/x', parameters: [], requestBodyType: 'R' })
  assert.equal(buildRequest(ENV, postApi, caseWith({ __body: '{"name":"武汉"}' }), null)?.body, '{"name":"武汉"}')
})

test('buildRequest：GET 但声明了 @RequestBody → 照样带 body（动词是扫描器的试探，不是事实）', () => {
  // 真实回归：SHOP /api/shop/payorderpush/orderPush 的 controller 写的是
  // @RequestMapping(value = "/orderPush")（没写 method），扫描器按 GET 试探。
  // 原来这里按动词判空，把用例里真配的 __body 一起丢掉 → Spring 抛
  // Required request body is missing → 全局异常翻 500，看着像接口坏了
  const getApi = api({
    httpMethod: 'GET',
    path: '/api/shop/payorderpush/orderPush',
    parameters: [{ name: 'request', javaType: 'PayOrderPushRequest', position: 'body', required: true }],
    requestBodyType: 'PayOrderPushRequest',
  })
  const req = buildRequest(ENV, getApi, caseWith({ __body: '{"orderNo":"1"}' }), null)
  assert.ok(req)
  assert.equal(req.method, 'GET') // 动词照扫描结果发，重扫工程后才是 POST
  assert.equal(req.body, '{"orderNo":"1"}')
  assert.equal(req.headers['Content-Type'], 'application/json')
  // 没给 __body 时同样按「声明了 body」补 {}，不空手发
  assert.equal(buildRequest(ENV, getApi, caseWith({}), null)?.body, '{}')
})

test('buildRequest：GET 没声明 body 的仍然不带——别把能跑的接口塞坏', () => {
  const getApi = api({ httpMethod: 'GET', path: '/api/x', parameters: [], requestBodyType: null })
  const req = buildRequest(ENV, getApi, caseWith({ __body: '{"a":1}' }), null)
  assert.ok(req)
  assert.equal(req.body, null)
  assert.equal(req.headers['Content-Type'], undefined)
})

test('extractToken：默认依次试 data.token / token / accessToken', () => {
  assert.equal(extractToken('{"data":{"token":"t1"}}'), 't1')
  assert.equal(extractToken('{"token":"t2"}'), 't2')
  assert.equal(extractToken('{"accessToken":"t3"}'), 't3')
  assert.equal(extractToken('{"data":{"accessToken":"t4"}}'), 't4')
})

test('extractToken：显式 JSONPath 优先', () => {
  assert.equal(extractToken('{"result":{"user":{"tk":"t5"}}}', '$.result.user.tk'), 't5')
})

test('extractToken：抽不到返回 null 而不是空串 —— 调用方要提示改配置', () => {
  assert.equal(extractToken('{"err":1}'), null)
  assert.equal(extractToken('not json'), null)
})

test('resolveBaseUrl：工程覆盖优先，空/未配回退全局', () => {
  const env: EnvironmentConfig = {
    ...ENV,
    baseUrl: 'http://default:8080',
    projectBaseUrls: { 'p-a': 'http://a:9001/', 'p-b': '  ' },
  }
  assert.equal(resolveBaseUrl(env, 'p-a'), 'http://a:9001/')
  assert.equal(resolveBaseUrl(env, 'p-b'), 'http://default:8080')
  assert.equal(resolveBaseUrl(env, 'p-c'), 'http://default:8080')
})

test('buildRequest：按 api.projectId 取覆盖 baseUrl', () => {
  const env: EnvironmentConfig = {
    ...ENV,
    baseUrl: 'http://default:8080',
    projectBaseUrls: { svc: 'http://svc:7001' },
  }
  const req = buildRequest(
    env,
    api({ projectId: 'svc', path: '/ping', parameters: [] }),
    caseWith({}),
    null,
  )
  assert.equal(req?.url, 'http://svc:7001/ping')
  const fallback = buildRequest(
    env,
    api({ projectId: 'other', path: '/ping', parameters: [] }),
    caseWith({}),
    null,
  )
  assert.equal(fallback?.url, 'http://default:8080/ping')
})
