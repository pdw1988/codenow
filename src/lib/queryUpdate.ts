/**
 * 连库勾选行按主键更新（PRD 19.4）。
 *
 * 各行同一套 SET 值，WHERE 复用删除那份主键定位。
 * 主键不进 SET。没勾 SET 字段、没 WHERE，都不拼语句。
 * 单格直接编辑（双击网格）走 buildCellUpdate，同一套主键纪律。
 * 插入一行见 PRD 19.7。
 */
import type { Column } from '../types/schema'
import { DIALECTS, type GenDialect } from './sqlgen/dialect'
import { renderValue } from './sqlgen/mockValue'
import { codeMask, splitStatements } from './sqlgen/statements'
import { buildPkWhereFromGrid, hasWherePredicate, quoteRelation } from './queryDelete'

export interface UpdateSet {
  column: Column
  /** 显示值；留空 → NULL（跟 renderValue 同一条） */
  value: string
}

export interface UpdatePlan {
  sql: string
  table: string
  rowCount: number
}

export function settableColumns(columns: Column[]): Column[] {
  return columns.filter((c) => !c.isPrimaryKey)
}

export function gridCellSample(
  columns: string[],
  rows: string[][],
  indices: number[],
  colName: string,
): { kind: 'missing' } | { kind: 'same'; text: string } | { kind: 'mixed' } {
  const i = columns.findIndex((c) => c.toLowerCase() === colName.toLowerCase())
  if (i < 0 || indices.length === 0) return { kind: 'missing' }
  const vals = indices.map((ri) => rows[ri]?.[i] ?? '')
  const first = vals[0]
  if (vals.every((v) => v === first)) return { kind: 'same', text: first }
  return { kind: 'mixed' }
}

function firstBareWord(sql: string): string | null {
  const m = sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s+)*/g, '').match(/^[A-Za-z_]+/)
  return m ? m[0].toUpperCase() : null
}

function hasSetPredicate(sql: string): boolean {
  const mask = codeMask(sql)
  let word = ''
  let after = false
  const flush = () => {
    if (!word) return
    if (word.toUpperCase() === 'SET') after = true
    word = ''
  }
  for (let i = 0; i < sql.length; i++) {
    if (!mask[i]) {
      flush()
      continue
    }
    const c = sql[i]
    if (/[A-Za-z_]/.test(c)) {
      word += c
      continue
    }
    flush()
    if (after && !/\s/.test(c) && c !== ';') return true
  }
  flush()
  return false
}

/** Rust `assert_pk_update` 的前端镜像。真正不执行靠命令侧再验一遍。 */
export function assertPkUpdate(sql: string): string {
  const text = sql.trim()
  if (!text) throw new Error('没有要执行的 UPDATE')
  const stmts = splitStatements(text).filter((s) => firstBareWord(s.text))
  if (stmts.length === 0) throw new Error('没有要执行的 UPDATE')
  if (stmts.length > 1) throw new Error('一次只跑一条语句，不要带第二段')
  const word = firstBareWord(stmts[0].text) ?? ''
  if (word !== 'UPDATE') throw new Error(`这条命令只执行按主键 UPDATE，不跑 ${word || '别的语句'}`)
  if (!hasSetPredicate(stmts[0].text)) throw new Error('拒绝没有 SET 的 UPDATE')
  if (!hasWherePredicate(stmts[0].text)) throw new Error('拒绝没有 WHERE 的 UPDATE')
  return text.replace(/;\s*$/, '')
}

export function buildUpdateFromGrid(args: {
  dialect: GenDialect
  table: string
  pkNames: string[]
  columns: string[]
  rows: string[][]
  indices: number[]
  sets: UpdateSet[]
}): UpdatePlan {
  const table = args.table.trim()
  if (!table) throw new Error('认不出表名。请点左边一张表再改，或 SQL 里写清 FROM 表')
  const usable = args.sets.filter((s) => !s.column.isPrimaryKey)
  if (usable.length === 0) throw new Error('先勾要改的字段。主键只出现在 WHERE，不进 SET')
  const { where, rowCount } = buildPkWhereFromGrid({
    dialect: args.dialect,
    pkNames: args.pkNames,
    columns: args.columns,
    rows: args.rows,
    indices: args.indices,
  })
  const q = DIALECTS[args.dialect].quote
  const setSql = usable
    .map((s) => `${q(s.column.name)} = ${renderValue(s.column, s.value, args.dialect)}`)
    .join(',\n  ')
  const sql = `UPDATE ${quoteRelation(args.dialect, table)}\nSET ${setSql}\nWHERE ${where};`
  if (!sql.toUpperCase().includes('WHERE')) {
    throw new Error('拒绝没有 WHERE 的 UPDATE')
  }
  return { sql: assertPkUpdate(sql) + ';', table, rowCount }
}

/**
 * 网格里双击一个格子直接改（2026-09-27）：一列一个值，WHERE 钉死这一行主键。
 *
 * 与「改」弹窗（勾选行共用一套新值）互补：散修一行就是这里。纪律不放松——
 * 没主键、查询结果里缺主键列、列不在字典里（表达式别名）、主键列本身，都拒。
 * 多表 JOIN 的结果网格不在这里挡：调用方（连库页）认得出单表才允许进入编辑。
 */
export function buildCellUpdate(args: {
  dialect: GenDialect
  table: string
  /** 表字典列（loadColumns 的结果），不是查询结果的列 */
  dictColumns: Column[]
  pkNames: string[]
  gridColumns: string[]
  rows: string[][]
  /** 原始行号（grid.rows 下标） */
  row: number
  colName: string
  value: string
}): UpdatePlan {
  if (!args.table.trim()) {
    throw new Error('认不出表名。请点左边一张表再改，或 SQL 里写清 FROM 表')
  }
  if (args.pkNames.length === 0) {
    throw new Error('这张表没有主键，定位不了单行。请用「改」按钮按勾选行生成 UPDATE')
  }
  const missingPk = args.pkNames.filter(
    (p) => !args.gridColumns.some((g) => g.toLowerCase() === p.toLowerCase()),
  )
  if (missingPk.length > 0) {
    throw new Error(
      `查询结果里没有主键列（${missingPk.join(', ')}），定位不了这一行。SELECT * 或把主键查出来再编辑`,
    )
  }
  const col = args.dictColumns.find((c) => c.name.toLowerCase() === args.colName.toLowerCase())
  if (!col) {
    throw new Error(`列 ${args.colName} 不在表字典里，改不了（可能是表达式别名）`)
  }
  if (col.isPrimaryKey) {
    throw new Error('主键列不支持直接编辑。要改主键请想清楚——那是在改行的身份')
  }
  return buildUpdateFromGrid({
    dialect: args.dialect,
    table: args.table,
    pkNames: args.pkNames,
    columns: args.gridColumns,
    rows: args.rows,
    indices: [args.row],
    sets: [{ column: col, value: args.value }],
  })
}
