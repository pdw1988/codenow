/**
 * 接口库左树的搜索展示工具：命中高亮分词 + 渲染预算。
 *
 * 为什么单独成文件：树组件 686 行已经满了，这两件事是纯函数、必须落测
 * （高亮的分词边界、正则元字符转义、预算的截断点都值得钉住）。
 */

/** 高亮片段：hit=true 的段用 <mark class="apf-hit"> 包 */
export interface HitPart {
  text: string
  hit: boolean
}

/**
 * 把 text 按查询词切成（不区分大小写的）命中片段。q 为空给整段不命中；
 * q 里的正则元字符（如 `(`、`*`）当字面量匹配，不当模式。
 */
export function hitParts(text: string, q: string): HitPart[] {
  const needle = q.trim()
  if (!needle || !text) return [{ text, hit: false }]
  const parts: HitPart[] = []
  let last = 0
  const lower = text.toLowerCase()
  const n = needle.toLowerCase()
  let i = lower.indexOf(n)
  while (i >= 0) {
    if (i > last) parts.push({ text: text.slice(last, i), hit: false })
    parts.push({ text: text.slice(i, i + n.length), hit: true })
    last = i + n.length
    i = lower.indexOf(n, last)
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false })
  return parts
}

/**
 * 搜索词归一：粘的是完整地址（http://主机:端口/上下文/xxx?id=1）就只留路径，
 * 去掉查询串和 # 后面的部分；其余原样（转小写）。
 */
export function normalizeApiQuery(q: string): string {
  let s = q.trim().toLowerCase()
  s = s.replace(/^https?:\/\/[^/?#]*/, '')
  if (s.startsWith('/')) s = s.replace(/[?#].*$/, '')
  return s
}

/**
 * 路径命中：直接包含；或搜索的是一段路径、且以接口路径结尾（前面多出的是上下文路径），
 * 接口路径里的 {id} 占位匹配任意一段。nq 须先经 normalizeApiQuery。
 */
export function pathMatches(apiPath: string, nq: string): boolean {
  const p = apiPath.toLowerCase()
  if (!nq || p.includes(nq)) return !!nq
  if (!nq.startsWith('/') || nq.length < 2) return false
  const body = p
    .split(/(\{[^}]*\})/)
    .map((seg) => (/^\{[^}]*\}$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`${body}/?$`).test(nq)
}

/**
 * 渲染预算：搜索态全展开时（工程 × Controller × 命中接口）一次就是几千行
 * DOM，每个键击重渲一遍必卡。每层截在预算内，截掉多少诚实返回，由调用方
 * 写「还有 N 条未显示」。非搜索态不裁（默认全折叠，展开是用户自己的选择）。
 */
export function capRows<T>(rows: readonly T[], budget: number): { shown: T[]; omitted: number } {
  if (budget >= rows.length) return { shown: rows as T[], omitted: 0 }
  if (budget <= 0) return { shown: [], omitted: rows.length }
  return { shown: rows.slice(0, budget), omitted: rows.length - budget }
}
