/**
 * 读 Vue 工程源码用的小工具：不引解析器，只处理路由表和 router.push 里的对象字面量。
 * 字符串里的括号、逗号、// 都要跳过；单引号 / 双引号串到行尾为止（模板文字里的撇号不会吞文件）。
 */

/** 从 i 处的引号开始，返回字符串结束后的下标。模板文字的 ${…} 里可以再套字符串（含反引号） */
function skipString(src: string, i: number): number {
  const q = src[i]
  let j = i + 1
  while (j < src.length && src[j] !== q) {
    if (src[j] === '\\') j++
    else if (q !== '`' && src[j] === '\n') return j
    else if (q === '`' && src[j] === '$' && src[j + 1] === '{') {
      j = skipExpr(src, j + 2)
      continue
    }
    j++
  }
  return j + 1
}

/** 从 ${ 后面开始，返回配对的 } 后面的下标 */
function skipExpr(src: string, j: number): number {
  let depth = 0
  while (j < src.length) {
    const c = src[j]!
    if (isQuote(c)) {
      j = skipString(src, j)
      continue
    }
    if (c === '{') depth++
    else if (c === '}' && depth-- === 0) return j + 1
    j++
  }
  return j
}

const isQuote = (c: string | undefined): boolean => c === "'" || c === '"' || c === '`'

export function stripComments(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4)
      i = end < 0 ? src.length : end + 3
    } else if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') i++
    } else if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? src.length : end + 2
    } else if (isQuote(src[i])) {
      const j = skipString(src, i)
      out += src.slice(i, j)
      i = j
    } else {
      out += src[i]
      i++
    }
  }
  return out
}

const CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

/** src[open] 是 ( [ { 之一，返回配对的右括号下标；配不上返回 -1 */
export function matchClose(src: string, open: number): number {
  const stack: string[] = []
  for (let i = open; i < src.length; i++) {
    const c = src[i]!
    if (isQuote(c)) {
      i = skipString(src, i) - 1
    } else if (CLOSE[c]) {
      stack.push(CLOSE[c]!)
    } else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1
      if (!stack.length) return i
    }
  }
  return -1
}

/** 数组 / 对象括号里的正文按顺层逗号拆开，去掉空项 */
export function splitTopLevel(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!
    if (isQuote(c)) i = skipString(inner, i) - 1
    else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) {
      parts.push(inner.slice(start, i))
      start = i + 1
    }
  }
  parts.push(inner.slice(start))
  return parts.map((p) => p.trim()).filter(Boolean)
}

/** `{ key: value, ... }` 的顶层键 → 值的源码文本。不是对象给空表 */
export function objectProps(obj: string): Map<string, string> {
  const m = new Map<string, string>()
  const t = obj.trim()
  if (!t.startsWith('{')) return m
  const end = matchClose(t, 0)
  for (const part of splitTopLevel(t.slice(1, end < 0 ? t.length : end))) {
    const kv = /^(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]*)$/.exec(part)
    if (kv) m.set(kv[1] ?? kv[2] ?? kv[3]!, kv[4]!.trim())
  }
  return m
}

/** 整段就是一个字符串字面量时取出内容，否则 null（三元、变量、拼接都不算） */
export function strLit(v: string | undefined): string | null {
  const m = /^(['"`])([^'"`]*)\1$/.exec((v ?? '').trim())
  return m ? m[2]! : null
}
