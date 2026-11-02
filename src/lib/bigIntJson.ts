/**
 * 大整数安全的 JSON 往返。
 *
 * JS 的 Number 只有 53 位安全整数，Java 的 Long 主键（雪花 id，19 位）经
 * JSON.parse → JSON.stringify 一往返就被圆整成结尾带 000 的近似值——用户实测
 * 1987654321098765431 复制进调试卡，显示和发送都变成 1987654321098765300。
 *
 * 做法：解析前把裸的 ≥16 位**整数** token 包成哨兵字符串（手写扫描器认得出
 * 字符串边界，字符串值里的数字原样不动）；序列化后再把哨兵字符串还原成裸
 * 字面量。没被改动过的字段逐字节原样回来，改动是调用方自己做的。
 *
 * 已知边界：值本身恰好长成 `"@@BIGINT:<数字>@"@"` 的字符串会被还原成裸数字
 * ——真实世界里没有这样的值，撞上算认了。
 */

const SENTINEL = '@@BIGINT:'

/** 还原哨兵字符串 → 裸字面量 */
const UNWRAP = /"@@BIGINT:(-?\d+)"/g

/** 整串就是一个哨兵（unwrapSentinelStrings 用的严格形态） */
const SENTINEL_EXACT = /^@@BIGINT:(-?\d+)$/

/** ≥16 位纯整数才算危险（2^53 = 9007199254740991，16 位里也有不安全的）。 */
const BIG_TOKEN = /^-?\d{16,}$/

/** 解析 JSON：大整数不丢精度（以哨兵字符串形态出现在结果里，仅供 stringifyPreservingBig 还原） */
export function parsePreservingBig(text: string): unknown {
  return JSON.parse(wrapBigLiterals(text))
}

/** 序列化：哨兵字符串还原成裸数字字面量，普通值照 JSON.stringify。indent 转发 */
export function stringifyPreservingBig(value: unknown, indent?: number): string {
  return JSON.stringify(value, null, indent).replace(UNWRAP, '$1')
}

/** 解析结果里的哨兵 → 原数字串；不是哨兵返回 null（JSON 树按数字显示用） */
export function bigDigits(value: unknown): string | null {
  return typeof value === 'string' ? (SENTINEL_EXACT.exec(value)?.[1] ?? null) : null
}

/**
 * 只读消费用：把解析结果里的哨兵字符串换成普通数字字符串（"2081…"）。
 * 断言比对、JSONPath 查询这类「读值不回写」的场合——19 位 Long 当字符串比，
 * `String(v) === '1987654321098765431'` 能对上；当 Number 必丢精度。
 */
export function unwrapSentinelStrings<T>(value: T): T {
  if (typeof value === 'string') {
    const m = SENTINEL_EXACT.exec(value)
    return (m ? m[1] : value) as T
  }
  if (Array.isArray(value)) {
    return value.map((v) => unwrapSentinelStrings(v)) as unknown as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = unwrapSentinelStrings(v)
    }
    return out as T
  }
  return value
}

/**
 * 解析前把裸大整数包进哨兵。手写字符扫描而不是全文正则——正则分不清
 * 字符串值里的数字（`"note":"a, 1987654321098765431"`），会包坏原文。
 */
function wrapBigLiterals(text: string): string {
  // 连 16 位连续数字都没有就不可能有大整数：几 MB 的 JSON 直接跳过扫描
  if (!/\d{16}/.test(text)) return text
  const out: string[] = []
  /** 已原样抄到 out 的位置；只在包大整数时切一刀，其余整段 slice */
  let from = 0
  let i = 0
  /** 上一个字符串外的非空白字符：JSON 数字只能跟在 `: , [ {` 或开头后面 */
  let prev = ''
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '"') {
      // 跳过整个字符串（含转义）
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      i = j + 1
      prev = '"'
      continue
    }
    if ((ch === '-' || (ch >= '0' && ch <= '9')) && (prev === '' || ':,[{'.includes(prev))) {
      // 读完整 JSON 数字 token（含小数 / 指数），只有纯大整数才包
      let j = i + 1
      while (j < text.length && '0123456789.eE+-'.includes(text[j]!)) j++
      const token = text.slice(i, j)
      if (BIG_TOKEN.test(token)) {
        out.push(text.slice(from, i), `"${SENTINEL}${token}"`)
        from = j
      }
      i = j
      prev = text[j - 1] ?? ''
      continue
    }
    if (ch !== ' ' && ch !== '\n' && ch !== '\r' && ch !== '\t') prev = ch
    i++
  }
  out.push(text.slice(from))
  return out.join('')
}
