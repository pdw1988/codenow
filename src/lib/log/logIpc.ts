/**
 * 码上追的桌面 IPC：选文件、扫描（建行偏移索引）、按行区间回读原始字节。
 * 解码在前端 TextDecoder（gbk / utf-8）——Rust 不引编码库。浏览器模式没有这
 * 根针，tauriInvoke 会直接中文拒绝。
 */
import { tauriInvoke } from '../tauriInvoke'
import { isTauri } from '../../storage'

export interface LogFileMeta {
  fileId: number
  sizeBytes: number
  totalLines: number
  encoding: string
}

export const logScan = (path: string): Promise<LogFileMeta> =>
  tauriInvoke<LogFileMeta>('log_file_scan', { path })

/** 行区间的原始字节（未解码）。Rust 直接回二进制，不走 JSON 数字数组 */
export const logSlice = async (fileId: number, startLine: number, lineCount: number): Promise<Uint8Array> =>
  new Uint8Array(await tauriInvoke<ArrayBuffer>('log_file_slice', { fileId, startLine, lineCount }))

/** 释放 Rust 侧的行偏移索引。关不掉不影响前端，失败静默 */
export const logClose = (fileId: number): Promise<void> =>
  tauriInvoke<void>('log_file_close', { fileId }).catch(() => undefined)

export async function pickLogFile(title = '选择日志文件'): Promise<string | null> {
  if (!isTauri()) {
    throw new Error('打开本机日志文件请用桌面版（pnpm tauri:dev 或安装包）')
  }
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({ directory: false, multiple: false, title })
  if (typeof selected === 'string' && selected) return selected
  return null
}

/**
 * 原始字节 → 行数组。Rust 的切片按行边界对齐，最后一条（EOF 那片）可能不带
 * 结尾换行：split 出的末尾空串是 split 的副产品，剥掉；文件真以空行结尾时
 * 尾部会多一个空串，只剥一个刚好对上
 */
export function sliceToLines(bytes: Uint8Array, encoding: string): string[] {
  const text = new TextDecoder(encoding === 'gbk' ? 'gbk' : 'utf-8').decode(bytes)
  const arr = text.split(/\r?\n/)
  if (arr.length && arr[arr.length - 1] === '') arr.pop()
  return capLongLines(arr)
}

/** 单行上限（字符）。有的日志把附件 base64 / 整个报文打进一行，一行几 MB，画出来窗口就点不动 */
export const MAX_LINE_CHARS = 64 * 1024

/** 超长行就地截断并标明原长；返回同一个数组 */
export function capLongLines(arr: string[]): string[] {
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i]!
    const cut = s.lastIndexOf('\u0001CUT')
    if (cut >= 0 && /^\d+$/.test(s.slice(cut + 4))) {
      // 服务器上已截过（见 ssh.ts REMOTE_LINE_CAP），原长是字节数
      arr[i] = `${s.slice(0, cut)} ……（这一行太长，共 ${(Number(s.slice(cut + 4)) / 1024 / 1024).toFixed(1)} MB，只显示前 60K）`
    } else if (s.length > MAX_LINE_CHARS) {
      arr[i] = `${s.slice(0, MAX_LINE_CHARS)} ……（这一行太长，共 ${(s.length / 1024 / 1024).toFixed(1)} M 字符，只显示前 64K）`
    }
  }
  return arr
}
