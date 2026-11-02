/**
 * 选表下拉的选项和匹配。纯函数，给 TablePick / 单测用。
 *
 * 原生 select 选项一多只能靠系统滚动条翻。这里把表名、注释、Java 类名、
 * 字段名都放进可搜范围，空查询时最近用过的排前面。
 */
import type { TableInfo } from '../types/schema'
import { textMatchesQuery } from './search'

export interface TablePickOption {
  value: string
  label: string
  hay?: string
}

export function tableOptions(
  tables: TableInfo[],
  opts: { empty?: string; recent?: readonly string[] } = {},
): TablePickOption[] {
  const seen = new Set<string>()
  const ordered: TableInfo[] = []
  for (const name of opts.recent ?? []) {
    const t = tables.find((x) => x.name === name)
    if (t && !seen.has(t.name)) {
      ordered.push(t)
      seen.add(t.name)
    }
  }
  const rest = tables.filter((t) => !seen.has(t.name)).sort((a, b) => a.name.localeCompare(b.name))
  const rows: TablePickOption[] = [...ordered, ...rest].map((t) => ({
    value: t.name,
    label: t.comment ? `${t.name}  —  ${t.comment}` : t.name,
    hay: [t.javaClass, ...t.columns.map((c) => c.name)].filter(Boolean).join(' '),
  }))
  return opts.empty !== undefined ? [{ value: '', label: opts.empty }, ...rows] : rows
}

export function optionMatches(o: TablePickOption, query: string): boolean {
  if (!o.value) return false
  return (
    textMatchesQuery(o.value, query) ||
    textMatchesQuery(o.label, query) ||
    textMatchesQuery(o.hay, query)
  )
}
