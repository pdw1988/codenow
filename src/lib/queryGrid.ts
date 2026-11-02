/**
 * 连库查询结果的纯函数：排序、筛选、复制成 INSERT。
 * 只动已经拉回来的格子，不再打库、不改用户 SQL。
 */
import { DIALECTS, type GenDialect } from './sqlgen/dialect'

export type SortDir = 'asc' | 'desc'

export interface GridSort {
  col: number
  dir: SortDir
}

const NUM = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/
const DATE = /^\d{4}-\d{1,2}-\d{1,2}( \d{1,2}:\d{2}(:\d{2})?)?$/

/** 空值垫底。两边都像数字就按数值比，避免 9 排在 10 后面。 */
export function compareCells(a: string, b: string): number {
  const ea = a.trim() === ''
  const eb = b.trim() === ''
  if (ea && eb) return 0
  if (ea) return 1
  if (eb) return -1
  if (NUM.test(a.trim()) && NUM.test(b.trim())) {
    return Number(a) - Number(b)
  }
  return a.localeCompare(b, 'zh')
}

export function sortRows(rows: string[][], sort: GridSort | null): number[] {
  const idx = rows.map((_, i) => i)
  if (!sort) return idx
  const { col, dir } = sort
  idx.sort((i, j) => {
    const c = compareCells(rows[i][col] ?? '', rows[j][col] ?? '')
    return dir === 'asc' ? c : -c
  })
  return idx
}

export function nextSort(cur: GridSort | null, col: number): GridSort | null {
  if (!cur || cur.col !== col) return { col, dir: 'asc' }
  if (cur.dir === 'asc') return { col, dir: 'desc' }
  return null
}

/** 任一格包含关键字（不区分大小写）。空关键字 = 全过。 */
export function filterRows(rows: string[][], order: number[], needle: string): number[] {
  const q = needle.trim().toLowerCase()
  if (!q) return order
  return order.filter((i) => rows[i].some((c) => (c ?? '').toLowerCase().includes(q)))
}

export function gridToTsv(columns: string[], rows: string[][], indices: number[]): string {
  return [columns.join('\t'), ...indices.map((i) => rows[i].join('\t'))].join('\n')
}

export function guessTableFromSql(sql: string): string | null {
  const m = sql.match(
    /\bfrom\s+(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][\w$#]*))(?:\s*\.\s*(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][\w$#]*)))?/i,
  )
  if (!m) return null
  const a = m[1] || m[2] || m[3]
  const b = m[4] || m[5] || m[6]
  if (!a) return null
  return b ? `${a}.${b}` : a
}

export function gridLiteral(text: string, dialect: GenDialect): string {
  const v = text.trim()
  if (v === '') return 'NULL'
  const upper = v.toUpperCase()
  if (upper === 'TRUE' || upper === 'FALSE') return DIALECTS[dialect].boolLiteral(upper === 'TRUE')
  if (NUM.test(v)) return v
  if (DATE.test(v)) return DIALECTS[dialect].dateLiteral(v)
  return `'${v.replace(/'/g, "''")}'`
}

export function buildInsertFromGrid(args: {
  dialect: GenDialect
  table: string
  columns: string[]
  rows: string[][]
  indices: number[]
}): string {
  const q = DIALECTS[args.dialect].quote
  if (!args.table.trim()) throw new Error('认不出表名。请点左边一张表再复制，或 SQL 里写清 FROM 表')
  if (args.indices.length === 0) throw new Error('先勾选要复制的行')
  const cols = args.columns.map((c) => q(c)).join(', ')
  const head = `INSERT INTO ${q(args.table)} (${cols}) VALUES`
  return args.indices
    .map((i) => {
      const vals = args.columns
        .map((_, c) => gridLiteral(args.rows[i][c] ?? '', args.dialect))
        .join(', ')
      return `${head} (${vals});`
    })
    .join('\n')
}

/** 行号列、勾选列宽度。CSS `--qgrid-rn` / `--qgrid-ck` 必须跟这两数一致，sticky left 才对得上。 */
export const GRID_RN_W = 48
export const GRID_CK_W = 36
/** 列头带序号徽章，72 会把短字段名裁成缝。 */
export const GRID_COL_MIN = 96
export const GRID_COL_MAX = 720
export const GRID_GUTTER = GRID_RN_W + GRID_CK_W

function chUnits(s: string): number {
  let n = 0
  const lim = Math.min(s.length, 64)
  for (let i = 0; i < lim; i++) n += s.charCodeAt(i) > 255 ? 2 : 1
  return n
}

/** 按列名和前几行内容估宽，拖动手柄再改。中文按两格算，避免短英文字段太窄、长备注撑破。 */
export function defaultColWidth(name: string, sample: readonly string[]): number {
  let u = chUnits(name)
  for (const v of sample) {
    const x = chUnits(v)
    if (x > u) u = x
  }
  // +28：排序箭头 + 拖动手柄余量
  return Math.min(GRID_COL_MAX, Math.max(GRID_COL_MIN, u * 8 + 28))
}

export function defaultColWidths(columns: string[], rows: string[][], sample = 48): number[] {
  const n = Math.min(rows.length, sample)
  return columns.map((name, c) => {
    const cells: string[] = []
    for (let i = 0; i < n; i++) cells.push(rows[i]?.[c] ?? '')
    return defaultColWidth(name, cells)
  })
}

/**
 * 内容估宽总和小于视口时，把余量均分到各列，避免右边空一大截。
 * 已经超出视口的不动——继续横滚，绝不 width:100% 把几十列挤成缝。
 */
export function expandColWidths(
  widths: number[],
  available: number,
  gutter = GRID_GUTTER,
): number[] {
  if (widths.length === 0 || available <= 0) return widths.slice()
  const room = available - gutter
  if (room <= 0) return widths.slice()
  const sum = widths.reduce((a, b) => a + b, 0)
  if (sum >= room) return widths.slice()
  let slack = room - sum
  const out = widths.slice()
  while (slack > 0) {
    let progressed = false
    for (let i = 0; i < out.length && slack > 0; i++) {
      if (out[i]! >= GRID_COL_MAX) continue
      out[i]! += 1
      slack -= 1
      progressed = true
    }
    if (!progressed) break
  }
  return out
}

/** 结果行高。跟 `.qgrid td` 的 padding + 行高对齐，虚拟列表用它算窗口。 */
export const GRID_ROW_H = 28

/**
 * 只画视口里那几行。一万行全进 DOM 会把窗口卡死（200 列 × 1 万 ≈ 两百万格子）。
 * overscan 多画几行，避免快滚露白。
 */
export function gridWindow(args: {
  scrollTop: number
  viewH: number
  n: number
  rowH?: number
  overscan?: number
}): { start: number; end: number; padTop: number; padBot: number } {
  const rowH = args.rowH ?? GRID_ROW_H
  const over = args.overscan ?? 10
  if (args.n <= 0) return { start: 0, end: 0, padTop: 0, padBot: 0 }
  const start = Math.max(0, Math.floor(Math.max(0, args.scrollTop) / rowH) - over)
  const vis = Math.ceil(Math.max(1, args.viewH) / rowH) + over * 2
  const end = Math.min(args.n, start + vis)
  return {
    start,
    end,
    padTop: start * rowH,
    padBot: Math.max(0, args.n - end) * rowH,
  }
}
