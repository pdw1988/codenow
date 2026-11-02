/**
 * Redis 键和值的字节处理。Rust 端一律 base64 原样传（见 redis_client.rs），
 * 怎么显示在这里定：文本 / JSON / 十六进制。
 *
 * 不能先转成字符串再说：Java 序列化（AC ED 开头）、gzip 这类值不是合法 UTF-8，
 * TextDecoder 默认把坏字节换成 �，再写回去值就永久坏了。
 */
import { parsePreservingBig, stringifyPreservingBig } from '../bigIntJson'

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToB64(bytes: Uint8Array): string {
  // 分块：整段 apply 到 fromCharCode 上，几百 KB 的值会爆调用栈
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

export const textToBytes = (s: string): Uint8Array => new TextEncoder().encode(s)
export const textToB64 = (s: string): string => bytesToB64(textToBytes(s))

/** 合法 UTF-8 才给文本，否则 null——调用方据此决定能不能当文本编辑 */
export function utf8OrNull(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export type ValueKind = 'text' | 'json' | 'jdk' | 'gzip' | 'binary'

/** 自动识别。Java 序列化交给 javaSer 解，gzip 先 gunzip 再识别一次 */
export function sniff(bytes: Uint8Array): ValueKind {
  if (bytes.length >= 2 && bytes[0] === 0xac && bytes[1] === 0xed) return 'jdk'
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip'
  const text = utf8OrNull(bytes)
  if (text === null) return 'binary'
  return jsonPretty(text) === null ? 'text' : 'json'
}

/** 解压后最多留这么多：几 KB 的 gzip 能解出几 GB（压缩炸弹），读全了页面就没了 */
export const GUNZIP_MAX = 16 * 1024 * 1024

/** gzip 解压（WebView2 / Node 18+ 自带 DecompressionStream）。超过上限就停，cut = true */
export async function gunzip(bytes: Uint8Array, max = GUNZIP_MAX): Promise<{ bytes: Uint8Array; cut: boolean }> {
  const reader = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream('gzip')).getReader()
  const parts: Uint8Array[] = []
  let size = 0
  let cut = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    size += value.length
    if (size > max) {
      cut = true
      await reader.cancel()
      break
    }
  }
  const out = new Uint8Array(Math.min(size, max))
  let off = 0
  for (const p of parts) {
    const n = Math.min(p.length, out.length - off)
    out.set(p.subarray(0, n), off)
    off += n
    if (off >= out.length) break
  }
  return { bytes: out, cut }
}

/** 格式化 JSON；不是 JSON 返回 null。长整数不丢精度（雪花 ID 在缓存里很常见） */
export function jsonPretty(text: string): string | null {
  const s = text.trim()
  if (s[0] !== '{' && s[0] !== '[') return null
  try {
    return stringifyPreservingBig(parsePreservingBig(s), 2)
  } catch {
    return null
  }
}

/** `00000000  ac ed 00 05  |....|`，每行 16 字节。超过 max 的部分不展开 */
export function hexDump(bytes: Uint8Array, max = 64 * 1024): string {
  const n = Math.min(bytes.length, max)
  const lines: string[] = []
  for (let off = 0; off < n; off += 16) {
    const row = bytes.subarray(off, Math.min(off + 16, n))
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ')
    const asc = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  |${asc}|`)
  }
  if (bytes.length > n) lines.push(`… 还有 ${bytes.length - n} 字节未展开`)
  return lines.join('\n')
}

/**
 * redis-cli 的转义写法：可见字符（含中文）原样，换行写 \n，其余字节写 \xHH。
 * 二进制键名这样显示，用户复制到命令窗口（加上双引号）还能原样用。
 */
export function escapeBytes(bytes: Uint8Array): string {
  const text = utf8OrNull(bytes)
  if (text !== null) {
    // eslint-disable-next-line no-control-regex -- 这条正则的功能就是把控制字符转义出来
    return text.replace(/[\\"\u0000-\u001f\u007f]/g, (c) => {
      if (c === '\\' || c === '"') return `\\${c}`
      if (c === '\n') return '\\n'
      if (c === '\r') return '\\r'
      if (c === '\t') return '\\t'
      return `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`
    })
  }
  let out = ''
  for (const b of bytes) {
    if (b === 0x5c || b === 0x22) out += `\\${String.fromCharCode(b)}`
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b)
    else out += `\\x${b.toString(16).padStart(2, '0')}`
  }
  return out
}

/** 表格里一行的预览：文本压成一行，二进制写类型 + 长度 */
export function preview(bytes: Uint8Array, max = 160): string {
  const kind = sniff(bytes)
  if (kind === 'jdk') return `（Java 序列化 · ${bytes.length} 字节）`
  if (kind === 'gzip') return `（gzip 压缩 · ${bytes.length} 字节）`
  if (kind === 'binary') return escapeBytes(bytes.subarray(0, max))
  const one = (utf8OrNull(bytes) ?? '').replace(/\s+/g, ' ')
  return one.length > max ? `${one.slice(0, max)}…` : one
}

export function sizeText(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 剩余过期时间（毫秒）→「3 天 4 小时」。-1 永不过期，-2 键不存在 */
export function ttlText(ms: number): string {
  if (ms === -1) return '永不过期'
  if (ms < 0) return '已过期'
  let s = Math.ceil(ms / 1000)
  const d = Math.floor(s / 86400)
  s -= d * 86400
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  const parts = [d && `${d} 天`, h && `${h} 小时`, m && `${m} 分`, (s || (!d && !h && !m)) && `${s} 秒`]
  return parts.filter(Boolean).slice(0, 2).join(' ')
}
