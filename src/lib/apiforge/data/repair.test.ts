/**
 * 异常学习纯函数的回归：报错抽取（missingHintsFromResponse）、字段候选
 * （refCandidates）、认表（pickRefTable）。借/造/重发的 IO 集成在 prepare.test.ts。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { missingHintsFromResponse, pickRefTable, refCandidates, stemOfFieldName } from './repair'

test('报错抽取：中文业务报错抽出实体名，泛指词不认', () => {
  assert.deepEqual(
    missingHintsFromResponse('{"code":500,"msg":"品牌商不存在"}').map((h) => h.entity),
    ['品牌商'],
  )
  // 修饰词剥掉；[值] 收进 raw 给字段候选对账
  const withValue = missingHintsFromResponse('操作失败：该品牌商[128]不存在，请检查')
  assert.deepEqual(withValue.map((h) => h.entity), ['品牌商'])
  assert.ok(withValue[0]!.raw.includes('128'), '被点名的坏值要留在 raw 里')
  // 请选择（必填校验）同一条路
  assert.deepEqual(missingHintsFromResponse('请选择品牌商').map((h) => h.entity), ['品牌商'])
  // 泛指词是黑名单：参数/字段/token 不是实体
  assert.deepEqual(missingHintsFromResponse('参数不合法'), [])
  assert.deepEqual(missingHintsFromResponse('token无效'), [])
  // 正常响应一条线索都没有
  assert.deepEqual(missingHintsFromResponse('{"code":0,"msg":"操作成功"}'), [])
  assert.deepEqual(missingHintsFromResponse(''), [])
})

test('报错抽取：英文报错同一条路', () => {
  assert.deepEqual(missingHintsFromResponse('{"msg":"brand not found"}').map((h) => h.entity), ['brand'])
  assert.deepEqual(missingHintsFromResponse('Invalid brandId').map((h) => h.entity), ['brandId'])
})

test('字段候选：坏值点名最硬，说明次之，id 形兜底', () => {
  const api = {
    parameters: [{ name: 'id', position: 'path' }],
    requestBodyFields: [
      { name: 'deptId', javaType: 'Long', required: true, description: '部门ID' },
      { name: 'name', javaType: 'String', required: false },
    ],
  }
  // ① 报错里出现了字段的现值：直接锁定
  const byValue = refCandidates(api, { id: 3, __body: '{"deptId":7}' }, { entity: '部门', raw: '部门[7]不存在' })
  assert.deepEqual(byValue[0], { field: 'deptId', kind: 'body', stem: 'dept', why: 'value' })
  // ② 字段说明写着实体名（brandId 的说明是「品牌商ID」这类）
  const byDesc = refCandidates(api, { __body: '{"deptId":999}' }, { entity: '部门', raw: '部门不存在' })
  assert.equal(byDesc[0]!.field, 'deptId')
  assert.equal(byDesc[0]!.why, 'desc')
  // ③ 兜底：全部 id 形字段交给认表（认表唯一命中才算，见 pickRefTable）
  const fallback = refCandidates(api, { __body: '{"name":"x"}' }, { entity: '分组', raw: '分组不存在' })
  assert.equal(fallback[0]!.field, 'id')
  assert.equal(fallback[0]!.why, 'idname')
  assert.ok(fallback.some((c) => c.field === 'deptId'), 'body 里的 id 形字段也参与兜底')
  // name 这种非 id 形字段永不参与
  assert.ok(!fallback.some((c) => c.field === 'name'))
})

test('词干：剥掉 id 后缀；裸 id 与英文单词（liquid）不算', () => {
  assert.equal(stemOfFieldName('brandId'), 'brand')
  assert.equal(stemOfFieldName('user_id'), 'user')
  assert.equal(stemOfFieldName('userID'), 'user')
  assert.equal(stemOfFieldName('id'), '')
  assert.equal(stemOfFieldName('liquid'), '')
})

test('认表：注释 > 类名 > 表名，唯一最高分才认，并列就明说认不准', () => {
  const tables = [
    { name: 'brand', comment: '品牌商' },
    { name: 'agent', comment: '代理商', javaClass: 'AgentInfo' },
    { name: 'brand_info', javaClass: 'Brand' },
  ]
  assert.deepEqual(pickRefTable('brand', '品牌商', tables), { name: 'brand', via: '表注释' })
  // 没有中文实体：表名精确相等压过包含
  assert.deepEqual(pickRefTable('brand', undefined, tables), { name: 'brand', via: '表名' })
  // Java 类名前缀（Agent → AgentInfo）
  assert.deepEqual(pickRefTable('', 'Agent', tables), { name: 'agent', via: 'Java类' })
  // sys_user / sys_role 都包含 sys：认不准
  assert.equal(pickRefTable('sys', undefined, [{ name: 'sys_user' }, { name: 'sys_role' }]), undefined)
  assert.equal(pickRefTable('', '不存在的东西', tables), undefined)
})
