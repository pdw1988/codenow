import test from 'node:test'
import assert from 'node:assert/strict'
import { bodyValueOf, bodyValueOfField, buildBody, bizThrowsForApi, expectedDbChangeOf, generateCases, refreshStaleBodies } from './generate'
import type { ApiMethod, BizThrowDetail, ProjectScanResult, TestCase, WorkspaceScanResult } from '../types'
import type { TypeDict } from '../scan/bodyFields'

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

test('expectedDbChange：POST→insert、PUT/PATCH→update、DELETE→delete、GET→none', () => {
  assert.equal(expectedDbChangeOf('POST'), 'insert')
  assert.equal(expectedDbChangeOf('PUT'), 'update')
  assert.equal(expectedDbChangeOf('PATCH'), 'update')
  assert.equal(expectedDbChangeOf('DELETE'), 'delete')
  assert.equal(expectedDbChangeOf('GET'), 'none')
})

test('generateCases：正常 + 逐个缺必填异常 + 边界', () => {
  const apiDef = api({
    httpMethod: 'POST',
    parameters: [
      { name: 'name', javaType: 'String', position: 'query', required: true },
      { name: 'age', javaType: 'Integer', position: 'query', required: true },
    ],
  })
  const cases = generateCases(apiDef)
  const types = cases.map((c) => c.type)
  assert.equal(types[0], 'normal')
  // 两个必填参数各一条异常
  assert.equal(types.filter((t) => t === 'exception').length, 2)
  // String 两个边界值 + Integer 两个边界值
  assert.equal(types.filter((t) => t === 'boundary').length, 4)
  // 正常用例参数齐全（值是显示值字符串，发请求时才拼 URL）
  // 字符串字段走语义字典：name → 人名，不再是一律 test_demo（后者过不了校验）
  assert.match(String(cases[0].parameters.name), /^[一-龥]{2,3}$/)
  assert.equal(cases[0].parameters.age, '1')
})

test('generateCases：边界用例期望 2xx——边界值是合法请求，不是「随便返什么都行」', () => {
  // 正主：`/flow/def/list` 的 keyword 是 @RequestParam(required=false)，
  // keyword= 空串完全合法，服务端返 200；原来期望给空数组，200 反而被判失败。
  const cases = generateCases(
    api({ parameters: [{ name: 'keyword', javaType: 'String', position: 'query', required: false }] }),
  )
  const boundary = cases.filter((c) => c.type === 'boundary')
  assert.ok(boundary.length > 0)
  for (const c of boundary) assert.deepEqual(c.expectedHttpStatus, [200, 201])
})

test('generateCases：id 形字段边界只发数字 0/-1——发空串/超长串会在 Long 反序列化处假失败', () => {
  // 正主：IdCondition.id 在 DTO 里是 String，语义却是 Long 主键。
  // 旧的 String 边界给它发 '' 和 'aaa…'，后端反序列化直接 400，用户读成接口挂了。
  const apiDef = api({
    requestBodyType: 'IdCondition',
    requestBodyFields: [{ name: 'id', javaType: 'String', required: false }],
  })
  const boundary = generateCases(apiDef).filter((c) => c.type === 'boundary')
  assert.equal(boundary.length, 2)
  assert.deepEqual(
    boundary.map((c) => JSON.parse(c.parameters.__body as string).id),
    [0, -1],
  )
  // query 里的 id 形参数同口径（URL 里反正都是字符串，发 '0'/'-1'）
  const q = generateCases(
    api({ parameters: [{ name: 'brandOwnerId', javaType: 'String', position: 'query', required: false }] }),
  ).filter((c) => c.type === 'boundary')
  assert.deepEqual(q.map((c) => c.parameters.brandOwnerId), ['0', '-1'])
})

test('generateCases：异常用例期望留空 = 不校验（SHOP 把 Spring 的 400 包成什么还没实测）', () => {
  const cases = generateCases(
    api({ parameters: [{ name: 'name', javaType: 'String', position: 'query', required: true }] }),
  )
  const exc = cases.filter((c) => c.type === 'exception')
  assert.ok(exc.length > 0)
  for (const c of exc) assert.deepEqual(c.expectedHttpStatus, [])
})

test('generateCases：认不出查增改删的非分页接口正常 body 就是空对象；异常用例必填字段置空串', () => {
  const apiDef = api({
    path: '/api/user/process',
    requestBodyType: 'UserReq',
    requestBodyFields: [
      { name: 'userName', javaType: 'String', required: true },
      { name: 'age', javaType: 'Integer', required: false },
    ],
  })
  const cases = generateCases(apiDef)
  const normal = cases.find((c) => c.type === 'normal')!
  // 冒烟不发大请求：字段全填只会把业务校验（BizException）的路径全跳过去，
  // 真实字段覆盖交给异常/边界用例（那边走 buildBody 全量造）
  assert.equal(normal.parameters.__body, '{}')

  const ex = cases.find((c) => c.type === 'exception' && c.name.includes('body'))!
  const exBody = JSON.parse(ex.parameters.__body as string)
  assert.equal(exBody.userName, '')
})

test('buildBody：扫描不到字段清单时给 {} —— 不编造字段名', () => {
  assert.equal(buildBody(api({ requestBodyType: 'Unknown' }), {}), '{}')
})

test('bodyValueOf：集合给 []、布尔给 true、数字给 1', () => {
  assert.deepEqual(bodyValueOf('List<String>'), [])
  // 老缓存里扫描器剥过泛型，裸 List 也要认出来是集合
  assert.deepEqual(bodyValueOf('List'), [])
  assert.deepEqual(bodyValueOf('ArrayList'), [])
  assert.equal(bodyValueOf('Boolean'), true)
  assert.equal(bodyValueOf('Long'), 1)
})

test('正常用例：列表有分页时只带分页，不填筛选（连通，别把结果筛空）', () => {
  const apiDef = api({
    methodName: 'list',
    httpMethod: 'GET',
    path: '/api/shop/flow/instance/list',
    parameters: [
      { name: 'keyword', javaType: 'String', position: 'query', required: false },
      { name: 'flowStatus', javaType: 'String', position: 'query', required: false },
      { name: 'createBy', javaType: 'String', position: 'query', required: false },
      { name: 'pageNum', javaType: 'Integer', position: 'query', required: false },
      { name: 'pageSize', javaType: 'Integer', position: 'query', required: false },
    ],
  })
  const normal = generateCases(apiDef).find((c) => c.type === 'normal')!
  assert.equal(normal.name, '正常·list')
  assert.equal(normal.parameters.pageNum, '1')
  assert.equal(normal.parameters.pageSize, '10')
  assert.equal(normal.parameters.keyword, undefined)
  assert.equal(normal.parameters.flowStatus, undefined)
  assert.equal(normal.parameters.createBy, undefined)
})

test('正常用例：有分页时 path 和必填仍给，可选筛选仍不给', () => {
  const apiDef = api({
    methodName: 'page',
    httpMethod: 'GET',
    path: '/api/order/{orgId}',
    parameters: [
      { name: 'orgId', javaType: 'Long', position: 'path', required: true },
      { name: 'status', javaType: 'String', position: 'query', required: true },
      { name: 'keyword', javaType: 'String', position: 'query', required: false },
      { name: 'page', javaType: 'Integer', position: 'query', required: false },
      { name: 'size', javaType: 'Integer', position: 'query', required: false },
    ],
  })
  const normal = generateCases(apiDef).find((c) => c.type === 'normal')!
  assert.equal(normal.parameters.orgId, '1')
  // 状态类字段给 0~9 的小整数串（字典里的 status 规则），不是 test_demo
  assert.match(String(normal.parameters.status), /^\d$/)
  assert.equal(normal.parameters.page, '1')
  assert.equal(normal.parameters.size, '10')
  assert.equal(normal.parameters.keyword, undefined)
})

test('正常用例：没有分页的可选 query 也不填（最小合法，不是给齐假值）', () => {
  const apiDef = api({
    methodName: 'get',
    httpMethod: 'GET',
    parameters: [
      { name: 'name', javaType: 'String', position: 'query', required: false },
    ],
  })
  const normal = generateCases(apiDef).find((c) => c.type === 'normal')!
  assert.equal(normal.parameters.name, undefined)
})

test('正常用例：body 带分页字段时只发分页，不发筛选（列表接口默认分页参数就行）', () => {
  const apiDef = api({
    methodName: 'query',
    httpMethod: 'POST',
    path: '/api/user/query',
    requestBodyType: 'QueryReq',
    requestBodyFields: [
      { name: 'keyword', javaType: 'String', required: false },
      { name: 'pageNum', javaType: 'Integer', required: false },
      { name: 'pageSize', javaType: 'Integer', required: false },
    ],
  })
  const body = JSON.parse(
    generateCases(apiDef).find((c) => c.type === 'normal')!.parameters.__body as string,
  )
  // 分页不是筛选条件：页码 1 / 每页 10 防一次拉全表；keyword 发个值反而把列表筛空
  assert.deepEqual(body, { pageNum: 1, pageSize: 10 })
})

test('用例上限：异常用例多的接口截到 30 条', () => {
  const apiDef = api({
    parameters: Array.from({ length: 40 }, (_, i) => ({
      name: `p${i}`,
      javaType: 'String',
      position: 'query' as const,
      required: true,
    })),
  })
  assert.equal(generateCases(apiDef).length, 30)
})

test('buildBody/冒烟：List<UserReq> 集合 body 的 JSON 是数组（契约是元素列表）', () => {
  const listApi = api({
    path: '/api/user/process',
    requestBodyType: 'List<UserReq>',
    requestBodyFields: [{ name: 'userName', javaType: 'String', required: true }],
  })
  const elemsOf = (json: string) => JSON.parse(json) as Array<Record<string, unknown>>
  // 元素里的字符串字段同样走字典（userName → 人名）
  assert.match(String(elemsOf(buildBody(listApi, {}))[0].userName), /^[一-龥]{2,3}$/)
  assert.deepEqual(elemsOf(buildBody(listApi, { userName: 'a' })), [{ userName: 'a' }])
  const normal = generateCases(listApi).find((c) => c.type === 'normal')!
  // 非分页接口的正常用例就是空数组：不发编出来的元素
  assert.equal(normal.parameters.__body, '[]')
  // 反查不到元素字段（List<String>）也是最小合法的空数组
  assert.equal(buildBody(api({ requestBodyType: 'List<String>' }), {}), '[]')
})

test('业务异常用例：注释说必填但注解没有（实测 brandOwnerId）→ 摘字段发，期望 200/400', () => {
  const apiDef = api({
    requestBodyType: 'OrderAddCondition',
    requestBodyFields: [
      { name: 'brandOwnerId', javaType: 'Long', required: false, description: '品牌商id,必填。' },
      { name: 'remark', javaType: 'String', required: false, description: '申请备注,选填' },
    ],
  })
  const cases = generateCases(apiDef)
  const biz = cases.filter((c) => c.name.includes('异常·业务·'))
  // 选填的 remark 不造业务用例
  assert.equal(biz.length, 1)
  assert.equal(biz[0].name, '异常·业务·brandOwnerId 必填缺失')
  const body = JSON.parse(biz[0].parameters.__body as string)
  assert.equal(body.brandOwnerId, undefined)
  // remark 的注释写着「备注」→ 字典的备注规则给中文文本
  assert.equal(body.remark, '测试数据')
  // 业务异常被全局处理器优雅接住怎么回都行，回 500 就是崩了
  assert.deepEqual(biz[0].expectedHttpStatus, [200, 400])
})

test('业务异常用例：至少一条给空数组（裸 List 也认）、长度上限给超长、数值范围给越界', () => {
  const apiDef = api({
    requestBodyType: 'Req',
    requestBodyFields: [
      { name: 'detailList', javaType: 'List', required: false, description: '申请明细。一行明细 = 一条关联(品种+供应商),至少一条' },
      { name: 'userName', javaType: 'String', required: false, description: '姓名,不超过50字符' },
      { name: 'age', javaType: 'Integer', required: false, description: '年龄 0-100' },
    ],
  })
  const cases = generateCases(apiDef)
  const byName = (s: string) => cases.find((c) => c.name === `异常·业务·${s}`)!
  // 中文数字转阿拉伯：用例名是「至少1条却给空」
  assert.deepEqual(JSON.parse(byName('detailList 至少1条却给空').parameters.__body as string).detailList, [])
  assert.equal(JSON.parse(byName('userName 超长(51字)').parameters.__body as string).userName.length, 51)
  assert.equal(JSON.parse(byName('age 越界(101)').parameters.__body as string).age, 101)
})

test('业务异常用例：选填/日期区间/无描述不生成（日期 "2026-01" 命中范围正则但 lo>hi 淘汰）', () => {
  const apiDef = api({
    requestBodyType: 'Req',
    requestBodyFields: [
      { name: 'remark', javaType: 'String', required: false, description: '申请备注,选填' },
      { name: 'createDate', javaType: 'Date', required: false, description: '创建时间 2026-01-01 到 2026-12-31' },
      { name: 'note', javaType: 'String', required: false },
    ],
  })
  const biz = generateCases(apiDef).filter((c) => c.name.includes('异常·业务·'))
  assert.deepEqual(biz, [])
})

test('业务异常用例：集合 body 的违例 JSON 仍是数组（契约是元素列表）', () => {
  const listApi = api({
    requestBodyType: 'List<UserReq>',
    requestBodyFields: [{ name: 'userName', javaType: 'String', required: true, description: '姓名,必填' }],
  })
  const biz = generateCases(listApi).find((c) => c.name === '异常·业务·userName 必填缺失')!
  assert.deepEqual(JSON.parse(biz.parameters.__body as string), [{}])
})

test('业务异常用例：字段说明丢了就从 types 字典回查（实测 requestBodyFields 只剩 23% 说明）', () => {
  const apiDef = api({
    requestBodyType: 'AddCondition',
    requestBodyFields: [{ name: 'brandOwnerId', javaType: 'Long', required: false }],
  })
  const dict: TypeDict = new Map([
    ['AddCondition', [{ name: 'brandOwnerId', javaType: 'Long', required: false, description: '品牌商id,必填。' }]],
  ])
  const biz = generateCases(apiDef, dict).filter((c) => c.name.includes('异常·业务·'))
  assert.equal(biz.length, 1)
  assert.equal(biz[0].name, '异常·业务·brandOwnerId 必填缺失')
})

test('refreshStaleBodies：{} 现在就是冒烟形状，不算陈旧；没字段表/手填的都不动', () => {
  const apiDef = api({
    requestBodyType: 'UserReq',
    requestBodyFields: [
      { name: 'userName', javaType: 'String', required: true },
      { name: 'age', javaType: 'Integer', required: false },
    ],
  })
  const stale: TestCase[] = [
    { id: 'a1#normal#1', name: '正常·create', type: 'normal', parameters: { __body: '{}' }, expectedHttpStatus: [200, 201], expectedDbChange: 'insert', enabled: true },
    { id: 'a1#normal#2', name: '手填过', type: 'normal', parameters: { __body: '{"userName":"我填的"}' }, expectedHttpStatus: [200, 201], expectedDbChange: 'insert', enabled: true },
  ]
  // 冒烟 body 本来就是 {}，重写一遍还是同一个值，不算刷新（省一次持久化）
  assert.equal(refreshStaleBodies(apiDef, stale), null)
  // 没有字段表（List<String>/String body）没东西可刷；用户填过内容的也不动
  assert.equal(refreshStaleBodies(api({ requestBodyType: 'String' }), stale), null)
  const filled: TestCase[] = [{ ...stale[0], parameters: { __body: '{"userName":"x"}' } }]
  assert.equal(refreshStaleBodies(apiDef, filled), null)
})

test('refreshStaleBodies：老用例里固化的 test_demo 刷成当前冒烟形状（IdCondition 实测）', () => {
  // 上一版生成器「字段全量填入」，于是 IdCondition（只有一个 id: String）
  // 的 body 固化下来就是 {"id":"test_demo"}——现在该是最小请求 {}。字段表没变，
  // 光靠「字段表变了才刷」永远轮不到它，只能认值本身。
  const apiDef = api({
    httpMethod: 'POST',
    path: '/ui/shop/market/switchSupply',
    requestBodyType: 'IdCondition',
    requestBodyFields: [{ name: 'id', javaType: 'String', required: false }],
  })
  const stale: TestCase[] = [
    { id: 'a1#normal#1', name: '正常·switchSupply', type: 'normal', parameters: { __body: '{"id":"test_demo"}' }, expectedHttpStatus: [200, 201], expectedDbChange: 'update', enabled: true },
    { id: 'a1#normal#2', name: '手填过', type: 'normal', parameters: { __body: '{"id":"我填的"}' }, expectedHttpStatus: [200, 201], expectedDbChange: 'update', enabled: true },
  ]
  const out = refreshStaleBodies(apiDef, stale)
  assert.ok(out)
  // 冒烟形状是最小请求：非分页接口就是空对象；手填的不动
  assert.equal(out![0].parameters.__body, '{}')
  assert.equal(out![1].parameters.__body, '{"id":"我填的"}')
})

test('refreshStaleBodies：buildBody 仍会给 test_demo 的未知类型照样刷——占位值只在冒烟路径消失', () => {
  // 认不出的复杂类型在 buildBody（手编面板）里仍诚实给 test_demo，但冒烟 body 是
  // {}，所以固化下来的 {"mystery":"test_demo"} 是老生成的陈旧值，要刷。
  const apiDef = api({
    path: '/api/user/process',
    requestBodyType: 'MysteryReq',
    requestBodyFields: [{ name: 'mystery', javaType: 'NotInDict', required: false }],
  })
  assert.equal(buildBody(apiDef, {}), '{"mystery":"test_demo"}')
  const stale: TestCase[] = [{ id: 'a1#normal#1', name: '正常', type: 'normal', parameters: { __body: '{"mystery":"test_demo"}' }, expectedHttpStatus: [200], expectedDbChange: 'insert', enabled: true }]
  const out = refreshStaleBodies(apiDef, stale)
  assert.ok(out)
  assert.equal(out![0].parameters.__body, '{}')
  // 增改删的正常用例是有意填满的 body：带 test_demo 也不刷回空 body
  assert.equal(refreshStaleBodies({ ...apiDef, path: '/api/user/create' }, stale), null)
})

test('buildBody：对象集合按类型字典嵌套造骨架（detailList 实测），overrides 仍优先', () => {
  const dict = new Map([
    ['DetailAdd', [
      { name: 'brandId', javaType: 'Long', required: true },
      { name: 'supplierId', javaType: 'Long', required: false, description: '供应商' },
    ]],
  ])
  const apiDef = api({
    requestBodyType: 'AddCondition',
    requestBodyFields: [
      { name: 'brandOwnerId', javaType: 'Long', required: false },
      { name: 'detailList', javaType: 'List<DetailAdd>', required: false },
    ],
  })
  const body = JSON.parse(buildBody(apiDef, {}, dict))
  assert.equal(body.brandOwnerId, 1)
  // 元素骨架一个就够：手编面板看得见字段才有的填，不是造假数据
  assert.deepEqual(body.detailList, [{ brandId: 1, supplierId: 1 }])
  // overrides 永远赢
  assert.equal(JSON.parse(buildBody(apiDef, { detailList: '手工' }, dict)).detailList, '手工')
  // 不给字典退回老行为（空数组），老调用方不受影响
  assert.deepEqual(JSON.parse(buildBody(apiDef, {})).detailList, [])
})

test('buildBody：标量集合给一个值；未知元素/裸 List 诚实给空；嵌套对象字段也给骨架', () => {
  const dict = new Map([
    ['Sub', [{ name: 'code', javaType: 'String', required: false }]],
  ])
  const apiDef = api({
    requestBodyType: 'Req',
    requestBodyFields: [
      { name: 'keywords', javaType: 'List<String>', required: false },
      { name: 'ids', javaType: 'List<Long>', required: false }, // jar 里的 DTO 靠 Signature 属性才留得住这个泛型
      { name: 'files', javaType: 'List<MultipartFile>', required: false },
      { name: 'tags', javaType: 'List', required: false }, // 老缓存剥过泛型
      { name: 'sub', javaType: 'Sub', required: false },
      { name: 'mystery', javaType: 'NotInDict', required: false },
    ],
  })
  const body = JSON.parse(buildBody(apiDef, {}, dict))
  // 标量元素没有自己的名字，用集合字段的名字查字典；keywords 无对应规则 → 普通文本
  assert.deepEqual(body.keywords, ['测试文本'])
  // 数字元素的集合给一个数字，不能给空数组（jar 来源的 List<Long> 曾经因为丢泛型落到空）
  assert.deepEqual(body.ids, [1])
  assert.deepEqual(body.files, [])
  assert.deepEqual(body.tags, [])
  // 嵌套对象的字段按自己的名字出值：code → 单号规则
  assert.match(String((body.sub as Record<string, unknown>).code), /^T\d{8}$/)
  // 字典里没有的对象类型退回标量默认——不编造字段名（连名字都没有，只能用占位值）
  assert.equal(body.mystery, 'test_demo')
})

test('buildBody：DTO 互引成环到深度封顶，不死循环', () => {
  const dict = new Map([
    ['A', [{ name: 'b', javaType: 'B', required: false }]],
    ['B', [{ name: 'a', javaType: 'A', required: false }]],
  ])
  const apiDef = api({
    requestBodyType: 'A',
    requestBodyFields: [{ name: 'b', javaType: 'B', required: false }],
  })
  // A.b → B.a → A.b：B 第二次出现被 seen 拦住（防环比深度封顶先出手），收成标量默认
  assert.deepEqual(JSON.parse(buildBody(apiDef, {}, dict)), {
    b: { a: { b: 'test_demo' } },
  })
})

test('buildBody：字符串按名字/注释给合法值，id 一律数字 —— 这是 test_demo 假失败的根因', () => {
  // 实测场景：DTO 字段名是中性缩写，格式约束（手机号 @Pattern、品牌商 id）只写在注释里。
  // 全发 test_demo 的话，「填入全部字段」发出去必然 400，用户读成「接口挂了」。
  const apiDef = api({
    requestBodyType: 'ApplyReq',
    requestBodyFields: [
      { name: 'contactPhone', javaType: 'String', required: true },
      { name: 'brandOwnerId', javaType: 'Long', required: true, description: '品牌商id,必填。' },
      { name: 'conditionId', javaType: 'String', required: false }, // SHOP 把 id 声明成 String（IdCondition 实测）
      { name: 'userId', javaType: 'String', required: false, description: '创建人手机号' },
      { name: 'remark', javaType: 'String', required: false, description: '联系手机号' },
    ],
  })
  const body = JSON.parse(buildBody(apiDef, {})) as Record<string, unknown>
  assert.match(String(body.contactPhone), /^138\d{8}$/)
  // 字段名中性、注释说了算：remark 的注释是「联系手机号」
  assert.match(String(body.remark), /^138\d{8}$/)
  // id 一律数字：String 声明也一样，注释写的手机号也不改口（JSON 契约上不该赌强转）
  assert.equal(typeof body.conditionId, 'number')
  assert.equal(typeof body.userId, 'number')
  // 数字字段不能落进字典变成 "T00000001"：那是另一种 400，比假失败更难查
  assert.equal(typeof body.brandOwnerId, 'number')
  assert.equal(JSON.stringify(body).includes('test_demo'), false)
})

test('bodyValueOfField：id 形字段给数字（String 声明、带手机号注释、集合元素三个口径一致）', () => {
  const n = bodyValueOfField({ name: 'userId', javaType: 'String', required: false })
  assert.equal(typeof n, 'number')
  assert.equal(Number.isInteger(n), true)
  // 注释说手机号也不盖过 id 的数字语义（剥注释再查字典）
  const withDesc = bodyValueOfField({ name: 'user_id', javaType: 'String', required: false, description: '创建人手机号' })
  assert.equal(typeof withDesc, 'number')
  // Long 本来就是数字（bodyValueOf），不因这条规则改变
  assert.equal(bodyValueOfField({ name: 'brandOwnerId', javaType: 'Long', required: false }), 1)
  // 恰好以 id 收尾的英文词（isValid / liquid）不是 id，走字典语义
  assert.equal(bodyValueOfField({ name: 'liquid', javaType: 'String', required: false }), '测试文本')
  assert.equal(typeof bodyValueOfField({ name: 'isValid', javaType: 'String', required: false }), 'string')
})

/* ================= 业务异常的扫描正源（bizThrowsForApi） =================
   字段注释推断（bizRulesOf）是「猜」，saveApply 实测 0 条——注释不规范就没辙。
   扫描器在 Service 方法体里捡到的 throw 是后端自己写的，连文案都是代码里那句，
   所以它是正源、注释是兜底。下面这些钉住链路走法和两条正源的优先级。 */

/** 扫描结果的壳：只填链路用得到的键，其余的给最小合法值 */
const ws = (project: Partial<ProjectScanResult>): WorkspaceScanResult => ({
  root: 'E:/work/demo',
  scannedAt: '2026-09-17T00:00:00Z',
  fingerprint: 'f',
  projects: [{
    projectId: 'p',
    projectPath: 'E:/work/demo',
    projectName: 'demo',
    controllers: [],
    mappers: [],
    classUses: [],
    bizThrows: [],
    errors: [],
    ...project,
  }],
  errors: [],
})

/** 实测那条：saveApply 的 brandOwnerId 注释写着「必填」但 @NotNull 压根没有 */
const BIZ_ID: BizThrowDetail = { type: 'BizException', message: '品牌商id必填', fields: ['brandOwnerId'] }

/** Controller 注入 UserService 的一跳（classUses 的形状），真实工程里就是这个样子 */
const CTRL_USE = { className: 'UserController', methodName: 'create', usedFieldTypes: ['UserService', 'UserServiceImpl'] }

/** 扫描器按「实现类全名 + 接口简名」双登记同一份 throw——同一个 Service 方法会被两条路走到 */
const BIZ_DOUBLE = [
  { className: 'com.demo.svc.UserServiceImpl', methodName: 'create', throws: [BIZ_ID] },
  { className: 'UserService', methodName: 'create', throws: [BIZ_ID] },
]

test('扫描正源：Controller→Service 一跳认领 throw，用例名带后端文案，双登记去重', () => {
  const apiDef = api({
    requestBodyType: 'AddCondition',
    requestBodyFields: [
      { name: 'brandOwnerId', javaType: 'Long', required: false },
      { name: 'remark', javaType: 'String', required: false },
    ],
  })
  const biz = generateCases(apiDef, undefined, ws({ classUses: [CTRL_USE], bizThrows: BIZ_DOUBLE }))
    .filter((c) => c.name.startsWith('异常·业务·'))
  // 实现类全名那条和接口别名那条是同一个 throw，去重后只剩一条——
  // 不去重的话报告里每条业务异常都成对出现，用户读成「两个字段都没过」
  assert.deepEqual(biz.map((c) => c.name), ['异常·业务·品牌商id必填'])
  // 守卫字段整组摘掉，没认领的 remark 照常带上
  const body = JSON.parse(biz[0].parameters.__body as string)
  assert.equal(body.brandOwnerId, undefined)
  assert.ok(body.remark !== undefined)
  // 业务异常被全局处理器优雅接住怎么回都行，回 500 就是没兜住
  assert.deepEqual(biz[0].expectedHttpStatus, [200, 400])
})

test('扫描正源：throw 在另一个工程的实现类里也认领（UI 壳 + service 实现的典型布局）', () => {
  // 实测布局：admin-ui 的 Controller 注入本工程声明的 AdminOrderService（壳接口，
  // 没有实现源码），真实 throw 在 system-service 的 AdminOrderServiceImpl 里——
  // throw 索引按工作区全工程合并，靠「接口简名」别名接上
  const apiDef = api({
    requestBodyType: 'AddCondition',
    requestBodyFields: [{ name: 'brandOwnerId', javaType: 'Long', required: false }],
  })
  const home = ws({ classUses: [CTRL_USE] })
  const svc = { ...home.projects[0], projectId: 'svc', projectName: 'svc', classUses: [], bizThrows: BIZ_DOUBLE }
  const multi: WorkspaceScanResult = { ...home, projects: [home.projects[0], svc] }
  // api 所属工程（p）里没有 bizThrows，只有另一个工程（svc）里有
  const biz = generateCases(apiDef, undefined, multi).filter((c) => c.name.startsWith('异常·业务·'))
  assert.deepEqual(biz.map((c) => c.name), ['异常·业务·品牌商id必填'])
})

test('扫描正源：守卫字段不在这个 body 上就不生成（同一个 Service 方法被多个接口复用）', () => {
  // 别的接口的守卫不该算到这个接口头上：认领字段一个都不在 body 里就跳过
  const apiDef = api({
    requestBodyType: 'OtherCondition',
    requestBodyFields: [{ name: 'keyword', javaType: 'String', required: false }],
  })
  const cases = generateCases(apiDef, undefined, ws({ classUses: [CTRL_USE], bizThrows: BIZ_DOUBLE }))
  assert.deepEqual(cases.filter((c) => c.name.startsWith('异常·业务·')), [])
  // 两条正源都没给出这个接口的规则 → 落进探查兜底（那段单独有测试）
  assert.equal(cases.filter((c) => c.name.startsWith('异常·探查·')).length, 1)
})

test('扫描正源：只收名字对得上的 Service 方法，查询接口不捡提交方法的 throw', () => {
  const submitThrow = { className: 'UserService', methodName: 'submit', throws: [{ type: 'BizException', message: '不是待提交不能提交', fields: ['id'] }] }
  const saveThrow = { className: 'UserService', methodName: 'saveApply', throws: [{ type: 'BizException', message: '名称必填', fields: ['name'] }] }
  const fields = [
    { name: 'id', javaType: 'Long', required: false },
    { name: 'name', javaType: 'String', required: false },
  ]
  const bizOf = (methodName: string) =>
    generateCases(
      api({ methodName, requestBodyType: 'Cond', requestBodyFields: fields }),
      undefined,
      ws({ classUses: [{ ...CTRL_USE, methodName }], bizThrows: [submitThrow, saveThrow] }),
    )
      .filter((c) => c.name.startsWith('异常·业务·'))
      .map((c) => c.name)
  assert.deepEqual(bizOf('list'), [])
  assert.deepEqual(bizOf('save'), ['异常·业务·名称必填'])
})

test('查询接口：不造「必填缺失」也不造探查（正常用例本就只带分页）', () => {
  const fields = [
    { name: 'brandOwnerId', javaType: 'Long', required: false, description: '品牌商id,必填。' },
    { name: 'keyword', javaType: 'String', required: false },
  ]
  const names = (path: string) =>
    generateCases(api({ methodName: 'x', path, requestBodyType: 'Cond', requestBodyFields: fields })).map((c) => c.name)
  const read = names('/api/user/listByPage')
  assert.equal(read.some((n) => n.includes('必填缺失') || n.startsWith('异常·探查·')), false)
  // 写接口照旧
  assert.ok(names('/api/user/save').includes('异常·业务·brandOwnerId 必填缺失'))
})

test('扫描正源：一条 throw 认领多个字段 = 一条用例整组摘掉；没文案时用例名兜底', () => {
  const apiDef = api({
    requestBodyType: 'AddCondition',
    requestBodyFields: [
      { name: 'brandOwnerId', javaType: 'Long', required: false },
      { name: 'supplierId', javaType: 'Long', required: false },
      { name: 'applyNo', javaType: 'String', required: false },
    ],
  })
  const biz = generateCases(apiDef, undefined, ws({
    classUses: [CTRL_USE],
    bizThrows: [
      {
        className: 'UserService',
        methodName: 'create',
        throws: [
          { type: 'BizException', message: '品牌商和供应商必传其一', fields: ['brandOwnerId', 'supplierId'] },
          // 运行时拼出来的 message 扫描器认不出（javadoc 里写明的 v1 缺口），
          // 但认领的字段还在——用例名用字段名兜底，别丢这条
          { type: 'BizException', message: '', fields: ['applyNo'] },
        ],
      },
    ],
  })).filter((c) => c.name.startsWith('异常·业务·'))
  assert.deepEqual(biz.map((c) => c.name), [
    '异常·业务·品牌商和供应商必传其一',
    '异常·业务·applyNo 未过校验',
  ])
  // 多个字段是一条用例里整组摘掉（一条 throw 就是一次校验），不是每个字段一条；
  // 没被这条 throw 认领的字段照常带上（第二条用例反过来，两组互补）
  const body = JSON.parse(biz[0].parameters.__body as string)
  assert.equal(body.brandOwnerId, undefined)
  assert.equal(body.supplierId, undefined)
  assert.ok(body.applyNo !== undefined)
  const body2 = JSON.parse(biz[1].parameters.__body as string)
  assert.equal(body2.applyNo, undefined)
  assert.ok(body2.brandOwnerId !== undefined && body2.supplierId !== undefined)
})

test('扫描正源：后端文案进用例名——空白压成单空格，超 40 字截断', () => {
  const apiDef = api({
    requestBodyType: 'AddCondition',
    requestBodyFields: [{ name: 'brandOwnerId', javaType: 'Long', required: false }],
  })
  const nameOf = (message: string) =>
    generateCases(apiDef, undefined, ws({
      classUses: [CTRL_USE],
      bizThrows: [{ className: 'UserService', methodName: 'create', throws: [{ type: 'BizException', message, fields: ['brandOwnerId'] }] }],
    })).find((c) => c.name.startsWith('异常·业务·'))!.name
  // Java 源码里的换行/缩进拼接会原样带进 message，报告里不能是一条断成几行的名字
  assert.equal(nameOf('品牌商\n   id  必填'), '异常·业务·品牌商 id 必填')
  const long = nameOf('一'.repeat(45))
  assert.equal(long, `异常·业务·${'一'.repeat(40)}…`)
})

test('扫描正源：扫描认领的字段不再重复发注释「必填缺失」，值型规则照出', () => {
  const apiDef = api({
    requestBodyType: 'AddCondition',
    requestBodyFields: [
      { name: 'brandOwnerId', javaType: 'Long', required: false, description: '品牌商id,必填。' },
      { name: 'userName', javaType: 'String', required: false, description: '姓名,不超过50字符' },
    ],
  })
  const biz = generateCases(apiDef, undefined, ws({ classUses: [CTRL_USE], bizThrows: BIZ_DOUBLE }))
    .filter((c) => c.name.startsWith('异常·业务·'))
  const names = biz.map((c) => c.name)
  // 同一件事别发两遍：扫描的「品牌商id必填」和注释的「brandOwnerId 必填缺失」重合
  assert.ok(names.includes('异常·业务·品牌商id必填'))
  assert.equal(names.includes('异常·业务·brandOwnerId 必填缺失'), false)
  // 值型规则照出：扫描只认领字段名，给不出「超长」这种违例值
  assert.ok(names.includes('异常·业务·userName 超长(51字)'))
})

test('扫描正源：没 scan / 工程对不上就返回空（跑批 bench 和旧缓存行为不变）', () => {
  const apiDef = api({ requestBodyType: 'AddCondition', requestBodyFields: [{ name: 'brandOwnerId', javaType: 'Long', required: false }] })
  assert.deepEqual(bizThrowsForApi(apiDef), [])
  // 旧缓存没有 bizThrows 键 → 空数组，不是 undefined 崩在遍历上
  assert.deepEqual(bizThrowsForApi(apiDef, ws({})), [])
  // 别的工程扫到的同名 Controller 不算数（projectId 是唯一归属）
  const other = ws({ classUses: [CTRL_USE], bizThrows: BIZ_DOUBLE })
  other.projects[0].projectId = 'other'
  assert.deepEqual(bizThrowsForApi(apiDef, other), [])
})

/* ================= 探查兜底 =================
   扫描没捡到 throw、注释也没写约束的写接口，今天一条异常用例都没有。
   满员 body 逐字段「缺一探查」是应急桥：拦了说明那字段有校验，没拦（200）也是结论。
   两个帽子控噪声——单接口封顶 8 条，且只在该接口一条规则都没挖到时才补。 */

test('探查兜底：两条正源都没数据时逐字段「缺一探查」，探的是摘掉该字段的满员 body', () => {
  const apiDef = api({
    requestBodyType: 'UnknownReq',
    requestBodyFields: [
      { name: 'brandOwnerId', javaType: 'Long', required: false },
      { name: 'remark', javaType: 'String', required: false },
    ],
  })
  const probes = generateCases(apiDef).filter((c) => c.name.startsWith('异常·探查·缺 '))
  assert.deepEqual(probes.map((c) => c.name), ['异常·探查·缺 brandOwnerId', '异常·探查·缺 remark'])
  const body = JSON.parse(probes[0].parameters.__body as string)
  assert.equal(body.brandOwnerId, undefined)
  assert.ok(body.remark !== undefined)
  assert.deepEqual(probes[0].expectedHttpStatus, [200, 400])
})

test('探查兜底：单接口封顶 8 条、分页字段不探（摘 pageNum 不是校验是分页）', () => {
  const apiDef = api({
    requestBodyType: 'BigReq',
    requestBodyFields: [
      { name: 'pageNum', javaType: 'Integer', required: false },
      { name: 'pageSize', javaType: 'Integer', required: false },
      ...Array.from({ length: 12 }, (_, i) => ({ name: `f${i}`, javaType: 'String', required: false })),
    ],
  })
  const probes = generateCases(apiDef).filter((c) => c.name.startsWith('异常·探查·缺 '))
  assert.equal(probes.length, 8)
  assert.deepEqual(probes.map((c) => c.name), Array.from({ length: 8 }, (_, i) => `异常·探查·缺 f${i}`))
})

test('探查兜底：挖到一条规则就不补（挖到一半补，矩阵要爆炸）；扫描有数据更不补', () => {
  const commented = api({
    requestBodyType: 'Req',
    requestBodyFields: [
      { name: 'brandOwnerId', javaType: 'Long', required: false, description: '品牌商id,必填。' },
      { name: 'other', javaType: 'String', required: false },
    ],
  })
  assert.equal(generateCases(commented).some((c) => c.name.startsWith('异常·探查·')), false)
  // 扫描已经认领了字段：正源有数据就别撒网（注释一个字没有也一样）
  const scanned = api({
    requestBodyType: 'AddCondition',
    requestBodyFields: [{ name: 'brandOwnerId', javaType: 'Long', required: false }],
  })
  assert.equal(
    generateCases(scanned, undefined, ws({ classUses: [CTRL_USE], bizThrows: BIZ_DOUBLE }))
      .some((c) => c.name.startsWith('异常·探查·')),
    false,
  )
})

test('探查兜底：只探写动词（GET 没有 body 校验，删/补的探查语义不明）', () => {
  for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
    const apiDef = api({
      httpMethod: method,
      requestBodyType: 'Req',
      requestBodyFields: [{ name: 'brandOwnerId', javaType: 'Long', required: false }],
    })
    assert.equal(generateCases(apiDef).some((c) => c.name.startsWith('异常·探查·')), false, method)
  }
})

test('「未找到」配对用例：必填 id 形参数给冻结大数，期望 [200,400,404]，标记 probeNotFound', () => {
  const apiDef = api({
    httpMethod: 'GET',
    path: '/api/user/getById',
    parameters: [
      { name: 'id', javaType: 'Long', position: 'query', required: true },
      { name: 'name', javaType: 'String', position: 'query', required: false },
    ],
  })
  const nf = generateCases(apiDef).find((c) => c.name === '异常·未找到')
  assert.ok(nf, 'getById 形态必须配一条未找到')
  assert.equal(nf.parameters.id, '987654321000')
  assert.equal(nf.parameters.name, undefined, '可选筛选不带：这条测的是「数据不存在」不是筛选')
  assert.deepEqual(nf.expectedHttpStatus, [200, 400, 404])
  assert.equal(nf.probeNotFound, true)
  assert.equal(nf.expectedDbChange, 'none', '未找到不改库，期望变更对齐事实')
})

test('「未找到」配对用例：写动词 body 的 id 字段给 JSON 冻结大数；列表可选 id 筛选不生成', () => {
  const put = api({
    httpMethod: 'PUT',
    path: '/api/user/update',
    requestBodyType: 'UpdateCondition',
    requestBodyFields: [
      { name: 'id', javaType: 'Long', required: false },
      { name: 'name', javaType: 'String', required: false },
    ],
  })
  const nf = generateCases(put).find((c) => c.name === '异常·未找到')
  assert.ok(nf)
  const body = JSON.parse(nf.parameters.__body as string) as Record<string, unknown>
  assert.equal(body.id, 987654321000, 'body 里的冻结大数是 JSON 数字（后端 Long 收不下字符串）')
  // 路径参数也没有、body 也没有：不生成
  assert.equal(generateCases(api({ httpMethod: 'GET', path: '/api/user/page' })).some((c) => c.name === '异常·未找到'), false)
  // 列表形态：id 形参数只有可选筛选（required=false）→ 不生成
  const list = api({
    httpMethod: 'GET',
    path: '/api/user/page',
    parameters: [{ name: 'brandOwnerId', javaType: 'Long', position: 'query', required: false }],
  })
  assert.equal(generateCases(list).some((c) => c.name === '异常·未找到'), false, '可选筛选填大数只会把结果筛空')
})
