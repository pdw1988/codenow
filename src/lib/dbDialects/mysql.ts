/**
 * MySQL 连库方言：information_schema + 共用 mapMetaColumns。
 * 查询执行在 `src-tauri/src/mysql.rs`，这里只负责 IPC 和行 → Column。
 */
import type { LiveDbDialect } from '../dbDialect'
import { indexRowsFromGrid, mapMetaColumns, mapMetaIndexes } from '../dbmeta'
import { mysqlColumns, mysqlConnect, mysqlDisconnect, mysqlQuery, mysqlDeleteRows, mysqlUpdateRows, mysqlInsertRows, mysqlExecSql, mysqlExecDdl } from '../mysqlIpc'

export const mysqlDialect: LiveDbDialect = {
  id: 'mysql',
  label: 'MySQL',
  defaultPort: '3306',
  defaultUser: 'root',
  dbLabel: '数据库名',
  dbPlaceholder: '如 mall',
  dbHint: 'information_schema 按这个库名过滤。库不存在会直接连不上。',
  who: 'MySQL',
  emptyTitle: '这个库里没有表。',
  emptyText: '列出的是 TABLE_SCHEMA 等于上面数据库名的基表。空库或名字填错都会是一张空清单。',
  catalogHint: '查询 information_schema.TABLES …',
  driverName: 'MySQL 驱动',
  connect: (t) =>
    mysqlConnect({
      host: t.host,
      port: t.port,
      user: t.user,
      password: t.password,
      db: t.db,
    }),
  fetchColumns: async (table) => mapMetaColumns(await mysqlColumns(table)),
  // 索引结构走只读元数据查询（information_schema.STATISTICS 带列序），不用新增命令
  fetchIndexes: async (table) => {
    const name = table.split('.').pop()!.trim().replace(/'/g, "''")
    const grid = await mysqlQuery(
      `SELECT TABLE_NAME AS itbl, INDEX_NAME AS iname, ` +
        `CASE WHEN NON_UNIQUE = 0 THEN 1 ELSE 0 END AS iuniq, ` +
        `SEQ_IN_INDEX AS iseq, COLUMN_NAME AS icol ` +
        `FROM information_schema.STATISTICS ` +
        `WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${name}' ` +
        `ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    )
    return mapMetaIndexes(indexRowsFromGrid(grid.columns, grid.rows))
  },
  query: mysqlQuery,
  deleteRows: mysqlDeleteRows,
  updateRows: mysqlUpdateRows,
  insertRows: mysqlInsertRows,
  execSql: mysqlExecSql,
  execDdl: mysqlExecDdl,
  disconnect: mysqlDisconnect,
}
