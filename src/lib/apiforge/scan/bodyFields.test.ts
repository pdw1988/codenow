import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTypeDict, fillBodyFields } from './bodyFields'
import type { ApiMethod, ProjectScanResult, WorkspaceScanResult } from '../types'

const api = (over: Partial<ApiMethod>): ApiMethod => ({
  id: 'a1',
  methodName: 'list',
  httpMethod: 'POST',
  path: '/api/shop/productCategory/list',
  parameters: [],
  requestBodyType: null,
  requestBodyFields: [],
  responseType: 'Map<String,Object>',
  description: '',
  controllerClass: 'PurchaseCityController',
  filePath: 'PurchaseCityController.java',
  projectId: 'p1',
  ...over,
})

const proj = (over: Partial<ProjectScanResult>): ProjectScanResult => ({
  projectId: 'p1',
  projectPath: 'D:/x/p1',
  projectName: 'p1',
  controllers: [],
  mappers: [],
  classUses: [],
  types: [],
  errors: [],
  ...over,
})

const ws = (projects: ProjectScanResult[]): WorkspaceScanResult => ({
  root: 'D:/work/shop/mobile/biz',
  scannedAt: '2026-09-11T00:00:00Z',
  fingerprint: 'f',
  projects,
  errors: [],
})

test('fillBodyFields：Controller 在 A 模块、DTO 在 B 模块也能补上（正主：productCategory）', () => {
  const out = fillBodyFields(
    ws([
      proj({
        projectId: 'assets',
        projectName: 'ruoyi-biz-order-service',
        controllers: [
          {
            className: 'PurchaseCityController',
            packageName: 'com.ruoyi',
            basePath: '/api/shop/productCategory',
            filePath: 'PurchaseCityController.java',
            description: '',
            author: '',
            date: '',
            methods: [api({ requestBodyType: 'PurchaseCityQueryRequest' })],
          },
        ],
      }),
      proj({
        projectId: 'mobileApi',
        projectName: 'ruoyi-biz-app-api',
        types: [
          {
            name: 'PurchaseCityQueryRequest',
            fields: [{ name: 'name', javaType: 'String', required: false, description: '城市名称' }],
          },
        ],
      }),
    ]),
  )
  const m = out.projects[0].controllers[0].methods[0]
  assert.deepEqual(m.requestBodyFields, [
    { name: 'name', javaType: 'String', required: false, description: '城市名称' },
  ])
})

test('fillBodyFields：扫描器自己解析出的那份不被字典盖掉（同模块比简名反查可信）', () => {
  const mine = [{ name: 'realField', javaType: 'Long', required: true }]
  const out = fillBodyFields(
    ws([
      proj({
        controllers: [
          {
            className: 'C',
            packageName: '',
            basePath: '',
            filePath: 'C.java',
            description: '',
            author: '',
            date: '',
            methods: [api({ requestBodyType: 'Req', requestBodyFields: mine })],
          },
        ],
        types: [{ name: 'Req', fields: [{ name: 'wrong', javaType: 'String', required: false }] }],
      }),
    ]),
  )
  assert.deepEqual(out.projects[0].controllers[0].methods[0].requestBodyFields, mine)
})

test('fillBodyFields：字典里没有的类型（List / PageCondition 这类）原样留空，不编字段', () => {
  const out = fillBodyFields(
    ws([
      proj({
        controllers: [
          {
            className: 'C',
            packageName: '',
            basePath: '',
            filePath: 'C.java',
            description: '',
            author: '',
            date: '',
            methods: [api({ requestBodyType: 'List' })],
          },
        ],
        types: [{ name: 'Other', fields: [{ name: 'x', javaType: 'String', required: false }] }],
      }),
    ]),
  )
  assert.deepEqual(out.projects[0].controllers[0].methods[0].requestBodyFields, [])
})

test('fillBodyFields：一条都没补到时原封不动返回（不改入参、不白白新建引用）', () => {
  const input = ws([proj({})])
  assert.equal(fillBodyFields(input), input)
})

test('buildTypeDict：简名撞车取字段多的那份，不依赖工程顺序', () => {
  const few = [{ name: 'a', javaType: 'String', required: false }]
  const many = [
    { name: 'a', javaType: 'String', required: false },
    { name: 'b', javaType: 'Long', required: false },
  ]
  const dictA = buildTypeDict([
    proj({ types: [{ name: 'SysUser', fields: few }] }),
    proj({ types: [{ name: 'SysUser', fields: many }] }),
  ])
  const dictB = buildTypeDict([
    proj({ types: [{ name: 'SysUser', fields: many }] }),
    proj({ types: [{ name: 'SysUser', fields: few }] }),
  ])
  assert.deepEqual(dictA.get('SysUser'), many)
  assert.deepEqual(dictB.get('SysUser'), many)
})

test('buildTypeDict：空字段的类型不进字典（否则会把真正有字段的同名类挡住）', () => {
  const dict = buildTypeDict([
    proj({ types: [{ name: 'Req', fields: [] }] }),
    proj({ types: [{ name: 'Req', fields: [{ name: 'a', javaType: 'String', required: false }] }] }),
  ])
  assert.equal(dict.get('Req')?.length, 1)
})
