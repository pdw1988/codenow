/**
 * 连库导入的方言接口。
 *
 * `DbConnect.tsx` 是共用壳：表清单、勾选、导入、历史、只读查询、勾选行按主键删除/更新、插入一行。方言之间只允许
 * 不同：怎么连、字典怎么查、查询怎么跑、删改插怎么发、生成页执行怎么发、编辑表结构增量 DDL 怎么发。**不要改 DbConnect.tsx 写 if (kind === '…')。**
 *
 * 接入新库：在 `dbDialects/` 下新建文件，在下面 `DIALECTS` 里登记。**不要改 DbConnect.tsx。**
 */
import type { Column } from '../types/schema'
import type { DbKind } from '../types/dbconn'
import type { IndexDef } from './sqladvise'
import type { DbTarget, MetaCountRow, MetaFkRow, MetaTableRow } from './dbmeta'
import type { QueryGrid } from './sqlReadonly'
import { mysqlDialect } from './dbDialects/mysql'
import { oracleDialect } from './dbDialects/oracle'
import { postgresqlDialect } from './dbDialects/postgresql'
import { sqliteDialect } from './dbDialects/sqlite'

export type { QueryGrid }
export type { DbKind }
export { dbKindOf } from '../types/dbconn'

export interface DbCatalog {
  version: string
  tables: MetaTableRow[]
  counts: MetaCountRow[]
  fks: MetaFkRow[]
}

/** 已接通、可以点「连接并读取」的方言 */
export interface LiveDbDialect {
  id: DbKind
  label: string
  defaultPort: string
  defaultUser: string
  /**
   * 本机文件库（SQLite）：连接表单只填路径，主机/端口/用户/密码用占位。
   * 壳根据这个开关藏字段，不要再写 if (kind === 'sqlite')。
   */
  fileBased?: boolean
  /** 第五栏：Oracle 服务名 / MySQL 数据库名 / SQLite 文件路径 */
  dbLabel: string
  dbPlaceholder: string
  dbHint: string
  who: string
  emptyTitle: string
  emptyText: string
  /** 连上后读表清单时进度日志用。壳不要写 if (kind === …) */
  catalogHint: string
  /** 拼进「浏览器模式无 … 驱动」 */
  driverName: string
  connect: (t: DbTarget) => Promise<DbCatalog>
  /** 方言自己查字典、自己映射成 Column，壳不看行对象形状 */
  fetchColumns: (table: string) => Promise<Column[]>
  /**
   * 一张表的索引（含复合索引列顺序）。SQL 体检（lib/sqladvise）用。
   * 各方言自己查字典（Oracle user_indexes / MySQL STATISTICS / PG pg_index /
   * SQLite PRAGMA），拿不到就 undefined——体检相应规则闭嘴，不报错。
   */
  fetchIndexes?: (table: string) => Promise<IndexDef[]>
  /** 只读查询。闸门在 sqlReadonly / Rust sql_readonly，这里只转发 */
  query: (sql: string, loadAll?: boolean) => Promise<QueryGrid>
  /** 勾选行按主键 DELETE。query 继续只读 */
  deleteRows: (sql: string) => Promise<{ affected: number }>
  /** 勾选行按主键 UPDATE。SQL 框不能跑 UPDATE；改格子保存不做 */
  updateRows: (sql: string) => Promise<{ affected: number }>
  /** 插入一行。SQL 框不能跑 INSERT；不拿「复制 INSERT」在本表执行 */
  insertRows: (sql: string) => Promise<{ affected: number }>
  /** 生成页确认后执行 INSERT / 带 WHERE 的 UPDATE、DELETE */
  execSql: (statements: string[]) => Promise<{ affected: number; ran: number }>
  /** 编辑表结构 / 索引落地确认后执行 ALTER TABLE / COMMENT ON / CREATE INDEX / ANALYZE。不复用 execSql */
  execDdl: (statements: string[]) => Promise<{ affected: number; ran: number }>
  disconnect: () => Promise<void>
}

export interface DisabledDbKind {
  id: DbKind
  label: string
  disabled: string
}

export type DbKindEntry = LiveDbDialect | DisabledDbKind

export function isLiveDbKind(e: DbKindEntry): e is LiveDbDialect {
  return !('disabled' in e)
}

/**
 * 登记表。新方言只在这里加一条 Live，不要往壳里写 if (kind === '…')。
 */
export const DIALECTS: DbKindEntry[] = [
  oracleDialect,
  mysqlDialect,
  postgresqlDialect,
  sqliteDialect,
]

export function liveDialects(): LiveDbDialect[] {
  return DIALECTS.filter(isLiveDbKind)
}

export function dialectEntry(id: DbKind): DbKindEntry {
  return DIALECTS.find((d) => d.id === id) ?? DIALECTS[0]
}

export function liveDialect(id: DbKind): LiveDbDialect | undefined {
  const e = dialectEntry(id)
  return isLiveDbKind(e) ? e : undefined
}

export const DEFAULT_DB_KIND: DbKind = liveDialects()[0]?.id ?? 'oracle'
