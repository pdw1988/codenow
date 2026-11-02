/**
 * 页面测试登录密码的本机记忆。复用「我的连接」那套 cred_*（Windows：DPAPI 文件；macOS：钥匙串），
 * 按工号存一条。环境配置 JSON 里仍然没有密码。读写失败抛给调用方提示，不吞。
 */
import { isTauri } from '../../../storage'
import { tauriInvoke } from '../../tauriInvoke'

const target = (username: string) => `apiforge.page|${username.trim()}`

export async function pageCredGet(username: string): Promise<string> {
  if (!isTauri() || !username.trim()) return ''
  return (await tauriInvoke<string | null>('cred_get', { target: target(username) })) ?? ''
}

export async function pageCredSet(username: string, password: string): Promise<void> {
  if (!isTauri()) throw new Error('浏览器版不能记住密码')
  if (!username.trim()) throw new Error('先填登录工号')
  await tauriInvoke('cred_set', { target: target(username), password })
}

export async function pageCredDelete(username: string): Promise<void> {
  if (!isTauri() || !username.trim()) return
  await tauriInvoke('cred_delete', { target: target(username) })
}
