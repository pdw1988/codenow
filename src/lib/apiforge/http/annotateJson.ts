/**
 * 给 pretty JSON 的 `"key":` 行末补 ` // 含义`。只改展示，不改存档的
 * responsePreview——复制仍要能 JSON.parse。
 *
 * 按行处理：JSON.stringify 缩进后，字符串里的换行是 `\\n` 不是真换行，
 * 所以每一行要么是结构，要么是完整的 `"k": v`，不会把值切开。
 */

export function annotateJsonKeys(text: string, hintOf: (key: string) => string): string {
  if (!text) return text
  return text
    .split('\n')
    .map((line) => {
      const m = /^(\s*)"((?:\\.|[^"\\])*)"\s*:/.exec(line)
      if (!m) return line
      const hint = hintOf(m[2]!).replace(/\s+/g, ' ').trim()
      if (!hint) return line
      if (line.includes('  // ')) return line
      return `${line}  // ${hint}`
    })
    .join('\n')
}
