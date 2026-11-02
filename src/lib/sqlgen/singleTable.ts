/**
 * 单表 CRUD 生成，PRD 4.4。
 *
 * 输出的是 MyBatis 风格的 #{param} 占位符，因为目标用户是 Java 开发，
 * 生成完直接粘进 Mapper 就能用；要拿去 Navicat 手跑，把 #{x} 换掉即可。
 */
import type { Column, Dialect, TableInfo } from '../../types/schema'
import { applyPage, DIALECTS } from './dialect'
import {
  pickAggFlags,
  realNamesOf,
  selectExprsFromPick,
} from '../columnPick'

export type CrudKind = 'insert' | 'update' | 'delete' | 'select'

export const CRUD_LABELS: Record<CrudKind, string> = {
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
  select: 'SELECT',
}

export interface SingleTableOptions {
  dialect: Dialect
  kinds: CrudKind[]
  /** 参与生成的字段名，不传则全部 */
  selectedColumns?: string[]
  /** 是否在语句上方加注释头 */
  withHeader: boolean
}

/** 分隔线宽度，跟 PRD 4.4 的示例保持一致 */
const RULE = '='.repeat(60)

/** 导出给 executable.ts 用：两种模式的注释头必须长得一样，否则切换模式时整段 diff 都在动 */
export function header(lines: string[]): string {
  return [`-- ${RULE}`, ...lines.map((l) => `-- ${l}`), `-- ${RULE}`].join('\n')
}

/**
 * 主键是 WHERE 条件的依据。没有主键的表（比如纯关联表 user_role 用复合主键，
 * 或者建表时忘了加）要能降级处理，不能直接崩。
 */
function primaryKeys(table: TableInfo): Column[] {
  return table.columns.filter((c) => c.isPrimaryKey)
}

/** WHERE id = #{id} AND ... ；无主键时返回 null，由调用方决定怎么提示 */
function whereByPk(table: TableInfo, dialect: Dialect): string | null {
  const pks = primaryKeys(table)
  if (!pks.length) return null
  const q = DIALECTS[dialect].quote
  return pks.map((pk) => `${q(pk.name)} = #{${pk.javaField}}`).join('\n  AND ')
}

/**
 * 拼逗号分隔的字段列表。
 *
 * 逗号必须在行尾注释之前：写成 `col  -- 注释,` 的话逗号被注释吃掉，
 * SQL 直接语法错误。这是行尾注释 + 多行列表组合时唯一容易踩的坑。
 * 可执行模式也用它拼值列表，所以导出。
 */
export function joinFields(entries: Array<{ text: string; comment?: string }>): string {
  const last = entries.length - 1
  return entries
    .map((e, i) => `  ${e.text}${i === last ? '' : ','}${e.comment ? `  -- ${e.comment}` : ''}`)
    .join('\n')
}

function buildInsert(table: TableInfo, cols: Column[], dialect: Dialect): string {
  const q = DIALECTS[dialect].quote
  // 自增主键不进 INSERT 列表，否则插入时会覆盖数据库的自增值
  const insertable = cols.filter((c) => !c.isAutoIncrement)

  if (!insertable.length) return `-- ${table.name}: 没有可插入的字段`

  const names = joinFields(insertable.map((c) => ({ text: q(c.name), comment: c.comment })))
  const values = joinFields(insertable.map((c) => ({ text: `#{${c.javaField}}` })))

  return `INSERT INTO ${q(table.name)} (\n${names}\n) VALUES (\n${values}\n);`
}

function buildUpdate(table: TableInfo, cols: Column[], dialect: Dialect): string {
  const q = DIALECTS[dialect].quote
  const where = whereByPk(table, dialect)

  // 主键不出现在 SET 里：改主键是另一回事，混进常规 UPDATE 很危险
  const settable = cols.filter((c) => !c.isPrimaryKey)
  if (!settable.length) return `-- ${table.name}: 除主键外没有可更新的字段`

  const sets = joinFields(
    settable.map((c) => ({ text: `${q(c.name)} = #{${c.javaField}}`, comment: c.comment })),
  )

  if (!where) {
    return [
      `-- ⚠️ ${table.name} 没有主键，无法生成安全的 WHERE 条件`,
      `-- 下面的语句会更新全表，务必自己补上 WHERE 再执行`,
      `UPDATE ${q(table.name)} SET\n${sets}\n-- WHERE <请补充条件>;`,
    ].join('\n')
  }

  return `UPDATE ${q(table.name)} SET\n${sets}\nWHERE ${where};`
}

function buildDelete(table: TableInfo, dialect: Dialect): string {
  const q = DIALECTS[dialect].quote
  const where = whereByPk(table, dialect)

  if (!where) {
    return [
      `-- ⚠️ ${table.name} 没有主键，DELETE 会清空全表`,
      `-- DELETE FROM ${q(table.name)} WHERE <请补充条件>;`,
    ].join('\n')
  }

  return `DELETE FROM ${q(table.name)}\nWHERE ${where};`
}

function buildSelect(
  table: TableInfo,
  cols: Column[],
  dialect: Dialect,
  selectedColumns?: string[],
): string {
  const spec = DIALECTS[dialect]
  const q = spec.quote
  const where = whereByPk(table, dialect)
  const agg = pickAggFlags(selectedColumns)
  const usePickAgg = selectedColumns != null && (agg.star || agg.pk)
  const pickResolved = usePickAgg
    ? selectExprsFromPick(dialect, selectedColumns, table.columns)
    : null
  const fields = pickResolved
    ? joinFields(pickResolved.exprs)
    : joinFields(cols.map((c) => ({ text: q(c.name), comment: c.comment })))
  const group =
    pickResolved && pickResolved.groupBy.length > 0
      ? `GROUP BY ${pickResolved.groupBy.map(q).join(', ')}`
      : null

  const byPk = where
    ? [
        '-- 按主键查询',
        'SELECT',
        fields,
        `FROM ${q(table.name)}`,
        `WHERE ${where}`,
        group,
      ]
        .filter(Boolean)
        .join('\n') + ';'
    : null

  const listInner = [
    'SELECT',
    fields,
    `FROM ${q(table.name)}`,
    'WHERE 1 = 1',
    // 常见做法是把可选条件都列出来注释掉，用户按需打开
    ...(pickResolved?.onlyAgg
      ? []
      : cols
          .filter((c) => !c.isAutoIncrement)
          .slice(0, 3)
          .map((c) => `  -- AND ${q(c.name)} = #{${c.javaField}}`)),
    group,
    pickResolved?.onlyAgg
      ? null
      : `ORDER BY ${q(primaryKeys(table)[0]?.name ?? cols[0]?.name ?? 'id')} DESC`,
  ]
    .filter(Boolean)
    .join('\n')

  const list = ['-- 列表查询（分页）', `${applyPage(dialect, listInner)};`].join('\n')

  return [byPk, list].filter(Boolean).join('\n\n')
}

/** 生成单表 CRUD。返回拼好的整段 SQL，调用方直接展示 / 复制。 */
export function generateSingleTable(table: TableInfo, options: SingleTableOptions): string {
  const { dialect, kinds, selectedColumns, withHeader } = options

  const realSelected =
    selectedColumns == null ? null : realNamesOf(selectedColumns)
  const aggOnly =
    selectedColumns != null &&
    realSelected!.length === 0 &&
    (pickAggFlags(selectedColumns).star || pickAggFlags(selectedColumns).pk)
  const cols =
    realSelected == null
      ? table.columns
      : table.columns.filter((c) => realSelected.includes(c.name))

  if (!cols.length && !(aggOnly && kinds.includes('select'))) {
    return '-- 没有选中任何字段'
  }
  if (!kinds.length) return '-- 没有选中任何语句类型'

  const blocks: string[] = []

  if (withHeader) {
    blocks.push(
      header([
        `表名: ${table.name}${table.comment ? ` (${table.comment})` : ''}`,
        `方言: ${DIALECTS[dialect].label}`,
        `字段: ${cols.length}/${table.columns.length}${aggOnly ? ' + 聚合' : ''}`,
      ]),
    )
  }

  // 固定按 INSERT/UPDATE/DELETE/SELECT 顺序输出，不跟随用户勾选顺序，
  // 这样同一张表两次生成的结果是一样的，方便 diff
  const order: CrudKind[] = ['insert', 'update', 'delete', 'select']
  let n = 0
  for (const kind of order) {
    if (!kinds.includes(kind)) continue
    n += 1

    const body =
      kind === 'insert'
        ? cols.length
          ? buildInsert(table, cols, dialect)
          : '-- 没有选中任何字段'
        : kind === 'update'
          ? cols.length
            ? buildUpdate(table, cols, dialect)
            : '-- 没有选中任何字段'
          : kind === 'delete'
            ? buildDelete(table, dialect)
            : buildSelect(table, cols, dialect, selectedColumns)

    blocks.push(`-- ${n}. ${CRUD_LABELS[kind]}\n${body}`)
  }

  return blocks.join('\n\n')
}
