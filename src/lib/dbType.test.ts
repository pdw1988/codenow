/**
 * dbType 拆装的不变量：**拆了再装回去必须等于原文**。
 * 装不回去的后果很安静——用户打开编辑弹窗什么都不改就保存，
 * 增量 DDL 里多出一条把类型改了个顺序的 ALTER，四道闸门照不到。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { displayDbType, joinDbType, peelCharUnit, splitDbType } from './dbType'

test('简单带长度类型：base / args 各归各位', () => {
  assert.deepEqual(splitDbType('VARCHAR(50)'), { base: 'VARCHAR', args: '50', unit: '' })
  assert.deepEqual(splitDbType('NUMBER(19)'), { base: 'NUMBER', args: '19', unit: '' })
  assert.deepEqual(splitDbType('TIMESTAMP(6)'), { base: 'TIMESTAMP', args: '6', unit: '' })
})

test('精度+小数位（DECIMAL(10,2)）：args 保留原文的逗号', () => {
  assert.deepEqual(splitDbType('DECIMAL(10,2)'), { base: 'DECIMAL', args: '10,2', unit: '' })
})

test('裸类型没有括号：整体进 base，args 为空', () => {
  assert.deepEqual(splitDbType('DATE'), { base: 'DATE', args: '', unit: '' })
  assert.deepEqual(splitDbType('LONG RAW'), { base: 'LONG RAW', args: '', unit: '' })
})

test('括号不在收尾的多词类型（TIMESTAMP(6) WITH TIME ZONE）：整体当 base，不许重排', () => {
  const parts = splitDbType('TIMESTAMP(6) WITH TIME ZONE')
  assert.equal(parts.args, '')
  assert.equal(joinDbType(parts.base, parts.args, parts.unit), 'TIMESTAMP(6) WITH TIME ZONE')
})

test('括号里带引号/嵌套（ENUM）：整体当 base，不碰引号里的东西', () => {
  const parts = splitDbType("ENUM('a','b')")
  assert.equal(joinDbType(parts.base, parts.args, parts.unit), "ENUM('a','b')")
})

test('Oracle 长度单位：CHAR/BYTE 不进长度框，装回去还在', () => {
  assert.deepEqual(splitDbType('VARCHAR2(100 CHAR)'), { base: 'VARCHAR2', args: '100', unit: 'CHAR' })
  assert.deepEqual(splitDbType('VARCHAR2(100 BYTE)'), { base: 'VARCHAR2', args: '100', unit: 'BYTE' })
  assert.equal(joinDbType('VARCHAR2', '100', 'CHAR'), 'VARCHAR2(100 CHAR)')
  assert.equal(displayDbType('VARCHAR2(100 CHAR)'), 'VARCHAR2(100)')
  assert.deepEqual(peelCharUnit('100 CHAR'), { args: '100', unit: 'CHAR' })
  assert.deepEqual(peelCharUnit('12,2'), { args: '12,2', unit: '' })
})

test('往返不变量：常见的各方言类型拆了再装回去等于原文', () => {
  const samples = [
    'VARCHAR(50)',
    'VARCHAR2(64)',
    'VARCHAR2(100 CHAR)',
    'NVARCHAR2(64)',
    'DECIMAL(12,2)',
    'NUMBER(10)',
    'TINYINT(1)',
    'DATETIME',
    'CLOB',
    'interval day to second',
  ]
  for (const s of samples) {
    const { base, args, unit } = splitDbType(s)
    assert.equal(joinDbType(base, args, unit), s, `往返失败：${s}`)
  }
})

test('装回：args 为空只出 base；两边都空给空串（交给「没填类型」校验拦）', () => {
  assert.equal(joinDbType('DATE', ''), 'DATE')
  assert.equal(joinDbType('', '50'), '')
  assert.equal(joinDbType('  ', ''), '')
})

test('装回：base 手打了完整带括号写法时以 base 为准，不叠加第二个括号', () => {
  assert.equal(joinDbType('VARCHAR(50)', '77'), 'VARCHAR(50)')
})

test('装回：首尾空白归一，但 args 内部原样（10, 2 不改写成 10,2）', () => {
  assert.equal(joinDbType(' VARCHAR ', ' 50 '), 'VARCHAR(50)')
  assert.equal(joinDbType('DECIMAL', '10, 2'), 'DECIMAL(10, 2)')
})
