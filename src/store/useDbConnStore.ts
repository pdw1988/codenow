/**
 * 连接地址的全局状态（有名字的「我的连接」+ 无名最近记录，同一份 blob）。
 *
 * 连库查询和「我的连接」同时挂着（AppShell keep-alive）。只在其中一页
 * 读 MetaStore 的话，另一页保存后这边还是旧列表。跟收藏同一个落点。
 *
 * 密码不进这份清单——类型里就没有 password 字段。
 */
import { create } from 'zustand'
import { removeDbConn, touchDbConn, upsertSavedDbConn } from '../storage/dbconn'
import { initStore } from '../storage'
import type { DbConn } from '../types/dbconn'

interface DbConnState {
  items: DbConn[]
  loaded: boolean
  loadErr: string | null
  saveErr: string | null

  reload: () => Promise<void>
  setItems: (next: DbConn[] | ((prev: DbConn[]) => DbConn[])) => void
  touch: (addr: DbConn) => void
  upsertSaved: (patch: DbConn) => DbConn | undefined
  remove: (id: string) => void
}

let inflight: Promise<void> | null = null

export const useDbConnStore = create<DbConnState>((set, get) => ({
  items: [],
  loaded: false,
  loadErr: null,
  saveErr: null,

  reload: () => {
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const store = await initStore()
        set({ items: await store.listDbConns(), loaded: true, loadErr: null })
      } catch (err) {
        set({ loadErr: String(err) })
      } finally {
        inflight = null
      }
    })()
    return inflight
  },

  setItems: (next) => {
    const items = typeof next === 'function' ? next(get().items) : next
    set({ items })
    if (!get().loaded) return
    void initStore()
      .then((s) => s.saveDbConns(items))
      .then(() => set({ saveErr: null }))
      .catch((err: unknown) => {
        set({ saveErr: `保存到本地存储失败，刷新后本次改动将丢失：${String(err)}` })
      })
  },

  touch: (addr) => {
    void (async () => {
      if (!get().loaded) await get().reload()
      get().setItems((prev) => touchDbConn(prev, addr))
    })()
  },

  upsertSaved: (patch) => {
    const next = upsertSavedDbConn(get().items, patch)
    get().setItems(next)
    return next[0]
  },

  remove: (id) => {
    get().setItems((prev) => removeDbConn(prev, id))
  },
}))
