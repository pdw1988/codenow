/**
 * 方式二「连接数据库」元数据映射的回归。
 *
 * 真库连不上也没法在单测里起 MySQL，这里钉的是行对象 → 领域类型的换算：
 * 驱动回传的行是外部输入（列名大小写、COUNT 回传字符串、复合外键多行），
 * 映射错了界面不报错、只是悄悄导进错的数据——比抛错难查。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildConnUrl,
  describeConn,
  mapMetaColumns,
  mapMetaCounts,
  mapMetaForeignKeys,
  mapMetaIndexes,
  mapMetaTables,
  indexRowsFromGrid,
} from './dbmeta'

test('连接串：用户名密码 encodeURIComponent——密码里有 @ : / 不能把 URL 截断', () => {
  const url = buildConnUrl({ host: '10.0.0.8', port: '3306', user: 'ro@reader', password: 'p@ss:w/rd', db: 'mall' })
  assert.equal(url, 'mysql://ro%40reader:p%40ss%3Aw%2Frd@10.0.0.8:3306/mall')
  // 展示标签永远不含密码
  assert.equal(describeConn({ host: '10.0.0.8', port: '3306', db: 'mall' }), 'mall@10.0.0.8:3306')
})

test('表清单：注释空白给 undefined，没名字的坏行跳过', () => {
  const rows = [
    { tname: ' user ', tcmt: '用户表' },
    { tname: 'order', tcmt: '' },
    { tname: '', tcmt: '没有名字' },
    { tname: null, tcmt: '名字也是空' },
  ]
  assert.deepEqual(mapMetaTables(rows), [
    { name: 'user', comment: '用户表' },
    { name: 'order', comment: undefined },
  ])
})

test('字段数聚合：驱动把 COUNT 回传成字符串也要转成数字', () => {
  const m = mapMetaCounts([
    { tname: 'user', n: '7' },
    { tname: 'order', n: 6 },
    { tname: 'bad', n: 'abc' }, // 转不成数字的不进 Map，宁缺不错
    { tname: null, n: 3 },
  ])
  assert.deepEqual([...m.entries()], [['user', 7], ['order', 6]])
})

test('逐表字段：PRI/自增/可空/默认值/注释全对上，tinyint(1) 的 Java 类型走 toJavaType 同一份规则', () => {
  const cols = mapMetaColumns([
    { cname: 'id', ctype: 'BIGINT', cnull: 'NO', cdef: null, ccmt: '主键', ckey: 'PRI', cextra: 'auto_increment' },
    { cname: 'is_paid', ctype: 'TINYINT(1)', cnull: 'YES', cdef: '0', ccmt: null, ckey: '', cextra: '' },
    { cname: 'create_time', ctype: 'DATETIME', cnull: 'NO', cdef: 'CURRENT_TIMESTAMP', ccmt: '创建时间', ckey: '', cextra: 'DEFAULT_GENERATION' },
    { cname: 'code', ctype: 'VARCHAR(32)', cnull: 'NO', cdef: null, ccmt: '编码', ckey: 'UNI', cextra: '' },
    { cname: 'user_id', ctype: 'BIGINT', cnull: 'NO', cdef: null, ccmt: '用户', ckey: 'MUL', cextra: '' },
    { cname: '', ctype: 'INT', cnull: 'YES', cdef: null, ccmt: null, ckey: '', cextra: '' }, // 坏行跳过
  ])
  assert.equal(cols.length, 5)
  const [id, paid, ct, code, userId] = cols
  assert.equal(id.isPrimaryKey, true)
  assert.equal(id.isAutoIncrement, true)
  assert.equal(!!id.isUnique, false)
  assert.equal(!!id.isIndexed, false)
  assert.equal(id.nullable, false)
  assert.equal(id.javaField, 'id')
  assert.equal(id.comment, '主键')
  // EXTRA 只有 DEFAULT_GENERATION 没有 auto_increment：业务号主键不能被误判成自增
  assert.equal(ct.isAutoIncrement, false)
  assert.equal(ct.defaultValue, 'CURRENT_TIMESTAMP')
  assert.equal(paid.javaType, 'Boolean')
  assert.equal(paid.defaultValue, '0')
  assert.equal(paid.comment, undefined)
  assert.equal(code.isUnique, true)
  assert.equal(code.isPrimaryKey, false)
  assert.equal(!!code.isIndexed, false)
  assert.equal(userId.isIndexed, true)
  assert.equal(!!userId.isUnique, false)
})

test('外键：复合约束按每列一对出一条（跟 ddlParser 单列模型一致），可信度都是 constraint', () => {
  const fks = mapMetaForeignKeys([
    { cname: 'fk_pair', ftbl: 'order_item', fcol: 'order_id', ttbl: 'order', tcol: 'id' },
    { cname: 'fk_pair', ftbl: 'order_item', fcol: 'product_id', ttbl: 'product', tcol: 'id' },
    { cname: null, ftbl: 'a', fcol: 'b_id', ttbl: 'b', tcol: 'id' },
    { cname: 'fk_bad', ftbl: 'x', fcol: '', ttbl: 'y', tcol: 'id' }, // 缺列名的坏行跳过
  ])
  assert.equal(fks.length, 3)
  assert.equal(fks[0].constraintName, 'fk_pair')
  assert.equal(fks[1].constraintName, 'fk_pair')
  assert.equal(fks[1].fromColumn, 'product_id')
  for (const fk of fks) assert.equal(fk.confidence, 'constraint')
})

test('索引元数据：按索引名分组、按列序拼复合索引；表达式索引列跳过不搅乱顺序', () => {
  const idx = mapMetaIndexes([
    { itbl: 't_order', iname: 'ix_sc', iuniq: '0', iseq: '2', icol: 'created_at' },
    { itbl: 't_order', iname: 'ix_sc', iuniq: '0', iseq: '1', icol: 'status' },
    { itbl: 't_order', iname: 'uk_no', iuniq: 1, iseq: 1, icol: 'order_no' },
    { itbl: 't_order', iname: 'ix_fn', iuniq: '0', iseq: 1, icol: null }, // 表达式索引：跳过
    { itbl: 't_order', iname: null, iuniq: '0', iseq: 1, icol: 'x' }, // 没索引名的坏行跳过
  ])
  assert.equal(idx.length, 2)
  const ixSc = idx.find((i) => i.name === 'ix_sc')!
  assert.deepEqual(ixSc.columns, ['status', 'created_at']) // 行序是乱的（字典回传不保证有序），按 iseq 排回来
  assert.equal(ixSc.unique, false)
  assert.deepEqual(idx.find((i) => i.name === 'uk_no')!.columns, ['order_no'])
  assert.equal(idx.find((i) => i.name === 'uk_no')!.unique, true)
})

test('索引元数据：QueryGrid 列名大小写不敏感取值，缺列记 null 不抛错', () => {
  const rows = indexRowsFromGrid(
    // 方言查询按约定 AS 成 itbl/iname/iuniq/iseq/icol；大小写不敏感
    ['ITBL', 'INAME', 'IUNIQ', 'ISEQ', 'ICOL'],
    [['t_order', 'ix_a', '1', '1', 'id'], ['t_order', '', '0', '2', 'x']],
  )
  assert.equal(rows[0].itbl, 't_order')
  assert.equal(rows[0].iname, 'ix_a')
  assert.equal(rows[0].iuniq, '1')
  assert.equal(rows[1].iname, '') // 空串照原样带回，坏行交由 mapMetaIndexes 跳过
  // 查询缺某列时整列都是 null（方言查询少写了列不崩，映射层照常工作）
  const sparse = indexRowsFromGrid(['itbl', 'iname'], [['t', 'ix']])
  assert.equal(sparse[0].iuniq, null)
  assert.equal(sparse[0].icol, null)
})
