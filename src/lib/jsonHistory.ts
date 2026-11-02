/** JSON 查看页的历史记录：解析、去重、裁剪、筛选。存储位见 storage/jsonHistory.ts */

export interface JsonHistoryEntry {
  id: string
  /** 压成一行的 JSON（大整数原样），也是去重依据 */
  json: string
  /** 码上测带过来的接口名；null = 自己贴的 */
  from: string | null
  /** 最近一次记录的时间，ISO */
  at: string
  /** 用户起的名字；没起就没有这个字段（老记录也是） */
  name?: string
}

export const JSON_HISTORY_LIMIT = 50
/** 单条上限：再大的存进来拖慢启动，超了就不记 */
export const JSON_HISTORY_MAX_CHARS = 512 * 1024

const isEntry = (v: unknown): v is JsonHistoryEntry => {
  const e = v as JsonHistoryEntry
  return (
    !!e &&
    typeof e.id === 'string' &&
    typeof e.json === 'string' &&
    typeof e.at === 'string' &&
    (e.from === null || typeof e.from === 'string') &&
    (e.name === undefined || typeof e.name === 'string')
  )
}

/** 坏的跳过；blob 损坏返回空——历史不能挡着页面用 */
export function parseJsonHistory(raw: string | null): JsonHistoryEntry[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter(isEntry).slice(0, JSON_HISTORY_LIMIT) : []
  } catch {
    return []
  }
}

/**
 * 记一条：同样内容只留一条并提到最前，来源和名字保留已知的。超上限先裁最旧的
 * 未命名记录——起过名字的是用户想留的。返回新数组
 */
export function addJsonHistory(list: JsonHistoryEntry[], entry: JsonHistoryEntry): JsonHistoryEntry[] {
  if (!entry.json || entry.json.length > JSON_HISTORY_MAX_CHARS) return list
  const old = list.find((e) => e.json === entry.json)
  const name = entry.name?.trim() || old?.name
  const next: JsonHistoryEntry = { ...entry, id: old?.id ?? entry.id, from: entry.from ?? old?.from ?? null }
  if (name) next.name = name
  else delete next.name
  const all = [next, ...list.filter((e) => e.json !== entry.json)]
  while (all.length > JSON_HISTORY_LIMIT) {
    let i = all.length - 1
    while (i > 0 && all[i]!.name) i--
    // 除了刚记的这条全都有名字：只好裁最旧的
    all.splice(i > 0 ? i : all.length - 1, 1)
  }
  return all
}

/** 改名；空串 = 去掉名字。不动顺序和时间 */
export function renameJsonHistory(list: JsonHistoryEntry[], id: string, name: string): JsonHistoryEntry[] {
  const n = name.trim()
  return list.map((e) => {
    if (e.id !== id) return e
    const { name: _old, ...rest } = e
    return n ? { ...rest, name: n } : rest
  })
}

/**
 * 没起名字时给个「大概是啥」的标题：码上测的用接口名，自己贴的列顶层字段；
 * 顶层是 code/msg/data 这种包装就往 data 里再看一层，那里才是业务字段
 */
export function autoTitle(e: JsonHistoryEntry): string {
  if (e.from) return e.from
  let v: unknown
  try {
    v = JSON.parse(e.json)
  } catch {
    return e.json.slice(0, 60)
  }
  return describe(v)
}

const WRAP_KEYS = ['data', 'result', 'body', 'rows', 'list', 'records']

function describe(v: unknown): string {
  if (Array.isArray(v)) {
    const first: unknown = v[0]
    const inner = first && typeof first === 'object' && !Array.isArray(first) ? `：${keysOf(first)}` : ''
    return `${v.length} 项${inner}`
  }
  if (!v || typeof v !== 'object') return String(v)
  const o = v as Record<string, unknown>
  const wrap = WRAP_KEYS.find((k) => o[k] && typeof o[k] === 'object')
  return wrap ? `${wrap} → ${describe(o[wrap])}` : keysOf(o)
}

function keysOf(o: object): string {
  const ks = Object.keys(o)
  if (!ks.length) return '空对象'
  return ks.slice(0, 5).join(' · ') + (ks.length > 5 ? ` 等 ${ks.length} 个字段` : '')
}

export function matchJsonHistory(e: JsonHistoryEntry, q: string): boolean {
  const s = q.trim().toLowerCase()
  return (
    !s ||
    (e.name ?? '').toLowerCase().includes(s) ||
    e.json.toLowerCase().includes(s) ||
    (e.from ?? '').toLowerCase().includes(s)
  )
}

/** 列表里的时间：当天只给时分，其余带月日 */
export function historyTime(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  return d.toDateString() === now.toDateString() ? hm : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`
}

export function historySize(chars: number): string {
  return chars < 1024 ? `${chars} 字符` : `${(chars / 1024).toFixed(1)} KB`
}
