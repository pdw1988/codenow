/**
 * SQL 生成模板的全局状态，PRD 4.13。
 *
 * 单独一个 store 而不是塞进 useSchemaStore：模板跟表结构缓存的生命周期不同
 * （清空缓存不清模板），混在一起会让 reload 的语义变含糊。
 */
import { create } from 'zustand'
import type { SqlTemplate } from '../types/template'
import { getStore, initStore } from '../storage'

interface TemplateState {
  templates: SqlTemplate[]
  loaded: boolean

  reload: () => Promise<void>
  save: (template: SqlTemplate) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useTemplateStore = create<TemplateState>((set, get) => ({
  templates: [],
  loaded: false,

  reload: async () => {
    // 必须 await initStore()：getStore() 在初始化完成前返回的是内存实现，
    // 直接用会在 Tauri 里读到 localStorage 而不是 SQLite。initStore 是幂等的。
    const store = await initStore()
    set({ templates: await store.listTemplates(), loaded: true })
  },

  save: async (template) => {
    await getStore().saveTemplate(template)
    await get().reload()
  },

  remove: async (id) => {
    await getStore().deleteTemplate(id)
    await get().reload()
  },
}))

/**
 * 生成模板 id。
 *
 * 用时间戳 + 随机后缀而不是 crypto.randomUUID()：后者在非 https 的
 * 浏览器环境下不一定可用，而这个工具本来就要在 localhost 上跑。
 */
export function newTemplateId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}
