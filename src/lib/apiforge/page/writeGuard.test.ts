import test from 'node:test'
import assert from 'node:assert/strict'
import { isClearlyRead, isSuspectWrite, wordsOf } from './writeGuard'

test('isClearlyRead：GET 不带写动词、读动词打头的 POST 算查询；认不出的 POST 不算', () => {
  assert.equal(isClearlyRead('/order/{id}', 'GET'), true)
  assert.equal(isClearlyRead('/order/listByPage', 'POST'), true)
  assert.equal(isClearlyRead('/order/getDetail', 'POST'), true)
  assert.equal(isClearlyRead('/order/process', 'POST'), false)
  assert.equal(isClearlyRead('/order/save', 'POST'), false)
  assert.equal(isClearlyRead('/order/delete/{id}', 'GET'), false)
  assert.equal(isClearlyRead('/order/{id}', 'DELETE'), false)
})

test('wordsOf：取最后一段路径，按驼峰 / 下划线 / 连字符拆词，去掉查询串和 jsessionid', () => {
  assert.deepEqual(wordsOf('http://h/ui/a/syncAllOrderHistoryData?x=1'), ['sync', 'all', 'order', 'history', 'data'])
  assert.deepEqual(wordsOf('/ui/a/batch_del;jsessionid=AB12'), ['batch', 'del'])
  assert.deepEqual(wordsOf('/ui/a/getHTMLPage'), ['get', 'html', 'page'])
})

test('写动词打头或包含写动词：疑似写请求', () => {
  for (const u of ['/ui/a/syncAllOrderHistoryData', '/ui/a/saveOrUpdate', '/ui/a/deleteById', '/ui/a/batchDel', '/ui/a/submitApply', '/ui/a/approve', '/ui/a/resetPassword', '/ui/a/importExcel', '/ui/a/doCancel']) {
    assert.equal(isSuspectWrite(u), true, u)
  }
})

test('mall / purchase 的审批、签收、确认类写接口也拦', () => {
  for (const u of [
    '/ui/shop/mobile/stock/stockCount/approval', '/ui/shop/mobile/stock/purchaseIn/sign', '/ui/shop/mobile/asset/repairApply/confirmVo',
    '/ui/shop/mobile/asset/assetEquip/equipConfirm', '/ui/shop/mobile/project/construction/sumbit', '/ui/shop/mobile/project/materialPrice/verify',
    '/ui/shop/mobile/view/saleOrder/rejectSaleOrder', '/ui/shop/mobile/purchaseOrder/reject',
    '/ui/shop/mobile/workOrder/dispatch/changeWorkOrder', '/ui/shop/mobile/stock/barCode/genBarCode',
  ]) {
    assert.equal(isSuspectWrite(u), true, u)
  }
  assert.equal(isSuspectWrite('/ui/a/getSignList'), false)
  assert.equal(isSuspectWrite('/ui/shop/mobile/purchase/purchaseApply/detailForChange'), false)
})

test('读动词打头：即使后面带写动词也放行（getAuditList 是查审核列表）', () => {
  for (const u of ['/ui/a/getAuditList', '/ui/a/queryUpdateLog', '/ui/a/listSubmitRecords', '/ui/a/exportDeleteDetail', '/ui/a/toEdit']) {
    assert.equal(isSuspectWrite(u), false, u)
  }
})

test('词要整词命中：getAddress 里的 add、getPushpinList 里的 push 不算', () => {
  assert.equal(isSuspectWrite('/ui/a/getAddress'), false)
  assert.equal(isSuspectWrite('/ui/a/getPurchaseApplyListByPage'), false)
  assert.equal(isSuspectWrite('/ui/a/pushpinList'), false)
})

test('UEditor 读配置（?action=config）放行：拦了编辑器初始化就报错', () => {
  assert.equal(isSuspectWrite('http://h/ui/a/groupNotice/noticeAdd?action=config&noCache=1'), false)
  assert.equal(isSuspectWrite('/ui/common/ueditor/upload/?action=config'), false)
  assert.equal(isSuspectWrite('/ui/common/ueditor/upload/?action=uploadimage'), true)
})

test('静态资源一律放行', () => {
  assert.equal(isSuspectWrite('/static/js/upload.js'), false)
  assert.equal(isSuspectWrite('/static/css/submit.css?v=3'), false)
  assert.equal(isSuspectWrite('/img/delete.png'), false)
})

test('PUT / DELETE / PATCH 一律算写；RESTful 地址末段是 id 时看前一段', () => {
  assert.equal(isSuspectWrite('/api/goods/12', 'DELETE'), true)
  assert.equal(isSuspectWrite('/api/goods', 'put'), true)
  assert.equal(isSuspectWrite('/api/goods/list', 'GET'), false)
  assert.equal(isSuspectWrite('/api/goods/list', 'POST'), false)
  assert.deepEqual(wordsOf('/api/order/submit/2107043479963029506'), ['submit'])
  assert.equal(isSuspectWrite('/api/order/submit/2107043479963029506'), true)
  assert.equal(isSuspectWrite('/api/order/detail/9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f'), false)
})
