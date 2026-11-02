/**
 * 连库勾选行按主键删除（PRD 19.3）。
 *
 * 只拼 `DELETE … WHERE 主键`，绝不输出没有 WHERE 的语句。
 * WHERE 片段给勾选 UPDATE（`queryUpdate.ts`）复用，避免两套主键定位。
 * INSERT 不在本模块。
 */
import type { Column } from '../types/schema'
import { DIALECTS, type GenDialect } from './sqlgen/dialect'
import { codeMask, splitStatements } from './sqlgen/statements'
import { gridLiteral } from './queryGrid'

export interface DeletePlan {
  sql: string
  table: string
  rowCount: number
}

export function quoteRelation(dialect: GenDialect, table: string): string {
  const q = DIALECTS[dialect].quote
  return table
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean)
    .map(q)
    .join('.')
}

export function pkColumnNames(columns: Column[]): string[] {
  return columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
}

/** 网格列名对主键：不区分大小写。缺一列就不能删。 */
export function matchPkColumns(
  gridColumns: string[],
  pkNames: string[],
): { ok: true; indexes: number[] } | { ok: false; reason: string } {
  if (pkNames.length === 0) {
    return { ok: false, reason: '这张表没有主键，不能按主键定位。不会生成不带 WHERE 的语句' }
  }
  const indexes: number[] = []
  for (const pk of pkNames) {
    const i = gridColumns.findIndex((c) => c.toLowerCase() === pk.toLowerCase())
    if (i < 0) {
      return {
        ok: false,
        reason: `结果里没有主键列 ${pk}，不能按主键定位。请 SELECT 带上主键，或点左边的表再查`,
      }
    }
    indexes.push(i)
  }
  return { ok: true, indexes }
}

function firstBareWord(sql: string): string | null {
  const m = sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s+)*/g, '').match(/^[A-Za-z_]+/)
  return m ? m[0].toUpperCase() : null
}

export function hasWherePredicate(sql: string): boolean {
  const mask = codeMask(sql)
  let word = ''
  let after = false
  const flush = () => {
    if (!word) return
    if (word.toUpperCase() === 'WHERE') after = true
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

/** Rust `assert_pk_delete` 的前端镜像。真正不执行靠命令侧再验一遍。 */
export function assertPkDelete(sql: string): string {
  const text = sql.trim()
  if (!text) throw new Error('没有要执行的 DELETE')
  const stmts = splitStatements(text).filter((s) => firstBareWord(s.text))
  if (stmts.length === 0) throw new Error('没有要执行的 DELETE')
  if (stmts.length > 1) throw new Error('一次只跑一条语句，不要带第二段')
  const word = firstBareWord(stmts[0].text) ?? ''
  if (word !== 'DELETE') throw new Error(`这条命令只执行按主键 DELETE，不跑 ${word || '别的语句'}`)
  if (!hasWherePredicate(stmts[0].text)) throw new Error('拒绝没有 WHERE 的 DELETE')
  return text.replace(/;\s*$/, '')
}

/** 按勾选行拼主键 WHERE。没有 WHERE 的片段不会从这里出去。 */
export function buildPkWhereFromGrid(args: {
  dialect: GenDialect
  pkNames: string[]
  columns: string[]
  rows: string[][]
  indices: number[]
}): { where: string; rowCount: number } {
  if (args.indices.length === 0) throw new Error('先勾选行')
  const matched = matchPkColumns(args.columns, args.pkNames)
  if (!matched.ok) throw new Error(matched.reason)

  const q = DIALECTS[args.dialect].quote
  const seen = new Set<string>()
  const clauses: string[] = []
  for (const i of args.indices) {
    const parts: string[] = []
    const key: string[] = []
    for (const col of matched.indexes) {
      const raw = args.rows[i]?.[col] ?? ''
      if (raw.trim() === '') {
        throw new Error(`第 ${i + 1} 行主键是空的，没法按主键定位`)
      }
      const name = args.columns[col]
      parts.push(`${q(name)} = ${gridLiteral(raw, args.dialect)}`)
      key.push(`${name.toLowerCase()}=${raw}`)
    }
    const sig = key.join('\0')
    if (seen.has(sig)) continue
    seen.add(sig)
    clauses.push(parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`)
  }
  if (clauses.length === 0) throw new Error('勾选行里没有能按主键定位的记录')
  return { where: clauses.join('\n  OR '), rowCount: clauses.length }
}

export function buildDeleteFromGrid(args: {
  dialect: GenDialect
  table: string
  pkNames: string[]
  columns: string[]
  rows: string[][]
  indices: number[]
}): DeletePlan {
  const table = args.table.trim()
  if (!table) throw new Error('认不出表名。请点左边一张表再删，或 SQL 里写清 FROM 表')
  const { where, rowCount } = buildPkWhereFromGrid(args)
  const sql = `DELETE FROM ${quoteRelation(args.dialect, table)}\nWHERE ${where};`
  if (!sql.toUpperCase().includes('WHERE')) {
    throw new Error('拒绝没有 WHERE 的 DELETE')
  }
  return { sql: assertPkDelete(sql) + ';', table, rowCount }
}
