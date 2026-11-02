/**
 * 连库查询的闸门：只放行只读语句。
 *
 * Rust 侧还会再验一遍——前端挡是为了立刻出中文，真正的边界在命令里。
 * 拆语句走 statements.ts 那一份扫描器，引号规则不另写一份。
 *
 * 只看首关键字不够：`WITH … INSERT`、`SELECT … FOR UPDATE` 首词仍是查询，
 * 必须再扫一遍裸代码里的写动词。
 */
import type { Column, Dialect } from '../types/schema'
import { applyPage, DIALECTS as SQL_DIALECTS } from './sqlgen/dialect'
import { type CmpOp, type OrderDir, renderCondition } from './sqlgen/executable'
import { codeMask, splitStatements } from './sqlgen/statements'

export const QUERY_ROW_CAP = 200
/** 「加载全部」的硬顶。再多请加 WHERE，不要无上限灌进窗口。 */
export const QUERY_ROW_CAP_ALL = 10_000

export interface QueryGrid {
  columns: string[]
  rows: string[][]
  truncated: boolean
  /** 这次查询用的行数封顶，给界面写「已截到 N」 */
  cap: number
}

const SHOW_LIKE = new Set(['SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'])

/** 出现在只读查询里就拒。FOR UPDATE / SELECT INTO / WITH…INSERT 都靠这个。 */
const WRITE = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'CREATE',
  'DROP',
  'ALTER',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'REPLACE',
  'CALL',
  'EXEC',
  'EXECUTE',
  'BEGIN',
  'DECLARE',
  'INTO',
])

export function assertReadonlySelect(sql: string): string {
  const text = sql.trim()
  if (!text) throw new Error('请输入一条查询')
  const stmts = splitStatements(text).filter((s) => firstBareWord(s.text))
  if (stmts.length === 0) throw new Error('请输入一条 SELECT / WITH 查询')
  if (stmts.length > 1) throw new Error('一次只跑一条语句，不要带第二段')
  const kind = stmts[0].kind
  const word = firstBareWord(stmts[0].text) ?? ''
  if (kind !== 'select' && !SHOW_LIKE.has(word)) {
    throw new Error(`只接受只读查询（SELECT / WITH / SHOW），不执行 ${word || kind.toUpperCase()}`)
  }
  // SHOW CREATE TABLE 是只读元数据，CREATE 不当写操作。
  if (!SHOW_LIKE.has(word)) {
    const write = firstWriteVerb(stmts[0].text)
    if (write) {
      throw new Error(`只接受只读查询（SELECT / WITH / SHOW），不执行 ${write}`)
    }
  }
  return text.replace(/;\s*$/, '')
}

/**
 * 从生成结果里抽出能丢给连库查询跑的那一条 SELECT。
 * 夹着 INSERT / UPDATE 就返回 null——那种走写命令，不走查询框。
 * 生成页带注释头、带「-- 1. 查询」，只取第一条真正的 SELECT。
 */
export function extractRunnableSelect(sql: string): string | null {
  const stmts = splitStatements(sql).filter((s) => s.kind)
  if (stmts.length === 0) return null
  if (stmts.some((s) => s.kind !== 'select')) return null
  try {
    return assertReadonlySelect(stmts[0].text)
  } catch {
    return null
  }
}

function firstWriteVerb(sql: string): string | null {
  const mask = codeMask(sql)
  let word = ''
  const flush = (): string | null => {
    if (!word) return null
    const u = word.toUpperCase()
    word = ''
    return WRITE.has(u) ? u : null
  }
  for (let i = 0; i < sql.length; i++) {
    if (!mask[i]) {
      const hit = flush()
      if (hit) return hit
      continue
    }
    const c = sql[i]
    if (/[A-Za-z_]/.test(c)) {
      word += c
      continue
    }
    const hit = flush()
    if (hit) return hit
  }
  return flush()
}

function firstBareWord(sql: string): string | null {
  const m = sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s+)*/g, '').match(/^[A-Za-z_]+/)
  return m ? m[0].toUpperCase() : null
}

/**
 * 点表或勾列后的查询。不传 columns 或空数组 = `SELECT *`（全选 / 还没动过）。
 * 列出字段时由调用方保证非空；全不选在界面挡住，不拿去跑。
 * `exprs` 有值时优先用（COUNT 等表达式），不再给列名加引号。
 */
export function previewSql(
  kind: Dialect,
  table: string,
  columns?: readonly string[],
  exprs?: readonly string[],
): string {
  // PG 非 public 表是 schema.table，整段加引号会变成 "audit.logs"（一张不存在的表）。
  const q = SQL_DIALECTS[kind].quote
  const from = table.split('.').map(q).join('.')
  if (exprs && exprs.length > 0) return `SELECT ${exprs.join(', ')} FROM ${from}`
  if (!columns || columns.length === 0) return `SELECT * FROM ${from}`
  return `SELECT ${columns.map(q).join(', ')} FROM ${from}`
}

export interface PreviewWhereCond {
  column: Column
  value: string
  op?: CmpOp
}

/**
 * 连库点表 / 勾列 / 条件拼出来的 SELECT。
 * conditions 空 = 不加 WHERE（点表默认）；有条件用 renderCondition（空值 → IS NULL）。
 * groupBy 有值时追加 GROUP BY（勾了 COUNT 且还勾了维度列）。
 *
 * orderBy / page 是界面上「排序 / 分页」那一块。顺序写死：
 * WHERE → GROUP BY → ORDER BY → 分页外包。ORDER BY 必须在外包之内——
 * Oracle 用 ROWNUM 外包一层，先截后排会截错行（而不是只乱序）。
 * 分页本身交给 applyPage，四种方言各自的写法在 dialect.ts，
 * 这里不写 if (kind === 'oracle')。page 不传 = 不分页，行数封顶仍在 query 命令里。
 */
export function previewSqlWithWhere(
  kind: Dialect,
  table: string,
  columns: readonly string[] | undefined,
  conditions: readonly PreviewWhereCond[],
  opts?: {
    exprs?: readonly string[]
    groupBy?: readonly string[]
    orderBy?: { column: string; dir: OrderDir }
    /** index 从 0 起。size <= 0 视作不分页 */
    page?: { size: number; index: number }
  },
): string {
  const base = previewSql(kind, table, columns, opts?.exprs)
  const parts = [base]
  if (conditions.length > 0) {
    const where = conditions
      .map((c) => renderCondition(c.column, c.value, kind, c.op ?? 'eq'))
      .join(' AND ')
    parts[0] = `${base} WHERE ${where}`
  }
  if (opts?.groupBy && opts.groupBy.length > 0) {
    const q = SQL_DIALECTS[kind].quote
    parts[0] = `${parts[0]} GROUP BY ${opts.groupBy.map(q).join(', ')}`
  }
  if (opts?.orderBy?.column) {
    // 分组时排序列可能是 COUNT 的别名 cnt，跟真列一样加引号（SELECT 里也是引号别名）
    const q = SQL_DIALECTS[kind].quote
    const dir = opts.orderBy.dir === 'asc' ? 'ASC' : 'DESC'
    parts[0] = `${parts[0]} ORDER BY ${q(opts.orderBy.column)} ${dir}`
  }
  const page = opts?.page
  if (page && page.size > 0) {
    return applyPage(kind, parts[0], {
      offset: Math.max(0, page.index) * page.size,
      limit: page.size,
    })
  }
  return parts[0]
}
