import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { assertGenWrite, execDisabledReason, isNeedSession, planExec } from './sqlExec'

test('INSERT 放行；无 WHERE 的 UPDATE/DELETE 拒；SELECT 拒', () => {
  assert.doesNotThrow(() => assertGenWrite('INSERT INTO t (id) VALUES (1)'))
  assert.doesNotThrow(() => assertGenWrite('UPDATE t SET a = 1 WHERE id = 1'))
  assert.throws(() => assertGenWrite('UPDATE t SET a = 1'), /WHERE/)
  assert.throws(() => assertGenWrite('DELETE FROM t'), /WHERE/)
  assert.throws(() => assertGenWrite('SELECT * FROM t'), /SELECT/)
})

test('批量拆成多条，能在 sqlite 里跑', () => {
  const plan = planExec(`
    INSERT INTO t (id, name) VALUES (1, 'a');
    INSERT INTO t (id, name) VALUES (2, 'b');
  `)
  assert.equal(plan.statements.length, 2)
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (id INTEGER, name TEXT)')
  for (const s of plan.statements) db.exec(s)
  const n = db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }
  assert.equal(n.n, 2)
})

test('夹着 SELECT 整段拒', () => {
  assert.throws(
    () => planExec('INSERT INTO t VALUES (1); SELECT * FROM t'),
    /连库查询/,
  )
})

test('没连上 / 方言对不上 / 预编译：禁用并说明', () => {
  const sql = 'INSERT INTO t (id) VALUES (1)'
  assert.match(
    execDisabledReason({ sql, pageDialect: 'oracle', session: null, isTauri: true }) ?? '',
    /还没连库/,
  )
  assert.match(
    execDisabledReason({
      sql,
      pageDialect: 'oracle',
      session: { kind: 'mysql' },
      isTauri: true,
    }) ?? '',
    /MySQL/,
  )
  assert.match(
    execDisabledReason({
      sql: 'INSERT INTO t (id) VALUES (#{id})',
      pageDialect: 'mysql',
      session: { kind: 'mysql' },
      isTauri: true,
    }) ?? '',
    /占位符/,
  )
  assert.match(
    execDisabledReason({
      sql,
      pageDialect: 'mysql',
      session: { kind: 'mysql' },
      isTauri: false,
    }) ?? '',
    /浏览器/,
  )
  assert.equal(
    execDisabledReason({
      sql,
      pageDialect: 'mysql',
      session: { kind: 'mysql' },
      isTauri: true,
    }),
    null,
  )
  assert.equal(
    isNeedSession(execDisabledReason({ sql, pageDialect: 'oracle', session: null, isTauri: true })),
    true,
  )
  assert.equal(
    isNeedSession(execDisabledReason({
      sql,
      pageDialect: 'oracle',
      session: { kind: 'mysql' },
      isTauri: true,
    })),
    false,
  )
})

test('行首注释不算第二段；预编译 / Mapper 会禁用', () => {
  const plan = planExec(`-- 注意: 测试数据
INSERT INTO t (id) VALUES (1)`)
  assert.equal(plan.statements.length, 1)
  assert.match(plan.statements[0], /INSERT/)
  const base = {
    sql: 'INSERT INTO t (id) VALUES (1)',
    pageDialect: 'mysql' as const,
    session: { kind: 'mysql' as const },
    isTauri: true,
  }
  assert.match(execDisabledReason({ ...base, executable: false }) ?? '', /预编译/)
  assert.match(execDisabledReason({ ...base, output: 'mybatis' }) ?? '', /Mapper/)
})

test('可执行 SELECT 不禁用，送到连库查询；预编译 SELECT 仍禁用', () => {
  const base = {
    pageDialect: 'mysql' as const,
    session: { kind: 'mysql' as const },
    isTauri: true,
  }
  assert.equal(
    execDisabledReason({ ...base, sql: 'SELECT id FROM t WHERE id = 1' }),
    null,
  )
  assert.match(
    execDisabledReason({ ...base, sql: 'SELECT id FROM t WHERE id = #{id}' }) ?? '',
    /占位符/,
  )
})

test('生产标签不挡按钮，只影响确认次数（原因函数不管 env）', () => {
  assert.equal(
    execDisabledReason({
      sql: 'DELETE FROM t WHERE id = 1',
      pageDialect: 'oracle',
      session: { kind: 'oracle', env: 'prod' },
      isTauri: true,
    }),
    null,
  )
})
