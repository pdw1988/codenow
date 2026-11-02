/**
 * 实体/库表结构对账（PRD v0.6 模块 4.15）——MyBatis-Plus / JPA 实体字段
 * 对出句表结构缓存做 diff，出 schema drift 报告。
 *
 * 三类漂移：
 *  - codeOnly     代码有映射列，库里没有 —— 字段加了没执行 DDL，或对错表
 *  - dbOnly       库里有列，代码没映射 —— 多半是库里新加的列实体没跟上
 *  - typeMismatch 两边都有但类型家族对不上 —— Long 对 VARCHAR 这类，运行时才炸
 *
 * 纯函数：实体来自扫描（EntityRegistry），表结构来自出句缓存（DDL 导入 /
 * 连库导入），两个来源谁缺了都如实报，不猜。
 */

import type { Column, TableInfo } from '../../types/schema'
import type { EntityInfo } from './types'

export type DriftKind = 'codeOnly' | 'dbOnly' | 'typeMismatch'

export interface DriftRow {
  kind: DriftKind
  table: string
  className: string
  /** codeOnly / typeMismatch = Java 字段名；dbOnly = 库列名 */
  field: string
  /** 库列名（dbOnly）或推断出的列名（其他） */
  column: string
  /** 人话：两边的类型各是什么、为什么算漂移 */
  detail: string
}

export interface EntityDiffResult {
  rows: DriftRow[]
  /** 对上账的实体表（扫描实体 ↔ 库缓存都存在） */
  matched: string[]
  /** 实体指向、但表结构缓存里没有的表 */
  missingTables: { table: string; className: string }[]
  /** 缓存里的表、扫描没有任何实体指过去 —— 提示性质，不算漂移 */
  unmappedTables: string[]
}

/** Java 类型 → 类型家族。认不出的给 unknown：对账两侧有一侧 unknown 就不比 */
function javaFamily(t: string): string {
  const s = t.trim()
  if (/^(Long|Integer|Short|Byte|BigInteger|long|int|short|byte|BigDecimal|Double|Float|double|float)$/.test(s)) {
    return 'number'
  }
  if (/^(String|char|Character)$/.test(s)) return 'string'
  if (/(Date|Time|Timestamp|Instant)$/.test(s)) return 'datetime'
  if (/^(Boolean|boolean)$/.test(s)) return 'boolean'
  return 'unknown'
}

/** 库列类型 → 类型家族（类型原文如 VARCHAR2(50)、NUMBER(20)、TIMESTAMP）。 */
function dbFamily(type: string): string {
  const t = type.toUpperCase()
  if (/NUMBER|INT|BIGINT|SMALLINT|DECIMAL|NUMERIC|FLOAT|DOUBLE|BIT/.test(t)) return 'number'
  if (/CHAR|TEXT|CLOB|STRING|GUID|RAW/.test(t)) return 'string'
  if (/DATE|TIME|TIMESTAMP/.test(t)) return 'datetime'
  if (/BOOL|BOOLEAN/.test(t)) return 'boolean'
  return 'unknown'
}

export function diffEntities(entities: EntityInfo[], tables: TableInfo[]): EntityDiffResult {
  const rows: DriftRow[] = []
  const matched: string[] = []
  const missingTables: { table: string; className: string }[] = []
  /** 库列 → 是否被某实体映射（全部实体并集，dbOnly 要跨实体判断） */
  const mappedByTable = new Map<string, Set<string>>()
  /** table(lower) → { table 原名, columns } */
  const tableIndex = new Map<string, { info: TableInfo; byLower: Map<string, Column> }>()
  for (const t of tables) {
    const byLower = new Map<string, Column>()
    for (const c of t.columns) byLower.set(c.name.toLowerCase(), c)
    tableIndex.set(t.name.toLowerCase(), { info: t, byLower })
  }

  for (const e of entities) {
    const hit = tableIndex.get(e.table.toLowerCase())
    if (!hit) {
      missingTables.push({ table: e.table, className: e.className })
      continue
    }
    matched.push(hit.info.name)
    const mapped = mappedByTable.get(hit.info.name.toLowerCase()) ?? new Set<string>()
    for (const f of e.fields) {
      const col = f.column.toLowerCase()
      mapped.add(col)
      const dbCol = hit.byLower.get(col)
      if (!dbCol) {
        rows.push({
          kind: 'codeOnly',
          table: hit.info.name,
          className: e.className,
          field: f.name,
          column: f.column,
          detail: `实体有字段 ${f.name}（映射列 ${f.column}，${f.javaType}），表结构缓存里没有这一列——字段加了没执行 DDL，或列名映射写错`,
        })
        continue
      }
      const jf = javaFamily(f.javaType)
      const df = dbFamily(dbCol.type)
      if (jf !== 'unknown' && df !== 'unknown' && jf !== df) {
        rows.push({
          kind: 'typeMismatch',
          table: hit.info.name,
          className: e.className,
          field: f.name,
          column: f.column,
          detail: `${f.name}: 实体 ${f.javaType}（${jf}）vs 库列 ${dbCol.name} ${dbCol.type}（${df}）——类型家族对不上，写入/读出时才炸最难受`,
        })
      }
    }
    mappedByTable.set(hit.info.name.toLowerCase(), mapped)
  }

  // dbOnly：对上账的表里，库列减去全部实体映射列（跨实体并集——同表多实体时
  // 只要有人映射了就不算孤儿列）
  for (const [lower, { info, byLower }] of tableIndex) {
    const mapped = mappedByTable.get(lower)
    if (!mapped) continue // 这张表没有实体对账，unmappedTables 统计
    for (const [colLower, col] of byLower) {
      if (!mapped.has(colLower)) {
        rows.push({
          kind: 'dbOnly',
          table: info.name,
          className: mappedEntityClass(entities, lower),
          field: col.name,
          column: col.name,
          detail: `库列 ${col.name}（${col.type}）没有任何实体字段映射——库里新加的列实体没跟上，或这列归别的写入方管`,
        })
      }
    }
  }

  const unmappedTables = tables
    .filter((t) => !entities.some((e) => e.table.toLowerCase() === t.name.toLowerCase()))
    .map((t) => t.name)
  return { rows, matched, missingTables, unmappedTables }
}

/** 找到映射这张表的实体类名（dbOnly 行展示用；多实体取第一个，够定位了） */
function mappedEntityClass(entities: EntityInfo[], tableLower: string): string {
  const e = entities.find((x) => x.table.toLowerCase() === tableLower)
  return e?.className ?? ''
}
