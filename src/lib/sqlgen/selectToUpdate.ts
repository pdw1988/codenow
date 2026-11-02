/**
 * SELECT转UPDATE，PRD v6.4 §4.16（批量可执行 UPDATE —— 从 SELECT 结果导入）。
 *
 * 场景：业务提改数需求时的老流程是「查数据 → 截图标注 → 对着截图手写 UPDATE」，
 * 这里压缩成「粘贴查询结果 → 确认主键和字段 → 拿走一条 UPDATE」。
 *
 * 三条已拍板的语义（2026-08-26 原型评审，`mockup/select2update.html`）：
 * 1. WHERE 只放进「值有变化」的行。PRD §4.16 自己两处矛盾（界面草图放全部主键、
 *    用户旅程只放变化的）——按旅程的来：旧值已经等于目标值的行进 WHERE 只是白锁几行。
 * 2. 目标值留空 = 「粘贴数据里的就是要改成的值」（业务直接发来一份已改好的清单的场景）；
 *    此时无从比对旧值，所有行都算要改。
 * 3. 手动指定 IN 格式但某字段的逐行值不同时，不硬拗——IN 写不下那种值，
 *    降级成 CASE WHEN 并把原因写进 warnings。静默降级等于悄悄生成另一条语句。
 *
 * 全是纯函数：解析、识别、生成分开导出，界面 useMemo 实时重算——本项目没有「生成」按钮。
 */
import type { Column, Dialect, TableInfo } from '../../types/schema'
import { DIALECTS } from './dialect'
import { renderValue } from './mockValue'
import { header } from './singleTable'

/* ================= 解析：粘贴文本 → PastedTable ================= */

export interface PastedColumn {
  /** 结果里写的列名；无表头时 = 按位置对齐到的表字段名 */
  name: string
  /**
   * 表结构缓存里的字段元数据。null = 缓存里没有这列（结果里带来的陌生列、
   * 或无表头粘贴超出了表的列数）。null 只影响字面量的类型判断，不影响生成。
   */
  column: Column | null
}

export interface PastedTable {
  cols: PastedColumn[]
  rows: string[][]
  /** 第一行是不是表头 */
  header: boolean
  /** 单列模式：整段只有一列值，当作主键列表（PRD §4.16 输入格式的第三种） */
  single: boolean
}

/**
 * 分隔符优先级：Tab > 竖线 > 逗号 > 空白。
 * Tab 必须排最前：Excel / 结果网格复制是 Tab，而格子里的 JSON、坐标经常带 `|`
 * （`442,200|442,200`）和逗号。旧顺序「竖线 > Tab」会把一整格从中间劈开，后面列全错位。
 * 竖线/逗号只在切出来的格数像一张表时才用——JSON 里的 `|` 会切出远多于字段的格子。
 */
function delimFits(n: number, colCount: number): boolean {
  return n >= 2 && n <= Math.max(colCount + 2, 8)
}

function pickDelim(lines: string[], colCount: number): string {
  if (lines.some((l) => l.includes('\t'))) return '\t'
  if (lines.some((l) => l.includes('|'))) {
    const n = splitPasteLine(lines[0], '|').length
    if (delimFits(n, colCount)) return '|'
  }
  if (lines.some((l) => l.includes(','))) {
    const n = splitPasteLine(lines[0], ',').length
    if (delimFits(n, colCount)) return ','
  }
  return ''
}

function splitPasteLine(line: string, delim: string): string[] {
  if (delim === '\t') {
    // 只按 Tab 切：格子里的空格（日期时间、JSON 条件）和空格子（连续 Tab）必须原样留下。
    // 行两端也不 trim——查询结果第一列/最后一列是 NULL 时，复制出来就是开头或结尾的 Tab。
    return line.split('\t').map((x) => x.trim())
  }
  let s = line.trim()
  if (delim === '|') {
    // 表格两端的装饰竖线不是分隔符：| id | name | 切出来是 ['id','name'] 不是 ['','id','name','']
    if (s.startsWith('|')) s = s.slice(1)
    if (s.endsWith('|')) s = s.slice(0, -1)
    return s.split('|').map((x) => x.trim())
  }
  if (delim === ',') return s.split(',').map((x) => x.trim())
  return s.split(/\s+/).map((x) => x.trim())
}

const isNumericLike = (s: string) => /^-?\d+(\.\d+)?$/.test(s.trim())

const colByName = (table: TableInfo, name: string): Column | undefined =>
  table.columns.find((c) => c.name.toLowerCase() === name.toLowerCase())

/**
 * 把粘贴的查询结果解析成表。
 *
 * 表头判定：首行至少一个词命中表结构的字段名，且整行没有数字。只查命中不查数字的话，
 * 无表头粘贴且第一列恰好是字符串时会误判；反过来只查数字会把「全部是字符串列的真表头」放走，
 * 两个条件都要满足。
 */
export function parsePastedTable(raw: string, table: TableInfo): PastedTable | null {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim().length > 0)
  if (!lines.length) return null

  const delim = pickDelim(lines, table.columns.length)
  const firstCells = splitPasteLine(lines[0], delim)
  const multiCol = firstCells.length > 1 || lines.some((l) => splitPasteLine(l, delim).length > 1)

  let headerRow = false
  if (multiCol) {
    const hits = firstCells.filter((c) => colByName(table, c)).length
    headerRow = hits >= 1 && !firstCells.some(isNumericLike)
  }

  const bodyLines = headerRow ? lines.slice(1) : lines
  let cols: PastedColumn[]
  if (!multiCol) {
    // 单列值列表只提供 WHERE 用的主键。列名借缓存主键的名字，让字面量类型跟着真字段走
    const pkc = table.columns.find((c) => c.isPrimaryKey)
    cols = [{ name: pkc ? pkc.name : 'id', column: pkc ?? null }]
  } else if (headerRow) {
    // 列名跟缓存对齐：Oracle 表常是 ID，网格复制常是 id。
    // 名字不统一的话 detectPk 拿缓存的 ID、cellOf 按 id 找，WHERE 里全是空。
    cols = firstCells.map((name) => {
      const column = colByName(table, name) ?? null
      return { name: column?.name ?? name, column }
    })
  } else {
    // 无表头的纯文本按**位置**对齐当前表的字段顺序。对的是表自己的列序
    // （order 表第 2 列是 user_id），不是从内容猜出来的列——猜必错一半
    const width = Math.max(...bodyLines.map((l) => splitPasteLine(l, delim).length))
    cols = Array.from({ length: width }, (_, i) => {
      const c = table.columns[i]
      return c ? { name: c.name, column: c } : { name: `第${i + 1}列`, column: null }
    })
  }

  const rows = bodyLines.map((l) => {
    const cs = splitPasteLine(l, delim)
    while (cs.length < cols.length) cs.push('')
    return cs.slice(0, cols.length)
  })

  return { cols, rows, header: headerRow, single: !multiCol }
}

/* ================= 主键识别（PRD §4.16 三级优先） ================= */

export type PkSource = 'cache' | 'idName' | 'first'

/**
 * 缓存主键 > 字段名含 id > 兜底第一列。来源要展示给用户：
 * 认错主键 = 改错行，「猜出来的」必须挂 ⚠️ 让人确认，不能只给一个名字。
 */
export function detectPk(parsed: PastedTable, table: TableInfo): { name: string; source: PkSource } {
  const cachedPk = table.columns.find((c) => c.isPrimaryKey)
  const cacheHit = cachedPk
    ? parsed.cols.find((c) => c.name.toLowerCase() === cachedPk.name.toLowerCase())
    : undefined
  if (cacheHit) return { name: cacheHit.name, source: 'cache' }
  const idish = parsed.cols.find((c) => /(^|_)id$/i.test(c.name))
  if (idish) return { name: idish.name, source: 'idName' }
  return { name: parsed.cols[0].name, source: 'first' }
}

/** 用户在下拉里手动指定的主键还存在于当前解析结果里才有效；换表/重粘后失效回自动 */
export function resolvePk(
  parsed: PastedTable,
  table: TableInfo,
  manualPk: string | null,
): { name: string; source: PkSource | 'manual'; manual: boolean } {
  if (manualPk) {
    const hit = parsed.cols.find((c) => c.name.toLowerCase() === manualPk.toLowerCase())
    if (hit) return { name: hit.name, source: 'manual', manual: true }
  }
  return { ...detectPk(parsed, table), manual: false }
}

/* ================= 值语义 ================= */

export type TargetMap = Record<string, string>
export type CheckedMap = Record<string, boolean>

/** 目标值原文 trim 后为空才算「没填」——用户敲个空格不代表放弃了输入 */
export const targetOf = (targets: TargetMap, field: string): string => {
  if (Object.prototype.hasOwnProperty.call(targets, field)) return (targets[field] ?? '').trim()
  const key = Object.keys(targets).find((k) => k.toLowerCase() === field.toLowerCase())
  return (key !== undefined ? targets[key] : '').trim()
}

export const cellOf = (parsed: PastedTable, field: string, rowIdx: number): string | null => {
  const ci = parsed.cols.findIndex((c) => c.name.toLowerCase() === field.toLowerCase())
  return ci < 0 ? null : parsed.rows[rowIdx][ci]
}

/**
 * 字段能不能参与更新：要么粘贴数据里有它的格子，要么填了目标值。
 * 单列模式下字段全部来自表结构，没填目标值的字段新值只能是 NULL——
 * 「把这几行的 username 全改成 NULL」几乎从来不是用户的意思，必须拦下来明说。
 */
export function fieldUsable(parsed: PastedTable, targets: TargetMap, field: string): boolean {
  return targetOf(targets, field) !== '' || cellOf(parsed, field, 0) !== null
}

/**
 * 该字段在第 idx 行的有效新值：填了目标值用它；没填则粘贴里的每行值就是新值（语义第 2 条）。
 * 仅对 fieldUsable 的字段调用。
 */
export function effectiveValue(
  parsed: PastedTable,
  targets: TargetMap,
  field: string,
  rowIdx: number,
): string {
  const t = targetOf(targets, field)
  return t !== '' ? t : (cellOf(parsed, field, rowIdx) ?? '')
}

/**
 * 第 idx 行要不要进 UPDATE（语义第 1、2 条）：
 * 目标值没填的字段无从比对（粘贴的就是终态），一律算要改；
 * 填了才做 旧≠新 判断——已是目标值的行进 WHERE 只是白锁几行。
 */
export function rowIncluded(
  parsed: PastedTable,
  fields: string[],
  targets: TargetMap,
  rowIdx: number,
): boolean {
  return fields.some((f) => {
    const t = targetOf(targets, f)
    if (t === '') return true
    const old = cellOf(parsed, f, rowIdx)
    return old === null ? true : old !== t
  })
}

export function includedIndices(
  parsed: PastedTable,
  fields: string[],
  targets: TargetMap,
): number[] {
  return parsed.rows.map((_, i) => i).filter((i) => rowIncluded(parsed, fields, targets, i))
}

/** IN 格式的前提：这个字段对所有入选行的有效新值全一致 */
export function uniformAcross(
  parsed: PastedTable,
  targets: TargetMap,
  field: string,
  indices: number[],
): boolean {
  if (!indices.length) return true
  const first = effectiveValue(parsed, targets, field, indices[0])
  return indices.every((i) => effectiveValue(parsed, targets, field, i) === first)
}

/* ================= 格式选择与生成 ================= */

export type S2uFormat = 'auto' | 'each' | 'in' | 'case'

export interface ResolvedFormat {
  kind: 'none' | 'each' | 'in' | 'case'
  /** 自动选择时标出来，界面上写「自动 → IN 列表」，让人知道为什么是这个形状 */
  auto?: boolean
  warning?: string
}

export function resolveFormat(
  format: S2uFormat,
  varyingFields: string[],
): ResolvedFormat {
  if (format === 'each') return { kind: 'each' }
  if (format === 'case') return { kind: 'case' }
  if (format === 'in')
    return varyingFields.length
      ? {
          kind: 'case',
          warning: `${varyingFields.join('、')} 的目标值逐行不同，IN 格式表达不了 —— 已按 CASE WHEN 输出`,
        }
      : { kind: 'in' }
  // 自动（PRD §4.16）：各行新值相同 → IN 列表（一条语句，效率最高）；有不同 → CASE WHEN
  return varyingFields.length ? { kind: 'case', auto: true } : { kind: 'in', auto: true }
}

export interface S2uOptions {
  dialect: Dialect
  format: S2uFormat
  /** 字段名 → 目标值原文（未 trim）。空串 = 没填 */
  targets: TargetMap
  /** 字段名 → 是否勾选更新 */
  checked: CheckedMap
}

export interface S2uResult {
  sql: string
  pastedCount: number
  includedCount: number
  skippedCount: number
  resolved: ResolvedFormat
  /** 勾了但既不在粘贴数据里也没填目标值的字段——它们被排除的原因要说清楚 */
  invalidFields: string[]
}

/** 缓存里没有的列只能按值的形状猜类型：整数裸着、小数裸着、日期走方言函数、其余当字符串 */
function guessColumn(name: string, text: string): Column {
  const v = text.trim()
  const base: Column = {
    name,
    type: '',
    nullable: true,
    isPrimaryKey: false,
    isAutoIncrement: false,
    javaField: name.replace(/_([a-z0-9])/g, (_m, x: string) => x.toUpperCase()),
    javaType: 'String',
  }
  if (/^-?\d+$/.test(v)) return { ...base, javaType: 'Integer' }
  if (/^-?\d+\.\d+$/.test(v)) return { ...base, javaType: 'java.math.BigDecimal' }
  if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(v))
    return { ...base, type: 'DATETIME', javaType: 'java.time.LocalDateTime' }
  return base
}

export function buildSelectToUpdate(
  table: TableInfo,
  parsed: PastedTable,
  pk: string,
  options: S2uOptions,
): S2uResult {
  const spec = DIALECTS[options.dialect]
  const q = spec.quote
  /*
   * 可勾选的字段 = 粘贴结果里的列 ∪ 表结构缓存里的列。
   * 并集是刻意的：单列模式下字段全部来自表结构（PRD §4.16 第三种输入只提供主键）；
   * 带表头的粘贴里没出现的缓存字段也允许勾——填上目标值它就退化成「按主键列表批量改」，
   * 这正是 PRD 里另外两种定位方式的交集形态。顺序按表定义序排，同配置两次生成可 diff；
   * 不在表里的列（结果里带来的陌生列、超宽的「第N列」）垫在后面按粘贴序。
   */
  const orderedCandidates = [
    ...table.columns.map((c) => c.name),
    ...parsed.cols
      .map((c) => c.name)
      .filter((n) => !table.columns.some((tc) => tc.name.toLowerCase() === n.toLowerCase())),
  ]
  const checkedOf = (n: string) =>
    !!options.checked[n] ||
    Object.entries(options.checked).some(([k, v]) => v && k.toLowerCase() === n.toLowerCase())
  const allChecked = orderedCandidates.filter((n) => n.toLowerCase() !== pk.toLowerCase() && checkedOf(n))
  const invalidFields = allChecked.filter((f) => !fieldUsable(parsed, options.targets, f))
  const fields = allChecked.filter((f) => fieldUsable(parsed, options.targets, f))

  const base = {
    pastedCount: parsed.rows.length,
    resolved: { kind: 'none' } as ResolvedFormat,
    invalidFields,
  }

  const litOf = (field: string, rowIdx: number): string => {
    const text = effectiveValue(parsed, options.targets, field, rowIdx)
    const meta =
      parsed.cols.find((c) => c.name.toLowerCase() === field.toLowerCase())?.column ??
      guessColumn(field, text)
    return renderValue(meta, text, options.dialect)
  }
  const pkLitOf = (rowIdx: number): string => {
    const text = cellOf(parsed, pk, rowIdx) ?? ''
    const meta =
      parsed.cols.find((c) => c.name.toLowerCase() === pk.toLowerCase())?.column ?? guessColumn(pk, text)
    return renderValue(meta, text, options.dialect)
  }

  if (!fields.length)
    return {
      ...base,
      includedCount: 0,
      skippedCount: 0,
      sql: '-- 还不能生成：先在左边勾选要更新的字段\n-- 单列模式下来的字段要填目标值才会生效',
    }

  const inc = includedIndices(parsed, fields, options.targets)
  if (!inc.length)
    return {
      ...base,
      resolved: { kind: 'none' },
      includedCount: 0,
      skippedCount: parsed.rows.length,
      sql: '-- 所有记录都已是目标值，不需要 UPDATE',
    }

  const varying = fields.filter((f) => !uniformAcross(parsed, options.targets, f, inc))
  const resolved = resolveFormat(options.format, varying)

  /* 注释头照 PRD §4.16 的样式：一眼看到改哪张表、几行、每个字段的去向 */
  const headLines = [
    `SELECT转UPDATE : ${table.name}${table.comment ? ` (${table.comment})` : ''}`,
    `粘贴 ${parsed.rows.length} 行 · 更新 ${inc.length} 行 · 主键 ${pk} · ${spec.label}`,
    ...fields.map((f) =>
      uniformAcross(parsed, options.targets, f, inc)
        ? `${f} → ${effectiveValue(parsed, options.targets, f, inc[0])}${targetOf(options.targets, f) === '' ? '（以粘贴值为准，各行相同）' : '（各行相同）'}`
        : `${f} → 各行赋不同值（CASE WHEN）`,
    ),
  ]

  const setEntries = fields.map((f) => {
    if (uniformAcross(parsed, options.targets, f, inc)) return { field: f, text: `  ${q(f)} = ${litOf(f, inc[0])}` }
    const body = inc
      .map((i) => `    WHEN ${pkLitOf(i)} THEN ${litOf(f, i)}`)
      .join('\n')
    return { field: f, text: `  ${q(f)} = CASE ${q(pk)}\n${body}\n    END` }
  })

  const whereIn = `WHERE ${q(pk)} IN (${inc.map((i) => pkLitOf(i)).join(', ')})`
  let body: string
  if (resolved.kind === 'each') {
    body = inc
      .map((i) =>
        [
          `UPDATE ${q(table.name)} SET`,
          setEntries
            .map((e) => (uniformAcross(parsed, options.targets, e.field, inc) ? e.text : `  ${q(e.field)} = ${litOf(e.field, i)}`))
            .join(',\n'),
          `WHERE ${q(pk)} = ${pkLitOf(i)};`,
        ].join('\n'),
      )
      .join('\n\n')
  } else {
    body = [`UPDATE ${q(table.name)} SET`, setEntries.map((e) => e.text).join(',\n'), `${whereIn};`].join('\n')
  }

  return {
    ...base,
    resolved,
    includedCount: inc.length,
    skippedCount: parsed.rows.length - inc.length,
    sql: [header(headLines), body].join('\n\n'),
  }
}
