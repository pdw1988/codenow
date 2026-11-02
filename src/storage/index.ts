/**
 * 存储层入口：按运行环境选实现。
 *
 * Tauri 环境下 window 上会有 __TAURI_INTERNALS__，靠这个判断即可，
 * 不用引 @tauri-apps/api（浏览器里那样会直接抛错）。
 *
 * SqliteStore 通过动态 import 加载：它顶层 import 了 tauri 插件，
 * 静态引入会让浏览器调试模式一起崩掉。
 */
import { LocalStorageStore } from './localStore'
import { MemoryStore } from './memoryStore'
import { syncBuiltinTables } from './builtinSeed'
import type { MetaStore } from './types'

export type { MetaStore } from './types'
export { RECENT_LIMIT } from './types'

/** 是否运行在 Tauri 壳内 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 默认给内存实现，initStore() 成功接上持久化实现后会被替换 */
let instance: MetaStore = new MemoryStore()
let initialized = false
/** 进行中的初始化。多处并发调 initStore() 时共用同一次，避免重复 init */
let pending: Promise<MetaStore> | null = null

/** localStorage 实现起不来（隐私模式禁用存储等）时的最后兜底 */
function memoryFallback(reason: string, err: unknown): MetaStore {
  console.error(`[storage] ${reason}，降级到内存实现（数据不落盘）：`, err)
  return new MemoryStore()
}

/**
 * 初始化存储层，返回最终生效的实现。
 *
 * 选择顺序：
 * - Tauri → SQLite（真正落盘）；起不来降级 localStorage（WebView2 里同样持久）；
 * - 浏览器 → localStorage（bug5：导入的表刷新不能丢）；再不行才是内存。
 * 只有 localStorage 都不可用时数据才会「关闭即丢」，而不是报错退出——
 * 宁可这次会话不落盘，也不要让用户对着一个打不开的工具。
 *
 * 可以并发调用：多个 store 各自 await 这个函数是安全的，真正的初始化只跑一次。
 * 不去重的话两处并发调用会 Database.load 两次、跑两遍 migration。
 */
export async function initStore(): Promise<MetaStore> {
  if (initialized) return instance
  pending ??= doInit()
  return pending
}

/**
 * bug9：启动时同步内置示例表（清理历史退役种子 / 刷新旧定义 / 空库播种）。
 * 故意吞掉异常：同步坏了顶多是旧示例多留一会儿，不能让工具打不开。
 */
async function syncBuiltins(store: MetaStore): Promise<void> {
  try {
    await syncBuiltinTables(store)
  } catch (err) {
    console.error('[storage] 内置示例表同步失败（不影响本次使用）：', err)
  }
}

async function doInit(): Promise<MetaStore> {
  if (isTauri()) {
    try {
      const { SqliteStore } = await import('./sqliteStore')
      const sqlite = new SqliteStore()
      await sqlite.init()
      instance = sqlite
      await syncBuiltins(instance)
      initialized = true
      return instance
    } catch (err) {
      console.error('[storage] SQLite 初始化失败，尝试降级到 localStorage 实现：', err)
    }
  }

  try {
    const local = new LocalStorageStore()
    // 探一下 localStorage 真的可用再认账：有的隐私模式读可以、写直接抛
    local.probe()
    await local.init()
    instance = local
  } catch (err) {
    instance = memoryFallback('localStorage 不可用', err)
  }

  initialized = true
  await syncBuiltins(instance)
  return instance
}

/** 取当前生效的 store。initStore() 之前调用会拿到内存实现。 */
export function getStore(): MetaStore {
  return instance
}
