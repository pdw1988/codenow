import test from 'node:test'
import assert from 'node:assert/strict'
import {
  apiDiscoverLabel,
  capScanLog,
  controllerLabel,
  isMachineEvent,
  liveTreeFromLog,
  queueFromScan,
  scanQueueFromLog,
} from './queue'
import type { WorkspaceScanResult } from '../types'

// 与 jar 实测输出一致的双工程事件流（/tmp/apf-probe 探针验证过）
const LIVE_LOG = [
  'PROG projects 2',
  'PROG proj demo-a · demo-a',
  'PROG proj demo-b · demo-b',
  'PROG files 1 java / 1 xml · demo-a',
  'PROG parsing 1/1 AController.java',
  'PROG controller AController · 2 api',
  'PROG api GET /api/a/list · list',
  'PROG api POST /api/a/create · create',
  'PROG proj done demo-a · 2 api',
  'PROG files 1 java / 1 xml · demo-b',
  'PROG parsing 1/4 BController.java',
  'PROG controller BController · 1 api',
  'PROG api DELETE /api/b/{id} · delete',
]

test('队列：proj 行先建「等待」条目，随事件推进到完成', () => {
  const early = scanQueueFromLog(LIVE_LOG.slice(0, 3))
  assert.deepEqual(
    early.projects.map((p) => [p.name, p.status, p.relPath]),
    [
      ['demo-a', 'waiting', 'demo-a'],
      ['demo-b', 'waiting', 'demo-b'],
    ],
  )

  const mid = scanQueueFromLog(LIVE_LOG.slice(0, 8))
  assert.equal(mid.projects[0].status, 'parsing')
  assert.deepEqual(mid.projects[0].files, { done: 1, total: 1 })
  assert.equal(mid.projects[0].apis, 2)
  assert.deepEqual(mid.activeControllers, [{ name: 'AController', apis: 2 }])

  const full = scanQueueFromLog(LIVE_LOG)
  assert.equal(full.projects[0].status, 'done')
  assert.equal(full.projects[0].apis, 2)
  assert.equal(full.projects[1].status, 'parsing')
  assert.deepEqual(full.projects[1].files, { done: 1, total: 4 })
  assert.equal(full.projects[1].controllers, 1)
  // 完成的工程条目还在队列里；Controller 小节切到当前工程
  assert.deepEqual(full.activeControllers, [{ name: 'BController', apis: 1 }])
})

test('实时发现树：扫描中按 Controller 名分组挂接口（含方法名）', () => {
  const tree = liveTreeFromLog(LIVE_LOG)
  assert.deepEqual(
    tree.map((p) => [
      p.name,
      p.controllers.map((c) => [
        c.name,
        c.apis.map((a) => `${a.method} ${a.path} · ${a.name}`),
      ]),
    ]),
    [
      [
        'demo-a',
        [
          [
            'AController',
            ['GET /api/a/list · list', 'POST /api/a/create · create'],
          ],
        ],
      ],
      ['demo-b', [['BController', ['DELETE /api/b/{id} · delete']]]],
    ],
  )
  // 老 jar 不带 · 方法名：name 空串，路径仍要认全
  const legacy = liveTreeFromLog([
    'PROG files 1 java / 0 xml · old',
    'PROG controller OldController · 1 api',
    'PROG api GET /legacy',
  ])
  assert.deepEqual(legacy[0].controllers[0].apis, [{ method: 'GET', path: '/legacy', name: '' }])
})

test('机器事件行判据：协议行认，人话解析块不认', () => {
  assert.ok(isMachineEvent('PROG projects 2'))
  assert.ok(isMachineEvent('PROG files 3 java / 1 xml · demo'))
  assert.ok(isMachineEvent('PROG parsing 1/9 A.java'))
  assert.ok(isMachineEvent('PROG controller AController · 2 api'))
  assert.ok(isMachineEvent('PROG proj done demo-a · 2 api'))
  assert.ok(isMachineEvent('PROG err A.java 解析失败已跳过'))
  // 人话解析块同样带 PROG 前缀（README「人话解析块」），但它要上屏，不是机器行
  assert.ok(!isMachineEvent('PROG ════════ 工程 demo ════════'))
  assert.ok(!isMachineEvent('PROG   ▶ 检测到 @RestController：AController'))
  assert.ok(!isMachineEvent('PROG        参数 @RequestParam status:String'))
  assert.ok(!isMachineEvent('PROG     ▸ [1/3] GET /api/a'))
})

test('流水封顶只封人话行：机器行的 files 锚必须活到最后', () => {
  // 实测形状：兜底阶段一行一个 DTO，先把窗口占满，第一个 controller 行晚于它到达
  const lines = ['PROG files 3 java / 0 xml · demo']
  for (let i = 0; i < 260; i++) lines.push(`PROG   dto D${i} 字段来自跨工程源码 x.java`)
  lines.push('PROG controller DemoController · 1 api', 'PROG api GET /demo · get')

  const capped = capScanLog(lines)
  // 机器行一条不丢（锚在，树才认得「当前工程」）
  assert.equal(capped.filter(isMachineEvent).length, 3)
  // 人话行按上限截断，进 <pre> 渲染的只有它们
  assert.equal(capped.filter((l) => !isMachineEvent(l)).length, 200)
  // 封顶之后照样还原得出树 —— 整条流水 slice(-199) 的旧写法正是死在这一步
  assert.deepEqual(
    liveTreeFromLog(capped).map((p) => [p.name, p.controllers[0]?.name, p.controllers[0]?.apis.length]),
    [['demo', 'DemoController', 1]],
  )
  // 没到上限就一行不动
  assert.deepEqual(capScanLog(lines.slice(0, 5)), lines.slice(0, 5))
})

test('队列：jar 模式 files 行写 class 而非 java，队列与实时树照常还原', () => {
  const log = [
    'PROG projects 1',
    'PROG proj user-service.jar · jar 包',
    'PROG files 22 class / 1 xml · user-service.jar',
    'PROG parsing 20/22 UserController.class',
    'PROG controller UserController · 2 api',
    'PROG api GET /api/v1/users/{id} · getUser',
    'PROG api POST /api/v1/users · createUser',
    'PROG proj done user-service.jar · 2 api',
  ]
  const q = scanQueueFromLog(log)
  assert.equal(q.projects.length, 1)
  assert.equal(q.projects[0].name, 'user-service.jar')
  assert.equal(q.projects[0].status, 'done')
  assert.equal(q.projects[0].apis, 2)
  assert.deepEqual(q.projects[0].files, { done: 20, total: 22 })
  assert.deepEqual(q.activeControllers, [{ name: 'UserController', apis: 2 }])
  assert.deepEqual(
    liveTreeFromLog(log).map((p) => [
      p.name,
      p.controllers[0]?.name,
      p.controllers[0]?.apis.map((a) => `${a.method} ${a.path}`),
    ]),
    [['user-service.jar', 'UserController', ['GET /api/v1/users/{id}', 'POST /api/v1/users']]],
  )
})

test('apiDiscoverLabel：方法名 · 说明，缺一不硬凑分隔符', () => {
  assert.equal(apiDiscoverLabel({ methodName: 'list', description: '列表' }), 'list · 列表')
  assert.equal(apiDiscoverLabel({ name: 'list' }), 'list')
  assert.equal(apiDiscoverLabel({ description: '列表' }), '列表')
  assert.equal(apiDiscoverLabel({}), '')
})

test('controllerLabel：有业务名拼「类名 · 业务名」', () => {
  assert.equal(controllerLabel({ className: 'UserController' }), 'UserController')
  assert.equal(
    controllerLabel({ className: 'UserController', description: '用户管理' }),
    'UserController · 用户管理',
  )
})

test('队列：proj fail 标失败，不打断后续工程', () => {
  const q = scanQueueFromLog([
    'PROG projects 2',
    'PROG proj bad · bad',
    'PROG proj good · good',
    'PROG files 0 java / 0 xml · bad',
    'PROG proj fail bad',
    'PROG files 2 java / 0 xml · good',
    'PROG proj done good · 0 api',
  ])
  assert.equal(q.projects[0].status, 'fail')
  assert.equal(q.projects[1].status, 'done')
})

test('队列：老扫描器（无 proj 事件行）也能兜底出条目', () => {
  const q = scanQueueFromLog([
    'PROG files 3 java / 1 xml · demo',
    'PROG parsing 3/3 Z.java',
    'PROG controller DemoController · 1 api',
    'PROG api GET /demo',
  ])
  assert.equal(q.projects.length, 1)
  assert.equal(q.projects[0].name, 'demo')
  assert.equal(q.projects[0].status, 'parsing')
  assert.equal(q.projects[0].apis, 1)
  assert.deepEqual(q.activeControllers, [{ name: 'DemoController', apis: 1 }])
})

test('队列：扫完后的权威队列直接从缓存结果出', () => {
  const ws = {
    root: 'E:/work',
    scannedAt: '2026-09-05T00:00:00Z',
    fingerprint: '',
    projects: [
      {
        projectId: 'E:/work/demo-a',
        projectPath: 'E:/work/demo-a',
        projectName: 'demo-a',
        fingerprint: 'aa',
        controllers: [
          {
            className: 'AController',
            packageName: 'demo',
            basePath: '/api/a',
            filePath: 'x',
            description: '模块A',
            methods: [{}, {}],
          },
        ],
        mappers: [],
        classUses: [],
        errors: [],
      },
      {
        projectId: 'E:/work/demo-b',
        projectPath: 'E:/work/demo-b',
        projectName: 'demo-b',
        fingerprint: 'bb',
        controllers: [
          {
            className: 'BController',
            packageName: 'demo',
            basePath: '/api/b',
            filePath: 'y',
            description: '',
            methods: [{}],
          },
        ],
        mappers: [],
        classUses: [],
        errors: [],
      },
    ],
    errors: [],
  } as unknown as WorkspaceScanResult
  const q = queueFromScan(ws)
  assert.deepEqual(
    q.projects.map((p) => [p.name, p.status, p.relPath, p.apis]),
    [
      ['demo-a', 'done', 'demo-a', 2],
      ['demo-b', 'done', 'demo-b', 1],
    ],
  )
  // 扫完不挂「当前工程 Controller」——中间栏已有完整树，挂在这只会跟 flex 空洞叠出空白
  assert.deepEqual(q.activeControllers, [])
  assert.deepEqual(queueFromScan({ ...ws, projects: [ws.projects[0]] }).activeControllers, [])
})
