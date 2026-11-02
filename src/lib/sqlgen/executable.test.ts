/**
 * 可执行模式的回归测试，PRD 4.4 / 4.6~4.9。
 *
 * 这个模式的唯一卖点是「复制出去就能跑」，所以主力测试不比字符串，而是
 * 用 exportDdl 在 node:sqlite 里真建一张表，再把生成的 INSERT / UPDATE /
 * DELETE / SELECT 真执行一遍——语法、引号、函数名、类型溢出全都当场暴露。
 * 每条用例都对应一个真踩过（或者一定会踩）的坑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import type { Column, TableInfo } from '../../types/schema'
import type { GenDialect } from './dialect'
import { parseDdl } from '../ddlParser'
import { exportDdl } from './ddlExport'
import { generateExecutable, type ExecutableOptions } from './executable'
import { COUNT_PK, COUNT_STAR } from '../columnPick'
import { renderParam } from './logFill'
import { planValues, renderValue, resolveValue } from './mockValue'
import type { CrudKind } from './singleTable'

const DDL = `
CREATE TABLE \`user\` (
  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键',
  username VARCHAR(50) NOT NULL COMMENT '用户名',
  password VARCHAR(64) NOT NULL COMMENT '密码',
  email VARCHAR(100) COMMENT '邮箱',
  phone VARCHAR(20) COMMENT '手机号',
  nick VARCHAR(1) COMMENT '短到只能放一个字',
  age TINYINT COMMENT '年龄',
  level TINYINT NOT NULL DEFAULT 0 COMMENT '等级',
  balance DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '余额',
  grade SMALLINT COMMENT '分级',
  channel VARCHAR(20) NOT NULL DEFAULT 'web' COMMENT '来源渠道',
  remark VARCHAR(200) COMMENT '备注',
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  update_time DATETIME COMMENT '更新时间',
  PRIMARY KEY (id)
) COMMENT='用户表';
CREATE TABLE \`order\` (
  id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '订单ID',
  order_no VARCHAR(32) NOT NULL COMMENT '订单号',
  user_id BIGINT NOT NULL COMMENT '下单用户',
  total_amount DECIMAL(10,2) NOT NULL COMMENT '订单总额',
  status TINYINT NOT NULL DEFAULT 0 COMMENT '状态',
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '下单时间',
  CONSTRAINT fk_order_user FOREIGN KEY (user_id) REFERENCES \`user\`(id)
) COMMENT='订单表';
CREATE TABLE user_role (
  user_id BIGINT NOT NULL,
  role_id BIGINT NOT NULL
);
`

const parsed = parseDdl(DDL, 'mysql')
assert.deepEqual(parsed.errors, [], `fixture DDL 解析失败：${parsed.errors.join('; ')}`)
const byName = new Map(parsed.tables.map((t) => [t.name, t]))
const get = (n: string): TableInfo => {
  const t = byName.get(n)
  assert.ok(t, `fixture 缺少表 ${n}`)
  return t
}

const ALL: CrudKind[] = ['insert', 'update', 'delete', 'select']

const opts = (over: Partial<ExecutableOptions> = {}): ExecutableOptions => ({
  dialect: 'sqlite',
  kinds: ALL,
  withHeader: false,
  values: {},
  pkValues: {},
  seed: 1,
  ...over,
})

/** 一条一条地生成，这样每段结果都是单条语句，可以直接交给 db.exec */
const gen = (table: TableInfo, kind: CrudKind, over: Partial<ExecutableOptions> = {}) =>
  generateExecutable(table, opts({ kinds: [kind], ...over }))

test('SQLite 真执行：四种语句都能跑，INSERT 真的插进去一行', () => {
  const db = new DatabaseSync(':memory:')
  const user = get('user')
  db.exec(exportDdl(user, { dialect: 'sqlite' }))

  db.exec(gen(user, 'insert'))
  const after = db.prepare('SELECT COUNT(*) AS n FROM "user"').get() as { n: number }
  assert.equal(after.n, 1, 'INSERT 执行了但没插进去')

  // 自增主键从 1 开始，所以默认的 WHERE id = 1 正好命中刚插的那行
  db.exec(gen(user, 'update'))
  db.exec(gen(user, 'select'))
  db.exec(gen(user, 'delete'))
  const left = db.prepare('SELECT COUNT(*) AS n FROM "user"').get() as { n: number }
  assert.equal(left.n, 0, 'DELETE 没删掉那行——WHERE 条件对不上？')
  db.close()
})

test('SQLite 真执行：多次 seed 都能跑，不是碰巧这一组值合法', () => {
  const user = get('user')
  const order = get('order')
  for (let seed = 0; seed < 25; seed += 1) {
    const db = new DatabaseSync(':memory:')
    // 这条用例查的是语法和类型，不是引用完整性：上一轮的 DELETE 会把 user 那行删掉，
    // 接着插 order 必然违反外键。node:sqlite 的外键约束默认是开的，得显式关掉。
    // 引用完整性另有一条专门的用例（见下面「外键约束打开时」）。
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec(exportDdl(user, { dialect: 'sqlite' }))
    db.exec(exportDdl(order, { dialect: 'sqlite', foreignKeys: parsed.foreignKeys }))
    for (const table of [user, order]) {
      for (const kind of ALL) {
        const sql = gen(table, kind, { seed })
        assert.doesNotThrow(() => db.exec(sql), `seed=${seed} ${table.name}.${kind} 跑不起来：\n${sql}`)
      }
    }
    db.close()
  }
})

test('SQLite 没有 NOW()：审计时间字段必须填 CURRENT_TIMESTAMP', () => {
  const sql = gen(get('user'), 'insert')
  assert.match(sql, /CURRENT_TIMESTAMP/)
  assert.doesNotMatch(sql, /NOW\(\)/, 'SQLite 里 NOW() 会报 no such function')
})

test('MySQL 用 NOW()，Oracle 用 SYSDATE', () => {
  assert.match(gen(get('user'), 'insert', { dialect: 'mysql' }), /NOW\(\)/)
  assert.match(gen(get('user'), 'insert', { dialect: 'oracle' }), /SYSDATE/)
})

test('自增主键不出现在 INSERT 的字段列表里（PRD 4.4 自动排除）', () => {
  const sql = gen(get('user'), 'insert')
  const columnList = sql.slice(sql.indexOf('('), sql.indexOf('VALUES'))
  assert.doesNotMatch(columnList, /"id"/)
  assert.match(columnList, /"username"/)
})

test('值里的单引号被转义，不会把语句断在半截', () => {
  const user = get('user')
  const sql = gen(user, 'insert', { values: { insert: { username: "O'Brien" } } })
  assert.match(sql, /'O''Brien'/)

  const db = new DatabaseSync(':memory:')
  db.exec(exportDdl(user, { dialect: 'sqlite' }))
  db.exec(sql)
  const row = db.prepare('SELECT username FROM "user"').get() as { username: string }
  assert.equal(row.username, "O'Brien", '转义之后存进去的值变了')
  db.close()
})

test('同一个 seed 结果稳定，换 seed 才变（否则手改的值会被无关操作冲掉）', () => {
  const user = get('user')
  assert.equal(gen(user, 'insert', { seed: 7 }), gen(user, 'insert', { seed: 7 }))
  assert.notEqual(gen(user, 'insert', { seed: 7 }), gen(user, 'insert', { seed: 8 }))
})

test('非空字段永远不生成 NULL（PRD 4.4：非空字段保证生成非空值）', () => {
  for (const table of parsed.tables) {
    for (let seed = 0; seed < 40; seed += 1) {
      for (const plan of planValues(table, 'mysql', seed)) {
        if (plan.column.nullable || plan.excluded) continue
        const rendered = renderValue(plan.column, resolveValue(plan, {}), 'mysql')
        assert.notEqual(
          rendered,
          'NULL',
          `${table.name}.${plan.column.name} 在 seed=${seed} 时生成了 NULL`,
        )
      }
    }
  }
})

test('可空字段确实有机会给 NULL，也确实有机会给值（20% 那条规则真的生效）', () => {
  const user = get('user')
  const seen = new Set<string>()
  for (let seed = 0; seed < 40; seed += 1) {
    const plan = planValues(user, 'mysql', seed).find((p) => p.column.name === 'remark')
    assert.ok(plan)
    seen.add(plan.auto === 'NULL' ? 'null' : 'value')
  }
  assert.deepEqual([...seen].sort(), ['null', 'value'])
})

test('数值不会溢出类型上界：TINYINT ≤ 127，SMALLINT ≤ 32767', () => {
  const user = get('user')
  for (let seed = 0; seed < 60; seed += 1) {
    for (const plan of planValues(user, 'mysql', seed)) {
      if (plan.auto === 'NULL') continue
      if (plan.column.name === 'age' || plan.column.name === 'level') {
        assert.ok(Number(plan.auto) <= 127, `${plan.column.name}=${plan.auto} 超出 TINYINT`)
      }
      if (plan.column.name === 'grade') {
        assert.ok(Number(plan.auto) <= 32767, `grade=${plan.auto} 超出 SMALLINT`)
      }
    }
  }
})

test('外键列给小数字：随机 BIGINT 一碰外键约束就插不进去', () => {
  const order = get('order')
  for (let seed = 0; seed < 40; seed += 1) {
    const plan = planValues(order, 'mysql', seed).find((p) => p.column.name === 'user_id')
    assert.ok(plan)
    assert.ok(Number(plan.auto) >= 1 && Number(plan.auto) <= 5, `user_id=${plan.auto} 不像外键值`)
  }
})

test('主键 id 不压成 1~5：换 seed 不重复（否则「重新生成」再插会撞 UNIQUE）', () => {
  const r = parseDdl(
    `CREATE TABLE ticket (
      id BIGINT NOT NULL COMMENT '主键',
      title VARCHAR(50) NOT NULL,
      PRIMARY KEY (id)
    );`,
    'mysql',
  )
  const table = r.tables[0]
  assert.ok(table)
  const ids = new Set<string>()
  for (let seed = 0; seed < 80; seed += 1) {
    const plan = planValues(table, 'mysql', seed).find((p) => p.column.name === 'id')
    assert.ok(plan)
    ids.add(plan.auto)
  }
  assert.equal(
    ids.size,
    80,
    `主键 id 在 80 个 seed 里只出了 ${ids.size} 个值，又压回 1~5 了：${[...ids].slice(0, 12).join(',')}`,
  )
})

test('SQLite 真执行：非自增主键换 seed 能连插两行，不再撞 UNIQUE', () => {
  const r = parseDdl(
    `CREATE TABLE ticket (
      id BIGINT NOT NULL COMMENT '主键',
      title VARCHAR(50) NOT NULL,
      PRIMARY KEY (id)
    );`,
    'mysql',
  )
  const table = r.tables[0]!
  const db = new DatabaseSync(':memory:')
  db.exec(exportDdl(table, { dialect: 'sqlite' }))
  db.exec(gen(table, 'insert', { seed: 1 }))
  assert.doesNotThrow(
    () => db.exec(gen(table, 'insert', { seed: 2 })),
    '换 seed 后主键还是同一个，第二条 INSERT 撞 UNIQUE',
  )
  const n = (db.prepare('SELECT COUNT(*) AS n FROM "ticket"').get() as { n: number }).n
  assert.equal(n, 2)
  db.close()
})

test('外键约束打开时，生成的 INSERT 真能插进去', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(exportDdl(get('user'), { dialect: 'sqlite' }))
  db.exec(exportDdl(get('order'), { dialect: 'sqlite', foreignKeys: parsed.foreignKeys }))
  // 先备好 1~5 号用户，user_id 落在这个区间才有得指
  for (let i = 0; i < 5; i += 1) db.exec(gen(get('user'), 'insert', { seed: 100 + i }))

  for (let seed = 0; seed < 20; seed += 1) {
    const sql = gen(get('order'), 'insert', { seed })
    assert.doesNotThrow(() => db.exec(sql), `seed=${seed} 的订单插不进去：\n${sql}`)
  }
  db.close()
})

test('VARCHAR(1) 不会被塞进两个字：超长会 1406 Data too long', () => {
  for (let seed = 0; seed < 30; seed += 1) {
    const plan = planValues(get('user'), 'mysql', seed).find((p) => p.column.name === 'nick')
    assert.ok(plan)
    if (plan.auto === 'NULL') continue
    assert.ok(plan.auto.length <= 1, `nick='${plan.auto}' 超过声明长度`)
  }
})

test('UPDATE：主键进 WHERE 不进 SET，create_time 不更新，update_time 强制刷新', () => {
  const sql = gen(get('user'), 'update', { dialect: 'mysql' })
  const [sets, where] = sql.split('WHERE')
  assert.ok(where, 'UPDATE 没有 WHERE，会更新全表')
  assert.match(where, /`id` = 1/)
  assert.doesNotMatch(sets, /`id` =/)
  assert.doesNotMatch(sets, /`create_time`/)
  assert.match(sets, /`update_time` = NOW\(\)/)
})

test('SQLite 真执行：INSERT 之后 UPDATE，那行数据的值真的变了（PRD 4.6/4.7）', () => {
  /*
   * 这条是整个可执行模式最该被守住的行为，也是它曾经真坏过的地方：
   * INSERT 和 UPDATE 共用一套自动值时，UPDATE 是把每个字段改成它自己，
   * 跑完 SELECT 一看毫无变化，用户根本判断不出 UPDATE 生效没有。
   *
   * 断言只比业务字段：id 是主键（WHERE 条件，本来就不该变），
   * create_time 不进 SET，update_time 两边都是 CURRENT_TIMESTAMP，
   * 同一秒内执行值相同——把它们算进去会让这条用例失去指向性。
   */
  const user = get('user')
  const business = user.columns
    .map((c) => c.name)
    .filter((n) => n !== 'id' && n !== 'create_time' && n !== 'update_time')

  for (let seed = 0; seed < 20; seed += 1) {
    const db = new DatabaseSync(':memory:')
    db.exec(exportDdl(user, { dialect: 'sqlite' }))
    const read = () =>
      db.prepare(`SELECT ${business.map((n) => `"${n}"`).join(', ')} FROM "user" WHERE id = 1`).get()

    db.exec(gen(user, 'insert', { seed }))
    const before = read()
    db.exec(gen(user, 'update', { seed }))
    const after = read()

    assert.notDeepEqual(after, before, `seed=${seed} 的 UPDATE 把每个字段改成了它自己`)
    db.close()
  }
})

test('UPDATE 阶段不套用 DEFAULT：否则带默认值的字段永远改不动', () => {
  const user = get('user')
  // channel NOT NULL DEFAULT 'web'、level NOT NULL DEFAULT 0
  const seen = { channel: new Set<string>(), level: new Set<string>() }
  for (let seed = 0; seed < 30; seed += 1) {
    for (const plan of planValues(user, 'mysql', seed, 'update')) {
      if (plan.column.name === 'channel') seen.channel.add(plan.auto)
      if (plan.column.name === 'level') seen.level.add(plan.auto)
    }
  }
  assert.ok(seen.channel.size > 1, `UPDATE 的 channel 永远是 ${[...seen.channel]}`)
  assert.ok(seen.level.size > 1, `UPDATE 的 level 永远是 ${[...seen.level]}`)

  // INSERT 阶段反过来必须照抄 DEFAULT（PRD 4.4），这是那行数据入库后的真实样子
  const insertPlan = planValues(user, 'mysql', 3).find((p) => p.column.name === 'channel')
  assert.equal(insertPlan?.auto, 'web')
})

test('阶段参与散列而不是给 seed 加偏移：UPDATE@seed1 不等于 INSERT@seed2', () => {
  /*
   * 「UPDATE 用 seed + 1」看着更简单，但用户点一次「重新生成」把 seed 从 1 加到 2，
   * 新的 INSERT 值就跟旧的 UPDATE 值撞了一模一样——刚才看过的数据又出现一遍，
   * 像是没生成成功。散列里带上阶段就没这个问题。
   */
  const user = get('user')
  const of = (seed: number, phase: 'insert' | 'update') =>
    planValues(user, 'mysql', seed, phase).map((p) => p.auto).join('|')

  assert.equal(of(1, 'update'), of(1, 'update'), '同 seed 同阶段必须稳定')
  assert.notEqual(of(1, 'insert'), of(1, 'update'))
  assert.notEqual(of(1, 'update'), of(2, 'insert'))
  assert.notEqual(of(1, 'update'), of(2, 'update'))
})

test('WHERE 的主键值可以改（PRD 4.4：默认 1，用户可改）', () => {
  const sql = gen(get('user'), 'delete', { dialect: 'mysql', pkValues: { id: '42' } })
  assert.match(sql, /`id` = 42/)
})

test('用户手改的值优先于自动生成的值', () => {
  const sql = gen(get('user'), 'insert', { values: { insert: { username: '指定的名字' } } })
  assert.match(sql, /'指定的名字'/)
})

test('手改 INSERT 的值不会串到 UPDATE 里（两栏是独立的两套值）', () => {
  const both = generateExecutable(
    get('user'),
    opts({
      dialect: 'mysql',
      kinds: ['insert', 'update'],
      values: { insert: { username: 'INSERT专用' }, update: { username: 'UPDATE专用' } },
    }),
  )
  const [insertPart, updatePart] = both.split('-- 2.')
  assert.match(insertPart, /'INSERT专用'/)
  assert.doesNotMatch(insertPart, /'UPDATE专用'/)
  assert.match(updatePart, /'UPDATE专用'/)
  assert.doesNotMatch(updatePart, /'INSERT专用'/)
})

test('没有主键的表：不生成裸的 UPDATE / DELETE', () => {
  const t = get('user_role')
  const del = gen(t, 'delete')
  assert.match(del, /⚠️/)
  assert.doesNotMatch(del, /^DELETE/m, '生成了一条会清空全表的 DELETE')

  const upd = gen(t, 'update')
  assert.match(upd, /⚠️/)
  assert.doesNotMatch(upd, /^WHERE/m)
})

/* ---------- PRD 4.9：SELECT 的条件字段可勾选 ---------- */

test('SELECT 条件默认只有主键（PRD 4.9）', () => {
  const sql = gen(get('user'), 'select', { dialect: 'mysql' })
  assert.match(sql, /WHERE `id` = 1\nORDER BY `id` DESC\nLIMIT 0, 20;/)
  assert.doesNotMatch(sql, /AND/, '默认多带了别的条件')
})

test('SELECT 默认同预编译：主键 DESC；可选手选列和升序', () => {
  const def = gen(get('user'), 'select', { dialect: 'mysql', selectConditions: [] })
  assert.match(def, /ORDER BY `id` DESC\nLIMIT/)

  const byName = gen(get('user'), 'select', {
    dialect: 'mysql',
    selectConditions: [],
    orderBy: { column: 'username', dir: 'asc' },
  })
  assert.match(byName, /ORDER BY `username` ASC\nLIMIT/)
})

test('SELECT 分组：SELECT 改成分组列 + COUNT(*)，默认按 cnt 降序', () => {
  const sql = gen(get('user'), 'select', {
    dialect: 'mysql',
    selectConditions: [],
    groupBy: ['channel'],
  })
  assert.match(sql, /`channel`,\s+--[^\n]*\n {2}COUNT\(\*\) AS `cnt`/)
  assert.match(sql, /GROUP BY `channel`\nORDER BY `cnt` DESC\nLIMIT/)
  assert.doesNotMatch(sql, /`username`/, '分组后不该再把原字段清单塞进 SELECT')
})

test('查询字段勾 COUNT(*)：默认不在全选里；只勾聚合出 COUNT', () => {
  const only = gen(get('user'), 'select', {
    dialect: 'mysql',
    selectConditions: [],
    selectedColumns: [COUNT_STAR],
  })
  assert.match(only, /COUNT\(\*\) AS `cnt`/)
  assert.doesNotMatch(only, /GROUP BY/)
  assert.doesNotMatch(only, /`username`/)

  const both = gen(get('user'), 'select', {
    dialect: 'mysql',
    selectConditions: [],
    selectedColumns: [COUNT_STAR, COUNT_PK],
  })
  assert.match(both, /COUNT\(\*\) AS `cnt`/)
  assert.match(both, /COUNT\(`id`\) AS `id_cnt`/)

  const dim = gen(get('user'), 'select', {
    dialect: 'mysql',
    selectConditions: [],
    selectedColumns: ['channel', COUNT_STAR],
  })
  assert.match(dim, /`channel`/)
  assert.match(dim, /COUNT\(\*\) AS `cnt`/)
  assert.match(dim, /GROUP BY `channel`/)
})

test('SELECT 分组：可按分组列升序，乱填的排序列退回 cnt', () => {
  const byDim = gen(get('user'), 'select', {
    dialect: 'mysql',
    selectConditions: [],
    groupBy: ['channel'],
    orderBy: { column: 'channel', dir: 'asc' },
  })
  assert.match(byDim, /GROUP BY `channel`\nORDER BY `channel` ASC\nLIMIT/)

  const junk = gen(get('user'), 'select', {
    dialect: 'mysql',
    selectConditions: [],
    groupBy: ['channel'],
    orderBy: { column: 'username', dir: 'asc' },
  })
  assert.match(junk, /ORDER BY `cnt` ASC\nLIMIT/)
})

test('勾多个条件以 AND 连接，顺序按 UI 口径（主键→其余字母）而不是勾选顺序', () => {
  // 故意倒着传：按勾选顺序拼的话同一份配置换个点击次序就 diff 不了
  const sql = gen(get('user'), 'select', {
    dialect: 'mysql',
    selectConditions: ['level', 'username', 'id'],
  })
  const where = sql.slice(sql.indexOf('WHERE'))
  assert.match(
    where,
    /`id` = 1\n {2}AND `level` = \d+\n {2}AND `username` = '[^']+'\nORDER BY `id` DESC\nLIMIT 0, 20;/,
  )
})

test('一个条件都不勾：退化成查前 20 条，不生成查全表的裸 SELECT（PRD 4.9）', () => {
  const sql = gen(get('user'), 'select', { dialect: 'mysql', selectConditions: [] })
  assert.doesNotMatch(sql, /WHERE/, '没有条件却拼出了 WHERE')
  assert.match(sql, /LIMIT 0, 20;/)
  // 注释必须有：不然用户以为自己勾的条件被吃掉了，回头再点一遍
  assert.match(sql, /退化成查前 20 条/)
})

test('没有主键的表也走「查前 20 条」这条路，不会漏出裸 SELECT', () => {
  const sql = gen(get('user_role'), 'select', { dialect: 'mysql' })
  assert.doesNotMatch(sql, /WHERE/)
  assert.match(sql, /LIMIT 0, 20;/)
})

test('Oracle 没有 LIMIT，退化的分页要用 ROWNUM（11g 也能跑）', () => {
  const sql = gen(get('user'), 'select', { dialect: 'oracle', selectConditions: [] })
  assert.doesNotMatch(sql, /LIMIT/, 'Oracle 没有 LIMIT')
  assert.doesNotMatch(
    sql,
    /OFFSET\s+\d+\s+ROWS FETCH NEXT/,
    'FETCH 是 12c 才有的，11g 会 ORA-00933，看起来也不像 Oracle',
  )
  assert.match(sql, /WHERE ROWNUM <= 20;/)
})

test('条数下拉：pageSize 换成 50，LIMIT / ROWNUM 跟着变', () => {
  const mysql = gen(get('user'), 'select', {
    dialect: 'mysql',
    selectConditions: [],
    pageSize: 50,
  })
  assert.match(mysql, /退化成查前 50 条/)
  assert.match(mysql, /LIMIT 0, 50;/)

  const oracle = gen(get('user'), 'select', {
    dialect: 'oracle',
    selectConditions: [],
    pageSize: 100,
  })
  assert.match(oracle, /WHERE ROWNUM <= 100;/)
})

test('LIKE 没写通配符时自动包 %值%；已有 % 不再套一层', () => {
  const auto = gen(get('user'), 'select', {
    dialect: 'mysql',
    selectConditions: ['username'],
    selectValues: { username: '张' },
    cmpOps: { username: 'like' },
  })
  assert.match(auto, /`username` LIKE '%张%'/)

  const raw = gen(get('user'), 'select', {
    dialect: 'mysql',
    selectConditions: ['username'],
    selectValues: { username: '张%' },
    cmpOps: { username: 'like' },
  })
  assert.match(raw, /`username` LIKE '张%'/)
  assert.doesNotMatch(raw, /%%/)
})

test('LIKE 空值仍是 IS NULL，不是 LIKE NULL', () => {
  const sql = gen(get('user'), 'select', {
    dialect: 'mysql',
    selectConditions: ['remark'],
    selectValues: { remark: '' },
    cmpOps: { remark: 'like' },
  })
  assert.match(sql, /`remark` IS NULL/)
  assert.doesNotMatch(sql, /LIKE NULL/)
})

test('条件操作符：不等于拼 <>，大于等于拼 >=', () => {
  const ne = gen(get('user'), 'select', {
    dialect: 'mysql',
    selectConditions: ['username'],
    selectValues: { username: '甲' },
    cmpOps: { username: 'ne' },
  })
  assert.match(ne, /`username` <> '甲'/)

  const ge = gen(get('user'), 'select', {
    dialect: 'mysql',
    selectConditions: ['level'],
    selectValues: { level: '3' },
    cmpOps: { level: 'ge' },
  })
  assert.match(ge, /`level` >= 3/)
})

test('不等于且值为空：IS NOT NULL，不是 <> NULL', () => {
  const sql = gen(get('user'), 'select', {
    dialect: 'mysql',
    selectConditions: ['remark'],
    selectValues: { remark: '' },
    cmpOps: { remark: 'ne' },
  })
  assert.match(sql, /`remark` IS NOT NULL/)
  assert.doesNotMatch(sql, /<> NULL/)
  assert.doesNotMatch(sql, /= NULL/)
})

test('SQLite 真执行：不等于能把另一行滤掉', () => {
  const db = new DatabaseSync(':memory:')
  const user = get('user')
  db.exec(exportDdl(user, { dialect: 'sqlite' }))
  db.exec(gen(user, 'insert', { values: { insert: { username: '甲' } } }))
  db.exec(gen(user, 'insert', { values: { insert: { username: '乙' } } }))

  const sql = gen(user, 'select', {
    selectConditions: ['username'],
    selectValues: { username: '乙' },
    cmpOps: { username: 'ne' },
  })
  const rows = db.prepare(sql.replace(/;\s*$/, '')).all() as Array<{ username: string }>
  assert.deepEqual(
    rows.map((r) => r.username),
    ['甲'],
    `不等于没起作用：\n${sql}`,
  )
  db.close()
})

test('条件值留空给的是 IS NULL，不是 = NULL（PRD 4.9）', () => {
  /*
   * 这条是 4.9 里最容易写错、也最难发现的一处。
   * `col = NULL` 不报错，只是恒为 unknown——永远查不出行。用户会以为「数据没插进去」，
   * 回头去翻 INSERT 的日志，而问题其实在 WHERE 上。
   */
  const sql = gen(get('user'), 'select', {
    dialect: 'mysql',
    selectConditions: ['remark'],
    selectValues: { remark: '' },
  })
  assert.match(sql, /WHERE `remark` IS NULL\nORDER BY `id` DESC\nLIMIT 0, 20;/)
  assert.doesNotMatch(sql, /= NULL/)
})

test('条件值的写法跟 INSERT/UPDATE 一栏一致：NULL / NOW() 不加引号，字符串加引号', () => {
  const sql = gen(get('user'), 'select', {
    dialect: 'mysql',
    selectConditions: ['username', 'create_time'],
    selectValues: { username: "O'Brien", create_time: 'NOW()' },
  })
  assert.match(sql, /`username` = 'O''Brien'/, '单引号没翻倍，语句会断在半截')
  assert.match(sql, /`create_time` = NOW\(\)/)
})

test('主键条件的值取【WHERE 条件】那一行，跟 UPDATE / DELETE 共用', () => {
  const sql = gen(get('user'), 'select', { dialect: 'mysql', pkValues: { id: '42' } })
  assert.match(sql, /`id` = 42/)
})

test('非主键条件的缺省值取 INSERT 那一栏，包括用户手改过的', () => {
  const sql = gen(get('user'), 'select', {
    dialect: 'mysql',
    selectConditions: ['username'],
    values: { insert: { username: '手改的名字' } },
  })
  assert.match(sql, /`username` = '手改的名字'/, '条件值跟刚插进去的那行对不上，查不出来')
})

test('条件字段可以是③里没勾的列：WHERE 引用它合法，值照样取得到', () => {
  const sql = gen(get('user'), 'select', {
    dialect: 'mysql',
    selectedColumns: ['id'],
    selectConditions: ['phone'],
  })
  assert.doesNotMatch(sql.slice(0, sql.indexOf('WHERE')), /`phone`/, '没勾的字段进了查询列表')
  assert.match(sql, /WHERE `phone` (= '138\d{8}'|IS NULL)/)
})

test('SQLite 真执行：按多个条件查，捞回来的正好是刚插进去的那行', () => {
  /*
   * 「条件值默认跟 INSERT 那栏同一个」的实测。这是 PRD 1.3 的场景：
   * 插一条测试数据，然后确认它真的进去了。两条语句连着复制出去就该能对上，
   * 对不上就等于每次都要人工回头抄一遍值——这个功能也就没用了。
   */
  const db = new DatabaseSync(':memory:')
  const user = get('user')
  db.exec(exportDdl(user, { dialect: 'sqlite' }))
  db.exec(gen(user, 'insert'))

  const sql = gen(user, 'select', { selectConditions: ['username', 'level', 'balance'] })
  const rows = db.prepare(sql.replace(/;\s*$/, '')).all()
  assert.equal(rows.length, 1, `条件跟插进去的值对不上：\n${sql}`)
  db.close()
})

test('SQLite 真执行：条件字段的值是 NULL 时靠 IS NULL 才捞得回来', () => {
  /*
   * `= NULL` 版本在这条用例上会返回 0 行，而且不报错——正是最难查的那种失败。
   * remark 强制清空，INSERT 写进去的就是 NULL。
   */
  const db = new DatabaseSync(':memory:')
  const user = get('user')
  db.exec(exportDdl(user, { dialect: 'sqlite' }))
  db.exec(gen(user, 'insert', { values: { insert: { remark: '' } } }))

  const sql = gen(user, 'select', {
    selectConditions: ['remark'],
    values: { insert: { remark: '' } },
  })
  assert.match(sql, /IS NULL/)
  const rows = db.prepare(sql.replace(/;\s*$/, '')).all()
  assert.equal(rows.length, 1, '值为 NULL 的条件查不到那一行')
  db.close()
})

test('SQLite 真执行：条件确实起过滤作用，不是碰巧都命中', () => {
  // 上面几条只证明「查得到」。查得到也可能是因为条件根本没生效，
  // 所以这里插两行、按其中一行的值查，断言另一行被过滤掉了。
  const db = new DatabaseSync(':memory:')
  const user = get('user')
  db.exec(exportDdl(user, { dialect: 'sqlite' }))
  db.exec(gen(user, 'insert', { values: { insert: { username: '甲' } } }))
  db.exec(gen(user, 'insert', { values: { insert: { username: '乙' } } }))

  const sql = gen(user, 'select', {
    selectConditions: ['username'],
    selectValues: { username: '乙' },
  })
  const rows = db.prepare(sql.replace(/;\s*$/, '')).all() as Array<{ username: string }>
  assert.deepEqual(
    rows.map((r) => r.username),
    ['乙'],
    '条件没起作用，两行都查出来了',
  )
  db.close()
})

test('主键值被清空时 UPDATE / DELETE 也走 IS NULL，不生成 = NULL', () => {
  // `WHERE id = NULL` 的 DELETE 一行都删不掉却又不报错，用户只会以为语句没执行
  const del = gen(get('user'), 'delete', { dialect: 'mysql', pkValues: { id: '' } })
  assert.match(del, /WHERE `id` IS NULL;/)
  assert.doesNotMatch(del, /= NULL/)
})

test('DEFAULT 的字符串值只剥一层引号，不会变成 \'\'web\'\'', () => {
  const plan = planValues(get('user'), 'mysql', 3).find((p) => p.column.name === 'channel')
  assert.ok(plan)
  assert.equal(plan.auto, 'web')
  assert.equal(renderValue(plan.column, plan.auto, 'mysql'), "'web'")
})

test('renderValue：空值当 NULL，函数和数字不加引号，字符串加引号', () => {
  const user = get('user')
  const col = (name: string) => {
    const c = user.columns.find((x) => x.name === name)
    assert.ok(c)
    return c
  }
  assert.equal(renderValue(col('remark'), '  ', 'mysql'), 'NULL')
  assert.equal(renderValue(col('remark'), 'null', 'mysql'), 'NULL')
  assert.equal(renderValue(col('create_time'), 'now()', 'mysql'), 'NOW()')
  assert.equal(renderValue(col('age'), '18', 'mysql'), '18')
  assert.equal(renderValue(col('balance'), '99.90', 'mysql'), '99.90')
  assert.equal(renderValue(col('username'), '张三', 'mysql'), "'张三'")
  // 数字类型里塞了非数字，只能加引号——不加就是语法错误
  assert.equal(renderValue(col('age'), '未知', 'mysql'), "'未知'")
})

test('手输 TRUE/FALSE 按方言给：Oracle 只认 1/0', () => {
  // Oracle 23c 以前没有布尔字面量，原样写 TRUE 进去是 ORA-00904「标识符无效」。
  // 自动值给的是 0/1，所以这条只在用户手改成 TRUE 时命中——但那正是最容易漏的路径。
  const boolCol: Column = {
    ...get('user').columns[0],
    name: 'is_deleted',
    type: 'TINYINT(1)',
    javaField: 'isDeleted',
    javaType: 'Boolean',
  }
  const cases: Array<[GenDialect, string, string]> = [
    ['mysql', 'TRUE', 'FALSE'],
    ['postgresql', 'TRUE', 'FALSE'],
    ['sqlite', '1', '0'],
    ['oracle', '1', '0'],
  ]
  for (const [dialect, t, f] of cases) {
    assert.equal(renderValue(boolCol, 'TRUE', dialect), t, `${dialect} 的 TRUE`)
    assert.equal(renderValue(boolCol, 'false', dialect), f, `${dialect} 的 false（小写也认）`)
  }
  // 跟日志回填走的必须是同一套规则，否则两个功能对同一个方言给出不同的 SQL
  assert.equal(
    renderParam({ raw: 'true', value: 'true', declaredType: 'Boolean' }, 'oracle').literal,
    renderValue(boolCol, 'TRUE', 'oracle'),
  )
})

test('日期字面量：只有 Oracle 需要 TO_DATE，其余方言裸字符串', () => {
  const createTime = get('user').columns.find((c) => c.name === 'create_time')
  assert.ok(createTime)
  const cases: Array<[GenDialect, string]> = [
    ['mysql', "'2026-08-22 10:30:00'"],
    ['postgresql', "'2026-08-22 10:30:00'"],
    ['sqlite', "'2026-08-22 10:30:00'"],
    ['oracle', "TO_DATE('2026-08-22 10:30:00', 'YYYY-MM-DD HH24:MI:SS')"],
  ]
  for (const [dialect, expected] of cases) {
    assert.equal(renderValue(createTime, '2026-08-22 10:30:00', dialect), expected)
  }
  // 只有日期没有时分秒时，格式串也得跟着变，否则 ORA-01861
  assert.equal(renderValue(createTime, '2026-08-22', 'oracle'), "TO_DATE('2026-08-22', 'YYYY-MM-DD')")
})

test('语义规则：email / phone / password 按字段名给合理值', () => {
  const plans = planValues(get('user'), 'mysql', 5)
  const auto = (name: string) => plans.find((p) => p.column.name === name)?.auto ?? ''
  assert.match(auto('email'), /^[a-z]+@test\.com$/)
  assert.match(auto('phone'), /^138\d{8}$/)
  // 密码从几个弱口令里挑，不是写死的常量——UPDATE 阶段要能给出一个不同的新密码
  assert.match(auto('password'), /^(123456|654321|abc123|test1234)$/)
})

test('只选一部分字段时，没选的字段不出现在任何语句里', () => {
  const sql = generateExecutable(
    get('user'),
    opts({ dialect: 'mysql', selectedColumns: ['id', 'username'] }),
  )
  assert.match(sql, /`username`/)
  assert.doesNotMatch(sql, /`email`/)
})

test('注释头里带「可执行SQL」字样，跟预编译模式区分得开', () => {
  const sql = generateExecutable(get('user'), opts({ withHeader: true, kinds: ['insert'] }))
  assert.match(sql, /可执行SQL/)
})

test('字段全不选 / 语句类型全不选，给提示而不是空字符串', () => {
  assert.match(generateExecutable(get('user'), opts({ selectedColumns: [] })), /没有选中任何字段/)
  assert.match(generateExecutable(get('user'), opts({ kinds: [] })), /没有选中任何语句类型/)
})
