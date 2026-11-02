/**
 * 请求体是不是合法 JSON；不是就尽量给出第几行（从 JSON.parse 的报错位置推算），
 * 能认出原因的再给一句人话（中文标点、看不见的空格这类肉眼查不出的最要紧）。
 * 空串当合法：没填就不提示。
 */
export function jsonProblem(text: string): { line: number | null; why?: string } | null {
  if (!text.trim()) return null
  try {
    JSON.parse(text)
    return null
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const byPos = /position (\d+)/.exec(msg)
    // 「Unexpected token」类报错不带位置：自己在字符串外面找第一个可疑字符
    const pos = byPos ? Number(byPos[1]) : firstSuspect(text)
    const why = pos === null ? undefined : whyAt(text, pos)
    const byLine = /line (\d+)/.exec(msg)
    if (byLine) return { line: Number(byLine[1]), why }
    if (pos !== null) return { line: text.slice(0, pos).split('\n').length, why }
    // 没写位置的多半是「写到一半就结束了」
    if (/end of (json|data) input/i.test(msg)) return { line: text.split('\n').length, why: '内容没写完，括号或引号没收尾' }
    return { line: null }
  }
}

const FULL_WIDTH: Record<string, string> = {
  '，': ',', '：': ':', '“': '"', '”': '"', '‘': "'", '’': "'", '｛': '{', '｝': '}', '［': '[', '］': ']',
}
const INVISIBLE = new Set([0xa0, 0x3000, 0x200b, 0x200c, 0x200d, 0xfeff, 0x2028, 0x2029])

/** 字符串字面量以外第一个中文标点 / 隐形空格 / 单引号 / 注释的位置；没有给 null */
function firstSuspect(text: string): number | null {
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inStr) {
      if (ch === '\\') i++
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (FULL_WIDTH[ch] || INVISIBLE.has(ch.charCodeAt(0)) || ch === "'" || ch === '/') return i
  }
  return null
}

/** 报错位置上的字符为什么不对；认不出就只报出这个字符 */
function whyAt(text: string, pos: number): string | undefined {
  const ch = text[pos]
  if (ch === undefined) return '内容没写完，括号或引号没收尾'
  const prev = text.slice(0, pos).trimEnd().slice(-1)
  if (FULL_WIDTH[ch]) return `「${ch}」是中文标点，改成英文的「${FULL_WIDTH[ch]}」`
  if (INVISIBLE.has(ch.charCodeAt(0))) return '这里有看不见的特殊空格（多半是从网页或文档复制来的），把这一段删掉重打'
  if (ch === "'") return 'JSON 里的字符串和字段名要用双引号，不能用单引号'
  if (ch === '/') return 'JSON 不支持注释，把 // 或 /* */ 删掉'
  if ((ch === '}' || ch === ']') && prev === ',') return `「${ch}」前面多了一个逗号（最后一项后面不能有逗号）`
  if (ch === ',' && prev === ',') return '这里多了一个逗号'
  if (ch === '"' && prev && !'{[,:'.includes(prev)) return '上一项后面少了一个逗号'
  if (/[A-Za-z_$\u4e00-\u9fa5]/.test(ch) && (prev === '{' || prev === ',')) return '字段名要用双引号括起来'
  return `这里的「${ch}」放得不对`
}
