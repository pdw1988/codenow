/**
 * PostgreSQL 连库导入的纯映射层。
 *
 * 查询正本在 `src-tauri/src/postgres.rs`（pg_catalog + format_type）。
 * 这里把 format_type 的词收成用户会写的 DDL（character varying → VARCHAR），
 * 再交给共用的 mapMetaColumns / toJavaType——连库和粘贴 DDL 必须同一口径，
 * 否则同一张表两种来源 Java 类型对不上，导出到 MySQL 还会带上 PG 专有词。
 */
import type { Column } from '../types/schema'
import { mapMetaColumns, type MetaColumnRow } from './dbmeta'

const s = (v: string | null | undefined): string => (typeof v === 'string' ? v.trim() : '')

/**
 * `pg_catalog.format_type` → 建表语句里常见的写法。
 *
 * 数组递归剥 `[]`。对不上的用户类型（枚举、域）原样保留，不要硬改成 TEXT。
 */
export function formatPgType(raw: string): string {
  const t = s(raw)
  if (!t) return ''
  if (t.endsWith('[]')) return `${formatPgType(t.slice(0, -2))}[]`

  const varying = /^character varying(?:\((\d+)\))?$/i.exec(t)
  if (varying) return varying[1] ? `VARCHAR(${varying[1]})` : 'VARCHAR'

  const character = /^character(?:\((\d+)\))?$/i.exec(t)
  if (character) return character[1] ? `CHAR(${character[1]})` : 'CHAR'

  const ts = /^timestamp(?:\((\d+)\))?\s+without\s+time\s+zone$/i.exec(t)
  if (ts) return ts[1] ? `TIMESTAMP(${ts[1]})` : 'TIMESTAMP'

  const tstz = /^timestamp(?:\((\d+)\))?\s+with\s+time\s+zone$/i.exec(t)
  if (tstz) return tstz[1] ? `TIMESTAMP(${tstz[1]}) WITH TIME ZONE` : 'TIMESTAMP WITH TIME ZONE'

  const time = /^time(?:\((\d+)\))?\s+without\s+time\s+zone$/i.exec(t)
  if (time) return time[1] ? `TIME(${time[1]})` : 'TIME'

  const timetz = /^time(?:\((\d+)\))?\s+with\s+time\s+zone$/i.exec(t)
  if (timetz) return timetz[1] ? `TIME(${timetz[1]}) WITH TIME ZONE` : 'TIME WITH TIME ZONE'

  const known = new Map<string, string>([
    ['integer', 'INTEGER'],
    ['bigint', 'BIGINT'],
    ['smallint', 'SMALLINT'],
    ['real', 'REAL'],
    ['double precision', 'DOUBLE PRECISION'],
    ['boolean', 'BOOLEAN'],
    ['text', 'TEXT'],
    ['bytea', 'BYTEA'],
    ['json', 'JSON'],
    ['jsonb', 'JSONB'],
    ['uuid', 'UUID'],
    ['date', 'DATE'],
    ['interval', 'INTERVAL'],
    ['money', 'MONEY'],
    ['numeric', 'NUMERIC'],
    ['decimal', 'NUMERIC'],
    ['bit', 'BIT'],
    ['bit varying', 'BIT VARYING'],
  ])
  const lower = t.toLowerCase()
  const exact = known.get(lower)
  if (exact) return exact

  const numeric = /^(numeric|decimal)(\(.+\))$/i.exec(t)
  if (numeric) return `NUMERIC${numeric[2]}`

  const bit = /^(bit(?:\s+varying)?)(\(.+\))$/i.exec(t)
  if (bit) return `${bit[1].toUpperCase().replace(/\s+/, ' ')}${bit[2]}`

  return t
}

export function mapPgColumns(rows: MetaColumnRow[]): Column[] {
  return mapMetaColumns(rows.map((r) => ({ ...r, ctype: formatPgType(s(r.ctype)) || r.ctype })))
}
