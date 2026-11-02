/**
 * SQL 优化记录的全局状态。
 *
 * 单独一个 store 的理由同 useFavoriteStore：所有功能页同时挂着、切走不卸载
 * （AppShell）。连库查询页跑一次查询就记一笔，若只写 MetaStore、列表留在
 * 「优化记录」页挂载时读到的那份，记完切过去还是空的，得刷新才看得见。
 *
 * 计算（解析、去重裁剪、统计）在 lib/sqladviseLog.ts，这里只搬数据。
 */
import { create } from 'zustand'
import {
  appendAdviceLog,
  parseAdviceLog,
  type AdviceLogEntry,
} from '../lib/sqladviseLog'
import { initStore } from '../storage'
import { ADVICE_LOG_KEY } from '../storage/adviceLog'

interface AdviceLogState {
  items: AdviceLogEntry[]
  loaded: boolean
  loadErr: string | null
  saveErr: string | null

  reload: () => Promise<void>
  /**
   * 记一笔。**基于内存里这份算**（zustand 的 set 是原子的）：不要「读回 blob →
   * push → 写回」，连着点两次「运行」会把两次交错丢一条。
   * 是加一行还是只 +1 次计数，由 `appendAdviceLog` 按「语句 + 结论」判。
   * 写失败只影响历史页，调用方（连库查询）不该为此变红。
   */
  append: (entry: AdviceLogEntry) => Promise<void>
  clear: () => Promise<void>
}

/** 并发 reload 共用一次，避免启动加载和记录抢着读，把刚写入的盖掉 */
let inflight: Promise<void> | null = null

export const useSqlAdviseStore = create<AdviceLogState>((set, get) => ({
  items: [],
  loaded: false,
  loadErr: null,
  saveErr: null,

  reload: () => {
    if (inflight) return inflight
    inflight = (async () => {
      try {
        // 必须 await initStore()：getStore() 在初始化完成前返回的是内存实现
        const store = await initStore()
        set({ items: parseAdviceLog(await store.getMetaBlob(ADVICE_LOG_KEY)), loaded: true, loadErr: null })
      } catch (err) {
        set({ loadErr: String(err) })
      } finally {
        inflight = null
      }
    })()
    return inflight
  },

  append: async (entry) => {
    // 没 load 完就先等：否则会用空数组把人家攒的记录清掉
    if (!get().loaded) await get().reload()
    const next = appendAdviceLog(get().items, entry)
    set({ items: next })
    try {
      const store = await initStore()
      await store.saveMetaBlob(ADVICE_LOG_KEY, JSON.stringify(next))
      set({ saveErr: null })
    } catch (err) {
      // 只报在历史页：记录写不进去不该打扰正在查数据的人
      set({ saveErr: `优化记录没能存到本地，刷新后本次将丢失：${String(err)}` })
    }
  },

  clear: async () => {
    const prev = get().items
    set({ items: [], saveErr: null })
    try {
      const store = await initStore()
      await store.saveMetaBlob(ADVICE_LOG_KEY, JSON.stringify([]))
    } catch (err) {
      // 删失败把原来的放回去，别让界面显示「没了」而存档还在
      set({ items: prev, saveErr: `清空失败：${String(err)}` })
    }
  },
}))
