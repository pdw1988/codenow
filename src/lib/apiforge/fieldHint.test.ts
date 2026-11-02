import test from 'node:test'
import assert from 'node:assert/strict'
import { fieldDocsOf, fieldHint } from './fieldHint'
import type { ScannedType } from './types'

test('fieldHint：信封和分页按常见名兜底，不必先扫', () => {
  assert.equal(fieldHint('code'), '状态码')
  assert.equal(fieldHint('msg'), '提示信息')
  assert.equal(fieldHint('data'), '业务数据')
  assert.equal(fieldHint('rows'), '列表')
  assert.equal(fieldHint('total'), '总条数')
  assert.match(fieldHint('pageNum'), /页码/)
  assert.match(fieldHint('flowCode'), /流程编码/)
})

test('fieldHint：扫描说明优先于常见名', () => {
  const docs = fieldDocsOf([
    {
      name: 'FlowInstanceVo',
      fields: [{ name: 'id', javaType: 'String', required: false, description: '实例id（勿转 Number）' }],
    },
  ])
  assert.match(fieldHint('id', docs), /实例id/)
})

test('fieldHint：同名说明冲突则丢掉，改走常见名', () => {
  const types: ScannedType[] = [
    { name: 'A', fields: [{ name: 'code', javaType: 'String', required: false, description: '门店编码' }] },
    { name: 'B', fields: [{ name: 'code', javaType: 'String', required: false, description: '状态码' }] },
  ]
  const docs = fieldDocsOf(types)
  assert.equal(docs.get('code'), undefined)
  assert.equal(fieldHint('code', docs), '状态码')
})

test('fieldHint：认不出的名字给空串', () => {
  assert.equal(fieldHint('fooBarX'), '')
})
