/**
 * SQLite 连库方言：本机 `.db` 文件 + sqlite_master / PRAGMA。
 * 查询执行在 `src-tauri/src/sqlite.rs`，这里只负责 IPC。
 *
 * 表单是文件路径模式（fileBased）：不填主机/端口/用户/密码。
 */
import type { LiveDbDialect } from '../dbDialect'
import { mapMetaColumns, mapMetaIndexes } from '../dbmeta'
import {
  sqliteColumns,
  sqliteConnect,
  sqliteDisconnect,
  sqliteIndexes,
  sqliteQuery,
  sqliteDeleteRows,
  sqliteUpdateRows,
  sqliteInsertRows,
  sqliteExecSql,
  sqliteExecDdl,
} from '../sqliteIpc'

export const sqliteDialect: LiveDbDialect = {
  id: 'sqlite',
  label: 'SQLite',
  fileBased: true,
  defaultPort: '0',
  defaultUser: 'sqlite',
  dbLabel: '数据库文件',
  dbPlaceholder: '如 C:\\data\\app.db',
  dbHint: '填本机 .db / .sqlite 文件的完整路径。文件必须已存在；不连应用自己的 cache.db。',
  who: 'SQLite 文件',
  emptyTitle: '这个库里没有用户表。',
  emptyText: '列出的是 sqlite_master 里的基表（不含 sqlite_* 系统表）。空库或路径指错都会是一张空清单。',
  catalogHint: '查询 sqlite_master / PRAGMA table_info …',
  driverName: 'SQLite 驱动',
  connect: (t) =>
    sqliteConnect({
      host: t.host,
      port: t.port,
      user: t.user,
      password: t.password,
      db: t.db,
    }),
  fetchColumns: async (table) => mapMetaColumns(await sqliteColumns(table)),
  fetchIndexes: async (table) => mapMetaIndexes(await sqliteIndexes(table)),
  query: sqliteQuery,
  deleteRows: sqliteDeleteRows,
  updateRows: sqliteUpdateRows,
  insertRows: sqliteInsertRows,
  execSql: sqliteExecSql,
  execDdl: sqliteExecDdl,
  disconnect: sqliteDisconnect,
}
