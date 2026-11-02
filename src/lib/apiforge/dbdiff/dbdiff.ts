/**
 * 数据库验证引擎的纯函数核心，PRD v0.3 模块 4.3 / 技术方案 §2.3（M2 生死线）。
 *
 * 查库走出句现有 dialect IPC（liveDialect().query），这里只管三件纯计算：
 *  planSnapshot   要跑哪些 SQL（COUNT + 主键倒序抽样，或按主键定点查行）
 *  buildSnapshot  QueryGrid → TableSnapshot
 *  diffTables     前后两份快照 → TableChange
 *
 * 落地约束 1：COUNT 抓不住「行数不变的 UPDATE」，所以快照必须带行样。
 * 全表 SELECT 是禁止的（技术方案「明确不做」），封顶用 query 命令自己的
 * 200 行 cap：主键倒序取最近的 200 行。新插入的行几乎总在这扇窗口里，
 * 老行的 UPDATE 靠请求主键定点查 —— 两招合起来覆盖 MVP 的绝大部分场景。
 */
import type { TableChange, TableSnapshot } from '../types'
import { QUERY_ROW_CAP, type QueryGrid } from '../../sqlReadonly'
import { applyPage, DIALECTS as SQL_DIALECTS, type GenDialect } from '../../sqlgen/dialect'

/** SQL 字符串字面量。单引号翻倍是唯一的安全要求 */
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`

export interface SnapshotPlan {
  countSql: string
  /** 主键列。空 = 无主键，只数行数（note 会写进快照） */
  pkCols: string[]
  /** 主键倒序取最近 QUERY_ROW_CAP 行，无主键时不跑 */
  sampleSql: string | null
  /** 定点查某主键值的整行（UPDATE 接口带 path id 时用） */
  targetedSql: string | null
  targetedPk: string | null
}

/**
 * 生成快照 SQL。targetPkValue 来自请求参数（path 里叫 id / xxxId 的那个），
 * 只在 UPDATE/DELETE 接口且有主键时才有意义；名字对不上主键列就放弃定点查。
 */
export function planSnapshot(
  dialect: GenDialect,
  table: string,
  pkCols: string[],
  targetPkValue?: string,
): SnapshotPlan {
  const q = SQL_DIALECTS[dialect].quote
  const from = table.split('.').map(q).join('.')
  const countSql = `SELECT COUNT(*) AS N FROM ${from}`
  const pk = pkCols[0] // 复合主键 MVP 只按第一列抽样，报告里注明

  if (!pk) {
    return { countSql, pkCols: [], sampleSql: null, targetedSql: null, targetedPk: null }
  }

  // 限行写进 SQL：只靠 query 命令截断时，库会先把整张表排一遍序，大表要好几秒
  const sampleSql = applyPage(dialect, `SELECT * FROM ${from} ORDER BY ${q(pk)} DESC`, {
    offset: 0,
    limit: QUERY_ROW_CAP,
  })
  let targetedSql: string | null = null
  if (targetPkValue !== undefined && targetPkValue !== '') {
    targetedSql = `SELECT * FROM ${from} WHERE ${q(pk)} = ${lit(targetPkValue)}`
  }
  return { countSql, pkCols: [pk], sampleSql, targetedSql, targetedPk: targetPkValue ?? null }
}

/** 真正的行转换：按 pkCols 找主键值当 key，整行存列 → 字符串 */
function rowsByPk(grid: QueryGrid, pkCol: string): Record<string, Record<string, string>> {
  const pkIndex = grid.columns.findIndex((c) => c.toLowerCase() === pkCol.toLowerCase())
  if (pkIndex < 0) return {}
  const out: Record<string, Record<string, string>> = {}
  for (const row of grid.rows) {
    const pkVal = row[pkIndex] ?? ''
    if (pkVal === '') continue
    const rec: Record<string, string> = {}
    grid.columns.forEach((col, i) => {
      rec[col] = row[i] ?? ''
    })
    out[pkVal] = rec
  }
  return out
}

export interface SnapshotInputs {
  countGrid: QueryGrid | null
  sampleGrid: QueryGrid | null
  targetedGrid: QueryGrid | null
  error?: string
}

/** 三份查询结果 → TableSnapshot。count 失败 rowCount=null（不是 0，0 是真数据） */
export function buildSnapshot(
  tableName: string,
  plan: SnapshotPlan,
  inputs: SnapshotInputs,
): TableSnapshot {
  if (inputs.error || !inputs.countGrid) {
    return {
      tableName,
      rowCount: null,
      rows: null,
      pkValues: [],
      hasPk: plan.pkCols.length > 0,
      error: inputs.error ?? 'COUNT 查询失败',
    }
  }
  const rowCount = Number(inputs.countGrid.rows[0]?.[0] ?? NaN)
  if (Number.isNaN(rowCount)) {
    return {
      tableName,
      rowCount: null,
      rows: null,
      pkValues: [],
      hasPk: plan.pkCols.length > 0,
      error: 'COUNT 结果不是数字',
    }
  }
  if (!plan.sampleSql || !inputs.sampleGrid) {
    return { tableName, rowCount, rows: null, pkValues: [], hasPk: false }
  }
  const pk = plan.pkCols[0]
  const rows = rowsByPk(inputs.sampleGrid, pk)
  // 定点行并入：UPDATE 后目标行要是没进 top-200 窗口，这里补上
  if (inputs.targetedGrid && plan.targetedPk) {
    const one = rowsByPk(inputs.targetedGrid, pk)
    Object.assign(rows, one)
  }
  return {
    tableName,
    rowCount,
    rows,
    pkValues: Object.keys(rows),
    hasPk: true,
  }
}

/** 字段级 diff 上限：报告里不能糊一屏 */
const FIELD_DIFF_LIMIT = 10

/**
 * 前后快照 → 变更。判 op 的优先级：insert/delete/ update 任一非零就报对应 op，
 * 混合变更报 'none' 但 rows* 都给（报告展示明细而不是硬归类）。
 * 无主键快照只有行数：行数变了标对应 op，UPDATE 类变更抓不到 —— note 里写明。
 */
export function diffTables(before: TableSnapshot, after: TableSnapshot): TableChange {
  const empty: TableChange = {
    tableName: before.tableName,
    op: 'none',
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsDeleted: 0,
    insertedIds: [],
    deletedIds: [],
    updatedIds: [],
    fieldDiffs: [],
  }

  if (before.error || after.error || before.rowCount === null || after.rowCount === null) {
    return {
      ...empty,
      note: before.error ?? after.error ?? '快照不完整，无法对比',
    }
  }

  const countDelta = after.rowCount - before.rowCount
  if (!before.hasPk || !after.hasPk || !before.rows || !after.rows) {
    return {
      ...empty,
      rowsInserted: Math.max(0, countDelta),
      rowsDeleted: Math.max(0, -countDelta),
      op: countDelta > 0 ? 'insert' : countDelta < 0 ? 'delete' : 'none',
      note:
        countDelta === 0
          ? '表无主键（或未识别），只对比了行数；行数不变的 UPDATE 看不到'
          : `表无主键（或未识别），只对比了行数（${before.rowCount} → ${after.rowCount}）`,
    }
  }

  const beforePks = new Set(before.pkValues)
  const afterPks = new Set(after.pkValues)
  const insertedIds = after.pkValues.filter((k) => !beforePks.has(k))
  const deletedIds = before.pkValues.filter((k) => !afterPks.has(k))

  const fieldDiffs: TableChange['fieldDiffs'] = []
  const updatedIds = new Set<string>()
  for (const pkVal of after.pkValues) {
    if (!beforePks.has(pkVal)) continue
    const bRow = before.rows[pkVal]
    const aRow = after.rows[pkVal]
    if (!bRow || !aRow) continue
    for (const [field, afterVal] of Object.entries(aRow)) {
      const beforeVal = bRow[field]
      if (beforeVal !== afterVal) {
        updatedIds.add(pkVal)
        if (fieldDiffs.length < FIELD_DIFF_LIMIT) {
          fieldDiffs.push({ pk: pkVal, field, before: beforeVal, after: afterVal })
        }
      }
    }
  }

  const rowsInserted = insertedIds.length
  const rowsDeleted = deletedIds.length
  const rowsUpdated = updatedIds.size
  const op: TableChange['op'] =
    rowsInserted > 0 && rowsUpdated === 0 && rowsDeleted === 0
      ? 'insert'
      : rowsDeleted > 0 && rowsUpdated === 0 && rowsInserted === 0
        ? 'delete'
        : rowsUpdated > 0 && rowsInserted === 0 && rowsDeleted === 0
          ? 'update'
          : 'none'

  const note =
    op === 'none' && rowsInserted + rowsDeleted + rowsUpdated === 0
      ? undefined
      : op === 'none'
        ? '混合变更，明细见各行数'
        : undefined

  return {
    tableName: before.tableName,
    op,
    rowsInserted,
    rowsUpdated,
    rowsDeleted,
    insertedIds: insertedIds.slice(0, FIELD_DIFF_LIMIT),
    deletedIds: deletedIds.slice(0, FIELD_DIFF_LIMIT),
    updatedIds: [...updatedIds].slice(0, FIELD_DIFF_LIMIT),
    fieldDiffs,
    note,
  }
}

/** 报告底部「库变更汇总」：按表聚合（技术方案 §2.6 的 dbChangeSummary） */
export function summarizeChanges(
  changes: TableChange[][],
): { tableName: string; totalInserted: number; totalUpdated: number; totalDeleted: number }[] {
  const acc = new Map<string, { tableName: string; totalInserted: number; totalUpdated: number; totalDeleted: number }>()
  for (const group of changes) {
    for (const c of group) {
      const row = acc.get(c.tableName) ?? {
        tableName: c.tableName,
        totalInserted: 0,
        totalUpdated: 0,
        totalDeleted: 0,
      }
      row.totalInserted += c.rowsInserted
      row.totalUpdated += c.rowsUpdated
      row.totalDeleted += c.rowsDeleted
      acc.set(c.tableName, row)
    }
  }
  return [...acc.values()].sort((a, b) => a.tableName.localeCompare(b.tableName))
}
