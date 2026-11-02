/**
 * Oracle 连库方言：连接串 + 字典列映射。
 * 查询语句的执行正本在 `src-tauri/src/oracle.rs`，这里只负责 IPC 和行 → Column。
 */
import type { LiveDbDialect } from '../dbDialect'
import { indexRowsFromGrid, mapMetaIndexes } from '../dbmeta'
import { mapOracleColumns } from '../oracleMeta'
import { oracleColumns, oracleConnect, oracleDisconnect, oracleQuery, oracleDeleteRows, oracleUpdateRows, oracleInsertRows, oracleExecSql, oracleExecDdl } from '../oracleIpc'

export const oracleDialect: LiveDbDialect = {
  id: 'oracle',
  label: 'Oracle',
  defaultPort: '1521',
  defaultUser: '',
  dbLabel: '服务名',
  dbPlaceholder: '如 ORCLPDB1',
  dbHint: '填主机 + SERVICE_NAME（如 ORCLPDB1）。只有 SID 写成 :ORCL，不要只填 DBeaver 的 TNS 名字。12.1+ 免客户端。11g：下「含 Oracle 11g 客户端」安装包，或本机已有 Instant Client / PL/SQL。',
  who: 'Oracle',
  emptyTitle: '当前用户下没有表。',
  emptyText: '列出的是 USER_TABLES。表在别的方案里时，请用那个方案的用户登录，或先 GRANT。',
  catalogHint: '查询 USER_TABLES / USER_TAB_COMMENTS …',
  driverName: 'Oracle 驱动',
  connect: (t) =>
    oracleConnect({
      host: t.host,
      port: t.port,
      user: t.user,
      password: t.password,
      service: t.db,
    }),
  fetchColumns: async (table) => mapOracleColumns(await oracleColumns(table)),
  // 索引结构走只读元数据查询（user_indexes + user_ind_columns），不用新增命令
  fetchIndexes: async (table) => {
    const name = table.split('.').pop()!.trim().replace(/'/g, "''")
    const grid = await oracleQuery(
      `SELECT i.table_name AS itbl, i.index_name AS iname, ` +
        `CASE WHEN i.uniqueness = 'UNIQUE' THEN 1 ELSE 0 END AS iuniq, ` +
        `ic.column_position AS iseq, ic.column_name AS icol ` +
        `FROM user_indexes i JOIN user_ind_columns ic ON ic.index_name = i.index_name ` +
        `WHERE i.table_name = UPPER('${name}') ` +
        `ORDER BY i.index_name, ic.column_position`,
    )
    return mapMetaIndexes(indexRowsFromGrid(grid.columns, grid.rows))
  },
  query: oracleQuery,
  deleteRows: oracleDeleteRows,
  updateRows: oracleUpdateRows,
  insertRows: oracleInsertRows,
  execSql: oracleExecSql,
  execDdl: oracleExecDdl,
  disconnect: oracleDisconnect,
}
