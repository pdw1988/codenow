/**
 * 左边的键树：按分隔符（默认 `:`）把 `user:1001:token` 分成 user → 1001 → token。
 *
 * 只对已经扫到的键分组（SCAN 分批加载），组后面的数字是「已加载」的个数，
 * 不是库里的总数——要总数得全库扫一遍，线上不能这么干。
 */

export interface RedisKey {
  /** base64 原始字节，发命令用它 */
  b64: string
  /** 显示名（二进制字节写成 \xHH） */
  name: string
  type: string
}

export interface TreeRow {
  kind: 'group' | 'key'
  /** 组：带尾部分隔符的前缀（`user:1001:`）；键：b64 */
  id: string
  label: string
  depth: number
  count?: number
  open?: boolean
  key?: RedisKey
}

interface Node {
  groups: Map<string, Node>
  keys: RedisKey[]
  count: number
}

const newNode = (): Node => ({ groups: new Map(), keys: [], count: 0 })

function build(keys: readonly RedisKey[], sep: string): Node {
  const root = newNode()
  for (const k of keys) {
    const parts = sep ? k.name.split(sep) : [k.name]
    let node = root
    node.count++
    // 最后一段是键自己；空段（`a::b`）也算一组，否则两个冒号的键会拼回来对不上
    for (const p of parts.slice(0, -1)) {
      let next = node.groups.get(p)
      if (!next) {
        next = newNode()
        node.groups.set(p, next)
      }
      next.count++
      node = next
    }
    node.keys.push(k)
  }
  return root
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** 拍平成可见行：组在前、键在后，各自按名字排。收起的组不展开子行 */
export function keyRows(keys: readonly RedisKey[], sep: string, open: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (node: Node, prefix: string, depth: number) => {
    for (const name of [...node.groups.keys()].sort(byText)) {
      const child = node.groups.get(name)!
      const id = `${prefix}${name}${sep}`
      const on = open.has(id)
      rows.push({ kind: 'group', id, label: name, depth, count: child.count, open: on })
      if (on) walk(child, id, depth + 1)
    }
    for (const k of [...node.keys].sort((a, b) => byText(a.name, b.name))) {
      const label = prefix && k.name.startsWith(prefix) ? k.name.slice(prefix.length) : k.name
      rows.push({ kind: 'key', id: k.b64, label, depth, key: k })
    }
  }
  walk(build(keys, sep), '', 0)
  return rows
}

/** 「全部展开」用：所有组的 id */
export function allGroupIds(keys: readonly RedisKey[], sep: string): Set<string> {
  const out = new Set<string>()
  if (!sep) return out
  for (const k of keys) {
    const parts = k.name.split(sep)
    let prefix = ''
    for (const p of parts.slice(0, -1)) {
      prefix = `${prefix}${p}${sep}`
      out.add(prefix)
    }
  }
  return out
}

/**
 * 组 → 按前缀批量删用的 SCAN 模式。前缀里的 * ? [ ] \ 要转义：键名里真有这些字符时，
 * 不转义就会把别的组一起匹配进来删掉
 */
export function groupPattern(prefix: string): string {
  return `${prefix.replace(/[*?[\]\\]/g, (c) => `\\${c}`)}*`
}

export const TYPE_LABEL: Record<string, string> = {
  string: '字符串',
  hash: '哈希',
  list: '列表',
  set: '集合',
  zset: '有序集合',
  stream: '流',
  ReJSON: 'JSON',
  'ReJSON-RL': 'JSON',
  none: '已删除',
}

export const typeLabel = (t: string): string => TYPE_LABEL[t] ?? t
