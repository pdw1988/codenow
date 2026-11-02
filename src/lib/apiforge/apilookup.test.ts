import test from 'node:test'
import assert from 'node:assert/strict'
import { apisForTables } from './apilookup'
import type { ApiMethod, ProjectScanResult, WorkspaceScanResult } from './types'

const api = (over: Partial<ApiMethod>): ApiMethod => ({
  id: 'a1',
  methodName: 'create',
  httpMethod: 'POST',
  path: '/api/user/create',
  parameters: [],
  requestBodyType: null,
  requestBodyFields: [],
  responseType: '',
  description: '',
  controllerClass: 'UserController',
  filePath: '',
  projectId: 'p',
  ...over,
})

const project = (over: Partial<ProjectScanResult>): ProjectScanResult => ({
  projectId: 'p',
  projectPath: 'E:/demo',
  projectName: 'demo',
  controllers: [],
  mappers: [
    {
      namespace: 'com.demo.mapper.UserMapper',
      filePath: 'UserMapper.xml',
      statements: [{ id: 'insertUser', op: 'insert', tables: ['t_user'] }],
    },
    {
      namespace: 'com.demo.mapper.OrderMapper',
      filePath: 'OrderMapper.xml',
      statements: [{ id: 'insert', op: 'insert', tables: ['t_order'] }],
    },
  ],
  classUses: [
    { className: 'com.demo.web.UserController', methodName: 'create', usedFieldTypes: ['UserService'] },
    { className: 'com.demo.web.OrderController', methodName: 'create', usedFieldTypes: ['OrderMapper'] },
    { className: 'com.demo.svc.UserService', methodName: 'createUser', usedFieldTypes: ['UserMapper'] },
  ],
  errors: [],
  ...over,
})

const ws = (projects: ProjectScanResult[]): WorkspaceScanResult => ({
  root: 'E:/demo',
  scannedAt: '2026-09-25T00:00:00',
  fingerprint: 'f',
  projects,
  errors: [],
})

test('apisForTables：Mapper 链路命中 → 返回用到这张表的接口，字段带齐', () => {
  const p = project({
    controllers: [
      {
        className: 'UserController',
        packageName: 'com.demo.web',
        basePath: '/api/user',
        filePath: 'UserController.java',
        description: '',
        author: '',
        date: '',
        methods: [
          api({ id: 'a1' }),
          // 挂到没有调用边的 Controller：resolveLinks 对同类不同方法名有整类回退，
          // 这里要的是「调用边为空 = 真不沾」
          api({ id: 'a2', methodName: 'other', controllerClass: 'OtherController', path: '/other' }),
        ],
      },
    ],
  })
  const hits = apisForTables({ scan: ws([p]), links: {}, tables: ['t_user'] })
  // a1.create → UserService → UserMapper(t_user)；a2 的调用边为空，不沾
  assert.equal(hits.length, 1)
  assert.equal(hits[0].apiId, 'a1')
  assert.equal(hits[0].path, '/api/user/create')
  assert.equal(hits[0].controllerClass, 'UserController')
  assert.equal(hits[0].project, 'demo')
  assert.equal(hits[0].enabled, true)
})

test('apisForTables：大小写与 schema 前缀不影响匹配（连接里的表名大写、带前缀）', () => {
  const p = project({
    controllers: [
      {
        className: 'UserController',
        packageName: 'com.demo.web',
        basePath: '/api/user',
        filePath: 'UserController.java',
        description: '',
        author: '',
        date: '',
        methods: [api({ id: 'a1' })],
      },
    ],
  })
  assert.equal(apisForTables({ scan: ws([p]), links: {}, tables: ['T_USER'] }).length, 1)
  assert.equal(apisForTables({ scan: ws([p]), links: {}, tables: ['DEMO.T_USER'] }).length, 1)
})

test('apisForTables：用户手动加的表（store.links）也算命中，没启用的排后面', () => {
  const p = project({
    controllers: [
      {
        className: 'UserController',
        packageName: 'com.demo.web',
        basePath: '/api/user',
        filePath: 'UserController.java',
        description: '',
        author: '',
        date: '',
        methods: [api({ id: 'a-user', methodName: 'create' })],
      },
      {
        className: 'OrderController',
        packageName: 'com.demo.web',
        basePath: '/api/order',
        filePath: 'OrderController.java',
        description: '',
        author: '',
        date: '',
        methods: [api({ id: 'a-order', path: '/api/order/create', controllerClass: 'OrderController' })],
      },
    ],
  })
  const hits = apisForTables({
    scan: ws([p]),
    links: {
      // 手动加了一张 mapper 识别不到的表，且没勾启用
      'a-user': [{ tableName: 't_manual', confidence: 'user', source: '手动添加', enabled: false }],
    },
    tables: ['t_manual', 't_order'],
  })
  assert.deepEqual(hits.map((h) => h.apiId), ['a-order', 'a-user'])
  assert.equal(hits[0].enabled, true)
  assert.equal(hits[1].enabled, false)
})

test('apisForTables：用户取消启用的表不算 enabled（只提示能用，不标能对比）', () => {
  const p = project({
    controllers: [
      {
        className: 'UserController',
        packageName: 'com.demo.web',
        basePath: '/api/user',
        filePath: 'UserController.java',
        description: '',
        author: '',
        date: '',
        methods: [api({ id: 'a1' })],
      },
    ],
  })
  const hits = apisForTables({
    scan: ws([p]),
    // resolveLinks 给的 t_user 默认启用，用户手改成 false——mergeLinks 尊重手改
    links: { a1: [{ tableName: 't_user', confidence: 'mapper', source: 'x', enabled: false }] },
    tables: ['t_user'],
  })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].enabled, false)
})

test('apisForTables：命名推断的表不参与匹配（低可信默认关闭，不捞假关联）', () => {
  const p = project({ classUses: [] })
  const hits = apisForTables({ scan: ws([p]), links: {}, tables: ['user'] })
  assert.equal(hits.length, 0)
})

test('apisForTables：没给表名 → 空数组，不给跳转按钮当真', () => {
  const p = project({})
  assert.deepEqual(apisForTables({ scan: ws([p]), links: {}, tables: [] }), [])
  assert.deepEqual(apisForTables({ scan: ws([p]), links: {}, tables: ['  '] }), [])
})
