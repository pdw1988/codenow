import test from 'node:test'
import assert from 'node:assert/strict'
import { apiActionOf, dbChangeOfAction, guessApiAction, isCallbackApi, isReadAction } from './apiAction'
import type { ApiMethod, DtoField } from '../types'

const a = (httpMethod: ApiMethod['httpMethod'], path: string, fields: DtoField[] = []) =>
  ({ httpMethod, path, requestBodyFields: fields })

test('apiAction：POST 按接口名分查增改删（SHOP 几乎全是 POST）', () => {
  assert.equal(guessApiAction(a('POST', '/brand/deleteBrand')), 'delete')
  assert.equal(guessApiAction(a('POST', '/brand/removeById')), 'delete')
  assert.equal(guessApiAction(a('POST', '/brand/updateBrand')), 'update')
  assert.equal(guessApiAction(a('POST', '/apply/approveApply')), 'update')
  assert.equal(guessApiAction(a('POST', '/apply/saveApply')), 'insert')
  assert.equal(guessApiAction(a('POST', '/apply/addDetail')), 'insert')
  assert.equal(guessApiAction(a('POST', '/apply/getList')), 'query')
  assert.equal(guessApiAction(a('POST', '/apply/listByPage')), 'query')
  // 读动词打头即使带写词也是查（getAuditList 是查审核列表）
  assert.equal(guessApiAction(a('POST', '/apply/getAuditList')), 'query')
  // 认不出的不瞎猜
  assert.equal(guessApiAction(a('POST', '/apply/process')), 'unknown')
})

test('apiAction：非 POST 照请求方法；GET 带写动词按词认', () => {
  assert.equal(guessApiAction(a('GET', '/order/list')), 'query')
  assert.equal(guessApiAction(a('GET', '/order/syncAll')), 'unknown')
  assert.equal(guessApiAction(a('GET', '/order/deleteById')), 'delete')
  assert.equal(guessApiAction(a('PUT', '/order/1')), 'update')
  assert.equal(guessApiAction(a('PATCH', '/order/1')), 'update')
  assert.equal(guessApiAction(a('DELETE', '/order/1')), 'delete')
})

test('apiAction：saveOrUpdate body 带 id 算改，没带算增', () => {
  const id: DtoField = { name: 'id', javaType: 'Long', required: false }
  const name: DtoField = { name: 'name', javaType: 'String', required: false }
  assert.equal(guessApiAction(a('POST', '/brand/saveOrUpdate', [id, name])), 'update')
  assert.equal(guessApiAction(a('POST', '/brand/saveOrUpdate', [name])), 'insert')
})

test('apiAction：手改优先；只读跑只认确定的查询', () => {
  assert.equal(apiActionOf({ ...a('POST', '/apply/check'), action: 'update' }), 'update')
  assert.equal(isReadAction(a('POST', '/apply/check')), true)
  assert.equal(isReadAction({ ...a('POST', '/apply/check'), action: 'update' }), false)
  assert.equal(isReadAction(a('POST', '/apply/process')), false)
})

test('isCallbackApi：路径末段以 push / notify / callback 结尾才算', () => {
  assert.equal(isCallbackApi(a('POST', '/api/shop/payorderpush/orderPush')), true)
  assert.equal(isCallbackApi(a('POST', '/pay/wxNotify')), true)
  assert.equal(isCallbackApi(a('POST', '/sso/callback')), true)
  assert.equal(isCallbackApi(a('POST', '/apply/pushToNc')), false)
  assert.equal(isCallbackApi(a('POST', '/payorderpush/list')), false)
})

test('apiAction：预计库变化跟着分类走，认不出的按请求方法', () => {
  assert.equal(dbChangeOfAction('delete', 'POST'), 'delete')
  assert.equal(dbChangeOfAction('query', 'POST'), 'none')
  assert.equal(dbChangeOfAction('unknown', 'POST'), 'insert')
  assert.equal(dbChangeOfAction('unknown', 'GET'), 'none')
})
