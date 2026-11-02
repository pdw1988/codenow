/**
 * 表结构缓存的全局状态。
 *
 * 职责边界：这个 store 只负责「把 MetaStore 的数据搬到内存里并保持同步」，
 * 搜索、SQL 生成这类纯计算不放这里，放 lib/ 下的纯函数，方便单测。
 */
import { create } from 'zustand'
import type { CacheStatus, ForeignKey, TableInfo } from '../types/schema'
import { getStore, initStore, type MetaStore } from '../storage'

interface SchemaState {
  tables: TableInfo[]
  foreignKeys: ForeignKey[]
  status: CacheStatus | null
  recent: string[]
  /** 首次加载中，用于骨架屏 */
  loading: boolean
  /** 首次加载失败的原因；不记的话页面会一直停在「正在读缓存…」 */
  loadErr: string | null
  /** 搜索框当前输入 */
  query: string
  /** 实际生效的存储实现，放进 state 是为了让状态栏能响应降级 */
  storeKind: MetaStore['kind']

  init: () => Promise<void>
  reload: () => Promise<void>
  setQuery: (query: string) => void
  /** 记录一次表访问，刷新「最近查过的表」 */
  touchTable: (tableName: string) => Promise<void>
  /** 删一条「最近查过」（chip 上的 ✕） */
  removeRecent: (tableName: string) => Promise<void>
  importTables: (tables: TableInfo[], fks: ForeignKey[]) => Promise<void>
  /** 删一张表（外键两端连带清，存储层负责）；内置示例表同样可删 */
  deleteTable: (name: string) => Promise<void>
  clearCache: () => Promise<void>
}

export const useSchemaStore = create<SchemaState>((set, get) => ({
  tables: [],
  foreignKeys: [],
  status: null,
  recent: [],
  loading: true,
  loadErr: null,
  query: '',
  storeKind: 'memory',

  init: async () => {
    set({ loading: true, loadErr: null })
    try {
      const store = await initStore()
      set({ storeKind: store.kind })
      await get().reload()
    } catch (err) {
      set({ loadErr: err instanceof Error ? err.message : String(err) })
    } finally {
      set({ loading: false })
    }
  },

  reload: async () => {
    const store = getStore()
    // 四个读操作互不依赖，并发拿，省去串行等待
    const [tables, foreignKeys, status, recent] = await Promise.all([
      store.listTables(),
      store.listForeignKeys(),
      store.status(),
      store.getRecent(),
    ])
    set({ tables, foreignKeys, status, recent })
  },

  setQuery: (query) => set({ query }),

  touchTable: async (tableName) => {
    await getStore().pushRecent(tableName)
    set({ recent: await getStore().getRecent() })
  },

  removeRecent: async (tableName) => {
    await getStore().removeRecent(tableName)
    set({ recent: await getStore().getRecent() })
  },

  importTables: async (tables, fks) => {
    const store = getStore()
    await store.upsertTables(tables)
    await store.upsertForeignKeys(fks)
    await get().reload()
  },

  deleteTable: async (name) => {
    // 存储层的 deleteTable 自带外键级联（两端都清），这里只管转发 + 让页面刷新
    await getStore().deleteTable(name)
    await get().reload()
  },

  clearCache: async () => {
    await getStore().clear()
    await get().reload()
  },
}))

/**
 * 取某张表的外键关系，分成两个方向：
 * - outgoing：当前表引用了别人（当前表是从表）
 * - incoming：别人引用了当前表（当前表是主表）
 * 对应 PRD 3.3 界面里 "user.id ← order.user_id" 那一块。
 */
export function useTableForeignKeys(tableName: string) {
  const foreignKeys = useSchemaStore((s) => s.foreignKeys)
  return {
    outgoing: foreignKeys.filter((fk) => fk.fromTable === tableName),
    incoming: foreignKeys.filter((fk) => fk.toTable === tableName),
  }
}
