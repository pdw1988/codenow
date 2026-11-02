import test from 'node:test'
import assert from 'node:assert/strict'
import { attributeFailure, attributeSummary } from './attribution'
import type { CaseRunResult, TableChange } from './types'

const change = (over: Partial<TableChange>): TableChange => ({
  tableName: 't_user',
  op: 'insert',
  rowsInserted: 1,
  rowsUpdated: 0,
  rowsDeleted: 0,
  insertedIds: ['1001'],
  deletedIds: [],
  updatedIds: [],
  fieldDiffs: [],
  ...over,
})

const r = (over: Partial<CaseRunResult>): CaseRunResult => ({
  caseId: 'c1',
  apiId: 'a1',
  apiPath: '/api/user/create',
  httpMethod: 'POST',
  caseName: '正常·create',
  caseType: 'normal',
  ok: false,
  httpStatus: 500,
  durationMs: 12,
  responsePreview: '{"code":500}',
  dbChanges: [],
  snapshotErrors: [],
  dataLog: [],
  requestUrl: 'http://x/api/user/create',
  ...over,
})

test('attributeFailure：通过的结果不归因', () => {
  assert.equal(attributeFailure(r({ ok: true })), null)
})

test('500 + 库有写变更 → 疑似写一半回滚；500 无写变更 → 服务端异常', () => {
  const a = attributeFailure(r({ dbChanges: [change({})] }))
  assert.equal(a?.bucket, '疑似写一半回滚')
  assert.match(a?.hint ?? '', /写了一半/)
  const b = attributeFailure(r({ dbChanges: [] }))
  assert.equal(b?.bucket, '服务端异常')
})

test('401/403 归认证、404 归路径、超时与服务错误分开', () => {
  assert.equal(attributeFailure(r({ httpStatus: 401 }))?.bucket, '认证权限')
  assert.equal(attributeFailure(r({ httpStatus: 403 }))?.bucket, '认证权限')
  assert.equal(attributeFailure(r({ httpStatus: 404 }))?.bucket, '路径未命中')
  assert.equal(attributeFailure(r({ httpStatus: null, error: 'Error: 请求超时（10000ms）' }))?.bucket, '服务无响应')
  assert.equal(
    attributeFailure(r({ httpStatus: null, error: 'Error: 请求失败：ECONNREFUSED' }))?.bucket,
    '服务连不上',
  )
})

test('路径参数缺失优先于 HTTP 判定；期望未命中兜底有响应但状态不对的', () => {
  assert.equal(
    attributeFailure(r({ httpStatus: null, error: '路径参数缺失，请求没发出去' }))?.bucket,
    '用例缺参数',
  )
  const a = attributeFailure(r({ ok: false, httpStatus: 200 }))
  assert.equal(a?.bucket, '期望未命中')
  assert.match(a?.hint ?? '', /HTTP 200/)
})

test('baseUrl 进了「服务连不上 / 404」的建议：填错地址是这两桶最常见的真因', () => {
  // 默认值 8080 猜错时每条用例都红成「服务连不上」——hint 里带上当前值，
  // 用户不用再翻环境页核对。不传就维持原话（纯函数：不自己读 store）
  const a = attributeFailure(r({ httpStatus: null, error: 'Error: 请求失败：ECONNREFUSED' }), 'http://localhost:9090')
  assert.match(a?.hint ?? '', /当前 http:\/\/localhost:9090/)
  const b = attributeFailure(r({ httpStatus: 404 }), 'http://localhost:9090')
  assert.match(b?.hint ?? '', /当前 http:\/\/localhost:9090/)
  const c = attributeFailure(r({ httpStatus: null, error: 'Error: 请求失败：ECONNREFUSED' }))
  assert.doesNotMatch(c?.hint ?? '', /当前 /)
})

test('体断言失败自成桶，不许掉进「期望未命中」对着正常 200 说谎', () => {
  const a = attributeFailure(r({ ok: false, httpStatus: 200, assertFails: ['$.level：期望不存在，实际 error'] }))
  assert.equal(a?.bucket, '体断言未命中')
  assert.match(a?.hint ?? '', /\$\.level/)
  // 多条失败只亮第一条，但要告诉用户还有几条
  const b = attributeFailure(r({ ok: false, httpStatus: 200, assertFails: ['x', 'y'] }))
  assert.match(b?.hint ?? '', /共 2 条/)
})

test('快照失败不打断归因，但提示数据验证不可信', () => {
  const a = attributeFailure(
    r({ httpStatus: 500, dbChanges: [], snapshotErrors: [{ tableName: 't_order', message: '表不存在' }] }),
  )
  assert.equal(a?.bucket, '服务端异常')
  assert.match(a?.hint ?? '', /快照有失败.*不可信/)
})

/** 例：存参数配置的接口，500 里裹着这一大段 MyBatis 报错。
 *  异常正文只在 responsePreview 里（runCase 只在网络层失败时填 error）——
 *  只在 error 里找 ORA-01400，这类失败会整批掉进「服务端异常」桶 */
const ORA_01400 =
  '{"msg":"\\n### Error updating database.  Cause: java.sql.SQLIntegrityConstraintViolationException: ' +
  'ORA-01400: cannot insert NULL into (\\"SHOP\\".\\"T_SHOP_PARAM_CONFIG\\".\\"CREATOR\\")\\n\\n' +
  '### The error may involve com.ruoyi.cloud.biz.shop.sys.dao.ShopParamConfigMapper.insert-Inline\\n' +
  '### SQL: INSERT INTO T_SHOP_PARAM_CONFIG ( id, plat_code, conf_code, create_date, modify_date ) VALUES ( ?, ?, ?, ?, ? )\\n"}'

test('ORA-01400：从响应体里认出「插库缺必填列」并报出表.列', () => {
  // error 空着、报错全在 responsePreview 里，这是 HTTP 500 带 body 的真形状
  const a = attributeFailure(r({ httpStatus: 500, responsePreview: ORA_01400 }))
  assert.equal(a?.bucket, '写库缺必填列')
  assert.match(a?.hint ?? '', /T_SHOP_PARAM_CONFIG\.CREATOR/)
  assert.match(a?.hint ?? '', /审计字段/)
})

test('ORA-01400 优先于「疑似写一半回滚」：真因已经查明，别再让人猜回滚', () => {
  const a = attributeFailure(r({ httpStatus: 500, dbChanges: [change({})], responsePreview: ORA_01400 }))
  assert.equal(a?.bucket, '写库缺必填列')
})

test('报错在 error 里也一样认；四种库的「必填列没值」都要认得出', () => {
  const a = attributeFailure(r({ error: 'Error: 500 ORA-01400: cannot insert NULL into ("T_ROLE"."ID")' }))
  assert.equal(a?.bucket, '写库缺必填列')
  assert.match(a?.hint ?? '', /T_ROLE\.ID/)
  const my = attributeFailure(r({ responsePreview: "Column 'creator' cannot be null" }))
  assert.equal(my?.bucket, '写库缺必填列')
  assert.match(my?.hint ?? '', /插库时 creator/)
  // SQL Server 与 PostgreSQL 的另一种说法：认不出的话这两类失败整批掉回通用桶
  const ms = attributeFailure(r({ responsePreview: "Cannot insert the value NULL into column 'Creator', table 'T'; column does not allow nulls." }))
  assert.equal(ms?.bucket, '写库缺必填列')
  assert.match(ms?.hint ?? '', /插库时 Creator/)
  const pg = attributeFailure(r({ responsePreview: 'ERROR: null value in column "creator" violates not-null constraint' }))
  assert.equal(pg?.bucket, '写库缺必填列')
  assert.match(pg?.hint ?? '', /插库时 creator/)
})

test('认不出列名的缺列报错仍归这一桶，只是提示里不编列名', () => {
  const a = attributeFailure(r({ responsePreview: 'cannot insert NULL into the target table' }))
  assert.equal(a?.bucket, '写库缺必填列')
  assert.doesNotMatch(a?.hint ?? '', /插库时 T_/)
})

test('普通 500 照旧归服务端异常（新规则不许把别的 500 也抢走）', () => {
  assert.equal(attributeFailure(r({ responsePreview: '{"code":500,"msg":"boom"}' }))?.bucket, '服务端异常')
  assert.equal(
    attributeFailure(r({ dbChanges: [change({})], responsePreview: '{"code":500,"msg":"boom"}' }))?.bucket,
    '疑似写一半回滚',
  )
})

test('attributeSummary：按桶聚合并去重接口路径，按数量倒序', () => {
  const s = attributeSummary([
    r({ apiPath: '/a', dbChanges: [change({})] }),
    r({ apiPath: '/a', dbChanges: [change({})] }),
    r({ apiPath: '/b', httpStatus: 401 }),
    r({ ok: true }),
  ])
  assert.equal(s.length, 2)
  assert.equal(s[0].bucket, '疑似写一半回滚')
  assert.equal(s[0].count, 2)
  assert.deepEqual(s[0].apis, ['/a'])
  assert.equal(s[1].bucket, '认证权限')
})
