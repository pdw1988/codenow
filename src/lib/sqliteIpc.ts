/**
 * 桌面版 SQLite 连库的 IPC 封装。
 *
 * 连的是用户本机 `.db` 文件，不是 cache.db（cache 仍走 plugin-sql）。
 * 命令面与 mysql_* 同款；连接参数里只有 `db`（文件路径）有意义。
 */
import type { MetaColumnRow, MetaCountRow, MetaFkRow, MetaTableRow } from './dbmeta'
import type { QueryGrid } from './sqlReadonly'
import { tauriInvoke } from './tauriInvoke'

export interface SqliteCatalog {
  version: string
  tables: MetaTableRow[]
  counts: MetaCountRow[]
  fks: MetaFkRow[]
}

export function sqliteConnect(args: {
  host: string
  port: string
  user: string
  password: string
  db: string
}): Promise<SqliteCatalog> {
  return tauriInvoke<SqliteCatalog>('sqlite_connect', args)
}

export function sqliteColumns(table: string): Promise<MetaColumnRow[]> {
  return tauriInvoke<MetaColumnRow[]>('sqlite_columns', { table })
}

/** 索引元数据（一行 = 索引的一列），SQL 体检用 */
export interface SqliteIdxRow {
  itbl: string | null
  iname: string | null
  iuniq: number | null
  iorigin: string | null
  iseq: number | null
  icol: string | null
}

export function sqliteIndexes(table: string): Promise<SqliteIdxRow[]> {
  return tauriInvoke<SqliteIdxRow[]>('sqlite_indexes', { table })
}

export function sqliteQuery(sql: string, loadAll = false): Promise<QueryGrid> {
  return tauriInvoke<QueryGrid>('sqlite_query', { sql, loadAll })
}

export function sqliteDeleteRows(sql: string): Promise<{ affected: number }> {
  return tauriInvoke<{ affected: number }>('sqlite_delete_rows', { sql })
}

export function sqliteExecSql(statements: string[]): Promise<{ affected: number; ran: number }> {
  return tauriInvoke<{ affected: number; ran: number }>('sqlite_exec_sql', { statements })
}

export function sqliteExecDdl(statements: string[]): Promise<{ affected: number; ran: number }> {
  return tauriInvoke<{ affected: number; ran: number }>('sqlite_exec_ddl', { statements })
}

export function sqliteUpdateRows(sql: string): Promise<{ affected: number }> {
  return tauriInvoke<{ affected: number }>('sqlite_update_rows', { sql })
}

export function sqliteInsertRows(sql: string): Promise<{ affected: number }> {
  return tauriInvoke<{ affected: number }>('sqlite_insert_rows', { sql })
}

export function sqliteDisconnect(): Promise<void> {
  return tauriInvoke<void>('sqlite_disconnect')
}
