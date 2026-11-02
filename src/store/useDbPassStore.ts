/**
 * 这次进程里记住的连接密码。
 *
 * **不准 persist 到 zustand / localStorage / cache.db。**
 * 跨天免输走 `dbCred.ts`（系统凭据），不走这里。
 * 这里只是同一次打开里少打一遍。
 */
import { create } from 'zustand'
import { addrKey, type DbConn } from '../types/dbconn'

interface State {
  byKey: Record<string, string>
  remember: (addr: Pick<DbConn, 'host' | 'port' | 'user' | 'db' | 'kind'>, password: string) => void
  peek: (addr: Pick<DbConn, 'host' | 'port' | 'user' | 'db' | 'kind'>) => string
}

export const useDbPassStore = create<State>((set, get) => ({
  byKey: {},
  remember: (addr, password) => {
    const p = password.trim()
    if (!p) return
    const k = addrKey(addr)
    set((s) => ({ byKey: { ...s.byKey, [k]: p } }))
  },
  peek: (addr) => get().byKey[addrKey(addr)] ?? '',
}))
