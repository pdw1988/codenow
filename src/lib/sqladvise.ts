/**
 * 手写 SQL 的静态优化建议（连库查询页）——「SQL 体检」。
 *
 * 定位：替 DBA 做日常 SQL 巡检里最有把握的那 80%，不是执行计划替代品。
 * 每条建议都给「问题 → 为什么 → 可执行的修复（DDL / 改写 SQL / 操作）」，
 * 由 UI 明确提示：上库前请用执行计划验证。
 *
 * 两类依据：
 * ① 文本规则（不需要连库）：SELECT *、前导 %% LIKE、NOT IN 子查询、深分页、
 *    OR 混列、IN 列表超长、函数包列……
 * ② 结合库内元数据（colsOf / indexesOf 懒喂进来）：等值列有没有索引、
 *    复合索引最左前缀、JOIN 列有没有索引、隐式类型转换（对照字段类型）、
 *    覆盖索引机会、ORDER BY 是否可走索引。
 *
 * 解析复用 sqlhint 的等长掩码（字符串/注释抹成等长空白）：结构在掩码上切，
 * 字面量内容按同偏移回原文读。所有规则尽力而为——解析不动就少出建议，绝不抛错；
 * 误报一次比少报一次更伤信任。
 */
import { maskLiterals } from './sqlhint'
import type { Column, Dialect } from '../types/schema'

/* ================= 对外类型 ================= */

/** 一条索引（来自连接库的元数据）。columns 按索引内列顺序 */
export interface IndexDef {
  /** 所属表名（元数据原样，匹配时大小写不敏感） */
  table: string
  name: string
  columns: string[]
  unique: boolean
}

export type AdvSeverity = 'high' | 'mid' | 'low' | 'info'

export interface SqlAdvice {
  /** 规则 id，稳定不翻译（测试与去重用） */
  id: string
  severity: AdvSeverity
  /** 一句话结论 */
  title: string
  /** 机制解释：为什么会拖慢 / 出错 */
  why: string
  /** 触发位置，如 `WHERE t.order_no`、`SELECT *` */
  scene?: string
  /** 修复：可执行的 DDL / 改写 SQL，或具体操作说明 */
  fix?: string
  /** fix 可以直接执行的 SQL（UI 给复制按钮）还是操作说明 */
  fixKind?: 'sql' | 'text'
  /**
   * 触发片段在 SQL 里的位置（字符偏移，掩码与原文等长所以通用）。
   * UI 拿它在输入框里选中这段——点建议就跳到出错的地方，不用自己在几十行里找。
   */
  at?: { start: number; end: number }
  /**
   * 一键改写：find 是 SQL 里要找的 token、replace 是换上去的文本。
   * 目前只有 SELECT * 展开用。不存偏移存 token——用户多半已经改过别处，
   * 偏移早不可信；应用时在 SELECT 段里现找，找不到就返回 null 不动 SQL。
   */
  apply?: { find: string; replace: string }
}

/**
 * 一条「该加但还没加」的索引。DDL 已经按方言生成好，抄走就能执行。
 *
 * 之所以单独列一份：建议是按规则一条条报的，同一条 `t_order(order_no)` 会被
 * 「等值条件没有索引」和「JOIN 关联列没有索引」同时指出来，用户看到的还是
 * 「给这个列建索引」这句话，得自己在十几条建议里翻哪几个列要建。
 */
export interface IndexNeed {
  /** 表名（元数据原样） */
  table: string
  /** 索引列，按建议顺序（等值列在前、排序列在后） */
  cols: string[]
  /** 建索引的完整语句。方言相关：MySQL 是 ALTER TABLE ADD INDEX、SQLite 末尾还带 ANALYZE */
  ddl: string
  /** 是哪几条建议把它推出来的（同一条索引常被多条规则同时指出来） */
  reasons: { id: string; title: string; scene?: string }[]
}

export interface AdvResult {
  advice: SqlAdvice[]
  /** 上面建议里凡是要建索引的，按表 + 列去重聚成一份落地清单 */
  indexes: IndexNeed[]
}

export interface AdvCtx {
  dialect: Dialect
  /** 表名（任意大小写）→ 字段。拿不到（还没拉）就 undefined，相关规则闭嘴 */
  colsOf?: (table: string) => Column[] | undefined
  /** 表名（任意大小写）→ 索引。同上 */
  indexesOf?: (table: string) => IndexDef[] | undefined
}

type Resolver = (tok: string) => { table: string; col: string; colDef?: Column }

const SEV_ORDER: Record<AdvSeverity, number> = { high: 0, mid: 1, low: 2, info: 3 }

/* ================= 基础工具 ================= */

/** 去掉标识符的引号包裹（Oracle "X" / MySQL `x` / [x]） */
function stripIdent(t: string): string {
  return t.trim().replace(/^["`[]+/, '').replace(/["`\]]+$/, '')
}

const NUM_TYPE = /\b(number|decimal|numeric|int|integer|bigint|smallint|tinyint|float|double|real|money)\b/i
const STR_TYPE = /\b(char|varchar2|varchar|nchar|nvarchar|text|clob|nclob|string)\b/i

const isNumericCol = (c: Column | undefined): boolean => !!c && NUM_TYPE.test(c.type)
const isStringCol = (c: Column | undefined): boolean => !!c && STR_TYPE.test(c.type)

/** 主键列本身就是 rowid / 聚簇索引，等值条件永远有得走 */
function isPkCol(cols: Column[] | undefined, col: string): boolean {
  return !!cols?.some((c) => c.isPrimaryKey && c.name.toLowerCase() === col.toLowerCase())
}

/** 某列是否是任一索引的第一列（最左前缀命中） */
function leadingIndex(idxs: IndexDef[] | undefined, col: string): IndexDef | null {
  for (const ix of idxs ?? []) {
    if (ix.columns[0]?.toLowerCase() === col.toLowerCase()) return ix
  }
  return null
}

/** 某列是否出现在任一索引里（任意位置） */
function inAnyIndex(idxs: IndexDef[] | undefined, col: string): IndexDef | null {
  for (const ix of idxs ?? []) {
    if (ix.columns.some((c) => c.toLowerCase() === col.toLowerCase())) return ix
  }
  return null
}

/* ================= 切片与顶层扫描 ================= */

interface Span {
  start: number
  end: number
}

interface Clauses {
  select: Span | null
  from: Span | null
  where: Span | null
  groupBy: Span | null
  having: Span | null
  orderBy: Span | null
  /** limit / offset / fetch first 混合区 */
  limit: Span | null
}

/** 括号深度：掩码里没有字符串和注释，深度只受真实表达式影响 */
function depthAt(text: string, upto: number): number {
  let d = 0
  for (let i = 0; i < upto && i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') d++
    else if (ch === ')') d = Math.max(0, d - 1)
  }
  return d
}

/** 整体是否被一层括号包住（首字符的配对括号恰在末尾） */
function wrappedInParens(text: string): boolean {
  if (!text.startsWith('(') || !text.endsWith(')')) return false
  let d = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') d++
    else if (text[i] === ')') {
      d--
      if (d === 0) return i === text.length - 1
    }
  }
  return false
}

interface KwHit {
  kw: string
  idx: number
  end: number
}

const CLAUSE_RE =
  /\b(with|select|from|where|group\s+by|having|order\s+by|limit|offset|fetch|union|intersect|minus)\b/gi

/** 找顶层子句边界。UNION / INTERSECT / MINUS 之后的分支不分析（只对第一段出建议） */
function findClauses(masked: string): Clauses {
  const hits: KwHit[] = []
  CLAUSE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CLAUSE_RE.exec(masked))) {
    if (depthAt(masked, m.index) !== 0) continue
    hits.push({ kw: m[1]!.toLowerCase().replace(/\s+/g, ' '), idx: m.index, end: m.index + m[0]!.length })
  }
  const empty: Clauses = {
    select: null, from: null, where: null, groupBy: null, having: null, orderBy: null, limit: null,
  }
  const stop =
    hits.find((h) => h.kw === 'union' || h.kw === 'intersect' || h.kw === 'minus')?.idx ??
    masked.length
  const sel = hits.find((h) => h.kw === 'select' && h.idx < stop)
  if (!sel) return empty
  const nexts = hits.filter((h) => h.idx > sel.idx && h.idx < stop)
  const pick = (kw: string): Span | null => {
    const hit = hits.find((h) => h.kw === kw && h.idx > sel.idx && h.idx < stop)
    if (!hit) return null
    const after = hits.filter((h) => h.idx > hit.idx && h.idx < stop)
    return { start: hit.end, end: after.length ? after[0]!.idx : stop }
  }
  // limit / offset / fetch 是同一尾巴的三种写法，合成一段到查询末尾
  const tailHit = nexts.find(
    (h) => h.kw === 'limit' || h.kw === 'offset' || h.kw === 'fetch',
  )
  return {
    select: { start: sel.end, end: nexts.length ? nexts[0]!.idx : stop },
    from: pick('from'),
    where: pick('where'),
    groupBy: pick('group by'),
    having: pick('having'),
    orderBy: pick('order by'),
    limit: tailHit ? { start: tailHit.end, end: stop } : null,
  }
}

/** 深度为 0 处按分隔符切开；下一段从分隔符**之后**开始（分隔符不粘进段首） */
function splitTop(text: string, segRe: RegExp): Array<{ start: number; end: number }> {
  const seps: Array<{ s: number; e: number }> = []
  segRe.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = segRe.exec(text))) {
    if (depthAt(text, m.index) !== 0) continue
    seps.push({ s: m.index, e: m.index + m[0].length })
  }
  const out: Array<{ start: number; end: number }> = []
  let prev = 0
  for (const sep of seps) {
    if (sep.s > prev) out.push({ start: prev, end: sep.s })
    prev = sep.e
  }
  if (text.length > prev) out.push({ start: prev, end: text.length })
  return out
}

/** 深度为 0 处的分隔符个数（IN 列表项数用） */
function countTopSplits(text: string, segRe: RegExp): number {
  let n = 0
  segRe.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = segRe.exec(text))) {
    if (depthAt(text, m.index) !== 0) continue
    n++
  }
  return n
}

/* ================= FROM / JOIN 解析 ================= */

type JoinType = 'first' | 'inner' | 'left' | 'right' | 'full' | 'cross'

interface OnConj {
  masked: string
  orig: string
  start: number
  end: number
  /** 所属 OR 链（该层括号的起点偏移，全局唯一）；0 = 无 OR 的 AND 链 */
  chain: number
  /** 链内第几个 AND 段 */
  seq: number
}

interface JoinFact {
  /** 空串 = 派生表 / 子查询，目录里没有 */
  table: string
  alias: string
  type: JoinType
  /** 逗号旧式连接（FROM a, b） */
  comma: boolean
  hasOn: boolean
  on: OnConj[]
}

const NOT_ALIAS = new Set([
  'where', 'on', 'inner', 'left', 'right', 'full', 'cross', 'outer', 'join',
  'group', 'order', 'limit', 'having', 'union', 'minus', 'intersect', 'set', 'using', 'by',
])

/** 段首的表 + 可选别名（`t as x` / `t x` 都认），与 sqlhint 同一套关键字排除 */
function tableAndAlias(seg: string): { table: string; alias: string } {
  const words = [...seg.matchAll(/[A-Za-z_][\w$#]*/g)].map((x) => x[0]!)
  const table = words[0] ?? ''
  let alias = ''
  if (words.length >= 2) {
    const w = words[1]!
    if (w.toLowerCase() === 'as' && words.length >= 3 && !NOT_ALIAS.has(words[2]!.toLowerCase())) {
      alias = words[2]!
    } else if (!NOT_ALIAS.has(w.toLowerCase())) {
      alias = w
    }
  }
  return { table, alias }
}

function parseFrom(masked: string, sql: string, from: Span): JoinFact[] {
  const text = masked.slice(from.start, from.end)
  const segRe = /\b(?:(left|right|full|inner|cross)(?:\s+outer)?\s+)?(join)\b|,/gi
  const seps: Array<{ s: number; e: number; type: JoinType | 'comma' }> = []
  let m: RegExpExecArray | null
  segRe.lastIndex = 0
  while ((m = segRe.exec(text))) {
    if (depthAt(text, m.index) !== 0) continue
    if (m[2]) {
      seps.push({ s: m.index, e: m.index + m[0].length, type: ((m[1]?.toLowerCase() ?? 'inner') as JoinType) })
    } else {
      seps.push({ s: m.index, e: m.index + 1, type: 'comma' })
    }
  }
  const out: JoinFact[] = []
  let prev = 0
  // 段由**前一个**分隔符引入：第一个段是主表，其后每段类型取引入它的那个 sep
  let intro: JoinType | 'comma' | null = null
  for (const sep of [...seps, { s: text.length, e: text.length, type: 'comma' as const }]) {
    const rel = { start: prev, end: sep.s }
    const cur = intro
    intro = sep.type
    prev = sep.e
    if (rel.end <= rel.start) continue
    const segMasked = masked.slice(from.start + rel.start, from.start + rel.end)
    const { table, alias } = tableAndAlias(segMasked)
    const fact: JoinFact = {
      table: /^[A-Za-z_]/.test(table) ? table : '',
      alias,
      type: cur == null ? 'first' : cur === 'comma' ? 'inner' : cur,
      comma: cur === 'comma',
      hasOn: false,
      on: [],
    }
    const onM = /\bon\b/i.exec(segMasked)
    if (onM) {
      fact.hasOn = true
      const onStart = from.start + rel.start + onM.index + onM[0].length
      fact.on = splitConjuncts(masked, sql, { start: onStart, end: from.start + rel.end })
    }
    out.push(fact)
  }
  return out
}

/* ================= 条件切分与归类 ================= */

/** 顶层 AND/OR 切分；BETWEEN … AND 的 AND 让路；括号组剥壳递归；标定 OR 链 */
function splitConjuncts(masked: string, sql: string, span: Span): OnConj[] {
  const text = masked.slice(span.start, span.end)
  const kwRe = /\b(and|or|between)\b/gi
  const seps: Array<{ s: number; e: number; kw: 'and' | 'or' }> = []
  let pendingBetween = false
  let m: RegExpExecArray | null
  kwRe.lastIndex = 0
  while ((m = kwRe.exec(text))) {
    if (depthAt(text, m.index) !== 0) continue
    const kw = m[1]!.toLowerCase()
    if (kw === 'between') {
      pendingBetween = true
      continue
    }
    if (kw === 'and' && pendingBetween) {
      pendingBetween = false
      continue
    }
    seps.push({ s: m.index, e: m.index + m[0].length, kw: kw as 'and' | 'or' })
  }
  // 这一层有顶层 OR 才算一条 OR 链；链 id 用该层起点偏移，全局唯一
  const chain = seps.some((c) => c.kw === 'or') ? span.start : 0
  const parts: OnConj[] = []
  let prev = 0
  let seq = 0
  for (const sep of [...seps, { s: text.length, e: text.length, kw: 'and' as const }]) {
    const s = span.start + prev
    const e = span.start + sep.s
    const rawT = masked.slice(s, e)
    if (wrappedInParens(rawT.trim())) {
      // 括号组自己是一层：内部有没有 OR 由递归那层自己判断
      parts.push(...splitConjuncts(masked, sql, { start: s + 1, end: e - 1 }))
    } else if (rawT.trim()) {
      parts.push({ masked: rawT, orig: sql.slice(s, e), start: s, end: e, chain, seq })
      seq++
    }
    prev = sep.e
  }
  return parts
}

interface Pred {
  table: string
  col: string
  kind: 'eq' | 'neq' | 'range' | 'like' | 'in' | 'notIn' | 'isNull' | 'func' | 'other'
  /** 所属 OR 链（0 = 无 OR 的 AND 链） */
  chain: number
  /** IN 字面量项数（子查询时不计） */
  litCount?: number
  inSubquery?: boolean
  funcName?: string
  likeLeading?: boolean
  /** 右值是带引号的字符串字面量 */
  quotedLit?: boolean
  /** 右值是裸数字 */
  numLit?: boolean
  /** 右值是绑定参数（#{x} ${x} :x ?），类型未知，不做类型检查 */
  isParam?: boolean
  /** 右值原文（字面量含引号），修复文案里回显真实值用 */
  rhsText?: string
  colDef?: Column
  /** 整条条件在 SQL 里的位置（WHERE / ON 定位用），classifyPred 恒填 */
  at?: { start: number; end: number }
}

const FN_COL_RE = /^([A-Za-z_][\w$#]*)\s*\(\s*([A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*)?)\s*[,)]/
const CMP_OP_RE = /^([\s\S]+?)\s*(>=|<=|!=|<>|=|>|<)([\s\S]+)$/

/**
 * 单条 AND 级条件归类。
 * 掩码把字符串字面量抹成**等长**空白——右值在掩码里可能只剩一串空格。
 * 只对齐修剪前导空白（两边的真空白一致）；**尾部绝不 trim**：
 * 掩码的尾部空格正是字面量占位，原文同位置是 `'x'`，剪了 rhs 就没了。
 * 各模式一律用 `\s*$` 容忍尾部，字面量内容按同偏移回原文读。
 */
function classifyPred(conj: OnConj, resolve: Resolver): Pred {
  const lead = conj.masked.length - conj.masked.trimStart().length
  const t = conj.masked.slice(lead)
  const o = conj.orig.slice(lead)
  const base: Pred = {
    table: '', col: '', kind: 'other', chain: conj.chain,
    // 定位从第一个非空白起，不然选中段带着缩进像没对齐。尾部**不动**：
    // 掩码的尾随空格可能是字面量占位，剪了选中段就缺了右值
    at: { start: conj.start + lead, end: conj.end },
  }

  // IS [NOT] NULL
  const isNull = /\bis\s+(not\s+)?null\s*$/i.exec(t)
  if (isNull) {
    const r = resolve(t.slice(0, isNull.index).trim())
    return { ...base, ...r, kind: 'isNull' }
  }

  // [NOT] IN (…)
  const inM = /^([\s\S]+?)\s+(not\s+in|in)\s*\(([\s\S]*)\)\s*$/i.exec(t)
  if (inM) {
    const r = resolve(inM[1]!.trim())
    const inner = inM[3]!
    const isSub = /\bselect\b/i.test(inner)
    return {
      ...base, ...r,
      kind: /not/i.test(inM[2]!) ? 'notIn' : 'in',
      inSubquery: isSub,
      litCount: isSub ? 0 : countTopSplits(inner, /,/g) + (inner.trim() ? 1 : 0),
    }
  }

  // [NOT] LIKE '…'（模式回原文读）
  const likeM = /^([\s\S]+?)\s+(not\s+like|like)\s+([\s\S]+)$/i.exec(t)
  if (likeM) {
    const r = resolve(likeM[1]!.trim())
    const patM = /'([^']*)'/.exec(o.slice(likeM[1]!.length))
    return { ...base, ...r, kind: 'like', likeLeading: /^[%_]/.test(patM?.[1] ?? '') }
  }

  // 函数包列：fn(col[, …]) op …
  const fnM = FN_COL_RE.exec(t)
  if (fnM && /=|<>|!=|>=|<=|>|<|\bis\b|\blike\b|\bbetween\b/i.test(t.slice(fnM[0].length - 1))) {
    const r = resolve(fnM[2]!)
    return {
      ...base, table: r.table, col: r.col, colDef: r.colDef,
      kind: 'func', funcName: fnM[1]!.toLowerCase(),
    }
  }

  // col op rhs。rhs 在掩码里可能是纯空白（字符串字面量），op 与 rhs 之间**不能放 \s***：
  // 贪婪回溯会把 rhs 吃得只剩一个字符，回原文对长度就错了
  const cmpM = CMP_OP_RE.exec(t)
  if (cmpM && !/\b(and|or|between)\b/i.test(cmpM[1]!)) {
    const lhs = cmpM[1]!.trim()
    const rhs = cmpM[3]!.trim()
    if (!/^[A-Za-z_][\w$#]*(\.[A-Za-z_][\w$#]*)?$/.test(stripIdent(lhs))) return base
    const r = resolve(lhs)
    const op = cmpM[2]!
    const kind: Pred['kind'] = op === '=' ? 'eq' : op === '>' || op === '<' || op === '>=' || op === '<=' ? 'range' : 'neq'
    const rhsOrig = o.slice(Math.max(0, o.length - cmpM[3]!.length)).trim()
    return {
      ...base, ...r, kind, rhsText: rhsOrig,
      quotedLit: /^'.*'$/.test(rhsOrig),
      numLit: /^-?\d/.test(rhs),
      isParam: /^[#:?]/.test(rhs) || /^\$\{/.test(rhs),
    }
  }

  // BETWEEN → range
  const btM = /^([\s\S]+?)\s+between\b/i.exec(t)
  if (btM) return { ...base, ...resolve(btM[1]!.trim()), kind: 'range' }
  return base
}

/* ================= SELECT / ORDER / LIMIT 解析 ================= */

interface SelectInfo {
  distinct: boolean
  star: boolean
  starAliases: string[]
  /** 星号 token 的位置与归属：alias 空 = 裸 *；定位 / 一键展开用 */
  starSpans: Array<{ alias: string; start: number; end: number }>
  /** 显式列（解析到目录的才算），不含表达式与聚合 */
  cols: Array<{ table: string; col: string }>
  hasSubquery: boolean
  hasAggregate: boolean
}

function parseSelect(masked: string, sel: Span, resolve: Resolver): SelectInfo {
  const text = masked.slice(sel.start, sel.end)
  const items = splitTop(text, /,/g)
  const starAliases: string[] = []
  const starSpans: SelectInfo['starSpans'] = []
  let star = false
  let distinct = false
  let hasSubquery = false
  let hasAggregate = false
  const cols: SelectInfo['cols'] = []
  for (const it of items) {
    // distinct/all 只可能在首项开头；掩码与原文等长，剥掉多少 rawStart 就跟进多少
    const itemText = masked.slice(sel.start + it.start, sel.start + it.end)
    let rawStart = sel.start + it.start + (itemText.length - itemText.trimStart().length)
    let raw = itemText.trim()
    if (it.start === 0) {
      const dM = /^(all|distinct)\s+/i.exec(raw)
      if (dM) {
        if (dM[1]!.toLowerCase() === 'distinct') distinct = true
        rawStart += dM[0].length
        raw = raw.slice(dM[0].length).trim()
      }
    }
    if (!raw) continue
    if (raw === '*') {
      star = true
      starSpans.push({ alias: '', start: rawStart, end: rawStart + raw.length })
      continue
    }
    const dotStar = /^([A-Za-z_][\w$#]*)\.\*$/.exec(raw)
    if (dotStar) {
      starAliases.push(dotStar[1]!.toLowerCase())
      starSpans.push({ alias: dotStar[1]!.toLowerCase(), start: rawStart, end: rawStart + raw.length })
      continue
    }
    if (/\(\s*select\b/i.test(raw)) hasSubquery = true
    if (/\b(count|sum|avg|min|max)\s*\(/i.test(raw)) hasAggregate = true
    // 纯列（可带别名）：只收第一段限定列，表达式不冒认
    const colM = /^([A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*)?)\s*(?:\s+as\s+\w+|\s+\w+)?\s*$/.exec(raw)
    if (colM) {
      const r = resolve(colM[1]!)
      if (r.col) cols.push({ table: r.table, col: r.col })
    }
  }
  return { distinct, star, starAliases, starSpans, cols, hasSubquery, hasAggregate }
}

function parseColsList(masked: string, span: Span | null, resolve: Resolver): string[] {
  if (!span) return []
  const text = masked.slice(span.start, span.end)
  return splitTop(text, /,/g)
    .map((it) => {
      const raw = masked.slice(span.start + it.start, span.start + it.end).trim()
      const m = /^([A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*)?)/.exec(raw)
      return m ? resolve(m[1]!).col : ''
    })
    .filter(Boolean)
}

interface LimitInfo {
  hasLimit: boolean
  offset: number
}

function parseLimit(masked: string, span: Span | null): LimitInfo {
  if (!span) return { hasLimit: false, offset: 0 }
  const text = masked.slice(span.start, span.end)
  const offsetM =
    /\boffset\s+(\d+)\s*(?:rows?)?\b/i.exec(text) ??
    /\blimit\s+(\d+)\s*,\s*\d+\b/i.exec(text) // MySQL LIMIT offset, count
  return {
    hasLimit: true, // 段存在本身就说明写了 LIMIT / OFFSET / FETCH
    offset: offsetM ? Number(offsetM[1]) : 0,
  }
}

/* ================= 修复 DDL ================= */

/**
 * 建索引的语句。
 *
 * **Oracle 后面那个 `ONLINE`**：建索引期间不锁表，表照常增删改。不加的话
 * Oracle 在整个建索引过程里挡住这张表上的 DML——`t_order` 这种线上业务表
 * 建个几分钟索引，写它的接口就集体超时，而日志里一句错都没有。
 * 代价是慢一些、吃更多 undo/redo（在线建要走一份日志表）。
 * 两个坑：① 开始和结束各要一次短暂排他锁，表上有长事务没提交时它会
 * **卡在那儿等**（ORA-00054 resource busy），不是失败；② Oracle 不允许对
 * 临时表指定 `ONLINE`，直接报错。元数据只拉列和索引、不拉「是不是临时表」，
 * 所以这条没判——给临时表建索引本身也没意义。
 *
 * **MySQL 是 `ALTER TABLE … ADD INDEX` 不是 `CREATE INDEX`**：后者在 MySQL 里
 * 只是前者的别名，两种写法都对，但前者 4.x/5.0 的老库也认，别名的唯一好处是
 * 省 8 个字符。加二级索引在 5.6+ 的 InnoDB 上默认 INPLACE，允许并发 DML，
 * 所以不需要额外关键字。
 *
 * **SQLite 建完必须 `ANALYZE`**：不统计，优化器照旧统计信息走，新索引等于没建。
 *
 * **名字不能撞库里已有的**：`idx_${表}_${列}` 是机械拼的，不查有没有同名索引。
 * 最容易中的不是两个表撞名，而是表上已经有个索引叫 `idx_t_order_order_no`、
 * 列却是 `(status, order_no)`——列序对不上，查 `WHERE order_no = ?` 用不上它，
 * 所以我们照说不建不行；等 DDL 拼出来，名字正好撞上，抄过去就是 ORA-00955。
 * Oracle 的索引名跟表名同一个命名空间（整个 schema 内唯一），所以严格说该拿
 * 全库的索引名对；但索引元数据是按表懒拉的，只有问到的表才有，这里只跟**这张表
 * 自己**的索引名对——剩下那种跨表撞名要两表名前 30 字符全等，交给 DBA 改名。
 * **本轮分析刚提过的也要躲**：只对库里现有的查，同一次分析给同一张表提的第一列
 * 相同的两条（等值 `(buyer_name)`、分组 `(buyer_name, created_at)`）会拿到同一个
 * 名字，「复制全部 DDL」整份抄过去第二条还是 ORA-00955。
 *
 * **不给 unique 参数**：体检只从「查询用得上」出发，没人调用过唯一索引分支，
 * 留着一个到不了的 `ADD UNIQUE INDEX` 只是让读者以为有这条路。
 */

/**
 * 索引名。后缀也算进 30 字符里，所以是**先把主干截短再补后缀**，
 * 不是截完 30 字符再补 `_2`——那样会超出 Oracle 的标识符上限。
 */
function indexName(table: string, col: string, taken: ReadonlySet<string>): string {
  const stem = `idx_${table}_${col}`
  for (let n = 1; ; n++) {
    const suffix = n > 1 ? `_${n}` : ''
    const name = stem.slice(0, 30 - suffix.length) + suffix
    if (!taken.has(name.toLowerCase())) return name
  }
}

/** 拼语句。方言差异只在格式，名字由 indexName 定好了传进来 */
function indexDdl(dialect: Dialect, table: string, cols: string[], name: string): string {
  const colList = cols.join(', ')
  switch (dialect) {
    case 'oracle':
      return `CREATE INDEX ${name} ON ${table} (${colList}) ONLINE;`
    case 'mysql':
      return `ALTER TABLE ${table} ADD INDEX ${name} (${colList});`
    default: // postgresql / sqlite
      return `CREATE INDEX ${name} ON ${table} (${colList});${dialect === 'sqlite' ? '\nANALYZE;' : ''}`
  }
}

/* ================= 主入口 ================= */

/** 建索引的建议来自哪条规则（同一条索引被多条规则指到时，清单里要能看出是谁） */
interface NeedHit {
  id: string
  scene?: string
}

/** 去重过程中的中间形态：标题最后统一从 advice 回填，免得规则里写两遍 */
interface NeedRaw {
  table: string
  cols: string[]
  ddl: string
  reasons: NeedHit[]
}

/**
 * 完整结果：建议列表 + 「该加哪几个索引」的落地清单。
 * 两条路共用同一次分析，所以清单里那条索引和建议里那条 DDL 必然对得上。
 */
export function advise(sql: string, ctx: AdvCtx): AdvResult {
  const out: SqlAdvice[] = []
  const add = (a: SqlAdvice) => {
    if (!out.some((x) => x.id === a.id && x.scene === a.scene)) out.push(a)
  }
  /** 表 + 列 都相同就只留一条；键小写，元数据大小写不规范不该建出两份 */
  const needs = new Map<string, NeedRaw>()
  /**
   * 这张表上已经叫出去的名字（小写）。索引名跟表名同一个命名空间，
   * 撞了直接 ORA-00955，而名字是我们机械拼的、不知道避开。没有索引元数据
   * （还没拉）时只跟本轮提过的对——那时库里有什么是真不知道。
   *
   * **必须把本轮提过的也算进去**：同一次分析可能给同一张表提两条第一列
   * 相同的索引（等值一条 `(buyer_name)`、分组一条 `(buyer_name, created_at)`），
   * 只查库的话两条拿到的名字一模一样，「复制全部 DDL」抄过去第二条就是 ORA-00955。
   * 排序那条掺和不进来：它要求等值列自己已经在索引首位，那时等值规则根本不报。
   */
  const requested = new Set<string>()
  const takenNames = (table: string): ReadonlySet<string> => {
    const all = new Set(requested)
    for (const i of ctx.indexesOf?.(table) ?? []) all.add(i.name.toLowerCase())
    return all
  }
  /**
   * 登记一条「该加的索引」，并把它的 DDL 交回规则当 fix——
   * 规则和清单说的是同一份语句，不会出现「建议里说改这里、清单里是另一句」。
   * 函数索引（列上套函数那类）不进来：它的 DDL 是表达式不是列名，
   * 在它自己那条建议里给完整语句已经够。
   */
  const needIdx = (table: string, cols: string[], from: NeedHit): string => {
    const key = `${table.toLowerCase()}|${cols.map((c) => c.toLowerCase()).join(',')}`
    const hit = needs.get(key)
    if (hit) {
      if (!hit.reasons.some((r) => r.id === from.id && r.scene === from.scene)) hit.reasons.push(from)
    } else {
      const name = indexName(table, cols[0]!, takenNames(table))
      requested.add(name.toLowerCase())
      needs.set(key, {
        table,
        cols,
        ddl: indexDdl(ctx.dialect, table, cols, name),
        reasons: [from],
      })
    }
    return needs.get(key)!.ddl
  }
  if (!sql.trim()) return { advice: out, indexes: [] }

  const masked = maskLiterals(sql)
  // CTE（WITH … AS …）主查询引用的是临时命名，目录里没有对应表——v1 不分析，宁缺毋滥
  if (/^\s*with\b/i.test(masked)) return { advice: out, indexes: [] }
  const cl = findClauses(masked)
  if (!cl.select || !cl.from) return { advice: out, indexes: [] }

  const joins = parseFrom(masked, sql, cl.from)
  const tablesInFrom = joins.filter((j) => j.table).map((j) => j.table)
  if (tablesInFrom.length === 0) return { advice: out, indexes: [] }

  const colsOfCtx = (t: string): Column[] | undefined => ctx.colsOf?.(t)
  const idxOfCtx = (t: string): IndexDef[] | undefined => ctx.indexesOf?.(t)

  /** 别名 → 表名（键小写）；表名本身也登记 */
  const aliasMap = new Map<string, string>()
  for (const j of joins) {
    if (j.table) {
      aliasMap.set(j.table.toLowerCase(), j.table)
      if (j.alias) aliasMap.set(j.alias.toLowerCase(), j.table)
    }
  }
  const resolve: Resolver = (tok) => {
    const ident = stripIdent(tok)
    if (!ident) return { table: '', col: '' }
    const dot = ident.split('.')
    if (dot.length === 2) {
      const table = aliasMap.get(dot[0]!.toLowerCase())
      const col = stripIdent(dot[1]!)
      return {
        table: table ?? '',
        col,
        colDef: table
          ? colsOfCtx(table)?.find((c) => c.name.toLowerCase() === col.toLowerCase())
          : undefined,
      }
    }
    const col = ident
    if (joins.length === 1 && joins[0]!.table) {
      const t = joins[0]!.table
      return { table: t, col, colDef: colsOfCtx(t)?.find((c) => c.name.toLowerCase() === col.toLowerCase()) }
    }
    // 多表裸列名：目录里唯一命中才归（歧义列不出索引建议）
    const hits = tablesInFrom.filter((t) =>
      colsOfCtx(t)?.some((c) => c.name.toLowerCase() === col.toLowerCase()),
    )
    if (hits.length === 1) {
      const t = hits[0]!
      return { table: t, col, colDef: colsOfCtx(t)!.find((c) => c.name.toLowerCase() === col.toLowerCase()) }
    }
    return { table: '', col }
  }

  const sel = parseSelect(masked, cl.select, resolve)
  const whereConjs = cl.where ? splitConjuncts(masked, sql, cl.where) : []
  const preds = whereConjs.map((c) => classifyPred(c, resolve))
  const orderCols = parseColsList(masked, cl.orderBy, resolve)
  const groupCols = parseColsList(masked, cl.groupBy, resolve)
  const lim = parseLimit(masked, cl.limit)
  const whereText = cl.where ? masked.slice(cl.where.start, cl.where.end) : ''
  const hasRownum = /\brownum\s*(<=|<|=)\s*\d+/i.test(whereText)
  const joined = tablesInFrom.length > 1

  /* ---- SELECT * / 别名.* ---- */
  // 纯 `SELECT o.*` 也要报：拉的还是全列，只是圈定了哪张表
  if (sel.star || sel.starAliases.length > 0) {
    for (const j of joins) {
      if (!j.table) continue
      if (sel.starAliases.length > 0 && !sel.starAliases.includes((j.alias || j.table).toLowerCase())) continue
      const cols = colsOfCtx(j.table)
      const aliasName = j.alias || j.table
      // 这张表对应 SELECT 里哪个星号：带别名清单时按别名对上；裸 * 只有一个才敢认
      const span =
        sel.starSpans.find((s) => s.alias === (j.alias || j.table).toLowerCase()) ??
        (sel.starAliases.length === 0 && sel.starSpans.length === 1 ? sel.starSpans[0] : undefined)
      // 一键展开只在 token 无歧义时给：裸 * 配 JOIN 时展开要拼几张表的列，
      // 顺序 / 前缀都容易猜错，不给按钮，只给可复制的列清单
      const expandable =
        !!cols && cols.length > 0 && !!span && (span.alias !== '' || tablesInFrom.length === 1)
      add({
        id: 'star',
        severity: joined ? 'high' : 'mid',
        title: `SELECT * 拉全部列${joined ? '（JOIN 下更糟）' : ''}`,
        why:
          cols?.length != null
            ? `${j.table} 共 ${cols.length} 列，用不到的列照样占网络和内存，还挡住覆盖索引（免回表）的机会。`
            : '用不到的列照样占网络和内存，还挡住覆盖索引（免回表）的机会。',
        scene: `SELECT *（${aliasName}）`,
        at: span,
        apply: expandable
          ? {
              find: masked.slice(span!.start, span!.end),
              replace: span!.alias
                ? cols!.map((c) => `${aliasName}.${c.name}`).join(', ')
                : cols!.map((c) => c.name).join(', '),
            }
          : undefined,
        fix:
          cols && cols.length > 0
            ? `把 * 换成显式列（${cols.length} 列）：\n${cols.map((c) => c.name).join(', ')}`
            : '把 * 换成实际需要的列名清单。',
        fixKind: cols && cols.length > 0 ? 'sql' : 'text',
      })
    }
  }

  /* ---- 查询列个数 ---- */
  if (sel.cols.length >= 25) {
    add({
      id: 'wide-select',
      severity: 'info',
      title: `查询列 ${sel.cols.length} 个，宽行拉取`,
      why: '列越多每行越大：网络、内存、结果网格渲染都跟着变慢。列数里常有一大半从没被用过。',
      scene: 'SELECT 清单',
      fix: '按实际要用的列裁剪；确实全要就保持，这条只是提醒。',
      fixKind: 'text',
    })
  }

  /* ---- 无 WHERE 全表 ---- */
  if (!cl.where && !hasRownum && !lim.hasLimit && !sel.hasAggregate && !cl.groupBy) {
    add({
      id: 'no-where',
      severity: 'info',
      title: '没有 WHERE，整表扫描',
      why: '表多大就扫多大。开发试探没问题，进程序前加上过滤或行数上限。',
      scene: tablesInFrom.join(', '),
      fix:
        ctx.dialect === 'oracle'
          ? '加 WHERE 过滤，或先 ROWNUM <= 100 试探数据。'
          : '加 WHERE 过滤，或先 LIMIT 100 试探数据。',
      fixKind: 'text',
    })
  }

  /* ---- WHERE 逐条 ---- */
  for (const p of preds) {
    const scene = p.table && p.col ? `WHERE ${p.table}.${p.col}` : p.funcName ? `WHERE ${p.funcName}(...)` : 'WHERE'
    const idxs = p.table ? idxOfCtx(p.table) : undefined
    const haveIdxMeta = p.table ? idxs !== undefined : false

    if (p.kind === 'like' && p.likeLeading) {
      add({
        id: 'like-leading',
        at: p.at,
        severity: 'mid',
        title: 'LIKE 前导通配，索引用不上',
        why: "'%xx' 要从每个值的头开始比，B-tree 的有序性帮不上忙——有索引也只能全索引扫。",
        scene,
        fix:
          ctx.dialect === 'postgresql'
            ? `业务允许就改后缀匹配；确要包含匹配可上 pg_trgm：\nCREATE EXTENSION IF NOT EXISTS pg_trgm;\nCREATE INDEX idx_trgm_${p.table}_${p.col} ON ${p.table} USING gin ((${p.col}) gin_trgm_ops);`
            : "业务允许就改后缀匹配 LIKE 'xx%'（能走索引范围）；确要包含匹配考虑全文索引 / 应用层过滤。",
        fixKind: ctx.dialect === 'postgresql' ? 'sql' : 'text',
      })
    }

    if (p.kind === 'func' && p.col) {
      const ix = haveIdxMeta ? leadingIndex(idxs, p.col) : null
      const fn = p.funcName ?? ''
      add({
        id: 'func-on-col',
        at: p.at,
        severity: ix ? 'high' : 'mid',
        title: `${fn.toUpperCase()} 包在条件列上${ix ? '，已有索引被废掉' : ''}`,
        why: '对列做函数运算后，优化器面对的是计算结果不再是列值，普通索引没法按值定位。',
        scene: `${scene}（${fn}）`,
        fix:
          ctx.dialect === 'oracle'
            ? `能等价改写条件就改写；或建函数索引：\nCREATE INDEX idx_fn_${p.table}_${p.col} ON ${p.table} (${fn.toUpperCase()}(${p.col})) ONLINE;`
            : ctx.dialect === 'mysql'
              ? `MySQL 8.0+ 可建函数索引：\nALTER TABLE ${p.table} ADD INDEX idx_fn_${p.table}_${p.col} ((${fn}(${p.col})));`
              : `能等价改写条件就改写；或建表达式索引：\nCREATE INDEX idx_fn_${p.table}_${p.col} ON ${p.table} (${fn}(${p.col}));`,
        fixKind: 'sql',
      })
    }

    if ((p.kind === 'eq' || p.kind === 'in') && p.table && p.col && haveIdxMeta) {
      const pk = isPkCol(colsOfCtx(p.table), p.col)
      const lead = leadingIndex(idxs, p.col)
      const anywhere = inAnyIndex(idxs, p.col)
      if (!pk && !lead) {
        add({
          id: 'eq-no-index',
          at: p.at,
          severity: 'high',
          title: `等值条件列没有索引${anywhere ? '（在复合索引的非首位，走不到）' : ''}`,
          why: anywhere
            ? '复合索引只有最左前缀能被查询用上：查询列不在索引第一位，这条条件对索引来说等于没有。'
            : '等值查找没有索引就是整表逐行比对，行数一上来就是秒级到分钟级的差距。',
          scene,
          fix: needIdx(p.table, [p.col], { id: 'eq-no-index', scene }),
          fixKind: 'sql',
        })
      }
    }

    if (p.kind === 'range' && p.table && p.col && haveIdxMeta && !leadingIndex(idxs, p.col)) {
      add({
          id: 'range-no-index',
          at: p.at,
        severity: 'low',
        title: '范围条件列没有索引',
        why: '范围扫描（> < BETWEEN）有索引能少摸很多行；没有就是全表逐行判断。',
        scene,
        fix: needIdx(p.table, [p.col], { id: 'range-no-index', scene }),
        fixKind: 'sql',
      })
    }

    /* 隐式类型转换：类型来自目录，两个方向都查 */
    if ((p.kind === 'eq' || p.kind === 'range' || (p.kind === 'in' && (p.litCount ?? 0) === 1)) && p.colDef) {
      if (isNumericCol(p.colDef) && p.quotedLit && !p.isParam) {
        add({
          id: 'implicit-cast',
          at: p.at,
          severity: 'high',
          title: '数字列和字符串字面量比较（隐式转换）',
          why:
            ctx.dialect === 'oracle'
              ? `Oracle 会把 ${p.col} 逐行 TO_NUMBER('…')：索引用不上，字符串里混进非数字还会整条报错。`
              : '字符串被转成数字再比，索引失效，还可能悄悄比错。',
          scene,
          fix: `去掉引号按数字写：${p.table}.${p.col} = ${p.rhsText?.replace(/^'|'$/g, '') || 123}。绑定参数保持数字类型。`,
          fixKind: 'text',
        })
      }
      if (isStringCol(p.colDef) && p.numLit && !p.isParam) {
        add({
          id: 'implicit-cast',
          at: p.at,
          severity: 'high',
          title: '字符串列和数字字面量比较（隐式转换）',
          why: '每行都要把字符串列转成数字再比，索引直接失效——MySQL 里最常见的隐性全表扫描。',
          scene,
          fix: `引号补上按字符串比：${p.table}.${p.col} = '${p.rhsText ?? '123'}'。`,
          fixKind: 'text',
        })
      }
    }

    /* IN 列表超长 */
    if (p.kind === 'in' && (p.litCount ?? 0) > 200) {
      const overOracle = ctx.dialect === 'oracle' && (p.litCount ?? 0) >= 1000
      add({
        id: 'in-long',
        at: p.at,
        severity: overOracle ? 'high' : 'mid',
        title: `IN 列表 ${p.litCount} 项${overOracle ? '，Oracle 上限 1000 会直接报错' : ''}`,
        why: overOracle
          ? 'ORA-01795：表达式列表最多 1000 项，这条 SQL 根本跑不起来。'
          : '超长 IN 让优化器代价估算失真、解析变慢；清单大时不如落临时表 JOIN。',
        scene,
        fix:
          ctx.dialect === 'oracle'
            ? '分批（每批 ≤1000），或把清单插进 GLOBAL TEMPORARY TABLE 再 JOIN。'
            : '分批发送，或把清单落临时表再 JOIN。',
        fixKind: 'text',
      })
    }

    if (p.kind === 'notIn' && p.inSubquery) {
      add({
        id: 'not-in-subquery',
        at: p.at,
        severity: 'mid',
        title: 'NOT IN (SELECT …)',
        why: '子查询结果里只要有一个 NULL，整条查询就空结果；而且多数优化器对 NOT IN 做不出高效的反连接。',
        scene,
        fix: `改 NOT EXISTS（语义更稳，通常也更快）：\nSELECT … FROM ${tablesInFrom[0]} t\nWHERE NOT EXISTS (\n  SELECT 1 FROM 子表 s WHERE s.关联列 = t.关联列\n)`,
        fixKind: 'sql',
      })
    }
  }

  /* ---- OR 链：同一组备选里跨了不同列的等值条件 ---- */
  const chainCols = new Map<number, Set<string>>()
  for (const p of preds) {
    if (p.chain === 0 || p.kind !== 'eq' || !p.col) continue
    let set = chainCols.get(p.chain)
    if (!set) chainCols.set(p.chain, (set = new Set()))
    set.add(`${p.table}.${p.col}`)
  }
  if ([...chainCols.values()].some((s) => s.size >= 2)) {
    add({
      id: 'or-mix',
      severity: 'low',
      title: 'OR 跨列等值条件',
      why: '优化器对 OR 两侧不同列常常只能全表扫（index merge 并不总生效）。',
      scene: 'WHERE … OR …',
      fix: '能合并就合并；否则拆成两条 UNION ALL，各自都能走自己的索引。',
      fixKind: 'text',
    })
  }

  /* ---- JOIN ---- */
  for (const j of joins) {
    if (j.type === 'first') continue
    if (!j.hasOn) {
      // 旧式逗号连接靠 WHERE 关联，有 WHERE 就不当笛卡尔积处理
      if (j.comma && cl.where) continue
      add({
        id: 'cartesian',
        severity: 'high',
        title: 'JOIN 没有 ON，笛卡尔积',
        why: '两张表逐行相乘：A 1 万行 × B 1 万行 = 1 亿行中间结果。',
        scene: `JOIN ${j.table || '(子查询)'}`,
        fix: '补上关联条件；确实要乘积就显式写 CROSS JOIN 并确认行数可控。',
        fixKind: 'text',
      })
      continue
    }
    for (const c of j.on) {
      const p = classifyPred(c, resolve)
      if (p.kind !== 'eq' || !p.table || !p.col) continue
      const idxs = idxOfCtx(p.table)
      const pk = isPkCol(colsOfCtx(p.table), p.col)
      if (!pk && idxs && !leadingIndex(idxs, p.col)) {
        const anywhere = inAnyIndex(idxs, p.col)
        add({
          id: 'join-col-no-index',
          at: p.at,
          severity: 'high',
          title: `JOIN 关联列 ${p.table}.${p.col} 没有索引${anywhere ? '（非首位走不到）' : ''}`,
          why: '嵌套循环每行都要去对方表找匹配，被驱动表没索引就是每行一次全表扫描。',
          scene: `ON ${p.table}.${p.col}`,
          fix: needIdx(p.table, [p.col], { id: 'join-col-no-index', scene: `ON ${p.table}.${p.col}` }),
          fixKind: 'sql',
        })
        break // 同一个 ON 里提一次就够
      }
    }
  }

  /* ---- LEFT JOIN 被 WHERE 打回内连接 ---- */
  if (cl.where) {
    for (const lj of joins.filter((x) => x.type === 'left' && x.alias)) {
      const rightAlias = lj.alias!.toLowerCase()
      const hit =
        preds.some((p) => p.table && p.table.toLowerCase() === lj.table.toLowerCase()) ||
        whereText.toLowerCase().includes(`${rightAlias}.`)
      if (hit) {
        add({
          id: 'left-join-where',
          severity: 'low',
          title: 'LEFT JOIN 的右表被 WHERE 过滤',
          why: '对右表列的非 NULL 判断会把 LEFT JOIN 退化成 INNER JOIN——语义变了，计划也可能变差。',
          scene: `WHERE ${lj.alias}.*`,
          fix: '确认不需要「左表全保留」的语义就改成 INNER JOIN，让两边意图一致。',
          fixKind: 'text',
        })
        break
      }
    }
  }

  /* ---- 单表才做：排序索引 / 覆盖索引（JOIN 下目录推不出驱动路径） ---- */
  if (!joined) {
    const t0 = tablesInFrom[0]!
    const idxs = idxOfCtx(t0)
    const eqCols = preds
      .filter((p) => p.kind === 'eq' && p.table === t0 && p.col)
      .map((p) => p.col!)
    if (cl.where && orderCols.length > 0 && idxs && eqCols.length > 0) {
      const combined = [...eqCols, ...orderCols]
      const covered = idxs.some((ix) =>
        combined.every((c, i) => ix.columns[i]?.toLowerCase() === c.toLowerCase()),
      )
      if (!covered && eqCols.every((c) => leadingIndex(idxs, c))) {
        add({
          id: 'order-no-index',
          severity: 'low',
          title: '排序列不在索引里，要额外排序',
          why: '等值条件走了索引，结果集还得再排一遍（filesort / SORT AREA）；数据量大时是一段明显的等待。',
          scene: `ORDER BY ${orderCols.join(', ')}`,
          fix: needIdx(t0, [...eqCols, ...orderCols], {
            id: 'order-no-index',
            scene: `ORDER BY ${orderCols.join(', ')}`,
          }),
          fixKind: 'sql',
        })
      }
    }
    if (groupCols.length > 0 && idxs) {
      const covered = idxs.some((ix) =>
        groupCols.every((c, i) => ix.columns[i]?.toLowerCase() === c.toLowerCase()),
      )
      if (!covered) {
        add({
          id: 'group-no-index',
          severity: 'info',
          title: '分组列不在索引里，要额外排序去重',
          why: 'GROUP BY 靠有序输入才便宜：列上没索引就得先排序或建哈希表，数据多时这一步比查询本身还贵。',
          scene: `GROUP BY ${groupCols.join(', ')}`,
          // 整条语句给全：这句要抄进 SQL 窗口执行，掺在「经常按这几列分组的话」
          // 里就别想整份复制了
          fix: needIdx(t0, groupCols, { id: 'group-no-index', scene: `GROUP BY ${groupCols.join(', ')}` }),
          fixKind: 'sql',
        })
      }
    }
    if (!sel.star && sel.cols.length > 0 && idxs) {
      const referenced = [
        ...sel.cols.filter((c) => c.table === t0).map((c) => c.col),
        ...preds.filter((p) => p.table === t0 && p.col).map((p) => p.col!),
      ]
      if (referenced.length >= 2) {
        const covering = idxs.find((ix) =>
          referenced.every((c) => ix.columns.some((x) => x.toLowerCase() === c.toLowerCase())),
        )
        if (covering) {
          add({
            id: 'covering',
            severity: 'info',
            title: `这条查询可以只靠索引 ${covering.name} 回答`,
            why: '所有引用列都在索引里，理想计划是纯索引扫不回表——确认执行计划里没有 TABLE ACCESS FULL 就稳了。',
            scene: `${t0}（覆盖索引）`,
            fix: 'EXPLAIN 确认走该索引；若仍回表，先更新统计信息再看。',
            fixKind: 'text',
          })
        }
      }
    }
  }

  /* ---- 深分页 ---- */
  if (lim.offset >= 1000) {
    add({
      id: 'deep-offset',
      severity: 'mid',
      title: `OFFSET ${lim.offset} 深分页`,
      why: '翻到第 N 页要把前 N-1 页全部产出再丢掉，越往后越慢。',
      scene: `OFFSET ${lim.offset}`,
      fix: '改游标分页（keyset）：记下上一页最后一行的排序列值，下页 WHERE 排序列 > 该值 ORDER BY 排序列 LIMIT 页大小——深页也一样快。',
      fixKind: 'text',
    })
  }

  /* ---- DISTINCT + JOIN ---- */
  if (sel.distinct && joined) {
    add({
      id: 'distinct-join',
      severity: 'low',
      title: 'DISTINCT + 多表连接',
      why: '先连接再去重要么物化中间结果排序、要么哈希去重，代价都不小；很多 DISTINCT 是在遮连接写出的重复。',
      scene: 'SELECT DISTINCT',
      fix: '先定位重复来自哪张表，能收窄连接列就不必整行 DISTINCT。',
      fixKind: 'text',
    })
  }

  /* ---- SELECT 列表里的标量子查询 ---- */
  if (sel.hasSubquery) {
    add({
      id: 'subquery-in-select',
      severity: 'mid',
      title: 'SELECT 列表里有子查询',
      why: '相关子查询对外层每行执行一次，行数一多就是 N 次单行查找。',
      scene: 'SELECT 清单',
      fix: '改成 LEFT JOIN（或按方言用 LATERAL / CROSS APPLY）一次关联到位。',
      fixKind: 'text',
    })
  }

  /* ---- Oracle 绑定变量 ---- */
  if (ctx.dialect === 'oracle' && cl.where) {
    // 字面量在掩码里是空白，回原文数（'' 转义会多计一次，阈值判断可容忍）
    const lits = sql.slice(cl.where.start, cl.where.end).match(/'[^']*'/g)?.length ?? 0
    if (lits >= 3) {
      add({
        id: 'bind-vars',
        severity: 'info',
        title: `WHERE 里有 ${lits} 个字面量`,
        why: '每换一组值就是一条新 SQL：硬解析耗 CPU，共享池被相似语句挤占。这段 SQL 要进程序就改成绑定变量。',
        scene: 'WHERE 字面量',
        fix: '值换成 :bind 参数（MyBatis #{} 天然就是）；只在报表类一次性查询里保留字面量。',
        fixKind: 'text',
      })
    }
  }

  /*
   * 标题从 advice 回填到清单上：规则里已经把标题写了一遍，再抄一份就等于
   * 「改标题只改一处，另一处静默留旧词」。
   */
  const titles = new Map<string, string>()
  for (const a of out) if (!titles.has(a.id)) titles.set(a.id, a.title)
  const advice = out.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])
  return {
    advice,
    indexes: [...needs.values()].map((n) => ({
      table: n.table,
      cols: n.cols,
      ddl: n.ddl,
      reasons: n.reasons.map((r) => ({ ...r, title: titles.get(r.id) ?? r.id })),
    })),
  }
}

/**
 * 只要建议列表（优化记录那条路用：历史里存的是建议，不是索引清单）。
 * 要「该加哪几个索引」用 `advise`。
 */
export function sqlAdvise(sql: string, ctx: AdvCtx): SqlAdvice[] {
  return advise(sql, ctx).advice
}

/**
 * 把建议附带的一键改写（目前只有 SELECT * 展开）应用到 SQL 上，返回新 SQL；
 * 应用不了返回 null，UI 据此提示而不动输入框。
 *
 * 不存偏移、每次现找：从分析到用户点按钮之间，SQL 多半已经被改过别处，
 * 分析时的字符偏移早不可信。在**掩码文本**的 SELECT 段里重找 find 的 token——
 * 字面量已被抹平，注释里冒出来的同名词不会中（注释也被掩码，但深度/边界判定
 * 一致，落点仍在 SELECT 段内才算数）；深度非 0 的跳过，count(*) 的星号不会误中。
 * 找不到（已经展开过 / 结构变了）就返回 null，宁可不应用也不改错地方。
 */
export function applyAdvice(sql: string, advice: SqlAdvice): string | null {
  const ap = advice.apply
  if (!ap || !sql.trim()) return null
  const masked = maskLiterals(sql)
  const cl = findClauses(masked)
  if (!cl.select) return null
  const seg = masked.slice(cl.select.start, cl.select.end)
  const esc = ap.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?<![\\w$.])${esc}(?![\\w*])`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(seg))) {
    if (depthAt(seg, m.index) !== 0) continue
    const at = cl.select.start + m.index
    return sql.slice(0, at) + ap.replace + sql.slice(at + ap.find.length)
  }
  return null
}

