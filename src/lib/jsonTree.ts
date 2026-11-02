/**
 * JSON 查看页的树：先拍成一张节点表（前序，即显示顺序），展开 / 搜索都对着它算。
 * 数据来自 parsePreservingBig，大整数是哨兵串，显示时按数字还原。
 */
import { bigDigits, stringifyPreservingBig } from './bigIntJson'

export type Kind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'

export interface TreeNode {
  /** 路径，如 $.data.list[0].id，兼作唯一键 */
  id: string
  /** 根是 null */
  key: string | number | null
  value: unknown
  kind: Kind
  depth: number
  parent: string | null
  kids: string[]
  /** 同级最后一个：不带逗号 */
  last: boolean
}

export type TreeIndex = Map<string, TreeNode>

export type TreeRow =
  | { t: 'node'; node: TreeNode; open: boolean }
  | { t: 'close'; node: TreeNode }
  /** 子节点太多没画完：「还有 N 项」 */
  | { t: 'more'; node: TreeNode; rest: number }

/** 一个容器一次最多画这么多个子节点；两万项的数组全画出来页面会卡死 */
export const KID_PAGE = 200

const IDENT = /^[A-Za-z_$][\w$]*$/

const KIND_CN: Record<Kind, string> = {
  object: '对象',
  array: '数组',
  string: '字符串',
  number: '数字',
  boolean: '布尔',
  null: 'null',
}

export function kindOf(v: unknown): Kind {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (bigDigits(v) !== null) return 'number'
  if (typeof v === 'object') return 'object'
  if (typeof v === 'number') return 'number'
  if (typeof v === 'boolean') return 'boolean'
  return 'string'
}

const childId = (parent: string, key: string | number) =>
  typeof key === 'number'
    ? `${parent}[${key}]`
    : IDENT.test(key)
      ? `${parent}.${key}`
      : `${parent}[${JSON.stringify(key)}]`

export const isBox = (n: TreeNode) => n.kind === 'object' || n.kind === 'array'

export function indexTree(root: unknown): TreeIndex {
  const out: TreeIndex = new Map()
  const add = (
    id: string,
    key: string | number | null,
    value: unknown,
    depth: number,
    parent: string | null,
    last: boolean,
  ) => {
    const node: TreeNode = { id, key, value, kind: kindOf(value), depth, parent, kids: [], last }
    out.set(id, node)
    // 几十万个节点时不再为每个容器造 entries 数组
    if (node.kind === 'array') {
      const arr = value as unknown[]
      for (let i = 0; i < arr.length; i++) {
        const cid = `${id}[${i}]`
        node.kids.push(cid)
        add(cid, i, arr[i], depth + 1, id, i === arr.length - 1)
      }
    } else if (node.kind === 'object') {
      const obj = value as Record<string, unknown>
      const keys = Object.keys(obj)
      for (let i = 0; i < keys.length; i++) {
        const cid = childId(id, keys[i]!)
        node.kids.push(cid)
        add(cid, keys[i]!, obj[keys[i]!], depth + 1, id, i === keys.length - 1)
      }
    }
  }
  add('$', null, root, 0, null, true)
  return out
}

/** 叶子的显示文字：字符串带引号，大整数还原成裸数字 */
export function leafText(n: TreeNode): string {
  if (n.kind === 'object') return '{}'
  if (n.kind === 'array') return '[]'
  const big = bigDigits(n.value)
  if (big !== null) return big
  return n.kind === 'string' ? JSON.stringify(n.value) : String(n.value)
}

/** 父节点右侧的子节点概况：「6 个字段」「3 项 · 对象」 */
export function summary(index: TreeIndex, n: TreeNode): string {
  const len = n.kids.length
  if (n.kind === 'object') return len ? `${len} 个字段` : '空对象'
  if (n.kind !== 'array') return ''
  if (!len) return '空数组'
  const kinds = new Set(n.kids.map((id) => index.get(id)!.kind))
  const [only] = kinds
  return `${len} 项 · ${kinds.size === 1 ? KIND_CN[only!] : '混合'}`
}

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s)

/** 折叠时括号里的预览：对象列前几个字段名，对象数组列第一项的字段名 */
export function preview(index: TreeIndex, n: TreeNode): string {
  const kids = n.kids.map((id) => index.get(id)!)
  const keys = (list: TreeNode[], max: number) =>
    list.slice(0, max).map((k) => String(k.key)).join(', ') + (list.length > max ? ', …' : '')
  if (n.kind === 'object') return kids.length ? `{ ${keys(kids, 4)} }` : '{}'
  if (!kids.length) return '[]'
  const first = kids[0]!
  if (kids.every((k) => k.kind === 'object')) {
    const inner = first.kids.map((id) => index.get(id)!)
    return `[ { ${keys(inner, 3)} } × ${kids.length} ]`
  }
  const vals = kids.slice(0, 3).map((k) => (isBox(k) ? (k.kind === 'array' ? '[…]' : '{…}') : cut(leafText(k), 20)))
  return `[ ${vals.join(', ')}${kids.length > 3 ? ', …' : ''} ]`
}

/**
 * 当前展开状态下要画的行：展开的容器多一行闭括号。
 * 子节点只画前 `shown`（缺省 KID_PAGE）个，剩下的收成一行「还有 N 项」。
 */
export function visibleRows(
  index: TreeIndex,
  open: ReadonlySet<string>,
  shown: ReadonlyMap<string, number> = new Map(),
): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (n: TreeNode) => {
    const on = isBox(n) && n.kids.length > 0 && open.has(n.id)
    rows.push({ t: 'node', node: n, open: on })
    if (!on) return
    const max = shown.get(n.id) ?? KID_PAGE
    for (const id of n.kids.slice(0, max)) walk(index.get(id)!)
    if (n.kids.length > max) rows.push({ t: 'more', node: n, rest: n.kids.length - max })
    rows.push({ t: 'close', node: n })
  }
  const root = index.get('$')
  if (root) walk(root)
  return rows
}

/** 要让 id 这一行画出来，各级祖先得放出多少子节点（搜索跳到第 19999 项时用） */
export function revealShown(index: TreeIndex, id: string, prev: ReadonlyMap<string, number>): Map<string, number> {
  const next = new Map(prev)
  for (let n = index.get(id); n?.parent != null; n = index.get(n.parent)) {
    const p = index.get(n.parent)!
    const at = p.kids.indexOf(n.id)
    if (at >= (next.get(p.id) ?? KID_PAGE)) next.set(p.id, Math.ceil((at + 1) / KID_PAGE) * KID_PAGE)
  }
  return next
}

/**
 * 默认展开前三层：响应体通常是 $ → data → list，再往下按需点。
 * 一层展开后行数会超过 budget 就停在上一层：两万条记录展开三层是几十万行。
 */
export function defaultOpen(index: TreeIndex, depth = 3, budget = 1500): Set<string> {
  const out = new Set<string>()
  const root = index.get('$')
  let level = root ? [root] : []
  let rows = 1
  for (let d = 0; d < depth && level.length; d++) {
    const boxes = level.filter((n) => isBox(n) && n.kids.length > 0)
    const add = boxes.reduce((s, n) => s + Math.min(n.kids.length, KID_PAGE) + 1, 0)
    if (d > 0 && rows + add > budget) break
    rows += add
    for (const n of boxes) out.add(n.id)
    level = boxes.flatMap((n) => n.kids.slice(0, KID_PAGE).map((id) => index.get(id)!))
  }
  return out
}

export function allBoxes(index: TreeIndex): Set<string> {
  return new Set([...index.values()].filter(isBox).map((n) => n.id))
}

export function ancestors(index: TreeIndex, id: string): string[] {
  const out: string[] = []
  for (let p = index.get(id)?.parent ?? null; p !== null; p = index.get(p)?.parent ?? null) out.push(p)
  return out
}

/** 叶子参与搜索的文字：字符串不带引号 */
const searchText = (n: TreeNode) => (n.kind === 'string' && bigDigits(n.value) === null ? String(n.value) : leafText(n))

/**
 * 搜索命中的节点，按显示顺序。字段名或叶子值包含关键字（不分大小写）即命中；
 * 带冒号按「字段:值」对整行（忽略引号空格，如 "status": 1）；以 $ 开头当路径精确定位。
 */
export function findHits(index: TreeIndex, q: string): string[] {
  const s = q.trim().toLowerCase()
  if (!s) return []
  if (s.startsWith('$')) return [...index.keys()].filter((id) => id.toLowerCase() === s)
  const flat = (x: string) => x.toLowerCase().replace(/["\s]/g, '')
  const pair = s.includes(':') ? flat(s) : ''
  const hits: string[] = []
  for (const n of index.values()) {
    const byKey = typeof n.key === 'string' && n.key.toLowerCase().includes(s)
    const byVal = !isBox(n) && searchText(n).toLowerCase().includes(s)
    const byPair = pair !== '' && !isBox(n) && n.key !== null && flat(`${n.key}:${searchText(n)}`).includes(pair)
    if (byKey || byVal || byPair) hits.push(n.id)
  }
  return hits
}

/** 把文字切成 [片段, 是否命中]，给高亮用 */
export function splitHit(text: string, q: string): Array<[string, boolean]> {
  const s = q.trim().toLowerCase()
  if (!s || s.startsWith('$')) return [[text, false]]
  const low = text.toLowerCase()
  const out: Array<[string, boolean]> = []
  let at = 0
  for (let i = low.indexOf(s); i >= 0; i = low.indexOf(s, i + s.length)) {
    if (i > at) out.push([text.slice(at, i), false])
    out.push([text.slice(i, i + s.length), true])
    at = i + s.length
  }
  if (at < text.length) out.push([text.slice(at), false])
  return out
}

/** 「复制值」：容器给格式化 JSON，字符串给原文（不带引号） */
export function copyText(n: TreeNode): string {
  if (isBox(n)) return stringifyPreservingBig(n.value, 2)
  return searchText(n)
}
