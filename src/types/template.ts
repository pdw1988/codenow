/**
 * SQL 生成模板，PRD 4.13。
 *
 * 存的是「配置」而不是「生成结果」：表结构会变（重新导入 DDL、改字段注释），
 * 存 SQL 文本的话模板第二天就过期了；存配置则每次套用都用当前表结构重算一遍。
 */
import { isDialect, type Dialect, type JoinType, type OutputKind } from './schema'
import type { CrudKind } from '../lib/sqlgen/singleTable'

/** 一条关联的持久化形式。用 fkKey 字符串而不是整个 ForeignKey：
 *  外键的 constraintName 之类的元数据会随重新导入变化，只有两端的字段是稳定的。 */
export interface TemplateLink {
  /** `fromTable.fromColumn->toTable.toColumn`，见 lib/sqlgen/multiTable 的 fkKey */
  key: string
  joinType: JoinType
  enabled: boolean
}

export interface SqlTemplate {
  id: string
  name: string
  tags: string[]
  mainTable: string
  mode: 'single' | 'multi'
  dialect: Dialect
  /** 单表模式下要生成哪几种语句 */
  kinds: CrudKind[]
  /**
   * 预编译还是可执行（PRD 4.3）。可选：v5.1 之前存的模板没有这个字段，
   * 套用时缺省当 'prepared'——那就是当时保存它的行为。
   * 注意只存模式，不存具体的测试数据值：值是 (seed, 表, 字段) 算出来的一次性东西，
   * 存进模板等于把某一天的假数据固化下来，跟「模板存配置不存结果」的原则冲突。
   */
  outputKind?: OutputKind
  /** 选中的字段名；null = 全选。单表用。多表见 tableColumns */
  columns: string[] | null
  /**
   * 多表：按表勾选的列。null / 缺省 = 每张表全选。
   * 某表 null = 该表全选；[] = 明确不选。单表不用这个字段。
   */
  tableColumns?: Record<string, string[] | null> | null
  links: TemplateLink[]
  withHeader: boolean
  createdAt: string
  updatedAt: string
}

/**
 * 模板里「可恢复的配置」那部分，不含 id / 名称 / 时间戳。
 *
 * 单独抽出来是为了让保存面板只收一个 prop：否则主表、模式、方言、语句类型、
 * 字段、关联、注释头得一个个传进去，加一项配置就要改三处签名。
 */
export type TemplateConfig = Omit<SqlTemplate, 'id' | 'name' | 'tags' | 'createdAt' | 'updatedAt'>

/** 模板保存条数上限。超过就该做搜索和分组了，那是另一个功能 */
export const TEMPLATE_LIMIT = 50

/**
 * 校验从存储里读出来的模板。
 *
 * 存的是 JSON blob，格式可能来自旧版本或被手改过。宁可丢掉一条坏模板，
 * 也不要让整个模板列表崩掉——所以逐条校验，不合格的直接跳过。
 */
export function isSqlTemplate(value: unknown): value is SqlTemplate {
  if (typeof value !== 'object' || value === null) return false
  const t = value as Record<string, unknown>
  return (
    typeof t.id === 'string' &&
    typeof t.name === 'string' &&
    typeof t.mainTable === 'string' &&
    (t.mode === 'single' || t.mode === 'multi') &&
    isDialect(t.dialect) &&
    Array.isArray(t.kinds) &&
    Array.isArray(t.links) &&
    Array.isArray(t.tags) &&
    (t.columns === null || Array.isArray(t.columns)) &&
    (t.tableColumns === undefined ||
      t.tableColumns === null ||
      (typeof t.tableColumns === 'object' && !Array.isArray(t.tableColumns)))
  )
}
