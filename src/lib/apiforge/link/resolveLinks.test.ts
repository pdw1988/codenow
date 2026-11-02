import test from 'node:test'
import assert from 'node:assert/strict'
import { enabledTables, mergeLinks, namingGuess, resolveLinks } from './resolveLinks'
import type { ApiMethod, ProjectScanResult } from '../types'

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
      statements: [
        { id: 'insertUser', op: 'insert', tables: ['t_user'] },
        { id: 'selectById', op: 'select', tables: ['t_user'] },
      ],
    },
    {
      namespace: 'com.demo.mapper.OrderMapper',
      filePath: 'OrderMapper.xml',
      statements: [{ id: 'insert', op: 'insert', tables: ['t_order'] }],
    },
  ],
  classUses: [
    { className: 'com.demo.web.UserController', methodName: 'create', usedFieldTypes: ['UserService'] },
    { className: 'com.demo.svc.UserService', methodName: 'createUser', usedFieldTypes: ['UserMapper'] },
    { className: 'com.demo.svc.UserService', methodName: 'other', usedFieldTypes: ['OrderMapper'] },
  ],
  errors: [],
  ...over,
})

test('resolveLinks：Controller → Service → Mapper 两层走通，表名小写化', () => {
  const links = resolveLinks(api({ methodName: 'create' }), project({}), false)
  // Controller.create → UserService；Service 里同名方法是 createUser（方法名不一致走整类回退），
  // 所以 UserMapper + OrderMapper 都会被收进来
  assert.deepEqual(links.map((l) => l.tableName).sort(), ['t_order', 't_user'])
  assert.ok(links.every((l) => l.confidence === 'mapper' && l.enabled))
})

test('resolveLinks：Mapper 命中后不再往深处走（叶子）', () => {
  const links = resolveLinks(api({ methodName: 'getUser' }), project({
    classUses: [
      { className: 'com.demo.web.UserController', methodName: 'getUser', usedFieldTypes: ['UserMapper'] },
    ],
  }), false)
  assert.deepEqual(links.map((l) => l.tableName), ['t_user'])
})

test('resolveLinks：没有任何命中 + 开命名推断 → user（默认不启用）', () => {
  const links = resolveLinks(api({}), project({ classUses: [] }), true)
  assert.equal(links.length, 1)
  assert.equal(links[0].tableName, 'user')
  assert.equal(links[0].confidence, 'naming')
  assert.equal(links[0].enabled, false)
})

test('resolveLinks：已有 mapper 命中时命名推断不再叠加', () => {
  const links = resolveLinks(api({}), project({}), true)
  assert.equal(links.some((l) => l.confidence === 'naming'), false)
})

test('namingGuess：剥 Controller 后缀再蛇形化', () => {
  const g = namingGuess(api({ controllerClass: 'UserAccountController' }))
  assert.equal(g?.tableName, 'user_account')
  assert.equal(namingGuess(api({ controllerClass: '' })), null)
})

test('mergeLinks：重扫保留用户勾选状态；用户手加的表不丢', () => {
  const fresh = resolveLinks(api({}), project({}), false)
  const userHit = fresh.find((l) => l.tableName === 't_user')!
  const previous = [
    { ...userHit, enabled: false },
    { tableName: 'manual_table', confidence: 'user' as const, source: '手动添加', enabled: true },
  ]
  const merged = mergeLinks(fresh, previous)
  const hit = merged.find((l) => l.tableName === 't_user')
  assert.equal(hit?.enabled, false)
  assert.ok(merged.some((l) => l.tableName === 'manual_table' && l.enabled))
})

test('enabledTables：只回勾选的表，去重', () => {
  const links = [
    { tableName: 'T_user', confidence: 'mapper' as const, source: 'x', enabled: true },
    { tableName: 't_user', confidence: 'naming' as const, source: 'y', enabled: true },
    { tableName: 't_order', confidence: 'naming' as const, source: 'y', enabled: false },
  ]
  assert.deepEqual(enabledTables(links), ['t_user'])
})
