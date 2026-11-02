/**
 * 可执行 SQL 生成，PRD 4.6 ~ 4.9。
 *
 * 跟 singleTable.ts 的区别只有一处：那边输出 #{param} 占位符给 MyBatis 用，
 * 这边把值直接填进去，复制到 Navicat 就能跑。PRD 4.3 把这两种叫「预编译模式」
 * 和「可执行模式」，也是 PRD 二、MVP 清单里第 3、4 条的核心差异化功能。
 *
 * 「能跑」是这个模块唯一的验收标准，所以下面每个细节都是为了这个：
 * 自增主键不出现在 INSERT 里、时间函数按方言取（Oracle 是 SYSDATE）、
 * UPDATE / DELETE 的 WHERE 只按主键（SELECT 的条件字段可勾选，PRD 4.9）、
 * 外键列给小数字。测试直接用 node:sqlite 真建表真执行。
 */
import type { Column, TableInfo } from '../../types/schema'
import { sortColumnsForUi } from '../columnOrder'
import {
  pickAggFlags,
  primaryKeyForCount,
  realNamesOf,
  selectExprsFromPick,
} from '../columnPick'
import { applyPage, DIALECTS, type GenDialect } from './dialect'
import {
  isCreateTime,
  isUpdateTime,
  planValues,
  renderValue,
  resolveValue,
  type PhaseValues,
  type ValueMap,
  type ValuePlan,
} from './mockValue'
import { CRUD_LABELS, header, joinFields, type CrudKind } from './singleTable'

export interface ExecutableOptions {
  dialect: GenDialect
  kinds: CrudKind[]
  /** 参与生成的字段名，不传则全部 */
  selectedColumns?: string[]
  withHeader: boolean
  /**
   * 用户手改过的值，按阶段分开：INSERT 和 UPDATE 是两套独立的值。
   * 没改的走 planValues 的自动值，那也是分阶段算的（PRD 4.6 vs 4.7）。
   */
  values: PhaseValues
  /** WHERE 用的主键值，列名 → 显示值。PRD 4.4：默认 1，用户可改 */
  pkValues: ValueMap
  /**
   * SELECT 的条件字段（PRD 4.9）。
   * null / 不传 = 默认只按主键；`[]` = 一个都没勾，退化成查前 20 条。
   * 这两种情况必须分开，不能都用「空」表示：不传是「还没动过」，空数组是用户明确取消了全部条件。
   */
  selectConditions?: string[] | null
  /** SELECT 条件的值，列名 → 显示值。没给的走 defaultConditionValue */
  selectValues?: ValueMap
  /**
   * WHERE 比较符，列名 → 操作。缺省等于。
   * 空值时 `ne` 出 `IS NOT NULL`，其余出 `IS NULL`（不等式对 NULL 没有意义）。
   */
  cmpOps?: Record<string, CmpOp>
  /**
   * 可执行 SELECT 最多返回多少行。缺省 20。
   * 没勾条件时用来避免裸 SELECT 全表；有条件时同样封顶，避免 LIKE 扫出几万行。
   */
  pageSize?: number
  /**
   * ORDER BY。不传 = 默认主键 DESC（没有主键则用选出的第一列）。
   * 和预编译列表查询、原型 mockup 同口径——送到连库查询时结果要有稳定顺序。
   * 开了分组时，只认分组列和 `cnt`；不传则默认按 `cnt` DESC。
   */
  orderBy?: OrderBySpec | null
  /**
   * GROUP BY 列名。空 / 不传 = 不分组。
   * 分组时 SELECT 改成这些列 + COUNT(*) AS cnt——直接把原字段清单挂上 GROUP BY
   * 会踩 ONLY_FULL_GROUP_BY（MySQL）/ 严格模式（PG/Oracle），语句能生成却跑不起来。
   */
  groupBy?: string[] | null
  /** 决定自动值那一套随机数，换一个就得到一整套新数据 */
  seed: number
}

/** 排序方向。界面 Seg 和生成器共用 */
export type OrderDir = 'asc' | 'desc'

export interface OrderBySpec {
  column: string
  dir: OrderDir
}

export const ORDER_DIR_OPTIONS: { value: OrderDir; label: string }[] = [
  { value: 'desc', label: '降序' },
  { value: 'asc', label: '升序' },
]

/** WHERE 比较。默认等于；界面下拉和生成器共用这一份，避免各写一套符号 */
export type CmpOp = 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'like'

export const CMP_OP_SQL: Record<CmpOp, string> = {
  eq: '=',
  ne: '<>',
  gt: '>',
  ge: '>=',
  lt: '<',
  le: '<=',
  like: 'LIKE',
}

export const CMP_OP_OPTIONS: { value: CmpOp; label: string }[] = [
  { value: 'eq', label: '等于' },
  { value: 'ne', label: '不等于' },
  { value: 'gt', label: '大于' },
  { value: 'ge', label: '大于等于' },
  { value: 'lt', label: '小于' },
  { value: 'le', label: '小于等于' },
  { value: 'like', label: 'LIKE' },
]

export function cmpOpOf(ops: Record<string, CmpOp> | undefined, name: string): CmpOp {
  const op = ops?.[name]
  return op && op in CMP_OP_SQL ? op : 'eq'
}

/** WHERE 条件默认按主键，值取 pkValues，缺省 1（PRD 4.4） */
export const DEFAULT_PK_VALUE = '1'

/** 可执行 SELECT 的条数下拉。默认 20，跟没勾条件时「查前 N 条」同一个数。 */
export const PAGE_SIZES = [10, 20, 50, 100, 500] as const
export const DEFAULT_PAGE_SIZE = 20

function pageLimit(options: ExecutableOptions): number {
  const n = options.pageSize
  return n && n > 0 ? n : DEFAULT_PAGE_SIZE
}

/** 分组查询里 COUNT(*) 的别名。ORDER BY / 界面下拉都认这个名字。 */
export const GROUP_COUNT_ALIAS = 'cnt'

/**
 * 解析分组列：只保留表里真有的，按表内顺序（不按勾选次序，方便 diff）。
 */
export function resolveGroupColumns(
  table: TableInfo,
  names: string[] | null | undefined,
): Column[] {
  if (!names?.length) return []
  const wanted = new Set(names)
  return table.columns.filter((c) => wanted.has(c.name))
}

/**
 * 拼 ORDER BY。列名必须在表里；乱填就退回主键 / 首列。
 * 没有可用列时返回空串（不硬拼非法 ORDER BY）。
 * `allowNames` 用于分组：只许排分组列和 cnt，缺省落到 cnt。
 */
export function renderOrderBy(
  table: TableInfo,
  cols: Column[],
  dialect: GenDialect,
  spec?: OrderBySpec | null,
  allowNames?: string[] | null,
): string {
  const q = DIALECTS[dialect].quote
  const dir = spec?.dir === 'asc' ? 'ASC' : 'DESC'
  const asked = spec?.column?.trim()

  if (allowNames?.length) {
    const name =
      asked && allowNames.includes(asked)
        ? asked
        : allowNames.includes(GROUP_COUNT_ALIAS)
          ? GROUP_COUNT_ALIAS
          : allowNames[0]!
    return `ORDER BY ${q(name)} ${dir}`
  }

  const pks = table.columns.filter((c) => c.isPrimaryKey)
  const fallback = pks[0]?.name ?? cols[0]?.name
  if (!fallback) return ''
  const name =
    asked && table.columns.some((c) => c.name === asked) ? asked : fallback
  return `ORDER BY ${q(name)} ${dir}`
}

/**
 * 拼 GROUP BY。没有合法列就返回空串。
 */
export function renderGroupBy(
  table: TableInfo,
  dialect: GenDialect,
  names: string[] | null | undefined,
): string {
  const cols = resolveGroupColumns(table, names)
  if (!cols.length) return ''
  const q = DIALECTS[dialect].quote
  return `GROUP BY ${cols.map((c) => q(c.name)).join(', ')}`
}

/**
 * 一个 `字段 操作符 值` 的 WHERE 条件。默认操作符是等于。
 *
 * 值为空时给的是 `IS NULL` / `IS NOT NULL`，而不是 `= NULL` / `<> NULL`
 * （PRD 4.9「留空 = IS NULL」）。SQL 里 NULL 不等于任何东西，连它自己都不等于，
 * 所以 `col = NULL` 恒为 unknown：查永远查不到行、删永远删不掉行，而且**不报错**——
 * 正是最难查的那类问题。用户把值清空的意思是「这一列是空的那些行」，
 * 只有 IS NULL 是那个意思；选了不等于则是「这一列有值的那些行」。
 * `>` / `>=` / `<` / `<=` / LIKE 遇上空值同样走 IS NULL：`> NULL`、`LIKE NULL` 永远 unknown。
 * LIKE 没写 `%` / `_` 时自动包成 `%值%`（包含）；已经带通配符的原样用。
 */
export function renderCondition(
  column: Column,
  text: string,
  dialect: GenDialect,
  op: CmpOp = 'eq',
  /** 多表 JOIN：写成 `别名.\`列\``；单表不传 */
  tableAlias?: string,
): string {
  const q = DIALECTS[dialect].quote
  const left = tableAlias ? `${tableAlias}.${q(column.name)}` : q(column.name)
  if (op === 'like') {
    const pattern = likePattern(text)
    if (pattern === '') {
      return `${left} IS NULL`
    }
    return `${left} LIKE ${renderValue(column, pattern, dialect)}`
  }
  const literal = renderValue(column, text, dialect)
  if (literal === 'NULL') {
    return op === 'ne' ? `${left} IS NOT NULL` : `${left} IS NULL`
  }
  return `${left} ${CMP_OP_SQL[op]} ${literal}`
}

/** 没写通配符就当「包含」。已经写了 `%` / `_` 的按用户原样，不再套一层。 */
function likePattern(text: string): string {
  const t = text.trim()
  if (!t) return ''
  return /[%_]/.test(t) ? t : `%${t}%`
}

/**
 * SELECT 的条件字段（PRD 4.9）。默认只有主键。
 *
 * 展示顺序与勾选清单同一套：主键 → 唯一键 → 日期 → 其余（档内字母）。
 * 不按用户勾选先后，否则同一份配置点两次 WHERE 就 diff 不开。
 */
export function selectConditionColumns(
  table: TableInfo,
  selected: string[] | null | undefined,
): Column[] {
  if (!selected) return sortColumnsForUi(table.columns.filter((c) => c.isPrimaryKey))
  const wanted = new Set(selected)
  return sortColumnsForUi(table.columns.filter((c) => wanted.has(c.name)))
}

/**
 * SELECT 条件的缺省值。主键取【WHERE 条件】那一行（跟 UPDATE / DELETE 共用一个值），
 * 其余字段取【INSERT 数据】那一栏的值。
 *
 * 后半条是刻意的：这个功能的场景是「刚插进去的那行到底进去了吗」（PRD 1.3），
 * 条件值跟 INSERT 用的同一个，复制出去两条语句连着跑就能验证，不用自己回头抄一遍。
 */
export function defaultConditionValue(
  column: Column,
  insertPlans: ValuePlan[],
  pkValues: ValueMap,
  insertOverrides: ValueMap,
): string {
  if (column.isPrimaryKey) return pkValues[column.name] ?? DEFAULT_PK_VALUE
  const plan = insertPlans.find((p) => p.column.name === column.name)
  return plan ? resolveValue(plan, insertOverrides) : ''
}

function whereByPk(table: TableInfo, options: ExecutableOptions): string | null {
  const pks = table.columns.filter((c) => c.isPrimaryKey)
  if (!pks.length) return null
  return pks
    .map((pk) =>
      renderCondition(
        pk,
        options.pkValues[pk.name] ?? DEFAULT_PK_VALUE,
        options.dialect,
        cmpOpOf(options.cmpOps, pk.name),
      ),
    )
    .join('\n  AND ')
}

/** 没主键的表只能给出带警告的半成品语句——生成一条会清全表的 SQL 是不可接受的 */
function noPkWarning(table: TableInfo, action: string): string[] {
  return [
    `-- ⚠️ ${table.name} 没有主键，${action}无法定位到单行`,
    '-- 下面的条件是占位的，执行前务必自己补上',
  ]
}

function buildInsert(
  table: TableInfo,
  plans: ValuePlan[],
  overrides: ValueMap,
  options: ExecutableOptions,
): string {
  const q = DIALECTS[options.dialect].quote
  // 自增主键不出现在字段列表里：填了就是覆盖数据库的自增值，PRD 4.4 叫「自动排除」
  const usable = plans.filter((p) => !p.excluded)
  if (!usable.length) return `-- ${table.name}: 没有可插入的字段`

  const names = joinFields(usable.map((p) => ({ text: q(p.column.name) })))
  // 值这一列把字段名写在行尾注释里：十几个值堆在一起时，不标就分不清哪个是哪个
  const values = joinFields(
    usable.map((p) => ({
      text: renderValue(p.column, resolveValue(p, overrides), options.dialect),
      comment: p.column.comment ? `${p.column.name} ${p.column.comment}` : p.column.name,
    })),
  )

  return `INSERT INTO ${q(table.name)} (\n${names}\n) VALUES (\n${values}\n);`
}

function buildUpdate(
  table: TableInfo,
  plans: ValuePlan[],
  overrides: ValueMap,
  options: ExecutableOptions,
): string {
  const spec = DIALECTS[options.dialect]
  const q = spec.quote
  const where = whereByPk(table, options)

  /*
   * SET 里排除三类字段（PRD 4.4 的 UPDATE 规则表）：
   *   主键      —— 它是 WHERE 条件，改主键是另一回事
   *   create_time —— 创建时间不该被更新覆盖
   *   自增列    —— 同主键
   * update_time 反过来必须出现，且强制填当前时间：这条语句执行时它就该被刷新。
   */
  const settable = plans.filter(
    (p) => !p.column.isPrimaryKey && !p.column.isAutoIncrement && !isCreateTime(p.column.name),
  )
  if (!settable.length) return `-- ${table.name}: 除主键和创建时间外没有可更新的字段`

  const sets = joinFields(
    settable.map((p) => ({
      text: `${q(p.column.name)} = ${
        isUpdateTime(p.column.name)
          ? spec.now
          : renderValue(p.column, resolveValue(p, overrides), options.dialect)
      }`,
      comment: p.column.comment,
    })),
  )

  if (!where) {
    return [
      ...noPkWarning(table, 'UPDATE'),
      `UPDATE ${q(table.name)} SET\n${sets}\n-- WHERE <请补充条件>;`,
    ].join('\n')
  }

  return `UPDATE ${q(table.name)} SET\n${sets}\nWHERE ${where};`
}

function buildDelete(table: TableInfo, options: ExecutableOptions): string {
  const q = DIALECTS[options.dialect].quote
  const where = whereByPk(table, options)

  if (!where) {
    return [
      ...noPkWarning(table, 'DELETE'),
      `-- DELETE FROM ${q(table.name)} WHERE <请补充条件>;`,
    ].join('\n')
  }

  return `DELETE FROM ${q(table.name)}\nWHERE ${where};`
}

function buildSelect(
  table: TableInfo,
  cols: Column[],
  insertPlans: ValuePlan[],
  options: ExecutableOptions,
): string {
  const q = DIALECTS[options.dialect].quote
  const groupCols = resolveGroupColumns(table, options.groupBy)
  const grouped = groupCols.length > 0
  /*
   * 分组下拉优先：SELECT = 分组列 + COUNT(*)，查询字段勾选（含 COUNT 记号）不生效。
   * 没开分组时，勾了 COUNT(*)/COUNT(主键) 才走聚合：只有聚合不加 GROUP BY；
   * 聚合 + 真列则 GROUP BY 真列，避免 ONLY_FULL_GROUP_BY 拒跑。
   */
  const pick = options.selectedColumns
  const agg = pickAggFlags(pick)
  const usePickAgg = !grouped && pick != null && (agg.star || agg.pk)
  const pickResolved = usePickAgg
    ? selectExprsFromPick(options.dialect, pick, table.columns)
    : null

  const fields = grouped
    ? joinFields([
        ...groupCols.map((c) => ({ text: q(c.name), comment: c.comment })),
        { text: `COUNT(*) AS ${q(GROUP_COUNT_ALIAS)}`, comment: '分组条数' },
      ])
    : pickResolved
      ? joinFields(pickResolved.exprs)
      : joinFields(cols.map((c) => ({ text: q(c.name), comment: c.comment })))
  const conds = selectConditionColumns(table, options.selectConditions)
  const limit = pageLimit(options)

  const where = conds
    .map((c) =>
      renderCondition(
        c,
        options.selectValues?.[c.name] ??
          defaultConditionValue(c, insertPlans, options.pkValues, options.values.insert ?? {}),
        options.dialect,
        cmpOpOf(options.cmpOps, c.name),
      ),
    )
    .join('\n  AND ')

  /*
   * 没勾条件（以及没有主键的表）不能给裸 SELECT 全表。PRD 4.9。
   * 有条件也同样封顶：LIKE '%x%' 也能扫出几万行。条数由 pageSize 决定，缺省 20。
   * GROUP BY / ORDER BY 必须在分页外包之前：Oracle ROWNUM 外包后外层再排会乱序。
   * 纯 COUNT(*) 一行结果：仍走分页外壳（各方言 LIMIT/ROWNUM 对聚合无害）。
   */
  let group = renderGroupBy(table, options.dialect, options.groupBy)
  if (!group && pickResolved && pickResolved.groupBy.length > 0) {
    group = `GROUP BY ${pickResolved.groupBy.map(q).join(', ')}`
  }
  const orderAllow = grouped
    ? [...groupCols.map((c) => c.name), GROUP_COUNT_ALIAS]
    : pickResolved
      ? [
          ...pickResolved.groupBy,
          ...(agg.star ? [GROUP_COUNT_ALIAS] : []),
          ...(agg.pk
            ? (() => {
                const pk = primaryKeyForCount(table.columns)
                return pk ? [`${pk.name}_cnt`] : []
              })()
            : []),
        ]
      : null
  const orderCols = pickResolved
    ? table.columns.filter((c) => pickResolved.groupBy.includes(c.name))
    : cols
  const order = pickResolved?.onlyAgg
    ? null
    : renderOrderBy(table, orderCols, options.dialect, options.orderBy, orderAllow)
  const lines = [`SELECT`, fields, `FROM ${q(table.name)}`]
  if (where) lines.push(`WHERE ${where}`)
  if (group) lines.push(group)
  if (order) lines.push(order)
  const inner = lines.join('\n')
  const paged = `${applyPage(options.dialect, inner, { offset: 0, limit })};`
  if (!where) {
    return [`-- 没有勾选查询条件，退化成查前 ${limit} 条（不生成查全表的裸 SELECT）`, paged].join('\n')
  }
  return paged
}

/**
 * 生成可执行 SQL。返回拼好的整段，调用方直接展示 / 复制。
 *
 * 语句顺序固定 INSERT → UPDATE → DELETE → SELECT，跟预编译模式一致，
 * 不跟随用户勾选顺序，这样同一份配置两次生成的结果能直接 diff。
 */
export function generateExecutable(table: TableInfo, options: ExecutableOptions): string {
  const { dialect, kinds, selectedColumns, withHeader, seed, values } = options

  // 聚合记号不算真列；只勾 COUNT 时 INSERT/UPDATE 仍报没字段，SELECT 单独放行
  const realSelected =
    selectedColumns == null ? null : realNamesOf(selectedColumns)
  const aggOnly =
    selectedColumns != null &&
    realSelected!.length === 0 &&
    (pickAggFlags(selectedColumns).star || pickAggFlags(selectedColumns).pk)
  const keep = (p: ValuePlan) =>
    realSelected == null || realSelected.includes(p.column.name)
  /*
   * INSERT 和 UPDATE 各算一套值，不能共用一套。
   * 共用的话「先执行 INSERT 再执行 UPDATE」那行数据一个字段都不会变，
   * 用户没法判断 UPDATE 到底生效了没有——而这正是十二、验收标准里
   * 「可执行 UPDATE：自动生成新值，复制后可直接执行更新」要求的。
   */
  const allInsertPlans = planValues(table, dialect, seed, 'insert')
  const insertPlans = allInsertPlans.filter(keep)
  const updatePlans = planValues(table, dialect, seed, 'update').filter(keep)
  const cols = insertPlans.map((p) => p.column)

  if (!cols.length && !(aggOnly && kinds.includes('select'))) {
    return '-- 没有选中任何字段'
  }
  if (!kinds.length) return '-- 没有选中任何语句类型'

  const blocks: string[] = []

  if (withHeader) {
    blocks.push(
      header([
        `表名: ${table.name}${table.comment ? ` (${table.comment})` : ''}    可执行SQL`,
        `方言: ${DIALECTS[dialect].label}`,
        `字段: ${cols.length}/${table.columns.length}${aggOnly ? ' + 聚合' : ''}`,
        '注意: 值是自动造的测试数据，执行前请确认它不会打乱现有数据',
      ]),
    )
  }

  const order: CrudKind[] = ['insert', 'update', 'delete', 'select']
  let n = 0
  for (const kind of order) {
    if (!kinds.includes(kind)) continue
    n += 1

    const body =
      kind === 'insert'
        ? cols.length
          ? buildInsert(table, insertPlans, values.insert ?? {}, options)
          : '-- 没有选中任何字段'
        : kind === 'update'
          ? cols.length
            ? buildUpdate(table, updatePlans, values.update ?? {}, options)
            : '-- 没有选中任何字段'
          : kind === 'delete'
            ? buildDelete(table, options)
            : // 给 buildSelect 的是**未过滤**的 plans：条件字段可以是③里没勾的列
              // （WHERE 引用不出现在 SELECT 列表里的列是合法的），那时仍要拿到它的缺省值
              buildSelect(table, cols, allInsertPlans, options)

    blocks.push(`-- ${n}. ${CRUD_LABELS[kind]}\n${body}`)
  }

  return blocks.join('\n\n')
}
