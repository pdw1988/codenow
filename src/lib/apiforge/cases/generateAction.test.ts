import test from 'node:test'
import assert from 'node:assert/strict'
import { generateCases, NOT_FOUND_ID } from './generate'
import type { ApiMethod } from '../types'

const api = (over: Partial<ApiMethod>): ApiMethod => ({
  id: 'a1',
  methodName: 'm',
  httpMethod: 'POST',
  path: '/api/brand/x',
  parameters: [],
  requestBodyType: 'BrandReq',
  requestBodyFields: [
    { name: 'id', javaType: 'Long', required: false },
    { name: 'brandName', javaType: 'String', required: false },
    { name: 'status', javaType: 'Integer', required: false },
  ],
  responseType: '',
  description: '',
  controllerClass: 'BrandController',
  filePath: '',
  projectId: 'p',
  ...over,
})

const normalBody = (a: ApiMethod) =>
  JSON.parse(generateCases(a).find((c) => c.type === 'normal')!.parameters.__body as string) as Record<string, unknown>

test('新增：正常用例 body 填满但不给主键 id；预计库变化=insert', () => {
  const a = api({ path: '/api/brand/saveBrand' })
  const body = normalBody(a)
  assert.equal('id' in body, false)
  assert.ok(body.brandName)
  assert.ok('status' in body)
  assert.equal(generateCases(a)[0].expectedDbChange, 'insert')
})

test('修改：body 填满（含 id，跑前对准造的行）；POST 也配「未找到」', () => {
  const a = api({ path: '/api/brand/updateBrand' })
  const body = normalBody(a)
  // 没对准造的行时打空，不拿字典的 id=1 改真数据
  assert.equal(body.id, NOT_FOUND_ID)
  assert.ok(body.brandName)
  const cases = generateCases(a)
  assert.equal(cases[0].expectedDbChange, 'update')
  const nf = cases.find((c) => c.probeNotFound)!
  assert.equal(JSON.parse(nf.parameters.__body as string).id, NOT_FOUND_ID)
})

test('删除：body 只带 id 形字段；预计库变化=delete；配「未找到」', () => {
  const a = api({ path: '/api/brand/deleteBrand' })
  assert.deepEqual(normalBody(a), { id: NOT_FOUND_ID })
  const cases = generateCases(a)
  assert.equal(cases[0].expectedDbChange, 'delete')
  assert.ok(cases.some((c) => c.probeNotFound))
})

test('「未找到」排在边界前面：超 30 条先截边界', () => {
  const cases = generateCases(api({ path: '/api/brand/updateBrand' }))
  const nf = cases.findIndex((c) => c.probeNotFound)
  const firstBoundary = cases.findIndex((c) => c.type === 'boundary')
  assert.ok(nf >= 0 && firstBoundary > nf)
})

test('正常用例默认查信封（level/code）；异常、边界不加', () => {
  const cases = generateCases(api({ path: '/api/brand/updateBrand' }))
  const normal = cases.find((c) => c.type === 'normal')!
  assert.deepEqual(normal.expectBody, [
    { path: '$.level', op: '!=', value: 'error' },
    { path: '$.code', op: '!=', value: '500' },
    { path: '$.code', op: '!=', value: '501' },
  ])
  for (const c of cases.filter((c) => c.type !== 'normal')) assert.equal(c.expectBody, undefined)
})

test('查询：可选筛选条件各一条「正常·按 xxx 查」，名字类按包含、状态类按相等；分页/日期不做', () => {
  const a = api({
    path: '/api/brand/getList',
    requestBodyFields: [
      { name: 'brandName', javaType: 'String', required: false },
      { name: 'status', javaType: 'Integer', required: false },
      { name: 'pageNum', javaType: 'Integer', required: false },
      { name: 'startDate', javaType: 'String', required: false },
      { name: 'createTime', javaType: 'Date', required: false },
      { name: 'detailList', javaType: 'List<Detail>', required: false },
    ],
    parameters: [{ name: 'keyword', javaType: 'String', position: 'query', required: false }],
  })
  const cases = generateCases(a)
  const qb = cases.filter((c) => c.queryBy).map((c) => [c.name, c.queryBy!.position, c.queryBy!.mode])
  assert.deepEqual(qb, [
    ['正常·按 keyword 查', 'query', 'contains'],
    ['正常·按 brandName 查', 'body', 'contains'],
    ['正常·按 status 查', 'body', 'eq'],
  ])
  // 查询不动库
  for (const c of cases) assert.equal(c.expectedDbChange, 'none')
})

test('查询：按条件查最多 10 条；写接口不生成', () => {
  const fields = Array.from({ length: 15 }, (_, i) => ({ name: `f${i}`, javaType: 'String', required: false }))
  assert.equal(generateCases(api({ path: '/api/brand/getList', requestBodyFields: fields })).filter((c) => c.queryBy).length, 10)
  assert.equal(generateCases(api({ path: '/api/brand/saveBrand', requestBodyFields: fields })).filter((c) => c.queryBy).length, 0)
})
