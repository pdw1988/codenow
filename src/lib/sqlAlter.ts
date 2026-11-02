/**
 * 编辑表结构把增量 DDL 丢给当前连接（PRD 19.8）。
 * 连库页也可粘贴 ALTER TABLE / COMMENT ON / CREATE INDEX / ANALYZE，走同一条闸门。
 *
 * 2026-09-24 起同一扇门放行**手写 DML 与 CTAS**：带 WHERE 的 UPDATE / DELETE、
 * 带 INTO 的 INSERT、CREATE TABLE … AS SELECT（备份表）。以前连发
 * 三条都被拒（CTAS 备份、重置状态的 UPDATE、清关联数据的 DELETE）——生成页
 * 能跑的语句，到连库页手写反而不行，等于把用户推回 PL/SQL Developer。
 * SQL 框继续只读；生成页 `exec_sql` 不能拿来跑 DDL（那条闸门在 assertGenScript，
 * 到今天仍然只有 INSERT / 带 WHERE 的 UPDATE / DELETE）。
 */
import type { Dialect } from '../types/schema'
import { DIALECTS } from './sqlgen/dialect'
import { codeMask, splitStatements } from './sqlgen/statements'
import { NEED_SESSION, type DbSession } from './sqlExec'
import { assertReadonlySelect } from './sqlReadonly'

export const ALTER_STMT_CAP = 80

/** Oracle 脚本末尾常带 COMMIT。DDL 已经隐式提交，闸门也不放行 COMMIT，拆的时候丢掉。 */
const IGNORE = new Set(['COMMIT', 'ROLLBACK'])

export interface AlterPlan {
  statements: string[]
  /** 含 DROP COLUMN / Oracle DROP (col)。确认框要单独点名：列里的数据一起没 */
  drops: boolean
  /** UPDATE / DELETE / INSERT 的条数。确认框要点名：行数据会改会删，且每条跑完立即提交 */
  dml: number
  /** CREATE TABLE … AS SELECT 的条数。确认框要点名：会按 SELECT 的结果建新表 */
  ctas: number
}

function isIgnorable(sql: string): boolean {
  const first = firstKeywords(sql, 1)[0]
  return Boolean(first && IGNORE.has(first))
}

/** ALTER TABLE … DROP … 才算删列。DROP TABLE 进不了这条（assert 已经拒了）。 */
export function hasDropColumn(sql: string): boolean {
  const words = firstKeywords(sql, 8)
  return words[0] === 'ALTER' && words[1] === 'TABLE' && words.includes('DROP')
}

/** 裸代码里前 n 个关键字。COMMENT ON COLUMN 要看第三个词。 */
function firstKeywords(sql: string, n: number): string[] {
  const mask = codeMask(sql)
  const out: string[] = []
  let word = ''
  const flush = () => {
    if (!word) return
    if (out.length < n) out.push(word.toUpperCase())
    word = ''
  }
  for (let i = 0; i < sql.length && out.length < n; i++) {
    if (!mask[i]) {
      flush()
      continue
    }
    const c = sql[i]
    if (/[A-Za-z_]/.test(c)) {
      word += c
      continue
    }
    flush()
  }
  flush()
  return out
}

/**
 * CREATE [UNIQUE|BITMAP] INDEX 才算建索引。
 *
 * 放它进来是因为「索引落地」清单的承诺是「照着这份就能把索引建上」，
 * 而用户不想为了建索引再开一个客户端。风险面很小：建索引不带子查询、
 * 不碰行数据，最坏是建出一个没人用的索引。
 *
 * `INDEX` 必须出现在前 4 个词里，它前面只许 `UNIQUE` / `BITMAP`
 * （Oracle 位图索引）。所以 `CREATE TABLE`、`CREATE OR REPLACE …`、
 * `CREATE USER`、`CREATE DATABASE` 一条都进不来——它们压根没有 INDEX 这个词。
 * PG 的 `CONCURRENTLY` / `IF NOT EXISTS` 在 INDEX 后面，不影响判断。
 */
function isCreateIndex(words: readonly string[]): boolean {
  if (words[0] !== 'CREATE') return false
  const at = words.indexOf('INDEX', 1)
  if (at < 1 || at > 3) return false
  return words.slice(1, at).every((w) => w === 'UNIQUE' || w === 'BITMAP')
}

/**
 * CREATE TABLE … AS SELECT（CTAS）才算建表。备份一张表（`TMP_XXX_BAK_0924`）是
 * 连库页最常见的建表诉求，普通 CREATE TABLE（列全手写）仍然不收——手写列的
 * 建表是设计动作，该走「编辑表结构」或真正的建表工具。
 *
 * 判据：`AS` 必须出现，且它后面第一个词是 `SELECT` / `WITH`（CTE）。表名可带
 * schema、可带 PG 的 `IF NOT EXISTS`；`AS (SELECT …)` 的括号不进词表，照样判得出。
 * 名字里的数字不进 firstKeywords 的词表，只会把长表名拆成几段——
 * `T_SHOP_ORDER_APPLY` 就拆成 5 段，所以词数上限给 16：schema.长表名
 * 加 IF NOT EXISTS 也够用，再长就当普通 CREATE TABLE 拒掉，宁枉勿纵。
 * `CREATE GLOBAL TEMPORARY` / `CREATE OR REPLACE` 的第二个词就不是 TABLE，进不来。
 */
function isCtas(words: readonly string[]): boolean {
  if (words[0] !== 'CREATE' || words[1] !== 'TABLE') return false
  const at = words.indexOf('AS', 2)
  if (at < 2) return false
  return words[at + 1] === 'SELECT' || words[at + 1] === 'WITH'
}

/**
 * 裸代码里要有关键字，且后面还得有内容。字符串 / 注释里的字不算——
 * SET 清单里夹着 `-- , USER_CODE = …` 这样的注释行不能算有 SET 之外的破绽，
 * 反过来注释里写着 WHERE 也不能骗过「必须带 WHERE」。
 * Rust 侧同名函数（sql_write.rs）的镜像，判据两边必须一字不差。
 */
function hasKeywordPredicate(sql: string, keyword: string): boolean {
  const mask = codeMask(sql)
  let word = ''
  let after = false
  const flush = () => {
    if (!word) return
    if (word.toUpperCase() === keyword) after = true
    word = ''
  }
  for (let i = 0; i < sql.length; i++) {
    if (!mask[i]) {
      flush()
      continue
    }
    const c = sql[i]
    if (/[A-Za-z_]/.test(c)) {
      word += c
      continue
    }
    flush()
    if (after && !/\s/.test(c) && c !== ';') return true
  }
  flush()
  return false
}

export function assertAlterStmt(sql: string): string {
  const text = sql.trim()
  if (!text) throw new Error('没有要执行的语句')
  const parts = splitStatements(text).filter((s) => s.kind)
  if (parts.length === 0) throw new Error('没有要执行的语句')
  if (parts.length > 1) throw new Error('一次只跑一条语句，不要带第二段')
  // 第 16 个词是给 CTAS 留的：schema.长表名 会被数字拆成好几段（见 isCtas 的注释）
  const words = firstKeywords(parts[0].text, 16)
  const first = words[0]
  if (first === 'ALTER') {
    if (words[1] !== 'TABLE') {
      throw new Error('只执行 ALTER TABLE，不跑 ALTER SESSION / INDEX / USER')
    }
    return text.replace(/;\s*$/, '')
  }
  if (first === 'COMMENT') {
    if (words[1] !== 'ON' || (words[2] !== 'COLUMN' && words[2] !== 'TABLE')) {
      throw new Error('只执行 COMMENT ON COLUMN / TABLE')
    }
    return text.replace(/;\s*$/, '')
  }
  /*
   * ANALYZE 是给 SQLite 那条路补的：建完索引不统计，优化器照旧统计信息走，
   * 新索引等于没建。它不改行数据，最坏是统计得慢一点。
   */
  if (first === 'ANALYZE' || isCreateIndex(words)) return text.replace(/;\s*$/, '')
  /* 手写 DML：UPDATE / DELETE 必须带 WHERE——全表改删是这条路上最贵的失误，
   * 要做就到勾选行或生成页里去，那里有确认框点名影响面。INSERT 要有 INTO。 */
  if (first === 'UPDATE') {
    if (!hasKeywordPredicate(text, 'SET')) throw new Error('拒绝没有 SET 的 UPDATE')
    if (!hasKeywordPredicate(text, 'WHERE')) throw new Error('拒绝没有 WHERE 的 UPDATE')
    return text.replace(/;\s*$/, '')
  }
  if (first === 'DELETE') {
    if (!hasKeywordPredicate(text, 'WHERE')) throw new Error('拒绝没有 WHERE 的 DELETE')
    return text.replace(/;\s*$/, '')
  }
  if (first === 'INSERT') {
    if (!hasKeywordPredicate(text, 'INTO')) throw new Error('拒绝没有 INTO 的 INSERT')
    return text.replace(/;\s*$/, '')
  }
  if (first === 'CREATE' && words[1] === 'TABLE' && !isCtas(words)) {
    throw new Error('CREATE TABLE 只放行 … AS SELECT（把查询结果建成表）；普通建表不在这里跑')
  }
  if (first === 'CREATE' && isCtas(words)) return text.replace(/;\s*$/, '')
  throw new Error(
    first
      ? `只执行 ALTER TABLE / COMMENT ON / CREATE INDEX / ANALYZE / UPDATE / DELETE / INSERT / CREATE TABLE AS SELECT，不跑 ${first}`
      : '没有要执行的语句',
  )
}

/**
 * 查询框分流（2026-09-24 起查询框收一切语句）：整段输入里的每一条都过只读闸门
 * 才算查询，有一条不是就整份走写路径——planAlter 会说出哪一条为什么不行，
 * 绝不悄悄挑出能跑的那几条。空段 / 纯注释按查询处理，让只读闸门去说
 * 「请输入一条 SELECT」。Rust 的 assert_readonly_select 是真正的边界；
 * 这里挡是为了分流不惊动命令层。
 */
export function looksReadonly(sql: string): boolean {
  const parts = splitStatements(sql).filter((s) => s.kind)
  if (parts.length === 0) return true
  return parts.every((s) => {
    try {
      assertReadonlySelect(s.text)
      return true
    } catch {
      return false
    }
  })
}

/**
 * 查询框输入的最终分流。「UPDATE …; SELECT …」写完顺手回查是连库页最常见的
 * 写法，过去整份被确认链拒掉（planAlter 不收 SELECT），用户只能框选分段跑。
 * 现在把纯 SELECT 拎出来留给执行完自动回查，写语句整份进确认链——
 * 烂语句（SELCT、没 WHERE 的 UPDATE）两头都不会收，仍会被点名。
 */
export function splitRunInput(text: string): { writes: string | null; lastSelect: string | null } {
  if (looksReadonly(text)) return { writes: null, lastSelect: null }
  const parts = splitStatements(text).filter((s) => s.kind)
  const isSel = (t: string): boolean => {
    try {
      assertReadonlySelect(t)
      return true
    } catch {
      return false
    }
  }
  const writes = parts.filter((s) => !isSel(s.text))
  const sels = parts.filter((s) => isSel(s.text))
  if (writes.length === 0 || sels.length === 0) return { writes: text, lastSelect: null }
  return {
    writes: writes.map((s) => s.text).join(';\n') + ';',
    lastSelect: sels[sels.length - 1]!.text,
  }
}

export function planAlter(sql: string): AlterPlan {
  const all = splitStatements(sql).filter((s) => s.kind && !isIgnorable(s.text))
  if (all.length === 0) {
    throw new Error('没有可执行的语句。主键/自增变化要手工处理；只有注释 / COMMIT 的输入不会执行')
  }
  const statements = all.map((s) => assertAlterStmt(s.text))
  if (statements.length > ALTER_STMT_CAP) {
    throw new Error(`一次最多 ${ALTER_STMT_CAP} 条`)
  }
  const kindOf = (s: string) => firstKeywords(s, 1)[0] ?? ''
  return {
    statements,
    drops: statements.some(hasDropColumn),
    dml: statements.filter((s) => ['UPDATE', 'DELETE', 'INSERT'].includes(kindOf(s))).length,
    ctas: statements.filter((s) => isCtas(firstKeywords(s, 16))).length,
  }
}

/**
 * 脚本里有没有 CREATE INDEX。建索引不改任何列，字段表不用重拉；但索引字典
 * （体检用的那份）必须作废，否则同一个索引会一直被报下去。
 */
export function hasCreateIndex(sql: string): boolean {
  return splitStatements(sql).some((s) => isCreateIndex(firstKeywords(s.text, 5)))
}

/**
 * ALTER TABLE 后面的表名（可带 schema，引号会剥掉）。
 * 粘贴执行后拿去对缓存里已导入的表重拉字典。
 */
export function alterTableTargets(sql: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const s of splitStatements(sql)) {
    const words = firstKeywords(s.text, 2)
    if (words[0] !== 'ALTER' || words[1] !== 'TABLE') continue
    const name = qualifiedNameAfterTable(s.text)
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names
}

function qualifiedNameAfterTable(sql: string): string | null {
  const mask = codeMask(sql)
  let word = ''
  let afterTable = -1
  for (let i = 0; i <= sql.length; i++) {
    const inCode = i < sql.length && mask[i]
    const c = inCode ? sql[i] : ''
    if (/[A-Za-z_]/.test(c)) {
      word += c
      continue
    }
    if (word.toUpperCase() === 'TABLE') {
      afterTable = i
      break
    }
    word = ''
  }
  if (afterTable < 0) return null
  let i = afterTable
  const skipWs = () => {
    while (i < sql.length && /\s/.test(sql[i])) i++
  }
  const readPart = (): string | null => {
    skipWs()
    if (i >= sql.length) return null
    const q = sql[i]
    // 双引号 / 反引号里的标识符在 codeMask 里不是「裸代码」
    if (q === '"' || q === '`') {
      i++
      let s = ''
      while (i < sql.length && sql[i] !== q) {
        s += sql[i]
        i++
      }
      if (i < sql.length && sql[i] === q) i++
      return s || null
    }
    if (!mask[i]) return null
    let s = ''
    while (i < sql.length && mask[i] && /[A-Za-z0-9_$#]/.test(sql[i])) {
      s += sql[i]
      i++
    }
    return s || null
  }
  const a = readPart()
  if (!a) return null
  skipWs()
  if (i < sql.length && sql[i] === '.') {
    i++
    const b = readPart()
    if (b) return `${a}.${b}`
  }
  return a
}

export function alterDisabledReason(args: {
  sql: string
  pageDialect: Dialect
  session: DbSession | null
  isTauri: boolean
  invalid?: string
}): string | null {
  if (args.invalid) return args.invalid
  if (!args.isTauri) return '浏览器模式没有驱动，请用桌面版'
  if (!args.sql.trim()) return '没有可执行的语句。主键/自增变化要手工处理；只有注释 / COMMIT 的输入不会执行'
  try {
    planAlter(args.sql)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  if (!args.session) return `${NEED_SESSION}。选一个连接，或到「连库查询」连上`
  if (args.session.kind !== args.pageDialect) {
    const want = DIALECTS[args.pageDialect].label
    const live = DIALECTS[args.session.kind].label
    return `当前连的是 ${live}，这份增量 DDL 是 ${want}。把上面的方言改成 ${live}，或到连库页换连接`
  }
  return null
}
