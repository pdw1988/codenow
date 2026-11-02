/**
 * PG 连库：format_type → DDL 词，再走共用 mapMetaColumns。
 * 真库连不上也要钉住这些换算——词没收成 VARCHAR，导出到 MySQL 会带上
 * character varying，Java 类型也会漂。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatPgType, mapPgColumns } from './postgresMeta'

test('format_type 收成用户会写的 DDL 词', () => {
  assert.equal(formatPgType('character varying(255)'), 'VARCHAR(255)')
  assert.equal(formatPgType('character varying'), 'VARCHAR')
  assert.equal(formatPgType('character(10)'), 'CHAR(10)')
  assert.equal(formatPgType('timestamp without time zone'), 'TIMESTAMP')
  assert.equal(formatPgType('timestamp(6) without time zone'), 'TIMESTAMP(6)')
  assert.equal(formatPgType('timestamp with time zone'), 'TIMESTAMP WITH TIME ZONE')
  assert.equal(formatPgType('timestamp(6) with time zone'), 'TIMESTAMP(6) WITH TIME ZONE')
  assert.equal(formatPgType('time without time zone'), 'TIME')
  assert.equal(formatPgType('double precision'), 'DOUBLE PRECISION')
  assert.equal(formatPgType('numeric(10,2)'), 'NUMERIC(10,2)')
  assert.equal(formatPgType('integer'), 'INTEGER')
  assert.equal(formatPgType('jsonb'), 'JSONB')
  assert.equal(formatPgType('integer[]'), 'INTEGER[]')
  assert.equal(formatPgType('character varying(32)[]'), 'VARCHAR(32)[]')
})

test('对不上的用户类型原样留：枚举不能悄悄改成 TEXT', () => {
  assert.equal(formatPgType('order_status'), 'order_status')
  assert.equal(formatPgType(''), '')
})

test('mapPgColumns：SERIAL / IDENTITY 靠 cextra，类型走收过的词', () => {
  const cols = mapPgColumns([
    {
      cname: 'id',
      ctype: 'integer',
      cnull: 'NO',
      cdef: "nextval('user_id_seq'::regclass)",
      ccmt: '主键',
      ckey: 'PRI',
      cextra: 'auto_increment',
    },
    {
      cname: 'email',
      ctype: 'character varying(128)',
      cnull: 'NO',
      cdef: null,
      ccmt: null,
      ckey: 'UNI',
      cextra: '',
    },
    {
      cname: 'paid_at',
      ctype: 'timestamp with time zone',
      cnull: 'YES',
      cdef: null,
      ccmt: null,
      ckey: '',
      cextra: '',
    },
    {
      cname: 'wait',
      ctype: 'interval',
      cnull: 'YES',
      cdef: null,
      ccmt: null,
      ckey: '',
      cextra: '',
    },
  ])
  assert.equal(cols.length, 4)
  const [id, email, paid, wait] = cols
  assert.equal(id.type, 'INTEGER')
  assert.equal(id.isPrimaryKey, true)
  assert.equal(id.isAutoIncrement, true)
  assert.equal(id.javaType, 'Integer')
  assert.equal(email.type, 'VARCHAR(128)')
  assert.equal(email.isUnique, true)
  assert.equal(email.javaType, 'String')
  assert.equal(paid.type, 'TIMESTAMP WITH TIME ZONE')
  assert.equal(paid.javaType, 'java.time.OffsetDateTime')
  assert.equal(wait.type, 'INTERVAL')
  assert.equal(wait.javaType, 'java.time.Duration')
})
