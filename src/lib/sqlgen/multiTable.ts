/**
 * 多表关联查询生成，PRD 4.5。
 *
 * 三套模板对应开发中三种真实需求：列表页（分页+条件）、详情页（按主表ID）、
 * 报表（聚合统计）。不做通用查询构造器——那等于重写一个 ORM。
 */
import type { Dialect, ForeignKey, JoinType, TableInfo } from '../../types/schema'
import { sortColumnsForUi } from '../columnOrder'
import { defaultPickNames } from '../columnPick'
import { applyPage, DIALECTS } from './dialect'
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_PK_VALUE,
  GROUP_COUNT_ALIAS,
  cmpOpOf,
  defaultConditionValue,
  renderCondition,
  type CmpOp,
} from './executable'
import { planValues, type ValueMap } from './mockValue'

// JoinType 的定义搬到了 types/schema.ts（模板类型也要用），这里保留导出不改调用方
export type { JoinType }

/** `表.列` → 两端。表名可能带 schema（a.b.c 取最后一个点）。 */
export function splitTableCol(key: string): { table: string; column: string } | null {
  const k = key.trim()
  const i = k.lastIndexOf('.')
  if (i <= 0 || i >= k.length - 1) return null
  return { table: k.slice(0, i), column: k.slice(i + 1) }
}

export function tableColKey(table: string, column: string): string {
  return `${table}.${column}`
}

/**
 * 列表默认条件：主表主键（UI 排序口径）。没有主键则空（调用方走 WHERE 1=1）。
 */
export function defaultMultiConditions(mainTable: TableInfo): string[] {
  return sortColumnsForUi(mainTable.columns.filter((c) => c.isPrimaryKey)).map((c) =>
    tableColKey(mainTable.name, c.name),
  )
}

/**
 * 解析当前要进 WHERE 的 `表.列` 列表。
 * 按 JOIN 表顺序，表内再按主键 → 唯一键 → 日期 → 字母排——跟条件勾选清单一致，
 * 不跟用户点击先后走，避免同一配置两次 diff 不开。
 */
export function resolveMultiConditions(
  mainTable: TableInfo,
  joined: string[],
  tables: Map<string, TableInfo>,
  selected: string[] | null | undefined,
): string[] {
  const keys =
    selected === undefined || selected === null ? defaultMultiConditions(mainTable) : selected
  const wanted = new Set(keys)
  const out: string[] = []
  for (const tableName of joined) {
    const table = tables.get(tableName)
    if (!table) continue
    const cols = sortColumnsForUi(
      table.columns.filter((c) => wanted.has(tableColKey(tableName, c.name))),
    )
    for (const c of cols) out.push(tableColKey(tableName, c.name))
  }
  return out
}

/** 一条确认过的关联，PRD 4.3 面板的产出 */
export interface JoinLink {
  fk: ForeignKey
  joinType: JoinType
  /** 是否参与生成 */
  enabled: boolean
}

/** 关联的稳定标识，用于 React key / 去重 / 比对 */
export const fkKey = (fk: ForeignKey) =>
  `${fk.fromTable}.${fk.fromColumn}->${fk.toTable}.${fk.toColumn}`

export interface MultiTableOptions {
  dialect: Dialect
  mainTable: TableInfo
  /** 参与 JOIN 的表，按 name 索引 */
  tables: Map<string, TableInfo>
  links: JoinLink[]
  withHeader: boolean
  /**
   * 要进 SELECT 的列。null / 缺省 / 表内 null = 默认露出列（跟单表 SELECT 一致）；
   * [] = 该表明确不选；有名单才出那些列。
   * 全部清空时降级为主表主键 + JOIN 两端字段，避免空 SELECT。
   * 分组时列表查询改成「分组列 + COUNT(*)」，这份勾选对列表暂不生效。
   */
  selectedColumns?: Record<string, string[] | null> | null
  /** 列表查询条数。缺省 20。写成字面量，方便复制就跑。 */
  pageSize?: number
  /**
   * 列表排序。`column` 为 `表.列`（跟 aliasByKey 的键同形），或分组时的 `cnt`。
   * 空 / 认不出时：有分组排 cnt，否则主表主键 DESC。
   */
  orderBy?: { column: string; dir: 'asc' | 'desc' } | null
  /**
   * 列表分组。`表.列`；空 = 不分组。
   * 分组后 SELECT 变为该列 + COUNT(*) AS cnt，查询列勾选对列表不生效。
   */
  groupBy?: string | null
  /**
   * 列表 WHERE 条件列，键为 `表.列`。
   * null / 缺省 = 主表主键（跟单表「条件字段」默认一致）；
   * [] = 明确无条件（只留 WHERE 1=1 + 分页）；
   * 有名单则按 conditionStyle 拼谓词。
   */
  selectConditions?: string[] | null
  /**
   * WHERE 写法。缺省 `placeholder`（MyBatis `#{}`）；
   * `literal` = 跟单表可执行一样，写进默认值 / 手改值 + 比较符。
   */
  conditionStyle?: 'placeholder' | 'literal'
  /** 条件值，键 `表.列`。只含手改；没改的走 defaultConditionValue */
  selectValues?: Record<string, string>
  /** 比较符，键 `表.列`。缺省等于 */
  cmpOps?: Record<string, CmpOp>
  /** 造默认条件值用的种子，跟单表 mockValue 同一套 */
  seed?: number
}

const RULE = '='.repeat(60)

/**
 * 表名 → 别名。取首字母，冲突时加序号。
 * 别名比全表名短，多表查询里可读性高得多。
 */
export function buildAliases(tableNames: string[]): Map<string, string> {
  const aliases = new Map<string, string>()
  const used = new Set<string>()

  for (const name of tableNames) {
    // user_role → ur，order → o
    const initials = name.split('_').map((p) => p[0]).join('').toLowerCase()
    let alias = initials || 't'
    let n = 1
    while (used.has(alias)) alias = `${initials}${++n}`
    used.add(alias)
    aliases.set(name, alias)
  }

  return aliases
}

/**
 * 从主表出发做广度遍历，把关联排成 JOIN 顺序。
 *
 * 必须按拓扑顺序输出：JOIN b ON b.x = a.y 里的 a 得先出现在 FROM/JOIN 链上，
 * 否则 SQL 直接报 unknown alias。PRD 没提这点，但不做就生成不出能跑的语句。
 */
function orderJoins(mainTable: string, links: JoinLink[]): JoinLink[] {
  const active = links.filter((l) => l.enabled)
  const reached = new Set([mainTable])
  const ordered: JoinLink[] = []
  const pending = [...active]

  let progressed = true
  while (progressed && pending.length) {
    progressed = false
    for (let i = 0; i < pending.length; i++) {
      const link = pending[i]
      const { fromTable, toTable } = link.fk
      // 只要有一端已经在链上，另一端就能接进来
      if (reached.has(fromTable) || reached.has(toTable)) {
        reached.add(fromTable)
        reached.add(toTable)
        ordered.push(link)
        pending.splice(i, 1)
        progressed = true
        break
      }
    }
  }

  // 剩下的是跟主表连不通的关联（用户手动加了孤立关联），丢掉而不是硬拼
  return ordered
}

/** 生成 FROM + JOIN 链 */
function buildFromClause(
  options: MultiTableOptions,
  aliases: Map<string, string>,
): { sql: string; joined: string[]; dropped: JoinLink[] } {
  const { mainTable, links, dialect } = options
  const q = DIALECTS[dialect].quote

  const ordered = orderJoins(mainTable.name, links)
  const dropped = links.filter((l) => l.enabled && !ordered.includes(l))

  const lines = [`FROM ${q(mainTable.name)} ${aliases.get(mainTable.name)}`]
  const joined = [mainTable.name]

  for (const link of ordered) {
    const { fromTable, fromColumn, toTable, toColumn } = link.fk
    // 已经在链上的那一端是"已知"表，另一端才是这次要 JOIN 进来的
    const newTable = joined.includes(fromTable) ? toTable : fromTable
    if (joined.includes(newTable)) continue

    const a1 = aliases.get(fromTable)
    const a2 = aliases.get(toTable)
    lines.push(
      `${link.joinType} JOIN ${q(newTable)} ${aliases.get(newTable)}` +
        ` ON ${a1}.${q(fromColumn)} = ${a2}.${q(toColumn)}`,
    )
    joined.push(newTable)
  }

  return { sql: lines.join('\n'), joined, dropped }
}

/**
 * 输出字段列表。跨表同名字段（两张表都有 id / status / create_time）必须起别名，
 * 否则 ResultSet 里后面的会覆盖前面的——这是多表查询最常见的坑。
 *
 * 勾选过滤后若一行都没有，降级为主表主键 + 当前 JOIN 用到的列。
 */
function buildSelectFields(
  joined: string[],
  options: MultiTableOptions,
  aliases: Map<string, string>,
): { lines: string[]; aliasByKey: Map<string, string> } {
  const { tables, dialect, selectedColumns } = options
  const q = DIALECTS[dialect].quote

  const pickedByTable = new Map<string, TableInfo['columns']>()
  for (const tableName of joined) {
    const table = tables.get(tableName)
    if (!table) continue
    pickedByTable.set(tableName, pickTableColumns(table, selectedColumns))
  }

  let total = 0
  for (const cols of pickedByTable.values()) total += cols.length
  if (total === 0) {
    // 全不选：至少留主键和 JOIN 键，不然 SELECT 是空的
    for (const tableName of joined) {
      const table = tables.get(tableName)
      if (!table) continue
      const keep = new Set<string>()
      if (tableName === options.mainTable.name) {
        for (const c of table.columns) if (c.isPrimaryKey) keep.add(c.name)
      }
      for (const link of options.links) {
        if (!link.enabled) continue
        if (link.fk.fromTable === tableName) keep.add(link.fk.fromColumn)
        if (link.fk.toTable === tableName) keep.add(link.fk.toColumn)
      }
      pickedByTable.set(
        tableName,
        table.columns.filter((c) => keep.has(c.name)),
      )
    }
  }

  // 别名冲突只看实际会输出的列，没勾的不算
  const nameCount = new Map<string, number>()
  for (const cols of pickedByTable.values()) {
    for (const col of cols) {
      nameCount.set(col.name, (nameCount.get(col.name) ?? 0) + 1)
    }
  }

  const lines: string[] = []
  const aliasByKey = new Map<string, string>()
  const used = new Set<string>()

  for (const tableName of joined) {
    const cols = pickedByTable.get(tableName) ?? []
    const a = aliases.get(tableName)!

    for (const col of cols) {
      // 前缀用表别名（u_id）而不是表名（user_id）：后者会跟 order.user_id
      // 这个真实存在的字段撞车，而「主表 id + 从表 xxx_id」恰好是最常见的表结构。
      let outName = (nameCount.get(col.name) ?? 0) > 1 ? `${a}_${col.name}` : col.name
      // 兜底：真有字段就叫 u_id 的话继续加序号，保证输出列名全局唯一——
      // 重名会让 ResultSet 里后面的值覆盖前面的，是静默的错数据
      for (let n = 2; used.has(outName); n++) outName = `${a}_${col.name}_${n}`
      used.add(outName)
      aliasByKey.set(`${tableName}.${col.name}`, outName)

      const expr =
        outName === col.name ? `  ${a}.${q(col.name)}` : `  ${a}.${q(col.name)} AS ${q(outName)}`
      lines.push(`${expr},${col.comment ? `  -- ${col.comment}` : ''}`)
    }
  }

  // 去掉最后一行的逗号
  if (lines.length) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/,(\s*(--.*)?)$/, '$1')
  }

  return { lines, aliasByKey }
}

/** 一张表当前要进 SELECT 的列（未降级）。供单测和 UI 计数复用。 */
export function pickTableColumns(
  table: TableInfo,
  selectedColumns?: Record<string, string[] | null> | null,
): TableInfo['columns'] {
  // null / 缺表 / 表内 null = 未动 = 只勾默认露出列（跟单表 SELECT 一致）
  const defaultCols = () => {
    const want = new Set(defaultPickNames(table.columns))
    return table.columns.filter((c) => want.has(c.name))
  }
  if (selectedColumns == null) return defaultCols()
  if (!(table.name in selectedColumns)) return defaultCols()
  const pick = selectedColumns[table.name]
  if (pick === null) return defaultCols()
  if (pick.length === 0) return []
  const want = new Set(pick)
  // 保持表内原顺序，不按勾选顺序重排
  return table.columns.filter((c) => want.has(c.name))
}

export interface MultiTableResult {
  sql: string
  /** 被丢弃的孤立关联，UI 上要提示 */
  droppedLinks: JoinLink[]
  /** 输出列名映射，MyBatis resultMap 复用 */
  aliasByKey: Map<string, string>
  joined: string[]
  aliases: Map<string, string>
}

export function generateMultiTable(options: MultiTableOptions): MultiTableResult {
  const { mainTable, tables, dialect, withHeader } = options
  const spec = DIALECTS[dialect]
  const q = spec.quote

  const allNames = [mainTable.name, ...options.links.filter((l) => l.enabled).flatMap((l) => [l.fk.fromTable, l.fk.toTable])]
  const aliases = buildAliases([...new Set(allNames)])

  const { sql: fromClause, joined, dropped } = buildFromClause(options, aliases)
  const { lines: fieldLines, aliasByKey } = buildSelectFields(joined, options, aliases)

  const mainAlias = aliases.get(mainTable.name)!
  const mainPk = mainTable.columns.find((c) => c.isPrimaryKey)
  const pageSize =
    options.pageSize && options.pageSize > 0 ? options.pageSize : DEFAULT_PAGE_SIZE

  const blocks: string[] = []

  if (withHeader) {
    const conditions = options.links
      .filter((l) => l.enabled)
      .map((l) => `${l.fk.fromTable}.${l.fk.fromColumn} = ${l.fk.toTable}.${l.fk.toColumn}`)
    blocks.push(
      [
        `-- ${RULE}`,
        `-- 多表关联查询: ${joined.join(' + ')}`,
        ...conditions.map((c) => `-- 关联条件: ${c}`),
        `-- 方言: ${spec.label}`,
        `-- ${RULE}`,
      ].join('\n'),
    )
  }

  // 1. 列表查询。分页 / 排序 / 分组只动这一块；详情和统计块仍按全列（勾选后的）出。
  const listSelect = buildListSelect({
    options,
    joined,
    aliases,
    fromClause,
    fieldLines,
    mainAlias,
    mainPk,
    q,
  })
  blocks.push(
    [
      `-- 1. 列表查询（前 ${pageSize} 条 + 可选条件）`,
      `${applyPage(options.dialect, listSelect, { offset: 0, limit: pageSize })};`,
    ].join('\n'),
  )

  // 2. 详情查询
  if (mainPk) {
    blocks.push(
      [
        '-- 2. 详情查询（按主表主键）',
        'SELECT',
        ...fieldLines,
        fromClause,
        `WHERE ${mainAlias}.${q(mainPk.name)} = #{${mainPk.javaField}};`,
      ].join('\n'),
    )
  }

  // 3. 统计聚合：对从表做 COUNT/SUM，数值字段挑第一个
  const childTable = joined.find((t) => t !== mainTable.name)
  if (childTable && mainPk) {
    const child = tables.get(childTable)
    const childAlias = aliases.get(childTable)
    const childPk = child?.columns.find((c) => c.isPrimaryKey)
    // SUM 的对象要挑真正的数值字段：排除主键和 xxx_id（对外键求和没有意义），
    // 金额/小数类优先于整型，因为报表里要统计的基本都是金额
    const summable = (child?.columns ?? []).filter(
      (c) => !c.isPrimaryKey && !/_?id$/i.test(c.name),
    )
    const numericCol =
      summable.find((c) => ['java.math.BigDecimal', 'Double'].includes(c.javaType)) ??
      summable.find((c) => ['Long', 'Integer'].includes(c.javaType))

    const groupCols = [
      `${mainAlias}.${q(mainPk.name)}`,
      ...mainTable.columns
        .filter((c) => !c.isPrimaryKey)
        .slice(0, 1)
        .map((c) => `${mainAlias}.${q(c.name)}`),
    ]

    blocks.push(
      [
        '-- 3. 统计聚合',
        'SELECT',
        ...groupCols.map((c) => `  ${c},`),
        `  COUNT(${childAlias}.${q(childPk?.name ?? mainPk.name)}) AS ${q(`${childTable}_count`)},`,
        numericCol
          ? `  SUM(${childAlias}.${q(numericCol.name)}) AS ${q(`total_${numericCol.name}`)}`
          : `  COUNT(*) AS ${q('row_count')}`,
        fromClause,
        `GROUP BY ${groupCols.join(', ')}`,
        `ORDER BY ${q(`${childTable}_count`)} DESC;`,
      ].join('\n'),
    )
  }

  return {
    sql: blocks.join('\n\n'),
    droppedLinks: dropped,
    aliasByKey,
    joined,
    aliases,
  }
}

function buildListSelect(args: {
  options: MultiTableOptions
  joined: string[]
  aliases: Map<string, string>
  fromClause: string
  fieldLines: string[]
  mainAlias: string
  mainPk: TableInfo['columns'][number] | undefined
  q: (id: string) => string
}): string {
  const { options, joined, aliases, fromClause, fieldLines, mainAlias, mainPk, q } = args
  const { tables } = options
  const groupKey = options.groupBy?.trim() || ''
  const group = groupKey ? splitTableCol(groupKey) : null
  const groupOk =
    group &&
    joined.includes(group.table) &&
    Boolean(tables.get(group.table)?.columns.some((c) => c.name === group.column))

  const whereBits = buildWhereBits({
    options,
    joined,
    aliases,
    q,
  })

  if (groupOk && group) {
    const ga = aliases.get(group.table)!
    const gExpr = `${ga}.${q(group.column)}`
    const dir = options.orderBy?.dir === 'asc' ? 'ASC' : 'DESC'
    const asked = options.orderBy?.column?.trim()
    const orderExpr =
      asked === GROUP_COUNT_ALIAS
        ? q(GROUP_COUNT_ALIAS)
        : asked === groupKey
          ? gExpr
          : q(GROUP_COUNT_ALIAS)
    return [
      'SELECT',
      `  ${gExpr},`,
      `  COUNT(*) AS ${q(GROUP_COUNT_ALIAS)}  -- 分组条数`,
      fromClause,
      ...whereBits,
      `GROUP BY ${gExpr}`,
      `ORDER BY ${orderExpr} ${dir}`,
    ].join('\n')
  }

  const order = renderMultiOrderBy({
    options,
    joined,
    aliases,
    mainAlias,
    mainPk,
    q,
  })
  return ['SELECT', ...fieldLines, fromClause, ...whereBits, order].join('\n')
}

function buildWhereBits(args: {
  options: MultiTableOptions
  joined: string[]
  aliases: Map<string, string>
  q: (id: string) => string
}): string[] {
  const { options, joined, aliases, q } = args
  const keys = resolveMultiConditions(
    options.mainTable,
    joined,
    options.tables,
    options.selectConditions,
  )
  if (!keys.length) {
    return ['WHERE 1 = 1']
  }
  const literal = options.conditionStyle === 'literal'
  const lines: string[] = []
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!
    const p = splitTableCol(key)!
    const table = options.tables.get(p.table)!
    const col = table.columns.find((c) => c.name === p.column)!
    const a = aliases.get(p.table)!
    let pred: string
    if (literal) {
      pred = renderCondition(
        col,
        multiCondDisplayValue(table, col, key, options),
        options.dialect,
        cmpOpOf(options.cmpOps, key),
        a,
      )
    } else {
      // 占位符带表别名，避免两张表都有 id 时都叫 #{id}
      const ph = `${a}_${col.javaField}`
      pred = `${a}.${q(col.name)} = #{${ph}}`
    }
    lines.push(i === 0 ? `WHERE ${pred}` : `  AND ${pred}`)
  }
  return lines
}

/** 条件格子展示值：手改优先，否则跟单表一样造默认值 */
function multiCondDisplayValue(
  table: TableInfo,
  col: TableInfo['columns'][number],
  key: string,
  options: MultiTableOptions,
): string {
  const overrides = options.selectValues
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, key)) {
    return overrides[key]!
  }
  const seed = options.seed ?? 1
  const insertPlans = planValues(table, options.dialect, seed, 'insert')
  const pkValues: ValueMap = {}
  for (const c of table.columns) {
    if (c.isPrimaryKey) pkValues[c.name] = DEFAULT_PK_VALUE
  }
  return defaultConditionValue(col, insertPlans, pkValues, {})
}

function renderMultiOrderBy(args: {
  options: MultiTableOptions
  joined: string[]
  aliases: Map<string, string>
  mainAlias: string
  mainPk: TableInfo['columns'][number] | undefined
  q: (id: string) => string
}): string {
  const { options, joined, aliases, mainAlias, mainPk, q } = args
  const dir = options.orderBy?.dir === 'asc' ? 'ASC' : 'DESC'
  const asked = options.orderBy?.column?.trim()
  const parsed = asked ? splitTableCol(asked) : null
  if (
    parsed &&
    joined.includes(parsed.table) &&
    options.tables.get(parsed.table)?.columns.some((c) => c.name === parsed.column)
  ) {
    return `ORDER BY ${aliases.get(parsed.table)}.${q(parsed.column)} ${dir}`
  }
  if (mainPk) return `ORDER BY ${mainAlias}.${q(mainPk.name)} ${dir}`
  return '-- ORDER BY <主表无主键，请自行指定>'
}
