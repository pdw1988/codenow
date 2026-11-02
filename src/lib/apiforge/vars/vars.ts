/**
 * 变量体系（接口改进 · 变量）：{{变量名}} 在场景步骤和数据驱动行里引用。
 *
 * 三层取值，越靠近这次请求的越可信：
 * 1. **场景链上提取的变量**——上一步响应里来的，最具体；
 * 2. **环境级变量**——用户在环境页配的固定值，随 apiforge.env blob 落盘；
 * 3. **内置动态变量**——发送那一刻现算：timestamp（毫秒时间戳）/ uuid /
 *    date（YYYY-MM-DD）/ time（HH:mm:ss）。
 *
 * 纪律：
 * - 内置变量**一次跑批共用同一组值**：timestamp 在同一场跑批里不跳变，报告里
 *   对得上账（每个请求要各异的值用 {{uuid}}，每次调用现算）；
 * - 没取到的变量**当场失败**——不把 {{x}} 原样发给服务端让人猜（substituteVars
 *   的 missing 上抛，调用方给行/步骤记失败）；
 * - 变量表是**测试数据不是保险箱**：环境级变量随 env blob 落盘，别放密码
 *   （密码只活在内存的铁律不变）。
 */

/** v4 uuid：crypto.randomUUID 优先（WebView2 / Node 17+ 都有），退化手工拼 */
function uuidV4(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined
  if (c?.randomUUID) return c.randomUUID()
  const hex = '0123456789abcdef'
  let out = ''
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-'
    else if (i === 14) out += '4'
    else if (i === 19) out += hex[(Math.floor(Math.random() * 16) & 0x3) | 0x8]
    else out += hex[Math.floor(Math.random() * 16)]
  }
  return out
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** 本地时区 YYYY-MM-DD（报告/造数口径与 Date 的 epoch 毫秒同一信息的两种形态） */
export function formatDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 本地时区 HH:mm:ss */
export function formatTime(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 内置动态变量。**调用一次算一组**：跑批入口（runScenario / runDataDriven）
 * 各调一次、整场共用——timestamp 不跳变；单独要每次都新的用 {{uuid}}。
 */
export function builtinVars(now = Date.now()): Record<string, string> {
  return {
    timestamp: String(now),
    uuid: uuidV4(),
    date: formatDate(now),
    time: formatTime(now),
  }
}

/**
 * 多层变量表合并成一份查找表：**后面的池优先**（越靠近这次请求的越可信）。
 * 宽容洗一遍——空键 / 空白键 / 非字符串值丢弃（老 blob / 手改的脏数据不炸）。
 */
export function resolveVars(
  ...pools: readonly (Record<string, string> | undefined)[]
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pool of pools) {
    if (!pool) continue
    for (const [k, v] of Object.entries(pool)) {
      const name = k.trim()
      if (name && typeof v === 'string') out[name] = v
    }
  }
  return out
}
