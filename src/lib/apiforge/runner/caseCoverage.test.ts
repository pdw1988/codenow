import test from 'node:test'
import assert from 'node:assert/strict'
import { findList, queryByCheckOf, queryByFails } from './queryBy'
import { dbHintOf } from './dbHint'
import { applyQueryValue, prepareCaseData } from './prepareCase'
import { guessTargetPk } from './runCase'
import { judgeCase } from './judge'
import { applyActionOverrides } from '../cases/apiAction'
import type { FixtureSession, ReadFill } from '../data/prepare'
import type { ApiMethod, TableChange, TestCase, WorkspaceScanResult } from '../types'

const api = (over: Partial<ApiMethod> = {}): ApiMethod => ({
  id: 'a1',
  methodName: 'm',
  httpMethod: 'POST',
  path: '/brand/getList',
  parameters: [],
  requestBodyType: 'BrandReq',
  requestBodyFields: [
    { name: 'id', javaType: 'Long', required: false },
    { name: 'brandName', javaType: 'String', required: false },
    { name: 'status', javaType: 'Integer', required: false },
  ],
  responseType: '',
  description: '',
  controllerClass: 'C',
  filePath: '',
  projectId: 'p',
  ...over,
})

const tc = (over: Partial<TestCase> = {}): TestCase => ({
  id: 'c1',
  name: 'n',
  type: 'normal',
  parameters: { __body: '{"pageNum":1}' },
  expectedHttpStatus: [200],
  expectedDbChange: 'none',
  enabled: true,
  ...over,
})

/** 只实现用到的方法，其余调到就报错； calls 记下调了哪些 */
function fakeFx(opts: { borrow?: ReadFill[]; fills?: ReadFill[]; value?: string }) {
  const calls: string[] = []
  const fx = {
    borrowFor: async () => {
      calls.push('borrow')
      return { log: [], backfill: opts.borrow }
    },
    prepareFor: async () => {
      calls.push('prepare')
      return []
    },
    fillsFor: () => opts.fills ?? [],
    queryValueFor: async () => {
      calls.push('value')
      return opts.value === undefined ? { log: [] } : { log: [], value: opts.value, table: 'T_BRAND', col: 'BRAND_NAME' }
    },
  } as unknown as FixtureSession
  return { fx, calls }
}

const rel = [{ tableName: 'T_BRAND', enabled: true }] as never
const idFill: ReadFill = { field: 'id', value: 42, table: 'T_BRAND', col: 'ID', kind: 'body' }

test('findList：常见列表位置都认，找不到给 null', () => {
  assert.deepEqual(findList({ data: { records: [1] } }), [1])
  assert.deepEqual(findList({ data: { list: [2] } }), [2])
  assert.deepEqual(findList({ data: [3] }), [3])
  assert.deepEqual(findList({ rows: [4] }), [4])
  assert.deepEqual(findList([5]), [5])
  assert.equal(findList({ data: { total: 1 } }), null)
})

test('按条件查：空列表算失败；字段对不上算失败；包含/相等/数字文本都认', () => {
  const c = { field: 'brandName', mode: 'contains' as const, value: '若依' }
  assert.match(queryByFails(c, '{"data":{"records":[]}}')[0], /列表是空的/)
  assert.deepEqual(queryByFails(c, '{"data":{"records":[{"brandName":"若依科技"}]}}'), [])
  assert.match(queryByFails(c, '{"data":{"records":[{"brandName":"别的"}]}}')[0], /第 1 条.*不包含/)
  const eq = { field: 'status', mode: 'eq' as const, value: '1' }
  assert.deepEqual(queryByFails(eq, '{"data":[{"status":1},{"status":"1"}]}'), [])
  assert.match(queryByFails(eq, '{"data":[{"status":2}]}')[0], /不等于/)
  // 列表里没有这个字段：只看非空；找不到列表 / 不是 JSON：不核对
  assert.deepEqual(queryByFails(eq, '{"data":[{"other":2}]}'), [])
  assert.deepEqual(queryByFails(eq, '{"data":{"total":0}}'), [])
  assert.deepEqual(queryByFails(eq, '<html>'), [])
})

test('按条件查：取出实际发的值；没填值（报告里重跑）不核对；信封先失败就不再报列表', () => {
  const q = { field: 'brandName', position: 'body' as const, mode: 'contains' as const }
  assert.equal(queryByCheckOf(tc({ queryBy: q })), null)
  const filled = applyQueryValue(api(), tc({ queryBy: q }), '若依')
  assert.deepEqual(JSON.parse(filled.parameters.__body as string), { pageNum: 1, brandName: '若依' })
  assert.deepEqual(queryByCheckOf(filled), { field: 'brandName', mode: 'contains', value: '若依' })
  // 数值字段给 JSON 数字；query 参数直接填
  const st = applyQueryValue(api(), tc({ queryBy: { field: 'status', position: 'body', mode: 'eq' } }), '3')
  assert.equal(JSON.parse(st.parameters.__body as string).status, 3)
  const qp = applyQueryValue(api(), tc({ queryBy: { field: 'kw', position: 'query', mode: 'contains' } }), 'x')
  assert.equal(qp.parameters.kw, 'x')

  const check = queryByCheckOf(filled)
  const fail = judgeCase([200], [{ path: '$.level', op: '!=', value: 'error' }], 200, undefined, '{"level":"error","msg":"没权限"}', null, check)
  assert.deepEqual(fail.assertFails, ['接口返回业务失败：没权限'])
  const empty = judgeCase([200], [], 200, undefined, '{"data":{"list":[]}}', null, check)
  assert.equal(empty.ok, false)
})

test('库变化提示：只在接口说成功时核对；逻辑删除（字段变了）也算删了', () => {
  const ch = (over: Partial<TableChange>): TableChange => ({
    tableName: 'T', op: 'none', rowsInserted: 0, rowsUpdated: 0, rowsDeleted: 0,
    insertedIds: [], deletedIds: [], updatedIds: [], fieldDiffs: [], ...over,
  })
  const base = { httpStatus: 200, bodyText: '{"code":"200"}', snapshotted: 1 }
  const ins = tc({ expectedDbChange: 'insert' })
  assert.equal(dbHintOf({ ...base, testCase: ins, changes: [ch({})] }), '接口说成功了，但库里没有新增数据')
  assert.equal(dbHintOf({ ...base, testCase: ins, changes: [ch({ rowsInserted: 1 })] }), undefined)
  // 接口自己报错 / HTTP 失败：库没变是应该的
  assert.equal(dbHintOf({ ...base, bodyText: '{"code":"500"}', testCase: ins, changes: [] }), undefined)
  assert.equal(dbHintOf({ ...base, httpStatus: 400, testCase: ins, changes: [] }), undefined)
  const del = tc({ expectedDbChange: 'delete' })
  assert.equal(dbHintOf({ ...base, testCase: del, changes: [ch({ rowsUpdated: 1 })] }), undefined)
  assert.match(dbHintOf({ ...base, testCase: del, changes: [ch({})] }) ?? '', /既没少行也没改状态/)
  assert.match(dbHintOf({ ...base, testCase: tc({ expectedDbChange: 'update' }), changes: [] }) ?? '', /没看到/)
  // 关联表一张都没查成：说没法核对；异常用例、查询不提示
  assert.match(dbHintOf({ ...base, snapshotted: 0, testCase: ins, changes: [] }) ?? '', /没法核对/)
  assert.equal(dbHintOf({ ...base, testCase: tc({ type: 'exception', expectedDbChange: 'insert' }), changes: [] }), undefined)
  assert.equal(dbHintOf({ ...base, testCase: tc(), changes: [] }), undefined)
})

test('数据准备：POST 查询只借不造；改删造行并对准 id；新增造行但不回填主键', async () => {
  const q = fakeFx({})
  await prepareCaseData(api(), tc(), rel, q.fx)
  assert.deepEqual(q.calls, ['borrow'])

  const u = fakeFx({ fills: [idFill] })
  const up = await prepareCaseData(api({ path: '/brand/updateBrand' }), tc({ parameters: { __body: '{"brandName":"x"}' } }), rel, u.fx)
  assert.deepEqual(u.calls, ['prepare'])
  assert.equal(JSON.parse(up.testCase.parameters.__body as string).id, 42)

  const i = fakeFx({ fills: [idFill] })
  const ins = await prepareCaseData(api({ path: '/brand/saveBrand' }), tc({ parameters: { __body: '{"brandName":"x"}' } }), rel, i.fx)
  assert.deepEqual(i.calls, ['prepare'])
  assert.equal('id' in JSON.parse(ins.testCase.parameters.__body as string), false)

  // 「未找到」、异常用例不备数据
  const n = fakeFx({})
  await prepareCaseData(api({ path: '/brand/deleteBrand' }), tc({ probeNotFound: true }), rel, n.fx)
  await prepareCaseData(api({ path: '/brand/deleteBrand' }), tc({ type: 'exception' }), rel, n.fx)
  assert.deepEqual(n.calls, [])
})

test('数据准备：按条件查取到真实值就填，取不到 / 没连库就跳过', async () => {
  const q = { field: 'brandName', position: 'body' as const, mode: 'contains' as const }
  const ok = await prepareCaseData(api(), tc({ queryBy: q }), rel, fakeFx({ value: '若依' }).fx)
  assert.equal(ok.skip, undefined)
  assert.equal(JSON.parse(ok.testCase.parameters.__body as string).brandName, '若依')
  assert.match((await prepareCaseData(api(), tc({ queryBy: q }), rel, fakeFx({}).fx)).skip ?? '', /没取到真实值/)
  assert.match((await prepareCaseData(api(), tc({ queryBy: q }), rel, undefined)).skip ?? '', /没连库/)
})

test('guessTargetPk：path 没有 id 就看 body 顶层 id（POST 改删对准那一行）', () => {
  assert.equal(guessTargetPk(api(), { __body: '{"id":42,"brandName":"x"}' }), '42')
  assert.equal(guessTargetPk(api(), { __body: '{"brandName":"x"}' }), undefined)
  assert.equal(guessTargetPk(api({ requestBodyFields: [] }), { __body: '{"id":42}' }), undefined)
  const pathApi = api({ parameters: [{ name: 'id', javaType: 'Long', position: 'path', required: true }] })
  assert.equal(guessTargetPk(pathApi, { id: '7', __body: '{"id":42}' }), '7')
})

test('applyActionOverrides：手改套到扫描结果上；去掉的恢复自动；没变化原样返回', () => {
  const ws = {
    root: '', scannedAt: '', fingerprint: '', errors: [],
    projects: [{ projectId: 'p', controllers: [{ methods: [api({ id: 'x' }), api({ id: 'y' })] }] }],
  } as unknown as WorkspaceScanResult
  const a = applyActionOverrides(ws, { x: 'update' })
  assert.equal(a.projects[0].controllers[0].methods[0].action, 'update')
  assert.equal(a.projects[0].controllers[0].methods[1], ws.projects[0].controllers[0].methods[1])
  assert.equal(applyActionOverrides(a, { x: 'update' }), a)
  const b = applyActionOverrides(a, {})
  assert.equal('action' in b.projects[0].controllers[0].methods[0], false)
})
