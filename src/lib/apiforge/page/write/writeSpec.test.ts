import test from 'node:test'
import assert from 'node:assert/strict'
import {
  allowsWrite,
  draftBlockers,
  dropLeftover,
  editedValue,
  isExternalAction,
  isStale,
  markerOf,
  parsePageWrite,
  popupValues,
  stampOf,
  upsertLeftover,
  upsertSpec,
  valueFor,
  withFreshOps,
  writeEnvAllowed,
  writeUrls,
} from './writeSpec'
import type { PageInfo, WriteDraft, WriteField, WriteLeftover } from '../../types'

const NOW = new Date(2026, 9, 2, 9, 5, 7)
const f = (name: string, over: Partial<WriteField> = {}): WriteField => ({
  name, label: '', kind: 'text', required: false, maxlength: null, options: [], ...over,
})
const DRAFT: WriteDraft = {
  kind: 'crud',
  add: { trigger: '新增', templateId: '#t', action: '/ui/x/addOrModify', fields: [f('name')] },
  edit: { trigger: '修改', templateId: '#t2', action: '/ui/x/addOrModify', fields: [f('name')] },
  editField: 'name',
  del: { title: '删除', url: '/ui/x/delete' },
  disable: { title: '停用', url: '/ui/x/updateStatus' },
  findField: 'name',
  fingerprint: 'abc',
  problems: [],
  notes: [],
}

test('标记：时间戳 MMddHHmmss，前缀固定', () => {
  assert.equal(stampOf(NOW), '1002090507')
  assert.equal(markerOf('1002090507'), 'ZZ自动测-1002090507')
})

test('造值：普通文本填标记，编码 / 电话 / 邮箱 / 日期 / 数量按格式，下拉和 other 不造', () => {
  assert.equal(valueFor(f('basicTypeName'), NOW), 'ZZ自动测-1002090507')
  assert.equal(valueFor(f('basicTypeCode'), NOW), 'ZZ1002090507')
  assert.equal(valueFor(f('x', { label: '档案编码' }), NOW), 'ZZ1002090507')
  assert.equal(valueFor(f('tel'), NOW), '13800000000')
  assert.equal(valueFor(f('email'), NOW), 'zz@test.com')
  assert.equal(valueFor(f('applyDate'), NOW), '2026-10-02')
  assert.equal(valueFor(f('sortNum'), NOW), '1')
  assert.equal(valueFor(f('k', { kind: 'select' }), NOW), null)
  assert.equal(valueFor(f('k', { kind: 'other' }), NOW), null)
})

test('造值：maxlength 放不下标记就用短标记，再放不下截断', () => {
  assert.equal(valueFor(f('name', { maxlength: 14 }), NOW), 'ZZ1002090507')
  assert.equal(valueFor(f('name', { maxlength: 8 }), NOW), 'ZZ100209')
})

test('编辑值：原值后面加 ZZ，放不下就截原值；原值为空填标记', () => {
  assert.equal(editedValue('蓝光镜', null, '1002090507'), '蓝光镜ZZ')
  assert.equal(editedValue('abcdef', 5, '1002090507'), 'abcZZ')
  assert.equal(editedValue('', null, '1002090507'), 'ZZ自动测-1002090507')
})

test('popupValues：用户填的优先，其余按规则造；下拉只收用户填的', () => {
  const v = popupValues([f('basicTypeName'), f('basicTypeCode'), f('cls', { kind: 'select' }), f('g', { kind: 'other' })], { basicTypeCode: 'MY1', cls: '2' }, NOW)
  assert.deepEqual(v, { basicTypeName: 'ZZ自动测-1002090507', basicTypeCode: 'MY1', cls: '2' })
})

test('外部动作：只看地址最后一段，字典增删改不算', () => {
  for (const u of ['/ui/a/commitApply', '/ui/a/updateSySuppLicStateByNc', '/ui/a/updateStatus', '/ui/a/syncAll', '/ui/a/importX', '/ui/a/singleBlueInvoiceAdd', '/ui/a/redInvoiceDelete', '/ui/a/addInvoiceApply', '/ui/a/reviseSave', '/ui/a/revokeDeliveryOrder', '/ui/a/submitBill']) {
    assert.equal(isExternalAction(u), true, u)
  }
  for (const u of ['/ui/shop/view/basicType/addOrModifyBasicType', '/ui/shop/invoice/invoiceChargeGoods/deleteInvoiceChargeGoods', '/ui/a/editInvoiceClientInfo']) {
    assert.equal(isExternalAction(u), false, u)
  }
})

test('环境：只认 dev / sit / 本机，生产和乱写的地址拒跑', () => {
  assert.equal(writeEnvAllowed('http://sit.example.com:8081/shop-admin-ui'), true)
  assert.equal(writeEnvAllowed('http://shop-dev2.example.net/shop-admin-ui'), true)
  assert.equal(writeEnvAllowed('http://localhost:8080'), true)
  assert.equal(writeEnvAllowed('http://127.0.0.1:8080/x'), true)
  assert.equal(writeEnvAllowed('https://shop.example.com/shop-admin-ui'), false)
  assert.equal(writeEnvAllowed('http://devtools.example.net'), false)
  assert.equal(writeEnvAllowed('不是地址'), false)
})

test('放行名单：草稿里的地址去掉上下文路径后全等才放行', () => {
  const allow = writeUrls(DRAFT)
  // 新增和编辑共用一个保存地址时只列一次
  assert.deepEqual(allow, ['/ui/x/addOrModify', '/ui/x/delete', '/ui/x/updateStatus'])
  assert.equal(allowsWrite('/shop-admin-ui/ui/x/delete', allow), true)
  assert.equal(allowsWrite('/ui/x/delete', allow), true)
  assert.equal(allowsWrite('/ui/x/deleteAll', allow), false)
  assert.equal(allowsWrite('/ui/xx/delete', allow), false)
  assert.equal(allowsWrite('/ui/x/delete', []), false)
})

test('白名单确认门槛：problems 和外部动作都拦；停用地址不查（只对自己造的行）', () => {
  assert.deepEqual(draftBlockers(DRAFT), [])
  assert.deepEqual(draftBlockers({ ...DRAFT, problems: ['缺编辑'] }), ['缺编辑'])
  const ext = draftBlockers({ ...DRAFT, del: { title: '删除', url: '/ui/x/commitDelete' } })
  assert.equal(ext.length, 1)
  assert.match(ext[0]!, /删除地址 \/ui\/x\/commitDelete/)
})

test('草稿变了就过期：指纹不同 / 重扫后没草稿', () => {
  const page = { writeDraft: DRAFT } as PageInfo
  const spec = { pageId: 'p', draft: DRAFT, values: {}, confirmedAt: 1 }
  assert.equal(isStale(spec, page), false)
  assert.equal(isStale(spec, { writeDraft: { ...DRAFT, fingerprint: 'zzz' } } as PageInfo), true)
  assert.equal(isStale(spec, { writeDraft: null } as PageInfo), true)
})

test('老白名单没有 enable：指纹没变从当前草稿补，变了 / 已有就不动', () => {
  const en = { title: '启用', url: '/ui/x/updateStatus' }
  const old = { ...DRAFT }
  delete old.enable
  const spec = { pageId: 'p', draft: old, values: {}, confirmedAt: 1 }
  assert.deepEqual(withFreshOps(spec, { writeDraft: { ...DRAFT, enable: en } } as PageInfo).draft.enable, en)
  assert.equal(withFreshOps(spec, { writeDraft: { ...DRAFT, fingerprint: 'zzz', enable: en } } as PageInfo), spec)
  const has = { ...spec, draft: { ...DRAFT, enable: null } }
  assert.equal(withFreshOps(has, { writeDraft: { ...DRAFT, enable: en } } as PageInfo), has)
})

test('leftover：同一页同一标记只留一条，去掉按同一键', () => {
  const a: WriteLeftover = { pageId: 'p', pagePath: '/x', kind: 'created', marker: 'ZZ1', at: 1 }
  const b: WriteLeftover = { pageId: 'p', pagePath: '/x', kind: 'edited', rowId: '9', field: 'n', original: 'o', at: 2 }
  let list = upsertLeftover([], a)
  list = upsertLeftover(list, { ...a, at: 5 })
  list = upsertLeftover(list, b)
  assert.equal(list.length, 2)
  assert.equal(list.find((x) => x.kind === 'created')?.at, 5)
  assert.deepEqual(dropLeftover(list, a), [b])
})

test('白名单：同一页覆盖；解析宽容，坏数据当空', () => {
  const s1 = { pageId: 'p', draft: DRAFT, values: {}, confirmedAt: 1 }
  const list = upsertSpec(upsertSpec([], s1), { ...s1, confirmedAt: 2 })
  assert.equal(list.length, 1)
  assert.equal(list[0]!.confirmedAt, 2)
  assert.deepEqual(parsePageWrite(null), { specs: [], leftovers: [] })
  assert.deepEqual(parsePageWrite('不是 json'), { specs: [], leftovers: [] })
  const raw = JSON.stringify({ specs: [s1, { pageId: 3 }], leftovers: [{ pageId: 'p', pagePath: '/x', kind: 'created', marker: 'ZZ1', at: 1 }, { kind: 'x' }] })
  const got = parsePageWrite(raw)
  assert.equal(got.specs.length, 1)
  assert.equal(got.leftovers.length, 1)
})
