import test from 'node:test'
import assert from 'node:assert/strict'
import { isMissingTableError, missingTableNote } from './missingTable'

test('各方言的「表不存在」报错认得出', () => {
  assert.ok(isMissingTableError('快照查询失败：OCI Error: ORA-00942: table or view does not exist'))
  assert.ok(isMissingTableError("Error 1146 (42S02): Table 'demo.t_user' doesn't exist"))
  assert.ok(isMissingTableError('ER_NO_SUCH_TABLE: no such table'))
  assert.ok(isMissingTableError('relation "t_order" does not exist'))
  assert.ok(isMissingTableError('ERROR 42P01: relation does not exist'))
  assert.ok(isMissingTableError('no such table: t_user'))
})

test('不是「表不存在」的不误伤：列不存在、权限、语法、连接断', () => {
  assert.ok(!isMissingTableError('ORA-00904: "T"."NOPE": invalid identifier'))
  assert.ok(!isMissingTableError("Unknown column 'x' in 'field list'"))
  assert.ok(!isMissingTableError('ORA-01017: invalid username/password'))
  assert.ok(!isMissingTableError('ORA-00933: SQL command not properly ended'))
  assert.ok(!isMissingTableError('connect ECONNREFUSED 127.0.0.1:1521'))
  assert.ok(!isMissingTableError(''))
})

test('话术带表名，说清跳过与出路', () => {
  const note = missingTableNote('t_shop_purchase_dept_psn')
  assert.ok(note.includes('t_shop_purchase_dept_psn'))
  assert.ok(note.includes('跳过'))
  assert.ok(note.includes('关联表'))
})
