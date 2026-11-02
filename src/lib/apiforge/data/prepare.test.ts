/**
 * 库前置数据（造数 / 逆序清理）的回归测试，PRD 4.4。
 *
 * 这个模块的输出全是**要发到用户真库上执行的 SQL**，所以主力测试不比字符串，
 * 而是用 exportDdl 在 node:sqlite 里真建表（自增主键、NOT NULL、真外键约束都有），
 * 把生成的 INSERT / DELETE 真跑一遍 —— 语法、NOT NULL、外键顺序、自增回查当场暴露。
 * CLAUDE.md 的纪律：类型检查证明不了生成的 SQL 能跑。
 *
 * 每条用例对应一个真踩过（或者一定会踩）的坑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import type { Column, ForeignKey, TableInfo } from '../../../types/schema'
import type { QueryGrid } from '../../sqlReadonly'
import type { ApiMethod, TableRelation } from '../types'
import { parseDdl } from '../../ddlParser'
import { exportDdl } from '../../sqlgen/ddlExport'
import { mockValueOfField } from '../../sqlgen/mockValue'
import {
  applyReadBackfill,
  applySampleValues,
  cleanupSqlOf,
  columnOverridesOf,
  makeFixtureSession,
  orderFixtures,
  pathValuesOf,
  pkQueryOf,
  planFixture,
  planReadBackfill,
  readBackfillOf,
  type FixtureDeps,
  type ReadFill,
} from './prepare'

const DDL = `
CREATE TABLE \`dept\` (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键',
  dept_name VARCHAR(50) NOT NULL COMMENT '部门名',
  PRIMARY KEY (id)
) COMMENT='部门';
CREATE TABLE \`emp\` (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键',
  emp_name VARCHAR(50) NOT NULL COMMENT '姓名',
  phone VARCHAR(20) COMMENT '手机号',
  dept_id BIGINT NOT NULL COMMENT '所属部门',
  PRIMARY KEY (id),
  CONSTRAINT fk_emp_dept FOREIGN KEY (dept_id) REFERENCES \`dept\`(id)
) COMMENT='员工';
CREATE TABLE \`goods\` (
  goods_code VARCHAR(32) NOT NULL COMMENT '商品编码',
  goods_name VARCHAR(50) COMMENT '名称',
  PRIMARY KEY (goods_code)
) COMMENT='商品';
CREATE TABLE \`audit_log\` (
  note VARCHAR(200) COMMENT '说明'
) COMMENT='没有主键的表';
`

const parsed = parseDdl(DDL, 'mysql')
assert.deepEqual(parsed.errors, [], `fixture DDL 解析失败：${parsed.errors.join('; ')}`)
const byName = new Map(parsed.tables.map((t) => [t.name, t]))
const get = (n: string): TableInfo => {
  const t = byName.get(n)
  assert.ok(t, `fixture 缺少表 ${n}`)
  return t
}
const colsOf = (n: string): Column[] => get(n).columns

/** 真的 SQLite 引擎 + 真外键约束（不开 PRAGMA 的话外键顺序错了也不报错，等于白测） */
function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  // 主表先建：从表的 FOREIGN KEY 要求被引用的表已经存在
  for (const name of ['dept', 'emp', 'goods', 'audit_log']) {
    db.exec(exportDdl(get(name), { dialect: 'sqlite', foreignKeys: parsed.foreignKeys }))
  }
  return db
}

/** 替身：写语句真跑、只读回查真跑，并记下发出去的每一条语句供断言 */
function depsOf(
  db: DatabaseSync,
  fks: ForeignKey[] = parsed.foreignKeys,
  tables: TableInfo[] = parsed.tables,
): FixtureDeps & { sent: string[] } {
  const sent: string[] = []
  const byTable = new Map(tables.map((t) => [t.name, t]))
  return {
    sent,
    lookupColumns: async (t) => (byTable.has(t) ? byTable.get(t)!.columns : []),
    foreignKeys: fks,
    execSql: async (statements) => {
      sent.push(...statements)
      let affected = 0
      for (const s of statements) {
        affected += Number(db.prepare(s).run().changes)
      }
      return { affected, ran: statements.length }
    },
    query: async (sql): Promise<QueryGrid> => {
      const rows = db.prepare(sql).all() as Record<string, unknown>[]
      const columns = rows.length ? Object.keys(rows[0]!) : []
      return {
        columns,
        rows: rows.map((r) => Object.values(r).map((v) => (v === null ? '' : String(v)))),
        truncated: false,
        cap: 1,
      }
    },
    dialect: 'sqlite',
    seed: 0,
  }
}

const count = (db: DatabaseSync, table: string): number =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n)

/** 只造路径参数；其余字段跟这次要测的东西无关，给最小可用的值 */
function apiOf(
  path: string,
  ...params: {
    name: string
    javaType: string
    position?: 'path' | 'query'
    defaultValue?: string
  }[]
): ApiMethod {
  return {
    id: path,
    methodName: 'handle',
    httpMethod: 'PUT',
    path,
    parameters: params.map((p) => ({
      name: p.name,
      javaType: p.javaType,
      position: p.position ?? 'path',
      required: true,
      defaultValue: p.defaultValue,
    })),
    requestBodyType: null,
    requestBodyFields: [],
    responseType: 'void',
    description: '',
    controllerClass: 'DemoController',
    filePath: 'DemoController.java',
    projectId: 'p1',
  }
}

const relOf = (...tables: string[]): TableRelation[] =>
  tables.map((tableName) => ({ tableName, confidence: 'mapper', source: '', enabled: true }))

/* ================= 生成 → 真执行 ================= */

test('自增主键不显式插：插完靠只读回查定位，这才删得掉', async () => {
  const db = openDb()
  try {
    const columns = colsOf('emp')
    const plan = planFixture('emp', columns, 'sqlite', 0)

    // 自增列不参与 INSERT（PRD 4.4），NOT NULL 的另外两列必须在
    const insert = plan.insertSql
    assert.ok(insert, '有非自增列就必须给得出 INSERT')
    assert.doesNotMatch(insert, /"id"/)
    assert.match(insert, /"emp_name"/)
    assert.match(insert, /"dept_id"/)
    assert.equal(plan.autoPk, true)
    // 主键值未知 → 必须给我一条回查 SQL，否则这行插了就定位不回来
    const readBack = plan.pkQuerySql
    assert.ok(readBack, '自增主键没有回查 SQL，插进去的行永远清不掉')

    // 外键列此刻没有父行，先关掉约束单独验插入（父子对齐在下面那条用例里）
    db.exec('PRAGMA foreign_keys = OFF')
    const deps = depsOf(db)
    await deps.execSql([insert])
    assert.equal(count(db, 'emp'), 1)

    const grid = await deps.query(readBack)
    const pk = grid.rows[0]![0]!
    assert.equal(pk, '1', '回查要拿到库真正分配的主键')

    const del = cleanupSqlOf('emp', plan.pkCols, [pk], 'sqlite')
    assert.ok(del, '有主键就必须给得出清理语句')
    assert.match(del, /WHERE/, '清理语句必须带 WHERE，绝不整表删')
    await deps.execSql([del])
    assert.equal(count(db, 'emp'), 0)
  } finally {
    db.close()
  }
})

test('外键列对齐父表刚插的主键；顺序错了真库会当场拒绝', async () => {
  const db = openDb()
  try {
    // 先证明这条用例有意义：外键约束是真的在拦
    assert.throws(() =>
      db
        .prepare('INSERT INTO "emp" ("emp_name", "dept_id") VALUES (\'张三\', 99999)')
        .run(),
    )

    const deps = depsOf(db)
    const fx = makeFixtureSession(deps)
    // 路径参数叫 name，表里只有 emp_name —— 对不上，于是 emp 的主键留给库自增（走回查那条路）
    const api = apiOf('/api/emp/{name}', { name: 'name', javaType: 'String' })
    const log = await fx.prepareFor(api, relOf('emp', 'dept'))

    assert.equal(count(db, 'dept'), 1)
    assert.equal(count(db, 'emp'), 1)
    const parent = db.prepare('SELECT "id" FROM "dept"').get() as { id: number }
    const child = db.prepare('SELECT "dept_id" FROM "emp"').get() as { dept_id: number }
    assert.equal(child.dept_id, parent.id, 'emp.dept_id 必须指向刚插进去的那行 dept')

    // 父表先插：日志里 dept 的 INSERT 排在 emp 前面
    const order = log.map((l) => (l.includes('"dept"') ? 'dept' : l.includes('"emp"') ? 'emp' : ''))
    assert.ok(order.indexOf('dept') < order.indexOf('emp'), `插入顺序反了：${log.join(' | ')}`)

    // 清理逆序：先删子表再删父表，否则外键拦着删不掉
    const clean = await fx.finishFor(api.id)
    const iEmp = clean.findIndex((l) => l.includes('"emp"'))
    const iDept = clean.findIndex((l) => l.includes('"dept"'))
    assert.ok(iEmp >= 0 && iDept >= 0 && iEmp < iDept, `清理顺序反了：${clean.join(' | ')}`)
    assert.equal(count(db, 'emp'), 0)
    assert.equal(count(db, 'dept'), 0)
    assert.equal(fx.insertedCount(), 2)
  } finally {
    db.close()
  }
})

test('无主键表：插得进去但定位不到，日志明说「未自动清理」，不假装成功', async () => {
  const db = openDb()
  try {
    const fx = makeFixtureSession(depsOf(db))
    const api = apiOf('/api/audit/{note}', { name: 'note', javaType: 'String' })
    await fx.prepareFor(api, relOf('audit_log'))
    assert.equal(count(db, 'audit_log'), 1)

    const clean = await fx.finishFor(api.id)
    assert.equal(clean.length, 1)
    assert.match(clean[0]!, /未自动清理/)
    // 关键：不能因为「定位不到」就退化成按范围删
    assert.doesNotMatch(clean[0]!, /DELETE/i)
    assert.equal(count(db, 'audit_log'), 1, '没有主键的表，那行留着并如实报告')
  } finally {
    db.close()
  }
})

test('撞唯一键（那行本来就在）不算失败，更不能记进清理清单', async () => {
  const db = openDb()
  try {
    // 路径参数点名了主键 = G001，用例要动的就是这行 —— 它已经在库里了
    db.exec('INSERT INTO "goods" ("goods_code", "goods_name") VALUES (\'G001\', \'既有商品\')')
    const deps = depsOf(db)
    const fx = makeFixtureSession(deps)
    const api = apiOf('/api/goods/{goodsCode}', { name: 'goodsCode', javaType: 'String' })
    const log = await fx.prepareFor(api, relOf('goods'), { goodsCode: 'G001' })

    assert.match(log.join('\n'), /造行失败/)
    assert.equal(fx.insertedCount(), 0)
    assert.equal(count(db, 'goods'), 1, '没有多插一行')
    assert.deepEqual(fx.fillsFor(api.id), [], '没插进去就没有可回填的行')

    // 那行不是我们造的，清理时删掉等于删用户的数据
    const clean = await fx.finishFor(api.id)
    assert.deepEqual(clean, [])
    assert.equal(count(db, 'goods'), 1)
  } finally {
    db.close()
  }
})

test('取消/中途抛异常走 finishAll：还挂着的行全清掉，一条不留在用户库里', async () => {
  const db = openDb()
  try {
    const fx = makeFixtureSession(depsOf(db))
    const a = apiOf('/api/dept/{id}', { name: 'id', javaType: 'Long' })
    const b = apiOf('/api/goods/{goodsCode}', { name: 'goodsCode', javaType: 'String' })
    await fx.prepareFor(a, relOf('dept'))
    await fx.prepareFor(b, relOf('goods'))
    assert.equal(count(db, 'dept'), 1)
    assert.equal(count(db, 'goods'), 1)

    const log = await fx.finishAll()
    assert.equal(count(db, 'dept'), 0)
    assert.equal(count(db, 'goods'), 0)
    assert.match(log.join('\n'), /DELETE FROM "goods"/)
    // 清完再清是空操作（runRegressionPipeline 的正常跑完路径就是这么调的）
    assert.deepEqual(await fx.finishAll(), [])
  } finally {
    db.close()
  }
})

test('同一接口并发准备只备一次（GET 组并发 3，两条用例同时进来）', async () => {
  const db = openDb()
  try {
    const fx = makeFixtureSession(depsOf(db))
    const api = apiOf('/api/dept/{id}', { name: 'id', javaType: 'Long' })
    const [first, second] = await Promise.all([
      fx.prepareFor(api, relOf('dept')),
      fx.prepareFor(api, relOf('dept')),
    ])
    // 后进来的那个不重复记日志：它的 dataLog 里不该出现它没做的事
    assert.ok(first.length > 0)
    assert.deepEqual(second, [])
    assert.equal(count(db, 'dept'), 1)
    assert.equal(fx.insertedCount(), 1)
  } finally {
    db.close()
  }
})

test('没有关联表 / 取不到列清单：一条写库语句都不发', async () => {
  const db = openDb()
  try {
    const deps = depsOf(db)
    const fx = makeFixtureSession(deps)

    assert.deepEqual(await fx.prepareFor(apiOf('/api/x/{id}', { name: 'id', javaType: 'Long' }), []), [])
    assert.deepEqual(
      await fx.prepareFor(
        apiOf('/api/y/{id}', { name: 'id', javaType: 'Long' }),
        relOf('没有这张表'),
      ),
      ['造行：没有这张表 取不到列清单，跳过'],
    )
    assert.deepEqual(deps.sent, [])
  } finally {
    db.close()
  }
})

test('只有自增主键一列的表：没有可插入的列，跳过而不是发一条空 INSERT', () => {
  const onlyPk: Column = {
    name: 'id',
    type: 'BIGINT',
    nullable: false,
    isPrimaryKey: true,
    isAutoIncrement: true,
    javaField: 'id',
    javaType: 'Long',
  }
  const plan = planFixture('t', [onlyPk], 'sqlite', 0)
  assert.equal(plan.insertSql, null)
  assert.equal(plan.note, '没有可插入的列')
})

/* ================= 纯函数：对齐规则 ================= */

test('路径参数按列名对齐，camelCase 也命中（{goodsCode} → goods_code）', () => {
  const out = columnOverridesOf(
    'goods',
    colsOf('goods'),
    { goodsCode: 'G001' },
    new Map(),
    parsed.foreignKeys,
  )
  assert.deepEqual(out, { goods_code: 'G001' })
})

test('一个路径参数都没对上：退一步把数字主键对齐第一个数字路径值（{applyId} 配表主键 id）', () => {
  const out = columnOverridesOf(
    'dept',
    colsOf('dept'),
    { applyId: '123' },
    new Map(),
    parsed.foreignKeys,
  )
  assert.deepEqual(out, { id: '123' })
})

test('字符串主键不猜：{applyId} 配商品表的 goods_code 不给值，宁可让它走自动值', () => {
  const out = columnOverridesOf(
    'goods',
    colsOf('goods'),
    { applyId: '123' },
    new Map(),
    parsed.foreignKeys,
  )
  assert.deepEqual(out, {})
})

test('路径值不是数字时不硬凑主键：{name} 拿的是「张三」，主键留给库自增', () => {
  const out = columnOverridesOf(
    'emp',
    colsOf('emp'),
    { name: '张三' },
    new Map(),
    parsed.foreignKeys,
  )
  assert.deepEqual(out, {})
})

test('pathValuesOf：用例值 > 参数 defaultValue > 语义字典，query 参数不参与对齐', () => {
  const api = apiOf(
    '/api/emp/{id}/{name}/{code}',
    { name: 'id', javaType: 'Long' },
    { name: 'name', javaType: 'String' },
    { name: 'code', javaType: 'String', defaultValue: 'VIP' },
    { name: 'page', javaType: 'Integer', position: 'query' },
  )
  // 用例里有就用用例的（那正是请求要发的值）；query 参数不是路径参数
  assert.deepEqual(pathValuesOf(api, { id: 7, name: '张三', code: 'A9', page: 3 }), {
    id: '7',
    name: '张三',
    code: 'A9',
  })

  const filled = pathValuesOf(api)
  assert.equal(filled.id, '1', '没有可用信息时按类型给默认值')
  // 值本身归 mockValue 的词表管（另有单测钉），这里只钉「回落到哪一层」
  assert.equal(filled.name, mockValueOfField({ name: 'name', javaType: 'String' }))
  assert.equal(filled.code, 'VIP', '作者写在参数上的 defaultValue 比词表更具体')

  // 用例给的是空串（用户清空过）：跟没给一样，回落到默认值
  assert.deepEqual(pathValuesOf(api, { id: 7, name: '', code: '' }), {
    id: '7',
    name: filled.name,
    code: 'VIP',
  })
})

/* ================= 纯函数：顺序 ================= */

test('orderFixtures：被引用的表先插；只认 constraint，naming 推断不参与排序', () => {
  const fks = parsed.foreignKeys
  assert.deepEqual(orderFixtures(['emp', 'dept'], fks), ['dept', 'emp'])

  const guessed: ForeignKey[] = fks.map((fk) => ({ ...fk, confidence: 'naming' as const }))
  // 命名推断可能是错的，让它决定插入顺序等于悄悄生成错 SQL
  assert.deepEqual(orderFixtures(['emp', 'dept'], guessed), ['emp', 'dept'])
})

test('orderFixtures：自引用外键不参与排序（部门树不能自己等自己）', () => {
  const selfRef: ForeignKey[] = [
    { fromTable: 'dept', fromColumn: 'parent_id', toTable: 'dept', toColumn: 'id', confidence: 'constraint' },
  ]
  assert.deepEqual(orderFixtures(['dept'], selfRef), ['dept'])
})

test('orderFixtures：互相引用（有环）不假装有拓扑序，也不把表弄丢', () => {
  const cycle: ForeignKey[] = [
    { fromTable: 'a', fromColumn: 'b_id', toTable: 'b', toColumn: 'id', confidence: 'constraint' },
    { fromTable: 'b', fromColumn: 'a_id', toTable: 'a', toColumn: 'id', confidence: 'constraint' },
  ]
  assert.deepEqual(orderFixtures(['a', 'b'], cycle), ['a', 'b'])
  assert.deepEqual(orderFixtures(['b', 'a'], cycle), ['b', 'a'])
})

test('清理 SQL：主键列和值必须一一对应，缺一个就宁可不给语句', () => {
  assert.equal(cleanupSqlOf('t', ['id'], ['1'], 'sqlite'), 'DELETE FROM "t" WHERE "id" = 1')
  assert.equal(
    cleanupSqlOf('t', ['a', 'b'], ["'x'", '2'], 'mysql'),
    'DELETE FROM `t` WHERE `a` = \'x\' AND `b` = 2',
  )
  assert.equal(cleanupSqlOf('t', [], [], 'sqlite'), null)
  // 值少给一个 = WHERE 少一半条件，那种 SQL 宁可别发出去
  assert.equal(cleanupSqlOf('t', ['a', 'b'], ['1'], 'sqlite'), null)
})

test('回查 SQL 按方言分页：SQLite / MySQL 末尾 LIMIT，Oracle 用 ROWNUM 外包', () => {
  assert.match(pkQueryOf('dept', 'id', 'sqlite'), /ORDER BY "id" DESC\s+LIMIT 1 OFFSET 0$/)
  assert.match(pkQueryOf('dept', 'id', 'mysql'), /ORDER BY `id` DESC\s+LIMIT 0, 1$/)
  // Oracle 11g 没有 OFFSET FETCH（那是 12c 的），只能 ROWNUM
  assert.match(pkQueryOf('dept', 'id', 'oracle'), /ROWNUM <= 1/)
})

/* ================= 读接口借真数据（请求配合库） ================= */

test('planReadBackfill：只 SELECT 对得上的 id 形列，单列主键倒序取一行；对不上就不查', () => {
  const api = apiOf(
    '/api/dept/{id}',
    { name: 'id', javaType: 'Long' },
    { name: 'name', javaType: 'String' },
  )
  const sql = planReadBackfill(api, 'dept', colsOf('dept'), 'sqlite')
  assert.ok(sql)
  assert.match(sql, /^SELECT "id" FROM "dept" ORDER BY "id" DESC/)
  // name 不是 id 形字段，不许混进 SELECT（借真数据只动「打到哪一行」，不搬业务值）
  assert.doesNotMatch(sql, /dept_name/)
  // 请求里没有 id 形字段：没有可借的列，查询都不用发
  const none = apiOf('/api/dept/{name}', { name: 'name', javaType: 'String' })
  assert.equal(planReadBackfill(none, 'dept', colsOf('dept'), 'sqlite'), null)
})

test('readBackfillOf：id 形字段先到先得；Long 的 body 回填转 JSON 数字（后端 Long 收不下字符串）', () => {
  const api = apiOf('/api/emp/{id}', { name: 'id', javaType: 'Long' })
  const withBody = { ...api, requestBodyFields: [{ name: 'deptId', javaType: 'Long', required: false }] }
  const fills = readBackfillOf(withBody, [
    { table: 'emp', record: { id: '9', dept_id: '7', emp_name: '张三' } },
  ])
  const byField = new Map(fills.map((f) => [f.field, f]))
  assert.equal(byField.get('id')!.value, '9')
  assert.equal(byField.get('deptId')!.value, 7, 'Long 字段回填必须是 JSON 数字')
  assert.equal(byField.get('deptId')!.col, 'dept_id', 'camel 字段按 snake 列名对上')
  // emp_name 不是 id 形字段，不借
  assert.equal(byField.get('empName'), undefined)
  // 先到先得：第二张表的同名列不覆盖第一张的
  const two = readBackfillOf(api, [
    { table: 'emp', record: { id: '9' } },
    { table: 'dept', record: { id: '42' } },
  ])
  assert.equal(two.find((f) => f.field === 'id')!.value, '9')
})

test('applyReadBackfill：只动用例里已有的键——正常用例没填的可选 id 不许被补上', () => {
  const fills: ReadFill[] = [
    { field: 'id', value: '9', table: 'emp', col: 'id', kind: 'param' },
    { field: 'deptId', value: 7, table: 'emp', col: 'dept_id', kind: 'body' },
  ]
  const out = applyReadBackfill({ id: '1', __body: '{"deptId":0,"remark":"x"}' }, fills)
  assert.equal(out.values.id, '9')
  const body = JSON.parse(out.values.__body as string) as Record<string, unknown>
  assert.equal(body.deptId, 7)
  assert.equal(body.remark, 'x', '没被回填的 body 字段原样保留')

  // 用例没带 deptId 键：不许补上（列表查询平白多个筛选条件，结果可能被筛空）
  const out2 = applyReadBackfill({ id: '1', __body: '{"remark":"x"}' }, fills)
  const body2 = JSON.parse(out2.values.__body as string) as Record<string, unknown>
  assert.equal(body2.deptId, undefined)
  // 参数键不在的也不补
  const out3 = applyReadBackfill({}, fills)
  assert.equal(out3.values.id, undefined)
  assert.deepEqual(out3.filled, [])
  // __body 解析不了：原样不动，不抛
  const out4 = applyReadBackfill({ id: '1', __body: 'not-json' }, fills)
  assert.equal(out4.values.__body, 'not-json')
  assert.deepEqual(out4.filled, ['回填 id=9（借自 emp.id）'])
})

test('借真实行：全程只读一条写语句都不发；回填值对上库里真实行；借的行清理必须无操作', async () => {
  const db = openDb()
  try {
    db.exec("INSERT INTO \"dept\" (\"dept_name\") VALUES ('研发部')")
    const deps = depsOf(db)
    const fx = makeFixtureSession(deps)
    const api = { ...apiOf('/api/dept/{id}', { name: 'id', javaType: 'Long' }), httpMethod: 'GET' as const }
    const first = await fx.borrowFor(api, relOf('dept'))
    assert.ok(first.backfill, '表里有行就该借得到')
    assert.equal(first.backfill[0]!.field, 'id')
    assert.equal(first.backfill[0]!.value, '1')
    assert.equal(deps.sent.length, 0, '借真数据全程只读，一条写语句都不发')

    // 并发去重：第二条只拿值，日志不重复记（同 prepareFor 的口径）
    const again = await fx.borrowFor(api, relOf('dept'))
    assert.deepEqual(again.log, [])
    assert.ok(again.backfill)

    // 借来的行不是我们插的：finishFor 必须是无操作，绝不按表删用户数据
    assert.deepEqual(await fx.finishFor(api.id), [])
    assert.equal(count(db, 'dept'), 1)
  } finally {
    db.close()
  }
})

test('表空 / 表不存在：backfill 为空，调用方据此降级回造行', async () => {
  const db = openDb()
  try {
    const deps = depsOf(db)
    const fx = makeFixtureSession(deps)
    const api = apiOf('/api/dept/{id}', { name: 'id', javaType: 'Long' })
    const empty = await fx.borrowFor(api, relOf('dept'))
    assert.equal(empty.backfill, undefined)
    assert.match(empty.log.join('\n'), /没有存量行/)
    const missing = await fx.borrowFor(api, relOf('没有这张表'))
    assert.equal(missing.backfill, undefined)
    assert.deepEqual(deps.sent, [])
  } finally {
    db.close()
  }
})

test('第②步：造出的行回填请求——fillsFor 给出刚插的主键，inject 把删改对准自己造的行', async () => {
  const db = openDb()
  try {
    const deps = depsOf(db)
    const fx = makeFixtureSession(deps)
    // PUT /api/dept：query 带 id，body DTO 也声明 id（冒烟 body 是空对象）
    const api: ApiMethod = {
      ...apiOf('/api/dept', { name: 'id', javaType: 'Long', position: 'query' }),
      httpMethod: 'PUT',
      requestBodyType: 'DeptCondition',
      requestBodyFields: [{ name: 'id', javaType: 'Long', required: false }],
    }
    const log = await fx.prepareFor(api, relOf('dept'))
    assert.ok(log.some((l) => l.includes('INSERT INTO')), '先造行')
    const fills = fx.fillsFor(api.id)
    const param = fills.find((f) => f.kind === 'param' && f.field === 'id')
    const body = fills.find((f) => f.kind === 'body' && f.field === 'id')
    assert.ok(param && body, 'param / body 两种都给，落哪边由用例的键定')
    const pk = (db.prepare('SELECT "id" FROM "dept"').get() as { id: number }).id
    assert.equal(param.value, String(pk), '回填值就是刚插那行的主键')

    // 冒烟 body 是 {}：inject 把主键写进去，删改打在自己造的行上
    const applied = applyReadBackfill({ __body: '{}' }, fills, true)
    assert.equal(applied.values.id, String(pk))
    assert.equal(JSON.parse(applied.values.__body as string).id, pk, 'Long 主键进 body 是 JSON 数字')

    // 清完台账即空：能回填的只有自己刚造的行
    await fx.finishFor(api.id)
    assert.deepEqual(fx.fillsFor(api.id), [])
  } finally {
    db.close()
  }
})

test('applyReadBackfill 的 inject 只给写接口用：默认不补缺键（读接口口径不变）', () => {
  const fills: ReadFill[] = [{ field: 'id', value: '5', table: 'dept', col: 'id', kind: 'param' }]
  assert.deepEqual(applyReadBackfill({}, fills).values, {}, '默认：键不在就不补')
  assert.equal(applyReadBackfill({}, fills, true).values.id, '5', 'inject：把造出行的主键补进去')
})

test('applySampleValues：只认接口声明过的字段；Long 转 JSON 数字；拼错字段如实提醒', () => {
  const api = apiOf('/api/emp/{id}', { name: 'id', javaType: 'Long' })
  const withBody = { ...api, requestBodyFields: [{ name: 'deptId', javaType: 'Long', required: false }] }
  const out = applySampleValues(withBody, { __body: '{}' }, { id: '7', deptId: '42', typoFiled: '1' })
  assert.equal(out.values.id, '7', '声明的参数被钉上')
  assert.equal(JSON.parse(out.values.__body as string).deptId, 42, 'Long 的 body 补值进 JSON 是数字')
  const log = out.filled.join('\n')
  assert.match(log, /手工补值：id=7/)
  assert.match(log, /手工补值：body\.deptId=42/)
  assert.match(log, /typoFiled[\s\S]*没有对应参数/, '拼错的字段名要看得出来，不能默默吞掉')
  // 空值不补：空串补值等于没补
  const blank = applySampleValues(withBody, { id: '1' }, { id: '' })
  assert.equal(blank.values.id, '1')
  assert.deepEqual(blank.filled, [])
})

test('applySampleValues：雪花 id 超安全整数不被圆整——body 里原有的大整数逐字节原样', () => {
  // 用户实测：1987654321098765431 复制进调试卡变成 …5300（Number 圆整）
  const api = apiOf('/api/emp/{id}', { name: 'id', javaType: 'Long' })
  const withBody = { ...api, requestBodyFields: [{ name: 'deptId', javaType: 'Long', required: false }] }
  // body 里已有的大整数 + 补值本身是大整数，两条路都不许动它
  const out = applySampleValues(
    withBody,
    { __body: '{"applyId": 1987654321098765431, "memo":"ok"}' },
    { deptId: '1987654321098765431' },
  )
  assert.match(out.values.__body as string, /"applyId": ?1987654321098765431/)
  assert.match(out.values.__body as string, /"memo": ?"ok"/)
  assert.match(out.values.__body as string, /"deptId": ?"1987654321098765431"/, '超安全整数的补值留字符串（Jackson 会并进 Long）')
})

/* ================= 第③步：外键混合策略（借真实父行，空了才递归造，封顶 3 层） ================= */

test('第③步：FK 列先借真实父行——父表不在关联表里也打得到，且绝不动父表', async () => {
  const db = openDb()
  try {
    db.exec("INSERT INTO \"dept\" (\"dept_name\") VALUES ('既有部门')")
    const real = (db.prepare('SELECT "id" FROM "dept"').get() as { id: number }).id
    const deps = depsOf(db)
    const fx = makeFixtureSession(deps)
    // 只关联 emp；dept 不在关联表里 —— 老行为 dept_id 走语义字典，真外键约束当场 1452
    const api = apiOf('/api/emp/{name}', { name: 'name', javaType: 'String' })
    const log = await fx.prepareFor(api, relOf('emp'))
    assert.equal(count(db, 'dept'), 1, '父表有数据就不该再造')
    assert.equal(count(db, 'emp'), 1)
    const child = db.prepare('SELECT "dept_id" FROM "emp"').get() as { dept_id: number }
    assert.equal(child.dept_id, real, 'emp.dept_id 指向库里真实存在的部门')
    assert.match(log.join('\n'), /借真实父行/)
    // 清理只删自己造的 emp；借的 dept 不是我们插的，一个都不动
    await fx.finishFor(api.id)
    assert.equal(count(db, 'dept'), 1)
    assert.equal(count(db, 'emp'), 0)
  } finally {
    db.close()
  }
})

test('第③步：父表空才递归造父行，链上父行也进清理清单（逆序删）', async () => {
  const db = openDb()
  try {
    const deps = depsOf(db)
    const fx = makeFixtureSession(deps)
    const api = apiOf('/api/emp/{name}', { name: 'name', javaType: 'String' })
    const log = await fx.prepareFor(api, relOf('emp'))
    assert.equal(count(db, 'dept'), 1, 'dept 空表被链式补造')
    assert.equal(count(db, 'emp'), 1)
    const parent = db.prepare('SELECT "id" FROM "dept"').get() as { id: number }
    const child = db.prepare('SELECT "dept_id" FROM "emp"').get() as { dept_id: number }
    assert.equal(child.dept_id, parent.id, '子表 FK 对准链上刚造的父行')
    assert.match(log.join('\n'), /造行（补父行）/)
    const clean = await fx.finishFor(api.id)
    const iEmp = clean.findIndex((l) => l.includes('"emp"'))
    const iDept = clean.findIndex((l) => l.includes('"dept"'))
    assert.ok(iEmp >= 0 && iDept >= 0 && iEmp < iDept, '先删子表再删父表，外键才放行')
    assert.equal(count(db, 'dept'), 0)
    assert.equal(count(db, 'emp'), 0)
  } finally {
    db.close()
  }
})

/** 五层链 a→b→c→d→e：封顶 3 层意味着 b/c/d 造得出，e 不造（如实报告） */
const CHAIN_DDL = `
CREATE TABLE \`c_a\` (id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键', b_id BIGINT NULL COMMENT 'b', PRIMARY KEY (id));
CREATE TABLE \`c_b\` (id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键', c_id BIGINT NULL COMMENT 'c', PRIMARY KEY (id));
CREATE TABLE \`c_c\` (id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键', d_id BIGINT NULL COMMENT 'd', PRIMARY KEY (id));
CREATE TABLE \`c_d\` (id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键', e_id BIGINT NULL COMMENT 'e', PRIMARY KEY (id));
CREATE TABLE \`c_e\` (id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键', PRIMARY KEY (id));
`
const chainParsed = parseDdl(CHAIN_DDL, 'mysql')
assert.deepEqual(chainParsed.errors, [], `chain DDL 解析失败：${chainParsed.errors.join('; ')}`)
const chainFks: ForeignKey[] = [
  { fromTable: 'c_a', fromColumn: 'b_id', toTable: 'c_b', toColumn: 'id', confidence: 'constraint' },
  { fromTable: 'c_b', fromColumn: 'c_id', toTable: 'c_c', toColumn: 'id', confidence: 'constraint' },
  { fromTable: 'c_c', fromColumn: 'd_id', toTable: 'c_d', toColumn: 'id', confidence: 'constraint' },
  { fromTable: 'c_d', fromColumn: 'e_id', toTable: 'c_e', toColumn: 'id', confidence: 'constraint' },
]

test('第③步：链深封顶 3 层——b/c/d 造得出，第 4 层如实报告「造不满」，e 一个都不插', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('PRAGMA foreign_keys = ON')
    for (const t of chainParsed.tables) db.exec(exportDdl(t, { dialect: 'sqlite', foreignKeys: chainFks }))
    const deps = depsOf(db, chainFks, chainParsed.tables)
    const fx = makeFixtureSession(deps)
    // 路径参数叫 id（id 形）：回填主表优先的断言才有东西可钉
    const api = apiOf('/api/c-a/{id}', { name: 'id', javaType: 'Long' })
    const log = await fx.prepareFor(api, relOf('c_a'))
    const n = (t: string) => count(db, t)
    assert.equal(n('c_a'), 1)
    assert.equal(n('c_b'), 1, '第 1 层父行造得出')
    assert.equal(n('c_c'), 1, '第 2 层父行造得出')
    assert.equal(n('c_d'), 1, '第 3 层父行造得出')
    assert.equal(n('c_e'), 0, '第 4 层封顶，不再向上造')
    assert.match(log.join('\n'), /外键链超过 3 层/)
    // 回填以请求要打的目标表为先：c_a 的主键赢，链上父行的 id 不冒充
    const fills = fx.fillsFor(api.id)
    assert.equal(fills.find((f) => f.kind === 'param' && f.field === 'id')!.table, 'c_a')
    const clean = await fx.finishFor(api.id)
    assert.equal(n('c_a'), 0)
    assert.equal(n('c_b'), 0, '链上父行也在清理清单里')
    assert.equal(n('c_d'), 0)
    // 逆序：c_a（子）先删，c_b（父）后删
    const iA = clean.findIndex((l) => l.includes('"c_a"'))
    const iB = clean.findIndex((l) => l.includes('"c_b"'))
    assert.ok(iA >= 0 && iB >= 0 && iA < iB)
  } finally {
    db.close()
  }
})

/* ================= 异常学习：接口报缺数据 → 认表 → 借/造 → 回填（2026-09-19） ================= */

const repairTables = (): FixtureDeps['listTables'] => async () =>
  parsed.tables.map((t) => ({ name: t.name, comment: t.comment }))

/** 代理商新增场景：POST body 里带 deptId（库里没有外键约束，造数链看不见它） */
const repairApi = (): ApiMethod => ({
  ...apiOf('/agents'),
  httpMethod: 'POST',
  requestBodyFields: [{ name: 'deptId', javaType: 'Long', required: true }],
})

test('异常学习：接口说「部门不存在」，借一条真实部门 id 回填', async () => {
  const db = openDb()
  try {
    db.exec(`INSERT INTO "dept" ("dept_name") VALUES ('华东部')`)
    const deps = { ...depsOf(db), listTables: repairTables() }
    const fx = makeFixtureSession(deps)
    const values = { __body: '{"deptId":999}' }
    const out = await fx.repairMissing('api1', repairApi(), '{"code":500,"msg":"部门不存在"}', values)
    assert.ok(out, '报错里有「部门不存在」就该出线索')
    assert.equal(out.fills.length, 1)
    assert.equal(out.fills[0]!.field, 'deptId')
    assert.equal(out.fills[0]!.kind, 'body')
    assert.equal(out.fills[0]!.table, 'dept')
    assert.equal(out.fills[0]!.value, 1, '借的是真实主键，Long 转 JSON 数字')
    assert.match(out.log.join('\n'), /借了 dept\.id=1/)
    // 借是只读：没有清理登记，也没多写的行
    assert.deepEqual(await fx.finishFor('api1'), [])
    assert.equal(count(db, 'dept'), 1)
    // 回填真能落进请求体（inject 语义）
    const applied = applyReadBackfill(values, out.fills, true)
    assert.equal(JSON.parse(applied.values.__body as string).deptId, 1)
  } finally {
    db.close()
  }
})

test('异常学习：表空就造一行引用数据，跑完随清理清单删掉', async () => {
  const db = openDb()
  try {
    const deps = { ...depsOf(db), listTables: repairTables() }
    const fx = makeFixtureSession(deps)
    const out = await fx.repairMissing('api1', repairApi(), '操作失败：部门不存在', { __body: '{"deptId":999}' })
    assert.ok(out)
    assert.equal(out.fills.length, 1)
    assert.match(out.log.join('\n'), /造行（补引用数据）/)
    assert.equal(count(db, 'dept'), 1, '库里补上了缺的部门')
    assert.equal(out.fills[0]!.value, 1, '造出的主键回填给请求')
    assert.equal(fx.insertedCount(), 1, '造的行计入写库总数（确认框与报告用）')
    // 跑完清理：只删自己造的那行
    const clean = await fx.finishFor('api1')
    assert.equal(clean.length, 1)
    assert.match(clean[0]!, /DELETE FROM "dept"/)
    assert.equal(count(db, 'dept'), 0)
  } finally {
    db.close()
  }
})

test('异常学习：认不出表就明说，绝不乱填', async () => {
  const db = openDb()
  try {
    const deps = { ...depsOf(db), listTables: repairTables() }
    const fx = makeFixtureSession(deps)
    const api: ApiMethod = {
      ...repairApi(),
      requestBodyFields: [{ name: 'remarkId', javaType: 'Long', required: true }],
    }
    const first = await fx.repairMissing('api1', api, '{"msg":"备注不存在"}', { __body: '{"remarkId":9}' })
    assert.ok(first)
    assert.deepEqual(first.fills, [])
    assert.match(first.log.join('\n'), /没认出对应哪张表/)
    // 抽不出线索的正常响应：null，零日志
    assert.equal(await fx.repairMissing('api1', api, '{"code":0,"msg":"ok"}', { __body: '{"remarkId":9}' }), null)
  } finally {
    db.close()
  }
})

test('异常学习：没导入表清单时说明原因，同样的提醒不刷第二遍', async () => {
  const db = openDb()
  try {
    const fx = makeFixtureSession(depsOf(db))
    const first = await fx.repairMissing('api1', repairApi(), '{"msg":"部门不存在"}', { __body: '{"deptId":9}' })
    assert.ok(first)
    assert.deepEqual(first.fills, [])
    assert.match(first.log.join('\n'), /认不出库里有哪些表/)
    const second = await fx.repairMissing('api2', repairApi(), '{"msg":"部门不存在"}', { __body: '{"deptId":9}' })
    assert.ok(second)
    assert.deepEqual(second.log, [])
  } finally {
    db.close()
  }
})

/* ================= 唯一列掺批号：重复跑不再撞唯一键（2026-09-19） ================= */

/** 手机号 / 邮箱是唯一键的两张典型脸；remark 故意不唯一，当对照组 */
const ukCols: Column[] = [
  { name: 'id', type: 'BIGINT', nullable: false, isPrimaryKey: true, isAutoIncrement: true, javaField: 'id', javaType: 'Long' },
  { name: 'phone', type: 'VARCHAR(20)', nullable: false, isPrimaryKey: false, isAutoIncrement: false, isUnique: true, javaField: 'phone', javaType: 'String' },
  { name: 'email', type: 'VARCHAR(50)', nullable: true, isPrimaryKey: false, isAutoIncrement: false, isUnique: true, javaField: 'email', javaType: 'String' },
  { name: 'remark', type: 'VARCHAR(50)', nullable: true, isPrimaryKey: false, isAutoIncrement: false, javaField: 'remark', javaType: 'String' },
]

test('planFixture：唯一列掺批号——同 seed 换个批号值就换，值的样子不变形', () => {
  const a = planFixture('member', ukCols, 'mysql', 0, {}, 1001)
  const b = planFixture('member', ukCols, 'mysql', 0, {}, 1002)
  // 手机号：还是 138 开头的 11 位数字，但两批不同
  assert.match(a.values.phone!, /^138\d{8}$/)
  assert.match(b.values.phone!, /^138\d{8}$/)
  assert.notEqual(a.values.phone, b.values.phone)
  // 邮箱：@ 前掺批号，域不动
  assert.match(a.values.email!, /^[a-z]+\d{6}@test\.com$/)
  assert.notEqual(a.values.email, b.values.email)
  // 非唯一列不掺：同 seed 同值（可复现的归 seed，不撞库的归批号）
  assert.equal(a.values.remark, b.values.remark)
  // 同一批号可复现：两次拼出的 INSERT 完全一致
  assert.equal(planFixture('member', ukCols, 'mysql', 0, {}, 1001).insertSql, a.insertSql)
  // 不传批号（出句面板的老路）：跟从前一模一样
  assert.equal(planFixture('member', ukCols, 'mysql', 0).values.phone, planFixture('member', ukCols, 'mysql', 0).values.phone)
})

test('planFixture：主键与被点名的对齐列不掺批号——那是请求要找的键', () => {
  // phone 被路径参数点名对齐：值必须原样保留
  const pinned = planFixture('member', ukCols, 'mysql', 0, { phone: '13800000000' }, 1001)
  assert.equal(pinned.values.phone, '13800000000')
  // 自增主键本来就不显式插，批号碰不到它
  assert.equal(pinned.values.id, undefined)
})

const UK_DDL = `
CREATE TABLE \`member\` (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键',
  phone VARCHAR(20) NOT NULL UNIQUE COMMENT '手机号',
  PRIMARY KEY (id)
) COMMENT='会员';
`

test('同一次跑里给同一张表造两行（两个接口各造一套）：批号错开，两条都成', async () => {
  const ukParsed = parseDdl(UK_DDL, 'mysql')
  assert.deepEqual(ukParsed.errors, [], `uk DDL 解析失败：${ukParsed.errors.join('; ')}`)
  const t = ukParsed.tables[0]!
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(exportDdl(t, { dialect: 'sqlite', foreignKeys: [] }))
    const deps = depsOf(db, [], [t])
    deps.runNonce = 5000
    const fx = makeFixtureSession(deps)
    // 主键是被点名对齐的键，两个接口各找各的行（都发默认值的话撞的是主键——那行
    // 已存在时用例照样有效，不算失败）；唯一列的错开由批号负责
    await fx.prepareFor(apiOf('/api/a/{id}', { name: 'id', javaType: 'Long' }), relOf('member'), { id: 101 })
    await fx.prepareFor(apiOf('/api/b/{id}', { name: 'id', javaType: 'Long' }), relOf('member'), { id: 102 })
    assert.equal(count(db, 'member'), 2, '两行都插进去（唯一列没有撞键）')
    const phones = (db.prepare('SELECT phone FROM "member" ORDER BY id').all() as { phone: string }[]).map(
      (r) => r.phone,
    )
    assert.equal(new Set(phones).size, 2, '两条手机号互不相同')
    await fx.finishAll()
    assert.equal(count(db, 'member'), 0)
  } finally {
    db.close()
  }
})
