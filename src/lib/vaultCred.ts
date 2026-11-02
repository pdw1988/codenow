/**
 * 常用信息里敏感字段的读写。走跟连接密码同一套 cred_*（Windows DPAPI，绑当前系统用户），
 * 一条一个键，里面是 { 字段id: 值 } 的 JSON——展开一条只解密一次。
 */
import { isTauri } from '../storage'
import { vaultCredTarget } from '../storage/vault'
import { tauriInvoke } from './tauriInvoke'

export async function vaultSecretsGet(id: string): Promise<Record<string, string>> {
  if (!isTauri()) return {}
  const raw = (await tauriInvoke<string | null>('cred_get', { target: vaultCredTarget(id) })) ?? ''
  if (!raw) return {}
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    throw new Error('加密存的内容读出来不对')
  }
  if (typeof obj !== 'object' || obj === null) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') out[k] = v
  return out
}

export async function vaultSecretsSet(id: string, secrets: Record<string, string>): Promise<void> {
  if (!isTauri()) throw new Error('浏览器版存不了敏感字段，请用桌面版')
  await tauriInvoke('cred_set', { target: vaultCredTarget(id), password: JSON.stringify(secrets) })
}

export async function vaultSecretsDelete(id: string): Promise<void> {
  if (!isTauri()) return
  await tauriInvoke('cred_delete', { target: vaultCredTarget(id) })
}
