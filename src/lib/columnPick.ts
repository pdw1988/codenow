/**
 * 查询字段勾选：默认只露关键列，其余「加载更多」；可选 COUNT(*) / COUNT(主键)。
 *
 * 合成记号不会撞真列名（双下划线前缀）。生成 SQL / 连库预览共用这份解析。
 */
import { columnUiTier, sortColumnsForUi, type ColumnOrderInput } from './columnOrder'
import { DIALECTS, type GenDialect } from './sqlgen/dialect'

/** COUNT(*) —— 勾选进 SELECT，别名 cnt（跟分组查询同一套） */
export const COUNT_STAR = '__count_star__'
/** COUNT(主键列) —— 没有主键时界面不画这一项 */
export const COUNT_PK = '__count_pk__'

export function isAggPickToken(name: string): boolean {
  return name === COUNT_STAR || name === COUNT_PK
}

/** 默认露出来的档：主键 / 唯一键 / 普通索引 / 日期（tier 0~3） */
export function isDefaultVisibleColumn(c: ColumnOrderInput): boolean {
  return columnUiTier(c) <= 3
}

export function splitPickColumns<T extends ColumnOrderInput>(cols: readonly T[]): {
  shown: T[]
  more: T[]
} {
  const sorted = sortColumnsForUi(cols)
  /*
   * 连库若没打出主键标（权限/字典查失败），id 会掉进「加载更多」，
   * 用户只看见 COUNT(*)，以为主键字段没了。认不出主键时先别藏。
   */
  if (!sorted.some((c) => c.isPrimaryKey)) {
    return { shown: sorted, more: [] }
  }
  const show = (c: ColumnOrderInput) =>
    isDefaultVisibleColumn(c) || !!c.isAutoIncrement
  return {
    shown: sorted.filter(show),
    more: sorted.filter((c) => !show(c)),
  }
}

/**
 * 「未动」时默认勾哪些列：只勾默认露出来的那批。
 * 「加载更多」里没展开的列默认不勾 —— 看不见的列不该悄悄进 SELECT。
 * 界面勾选和生成 SQL 必须调同一个，否则两边一定会跑偏。
 */
export function defaultPickNames<T extends ColumnOrderInput>(cols: readonly T[]): string[] {
  return splitPickColumns(cols).shown.map((c) => c.name)
}

/** 主键按 UI 字母序；复合主键取第一个给 COUNT(主键) */
export function primaryKeyForCount<T extends { name: string; isPrimaryKey: boolean }>(
  cols: readonly T[],
): T | null {
  const pks = sortColumnsForUi(
    cols.filter((c) => c.isPrimaryKey).map((c) => ({ ...c, isPrimaryKey: true })),
  )
  return pks[0] ?? null
}

export function countPkLabel(pkName: string): string {
  return `COUNT(${pkName})`
}

export function realNamesOf(selected: readonly string[]): string[] {
  return selected.filter((n) => !isAggPickToken(n))
}

export function pickAggFlags(selected: readonly string[] | null | undefined): {
  star: boolean
  pk: boolean
} {
  if (!selected) return { star: false, pk: false }
  return {
    star: selected.includes(COUNT_STAR),
    pk: selected.includes(COUNT_PK),
  }
}

/**
 * 勾选里有哪些真列。null = 未动 = 全选真列（不含聚合记号）。
 */
export function resolvedRealNames(
  selected: string[] | null | undefined,
  all: readonly { name: string }[],
): string[] {
  if (selected == null) return all.map((c) => c.name)
  return realNamesOf(selected)
}

/**
 * 从 null（全选）勾上聚合时：收成「只勾这个聚合」，避免 GROUP BY 全表列。
 * 已有显式勾选时只追加记号。
 */
export function withAggToggle(
  selected: string[] | null,
  allNames: readonly string[],
  token: typeof COUNT_STAR | typeof COUNT_PK,
  on: boolean,
): string[] {
  if (!on) {
    const cur = selected ?? allNames
    return cur.filter((n) => n !== token)
  }
  if (selected == null) return [token]
  return selected.includes(token) ? selected : [...selected, token]
}

export type SelectExpr = { text: string; comment?: string }

/**
 * 把勾选解析成 SELECT 表达式。
 * - 无聚合：按真列名（调用方自己决定要不要退化成 *）
 * - 有聚合 + 无真列：只有 COUNT
 * - 有聚合 + 有真列：真列 + COUNT，调用方再 GROUP BY 真列
 */
export function selectExprsFromPick(
  dialect: GenDialect,
  selected: readonly string[],
  all: readonly { name: string; comment?: string; isPrimaryKey: boolean }[],
): { exprs: SelectExpr[]; groupBy: string[]; onlyAgg: boolean } {
  const q = DIALECTS[dialect].quote
  const agg = pickAggFlags(selected)
  const real = realNamesOf(selected)
  const byName = new Map(all.map((c) => [c.name, c]))
  const cols = real.map((n) => byName.get(n)).filter(Boolean) as {
    name: string
    comment?: string
  }[]

  const exprs: SelectExpr[] = cols.map((c) => ({
    text: q(c.name),
    comment: c.comment,
  }))

  if (agg.star) {
    exprs.push({ text: `COUNT(*) AS ${q('cnt')}`, comment: '条数' })
  }
  if (agg.pk) {
    const pk = primaryKeyForCount(all)
    if (pk) {
      exprs.push({
        text: `COUNT(${q(pk.name)}) AS ${q(`${pk.name}_cnt`)}`,
        comment: countPkLabel(pk.name),
      })
    }
  }

  const onlyAgg = exprs.length > 0 && cols.length === 0 && (agg.star || agg.pk)
  return {
    exprs,
    groupBy: agg.star || agg.pk ? cols.map((c) => c.name) : [],
    onlyAgg,
  }
}
