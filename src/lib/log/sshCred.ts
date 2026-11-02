/**
 * SSH 服务器密码/私钥口令的跨天存储——复用连库密码那条 cred_* 通道
 * （Windows：DPAPI 加密绑当前 Windows 用户，拷走文件解不开；macOS/Linux：
 * 系统钥匙串），只是 key 前缀换成 ssh。「最近连接」的 localStorage 里仍然
 * 只有地址四项，密码永不进 JSON / cache.db。
 * 读写失败必须抛出去：静默吞掉的话，用户以为记住了、重启后却是空的。
 */
import { isTauri } from '../../storage'
import { tauriInvoke } from '../tauriInvoke'

export interface SshAddr {
  host: string
  port: number
  user: string
}

/** 凭据库的 key：同一台机器换端口 / 换用户名是不同的钥匙 */
export function sshCredTarget(a: SshAddr): string {
  return `ssh|${a.user}@${a.host}|${a.port}`
}

export async function sshCredGet(a: SshAddr): Promise<string> {
  if (!isTauri()) return ''
  return (await tauriInvoke<string | null>('cred_get', { target: sshCredTarget(a) })) ?? ''
}

export async function sshCredSet(a: SshAddr, secret: string): Promise<void> {
  if (!isTauri()) throw new Error('浏览器版存不了密码，请用桌面版')
  const s = secret.trim()
  if (!s) throw new Error('密码是空的')
  await tauriInvoke('cred_set', { target: sshCredTarget(a), password: s })
}

export async function sshCredDelete(a: SshAddr): Promise<void> {
  if (!isTauri()) return
  try {
    await tauriInvoke('cred_delete', { target: sshCredTarget(a) })
  } catch {
    /* 本来就没有这条也算删干净 */
  }
}
