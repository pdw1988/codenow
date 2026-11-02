/**
 * 许可状态。许可码存在应用数据目录的文件里（不进 cache.db，清缓存不丢），
 * localStorage 留一份备用：老版只存在这里，启动时搬进文件。
 * isPro = 有效许可码 或 7 天试用未到期。
 */
import { create } from 'zustand'
import { licenseCodeLoad, licenseCodeSave, licenseTrial, licenseVerify } from '../lib/licenseIpc'
import { LICENSE_ENABLED, type License, type Trial } from '../lib/license'

const LS_KEY = 'devtools.license.v1'

function readStored(): string {
  try {
    return localStorage.getItem(LS_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeStored(code: string): void {
  try {
    if (code) localStorage.setItem(LS_KEY, code)
    else localStorage.removeItem(LS_KEY)
  } catch {
    /* 隐私模式写不上：本次会话仍按内存里的 isPro 用 */
  }
  void licenseCodeSave(code)
}

/** 文件优先；文件没有而网页存储有（老版存的）就搬过去 */
async function loadCode(): Promise<string> {
  const fromFile = await licenseCodeLoad()
  if (fromFile) return fromFile
  const legacy = readStored()
  if (legacy) await licenseCodeSave(legacy)
  return legacy
}

interface LicenseState {
  ready: boolean
  isPro: boolean
  license: License | null
  trial: Trial | null
  upgradeOpen: boolean
  activateErr: string | null

  hydrate: () => Promise<void>
  openUpgrade: () => void
  closeUpgrade: () => void
  activate: (code: string) => Promise<boolean>
  startTrial: () => Promise<boolean>
}

export const useLicenseStore = create<LicenseState>((set, get) => ({
  ready: !LICENSE_ENABLED,
  isPro: !LICENSE_ENABLED,
  license: null,
  trial: null,
  upgradeOpen: false,
  activateErr: null,

  hydrate: async () => {
    if (!LICENSE_ENABLED) {
      set({ ready: true, isPro: true, license: null })
      return
    }
    const [code, trial] = await Promise.all([loadCode(), licenseTrial(false)])
    const license = code ? await licenseVerify(code) : null
    set({ ready: true, isPro: !!license || !!trial?.active, license, trial })
  },

  openUpgrade: () => {
    if (!LICENSE_ENABLED) return
    set({ upgradeOpen: true, activateErr: null })
  },
  closeUpgrade: () => set({ upgradeOpen: false }),

  activate: async (code) => {
    const license = await licenseVerify(code)
    if (!license) {
      set({ activateErr: '许可码无效或已过期', isPro: !!get().trial?.active, license: null })
      return false
    }
    writeStored(license.code)
    set({ isPro: true, license, activateErr: null, upgradeOpen: false })
    return true
  },

  startTrial: async () => {
    const trial = await licenseTrial(true)
    if (!trial) return false
    set({ trial, isPro: !!get().license || trial.active })
    return trial.active
  },
}))

/** 只靠试用在用专业版时返回剩余天数，否则 null（买过码的不提试用） */
export function trialDaysLeft(s: Pick<LicenseState, 'license' | 'trial'>): number | null {
  return !s.license && s.trial?.active ? s.trial.remaining_days : null
}
