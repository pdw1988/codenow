import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorkspaceScanResult } from '../types'
import { ALL_SCOPE, applyRunScope, isAllScope, scopeFits, scopeLabel, scopedApiCount } from './scope'

/** 两个工程、其中 UserController 跨工程重名——范围语义最容易被这个名字考倒 */
const ws: WorkspaceScanResult = {
  root: 'E:/work',
  scannedAt: '2026-09-13T10:00:00Z',
  fingerprint: 'fp',
  errors: [],
  projects: [
    {
      projectId: 'user-svc',
      projectPath: 'E:/work/user-service',
      projectName: 'user-service',
      controllers: [
        {
          className: 'UserController',
          packageName: 'com.demo',
          basePath: '/api/users',
          filePath: 'E:/work/user-service/UserController.java',
          description: '',
          author: '',
          date: '',
          methods: [
            {
              id: 'u1',
              methodName: 'list',
              httpMethod: 'GET',
              path: '/api/users',
              parameters: [],
              requestBodyType: null,
              requestBodyFields: [],
              responseType: 'void',
              description: '',
              controllerClass: 'UserController',
              filePath: 'E:/work/user-service/UserController.java',
              projectId: 'user-svc',
            },
          ],
        },
        {
          className: 'HealthController',
          packageName: 'com.demo',
          basePath: '',
          filePath: 'E:/work/user-service/HealthController.java',
          description: '',
          author: '',
          date: '',
          methods: [
            {
              id: 'h1',
              methodName: 'health',
              httpMethod: 'GET',
              path: '/health',
              parameters: [],
              requestBodyType: null,
              requestBodyFields: [],
              responseType: 'void',
              description: '',
              controllerClass: 'HealthController',
              filePath: 'E:/work/user-service/HealthController.java',
              projectId: 'user-svc',
            },
          ],
        },
      ],
      mappers: [],
      classUses: [],
      types: [],
      errors: [],
    },
    {
      projectId: 'order-svc',
      projectPath: 'E:/work/order-service',
      projectName: 'order-service',
      controllers: [
        {
          className: 'UserController',
          packageName: 'com.demo',
          basePath: '/api/orders/users',
          filePath: 'E:/work/order-service/UserController.java',
          description: '',
          author: '',
          date: '',
          methods: [
            {
              id: 'o1',
              methodName: 'list',
              httpMethod: 'GET',
              path: '/api/orders/users',
              parameters: [],
              requestBodyType: null,
              requestBodyFields: [],
              responseType: 'void',
              description: '',
              controllerClass: 'UserController',
              filePath: 'E:/work/order-service/UserController.java',
              projectId: 'order-svc',
            },
          ],
        },
      ],
      mappers: [],
      classUses: [],
      types: [],
      errors: [],
    },
  ],
}

const classNamesOf = (w: WorkspaceScanResult): string[] =>
  w.projects.flatMap((p) => p.controllers.map((c) => c.className)).sort()

test('空范围原样返回，isAllScope 认它', () => {
  assert.ok(isAllScope(ALL_SCOPE))
  assert.ok(applyRunScope(ws, ALL_SCOPE) === ws)
})

test('按工程（服务）过滤：只留该工程的 Controller', () => {
  const out = applyRunScope(ws, { projectId: 'order-svc' })
  assert.deepEqual(out.projects.map((p) => p.projectId), ['order-svc'])
  assert.deepEqual(classNamesOf(out), ['UserController'])
})

test('按 Controller 过滤：跨工程重名的同名类都留下', () => {
  const out = applyRunScope(ws, { controllerClass: 'UserController' })
  assert.deepEqual(classNamesOf(out), ['UserController', 'UserController'])
  assert.equal(out.projects.length, 2)
})

test('范围命中为空：工程全被剔除', () => {
  assert.deepEqual(applyRunScope(ws, { controllerClass: 'NopeController' }).projects, [])
  assert.deepEqual(applyRunScope(ws, { projectId: 'gone' }).projects, [])
})

test('scopeFits：换目录后上次圈的工程不在了就不算数', () => {
  assert.ok(scopeFits(ws, ALL_SCOPE))
  assert.ok(scopeFits(ws, { projectId: 'order-svc' }))
  assert.ok(!scopeFits(ws, { projectId: 'gone' }))
  assert.ok(!scopeFits(ws, { controllerClass: 'NopeController' }))
})

test('scopeLabel：全部 / 工程名 / 类名 / 组合，找不到 id 回退原始值', () => {
  assert.equal(scopeLabel(ws, ALL_SCOPE), '全部')
  assert.equal(scopeLabel(ws, { projectId: 'user-svc' }), 'user-service')
  assert.equal(scopeLabel(ws, { projectId: 'gone' }), 'gone')
  assert.equal(scopeLabel(ws, { controllerClass: 'UserController' }), 'UserController')
  assert.equal(scopeLabel(ws, { projectId: 'user-svc', controllerClass: 'UserController' }), 'user-service · UserController')
  assert.equal(scopeLabel(null, { controllerClass: 'UserController' }), 'UserController')
})

test('scopedApiCount：全量 = 3 个接口，单工程 = 2，单 Controller 跨工程 = 2', () => {
  assert.equal(scopedApiCount(ws, ALL_SCOPE), 3)
  assert.equal(scopedApiCount(ws, { projectId: 'user-svc' }), 2)
  assert.equal(scopedApiCount(ws, { controllerClass: 'UserController' }), 2)
  assert.equal(scopedApiCount(ws, { controllerClass: 'NopeController' }), 0)
})
