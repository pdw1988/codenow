/**
 * 连库插入一行（PRD 19.7）。
 *
 * 不拿「复制 INSERT」在本表执行——带原主键几乎必撞唯一。
 * 自增列默认不进语句，让库编号。不勾 = 省略（库默认）；勾了留空 = NULL。
 * SQL 框仍然不能跑 INSERT。INSERT … SELECT 拒。
 */
import type { Column } from '../types/schema'
import { DIALECTS, type GenDialect } from './sqlgen/dialect'
import { renderValue } from './sqlgen/mockValue'
import { codeMask, splitStatements } from './sqlgen/statements'
import { quoteRelation } from './queryDelete'

export interface InsertSet {
  column: Column
  /** 显示值；留空 → NULL（跟 renderValue 同一条） */
  value: string
}

export interface InsertPlan {
  sql: string
  table: string
}

/** 自增列默认不勾：写进去会覆盖库的编号。 */
export function defaultInsertOn(column: Column): boolean {
  return !column.isAutoIncrement
}

/** DATE / DATETIME / TIMESTAMP。LocalTime 不是日期，不套 SYSDATE。 */
export function isInsertDateColumn(column: Column): boolean {
  if (column.javaType === 'java.time.LocalDateTime' || column.javaType === 'java.time.LocalDate') {
    return true
  }
  return /^(date|datetime|timestamp)\b/i.test(column.type)
}

/**
 * 日期列默认填方言的「现在」（Oracle = SYSDATE，MySQL/PG = NOW()）。
 * 不从勾选行抄旧时间——抄进去几乎总是错的，还容易撞唯一。
 * 其它字段交给调用方预填，这里给空串。
 */
export function defaultInsertValue(column: Column, dialect: GenDialect): string {
  if (isInsertDateColumn(column)) return DIALECTS[dialect].now
  return ''
}

export function insertColumnNote(column: Column): string {
  const bits: string[] = []
  if (column.isAutoIncrement) bits.push('自增')
  else if (column.isPrimaryKey) bits.push('主键')
  if (!column.nullable && !column.isAutoIncrement) bits.push('必填')
  if (column.defaultValue) bits.push(`默认 ${column.defaultValue}`)
  return bits.join(' · ')
}

function firstBareWord(sql: string): string | null {
  const m = sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s+)*/g, '').match(/^[A-Za-z_]+/)
  return m ? m[0].toUpperCase() : null
}

function hasBareWord(sql: string, keyword: string): boolean {
  const want = keyword.toUpperCase()
  const mask = codeMask(sql)
  let word = ''
  const flush = () => {
    if (!word) return false
    const hit = word.toUpperCase() === want
    word = ''
    return hit
  }
  for (let i = 0; i < sql.length; i++) {
    if (!mask[i]) {
      if (flush()) return true
      continue
    }
    const c = sql[i]
    if (/[A-Za-z_]/.test(c)) {
      word += c
      continue
    }
    if (flush()) return true
  }
  return flush()
}

function hasKeywordThenToken(sql: string, keyword: string): boolean {
  const want = keyword.toUpperCase()
  const mask = codeMask(sql)
  let word = ''
  let after = false
  const flush = () => {
    if (!word) return
    if (word.toUpperCase() === want) after = true
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

/** Rust `assert_row_insert` 的前端镜像。真正不执行靠命令侧再验一遍。 */
export function assertRowInsert(sql: string): string {
  const text = sql.trim()
  if (!text) throw new Error('没有要执行的 INSERT')
  const stmts = splitStatements(text).filter((s) => firstBareWord(s.text))
  if (stmts.length === 0) throw new Error('没有要执行的 INSERT')
  if (stmts.length > 1) throw new Error('一次只跑一条语句，不要带第二段')
  const word = firstBareWord(stmts[0].text) ?? ''
  if (word !== 'INSERT') throw new Error(`这条命令只执行 INSERT，不跑 ${word || '别的语句'}`)
  if (!hasKeywordThenToken(stmts[0].text, 'INTO')) throw new Error('拒绝没有 INTO 的 INSERT')
  if (!hasKeywordThenToken(stmts[0].text, 'VALUES')) {
    throw new Error('这条命令只插入 VALUES，不跑 INSERT … SELECT')
  }
  if (hasBareWord(stmts[0].text, 'SELECT')) {
    throw new Error('这条命令只插入 VALUES，不跑 INSERT … SELECT')
  }
  return text.replace(/;\s*$/, '')
}

export function buildInsertRow(args: {
  dialect: GenDialect
  table: string
  sets: InsertSet[]
}): InsertPlan {
  const table = args.table.trim()
  if (!table) throw new Error('认不出表名。请点左边一张表再插，或 SQL 里写清 FROM 表')
  if (args.sets.length === 0) {
    throw new Error('先勾要写入的字段。自增列请保持不勾，让库自己编号')
  }
  const q = DIALECTS[args.dialect].quote
  const cols = args.sets.map((s) => q(s.column.name)).join(', ')
  const vals = args.sets
    .map((s) => renderValue(s.column, s.value, args.dialect))
    .join(', ')
  const sql = `INSERT INTO ${quoteRelation(args.dialect, table)} (${cols})\nVALUES (${vals});`
  return { sql: assertRowInsert(sql) + ';', table }
}
