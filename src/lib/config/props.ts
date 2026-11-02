/**
 * Properties 的解析 / 生成（PRD 五）。
 *
 * 解析器按 PRD 5.5 的要求手写，支持**多行（反斜杠续行）、转义、注释**——
 * 这三条是原型里欠着的（mockup 的注释声称支持续行，代码里其实没有），
 * 正式版必须补上：从老项目 properties 迁移到 yml 是 PRD 1.3 点名的场景，
 * 而 `\` 续行和 `\uXXXX` 在老配置文件里真实存在。
 *
 * 刻意不支持的（够用就好）：键里出现未转义的 `=`/`:` 分隔符之外的花活、
 * 值的行尾空格保留（dissect 会把代码部分 trimEnd——行尾空格几乎都是误输入，
 * 为它把解剖函数复杂化不值）。
 */
import type { ParsedConfig } from './common'
import { dissect, unquote } from './common'

/**
 * 把物理行拼成逻辑行：值以奇数个反斜杠结尾时续下一行
 * （下一行行首空白按 Java properties 规则剥掉）。行号取逻辑行的第一行，
 * 报错才指得到用户写错的那一行。
 */
function toLogicalLines(src: string): Array<{ ln: number; text: string }> {
  const physical = src.split('\n')
  const out: Array<{ ln: number; text: string }> = []
  let pending: { ln: number; text: string } | null = null

  for (let i = 0; i < physical.length; i++) {
    // 显式标注类型：这里不标的话 tsc 会报 TS7022——line 经由 pending 的赋值
    // 间接引用了它自己的推导过程，推断链成环
    const line: { ln: number; text: string } = pending ?? { ln: i + 1, text: '' }
    pending = null
    // 接续行剥行首空白；首行不动——行首空白在首行是键的一部分边界，交给后面的 trim
    line.text += i === line.ln - 1 ? physical[i] : physical[i].replace(/^\s+/, '')
    // 数行尾反斜杠的个数：偶数个是成对的转义（\\ 就是字面反斜杠），
    // 奇数个才是续行。用「成对组 + 单个收尾」表达奇偶，不用数数循环
    const m = /(?:[^\\]|^)(\\\\)*\\$/.exec(line.text)
    if (m) {
      line.text = line.text.slice(0, -1)
      pending = line
    } else {
      out.push(line)
    }
  }
  if (pending) out.push(pending) // 文件以孤立反斜杠结尾：按到文件尾为止算一个逻辑行
  return out
}

/** 解码转义：\t \n \r \f \\ \uXXXX，`\其他字符` 就是那个字符本身（\: \= \空格） */
export function decodeEscapes(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const nxt = s[++i]
    if (nxt === undefined) {
      out += '\\' // 尾随孤立反斜杠按字面保留，不为它抛错
      break
    }
    if (nxt === 'n') out += '\n'
    else if (nxt === 'r') out += '\r'
    else if (nxt === 't') out += '\t'
    else if (nxt === 'f') out += '\f'
    else if (nxt === 'u') {
      const hex = s.slice(i + 1, i + 5)
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16))
        i += 4
      } else {
        out += 'u' // 假 \u 按字面保留 u；配置工具宽容一点比整批报废好
      }
    } else out += nxt
  }
  return out
}

/**
 * 找第一个**未转义**的 = 或 :。逐字符扫而不是正则：正则要同时表达
 * 「跳过 \x」和「两个候选分隔符」，写出来没人看得懂。
 */
function findSep(code: string): { index: number } | null {
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '\\') {
      i++ // 跳过被转义的字符
      continue
    }
    if (code[i] === '=' || code[i] === ':') return { index: i }
  }
  return null
}

/** 返回类型用泛型特化：tree 是扁平字符串表（键=完整点分路径），不是 YamlNode */
export function parseProps(src: string): ParsedConfig<Record<string, string>> {
  const tree: Record<string, string> = {}
  const notes: Record<string, string> = {}
  const seen = new Map<string, number>()

  for (const { ln, text } of toLogicalLines(src)) {
    const { code, comment } = dissect(text)
    if (!code.trim()) continue

    const sep = findSep(code)
    if (!sep) throw new Error(`第 ${ln} 行：缺 '=' —— 这一行既没有键值分隔符也不是注释`)
    const key = decodeEscapes(code.slice(0, sep.index).trim())
    const firstAt = seen.get(key)
    if (firstAt !== undefined)
      throw new Error(`第 ${ln} 行：重复键 '${key}'（第一次出现在第 ${firstAt} 行）`)
    seen.set(key, ln)

    // 值只剥行首空白（Java 规则），行尾已由 dissect 收掉
    tree[key] = unquote(decodeEscapes(code.slice(sep.index + 1).replace(/^\s+/, '')))
    if (comment) notes[key] = comment
  }
  return { tree, notes }
}

/**
 * 生成 Properties。值**不加引号不做多余转义**——分隔符只是键后面那一个
 * = 或 :，给 jdbc url 加引号反而错了（properties 不吃引号，引号会原样进值里）。
 * 只有两种东西必须编码：真换行（会断行）和后面跟着转义字符的反斜杠
 * （原样写回去，下次解析会被解码成别的字符——`C:\names` 会凭空多出换行）。
 */
export function dumpProps(
  flat: Record<string, string | number | boolean | null>,
  notes: Record<string, string> = {},
  sorted = false,
): string {
  const keys = Object.keys(flat)
  if (sorted) keys.sort((a, b) => a.localeCompare(b))
  return keys
    .map((k) => {
      const raw = flat[k]
      const v =
        raw === null
          ? ''
          : String(raw)
              .replace(/\\(?=[nrtfu\\]|$)/g, '\\\\')
              .replace(/\r/g, '\\r')
              .replace(/\n/g, '\\n')
      return `${k}=${v}${notes[k] ? `   ${notes[k]}` : ''}`
    })
    .join('\n')
}
