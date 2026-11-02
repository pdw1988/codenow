import test from 'node:test'
import assert from 'node:assert/strict'
import { apiDiffToMarkdown, diffScans } from './apidiff'
import type { ApiMethod, WorkspaceScanResult } from '../types'

const api = (over: Partial<ApiMethod>): ApiMethod => ({
  id: 'id-1',
  methodName: 'create',
  httpMethod: 'POST',
  path: '/api/user/create',
  parameters: [{ name: 'id', javaType: 'Long', position: 'path', required: true }],
  requestBodyType: null,
  requestBodyFields: [],
  responseType: 'R<Void>',
  description: '创建',
  controllerClass: 'UserController',
  filePath: 'UserController.java',
  projectId: 'p1',
  ...over,
})

const ws = (apis: ApiMethod[], fingerprint = 'f1'): WorkspaceScanResult => ({
  root: 'E:/demo',
  scannedAt: '2026-09-06T00:00:00Z',
  fingerprint,
  projects: [
    {
      projectId: 'p1',
      projectPath: 'E:/demo/svc',
      projectName: 'svc',
      controllers: [{ className: 'UserController', packageName: 'web', basePath: '', filePath: 'UserController.java', description: '', author: '', date: '', methods: apis }],
      mappers: [],
      classUses: [],
      errors: [],
    },
  ],
  errors: [],
})

test('diffScans：空基线或没有差异时不硬凑条目', () => {
  const fresh = ws([api({})])
  assert.equal(diffScans(null, fresh).entries.length, 0)
  const same = diffScans(ws([api({})]), fresh)
  assert.equal(same.entries.length, 0)
  assert.deepEqual(
    { b: same.breakingCount, a: same.addedCount, r: same.removedCount, c: same.changedCount },
    { b: 0, a: 0, r: 0, c: 0 },
  )
})

test('破坏性判定：路径变更、必填参数删除、类型变更、新增必填', () => {
  const old = ws([
    api({
      path: '/api/user/add',
      parameters: [
        { name: 'id', javaType: 'Long', position: 'path', required: true },
        { name: 'phone', javaType: 'String', position: 'query', required: true },
        { name: 'memo', javaType: 'String', position: 'query', required: false },
      ],
    }),
  ])
  const fresh = ws([
    api({
      parameters: [
        { name: 'id', javaType: 'String', position: 'path', required: true },
        { name: 'orgId', javaType: 'Long', position: 'query', required: true },
        { name: 'tag', javaType: 'String', position: 'query', required: false },
      ],
    }),
  ])
  const d = diffScans(old, fresh)
  assert.equal(d.entries.length, 1)
  const e = d.entries[0]
  assert.equal(e.breaking, true)
  assert.match(e.details.join('；'), /路径 \/api\/user\/add → \/api\/user\/create/)
  assert.match(e.details.join('；'), /删除了必填参数 phone\(query\)/)
  assert.match(e.details.join('；'), /删除了可选参数 memo\(query\)/)
  assert.match(e.details.join('；'), /参数 id\(path\) 类型变更 Long → String/)
  assert.match(e.details.join('；'), /新增必填参数 orgId\(query\)/)
  assert.match(e.details.join('；'), /新增可选参数 tag\(query\)/)
})

test('body 必填字段删除是破坏性；可选字段删除仅提示', () => {
  const old = ws([
    api({ requestBodyFields: [{ name: 'name', javaType: 'String', required: true }, { name: 'note', javaType: 'String', required: false }] }),
  ])
  const fresh = ws([api({ requestBodyFields: [] })])
  const d = diffScans(old, fresh)
  const details = d.entries[0].details.join('；')
  assert.equal(d.breakingCount, 1)
  assert.match(details, /删除了必填参数 name/)
  assert.match(details, /删除了可选参数 note/)
})

test('HTTP 方法变更：身份对不上时按 工程+Controller+方法名 兜底配对', () => {
  const d = diffScans(ws([api({ httpMethod: 'PUT', path: '/api/user' })]), ws([api({ httpMethod: 'POST', path: '/api/user' })]))
  assert.equal(d.entries.length, 1)
  assert.equal(d.entries[0].breaking, true)
  assert.match(d.entries[0].details[0], /HTTP 方法变更 PUT → POST/)
  assert.match(d.entries[0].signature, /PUT \/api\/user → POST \/api\/user/)
})

test('接口删除是破坏性；接口新增不破坏；描述变更仅提示', () => {
  const d = diffScans(ws([api({ methodName: 'del', description: '旧' })]), ws([api({ methodName: 'new', description: '新' })]))
  assert.equal(d.breakingCount, 1)
  assert.equal(d.addedCount, 1)
  assert.equal(d.removedCount, 1)
  assert.match(d.entries.find((e) => e.kind === 'removed')?.details[0] ?? '', /404/)
})

test('apiDiffToMarkdown：破坏性置顶、无差异给明确结论', () => {
  const empty = apiDiffToMarkdown(diffScans(ws([api({})]), ws([api({})], 'f2')))
  assert.match(empty, /没有接口差异/)
  const d = diffScans(ws([api({ methodName: 'gone' })]), ws([api({})], 'f2'))
  const md = apiDiffToMarkdown(d)
  const breakIdx = md.indexOf('## 破坏性变更')
  const infoIdx = md.indexOf('## 仅提示')
  assert.ok(breakIdx >= 0 && breakIdx < infoIdx)
  assert.match(md, /接口被删除/)
})
