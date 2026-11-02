/**
 * 批量生成，PRD v6.3 §4.15 批量INSERT / §4.16 批量UPDATE（v6.4 MVP #5/#6）。
 *
 * 原型已拆成 `mockup/batch-insert.html` + `batch-update.html`（共用 `_batch.js`）。
 * 页面底部那七项「待拍板」全部按原型里写明的倾向落地，这里逐条记下出处：
 * 1. 独立成两页（features/batch/ BatchInsertPage / BatchUpdatePage），不挂进 SQL 生成器；
 *    SELECT转UPDATE 保持自己的页，批量 UPDATE 里只留入口。
 * 2. 字段规则默认 = §4.4 自动值，不强制逐列显式配置——12 种规则挨个配 20 个
 *    字段没人受得了。§4.4 那套自动值**直接调 mockValue**（种子 = 行号），
 *    不在本文件再抄一份：抄了就是第二份规则，注定只修好一份。
 * 3. 「随机」全部用 (行号, 字段) 的 FNV 哈希实现——界面上叫随机，实际同配置
 *    两次生成逐字符一致，评审可比对、回归可断言。不提供真随机开关。
 * 4. 逐条 UPDATE 只加批次注释，不包 BEGIN/COMMIT：事务语法方言差异太大
 *   （Oracle 里 BEGIN/COMMIT 是 PL/SQL 块语义），包错比不包更糟。
 * 5. WHERE 1=1 定位的防呆是一道确认勾选闸（confirmed）。
 * 6. 没有「原值→新值」对比——不连库拿不到旧值，这是能力边界不是缺陷；
 *    要对比用已上线的 SELECT转UPDATE。
 * 7. 收藏为模板 / 收藏夹联动本轮不做，按钮不出现而不是禁用。
 *
 * 全是纯函数：生成、解析、规则分开导出，界面 useMemo 实时重算——本项目没有「生成」按钮。
 */
import type { Column, Dialect, TableInfo } from '../../types/schema'
import { requiresDistinct } from '../../types/schema'
import { sortColumnsForUi } from '../columnOrder'
import { DIALECTS } from './dialect'
import { planValues, renderValue } from './mockValue'
import { header } from './singleTable'

/* ================= 字段级生成规则引擎（§4.15 表格那 12 种）================= */

export type RuleKind =
  | 'auto'
  | 'tpl'
  | 'fixed'
  | 'rnum'
  | 'rstr'
  | 'renum'
  | 'rdate'
  | 'phone'
  | 'email'
  | 'name'
  | 'now'
  | 'null'

export interface FieldRule {
  k: RuleKind
  /** 规则参数；tpl/fixed 用 a，rnum/rstr/rdate 用 a+b */
  p?: { a?: string; b?: string }
}

/** 列名 → 规则。缺省（没登记）= auto，即沿用 §4.4 自动值 */
export type RuleMap = Record<string, FieldRule>

/** 下拉框的 12 项，顺序即界面顺序。放 lib 不放 UI：测试要断言它齐不齐 */
export const RULE_KINDS: ReadonlyArray<{ v: RuleKind; l: string }> = [
  { v: 'auto', l: '沿用自动值' },
  { v: 'tpl', l: '模板 {n}' },
  { v: 'fixed', l: '固定值' },
  { v: 'rnum', l: '随机 · 数字' },
  { v: 'rstr', l: '随机 · 字符串' },
  { v: 'renum', l: '随机 · 枚举' },
  { v: 'rdate', l: '随机 · 日期' },
  { v: 'phone', l: '随机 · 手机号' },
  { v: 'email', l: '随机 · 邮箱' },
  { v: 'name', l: '随机 · 姓名' },
  { v: 'now', l: '当前时间' },
  { v: 'null', l: 'NULL' },
]

export interface RuleParamSpec {
  /** 参数槽位：a=第一个输入框，b=第二个 */
  slot: 'a' | 'b'
  /** 默认值。换规则就填一套默认参数——空白必配会让「随机数字」产出空串，用户还以为坏了 */
  dft: string
  ph: string
  tt: string
}

export const RULE_PARAMS: Partial<Record<RuleKind, readonly RuleParamSpec[]>> = {
  tpl: [{ slot: 'a', dft: 'xx_{n}', ph: '前缀_{n}', tt: '{n} 会替换成行号（1 起）' }],
  fixed: [{ slot: 'a', dft: '', ph: '所有行都用这个值', tt: '数字/日期会按字段类型转字面量' }],
  rnum: [
    { slot: 'a', dft: '1', ph: '最小', tt: '随机整数下界' },
    { slot: 'b', dft: '100', ph: '最大', tt: '闭区间，含两端' },
  ],
  rstr: [
    { slot: 'a', dft: '8', ph: '长度', tt: '字符个数' },
    { slot: 'b', dft: 'alnum', ph: '字符集', tt: 'alnum=字母数字 / num=纯数字 / lower=小写字母' },
  ],
  renum: [{ slot: 'a', dft: 'A,B,C', ph: '逗号分隔候选值', tt: '每次从中取一个' }],
  rdate: [
    { slot: 'a', dft: '2026-01-01', ph: '起始日期', tt: '' },
    { slot: 'b', dft: '2026-12-31', ph: '结束日期', tt: '随机落在区间内（含端点）' },
  ],
}

/* ---------- 确定性随机 ---------- */

/** FNV-1a。跟 mockValue 里那份各管一个域：这里的散列域是 (行号, 字段)，不含 seed/phase */
function h32(i: number, name: string): number {
  let h = 0x811c9dc5
  const s = `${i}${name}`
  for (let k = 0; k < s.length; k += 1) {
    h ^= s.charCodeAt(k)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 显式规则的文本产出（人看的逻辑文本，不带引号转义）。返回 '' = 参数没填 */
function ruleText(rule: FieldRule, column: Column, i: number): string {
  const p = rule.p ?? {}
  const a = String(p.a ?? '')
  const b = String(p.b ?? '')
  switch (rule.k) {
    case 'tpl':
      return a.replaceAll('{n}', String(i))
    case 'fixed':
      return a
    case 'rnum': {
      const lo = Number.parseInt(a, 10) || 0
      const hiRaw = Number.parseInt(b, 10)
      const hi = Number.isNaN(hiRaw) ? lo : hiRaw
      return String(lo + (h32(i, column.name) % (Math.abs(hi - lo) + 1)))
    }
    case 'rstr': {
      const len = Math.min(64, Math.max(1, Number.parseInt(a, 10) || 8))
      // 字符集白名单外的值回落 alnum：手滑敲个 'ABC' 不能产出空串
      const cs =
        b === 'num'
          ? '0123456789'
          : b === 'lower'
            ? 'abcdefghijklmnopqrstuvwxyz'
            : 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
      let out = ''
      for (let k = 0; k < len; k += 1) out += cs[h32(i * 131 + k, column.name) % cs.length]
      return out
    }
    case 'renum': {
      const opts = a
        .split(/[,，]/)
        .map((x) => x.trim())
        .filter(Boolean)
      return opts.length ? opts[h32(i, column.name) % opts.length] : ''
    }
    case 'rdate': {
      const t0 = Date.parse(a)
      const t1 = Date.parse(b)
      // 区间没给对就原样回起始值：宁可见到一个没变的日期也别静默出空
      if (Number.isNaN(t0) || Number.isNaN(t1)) return a || b || ''
      const lo = Math.min(t0, t1)
      const span = Math.max(0, Math.abs(t1 - t0))
      const d = new Date(lo + (h32(i, column.name) % (span + 86_400_000)))
      const pd = (x: number) => String(x).padStart(2, '0')
      return `${d.getFullYear()}-${pd(d.getMonth() + 1)}-${pd(d.getDate())}`
    }
    case 'phone':
      return `138${String(h32(i, column.name) % 100_000_000).padStart(8, '0')}`
    case 'email': {
      const letters = 'abcdefghjkmnpqrstwxyz'
      const word = (salt: number) =>
        Array.from({ length: salt % 2 === 0 ? 4 : 3 }, (_, k) => letters[h32(i * 7 + salt * 31 + k, column.name) % letters.length]).join('')
      return `${word(0)}.${word(1)}@test.com`
    }
    case 'name':
      return ['张三', '李四', '王五', '赵六', '陈七', '周八', '吴九', '郑十'][h32(i, column.name) % 8]
    default:
      return ''
  }
}

/**
 * 该列规则是否随行号变化——决定 CASE WHEN 里它进 CASE 还是普通赋值，
 * 以及 cond/fixed 定位下要不要提示「只取第 1 行的值」。
 * fixed/now/null 三种对每一行给出同一个值，其余（含缺省的 auto）都随行走。
 */
export function ruleVaries(rule: FieldRule | undefined): boolean {
  const k = rule?.k
  return !(k === 'fixed' || k === 'now' || k === 'null')
}

/**
 * 第 i 行第 column 列的显示值（预览用逻辑文本）。'' = 显式规则的参数没填，
 * 调用方要在界面上明说「参数未填」，SQL 里那一格会是 NULL。
 *
 * auto 直接调 mockValue.planValues：种子 = 行号，phase 由调用方定
 * （INSERT 用 insert，UPDATE 新值用 update——两阶段的值必须不同，
 * 否则「先插后改」看不出变化，PRD 4.4 的老规矩）。
 *
 * 主键 / 单列唯一索引在 INSERT 里不走 auto：散列会撞 UNIQUE，语句看着正常、
 * 插进去才报错。改成从起始ID（缺省 1）连号，行与行之间一定不同。
 */
export function distinctSerial(_column: Column, rowIndex: number, startId: number | null): string {
  return String((startId ?? 1) + rowIndex - 1)
}

export function displayCell(
  table: TableInfo,
  column: Column,
  rowIndex: number,
  rules: RuleMap,
  phase: 'insert' | 'update',
  dialect: Dialect,
  startId: number | null = null,
): string {
  const rule = rules[column.name]
  if (phase === 'insert' && (!rule || rule.k === 'auto') && requiresDistinct(column)) {
    // 自增列没填起始ID 时整列排除，这里不该再造一个会撞车的散列值
    if (column.isAutoIncrement && startId === null) return ''
    return distinctSerial(column, rowIndex, startId)
  }
  if (!rule || rule.k === 'auto') {
    return planValues(table, dialect, rowIndex, phase).find((p) => p.column.name === column.name)!
      .auto
  }
  if (rule.k === 'now') return DIALECTS[dialect].now
  if (rule.k === 'null') return 'NULL'
  return ruleText(rule, column, rowIndex)
}

/* ================= 主键列表解析（§4.16：范围/列表混着来）================= */

/**
 * 逗号/中文逗号/分号/空白混着切；范围写法 a-b 展开闭区间，保序去重。
 * 跨度上限 2000：手滑写个 1-99999999 不能把整个页面卡死，超限的整段跳过并计数。
 */
export function parsePkList(raw: string): { list: string[]; overRange: number } {
  const seen = new Map<string, true>()
  let overRange = 0
  for (const tok of String(raw).split(/[\s,，;；]+/)) {
    const t = tok.trim()
    if (!t) continue
    const m = /^(\d+)\s*[-~]\s*(\d+)$/.exec(t)
    if (m) {
      let a = Number(m[1])
      let b = Number(m[2])
      if (a > b) [a, b] = [b, a]
      if (b - a + 1 > 2000) {
        overRange += 1
        continue
      }
      for (let v = a; v <= b; v += 1) seen.set(String(v), true)
    } else if (!seen.has(t)) {
      seen.set(t, true)
    }
  }
  return { list: [...seen.keys()], overRange }
}

/* ================= 结果形状 ================= */

export interface BatchWarning {
  tone: 'warn' | 'err'
  msg: string
}

export type BatchPreview =
  | { kind: 'rows'; columns: Column[]; cells: string[][] }
  | { kind: 'text'; text: string }

export interface BatchResult {
  sql: string
  /** 结果卡状态栏一句话，如「20 条」「137 个主键 · CASE WHEN」 */
  stat: string
  /** true = 还不能生成，sql 是占位说明注释而不是真语句 */
  refused: boolean
  warnings: BatchWarning[]
  preview: BatchPreview | null
  previewLabel: string
}

/** 占位注释：拒绝生成的分支也要把已知警告带上——警告只跟表/粘贴内容有关，
 *  等用户补完配置才告诉他，他已经按错的前提想了半天了 */
function refuse(lines: string[], warnings: BatchWarning[], previewNote: string): BatchResult {
  return {
    sql: lines.map((l) => `-- ${l}`).join('\n'),
    stat: '',
    refused: true,
    warnings,
    preview: null,
    previewLabel: previewNote,
  }
}

/* ================= 批量INSERT（§4.15）================= */

export type InsertFormat = 'each' | 'multi' | 'chunk'

export interface InsertOptions {
  dialect: Dialect
  count: number
  format: InsertFormat
  /** chunk 格式每组条数（§4.15「每条SQL包含记录数」） */
  perStmt: number
  /** null = 自增列整列排除；数字 = 自增列一并写入，从它起连续编号 */
  startId: number | null
  headerComment: boolean
  rules: RuleMap
}

const CHUNK_LIMIT = 1024 * 1024

export function generateBatchInsert(table: TableInfo, o: InsertOptions): BatchResult {
  const spec = DIALECTS[o.dialect]
  const q = spec.quote
  const n = Math.min(500, Math.max(1, o.count))

  /* 多 VALUES：MySQL / SQLite 直收（Oracle 要 INSERT ALL，PG 也行但本产品只开这两家）。
     界面会禁用入口，这里再守一道：lib 不该假设每个调用方都记得禁 */
  const warns: BatchWarning[] = []
  let format = o.format
  if (format !== 'each' && o.dialect !== 'mysql' && o.dialect !== 'sqlite') {
    format = 'each'
    warns.push({
      tone: 'warn',
      msg: `${spec.label} 方言不支持多 VALUES 拼装，已降级为逐条 INSERT`,
    })
  }

  const aiCols = table.columns.filter((c) => c.isAutoIncrement)
  const sid = o.startId !== null && Number.isInteger(o.startId) ? o.startId : null
  const cols = table.columns.filter((c) => !c.isAutoIncrement || sid !== null)
  if (!cols.length)
    return refuse(
      ['这张表除自增主键外没有可插入的字段', '填上「起始ID」让自增列回到列清单，或换一张表'],
      warns,
      '',
    )

  /* 参数没填的显式规则要挂出来：renderValue 会把空文本当 NULL 插进去，
     「想固定成 0 结果插了一列 NULL」这种事必须让用户在生成前看到 */
  const emptyRuleFields = cols.filter(
    (c) =>
      !(o.rules[c.name]?.k === undefined ||
        o.rules[c.name].k === 'auto' ||
        o.rules[c.name].k === 'now' ||
        o.rules[c.name].k === 'null') &&
      displayCell(table, c, 1, o.rules, 'insert', o.dialect, sid) === '',
  )
  if (emptyRuleFields.length)
    warns.push({ tone: 'warn', msg: `${emptyRuleFields.map((c) => c.name).join('、')} 的规则参数没填，这些列按 NULL 输出` })

  const fmtLabel =
    format === 'each'
      ? '逐条'
      : format === 'multi'
        ? '一条多VALUES(MySQL)'
        : `分批（每 ${Math.max(1, o.perStmt)} 条一组，超 1MB 自动再切）`
  const head = o.headerComment
    ? `${header([
        `批量INSERT : ${table.name}${table.comment ? ` (${table.comment})` : ''}`,
        `共 ${n} 条 · 形态 ${fmtLabel} · ${spec.label}`,
        sid !== null && aiCols.length
          ? `起始ID=${sid}：自增列 ${aiCols.map((c) => c.name).join('、')} 一并写入（${sid} 编到 ${sid + n - 1}）`
          : `自增列已整列跳过：${aiCols.length ? aiCols.map((c) => c.name).join('、') : '（无）'}`,
        '主键/唯一列按行号连号，不走自动值散列（撞 UNIQUE 插不进去）',
      ])}\n\n`
    : ''

  /** 自增列给了起始ID就是纯序列；主键/唯一列同样连号，其余列走规则引擎 */
  const cell = (c: Column, i: number): string => {
    if (c.isAutoIncrement && sid !== null) return String(sid + i - 1)
    const rule = o.rules[c.name]
    if (requiresDistinct(c) && (!rule || rule.k === 'auto')) {
      return renderValue(c, distinctSerial(c, i, sid), o.dialect)
    }
    return renderValue(c, displayCell(table, c, i, o.rules, 'insert', o.dialect, sid), o.dialect)
  }
  const row = (i: number) => `(${cols.map((c) => cell(c, i)).join(', ')})`
  const prefix = `INSERT INTO ${q(table.name)} (${cols.map((c) => q(c.name)).join(', ')}) VALUES`

  let body: string
  if (format === 'multi') {
    body = `${prefix}\n${Array.from({ length: n }, (_, k) => row(k + 1)).join(',\n')};`
  } else if (format === 'chunk') {
    const per = Math.min(500, Math.max(1, o.perStmt))
    const groups: string[] = []
    let buf: string[] = []
    for (let i = 1; i <= n; i += 1) {
      const r = row(i)
      // 双重切分：条数到 per 就收口；条数没到但拼出来超 1MB 也提前收口（§4.15 分批 INSERT）
      if (buf.length && (buf.length >= per || `${prefix}\n${[...buf, r].join(',\n')}`.length > CHUNK_LIMIT)) {
        groups.push(`${prefix}\n${buf.join(',\n')};`)
        buf = []
      }
      buf.push(r)
    }
    if (buf.length) groups.push(`${prefix}\n${buf.join(',\n')};`)
    body = groups.join('\n\n')
  } else {
    body = Array.from({ length: n }, (_, k) => `${prefix}\n  ${row(k + 1)};`).join('\n\n')
  }

  const shown = Math.min(10, n)
  return {
    sql: `${head}${body}\n`,
    stat: `${n} 条`,
    refused: false,
    warnings: warns,
    preview: {
      kind: 'rows',
      columns: cols,
      cells: Array.from({ length: shown }, (_, k) =>
        cols.map((c) => {
          if (c.isAutoIncrement && sid !== null) return String(sid + k)
          const v = displayCell(table, c, k + 1, o.rules, 'insert', o.dialect, sid)
          return v === '' ? '（参数未填）' : v
        }),
      ),
    },
    previewLabel: `共 ${n} 行 · 预览前 ${shown} 行`,
  }
}

/* ================= 批量UPDATE（§4.16 三种定位）================= */

export type UpdateLocator =
  | { mode: 'pk'; raw: string; outputFormat: 'each' | 'case'; batchSize: number }
  | { mode: 'cond'; conditions: Record<string, string> }
  | { mode: 'fixed'; confirmed: boolean }

export interface UpdateOptions {
  dialect: Dialect
  /** SET 字段勾选（非主键列） */
  setOn: Record<string, boolean>
  rules: RuleMap
  locator: UpdateLocator
}

/** 勾选了的 SET 列，保持表定义序 */
const setColsOf = (table: TableInfo, setOn: Record<string, boolean>): Column[] =>
  table.columns.filter((c) => !c.isPrimaryKey && setOn[c.name])

function emptySetRefuse(table: TableInfo, warnings: BatchWarning[]): BatchResult {
  return refuse(
    table.columns.every((c) => c.isPrimaryKey)
      ? [
          '这张表所有列都是主键，没有可更新的字段',
          '关联表要改关系请用 DELETE + INSERT，而不是 UPDATE 主键',
        ]
      : [
          '还不能生成：先勾选 SET 字段',
          '新值来自字段规则（默认沿用自动值；要统一值就把规则改成「固定值」）',
        ],
    warnings,
    '勾好 SET 字段后出语句',
  )
}

/** 显式规则的参数没填 → 那一列会按 NULL 输出，生成前挂出来（同 INSERT 口径） */
function emptyRuleWarn(
  table: TableInfo,
  sets: Column[],
  rules: RuleMap,
  dialect: Dialect,
): BatchWarning | null {
  const bad = sets.filter(
    (c) =>
      !(rules[c.name]?.k === undefined ||
        rules[c.name]?.k === 'auto' ||
        rules[c.name]?.k === 'now' ||
        rules[c.name]?.k === 'null') &&
      displayCell(table, c, 1, rules, 'update', dialect) === '',
  )
  return bad.length
    ? { tone: 'warn', msg: `${bad.map((c) => c.name).join('、')} 的规则参数没填，这些列按 NULL 输出` }
    : null
}

export function generateBatchUpdate(table: TableInfo, o: UpdateOptions): BatchResult {
  if (o.locator.mode === 'pk') return genUpdatePk(table, o)
  if (o.locator.mode === 'cond') return genUpdateCond(table, o)
  return genUpdateFixed(table, o)
}

/* ---------- 定位一：主键列表（§4.16 输出格式①逐条 / 高级模式 CASE WHEN）---------- */

function genUpdatePk(table: TableInfo, o: UpdateOptions): BatchResult {
  const spec = DIALECTS[o.dialect]
  const q = spec.quote
  const loc = o.locator as Extract<UpdateLocator, { mode: 'pk' }>
  const { list: pks, overRange } = parsePkList(loc.raw)
  const pkc = table.columns.find((c) => c.isPrimaryKey) ?? table.columns[0]

  /* 这两条警告只跟「哪张表 + 贴了什么列表」有关，SET 配没配完不影响它们成立。
     所以先算出来，连拒绝生成的分支也带上。 */
  const warns: BatchWarning[] = []
  if (overRange)
    warns.push({ tone: 'warn', msg: `${overRange} 个范围写法跨度超过 2000 已跳过（防手滑展开几十万个主键）` })
  if (table.columns.filter((c) => c.isPrimaryKey).length > 1)
    warns.push({
      tone: 'warn',
      msg: `复合主键表：WHERE 只用了第一列 ${pkc.name} —— 复合主键要几列一起才唯一，执行前确认`,
    })
  if (!pks.length)
    return refuse(
      [
        '先粘贴主键列表：范围(1-100) / 逗号 / 空格 / 换行都可以',
        '这份列表就是 WHERE 的全部范围，执行前核对一遍个数',
      ],
      warns,
      '← 左边贴主键后，这里抽样展示',
    )

  const sets = setColsOf(table, o.setOn)
  if (!sets.length) return emptySetRefuse(table, warns)
  const er = emptyRuleWarn(table, sets, o.rules, o.dialect)
  if (er) warns.push(er)

  const head = header([
    `批量UPDATE : ${table.name}${table.comment ? ` (${table.comment})` : ''} · 定位方式：主键列表`,
    `给定主键 ${pks.length} 个 · 格式 ${loc.outputFormat === 'case' ? 'CASE WHEN(100条/组)' : `逐条(${loc.batchSize}条/批)`} · ${spec.label}`,
    `SET：${sets.map((c) => c.name).join('，')}（新值来自字段规则，随行号变化）`,
    '说明：没有旧值可比，全部给定主键都进 WHERE；要只改值有变化的行，用「SQL语句转换」',
  ])

  /** 第 i 个主键（1 起）的一条完整 UPDATE。SET 值取行号 i 的规则值 */
  const stmtFor = (i: number): string =>
    `UPDATE ${q(table.name)} SET\n${sets
      .map((c) => `  ${q(c.name)} = ${renderValue(c, displayCell(table, c, i, o.rules, 'update', o.dialect), o.dialect)}`)
      .join(',\n')}\nWHERE ${q(pkc.name)} = ${renderValue(pkc, pks[i - 1], o.dialect)};`

  let body: string
  if (loc.outputFormat === 'case') {
    // CASE WHEN：每 100 个主键一组（§4.16「每 100 条一组，分成多批」）。
    // 随行变化的列进 CASE 块，固定值列普通赋值；全固定时退化成 IN 更新
    const CH = 100
    const vc = sets.filter((c) => ruleVaries(o.rules[c.name]))
    const ic = sets.filter((c) => !ruleVaries(o.rules[c.name]))
    const chunks: string[] = []
    for (let g = 0; g < pks.length; g += CH) {
      const idx = pks.slice(g, g + CH)
      const setLines = vc
        .map(
          (c) =>
            `  ${q(c.name)} = CASE ${q(pkc.name)}\n${idx
              .map(
                (x, j) =>
                  `    WHEN ${renderValue(pkc, x, o.dialect)} THEN ${renderValue(
                    c,
                    displayCell(table, c, g + j + 1, o.rules, 'update', o.dialect),
                    o.dialect,
                  )}`,
              )
              .join('\n')}\n    END`,
        )
        .join(',\n')
      const plain = ic
        .map((c) => `${q(c.name)} = ${renderValue(c, displayCell(table, c, 1, o.rules, 'update', o.dialect), o.dialect)}`)
        .join(', ')
      const allSet = [setLines, plain].filter(Boolean).join(setLines && plain ? ',\n' : '')
      chunks.push(`UPDATE ${q(table.name)} SET\n${allSet}\nWHERE ${q(pkc.name)} IN (${idx.map((x) => renderValue(pkc, x, o.dialect)).join(', ')});`)
    }
    body = chunks.join('\n\n')
  } else {
    const parts: string[] = []
    let bno = 0
    const batch = Math.min(500, Math.max(1, loc.batchSize))
    for (let g = 0; g < pks.length; g += batch) {
      const grp: string[] = []
      for (let j = g; j < Math.min(g + batch, pks.length); j += 1) grp.push(stmtFor(j + 1))
      if (pks.length > batch) {
        bno += 1
        parts.push(`-- ── 第 ${bno} 批（${grp.length} 条）──`)
      }
      parts.push(grp.join('\n\n'))
    }
    body = parts.join('\n\n')
  }

  const shown = pks.slice(0, 10)
  return {
    sql: `${head}\n\n${body}\n`,
    stat: `${pks.length} 个主键 · ${loc.outputFormat === 'case' ? 'CASE WHEN' : '逐条'}`,
    refused: false,
    warnings: warns,
    preview: {
      kind: 'rows',
      columns: sets,
      cells: shown.map((_, j) =>
        sets.map((c) => {
          const v = displayCell(table, c, j + 1, o.rules, 'update', o.dialect)
          return v === '' ? '（参数未填）' : v
        }),
      ),
    },
    previewLabel: `共 ${pks.length} 行 · 主键 ${pkc.name} 抽样前 ${shown.length}`,
  }
}

/* ---------- 定位二：条件字段（空值是 IS NULL，永远不是 = NULL）---------- */

function genUpdateCond(table: TableInfo, o: UpdateOptions): BatchResult {
  const spec = DIALECTS[o.dialect]
  const q = spec.quote
  const loc = o.locator as Extract<UpdateLocator, { mode: 'cond' }>
  const conds = sortColumnsForUi(
    table.columns.filter((c) => Object.prototype.hasOwnProperty.call(loc.conditions, c.name)),
  )
  if (!conds.length)
    return refuse(
      [
        '至少勾一个条件字段：无 WHERE 的批量 UPDATE 改的是全表',
        '这是防呆，不是限制——真要清空条件请用「按固定条件」并勾选确认',
      ],
      [{ tone: 'err', msg: '一个条件都没勾：生成的语句会不带 WHERE、改掉全表，所以拒绝生成。' }],
      '勾选 WHERE 条件字段后，这里明示最终子句',
    )

  const sets = setColsOf(table, o.setOn)
  if (!sets.length) return emptySetRefuse(table, [])
  const warns: BatchWarning[] = []
  const er = emptyRuleWarn(table, sets, o.rules, o.dialect)
  if (er) warns.push(er)

  const whereTxt = conds
    .map((c) => {
      const v = String(loc.conditions[c.name] ?? '').trim()
      // 空值是 IS NULL，永远不是 = NULL —— 后者恒为 unknown，一行都匹配不上还不报错
      return v === '' || /^null$/i.test(v)
        ? `${q(c.name)} IS NULL`
        : `${q(c.name)} = ${renderValue(c, v, o.dialect)}`
    })
    .join('\n  AND ')

  // 条件模式一条语句影响多行，没有「第 n 行」的概念：随行号变化的规则只取第 1 行的值，
  // 明说而不是装没看见
  const anyVary = sets.some((c) => ruleVaries(o.rules[c.name]))
  if (anyVary)
    warns.push({
      tone: 'warn',
      msg: 'SET 规则含模板/随机类：此定位没有行号，全部匹配行都取第 1 行的值；要每行不同请用主键列表定位。',
    })

  const head = header([
    `批量UPDATE : ${table.name}${table.comment ? ` (${table.comment})` : ''} · 定位方式：条件字段`,
    `WHERE：${conds.map((c) => c.name).join(' AND ')} · SET：${sets.map((c) => c.name).join('，')} · ${spec.label}`,
    ...(anyVary ? ['注意：SET 规则随行号变化，此模式统一取第 1 行的值套用到所有匹配行'] : []),
    '影响多少行执行前先拿同条件 SELECT 核一遍 —— 工具不猜行数',
  ])

  return {
    sql: `${head}\n\nUPDATE ${q(table.name)} SET\n${sets
      .map((c) => `  ${q(c.name)} = ${renderValue(c, displayCell(table, c, 1, o.rules, 'update', o.dialect), o.dialect)}`)
      .join(',\n')}\nWHERE\n  ${whereTxt};\n`,
    stat: `${conds.length} 个条件`,
    refused: false,
    warnings: warns,
    preview: { kind: 'text', text: `WHERE\n  ${whereTxt}` },
    previewLabel: `${conds.length} 个条件 AND 连接`,
  }
}

/* ---------- 定位三：固定条件 WHERE 1=1（§4.16 第三种，慎用）---------- */

function genUpdateFixed(table: TableInfo, o: UpdateOptions): BatchResult {
  const spec = DIALECTS[o.dialect]
  const q = spec.quote
  const loc = o.locator as Extract<UpdateLocator, { mode: 'fixed' }>
  const sets = setColsOf(table, o.setOn)
  if (!sets.length) return emptySetRefuse(table, [])
  if (!loc.confirmed)
    return refuse(
      [
        '「按固定条件」就是 WHERE 1=1：这张表的每一行都会被改掉。',
        '先勾选「我确认要更新这张表的全部行」，再回来生成。',
      ],
      [{ tone: 'err', msg: '全表更新（慎用）：该定位不带任何过滤。真要执行，先勾选确认框。' }],
      '确认后这里展示最终语句',
    )
  const warns: BatchWarning[] = []
  const er = emptyRuleWarn(table, sets, o.rules, o.dialect)
  if (er) warns.push(er)
  warns.push({
    tone: 'warn',
    msg: '这条语句会更新全表。规格标了「慎用」——确认框挡住的是误触，挡不住决心，执行前再核一遍行数。',
  })

  const head = header([
    `批量UPDATE : ${table.name}${table.comment ? ` (${table.comment})` : ''} · 定位方式：固定条件 WHERE 1=1 ⚠ 全表更新`,
    `SET：${sets.map((c) => c.name).join('，')} · ${spec.label}`,
    '执行前务必拿 SELECT COUNT(*) 核一遍行数；建议先在事务里跑，确认影响行数再提交',
  ])

  return {
    sql: `${head}\n\nUPDATE ${q(table.name)} SET\n${sets
      .map((c) => `  ${q(c.name)} = ${renderValue(c, displayCell(table, c, 1, o.rules, 'update', o.dialect), o.dialect)}`)
      .join(',\n')}\nWHERE 1=1;\n`,
    stat: '全表（WHERE 1=1）',
    refused: false,
    warnings: warns,
    preview: { kind: 'text', text: `UPDATE ${q(table.name)} SET …\nWHERE 1=1;   ← 无任何过滤，每一行都会被更新` },
    previewLabel: '慎用：影响全表',
  }
}
