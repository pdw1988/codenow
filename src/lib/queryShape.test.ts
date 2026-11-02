import test from 'node:test'
import assert from 'node:assert/strict'
import type { Column } from '../types/schema'
import {
  DEFAULT_QUERY_SHAPE,
  defaultOrderColumn,
  groupOrderAllow,
  groupSelectExprs,
  resolveOrder,
  shapeSummary,
  type QueryShape,
} from './queryShape'
import { previewSqlWithWhere } from './sqlReadonly'

const col = (name: string, type: string, pk = false): Column => ({
  name,
  type,
  comment: '',
  nullable: !pk,
  isPrimaryKey: pk,
  isAutoIncrement: false,
  javaField: name.toLowerCase(),
  javaType: 'String',
})

const shapeOf = (patch: Partial<QueryShape> = {}): QueryShape => ({
  ...DEFAULT_QUERY_SHAPE,
  ...patch,
})

test('默认：不分组、按 id 降序、一页 20 条', () => {
  assert.equal(DEFAULT_QUERY_SHAPE.groupCol, '')
  assert.equal(DEFAULT_QUERY_SHAPE.orderDir, 'desc')
  assert.equal(DEFAULT_QUERY_SHAPE.pageSize, 20)
  assert.equal(DEFAULT_QUERY_SHAPE.pageIndex, 0)
})

test('默认排序列：主键 → 名字叫 id 的列 → 第一列', () => {
  assert.equal(
    defaultOrderColumn([col('NAME', 'VARCHAR2(50)'), col('USER_ID', 'NUMBER', true)]),
    'USER_ID',
  )
  // 连库没拿到主键标（权限/字典查失败）时靠名字兼容，大小写都认
  assert.equal(defaultOrderColumn([col('NAME', 'VARCHAR2(50)'), col('id', 'NUMBER')]), 'id')
  assert.equal(defaultOrderColumn([col('NAME', 'VARCHAR2(50)'), col('ID', 'NUMBER')]), 'ID')
  assert.equal(defaultOrderColumn([col('NAME', 'VARCHAR2(50)')]), 'NAME')
  assert.equal(defaultOrderColumn([]), '')
})

test('排序列不在 SELECT 里就退回默认，默认也不在就拿第一个', () => {
  const allow = ['ID', 'NAME']
  assert.deepEqual(resolveOrder(shapeOf({ orderCol: 'NAME' }), allow, 'ID'), {
    column: 'NAME',
    dir: 'desc',
  })
  // 勾列把排序列取消了：不能拼出 ORDER BY 一个没进 SELECT 的列
  assert.deepEqual(resolveOrder(shapeOf({ orderCol: 'GONE' }), allow, 'ID'), {
    column: 'ID',
    dir: 'desc',
  })
  assert.deepEqual(resolveOrder(shapeOf({ orderCol: 'GONE' }), allow, 'ALSO_GONE'), {
    column: 'ID',
    dir: 'desc',
  })
  assert.equal(resolveOrder(shapeOf(), [], 'ID'), undefined)
})

test('分组：SELECT 只有分组列 + COUNT(*)，排序只能在这两个里选', () => {
  assert.deepEqual(groupSelectExprs('oracle', 'STATUS'), ['"STATUS"', 'COUNT(*) AS "cnt"'])
  assert.deepEqual(groupSelectExprs('mysql', 'status'), ['`status`', 'COUNT(*) AS `cnt`'])
  assert.deepEqual(groupOrderAllow('STATUS'), ['STATUS', 'cnt'])
})

test('摘要：折起时不展开也能看见怎么排、分没分组、第几页', () => {
  assert.equal(shapeSummary(shapeOf(), 'ID', true), '按 ID 降序 · 不分组 · 第 1 页 · 每页 20')
  assert.equal(
    shapeSummary(shapeOf({ groupCol: 'STATUS', orderDir: 'asc', pageIndex: 2 }), 'cnt', false),
    '按 cnt 升序 · 分组 STATUS（字段勾选不生效） · 第 3 页（末页） · 每页 20',
  )
})

test('ORDER BY 拼在 WHERE / GROUP BY 后面，分页外包之前', () => {
  const id = col('ID', 'NUMBER', true)
  assert.equal(
    previewSqlWithWhere('mysql', 't', ['id'], [{ column: id, value: '1', op: 'eq' }], {
      orderBy: { column: 'id', dir: 'desc' },
    }),
    'SELECT `id` FROM `t` WHERE `ID` = \'1\' ORDER BY `id` DESC',
  )
  assert.equal(
    previewSqlWithWhere('mysql', 't', undefined, [], {
      exprs: ['`status`', 'COUNT(*) AS `cnt`'],
      groupBy: ['status'],
      orderBy: { column: 'cnt', dir: 'desc' },
    }),
    'SELECT `status`, COUNT(*) AS `cnt` FROM `t` GROUP BY `status` ORDER BY `cnt` DESC',
  )
})

test('分页：四种方言各走各的，Oracle 不能出 OFFSET/FETCH（11g 会 ORA-00933）', () => {
  const page = { size: 20, index: 0 }
  const mysql = previewSqlWithWhere('mysql', 't', undefined, [], { page })
  const pg = previewSqlWithWhere('postgresql', 't', undefined, [], { page })
  const sqlite = previewSqlWithWhere('sqlite', 't', undefined, [], { page })
  const oracle = previewSqlWithWhere('oracle', 'T', undefined, [], { page })

  assert.match(mysql, /LIMIT 0, 20$/)
  assert.match(pg, /LIMIT 20 OFFSET 0$/)
  assert.match(sqlite, /LIMIT 20 OFFSET 0$/)
  assert.match(oracle, /ROWNUM <= 20/)
  assert.doesNotMatch(oracle, /FETCH NEXT/)
  assert.doesNotMatch(oracle, /OFFSET/)
})

test('第二页：Oracle 外包两层算 rn，其他方言改 offset', () => {
  const page = { size: 20, index: 2 }
  assert.match(previewSqlWithWhere('mysql', 't', undefined, [], { page }), /LIMIT 40, 20$/)
  assert.match(
    previewSqlWithWhere('postgresql', 't', undefined, [], { page }),
    /LIMIT 20 OFFSET 40$/,
  )
  const oracle = previewSqlWithWhere('oracle', 'T', undefined, [], { page })
  assert.match(oracle, /ROWNUM <= 60/)
  assert.match(oracle, /rn > 40/)
})

test('ORDER BY 必须在分页外包之内：Oracle 先截后排会截错行', () => {
  const oracle = previewSqlWithWhere('oracle', 'T', undefined, [], {
    orderBy: { column: 'ID', dir: 'desc' },
    page: { size: 20, index: 0 },
  })
  const inner = oracle.indexOf('ORDER BY "ID" DESC')
  const outer = oracle.indexOf('ROWNUM <= 20')
  assert.ok(inner > 0, 'ORDER BY 应该在语句里')
  assert.ok(inner < outer, 'ORDER BY 要在 ROWNUM 外包之前')
})

test('page.size <= 0 视作不分页；不传 page 也不分页', () => {
  assert.equal(
    previewSqlWithWhere('mysql', 't', undefined, [], { page: { size: 0, index: 0 } }),
    'SELECT * FROM `t`',
  )
  assert.equal(previewSqlWithWhere('mysql', 't', undefined, []), 'SELECT * FROM `t`')
})
