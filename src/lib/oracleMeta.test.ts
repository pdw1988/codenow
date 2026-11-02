/**
 * Oracle 连库：Easy Connect 拼法和字典行 → 类型 / Column 的回归。
 *
 * 真库连不上也没法在 CI 里起 Oracle，这里钉的是换算。
 * 拼错类型不会抛错，只会让 Java 映射和导出 DDL 悄悄走样。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildOracleConnectString, formatOracleType, mapOracleColumns } from './oracleMeta'

test('Easy Connect：服务名走 host:port/service', () => {
  assert.equal(buildOracleConnectString('10.0.0.8', '1521', 'ORCLPDB1'), '10.0.0.8:1521/ORCLPDB1')
})

test('SID 写成描述符：薄驱动不认 host:port:sid，会报 no configuration directory', () => {
  const want =
    '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=10.0.0.8)(PORT=1521))(CONNECT_DATA=(SID=ORCL)))'
  assert.equal(buildOracleConnectString('10.0.0.8', '1521', ':ORCL'), want)
  assert.equal(buildOracleConnectString('ignored', '1521', '10.0.0.8:1521:ORCL'), want)
})

test('Easy Connect：整段描述符或已带主机的串不再包一层', () => {
  assert.equal(
    buildOracleConnectString('localhost', '1521', '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=x)(PORT=1521)))'),
    '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=x)(PORT=1521)))',
  )
  assert.equal(buildOracleConnectString('ignored', '1521', 'db.corp.local:1521/prod'), 'db.corp.local:1521/prod')
})

test('类型：NUMBER 精度和小数位必须拼回去，否则 Java 类型会从 Long 变成 BigDecimal', () => {
  assert.equal(formatOracleType({ dtype: 'NUMBER', dprec: '18', dscale: '0' }), 'NUMBER(18)')
  assert.equal(formatOracleType({ dtype: 'NUMBER', dprec: '10', dscale: '2' }), 'NUMBER(10,2)')
  assert.equal(formatOracleType({ dtype: 'NUMBER', dprec: null, dscale: null }), 'NUMBER')
  assert.equal(formatOracleType({ dtype: 'NUMBER', dprec: '1', dscale: '0' }), 'NUMBER(1)')
})

test('类型：字符串长度只保留数字，不拼 CHAR/BYTE 单位', () => {
  // NVARCHAR2(n CHAR) 不是合法 Oracle 语法；用户确认过导出只要长度
  assert.equal(formatOracleType({ dtype: 'VARCHAR2', clen: '50', cused: 'C' }), 'VARCHAR2(50)')
  assert.equal(formatOracleType({ dtype: 'VARCHAR2', clen: '50', cused: 'B' }), 'VARCHAR2(50)')
  assert.equal(formatOracleType({ dtype: 'NVARCHAR2', clen: '1000', cused: 'C' }), 'NVARCHAR2(1000)')
  assert.equal(formatOracleType({ dtype: 'CHAR', clen: '2', cused: 'C' }), 'CHAR(2)')
  assert.equal(formatOracleType({ dtype: 'NCHAR', clen: '8' }), 'NCHAR(8)')
})

test('类型：DATA_TYPE 已带括号的原样保留（带时区的 TIMESTAMP）', () => {
  assert.equal(
    formatOracleType({ dtype: 'TIMESTAMP(6) WITH TIME ZONE' }),
    'TIMESTAMP(6) WITH TIME ZONE',
  )
  assert.equal(formatOracleType({ dtype: 'RAW', dlen: '16' }), 'RAW(16)')
  assert.equal(formatOracleType({ dtype: 'FLOAT', dprec: '126' }), 'FLOAT(126)')
})

test('逐表字段：Y/N 可空、identity 自增、NUMBER(1) 不当布尔、NUMBER(25) 不给 Long', () => {
  const cols = mapOracleColumns([
    {
      cname: 'ID',
      dtype: 'NUMBER',
      dprec: '18',
      dscale: '0',
      cnull: 'N',
      ccmt: '主键',
      pk: 'Y',
      ident: 'Y',
      uniq: 'Y',
    },
    {
      cname: 'IS_PUBLISH',
      dtype: 'NUMBER',
      dprec: '1',
      dscale: '0',
      cnull: 'Y',
      cdef: '0',
      pk: 'N',
      ident: 'N',
    },
    {
      cname: 'AMOUNT',
      dtype: 'NUMBER',
      dprec: '25',
      dscale: '0',
      cnull: 'N',
      pk: 'N',
    },
    {
      cname: 'ORDER_NO',
      dtype: 'VARCHAR2',
      clen: '32',
      cused: 'C',
      cnull: 'N',
      pk: 'N',
      uniq: 'Y',
    },
    { cname: '', dtype: 'DATE', cnull: 'Y' },
  ])
  assert.equal(cols.length, 4)
  const [id, flag, amount, no] = cols
  assert.equal(id.isPrimaryKey, true)
  assert.equal(id.isAutoIncrement, true)
  assert.equal(!!id.isUnique, false)
  assert.equal(id.nullable, false)
  assert.equal(id.type, 'NUMBER(18)')
  assert.equal(id.javaType, 'Long')
  assert.equal(id.comment, '主键')

  assert.equal(flag.nullable, true)
  assert.equal(flag.type, 'NUMBER(1)')
  assert.equal(flag.javaType, 'Integer')
  assert.equal(flag.defaultValue, '0')

  assert.equal(amount.javaType, 'java.math.BigDecimal')
  assert.equal(no.isUnique, true)
  assert.equal(no.type, 'VARCHAR2(32)')
  assert.equal(no.javaType, 'String')
})
