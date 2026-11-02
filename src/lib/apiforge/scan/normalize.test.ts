import test from 'node:test'
import assert from 'node:assert/strict'
import { allApiMethods, fingerprintOf, joinPath, normalizeScanJson } from './normalize'
import { pagesStale } from '../page/pageLogic'

const GOOD = JSON.stringify({
  root: 'E:/work/demo',
  scannedAt: '2026-09-05T00:00:00Z',
  projects: [
    {
      projectPath: 'E:/work/demo',
      projectName: 'demo',
      controllers: [
        {
          className: 'UserController',
          packageName: 'com.demo.web',
          basePath: '/api/user',
          filePath: 'E:/work/demo/UserController.java',
          description: '用户管理',
          methods: [
            {
              methodName: 'create',
              httpMethod: 'POST',
              classBasePath: '/api/user',
              methodPath: '/create',
              parameters: [{ name: 'req', javaType: 'UserCreateReq', position: 'body', required: true }],
              requestBody: {
                type: 'UserCreateReq',
                fields: [{ name: 'userName', javaType: 'String', required: true, description: '用户名' }],
              },
              responseType: 'Long',
              description: '创建用户',
              controllerClass: 'UserController',
            },
            { methodName: 'bad', httpMethod: 'TRACE', classBasePath: '/api/user', methodPath: '/bad', parameters: [] },
          ],
        },
      ],
      mappers: [
        {
          namespace: 'com.demo.mapper.UserMapper',
          filePath: 'E:/work/demo/UserMapper.xml',
          statements: [{ id: 'insertUser', op: 'insert', tables: ['t_user'] }],
        },
      ],
      classUses: [{ className: 'com.demo.web.UserController', methodName: 'create', usedFieldTypes: ['UserService'] }],
      types: [
        {
          name: 'UserVO',
          fields: [{ name: 'id', javaType: 'Long', required: false, description: '主键' }],
        },
      ],
      errors: [{ file: 'Bad.java', message: '解析失败' }],
    },
  ],
  errors: [],
})

test('normalize：完整 JSON 归一化，坏 HTTP 方法（TRACE）被丢掉', () => {
  const ws = normalizeScanJson(GOOD)
  assert.ok(ws)
  assert.equal(ws.projects.length, 1)
  const apis = allApiMethods(ws)
  assert.equal(apis.length, 1)
  assert.equal(apis[0].path, '/api/user/create')
  assert.equal(apis[0].requestBodyFields[0].name, 'userName')
  assert.equal(apis[0].requestBodyFields[0].description, '用户名')
  assert.equal(ws.projects[0].types?.[0]?.fields[0]?.description, '主键')
  assert.equal(ws.projects[0].controllers[0].description, '用户管理')
  assert.equal(ws.projects[0].mappers[0].statements[0].tables[0], 't_user')
  assert.equal(ws.projects[0].errors[0].file, 'Bad.java')
})

test('normalize：0 接口的空工程（纯 DTO/jar 模块）整棵不展示，types 字典保留', () => {
  const withEmpty = JSON.stringify({
    root: 'E:/work/demo',
    scannedAt: '2026-09-05T00:00:00Z',
    projects: [
      // 纯 DTO 模块：没有 Controller，但 types 是跨工程补字段字典的来源
      {
        projectPath: 'E:/work/demo/api',
        projectName: 'demo-api',
        controllers: [],
        mappers: [],
        classUses: [],
        types: [{ name: 'SharedReq', fields: [{ name: 'token', javaType: 'String', required: true, description: '令牌' }] }],
        errors: [],
      },
      {
        projectPath: 'E:/work/demo/ghost',
        projectName: 'demo-ghost',
        // 有 Controller 文件但一个映射都没有，同样是空壳
        controllers: [
          {
            className: 'GhostController',
            packageName: 'com.demo.ghost',
            basePath: '/api/ghost',
            filePath: 'E:/work/demo/ghost/GhostController.java',
            methods: [],
          },
        ],
        mappers: [],
        classUses: [],
        types: [],
        errors: [],
      },
      {
        projectPath: 'E:/work/demo',
        projectName: 'demo',
        controllers: [
          {
            className: 'OrderController',
            packageName: 'com.demo.web',
            basePath: '/api/order',
            filePath: 'E:/work/demo/OrderController.java',
            methods: [
              {
                methodName: 'save',
                httpMethod: 'POST',
                classBasePath: '/api/order',
                methodPath: '/save',
                parameters: [{ name: 'req', javaType: 'SharedReq', position: 'body', required: true }],
                // DTO 在别的工程：scanner 出来时字段是空的，靠 fillBodyFields 跨工程补
                requestBody: { type: 'SharedReq', fields: [] },
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
    errors: [],
  })
  const ws = normalizeScanJson(withEmpty)
  assert.ok(ws)
  assert.deepEqual(
    ws.projects.map((p) => p.projectName),
    ['demo'],
  )
  // 空工程被滤掉，但它的 types 字典在滤之前参与了补字段
  const apis = allApiMethods(ws)
  assert.equal(apis[0].requestBodyFields[0].name, 'token')
  // 缓存 blob（已归一化 JSON）二次进来同样被滤
  const roundTrip = normalizeScanJson(JSON.stringify(ws))
  assert.ok(roundTrip)
  assert.equal(roundTrip.projects.length, 1)
})

test('normalize：路径拼接两边斜杠不重复', () => {
  assert.equal(joinPath('/api', '/list'), '/api/list')
  assert.equal(joinPath('api', 'list'), '/api/list')
  assert.equal(joinPath('/', ''), '/')
})

test('normalize：整份 JSON 坏 / 缺 root 返回 null，调用方按扫描失败处理', () => {
  assert.equal(normalizeScanJson('not json'), null)
  assert.equal(normalizeScanJson('{"projects":[]}'), null)
})

test('normalize：已归一化的 JSON（缓存/存档）二次归一化路径不退化成 /', () => {
  // 缓存 blob 和 CLI 扫描存档存的都是归一化后的形状：方法上只有拼好的 path，
  // 没有 classBasePath/methodPath 两段。这里模拟该形状走同一入口。
  const first = normalizeScanJson(GOOD)
  assert.ok(first)
  const roundTrip = normalizeScanJson(JSON.stringify(first))
  assert.ok(roundTrip)
  const before = allApiMethods(first).map((m) => m.path)
  const after = allApiMethods(roundTrip).map((m) => m.path)
  assert.deepEqual(after, before)
  assert.ok(after.every((p) => p.startsWith('/api')), JSON.stringify(after))
})

test('normalize：缓存二次归一化 body 不剥空（requestBodyType/Fields 双形状都认）', () => {
  // saveApply 实测：blob 里 body 平铺在顶层（requestBodyType/requestBodyFields），
  // 只认扫描器包裹形状（requestBody:{type,fields}）的话，开机载缓存把全工作区
  // body 剥成 null——试跑 BODY 只剩 {}，fillBodyFields 兜底也拿不到类型名
  const first = normalizeScanJson(GOOD)
  assert.ok(first)
  const roundTrip = normalizeScanJson(JSON.stringify(first))
  assert.ok(roundTrip)
  const m = allApiMethods(roundTrip).find((x) => x.methodName === 'create')
  assert.ok(m)
  assert.equal(m.requestBodyType, 'UserCreateReq')
  assert.deepEqual(
    m.requestBodyFields,
    [{ name: 'userName', javaType: 'String', required: true, description: '用户名' }],
  )

  // 更早的缓存连 requestBody 键都没有、只有平铺字段（手造该形状），一样要认
  const flat = normalizeScanJson(JSON.stringify({
    root: 'r',
    projects: [{
      projectPath: 'p',
      controllers: [{
        filePath: 'a.java',
        className: 'C',
        methods: [{
          methodName: 'save',
          httpMethod: 'POST',
          path: '/p/save',
          parameters: [{ name: 'condition', javaType: 'AddCondition', position: 'body', required: true }],
          requestBodyType: 'AddCondition',
          requestBodyFields: [{ name: 'brandOwnerId', javaType: 'Long', required: false, description: '品牌商id' }],
        }],
      }],
    }],
  }))
  assert.ok(flat)
  const fm = allApiMethods(flat)[0]
  assert.equal(fm.requestBodyType, 'AddCondition')
  assert.deepEqual(
    fm.requestBodyFields,
    [{ name: 'brandOwnerId', javaType: 'Long', required: false, description: '品牌商id' }],
  )
})

test('normalize：单方法缺字段不炸整次扫描', () => {
  const ws = normalizeScanJson(JSON.stringify({
    root: 'r',
    projects: [{ projectPath: 'p', controllers: [{ filePath: 'a.java', methods: [null, { httpMethod: 'GET' }, { methodName: 'm', httpMethod: 'GET' }] }] }],
  }))
  assert.ok(ws)
  // 无名方法被丢，有名字的留下
  assert.equal(allApiMethods(ws).length, 1)
})

test('normalize：Controller 按类名排序（扫描器 JSON 是 HashMap 桶序，看着是乱的）', () => {
  const ws = normalizeScanJson(JSON.stringify({
    root: 'r',
    projects: [{
      projectPath: 'p',
      // 每个控制器挂一个最小方法：0 接口的空工程会被整体滤掉（见空工程测试）
      controllers: [
        { filePath: 'b/UserController.java', className: 'UserController', packageName: 'a', methods: [m('ua')] },
        { filePath: 'c/UserController.java', className: 'UserController', packageName: 'b', methods: [m('ub')] },
        { filePath: 'a/OrderController.java', className: 'OrderController', packageName: 'z', methods: [m('o')] },
        { filePath: 'x/AdminController.java', className: 'AdminController', packageName: 'x', methods: [m('a')] },
      ],
    }],
  }))
  assert.ok(ws)
  assert.deepEqual(
    ws.projects[0].controllers.map((c) => `${c.className}@${c.packageName}`),
    ['AdminController@x', 'OrderController@z', 'UserController@a', 'UserController@b'],
  )
})

/** 排序测试用的最小方法：有 path 能活过归一化即可 */
function m(name: string) {
  return { methodName: name, httpMethod: 'GET', classBasePath: '/x', methodPath: `/${name}`, parameters: [] }
}

test('fingerprintOf：同输入同指纹，不同输入不同指纹', () => {
  assert.equal(fingerprintOf('abc'), fingerprintOf('abc'))
  assert.notEqual(fingerprintOf('abc'), fingerprintOf('abd'))
})

test('normalize：旧缓存没有 types / bizThrows 当空数组', () => {
  const ws = normalizeScanJson(JSON.stringify({
    root: 'r',
    projects: [{ projectPath: 'p', controllers: [{ className: 'C', packageName: 'p', filePath: 'C.java', methods: [m('c')] }] }],
  }))
  assert.ok(ws)
  assert.deepEqual(ws.projects[0].types, [])
  // 老缓存没有 bizThrows 键：当空数组（不是 undefined），用例生成才好回退注释推断
  assert.deepEqual(ws.projects[0].bizThrows, [])
})

test('normalize：bizThrows 往返不丢（开机载缓存是二次归一化），脏条目只丢那一条', () => {
  // 扫描器 JSON 是这个形状；缓存 blob 是归一化后的同一个形状再过一遍入口，
  // 所以「第二次进来把业务异常收集剥成空」会把已扫工程的异常用例全变回注释推断
  const raw = JSON.stringify({
    root: 'r',
    projects: [{
      projectPath: 'p',
      controllers: [{ className: 'C', packageName: 'p', filePath: 'C.java', methods: [m('c')] }],
      bizThrows: [
        {
          className: 'com.demo.svc.UserServiceImpl',
          methodName: 'create',
          throws: [
            { type: 'BizException', message: '品牌商id必填', fields: ['brandOwnerId'] },
            // 字段数组里的空串/null 是运输路上的噪音，丢掉；没 type 的 throw 也丢掉
            { type: 'BizException', message: '', fields: ['ok', '', null] },
            null,
            { message: '没有 type 的丢掉', fields: ['x'] },
          ],
        },
        // 没 className 的条目整条丢（链路上按类名索引，留着也查不到）
        { methodName: 'x', throws: [{ type: 'BizException', message: 'm', fields: [] }] },
      ],
    }],
  })
  const ws = normalizeScanJson(raw)
  assert.ok(ws)
  assert.deepEqual(ws.projects[0].bizThrows, [
    {
      className: 'com.demo.svc.UserServiceImpl',
      methodName: 'create',
      throws: [
        { type: 'BizException', message: '品牌商id必填', fields: ['brandOwnerId'] },
        { type: 'BizException', message: '', fields: ['ok'] },
      ],
    },
  ])
  const roundTrip = normalizeScanJson(JSON.stringify(ws))
  assert.ok(roundTrip)
  assert.deepEqual(roundTrip.projects[0].bizThrows, ws.projects[0].bizThrows)
})

const PAGE_SCAN = {
  root: 'D:/w',
  projects: [
    {
      projectPath: 'D:/w/admin-ui',
      controllers: [
        { filePath: 'A.java', className: 'A', methods: [{ methodName: 'list', httpMethod: 'GET', classBasePath: '/ui/a', methodPath: '/list' }] },
      ],
      pages: [
        {
          controllerClass: 'A', methodName: 'page', classBasePath: '/ui/a', methodPath: '/page', viewName: 'a/list',
          needsParams: false, ftlFile: 'D:/w/admin-ui/src/main/webapp/WEB-INF/views/a/list.ftl',
          ftlText: '<title>甲列表 - x</title><body>hi</body>',
        },
        { controllerClass: 'A', methodName: 'bad', classBasePath: '/ui/a', methodPath: '/bad', viewName: '' },
      ],
    },
  ],
}

test('页面：没找到模板的页面 profile 为 null；老缓存没有 pages 键当空数组', () => {
  const noFtl = structuredClone(PAGE_SCAN)
  noFtl.projects[0]!.pages = [{ controllerClass: 'A', methodName: 'p', classBasePath: '/ui/a', methodPath: '/p', viewName: 'a/p' }]
  assert.equal(normalizeScanJson(JSON.stringify(noFtl))!.projects[0]!.pages![0]!.profile, null)
  const old = structuredClone(PAGE_SCAN) as { projects: { pages?: unknown }[] }
  delete old.projects[0]!.pages
  assert.deepEqual(normalizeScanJson(JSON.stringify(old))!.projects[0]!.pages, [])
})

test('页面：没有一页算出画像（没页面 / 模板都没找到）不提醒重扫，重扫也没用', () => {
  const noFtl = structuredClone(PAGE_SCAN)
  noFtl.projects[0]!.pages = [{ controllerClass: 'A', methodName: 'p', classBasePath: '/ui/a', methodPath: '/p', viewName: 'a/p' }]
  assert.equal(pagesStale(normalizeScanJson(JSON.stringify(noFtl))!.projects[0]!), false)
  const none = structuredClone(PAGE_SCAN) as { projects: { pages?: unknown }[] }
  delete none.projects[0]!.pages
  assert.equal(pagesStale(normalizeScanJson(JSON.stringify(none))!.projects[0]!), false)
})
