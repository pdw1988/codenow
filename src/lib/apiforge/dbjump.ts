/**
 * 调试卡「查库 ↗」的落点计算（纯函数）。
 *
 * 调完接口最想看的是**刚动过的那张表的刚动过那几行**——所以落点按证据强度挑：
 * 真有行数变更的表 > 有变更记录但行数为 0 的 > 启用的关联表。WHERE 靠快照对比
 * 算出的主键值（insertedIds/updatedIds/deletedIds，TableChange 注释见 types）：
 * 新增/更新的行拿主键一查就中，删除的行查出来是空——空恰恰证明删干净了。
 *
 * 主键列名从本地表结构缓存（连库导入过的表）拿：只有**单主键**表才敢拼 WHERE，
 * 复合主键/缓存里没有的表退回裸 SELECT *——猜错列名的 WHERE 比没有更糟。
 * 这条 SQL 只进连库查询的只读通道（assertReadonlySelect），SELECT 之外不生成。
 */
import type { Column } from '../../types/schema'
import type { TableChange } from './types'

export interface DbJumpTarget {
  table: string
  sql: string
}

/** IN 列表的长度上限：超过它就不是「看刚动过的几行」而是全表浏览了，别拼一长串 */
const MAX_IDS = 10

/** SQL 字符串字面量：单引号翻倍，其余原样（值来自快照对比，不是用户输入，够用） */
const quote = (v: string): string => `'${v.replace(/'/g, "''")}'`

export function quickCheckSql(args: {
  /** 最近一次执行的库变更对比（CaseRunResult.dbChanges） */
  changed: TableChange[]
  /** 调试卡里勾选启用的关联表（按界面顺序） */
  enabledTables: string[]
  /** 本地表结构缓存（连库导入的权威副本；没导入过的表不在里面） */
  schemaTables: { name: string; columns: Column[] }[]
}): DbJumpTarget | null {
  const { changed, enabledTables, schemaTables } = args
  const withOps = changed.filter((c) => c.rowsInserted || c.rowsUpdated || c.rowsDeleted)
  const touched = changed.filter((c) => c.op !== 'none')
  const entry = withOps[0] ?? touched[0]
  const table = entry?.tableName ?? enabledTables[0]
  if (!table) return null

  // 单主键才拼 WHERE：主键值就是快照对比的定位依据，列名必须来自表结构而不是猜
  const known = schemaTables.find((t) => t.name.toLowerCase() === table.toLowerCase())
  const pks = known ? known.columns.filter((c) => c.isPrimaryKey) : []
  const pk = pks.length === 1 ? pks[0].name : null
  const ids = entry
    ? [...entry.insertedIds, ...entry.updatedIds, ...entry.deletedIds].filter(Boolean)
    : []
  const where = pk && ids.length ? ` WHERE ${pk} IN (${ids.slice(0, MAX_IDS).map(quote).join(', ')})` : ''

  return { table, sql: `SELECT * FROM ${table}${where}` }
}
