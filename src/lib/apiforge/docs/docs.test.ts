import test from 'node:test'
import assert from 'node:assert/strict'
import { assembleDocs, docsToHtml, docsToMarkdown, docsToOpenApi, oasSchemaOf } from './docs'
import { scan } from './docsFixture'

test('assembleDocs：铺平扫描结果，body 示例按字段生成，关联表走 mapper 命中 + 用户修正', () => {
  const docs = assembleDocs(scan(), {
    a2: [{ tableName: 't_user_log', confidence: 'user', source: '手动添加', enabled: true }],
  })
  assert.equal(docs.length, 2)

  const create = docs.find((d) => d.id === 'a1')!
  // Controller → Service → UserMapper.insert → t_user
  assert.deepEqual(create.tables.map((t) => t.tableName), ['t_user'])
  // body 示例按字段名给值（name → 人名），不是占位 test_demo
  const createBody = JSON.parse(create.bodyExample ?? '{}')
  assert.match(String(createBody.name), /^[一-龥]{2,3}$/)
  assert.equal(createBody.age, 1)
  // 复杂返回类型解析不到字段，不给假示例，只标类型
  assert.equal(create.responseExample, null)
  assert.equal(create.responseType, 'Result<UserVO>')

  const detail = docs.find((d) => d.id === 'a2')!
  assert.equal(detail.bodyExample, null)
  assert.equal(detail.responseExample, JSON.stringify('test_demo'))
  // resolveLinks 对方法名不命中的走整 Controller 兜底，所以 GET 也带出 t_user；
  // 用户手动的 t_user_log 可信度最高排前
  assert.deepEqual(detail.tables.map((t) => t.tableName), ['t_user_log', 't_user'])

  // 用户取消勾选的表不进文档
  const off = assembleDocs(scan(), {
    a1: [{ tableName: 't_user', confidence: 'mapper', source: 'x', enabled: false }],
  })
  assert.equal(off.find((d) => d.id === 'a1')!.tables.length, 0)
})

test('文档 Markdown：工程/Controller 分组、参数表、请求体示例、不出现 Token', () => {
  const md = docsToMarkdown(assembleDocs(scan(), {}))
  assert.match(md, /^# 码上测 接口文档/)
  assert.match(md, /## demo-api/)
  assert.match(md, /### UserController/)
  assert.match(md, /#### `POST \/api\/users`/)
  assert.match(md, /t_user（MAPPER）/)
  assert.match(md, /\| id \| path \| Long \| 是 /)
  // bodyExample 现在是 pretty 后的多行（跟试跑卡/报告一个口径），内容语义不变
  assert.match(md, /```json\n\{\n  "name": "[^"]+",\n  "age": 1\n\}\n```/)
  assert.match(md, /返回类型：`Result<UserVO>`/)
  assert.doesNotMatch(md, /Bearer|token/i)
})

test('文档 HTML：转义描述里的 HTML 字符', () => {
  const html = docsToHtml(assembleDocs(scan(), {}))
  assert.doesNotMatch(html, /<script>alert/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /class="verb post"/)
})

test('OpenAPI：合法 spec，路径/方法/请求体 schema/路径参数补齐都到位', () => {
  const spec = JSON.parse(docsToOpenApi(assembleDocs(scan(), {}), { baseUrl: 'http://localhost:8080' }))
  assert.equal(spec.openapi, '3.0.3')
  assert.deepEqual(spec.servers, [{ url: 'http://localhost:8080' }])

  const create = spec.paths['/api/users'].post
  assert.equal(create.tags[0], 'UserController')
  assert.equal(create.summary, '创建用户 <script>')
  assert.deepEqual(create.requestBody.content['application/json'].schema, {
    type: 'object',
    properties: { name: { type: 'string' }, age: { type: 'integer', format: 'int32' } },
    required: ['name'],
  })
  const example = create.requestBody.content['application/json'].example
  assert.match(String(example.name), /^[一-龥]{2,3}$/)
  assert.equal(example.age, 1)

  // 路径参数 {id} 即使扫描器漏报也补齐声明，保证导入 Postman 不报 spec 错误
  const detail = spec.paths['/api/users/{id}'].get
  assert.equal(detail.parameters[0].name, 'id')
  assert.equal(detail.parameters[0].in, 'path')
  assert.equal(detail.parameters[0].required, true)
})

test('oasSchemaOf：认得的 Java 类型给精确 schema，数组带 items，不认得的给 string', () => {
  assert.deepEqual(oasSchemaOf('Long'), { type: 'integer', format: 'int64' })
  assert.deepEqual(oasSchemaOf('BigDecimal'), { type: 'number' })
  assert.deepEqual(oasSchemaOf('LocalDateTime'), { type: 'string', format: 'date-time' })
  assert.deepEqual(oasSchemaOf('List<String>'), { type: 'array', items: { type: 'string' } })
  // VO 没有字段清单，items 留空让导入方自己改 —— 不编
  assert.deepEqual(oasSchemaOf('UserVO[]'), { type: 'array', items: {} })
  assert.deepEqual(oasSchemaOf('UserVO'), { type: 'string' })
})
