/**
 * 桌面版 PostgreSQL 连库的 IPC 封装。
 *
 * 走 `tauriInvoke`，不要 `import('@tauri-apps/api/core')`（见 tauriInvoke.ts）。
 * 命令面：connect / columns / query / delete_rows / update_rows / insert_rows / exec_sql / exec_ddl / disconnect。
 * query 只放行只读语句。exec_sql 放行生成页确认后的写语句。
 * exec_ddl 放行编辑表结构确认后的 ALTER TABLE / COMMENT ON。
 */
import type { MetaColumnRow, MetaCountRow, MetaFkRow, MetaTableRow } from './dbmeta'
import type { QueryGrid } from './sqlReadonly'
import { tauriInvoke } from './tauriInvoke'

export interface PostgresCatalog {
  version: string
  tables: MetaTableRow[]
  counts: MetaCountRow[]
  fks: MetaFkRow[]
}

export function postgresConnect(args: {
  host: string
  port: string
  user: string
  password: string
  db: string
}): Promise<PostgresCatalog> {
  return tauriInvoke<PostgresCatalog>('postgres_connect', args)
}

export function postgresColumns(table: string): Promise<MetaColumnRow[]> {
  return tauriInvoke<MetaColumnRow[]>('postgres_columns', { table })
}

export function postgresQuery(sql: string, loadAll = false): Promise<QueryGrid> {
  return tauriInvoke<QueryGrid>('postgres_query', { sql, loadAll })
}

export function postgresDeleteRows(sql: string): Promise<{ affected: number }> {
  return tauriInvoke<{ affected: number }>('postgres_delete_rows', { sql })
}

export function postgresExecSql(statements: string[]): Promise<{ affected: number; ran: number }> {
  return tauriInvoke<{ affected: number; ran: number }>('postgres_exec_sql', { statements })
}

export function postgresExecDdl(statements: string[]): Promise<{ affected: number; ran: number }> {
  return tauriInvoke<{ affected: number; ran: number }>('postgres_exec_ddl', { statements })
}

export function postgresUpdateRows(sql: string): Promise<{ affected: number }> {
  return tauriInvoke<{ affected: number }>('postgres_update_rows', { sql })
}

export function postgresInsertRows(sql: string): Promise<{ affected: number }> {
  return tauriInvoke<{ affected: number }>('postgres_insert_rows', { sql })
}

export function postgresDisconnect(): Promise<void> {
  return tauriInvoke<void>('postgres_disconnect')
}
