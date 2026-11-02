import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Column } from '../types/schema'
import {
  assertReadonlySelect,
  extractRunnableSelect,
  previewSql,
  previewSqlWithWhere,
  QUERY_ROW_CAP,
  QUERY_ROW_CAP_ALL,
} from './sqlReadonly'

test('只读闸门：SELECT / WITH 放行，去掉末尾分号', () => {
  assert.equal(assertReadonlySelect('  SELECT 1 FROM dual;  '), 'SELECT 1 FROM dual')
  assert.ok(assertReadonlySelect('WITH a AS (SELECT 1 x FROM dual) SELECT * FROM a').includes('WITH'))
})

test('只读闸门：SHOW / DESC 放行（MySQL 看表常用）', () => {
  assert.ok(assertReadonlySelect('SHOW TABLES').startsWith('SHOW'))
  assert.ok(assertReadonlySelect('DESC user').startsWith('DESC'))
  assert.ok(assertReadonlySelect('SHOW CREATE TABLE user').startsWith('SHOW'))
})

test('只读闸门：写操作拒掉，字符串里的 INSERT 不误伤', () => {
  assert.throws(() => assertReadonlySelect('INSERT INTO t VALUES (1)'), /INSERT/)
  assert.throws(() => assertReadonlySelect('UPDATE t SET a=1'), /UPDATE/)
  assert.throws(() => assertReadonlySelect('DELETE FROM t'), /DELETE/)
  assert.doesNotThrow(() => assertReadonlySelect("SELECT 'INSERT INTO t' FROM dual"))
})

test('只读闸门：第二条语句拒掉；注释里的分号不算', () => {
  assert.throws(() => assertReadonlySelect('SELECT 1; SELECT 2'), /一条/)
  assert.doesNotThrow(() => assertReadonlySelect("SELECT 'a;b' FROM dual"))
})

test('行数封顶：先 200，加载全部 1 万', () => {
  assert.equal(QUERY_ROW_CAP, 200)
  assert.equal(QUERY_ROW_CAP_ALL, 10_000)
  assert.ok(QUERY_ROW_CAP_ALL > QUERY_ROW_CAP)
})

test('点表名填 SELECT：Oracle 双引号，MySQL 反引号，PG 限定名按段加引号', () => {
  assert.equal(previewSql('oracle', 'USER'), 'SELECT * FROM "USER"')
  assert.equal(previewSql('mysql', 'order'), 'SELECT * FROM `order`')
  assert.equal(previewSql('postgresql', 'users'), 'SELECT * FROM "users"')
  assert.equal(previewSql('postgresql', 'audit.logs'), 'SELECT * FROM "audit"."logs"')
})

test('勾列：列出字段；空数组仍是 *（全不选由界面挡住，不拿去跑）', () => {
  assert.equal(previewSql('oracle', 'USER', ['ID', 'NAME']), 'SELECT "ID", "NAME" FROM "USER"')
  assert.equal(previewSql('mysql', 'order', ['id']), 'SELECT `id` FROM `order`')
  assert.equal(previewSql('postgresql', 'audit.logs', ['id']), 'SELECT "id" FROM "audit"."logs"')
  assert.equal(previewSql('oracle', 'T', []), 'SELECT * FROM "T"')
})

test('连库条件：无条件就是 previewSql；有条件拼 WHERE', () => {
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
  const id = col('ID', 'NUMBER', true)
  const name = col('NAME', 'VARCHAR2(50)')
  assert.equal(previewSqlWithWhere('oracle', 'USER', undefined, []), 'SELECT * FROM "USER"')
  assert.equal(
    previewSqlWithWhere('oracle', 'USER', ['ID', 'NAME'], [{ column: id, value: '1', op: 'eq' }]),
    `SELECT "ID", "NAME" FROM "USER" WHERE "ID" = '1'`,
  )
  assert.equal(
    previewSqlWithWhere('mysql', 'user', undefined, [{ column: name, value: '', op: 'eq' }]),
    'SELECT * FROM `user` WHERE `NAME` IS NULL',
  )
  assert.equal(
    previewSqlWithWhere('oracle', 'USER', undefined, [{ column: name, value: '张', op: 'like' }]),
    `SELECT * FROM "USER" WHERE "NAME" LIKE '%张%'`,
  )
  assert.equal(
    previewSqlWithWhere('mysql', 't', ['id'], [
      { column: id, value: '1', op: 'eq' },
      { column: name, value: 'a', op: 'ne' },
    ]),
    "SELECT `id` FROM `t` WHERE `ID` = '1' AND `NAME` <> 'a'",
  )
})

test('只读闸门：WITH 后接 INSERT、FOR UPDATE 也拒', () => {
  assert.throws(
    () => assertReadonlySelect('WITH a AS (SELECT 1 x FROM dual) INSERT INTO t SELECT * FROM a'),
    /INSERT/,
  )
  assert.throws(() => assertReadonlySelect('SELECT id FROM t FOR UPDATE'), /UPDATE/)
})

test('生成结果里抽出第一条 SELECT；夹着写语句则不抽', () => {
  const q = extractRunnableSelect(`-- 表名: T
-- 1. 查询
SELECT id FROM t WHERE id = 1;`)
  assert.match(q ?? '', /SELECT id FROM t WHERE id = 1/)
  assert.equal(extractRunnableSelect('INSERT INTO t (id) VALUES (1)'), null)
  assert.equal(
    extractRunnableSelect('INSERT INTO t (id) VALUES (1);\nSELECT id FROM t'),
    null,
  )
})
