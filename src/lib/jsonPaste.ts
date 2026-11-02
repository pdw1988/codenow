/**
 * 从粘贴的一段文字里抠出 JSON：日志整行、「response: {...} 耗时 12ms」这类，
 * 去掉第一个 { 前面和最后一个 } 后面。先试 {}：日志前缀常带 [INFO] 这种方括号。
 * format 把抠出来的一段格式化，不是合法 JSON 返回 null；两种都不行就返回 null。
 */
export function extractJson(text: string, format: (s: string) => string | null): string | null {
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const a = text.indexOf(open)
    const b = text.lastIndexOf(close)
    if (a < 0 || b <= a) continue
    const s = text.slice(a, b + 1)
    if (s.length >= text.trim().length) continue
    const out = format(s)
    if (out !== null) return out
  }
  return null
}
