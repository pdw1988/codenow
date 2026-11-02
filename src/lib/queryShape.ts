/**
 * 连库查询的「排序 / 分组 / 分页」三件套。
 *
 * 纯函数，不碰 React 也不碰存储 —— 界面只负责把 QueryShape 交给
 * previewSqlWithWhere，怎么选默认值、排序列合不合法都在这里判，能被 node:test 直接打。
 *
 * 为什么需要 allowNames：分组后 SELECT 里只剩「分组列 + COUNT(*)」，
 * 排序再指向一个没进 SELECT 的列，Oracle/PG 会直接报错。
 */
import type { Column } from '../types/schema'
import {
  DEFAULT_PAGE_SIZE,
  GROUP_COUNT_ALIAS,
  type OrderDir,
} from './sqlgen/executable'
import { DIALECTS, type GenDialect } from './sqlgen/dialect'

export interface QueryShape {
  /** '' = 跟默认（主键 → 叫 id 的列 → 第一列） */
  orderCol: string
  orderDir: OrderDir
  /** '' = 不分组 */
  groupCol: string
  pageSize: number
  /** 从 0 起 */
  pageIndex: number
}

/** 默认：不分组，按主键（id）降序，一页 20 条 */
export const DEFAULT_QUERY_SHAPE: QueryShape = {
  orderCol: '',
  orderDir: 'desc',
  groupCol: '',
  pageSize: DEFAULT_PAGE_SIZE,
  pageIndex: 0,
}

/**
 * 默认排序列。主键优先；连库有时拿不到主键标（权限/字典查失败），
 * 退而找名字就叫 id 的列，再不行拿第一列。
 */
export function defaultOrderColumn(all: readonly Column[]): string {
  const pk = all.find((c) => c.isPrimaryKey)
  if (pk) return pk.name
  const id = all.find((c) => c.name.toLowerCase() === 'id')
  if (id) return id.name
  return all[0]?.name ?? ''
}

/**
 * 排序列定案。allowNames 是当前 SELECT 里真实存在的名字（含 cnt 这种别名）。
 * 选中的列不在里面就退回 fallback，fallback 也不在就拿第一个——
 * 宁可排错列，不能拼出一条跑不起来的 SQL。allowNames 空 = 不加 ORDER BY。
 */
export function resolveOrder(
  shape: QueryShape,
  allowNames: readonly string[],
  fallback: string,
): { column: string; dir: OrderDir } | undefined {
  if (allowNames.length === 0) return undefined
  const column = allowNames.includes(shape.orderCol)
    ? shape.orderCol
    : allowNames.includes(fallback)
      ? fallback
      : allowNames[0]!
  return { column, dir: shape.orderDir }
}

/** 分组时的 SELECT：分组列 + COUNT(*) AS cnt。引号交给方言，调用方不拼字符串 */
export function groupSelectExprs(kind: GenDialect, groupCol: string): string[] {
  const q = DIALECTS[kind].quote
  return [q(groupCol), `COUNT(*) AS ${q(GROUP_COUNT_ALIAS)}`]
}

/** 分组后只能按「分组列」或「条数」排 */
export function groupOrderAllow(groupCol: string): string[] {
  return [groupCol, GROUP_COUNT_ALIAS]
}

/** 折起时标题栏上那句摘要：不展开也知道当前怎么排、分没分组、第几页 */
export function shapeSummary(
  shape: QueryShape,
  orderColumn: string,
  hasNextPage: boolean,
): string {
  const dir = shape.orderDir === 'asc' ? '升序' : '降序'
  const order = orderColumn ? `按 ${orderColumn} ${dir}` : '不排序'
  // 分组后勾的列会凭空失效，得说一声。控件挤在一行了，没地方放 Hint，就搭在摘要里
  const group = shape.groupCol ? `分组 ${shape.groupCol}（字段勾选不生效）` : '不分组'
  // 总页数要再发一条 COUNT 才知道，不值得；只说当前第几页、后面还有没有
  const page = `第 ${shape.pageIndex + 1} 页${hasNextPage ? '' : '（末页）'} · 每页 ${shape.pageSize}`
  return `${order} · ${group} · ${page}`
}
