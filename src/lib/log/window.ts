/**
 * 码上追 · 时间窗的换算与跳转垫边（第三步「和码上测联动」的纯函数部分）。
 * 过滤器本体在 filter.ts，这里只管三件事：
 * datetime-local 输入框的值 ↔ 毫秒时间戳，以及「跳日志」时给回归起止时刻
 * 垫余量。都是纯函数，直接测。
 */

/**
 * datetime-local 的值 → 本地时区毫秒。空串/残缺/日期不成立给 null——输入框
 * 打字打到一半是常态，null 只是「这一端还没填好」，不报错。
 */
export function windowFromInput(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, sec] = m
  const ts = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), sec ? Number(sec) : 0).getTime()
  // round-trip 校验把 2 月 30 日这类拼不出来的一天挡掉（Date 会静默进位）
  const back = new Date(ts)
  if (back.getFullYear() !== Number(y) || back.getMonth() !== Number(mo) - 1 || back.getDate() !== Number(d)) return null
  return ts
}

/** 毫秒 → datetime-local 的值（本地时区）。null 给空串，对上「这一端没设」 */
export function inputFromWindow(ts: number | null): string {
  if (ts === null) return ''
  const d = new Date(ts)
  const p = (v: number, w = 2) => String(v).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 「跳日志」的窗口垫边。跳转带上来的起止是码上测跑批的精确墙钟，直接当
 * 过滤条件会把「服务端日志时间戳略早于请求发出」的行挡在窗外；两端各垫
 * padMs 省去用户手动放宽。until 还没收口（跑批中断）按 now 收。
 * 传进来的 since/until 本身就没有先后保证，垫完仍强制 since ≤ until。
 */
export function padWindow(
  since: number,
  until: number | null,
  padMs: number,
  now: number,
): { since: number; until: number } {
  const from = Math.min(since, until ?? now) - padMs
  const to = Math.max(since, until ?? now) + padMs
  return { since: from, until: to }
}
