/**
 * Controller 的 Javadoc 元信息（作者 / 日期）归一化。
 *
 * 扫描器原样吐出 `@author` / `@date` 系 tag 的值，写法五花八门 —— 同一个工程
 * 里就可能有 `2025/6/12 9:01`、
 * `2025-12-26 17:25:30`、`2026-08-19`、`2025-04-09 11:14:07` 四种。不归一
 * 那一列就长短参差，带时分秒的会把业务名挤成省略号。
 *
 * 归一放这里而不是 Java 侧：扫描器没有测试工程，写了钉不住；这里是纯函数，
 * 能被 node:test 直接打（分层纪律：计算进 lib/）。
 */

/**
 * 日期归一成 `YYYY-MM-DD`。
 *
 * 只认「年在最前」的写法（`2025-4-9` / `2025/4/9` / `2025.4.9` / `2025年4月9日`），
 * 时分秒一律丢掉。**认不出的原样返回** —— 宁可显示原文，不要编一个日期出来。
 * `3/11/2024` 这种日月年歧义写法故意不碰：猜错了比不猜更坏。
 */
export function normDocDate(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  const m = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(s)
  if (!m) return s
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return s
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * 作者归一：去邮箱（`张三 <a@b.com>` → `张三`），多作者取第一个。
 * 只取第一个是为了宽度可预测 —— 左栏那一行本来就是被优先压缩的。
 */
export function normAuthor(raw: string): string {
  const s = raw
    .trim()
    .replace(/<[^>]*>/g, ' ')
    .replace(/\S+@\S+\.\S+/g, ' ')
  return s.split(/[,，、;；/|]/)[0].trim().replace(/\s+/g, ' ')
}

/**
 * 左栏 Controller 行右侧那一小段。两个都有就拼「作者·日期」，
 * 只有一个就显那个，都没有给空串（UI 自己决定显不显 `—`）。
 */
export function whoLine(c: { author: string; date: string }): string {
  if (c.author && c.date) return `${c.author}·${c.date}`
  return c.author || c.date
}
