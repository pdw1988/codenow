/**
 * 桌面版 MySQL 连库的 IPC 封装。
 *
 * 走 `tauriInvoke`，不要 `import('@tauri-apps/api/core')`（见 tauriInvoke.ts）。
 * 命令面：connect / columns / query / delete_rows / update_rows / insert_rows / exec_sql / exec_ddl / disconnect。
 * query 只放行只读语句。exec_sql 放行生成页确认后的写语句。
 * exec_ddl 放行编辑表结构确认后的 ALTER TABLE / COMMENT ON。
 */
import type { MetaColumnRow, MetaCountRow, MetaFkRow, MetaTableRow } from './dbmeta'
import type { QueryGrid } from './sqlReadonly'
import { tauriInvoke } from './tauriInvoke'

export interface MysqlCatalog {
  version: string
  tables: MetaTableRow[]
  counts: MetaCountRow[]
  fks: MetaFkRow[]
}

export function mysqlConnect(args: {
  host: string
  port: string
  user: string
  password: string
  db: string
}): Promise<MysqlCatalog> {
  return tauriInvoke<MysqlCatalog>('mysql_connect', args)
}

export function mysqlColumns(table: string): Promise<MetaColumnRow[]> {
  return tauriInvoke<MetaColumnRow[]>('mysql_columns', { table })
}

export function mysqlQuery(sql: string, loadAll = false): Promise<QueryGrid> {
  return tauriInvoke<QueryGrid>('mysql_query', { sql, loadAll })
}

export function mysqlDeleteRows(sql: string): Promise<{ affected: number }> {
  return tauriInvoke<{ affected: number }>('mysql_delete_rows', { sql })
}

export function mysqlExecSql(statements: string[]): Promise<{ affected: number; ran: number }> {
  return tauriInvoke<{ affected: number; ran: number }>('mysql_exec_sql', { statements })
}

export function mysqlExecDdl(statements: string[]): Promise<{ affected: number; ran: number }> {
  return tauriInvoke<{ affected: number; ran: number }>('mysql_exec_ddl', { statements })
}

export function mysqlUpdateRows(sql: string): Promise<{ affected: number }> {
  return tauriInvoke<{ affected: number }>('mysql_update_rows', { sql })
}

export function mysqlInsertRows(sql: string): Promise<{ affected: number }> {
  return tauriInvoke<{ affected: number }>('mysql_insert_rows', { sql })
}

export function mysqlDisconnect(): Promise<void> {
  return tauriInvoke<void>('mysql_disconnect')
}
