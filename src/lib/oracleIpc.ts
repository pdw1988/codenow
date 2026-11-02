/**
 * 桌面版 Oracle 连库的 IPC 封装。
 *
 * 走 `tauriInvoke`（`window.__TAURI_INTERNALS__`），不要 `import('@tauri-apps/api/core')`：
 * Vite 预打包带 hash，开发时一重优化就 Failed to fetch。
 * 命令面：connect / columns / query / delete_rows / update_rows / insert_rows / exec_sql / exec_ddl / disconnect。
 * query 只放行 SELECT / WITH / SHOW，行数封顶，Rust 再验一遍。
 * delete_rows 只放行带 WHERE 的 DELETE；update_rows 只放行带 SET + WHERE 的 UPDATE。
 * insert_rows 只放行带 VALUES 的单条 INSERT（不跑 INSERT … SELECT）。
 * exec_sql 放行生成页确认后的 INSERT / 带 WHERE 的 UPDATE、DELETE。
 * exec_ddl 放行编辑表结构确认后的 ALTER TABLE / COMMENT ON。
 */
import type { OracleColumnRow } from './oracleMeta'
import type { MetaCountRow, MetaFkRow, MetaTableRow } from './dbmeta'
import type { QueryGrid } from './sqlReadonly'
import { tauriInvoke } from './tauriInvoke'

export interface OracleCatalog {
  version: string
  tables: MetaTableRow[]
  counts: MetaCountRow[]
  fks: MetaFkRow[]
}

export function oracleConnect(args: {
  host: string
  port: string
  user: string
  password: string
  service: string
}): Promise<OracleCatalog> {
  return tauriInvoke<OracleCatalog>('oracle_connect', args)
}

export function oracleColumns(table: string): Promise<OracleColumnRow[]> {
  return tauriInvoke<OracleColumnRow[]>('oracle_columns', { table })
}

export function oracleQuery(sql: string, loadAll = false): Promise<QueryGrid> {
  return tauriInvoke<QueryGrid>('oracle_query', { sql, loadAll })
}

export function oracleDeleteRows(sql: string): Promise<{ affected: number }> {
  return tauriInvoke<{ affected: number }>('oracle_delete_rows', { sql })
}

export function oracleExecSql(statements: string[]): Promise<{ affected: number; ran: number }> {
  return tauriInvoke<{ affected: number; ran: number }>('oracle_exec_sql', { statements })
}

export function oracleExecDdl(statements: string[]): Promise<{ affected: number; ran: number }> {
  return tauriInvoke<{ affected: number; ran: number }>('oracle_exec_ddl', { statements })
}

export function oracleUpdateRows(sql: string): Promise<{ affected: number }> {
  return tauriInvoke<{ affected: number }>('oracle_update_rows', { sql })
}

export function oracleInsertRows(sql: string): Promise<{ affected: number }> {
  return tauriInvoke<{ affected: number }>('oracle_insert_rows', { sql })
}

export function oracleDisconnect(): Promise<void> {
  return tauriInvoke<void>('oracle_disconnect')
}
