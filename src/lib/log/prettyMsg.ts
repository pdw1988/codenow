/**
 * 详情卡里把日志消息中嵌着的 JSON 格式化。
 *
 * 日志很少整行是 JSON，常见的是「提交订单开始,req::{...}」：逐个找 `{` / `[`，
 * 配对到闭合处能 parse 就独占几行缩进显示，其余文字原样。大整数走 bigIntJson，
 * 雪花 id 不会被圆整。只管显示，复制仍然是原文。
 */
import { parsePreservingBig, stringifyPreservingBig } from '../bigIntJson'

/** 超过这个长度不格式化，原样显示，免得点一条巨型记录卡住 */
export const PRETTY_MSG_MAX = 200_000

/** 从 start（`{` 或 `[`）开始找配对的闭合位置；跳过字符串里的括号，对不上返回 -1 */
function matchEnd(s: string, start: number): number {
  const stack: string[] = []
  let inStr = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') stack.push('}')
    else if (c === '[') stack.push(']')
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1
      if (stack.length === 0) return i
    }
  }
  return -1
}

/** 只格式化「有内容」的：非空对象，或里面套着对象/数组的数组。`[1]`、`{}` 这类不动 */
function tryPretty(seg: string): string | null {
  let v: unknown
  try {
    v = parsePreservingBig(seg)
  } catch {
    return null
  }
  if (Array.isArray(v)) {
    if (!v.some((x) => x !== null && typeof x === 'object')) return null
  } else if (v === null || typeof v !== 'object' || Object.keys(v).length === 0) {
    return null
  }
  return stringifyPreservingBig(v, 2)
}

/** 文本里嵌的 JSON 换行缩进；一个都没有就原样返回 */
export function prettyJsonInText(text: string): string {
  if (!text || text.length > PRETTY_MSG_MAX) return text
  let out = ''
  let changed = false
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '{' || c === '[') {
      const end = matchEnd(text, i)
      const pretty = end > 0 ? tryPretty(text.slice(i, end + 1)) : null
      if (pretty !== null) {
        if (out && !out.endsWith('\n')) out += '\n'
        out += pretty
        i = end + 1
        if (i < text.length && text[i] !== '\n') out += '\n'
        changed = true
        continue
      }
    }
    out += c
    i++
  }
  return changed ? out : text
}
