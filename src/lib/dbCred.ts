/**
 * 连接密码的跨天存储。桌面版走 cred_*（Windows：本机 DPAPI 文件；macOS：钥匙串）。
 * 浏览器没有这条 IPC。「我的连接」JSON / cache.db 仍然没有 password 列。
 *
 * 读写失败必须抛出去：吞掉的话，勾了记住、重启却是空的，用户以为没勾上。
 */
import { canPersistPass, credTarget, type DbConn, type DbEnv } from '../types/dbconn'
import { isTauri } from '../storage'
import { useDbPassStore } from '../store/useDbPassStore'
import { tauriInvoke } from './tauriInvoke'

type Addr = Pick<DbConn, 'host' | 'port' | 'user' | 'db' | 'kind'>

export function credErr(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  return String(e)
}

export async function credGet(addr: Addr): Promise<string> {
  if (!isTauri()) return ''
  return (await tauriInvoke<string | null>('cred_get', { target: credTarget(addr) })) ?? ''
}

export async function credSet(addr: Addr, password: string): Promise<void> {
  if (!isTauri()) throw new Error('浏览器不能记住密码')
  const p = password.trim()
  if (!p) throw new Error('密码是空的')
  await tauriInvoke('cred_set', { target: credTarget(addr), password: p })
}

export async function credDelete(addr: Addr): Promise<void> {
  if (!isTauri()) return
  try {
    await tauriInvoke('cred_delete', { target: credTarget(addr) })
  } catch {
    /* 没有这条也算清掉 */
  }
}

/** 进程里有就用；否则非生产才问本机凭据 */
export async function loadPass(addr: Addr, env?: DbEnv): Promise<string> {
  const mem = useDbPassStore.getState().peek(addr)
  if (mem) return mem
  if (!canPersistPass(env)) return ''
  return credGet(addr)
}

/** 连上之后：内存一定记；勾了记住且非生产才写本机，否则删。写失败抛错，调用方自己提示。 */
export async function persistPass(addr: Addr, password: string, keep: boolean, env?: DbEnv): Promise<void> {
  useDbPassStore.getState().remember(addr, password)
  if (keep && canPersistPass(env)) {
    await credSet(addr, password)
    return
  }
  await credDelete(addr)
}
