/**
 * JSON 查看页的历史记录。计算在 lib/jsonHistory.ts，这里只搬数据；
 * 写法同 useSqlAdviseStore（基于内存那份算，写失败只报不拦）。
 */
import { create } from 'zustand'
import { addJsonHistory, parseJsonHistory, renameJsonHistory, type JsonHistoryEntry } from '../lib/jsonHistory'
import { initStore } from '../storage'
import { JSON_HISTORY_KEY } from '../storage/jsonHistory'

interface JsonHistoryState {
  items: JsonHistoryEntry[]
  loaded: boolean
  saveErr: string | null
  reload: () => Promise<void>
  /** name 只在给了时覆盖；不给就沿用同内容老记录的名字 */
  add: (json: string, from: string | null, name?: string) => Promise<void>
  rename: (id: string, name: string) => Promise<void>
  remove: (id: string) => Promise<void>
  clear: () => Promise<void>
}

let inflight: Promise<void> | null = null

export const useJsonHistoryStore = create<JsonHistoryState>((set, get) => {
  /** 写盘；失败把界面退回 prev，别显示「已删」而存档还在 */
  const save = async (next: JsonHistoryEntry[], prev: JsonHistoryEntry[]) => {
    set({ items: next })
    try {
      const store = await initStore()
      await store.saveMetaBlob(JSON_HISTORY_KEY, JSON.stringify(next))
      set({ saveErr: null })
    } catch (err) {
      set({ items: prev, saveErr: `历史记录没能存到本地：${String(err)}` })
    }
  }

  return {
    items: [],
    loaded: false,
    saveErr: null,

    reload: () => {
      if (inflight) return inflight
      inflight = (async () => {
        try {
          const store = await initStore()
          set({ items: parseJsonHistory(await store.getMetaBlob(JSON_HISTORY_KEY)), loaded: true })
        } catch (err) {
          set({ saveErr: `历史记录读取失败：${String(err)}` })
        } finally {
          inflight = null
        }
      })()
      return inflight
    },

    add: async (json, from, name) => {
      // 没加载完就先等：否则空数组会把已有记录盖掉
      if (!get().loaded) await get().reload()
      const prev = get().items
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const next = addJsonHistory(prev, { id, json, from, at: new Date().toISOString(), ...(name ? { name } : {}) })
      if (next !== prev) await save(next, prev)
    },

    rename: async (id, name) => {
      const prev = get().items
      await save(renameJsonHistory(prev, id, name), prev)
    },

    remove: async (id) => {
      const prev = get().items
      await save(
        prev.filter((e) => e.id !== id),
        prev,
      )
    },

    clear: async () => {
      await save([], get().items)
    },
  }
})
