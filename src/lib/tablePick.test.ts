/**
 * 选表下拉：最近用过的排前面；筛表名 / 注释 / 拼音 / 类名 / 字段。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Column, TableInfo } from '../types/schema'
import { optionMatches, tableOptions } from './tablePick'

const col = (name: string): Column => ({
  name,
  type: 'VARCHAR(50)',
  nullable: true,
  isPrimaryKey: false,
  isAutoIncrement: false,
  javaField: name,
  javaType: 'String',
})

const tbl = (name: string, over: Partial<TableInfo> = {}): TableInfo => ({
  name,
  source: 'sql',
  columns: [col('id')],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

test('空查询：最近用过的排前面，其余按表名排；请选择永远第一项', () => {
  const tables = [tbl('zeta'), tbl('alpha'), tbl('beta')]
  const opts = tableOptions(tables, { empty: '请选择', recent: ['beta', 'missing'] })
  assert.deepEqual(
    opts.map((o) => o.value),
    ['', 'beta', 'alpha', 'zeta'],
  )
})

test('筛表名、注释拼音、Java 类名、字段名', () => {
  const user = tbl('t_sys_001', {
    comment: '用户表',
    javaClass: 'SysUser',
    columns: [col('id'), col('mobile')],
  })
  const order = tbl('t_ord', { comment: '订单表' })
  const opts = tableOptions([user, order])
  const u = opts.find((o) => o.value === 't_sys_001')!
  assert.equal(optionMatches(u, 't_sys'), true)
  assert.equal(optionMatches(u, 'yh'), true, '注释拼音')
  assert.equal(optionMatches(u, 'SysUser'), true)
  assert.equal(optionMatches(u, 'mobile'), true)
  assert.equal(optionMatches(u, '订单'), false)
  assert.equal(optionMatches({ value: '', label: '请选择' }, 'user'), false)
})
