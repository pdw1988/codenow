/**
 * 命令窗口：解析输入行、把回复排成 redis-cli 的样子。
 *
 * 引号和转义跟 redis-cli 一致（"…" 里认 \n \t \" \\ \xHH，'…' 只认 \'）：
 * 用户从别处拷来的命令不用改就能跑，二进制键也能用 \x 写出来。
 */
import { b64ToBytes, escapeBytes, textToBytes } from './codec'

export type Reply =
  | { t: 'nil' }
  | { t: 'int'; v: number }
  | { t: 'str'; v: string }
  | { t: 'status'; v: string }
  | { t: 'arr'; v: Reply[] }
  | { t: 'map'; v: Array<[Reply, Reply]> }
  | { t: 'dbl'; v: number }
  | { t: 'bool'; v: boolean }

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const ESC: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07', '"': '"', '\\': '\\' }

/** 一行命令 → 参数字节。引号没配对返回错误文字 */
export function splitArgs(line: string): Uint8Array[] | string {
  const args: Uint8Array[] = []
  let i = 0
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i]!)) i++
    if (i >= line.length) break
    const parts: Uint8Array[] = []
    let text = ''
    const flush = () => {
      if (text) parts.push(textToBytes(text))
      text = ''
    }
    while (i < line.length && !/\s/.test(line[i]!)) {
      const c = line[i]!
      if (c === '"') {
        i++
        let closed = false
        while (i < line.length) {
          const d = line[i]!
          if (d === '"') {
            closed = true
            i++
            break
          }
          if (d === '\\' && i + 1 < line.length) {
            const e = line[i + 1]!
            const hex = /^x[0-9a-fA-F]{2}$/.test(line.slice(i + 1, i + 4))
            if (hex) {
              flush()
              parts.push(Uint8Array.of(parseInt(line.slice(i + 2, i + 4), 16)))
              i += 4
              continue
            }
            text += ESC[e] ?? e
            i += 2
            continue
          }
          text += d
          i++
        }
        if (!closed) return '双引号没有配对'
      } else if (c === "'") {
        i++
        let closed = false
        while (i < line.length) {
          const d = line[i]!
          if (d === "'") {
            closed = true
            i++
            break
          }
          if (d === '\\' && line[i + 1] === "'") {
            text += "'"
            i += 2
            continue
          }
          text += d
          i++
        }
        if (!closed) return '单引号没有配对'
      } else {
        text += c
        i++
      }
    }
    flush()
    args.push(concat(parts))
  }
  return args
}

function quoted(b64: string): string {
  return `"${escapeBytes(b64ToBytes(b64))}"`
}

/** redis-cli 的排版：(integer) 1 / "值" / 1) … 缩进嵌套 */
export function formatReply(r: Reply, indent = ''): string {
  switch (r.t) {
    case 'nil':
      return '(nil)'
    case 'int':
      return `(integer) ${r.v}`
    case 'str':
      return quoted(r.v)
    case 'status':
      return r.v
    case 'dbl':
      return `(double) ${r.v}`
    case 'bool':
      return r.v ? '(true)' : '(false)'
    case 'arr':
    case 'map': {
      const items = r.t === 'arr' ? r.v : r.v.flat()
      if (items.length === 0) return '(empty array)'
      const w = String(items.length).length
      return items
        .map((it, i) => {
          const head = `${String(i + 1).padStart(w)}) `
          const pad = indent + ' '.repeat(head.length)
          return `${i === 0 ? '' : indent}${head}${formatReply(it, pad)}`
        })
        .join('\n')
    }
  }
}

/* ---- 从回复里取值：界面调命令时知道形状，形状不对给空值而不是抛错 ---- */

export function asInt(r: Reply): number {
  if (r.t === 'int' || r.t === 'dbl') return r.v
  if (r.t === 'str') return Number(new TextDecoder().decode(b64ToBytes(r.v)))
  return 0
}

export function asBytes(r: Reply): Uint8Array | null {
  if (r.t === 'str') return b64ToBytes(r.v)
  if (r.t === 'status') return textToBytes(r.v)
  return null
}

export function asText(r: Reply): string {
  const b = asBytes(r)
  return b ? new TextDecoder().decode(b) : ''
}

export function asArr(r: Reply): Reply[] {
  if (r.t === 'arr') return r.v
  if (r.t === 'map') return r.v.flat()
  return []
}
