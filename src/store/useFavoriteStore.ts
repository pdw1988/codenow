/**
 * 我的SQL库的全局状态。
 *
 * 单独一个 store：所有功能页同时挂着、切走不卸载（AppShell）。收藏若只
 * 写 MetaStore、列表留在 FavPanel 挂载时读到的那份，日志转SQL 点了「⭐ 收藏」
 * 再切过来会仍是空的——存档已经有了，刷新才看得到。模板是同一类问题，
 * 所以跟 useTemplateStore 同一个落点：读写都经过这里。
 *
 * 计算（搜索 / 去重 / 起名）仍在 lib/sqlfav.ts，这里只搬数据。
 */
import { create } from 'zustand'
import { saveFavoriteDetailed, saveSqlFavorite, type FavoriteInput } from '../lib/sqlfav'
import { initStore } from '../storage'
import type { FavoriteSql } from '../types/favorite'

interface FavoriteState {
  items: FavoriteSql[]
  loaded: boolean
  loadErr: string | null
  saveErr: string | null

  reload: () => Promise<void>
  setItems: (next: FavoriteSql[] | ((prev: FavoriteSql[]) => FavoriteSql[])) => void
  /** 生成结果 / 日志转SQL：等落盘成功再报「已收藏」，失败不改内存 */
  addSql: (sql: string) => Promise<boolean>
  /** 连库查询的收藏弹框：带名字/备注/标签/当时连接。落盘口径同 `addSql` */
  addFavorite: (input: FavoriteInput) => Promise<boolean>
}

/** 并发 reload 共用一次，避免启动加载和收藏抢着 list 把刚写入的盖掉 */
let inflight: Promise<void> | null = null

export const useFavoriteStore = create<FavoriteState>((set, get) => ({
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
        set({ items: await store.listFavorites(), loaded: true, loadErr: null })
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
    // 未 load 完就写等于用空数组把存档清掉（FavPanel 原先那条纪律）
    if (!get().loaded) return
    void initStore()
      .then((s) => s.saveFavorites(items))
      .then(() => set({ saveErr: null }))
      .catch((err: unknown) => {
        set({ saveErr: `保存到本地存储失败，刷新后本次改动将丢失：${String(err)}` })
      })
  },

  addSql: async (sql) => {
    if (!get().loaded) await get().reload()
    const { list, deduped } = saveSqlFavorite(get().items, sql)
    const store = await initStore()
    await store.saveFavorites(list)
    set({ items: list, saveErr: null })
    return deduped
  },

  addFavorite: async (input) => {
    if (!get().loaded) await get().reload()
    const { list, deduped } = saveFavoriteDetailed(get().items, input)
    const store = await initStore()
    await store.saveFavorites(list)
    set({ items: list, saveErr: null })
    return deduped
  },
}))
