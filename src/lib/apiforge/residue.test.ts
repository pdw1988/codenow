/**
 * 测试残留检测（PRD v0.6 模块 4.16）的单测。
 * live 会话用脚本假货：按 SQL 片段路由到准备好的网格，不连真库。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { LiveDbDialect, QueryGrid } from '../dbDialect'
import type { Column, ForeignKey } from '../../types/schema'
import type { TableSnapshot } from './types'
import {
  cleanupPlan,
  cleanupSqls,
  claimedInserts,
  detectResidue,
  residueConnMismatch,
  snapResidueTables,
} from './residue'

const grid = (columns: string[], rows: string[][]): QueryGrid => ({
  columns,
  rows,
  truncated: false,
  cap: 200,
})

/** 按 SQL 片段路由的假 live：handlers 逐条试，命中第一个含关键字的 */
function fakeLive(handlers: { match: RegExp; run: (sql: string) => QueryGrid }[]): LiveDbDialect {
  return {
    query: async (sql: string) => {
      for (const h of handlers) {
        if (h.match.test(sql)) return h.run(sql)
      }
      throw new Error(`假 live 没有这个查询的桩：${sql}`)
    },
  } as unknown as LiveDbDialect
}

const col = (name: string, type: string, extra: Partial<Column> = {}): Column => ({
  name,
  type,
  nullable: true,
  isPrimaryKey: false,
  isAutoIncrement: false,
  javaField: name,
  javaType: 'String',
  ...extra,
})

const fk = (fromTable: string, fromColumn: string, toTable: string, confidence: ForeignKey['confidence'] = 'constraint'): ForeignKey => ({
  fromTable,
  fromColumn,
  toTable,
  toColumn: 'ID',
  confidence,
})

const snap = (table: string, rowCount: number | null, pkValues: string[], hasPk = true): TableSnapshot => ({
  tableName: table,
  rowCount,
  rows: null,
  pkValues,
  hasPk,
})

const T = 'T_ORDER'
const pkLookupOf = async () => ['ID']

// ── snapResidueTables：起点/终点快照 ─────────────────────────────────────────

test('快照：COUNT + 主键倒序抽样进 TableSnapshot，主键从 pkLookup 来', async () => {
  const live = fakeLive([
    { match: /COUNT\(\*\)/, run: () => grid(['N'], [['3']]) },
    { match: /SELECT \* FROM/, run: () => grid(['ID', 'STATUS'], [['3', 'x'], ['2', 'y'], ['1', 'z']]) },
  ])
  const { snapshots, errors } = await snapResidueTables(live, 'oracle', pkLookupOf, [T])
  assert.deepEqual(errors, [])
  const s = snapshots.get(T)!
  assert.equal(s.rowCount, 3)
  // buildSnapshot 会把样本主键排序，这里只认集合不认顺序
  assert.deepEqual([...s.pkValues].sort(), ['1', '2', '3'])
  assert.equal(s.hasPk, true)
})

test('快照：表不存在 → 进 errors 并记入 skipTables，下一轮不再查', async () => {
  const skip = new Set<string>()
  let calls = 0
  const live = fakeLive([
    {
      match: /./,
      run: () => {
        calls++
        throw new Error('ORA-00942: table or view does not exist')
      },
    },
  ])
  const r1 = await snapResidueTables(live, 'oracle', pkLookupOf, [T], skip)
  assert.equal(r1.snapshots.size, 0)
  assert.equal(r1.errors.length, 1)
  assert.ok(skip.has(T))
  await snapResidueTables(live, 'oracle', pkLookupOf, [T], skip)
  assert.equal(calls, 1) // 第二轮零查询
})

// ── detectResidue：三类候选 ─────────────────────────────────────────────────

const columnsOfT: Column[] = [
  col('ID', 'NUMBER(20)', { isPrimaryKey: true }),
  col('USER_ID', 'NUMBER(20)'),
  col('NAME', 'VARCHAR2(50)'),
  col('MEMO', 'VARCHAR2(200)'),
]

function residueLive(over: { orphanCount?: number; prefixCount?: number } = {}) {
  return fakeLive([
    {
      match: /COUNT\(\*\).*USER_ID/,
      run: () => grid(['N'], [[String(over.orphanCount ?? 2)]]),
    },
    {
      match: /COUNT\(\*\).*LIKE 'test%'/,
      run: () => grid(['N'], [[String(over.prefixCount ?? 1)]]),
    },
    {
      match: /SELECT "ID" FROM "T_ORDER" WHERE/,
      run: () => grid(['ID'], [['9001'], ['9002']]),
    },
  ])
}

const depsOf = (live: LiveDbDialect, start: TableSnapshot[], tables = [T]) => ({
  live,
  dialect: 'oracle' as const,
  pkLookup: pkLookupOf,
  lookupColumns: async () => columnsOfT,
  tables,
  startSnapshots: new Map(start.map((s) => [s.tableName, s])),
  claimed: new Map<string, Set<string>>(),
  foreignKeys: [fk(T, 'USER_ID', 'T_USER')],
})

test('unclaimed：跑后多出来的主键，扣掉认领的不算残留', async () => {
  const live = residueLive({ orphanCount: 0, prefixCount: 0 })
  const deps = depsOf(live, [snap(T, 10, ['1', '2'])])
  const end = new Map([[T, snap(T, 12, ['3', '2', '1'])]])
  // claimed 认领了 3 → 只剩空
  deps.claimed.set(T, new Set(['3']))
  const r = await detectResidue(deps, end)
  assert.equal(r.findings.filter((f) => f.kind === 'unclaimed').length, 0)
  // 不认领 → 3 是残留
  deps.claimed.delete(T)
  const r2 = await detectResidue(deps, end)
  const un = r2.findings.find((f) => f.kind === 'unclaimed')!
  assert.deepEqual(un.pks, ['3'])
  assert.equal(un.pkCol, 'ID')
})

test('apiInserted：新增接口插的行单列出来、出清理 SQL；后来被删接口删掉的不列', async () => {
  const live = residueLive({ orphanCount: 0, prefixCount: 0 })
  const deps = depsOf(live, [snap(T, 10, ['1', '2'])])
  deps.claimed.set(T, new Set(['3', '4']))
  // 4 后来被删除接口删了：跑后快照里只剩 3
  const r = await detectResidue(deps, new Map([[T, snap(T, 11, ['3', '2', '1'])]]))
  const ins = r.findings.find((f) => f.kind === 'apiInserted')!
  assert.deepEqual(ins.pks, ['3'])
  assert.equal(ins.count, 1)
  assert.ok(r.cleanupSql.some((s) => /IN \(3\)/.test(s)))
  // 没有接口新增的就没有这一类
  deps.claimed.delete(T)
  const r2 = await detectResidue(deps, new Map([[T, snap(T, 10, ['2', '1'])]]))
  assert.equal(r2.findings.some((f) => f.kind === 'apiInserted'), false)
})

test('orphanFk：外键空值行进候选，NOT NULL 的外键列不查', async () => {
  const live = residueLive({ orphanCount: 2 })
  const deps = depsOf(live, [snap(T, 10, ['1'])])
  const end = new Map([[T, snap(T, 12, ['9001', '9002', '1'])]])
  const r = await detectResidue(deps, end)
  const f = r.findings.find((x) => x.kind === 'orphanFk')!
  assert.ok(f)
  assert.equal(f.count, 2)
  assert.deepEqual(f.pks, ['9001', '9002'])
  assert.match(f.detail, /USER_ID/)
  assert.match(f.detail, /真实约束/)
})

test('testPrefix：test/测试 前缀的行进候选，主键列不参与 LIKE', async () => {
  const live = residueLive({ orphanCount: 0, prefixCount: 1 })
  const deps = depsOf(live, [snap(T, 10, ['1'])])
  const end = new Map([[T, snap(T, 11, ['9001', '1'])]])
  const r = await detectResidue(deps, end)
  const f = r.findings.find((x) => x.kind === 'testPrefix')!
  assert.ok(f)
  assert.equal(f.count, 1)
  assert.ok(!JSON.stringify(f.detail).includes('ID、'))
})

test('行数超上限的表：快照差分照做，COUNT/LIKE 跳过并如实说明', async () => {
  const live = residueLive()
  const deps = { ...depsOf(live, []), scanRowCap: 100 }
  const end = new Map([[T, snap(T, 500, ['7', '1'])]])
  const r = await detectResidue(deps, end)
  assert.ok(r.findings.some((f) => f.kind === 'unclaimed' && f.pks.includes('7')))
  assert.ok(r.skipped.some((s) => /超过扫描上限/.test(s.reason)))
  assert.equal(r.findings.filter((f) => f.kind !== 'unclaimed').length, 0)
})

test('复合主键：候选照报，但 pkCol 留空——定位不完整不出清理 SQL', async () => {
  const live = residueLive({ orphanCount: 1 })
  const deps = depsOf(live, [])
  deps.pkLookup = async () => ['ID', 'SEQ']
  const end = new Map([[T, snap(T, 5, ['9'])]])
  const r = await detectResidue(deps, end)
  const f = r.findings.find((x) => x.kind === 'orphanFk')!
  assert.ok(f)
  assert.equal(f.pkCol, '')
  assert.deepEqual(f.pks, []) // 复合主键连样本也不给（第一列定位会误删）
  assert.equal(cleanupPlan(r.findings, deps.foreignKeys).length, 0)
})

// ── cleanupPlan / cleanupSqls ───────────────────────────────────────────────

test('清理 SQL：子表在前父表在后（只认 constraint 约束），同表候选合并 pk', async () => {
  const findings = [
    { kind: 'orphanFk' as const, table: 'T_ORDER', pkCol: 'ID', count: 1, pks: ['2'], detail: '' },
    { kind: 'unclaimed' as const, table: 'T_ORDER', pkCol: 'ID', count: null, pks: ['1'], detail: '' },
    { kind: 'testPrefix' as const, table: 'T_USER', pkCol: 'ID', count: 1, pks: ['u1'], detail: '' },
  ]
  const fks = [fk('T_ORDER', 'USER_ID', 'T_USER')]
  const groups = cleanupPlan(findings, fks)
  assert.deepEqual(groups.map((g) => g.table), ['T_ORDER', 'T_USER']) // 子表 T_ORDER 先删
  assert.equal(groups[0]!.pks.length, 2) // 两个候选同表合并：['2','1']
  const sqls = cleanupSqls(groups, 'oracle')
  assert.match(sqls[0]!, /DELETE FROM "T_ORDER" WHERE "ID" IN \(2, 1\)/)
  assert.match(sqls[1]!, /DELETE FROM "T_USER" WHERE "ID" IN \('u1'\)/)
})

test('清理 SQL：naming 约束不给排序权力（环里按名字兜底不炸）', () => {
  const findings = [
    { kind: 'testPrefix' as const, table: 'B', pkCol: 'ID', count: 1, pks: ['1'], detail: '' },
    { kind: 'testPrefix' as const, table: 'A', pkCol: 'ID', count: 1, pks: ['1'], detail: '' },
  ]
  const fks = [fk('A', 'X', 'B', 'naming')]
  const groups = cleanupPlan(findings, fks)
  assert.deepEqual(groups.map((g) => g.table), ['A', 'B']) // 没有真约束 → 名字兜底
})

test('lit：数字裸写、字符串加引号且引号翻倍转义', () => {
  const sqls = cleanupSqls([{ table: 'T', pkCol: 'ID', pks: ['123', "o'brien", ''] }], 'mysql')
  assert.match(sqls[0]!, /IN \(123, 'o''brien', ''\)/)
})

// ── residueConnMismatch ──

test('residueConnMismatch：同 id 放行、换连接拒绝、没连库拒绝、旧报告放行', () => {
  const sit = { id: 'c1', label: 'sit · 10.0.0.1:1521/ORCL' }
  const prod = { id: 'c2', label: 'prod · 10.0.0.2:1521/ORCL' }
  assert.equal(residueConnMismatch(sit, { ...sit }), null)
  assert.match(residueConnMismatch(sit, prod)!, /sit.*prod/)
  assert.equal(residueConnMismatch(sit, null), '当前没有连库')
  assert.equal(residueConnMismatch(undefined, prod), null)
})

test('residueConnMismatch：一边没 id 时按 label 比', () => {
  assert.equal(residueConnMismatch({ label: 'a' }, { id: 'c1', label: 'a' }), null)
  assert.notEqual(residueConnMismatch({ label: 'a' }, { id: 'c1', label: 'b' }), null)
})

// ── claimedInserts ──────────────────────────────────────────────────────────

test('claimedInserts：只收 insert 的 insertedIds，空串不收', () => {
  const map = claimedInserts([
    {
      dbChanges: [
        { tableName: 'T_ORDER', op: 'insert', insertedIds: ['1', '', '2'] },
        { tableName: 'T_LOG', op: 'update', insertedIds: ['9'] },
      ],
    },
  ] as never)
  assert.deepEqual([...map.get('T_ORDER')!], ['1', '2'])
  assert.equal(map.get('T_LOG'), undefined)
})
