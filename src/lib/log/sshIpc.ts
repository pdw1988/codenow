/**
 * 码上追 · SSH 拉日志的桌面 IPC：起会话（Rust spawn 系统 ssh）、按块读流、
 * 取消。流式攒字节 + 解码 + 兜底取消都收在 sshCollect 一个出口里——store 拉
 * 日志要进度回调，页面浏览目录要一次性文本，同一套流程两种用法。
 * 浏览器模式没有这根针，tauriInvoke 会直接中文拒绝（页面层已有桌面版提示）。
 */
import { tauriInvoke } from '../tauriInvoke'
import { decodeBytesSmart, guessSshError } from './ssh'

export interface SshStartParams {
  host: string
  port: number
  user: string
  /** 密码或私钥口令；不传 = 走本机密钥。只在内存传递，绝不持久化 */
  secret?: string
  remoteCmd: string
}

interface SshFinishRaw {
  exitCode: number | null
  stderrTail: string
}

const logSshStart = (p: SshStartParams): Promise<number> =>
  tauriInvoke<number>('log_ssh_start', {
    host: p.host,
    port: p.port,
    user: p.user,
    secret: p.secret,
    remoteCmd: p.remoteCmd,
  })

/** 读一块 stdout（二进制直传）。空块 = 读完了，接着 finish 拿退出码 */
const logSshRead = async (sessionId: number, maxBytes: number): Promise<Uint8Array> =>
  new Uint8Array(await tauriInvoke<ArrayBuffer>('log_ssh_read', { sessionId, maxBytes }))

const logSshFinish = (sessionId: number): Promise<SshFinishRaw> =>
  tauriInvoke<SshFinishRaw>('log_ssh_finish', { sessionId })

const logSshAbort = (sessionId: number): Promise<void> =>
  tauriInvoke<void>('log_ssh_abort', { sessionId })

export interface SshCollectResult {
  text: string
  encoding: string
  sizeBytes: number
  /** 到了字节上限被掐断：内容只有一半，调用方要提示 */
  truncated: boolean
  exitCode: number | null
  stderrTail: string
}

export interface SshCollectOpts {
  /** 字节上限：到顶就地掐断（truncated: true）。不设 = 尽量拉完 */
  capBytes?: number
  /** 每收到一块回调（累计字节数）：拉日志的进度条用 */
  onProgress?: (receivedBytes: number) => void
  /** 返回 true 就停：拉取取消 = 关掉来源，别再往已卸载的对象里堆数据 */
  shouldStop?: () => boolean
}

function mergeChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const all = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    all.set(c, off)
    off += c.length
  }
  return all
}

/**
 * 跑一条远程命令直到 stdout 结束，返回解码好的文本。
 * 「连接建立不了 / 远端命令一个字节没回还失败」直接抛人话错误；其余情况
 * 正常返回（exitCode、stderrTail 带回去），调用方按自己的语境决定用不用。
 */
export async function sshCollect(
  params: SshStartParams,
  opts: SshCollectOpts = {},
): Promise<SshCollectResult> {
  const sessionId = await logSshStart(params)
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  try {
    for (;;) {
      if (opts.shouldStop?.()) {
        await logSshAbort(sessionId).catch(() => undefined)
        return { text: '', encoding: 'utf-8', sizeBytes: total, truncated, exitCode: null, stderrTail: '' }
      }
      const bytes = await logSshRead(sessionId, 1024 * 1024)
      if (bytes.length) {
        chunks.push(bytes)
        total += bytes.length
        opts.onProgress?.(total)
      }
      if (opts.capBytes !== undefined && total >= opts.capBytes) {
        truncated = true
        await logSshAbort(sessionId).catch(() => undefined)
        break
      }
      if (bytes.length === 0) {
        // 读完了：Rust 等进程退出、stderr 线程读完才回，错误原文不会半截
        const r = await logSshFinish(sessionId)
        if (opts.shouldStop?.()) {
          return { text: '', encoding: 'utf-8', sizeBytes: total, truncated, exitCode: null, stderrTail: '' }
        }
        if (total === 0 && r.exitCode !== null && r.exitCode !== 0) {
          throw new Error(guessSshError(r.stderrTail, r.exitCode))
        }
        const { text, encoding } = decodeBytesSmart(mergeChunks(chunks, total))
        return { text, encoding, sizeBytes: total, truncated, exitCode: r.exitCode, stderrTail: r.stderrTail }
      }
    }
    const { text, encoding } = decodeBytesSmart(mergeChunks(chunks, total))
    return { text, encoding, sizeBytes: total, truncated, exitCode: null, stderrTail: '' }
  } finally {
    // 兜底杀会话：正常 EOF 的在读到 done 时已被 Rust 回收，这里是空操作；
    // 异常路径（抛错 / shouldStop）靠它保证 ssh 进程不留尸
    await logSshAbort(sessionId).catch(() => undefined)
  }
}
