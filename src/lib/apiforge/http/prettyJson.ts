/**
 * HTTP 响应体的展示用格式化。
 *
 * 为什么必须在**抓包时**做而不是渲染时做：`runCase` 把响应截到定长才存进
 * `responsePreview`，而被截断的 JSON 永远 `JSON.parse` 不回来——放到渲染层格式化，
 * 长响应就永远是一坨单行。先 pretty 再截，最差也是「前 N 字符的缩进 JSON」。
 *
 * 放 `lib/` 是分层纪律：红绿判定之外的东西都是纯函数，node:test 直接钉。
 * 试跑卡、报告页、Markdown / HTML 报告共用同一份 `responsePreview`，
 * 所以只要这里格式化了，四处一起受益。
 */
import { parsePreservingBig, stringifyPreservingBig } from '../../bigIntJson'

/**
 * 响应体存多长。从 2000 提到 4000：缩进会把体积撑大约 1.5~2 倍（实测
 * `/api/shop/productCategory/list` 的 913 字节响应 pretty 后约 1.8KB），不提上限
 * 等于用可读性换掉一半信息量。
 */
export const RESPONSE_PREVIEW_MAX = 4000

/**
 * 合法 JSON → 缩进 2 空格；**其余一律原样返回**。
 *
 * 只试 `{` / `[` 开头的：响应可能是 Nginx 的 HTML 错误页、纯文本 `OK`、
 * 或者被上游截断的半截 JSON——这些情况下原文就是唯一真相，宁可不好看，
 * 也不能因为格式化失败就把内容吞成空。
 *
 * 不展开字符串里的 `\n`：SHOP 的 500 响应把整个 Java 堆栈塞在 `error` 字段里
 * （常有好几 KB），展开得好读，但那就不是合法 JSON 了——报告里还要能
 * 拷出去直接 parse。`.apf-code` 是 `white-space: pre-wrap`，软换行照样看得全。
 */
export function prettyJson(text: string): string {
  const s = text.trim()
  if (!s[0] || (s[0] !== '{' && s[0] !== '[')) return text
  try {
    // 大整数安全：Java Long 主键（雪花 id）经 parse→stringify 一往返就被圆整
    // 成结尾带 000 的近似值（用户实测 1987654321098765431 → …5300），
    // 这里没动过的字段必须逐字节原样
    return stringifyPreservingBig(parsePreservingBig(s), 2)
  } catch {
    return text
  }
}

/** 完整的请求体 / 响应体（pretty 后）；只在 preview 会被截断时给，结果卡靠它「展开全部」 */
export function fullBodyOf(bodyText: string | null | undefined): string | undefined {
  const pretty = bodyText ? prettyJson(bodyText) : ''
  return pretty.length > RESPONSE_PREVIEW_MAX ? pretty : undefined
}

/**
 * 抓包时的统一入口：先格式化再截断，超了明说。
 *
 * 截断要有话说：以前默默 `slice(0, 2000)`，响应被削了一半用户也不知道，
 * 看着像服务端只返了这么多。
 */
export function previewOf(bodyText: string, max: number = RESPONSE_PREVIEW_MAX): string {
  const pretty = prettyJson(bodyText)
  if (pretty.length <= max) return pretty
  return `${pretty.slice(0, max)}\n…（已截断，原文 ${bodyText.length} 字符）`
}
