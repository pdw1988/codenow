/**
 * 桌面版许可码校验。验签在 Rust，这里只问结果。
 *
 * 走 `tauriInvoke`，不要 `import('@tauri-apps/api/core')`（见 tauriInvoke.ts）。
 * 浏览器没有这条 IPC——激活只能在桌面窗口里完成。
 */
import { isTauri } from '../storage'
import type { License, Trial } from './license'
import { tauriInvoke } from './tauriInvoke'

/** 读应用数据目录里的许可码；浏览器或读失败回空串 */
export async function licenseCodeLoad(): Promise<string> {
  if (!isTauri()) return ''
  try {
    return (await tauriInvoke<string | null>('license_code_load')) ?? ''
  } catch {
    return ''
  }
}

/** 写入许可码，空串即删除。写不上只影响下次启动，不报错 */
export async function licenseCodeSave(code: string): Promise<void> {
  if (!isTauri()) return
  try {
    await tauriInvoke('license_code_save', { code })
  } catch {
    /* 网页存储里还有一份 */
  }
}

/** 试用状态（Rust TrialInfo 原样）。start=true 是用户点了「免费试用」；浏览器或失败回 null */
export async function licenseTrial(start: boolean): Promise<Trial | null> {
  if (!isTauri()) return null
  try {
    return await tauriInvoke<Trial>('license_trial', { start })
  } catch {
    return null
  }
}

export async function licenseVerify(code: string): Promise<License | null> {
  if (!isTauri()) return null
  try {
    const got = await tauriInvoke<License | null>('license_verify', { code })
    if (!got || got.kind !== 'pro') return null
    return got
  } catch {
    return null
  }
}
