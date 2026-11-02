/**
 * PostgreSQL 连库方言：pg_catalog + format_type，类型词收成 DDL 写法。
 * 查询执行在 `src-tauri/src/postgres.rs`，这里只负责 IPC 和行 → Column。
 */
import type { LiveDbDialect } from '../dbDialect'
import { indexRowsFromGrid, mapMetaIndexes } from '../dbmeta'
import { mapPgColumns } from '../postgresMeta'
import { postgresColumns, postgresConnect, postgresDisconnect, postgresQuery, postgresDeleteRows, postgresUpdateRows, postgresInsertRows, postgresExecSql, postgresExecDdl } from '../postgresIpc'

export const postgresqlDialect: LiveDbDialect = {
  id: 'postgresql',
  label: 'PostgreSQL',
  defaultPort: '5432',
  defaultUser: 'postgres',
  dbLabel: '数据库名',
  dbPlaceholder: '如 mall',
  dbHint: '连的是这个库。列出 public 下的表（裸名）和其它用户 schema（schema.表）。系统目录不列。库不存在会直接连不上。',
  who: 'PostgreSQL',
  emptyTitle: '这个库里没有用户表。',
  emptyText: '列出的是 public 以及其它用户 schema 的基表。空库、名字填错、表都在系统 schema 里都会是一张空清单。',
  catalogHint: '查询 pg_catalog / information_schema.tables …',
  driverName: 'PostgreSQL 驱动',
  connect: (t) =>
    postgresConnect({
      host: t.host,
      port: t.port,
      user: t.user,
      password: t.password,
      db: t.db,
    }),
  fetchColumns: async (table) => mapPgColumns(await postgresColumns(table)),
  // 索引结构走只读元数据查询（pg_index + unnest(indkey) 保列序），不用新增命令。
  // 表名可带 schema（schema.表）：带了就精确到那个 schema，否则当前 schema
  fetchIndexes: async (table) => {
    const parts = table.trim().split('.')
    const tbl = (parts.pop() ?? '').trim().replace(/'/g, "''")
    const sch = (parts.pop() ?? '').trim().replace(/'/g, "''")
    const schemaCond = sch ? `n.nspname = '${sch}'` : 'n.nspname = current_schema()'
    const grid = await postgresQuery(
      `SELECT t.relname AS itbl, c.relname AS iname, ` +
        `CASE WHEN ix.indisunique THEN 1 ELSE 0 END AS iuniq, ` +
        `k.ord AS iseq, a.attname AS icol ` +
        `FROM pg_index ix ` +
        `JOIN pg_class c ON c.oid = ix.indexrelid ` +
        `JOIN pg_class t ON t.oid = ix.indrelid ` +
        `JOIN pg_namespace n ON n.oid = t.relnamespace ` +
        `CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ` +
        `LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum ` +
        `WHERE ${schemaCond} AND t.relname = '${tbl}' ` +
        `ORDER BY c.relname, k.ord`,
    )
    return mapMetaIndexes(indexRowsFromGrid(grid.columns, grid.rows))
  },
  query: postgresQuery,
  deleteRows: postgresDeleteRows,
  updateRows: postgresUpdateRows,
  insertRows: postgresInsertRows,
  execSql: postgresExecSql,
  execDdl: postgresExecDdl,
  disconnect: postgresDisconnect,
}
