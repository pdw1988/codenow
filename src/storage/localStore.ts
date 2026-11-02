/**
 * MetaStore 的 localStorage 实现 —— bug.txt bug5 的修法。
 *
 * 背景：用户在浏览器模式下导入了表，一刷新就没了（MemoryStore 只把表放在
 * 内存 Map 里）。Tauri 的 SQLite 路径又因为缺 MSVC 链接器一直没法用，
 * 所以浏览器模式需要自己的持久化：localStorage 是 WebView2 / 浏览器里
 * 唯一不用动 Rust 就能落盘的地方。
 *
 * 实现上直接继承 MemoryStore：增删改查、外键级联删除、「清空缓存保留模板」
 * 这些语义只有一份（都在基类），这里只做两件事——
 * 1. init() 时读回上次存档；2. 每次改动后把 表+外键+lastUpdate 整体写回。
 *
 * 存档故意是单个 key 的整体 JSON：表结构是几百 KB 量级的一次性整体，
 * 拆成每张表一个 key 只会让「读到一半写坏」的状态多出来，没有任何收益。
 */
import type { ForeignKey, TableInfo } from '../types/schema'
import { parseConfigDrafts } from './configDrafts'
import { fkKey, MemoryStore } from './memoryStore'

/** 版本号挂在 key 里：以后字段结构变了换 v2，旧存档自然作废而不是解析炸掉 */
const CACHE_KEY = 'devtools.cache.v1'

/** 配置管理草稿的独立键，**故意不并入** CACHE_KEY 存档：
 *  「清空缓存」会删 CACHE_KEY，但草稿是用户手写的配置文本，
 *  没法像表结构那样「重新导入」，跟着存档被一起删就找不回来了。 */
const DRAFTS_KEY = 'devtools.config.v1'

interface CacheBlob {
  tables: TableInfo[]
  foreignKeys: ForeignKey[]
  lastUpdate: string | null
}

export class LocalStorageStore extends MemoryStore {
  /** 状态栏按它区分显示；'local' 表示「浏览器里但刷新不丢」 */
  readonly kind = 'local' as const

  /**
   * 探一下 localStorage 真的可用。有的隐私模式读没问题、写直接抛，
   * 只 try getItem 会误判成可用然后每次存档都失败。initStore() 在认账前调它。
   */
  probe(): void {
    const k = `${CACHE_KEY}.__probe`
    localStorage.setItem(k, '1')
    if (localStorage.getItem(k) !== '1') throw new Error('localStorage 写入未生效')
    localStorage.removeItem(k)
  }

  async init(): Promise<void> {
    // 草稿和表存档分开读：上面 readArchive 返回 false 只说明没有表存档，
    // 草稿可能还在（比如刚点过「清空缓存」）
    try {
      this.configDrafts = parseConfigDrafts(localStorage.getItem(DRAFTS_KEY))
    } catch {
      // localStorage 读不了时保持空草稿；parseConfigDrafts 自身已容错坏数据
    }
    if (this.readArchive()) return
    // 没有存档（第一次跑，或刚点过「清空缓存」）→ 回种子数据，跟 MemoryStore 同语义
    await super.init()
  }

  async upsertTables(tables: TableInfo[]): Promise<void> {
    await super.upsertTables(tables)
    this.writeArchive()
  }

  async deleteTable(name: string): Promise<void> {
    await super.deleteTable(name)
    this.writeArchive()
  }

  async upsertForeignKeys(fks: ForeignKey[]): Promise<void> {
    await super.upsertForeignKeys(fks)
    this.writeArchive()
  }

  async clear(): Promise<void> {
    await super.clear()
    // 存档一并删掉：不清的话下次刷新「清空缓存」就白点了
    try {
      localStorage.removeItem(CACHE_KEY)
    } catch {
      // 读不到 localStorage 时写档案也早就失败了，这里没什么可做的
    }
  }

  async saveConfigDraft(key: string, content: string): Promise<void> {
    await super.saveConfigDraft(key, content)
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(this.configDrafts))
    } catch (err) {
      console.warn('[storage] 配置草稿写入失败（隐私模式或配额满），本次改动刷新后会丢：', err)
    }
  }

  /**
   * 读存档进内存。返回是否有有效存档。
   * 内容损坏按「没有存档」处理重新播种——localStorage 不是关键数据，
   * 宁可回到种子也不能让工具起不来。
   */
  private readArchive(): boolean {
    try {
      const raw = localStorage.getItem(CACHE_KEY)
      if (!raw) return false
      const blob = JSON.parse(raw) as Partial<CacheBlob>
      if (!Array.isArray(blob.tables)) return false
      for (const t of blob.tables) this.tables.set(t.name, t)
      if (Array.isArray(blob.foreignKeys)) {
        for (const fk of blob.foreignKeys) this.foreignKeys.set(fkKey(fk), fk)
      }
      this.lastUpdate = blob.lastUpdate ?? null
      return true
    } catch {
      return false
    }
  }

  /** 整体写回。失败只在控制台提醒：静默吞掉的话，用户以为存上了其实没存 */
  private writeArchive(): void {
    const blob: CacheBlob = {
      tables: [...this.tables.values()],
      foreignKeys: [...this.foreignKeys.values()],
      lastUpdate: this.lastUpdate,
    }
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(blob))
    } catch (err) {
      console.warn('[storage] localStorage 写入失败（隐私模式或配额满），本次改动刷新后会丢：', err)
    }
  }
}
