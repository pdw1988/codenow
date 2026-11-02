/**
 * 测试残留检测（PRD v0.6 模块 4.16）——回归跑完后扫测试垃圾。
 *
 * 三类候选，**全部只是候选**：业务库里合法的 NULL 外键、正巧 test 开头的真数据
 * 都会误报，所以只出清单和清理 SQL，用户确认后才执行——工具绝不按自己的判断删行：
 *
 *  1. unclaimed   快照差分：跑后比跑前多出来、又不属于任何接口认领的 insertedIds
 *                 的主键。造数清理失败的行、服务偷偷写的行都在这里。
 *  2. orphanFk    关联外键为空的行：造数插的子行外键没填上（定位父行失败那一路）。
 *  3. testPrefix  test / 测试 前缀数据：用户自己留的测试行。
 *  4. apiInserted 新增接口自己插的行（认领的 insertedIds 里跑完还在的）。
 *
 * COUNT / LIKE 是全表扫：行数超过上限的表只做快照差分，列级扫描跳过并如实说明。
 */

import type { LiveDbDialect, QueryGrid } from '../dbDialect'
import type { Column, ForeignKey } from '../../types/schema'
import { DIALECTS, type GenDialect } from '../sqlgen/dialect'
import { buildSnapshot, planSnapshot } from './dbdiff/dbdiff'
import { isMissingTableError, missingTableNote } from './runner/missingTable'
import type { CaseRunResult, ResidueConn, ResidueFinding, ResidueReport, TableSnapshot } from './types'

/** 样本主键上限：清理 SQL 里 IN 列表的规模顶到这 */
const SAMPLE_CAP = 60
/** 全表扫描（COUNT / LIKE）的行数上限：超过的表跳过列级扫描，快照差分照做 */
const SCAN_ROW_CAP = 100_000
/** LIKE 扫的字符串列上限：一张表扫 8 列已经够吵了 */
const LIKE_COL_CAP = 8
/** 一张表最多统计几个外键列的空值 */
const FK_COL_CAP = 4

/** 列类型是不是文本（LIKE 有意义）。数字 / 日期拿 LIKE 扫出来的全是噪音 */
function isTextColumn(type: string): boolean {
  return /^(VARCHAR|NVARCHAR|CHAR|NCHAR|CHARACTER|TEXT|CLOB|STRING)/i.test(type)
}

/** 主键值转 SQL 字面量：纯数字裸写，其余按字符串加引号（'' 转义） */
function lit(v: string): string {
  return /^-?\d+(\.\d+)?$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`
}

const fromOf = (table: string, dialect: GenDialect): string =>
  table.split('.').map(DIALECTS[dialect].quote).join('.')

/** 跑前 / 跑后各取一次：每张表 COUNT + 主键倒序抽样（与用例级快照同一套口径）。
 *  残留差分就在这两份之间做；库里没这张表（接口造的中间表没建等）记进 errors，
 *  skipTables 与用例级快照共用：第一发现人说过一次，后面都不再问。 */
export async function snapResidueTables(
  live: LiveDbDialect,
  dialect: GenDialect,
  pkLookup: (table: string) => Promise<string[]>,
  tables: string[],
  skipTables?: Set<string>,
): Promise<{ snapshots: Map<string, TableSnapshot>; errors: { tableName: string; message: string }[] }> {
  const snapshots = new Map<string, TableSnapshot>()
  const errors: { tableName: string; message: string }[] = []
  for (const table of tables) {
    if (skipTables?.has(table)) continue
    let pks: string[] = []
    try {
      pks = await pkLookup(table)
    } catch {
      pks = []
    }
    const plan = planSnapshot(dialect, table, pks)
    const runOne = async (sql: string | null): Promise<QueryGrid | null> => {
      if (!sql) return null
      try {
        return await live.query(sql)
      } catch (e) {
        throw new Error(`快照查询失败：${String(e)}`)
      }
    }
    try {
      const countGrid = await runOne(plan.countSql)
      const sampleGrid = plan.sampleSql ? await runOne(plan.sampleSql) : null
      const snap = buildSnapshot(table, plan, { countGrid, sampleGrid, targetedGrid: null })
      snapshots.set(table, snap)
    } catch (e) {
      const msg = String(e)
      if (isMissingTableError(msg)) {
        skipTables?.add(table)
        errors.push({ tableName: table, message: missingTableNote(table) })
      } else {
        errors.push({ tableName: table, message: msg })
      }
    }
  }
  return { snapshots, errors }
}

export interface ResidueDeps {
  live: LiveDbDialect
  dialect: GenDialect
  pkLookup: (table: string) => Promise<string[]>
  /** 表的列清单（连库导入 / DDL 导入的缓存）。拿不到就跳过该表的列级检查并说明 */
  lookupColumns: (table: string) => Promise<Column[] | null>
  /** 参与检测的关联表（勾选启用的那批） */
  tables: string[]
  /** 管线开头取的快照 */
  startSnapshots: Map<string, TableSnapshot>
  /** 各接口认领的插入主键（claimedInserts 汇总）：差分时从「新增」里扣掉 */
  claimed: Map<string, Set<string>>
  /** 声明过的外键（schema 缓存）。排序只认 constraint，孤儿检测 constraint/naming 都看 */
  foreignKeys: ForeignKey[]
  scanRowCap?: number
}

/** 回归跑完后检测一次。endSnapshots 由调用方在 finishAll 之后取（清理失败的行
 *  恰好在这时露出来），列级扫描（外键空值 / test 前缀）在这里现场查。 */
export async function detectResidue(
  deps: ResidueDeps,
  endSnapshots: Map<string, TableSnapshot>,
): Promise<ResidueReport> {
  const findings: ResidueFinding[] = []
  const skipped: { table: string; reason: string }[] = []
  const scanRowCap = deps.scanRowCap ?? SCAN_ROW_CAP

  for (const table of deps.tables) {
    const start = deps.startSnapshots.get(table)
    const end = endSnapshots.get(table)
    if (!end) continue // 起点就失败 / 表不存在：errors 里已经说过，这里不重复

    // 复合主键只按第一列抽样（与快照同一 MVP 口径）：第一列定位可能误伤同列值
    // 的其他行，所以 pkCol 留空 = 只提示不生成清理 SQL
    let pkCols: string[] = []
    try {
      pkCols = await deps.pkLookup(table)
    } catch {
      pkCols = []
    }
    const singlePk = pkCols.length === 1 ? pkCols[0] : ''
    const pkLower = new Set(pkCols.map((c) => c.toLowerCase()))

    // ── 1. unclaimed：快照差分 ──────────────────────────────────────────────
    const startPks = new Set(start?.pkValues ?? [])
    const claimed = deps.claimed.get(table)
    const unclaimed = end.pkValues.filter((p) => p !== '' && !startPks.has(p) && !claimed?.has(p))
    if (end.hasPk && unclaimed.length) {
      findings.push({
        kind: 'unclaimed',
        table,
        pkCol: singlePk,
        count: null,
        pks: unclaimed,
        detail: `跑后比跑前多出来、又没被任何接口的写变更认领的主键（样本 ${unclaimed.length} 个）`,
      })
    } else if (!end.hasPk && start?.rowCount != null && end.rowCount != null && end.rowCount > start.rowCount) {
      findings.push({
        kind: 'unclaimed',
        table,
        pkCol: '',
        count: end.rowCount - start.rowCount,
        pks: [],
        detail: `无主键表：行数跑后比跑前多 ${end.rowCount - start.rowCount}，定位不到行，只提示不生成清理 SQL`,
      })
    }

    // ── apiInserted：新增接口自己插的行。工具不按自己的判断删业务数据（2026-10-20 定：
    //    列出来手动删）。后面有删除接口删掉了的，跑后快照里已经没有，不再列
    if (claimed?.size) {
      const left = [...claimed].filter((p) => p !== '' && (!end.hasPk || end.pkValues.includes(p)))
      if (left.length) {
        findings.push({
          kind: 'apiInserted',
          table,
          pkCol: singlePk,
          count: left.length,
          pks: left.slice(0, SAMPLE_CAP),
          detail: `本次接口新增的数据（${left.length} 行），工具不自动删，确认后点清理`,
        })
      }
    }

    // ── 2/3. 列级扫描：外键空值 + test 前缀 ────────────────────────────────
    let columns: Column[] | null = null
    try {
      columns = await deps.lookupColumns(table)
    } catch {
      columns = null
    }
    if (!columns || columns.length === 0) {
      skipped.push({ table, reason: '没有这张表的列缓存（连库导入或 DDL 导入后有），外键 / 前缀检查跳过' })
      continue
    }
    if (end.rowCount == null) {
      skipped.push({ table, reason: '行数未知，COUNT/LIKE 全表扫不去赌' })
      continue
    }
    if (end.rowCount > scanRowCap) {
      skipped.push({ table, reason: `行数 ${end.rowCount} 超过扫描上限 ${scanRowCap}，COUNT/LIKE 全表扫太重` })
      continue
    }

    // 外键空值。NOT NULL 列不可能有空外键，直接跳过；类型对不上的约束说明元数据可疑，也不查
    let fkScanned = 0
    let fkMore = false
    for (const fk of deps.foreignKeys) {
      if (fk.fromTable !== table || fk.toTable === table) continue
      if (pkLower.has(fk.fromColumn.toLowerCase())) continue
      if (fkScanned >= FK_COL_CAP) {
        fkMore = true
        break
      }
      const col = columns.find((c) => c.name.toLowerCase() === fk.fromColumn.toLowerCase())
      if (!col || !col.nullable) continue
      fkScanned++
      const where = `${DIALECTS[deps.dialect].quote(fk.fromColumn)} IS NULL`
      const count = await countRows(deps.live, deps.dialect, table, where)
      if (count == null) {
        skipped.push({ table, reason: `外键空值统计失败（${fk.fromColumn}）` })
        continue
      }
      if (count > 0) {
        findings.push({
          kind: 'orphanFk',
          table,
          pkCol: singlePk,
          count,
          pks: singlePk ? await samplePks(deps.live, deps.dialect, table, singlePk, where) : [],
          detail: `外键 ${fk.fromColumn} 为空（应指向 ${fk.toTable}.${fk.toColumn}，${
            fk.confidence === 'constraint' ? '真实约束' : '命名推断'
          }）——造数没对上父行或业务垃圾`,
        })
      }
    }
    if (fkMore) skipped.push({ table, reason: `外键列超过 ${FK_COL_CAP} 个，只查了前 ${FK_COL_CAP} 个` })

    // test / 测试 前缀：用户自己留的测试行。主键列不扫（LIKE 'test%' 对 id 无意义）
    const likeCols = columns
      .filter((c) => !c.isPrimaryKey && isTextColumn(c.type))
      .slice(0, LIKE_COL_CAP)
    if (likeCols.length) {
      const q = DIALECTS[deps.dialect].quote
      const where = likeCols
        .map((c) => `${q(c.name)} LIKE 'test%' OR ${q(c.name)} LIKE '测试%'`)
        .join(' OR ')
      const count = await countRows(deps.live, deps.dialect, table, where)
      if (count == null) {
        skipped.push({ table, reason: '前缀统计查询失败' })
      } else if (count > 0) {
        findings.push({
          kind: 'testPrefix',
          table,
          pkCol: singlePk,
          count,
          pks: singlePk ? await samplePks(deps.live, deps.dialect, table, singlePk, where) : [],
          detail: `值以 test / 测试 开头（列：${likeCols.map((c) => c.name).join('、')}）`,
        })
      }
    }
  }

  return {
    findings,
    tables: deps.tables,
    skipped,
    // 清理 SQL 检测时就生成好（方言 / 外键只有这里有），报告与执行面板直接引用
    cleanupSql: cleanupSqls(cleanupPlan(findings, deps.foreignKeys), deps.dialect),
    ranAt: Date.now(),
  }
}

async function countRows(live: LiveDbDialect, dialect: GenDialect, table: string, where: string): Promise<number | null> {
  try {
    const grid = await live.query(`SELECT COUNT(*) AS N FROM ${fromOf(table, dialect)} WHERE ${where}`)
    const n = Number(grid.rows[0]?.[0])
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/** 符合条件的行的主键样本（清理 SQL 的 IN 列表）。方言分页套在扫描网既有上限里 */
async function samplePks(
  live: LiveDbDialect,
  dialect: GenDialect,
  table: string,
  pkCol: string,
  where: string,
): Promise<string[]> {
  const spec = DIALECTS[dialect]
  try {
    const grid = await live.query(spec.paginate(`SELECT ${spec.quote(pkCol)} FROM ${fromOf(table, dialect)} WHERE ${where}`))
    const idx = grid.columns.findIndex((c) => c.toLowerCase() === pkCol.toLowerCase())
    if (idx < 0) return []
    return grid.rows
      .map((r) => r[idx] ?? '')
      .filter((v) => v !== '')
      .slice(0, SAMPLE_CAP)
  } catch {
    return []
  }
}

/** 从回归结果汇总各接口认领的插入主键：快照差分里这些行有人认领，不算残留 */
export function claimedInserts(results: CaseRunResult[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const r of results) {
    // CaseRunResult.dbChanges 就是 TableChange[]（DbChangeSummary 只在 runCase 内部用）
    for (const c of r.dbChanges) {
      if (c.op !== 'insert' || c.insertedIds.length === 0) continue
      let set = out.get(c.tableName)
      if (!set) out.set(c.tableName, (set = new Set()))
      for (const id of c.insertedIds) if (id !== '') set.add(id)
    }
  }
  return out
}

export interface ResidueCleanupGroup {
  table: string
  pkCol: string
  pks: string[]
}

/** 候选按表归并（同表多类候选并成一个 pk 集合），返回删除顺序：子表在前、父表在后。
 *  复合主键 / 没样本的候选给不出定位手段，不出 SQL——提示留在 findings 里。 */
export function cleanupPlan(findings: ResidueFinding[], foreignKeys: ForeignKey[]): ResidueCleanupGroup[] {
  const byTable = new Map<string, ResidueCleanupGroup>()
  for (const f of findings) {
    if (!f.pkCol || f.pks.length === 0) continue
    const key = `${f.table}\u0000${f.pkCol.toLowerCase()}`
    const cur = byTable.get(key)
    if (cur) {
      const seen = new Set(cur.pks)
      for (const p of f.pks) {
        if (!seen.has(p)) {
          cur.pks.push(p)
          seen.add(p)
        }
      }
    } else {
      byTable.set(key, { table: f.table, pkCol: f.pkCol, pks: [...f.pks] })
    }
  }
  const groups = [...byTable.values()]
  const rank = new Map(deleteOrder(groups.map((g) => g.table), foreignKeys).map((t, i) => [t, i]))
  return groups.sort(
    (a, b) => (rank.get(a.table) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.table) ?? Number.MAX_SAFE_INTEGER) || a.table.localeCompare(b.table),
  )
}

/** DELETE FROM t WHERE pk IN (…)。组已按子表在前的顺序排好 */
export function cleanupSqls(groups: ResidueCleanupGroup[], dialect: GenDialect): string[] {
  const spec = DIALECTS[dialect]
  return groups.map((g) => {
    const from = g.table.split('.').map(spec.quote).join('.')
    return `DELETE FROM ${from} WHERE ${spec.quote(g.pkCol)} IN (${g.pks.map(lit).join(', ')})`
  })
}

/** 清理目标不是检测时那个库就返回原因，一致返回 null。
 *  检测时没记连接（旧报告）无从比对，放行；两边都有 id 按 id，否则按 label */
export function residueConnMismatch(detected: ResidueConn | undefined, current: ResidueConn | null): string | null {
  if (!current) return '当前没有连库'
  if (!detected) return null
  const same = detected.id && current.id ? detected.id === current.id : detected.label === current.label
  return same ? null : `检测时连的是「${detected.label}」，现在连的是「${current.label}」`
}

/** 删除顺序：子表先删、父表后删（外键约束拦着先删父表的路）。
 *  与造数清理同一铁律：只认 confidence === 'constraint' 的真实约束——命名推断
 *  猜错把父表排到子表后面，DELETE 当场被约束拦住；有环 / 缺失时按名字兜底，
 *  绝不死循环。 */
function deleteOrder(tables: string[], fks: ForeignKey[]): string[] {
  const set = new Set(tables)
  /** t → 还有哪些表引用着 t（t 是它们的外键父表） */
  const refBy = new Map<string, Set<string>>()
  for (const t of tables) refBy.set(t, new Set())
  for (const fk of fks) {
    if (fk.confidence !== 'constraint') continue
    if (fk.fromTable === fk.toTable) continue
    if (!set.has(fk.fromTable) || !set.has(fk.toTable)) continue
    refBy.get(fk.toTable)!.add(fk.fromTable)
  }
  const out: string[] = []
  const rest = new Set(tables)
  while (rest.size) {
    // 没有任何在册表引用的先删（叶子表）；有环 / 引用缺失时按名字兜底
    const ready = [...rest].filter((t) => [...refBy.get(t)!].every((c) => !rest.has(c))).sort()
    if (ready.length === 0) {
      out.push(...[...rest].sort())
      break
    }
    for (const t of ready) {
      rest.delete(t)
      out.push(t)
    }
  }
  return out
}
