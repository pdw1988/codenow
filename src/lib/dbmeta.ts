/**
 * 连库导入共用的行映射：表清单 / 字段数 / 外键。
 *
 * 列对象形状（tname/tcmt、ftbl/fcol）各方言的字典查询都 AS 成这一套，
 * 壳只认这些函数。**字段类型怎么拼**是方言自己的事（Oracle 在 oracleMeta.ts）。
 *
 * MySQL 的 information_schema SQL 仍放在本文件，接入直连时在
 * `dbDialects/mysql.ts` 里引用，不要写进 DbConnect.tsx。
 */
import type { Column, ForeignKey } from '../types/schema'
import type { IndexDef } from './sqladvise'
import { toCamelCase, toJavaType } from './javaType'

/** 连接参数（密码只在调用现场传入，不进任何持久化结构） */
export interface DbTarget {
  host: string
  port: string
  user: string
  password: string
  db: string
}

/**
 * 连接串。用户名/密码必须 encodeURIComponent：密码里有 @ : / 时
 * 裸拼会让 URL 解析把密码截断在第一个特殊字符上。
 */
export function buildConnUrl(t: DbTarget): string {
  return `mysql://${encodeURIComponent(t.user)}:${encodeURIComponent(t.password)}@${t.host.trim()}:${t.port.trim()}/${t.db.trim()}`
}

/** 界面上展示用的地址标签，永远不含密码 */
export function describeConn(
  t: Pick<DbTarget, 'host' | 'port' | 'db'> & { fileBased?: boolean },
): string {
  if (t.fileBased) return t.db.trim()
  return `${t.db.trim()}@${t.host.trim()}:${t.port.trim()}`
}

/* ================= information_schema 查询（唯一正本） ================= */

/** 列名全部显式 AS 成小写别名：行对象的键不依赖驱动对列名大小写的处理方式。
 *  MySQL 直连接入时在 `dbDialects/mysql.ts` 引用这些常量，不要写进 DbConnect。 */
export const SQL_TABLE_LIST =
  'SELECT TABLE_NAME AS `tname`, TABLE_COMMENT AS `tcmt` FROM information_schema.TABLES ' +
  "WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"

/** 字段数用一条聚合一次拿全——勾选前列表就能显示规模，逐表拉字段留到导入时 */
export const SQL_COLUMN_COUNTS =
  'SELECT TABLE_NAME AS `tname`, COUNT(*) AS `n` FROM information_schema.COLUMNS ' +
  'WHERE TABLE_SCHEMA = ? GROUP BY TABLE_NAME'

export const SQL_TABLE_COLUMNS =
  'SELECT COLUMN_NAME AS `cname`, COLUMN_TYPE AS `ctype`, IS_NULLABLE AS `cnull`, ' +
  'COLUMN_DEFAULT AS `cdef`, COLUMN_COMMENT AS `ccmt`, COLUMN_KEY AS `ckey`, EXTRA AS `cextra` ' +
  'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ' +
  'ORDER BY ORDINAL_POSITION'

/** 全库外键连接时一次拉完（元数据量很小），预览随勾选过滤 */
export const SQL_FOREIGN_KEYS =
  'SELECT CONSTRAINT_NAME AS `cname`, TABLE_NAME AS `ftbl`, COLUMN_NAME AS `fcol`, ' +
  'REFERENCED_TABLE_NAME AS `ttbl`, REFERENCED_COLUMN_NAME AS `tcol` ' +
  'FROM information_schema.KEY_COLUMN_USAGE ' +
  'WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL ' +
  'ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION'

export const SQL_VERSION = 'SELECT VERSION() AS `v`'

/* ================= 行对象 → 领域类型 ================= */

export interface MetaTableRow {
  tname: string | null
  tcmt: string | null
}

export interface MetaCountRow {
  tname: string | null
  n: number | string | null
}

export interface MetaColumnRow {
  cname: string | null
  ctype: string | null
  cnull: string | null
  cdef: string | null
  ccmt: string | null
  ckey: string | null
  cextra: string | null
}

export interface MetaFkRow {
  cname: string | null
  ftbl: string | null
  fcol: string | null
  ttbl: string | null
  tcol: string | null
}

/** 索引元数据，一行 = 索引的一列。各方言的字典查询都 AS 成这一套 */
export interface MetaIndexRow {
  itbl: string | null
  iname: string | null
  /** 1 = 唯一（方言里用 CASE 收成 0/1） */
  iuniq: number | string | null
  /** 列在索引内的序号，从 1 起（SQLite 从 0 起，映射时归一） */
  iseq: number | string | null
  /** 表达式索引的列不是裸列名，会是 NULL */
  icol: string | null
}

const s = (v: string | null): string => (typeof v === 'string' ? v.trim() : '')

/** 表清单。空注释和字面 'VIEW' 泄漏都洗掉；坏行（没名字）跳过 */
export function mapMetaTables(rows: MetaTableRow[]): Array<{ name: string; comment?: string }> {
  const out: Array<{ name: string; comment?: string }> = []
  for (const r of rows) {
    const name = s(r.tname)
    if (!name) continue
    const comment = s(r.tcmt)
    out.push({ name, comment: comment || undefined })
  }
  return out
}

/** 字段数聚合 → Map。COUNT(*) 在不同驱动下可能回传字符串，统一转数字 */
export function mapMetaCounts(rows: MetaCountRow[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    const name = s(r.tname)
    if (!name) continue
    const n = Number(r.n)
    if (Number.isFinite(n)) out.set(name, n)
  }
  return out
}

/**
 * 逐表字段。COLUMN_KEY='PRI' 是主键；EXTRA 含 auto_increment 才算自增——
 * 主键不一定自增（业务号），自增一定是主键但别反着推。
 * 类型/默认值原样保留（含 CURRENT_TIMESTAMP 这类字面量），跟 DDL 导入同一口径。
 */
export function mapMetaColumns(rows: MetaColumnRow[]): Column[] {
  const out: Column[] = []
  for (const r of rows) {
    const name = s(r.cname)
    const type = s(r.ctype)
    if (!name || !type) continue
    out.push({
      name,
      type,
      nullable: s(r.cnull).toUpperCase() === 'YES',
      isPrimaryKey: s(r.ckey).toUpperCase() === 'PRI',
      isAutoIncrement: /auto_increment/i.test(s(r.cextra)),
      // UNI = 单列唯一索引；PRI 已经是主键。MUL = 普通索引（列值可重复）。
      isUnique: s(r.ckey).toUpperCase() === 'UNI',
      isIndexed: s(r.ckey).toUpperCase() === 'MUL',
      defaultValue: s(r.cdef) || undefined,
      comment: s(r.ccmt) || undefined,
      javaField: toCamelCase(name),
      javaType: toJavaType(type),
    })
  }
  return out
}

/**
 * 外键。复合外键（一个约束多列）在 information_schema 里是多行——
 * 按每列一对出一条 ForeignKey，跟 ddlParser「definition[0] 单列」的既有模型一致：
 * JOIN 生成本来就按列对工作，合并成一条反而要发明新的列分隔约定。
 */
export function mapMetaForeignKeys(rows: MetaFkRow[]): ForeignKey[] {
  const out: ForeignKey[] = []
  for (const r of rows) {
    const fromTable = s(r.ftbl)
    const fromColumn = s(r.fcol)
    const toTable = s(r.ttbl)
    const toColumn = s(r.tcol)
    if (!fromTable || !fromColumn || !toTable || !toColumn) continue
    out.push({
      fromTable,
      fromColumn,
      toTable,
      toColumn,
      constraintName: s(r.cname) || undefined,
      confidence: 'constraint',
    })
  }
  return out
}

/**
 * 索引行 → IndexDef。按索引名分组、按列序拼出复合索引结构。
 * 表达式索引的列（icol 为 NULL）跳过——sqladvise 只做裸列名匹配。
 * SQLite 的 iseq 从 0 起、其余方言从 1 起，这里只保序不保值。
 */
export function mapMetaIndexes(rows: MetaIndexRow[]): IndexDef[] {
  const byName = new Map<string, { table: string; unique: boolean; cols: Array<{ seq: number; col: string }> }>()
  for (const r of rows) {
    const name = s(r.iname)
    const table = s(r.itbl)
    const col = s(r.icol)
    if (!name || !table) continue
    let entry = byName.get(name)
    if (!entry) {
      entry = { table, unique: Number(r.iuniq ?? 0) === 1, cols: [] }
      byName.set(name, entry)
    }
    if (!col) continue // 表达式索引列：跳过，不影响其余列的顺序
    const seq = Number(r.iseq ?? 0)
    entry.cols.push({ seq: Number.isFinite(seq) ? seq : entry.cols.length, col })
  }
  const out: IndexDef[] = []
  for (const [name, e] of byName) {
    e.cols.sort((a, b) => a.seq - b.seq)
    if (e.cols.length === 0) continue // 整条索引都是表达式列（icol 全 NULL）：没有可匹配的裸列名，不出
    out.push({ table: e.table, name, columns: e.cols.map((c) => c.col), unique: e.unique })
  }
  return out
}

/**
 * spec.query（QueryGrid：列名 + 字符串行）→ MetaIndexRow[]。
 * Oracle / MySQL / PG 的索引元数据都走各自方言的只读查询拿，
 * 按结果列名取值，方言不用各自拼行对象。
 */
export function indexRowsFromGrid(
  columns: readonly string[],
  rows: readonly string[][],
): MetaIndexRow[] {
  const at = (row: string[], name: string): string | null => {
    const i = columns.findIndex((c) => c.toLowerCase() === name)
    return i >= 0 ? (row[i] ?? null) : null
  }
  return rows.map((r) => ({
    itbl: at(r, 'itbl'),
    iname: at(r, 'iname'),
    iuniq: at(r, 'iuniq'),
    iseq: at(r, 'iseq'),
    icol: at(r, 'icol'),
  }))
}
