/**
 * MetaStore 的内存实现。
 *
 * 用途：
 * 1. 浏览器里 `pnpm dev` 调 UI，不需要 Tauri / Rust；
 * 2. Tauri 侧 SQLite 出问题时的降级兜底。
 *
 * 表结构本身不落盘（重启即回到种子数据），但「最近查过的表」写 localStorage，
 * 这样开发时热重载不会每次都清空那一排 Tag。
 */
import type { CacheStatus, DataSource, ForeignKey, TableInfo } from '../types/schema'
import type { SqlTemplate } from '../types/template'
import type { FavoriteSql } from '../types/favorite'
import type { DbConn } from '../types/dbconn'
import { MOCK_FOREIGN_KEYS, MOCK_TABLES } from './mockData'
import { upsertConfigDraft } from './configDrafts'
import { DBCONNS_LS_KEY, parseDbConns } from './dbconn'
import { parseFavorites } from './favorites'
import { parseTemplates, upsertTemplate } from './templates'
import { RECENT_LIMIT, type MetaStore } from './types'

const RECENT_KEY = 'devtools.recentTables'
const TEMPLATES_KEY = 'devtools.templates'
/** 收藏的独立键，同 TEMPLATES_KEY 的理由：清空缓存不清用户自己编的内容 */
const FAVORITES_LS_KEY = 'devtools.favorites'

/**
 * APIForge 元数据：所有 key 合并成一个 localStorage blob。
 * 键控在 JSON 内部做（`apiforge.workspace.<hash>` 等），不散成多个 localStorage
 * 条目 —— 数量不定，散着放没法整体容错读回。
 */
const APIFORGE_META_KEY = 'devtools.apiforge.meta'

function META_BLOBS(): Record<string, string> {
  try {
    const raw = localStorage.getItem(APIFORGE_META_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {}
  } catch {
    return {}
  }
}

/** 外键唯一键：一条外键由「从表.从字段 → 主表.主字段」唯一确定。
 *  导出给 LocalStorageStore 用——键的规则只准有一份 */
export const fkKey = (fk: ForeignKey) =>
  `${fk.fromTable}.${fk.fromColumn}->${fk.toTable}.${fk.toColumn}`

export class MemoryStore implements MetaStore {
  /** 声明成宽类型而不是字面量：LocalStorageStore 继承后要覆盖成 'local' */
  readonly kind: MetaStore['kind'] = 'memory'

  /* protected 而不是 private：LocalStorageStore 继承本类做持久化，
     存档时要读这两个 Map 和时间戳 */
  protected tables = new Map<string, TableInfo>()
  protected foreignKeys = new Map<string, ForeignKey>()
  protected lastUpdate: string | null = null
  /** 配置管理草稿（PRD 5.6），键 `${fileName}|${env}`。protected：LocalStorageStore 持久化要读它 */
  protected configDrafts: Record<string, string> = {}

  async init(): Promise<void> {
    // 已经有数据说明是热重载后的二次 init，不要用种子数据盖掉用户导入的表
    if (this.tables.size) return
    await this.upsertTables(MOCK_TABLES)
    await this.upsertForeignKeys(MOCK_FOREIGN_KEYS)
  }

  async listTables(): Promise<TableInfo[]> {
    return [...this.tables.values()]
  }

  async getTable(name: string): Promise<TableInfo | null> {
    return this.tables.get(name) ?? null
  }

  async upsertTables(tables: TableInfo[]): Promise<void> {
    for (const t of tables) this.tables.set(t.name, t)
    this.touch()
  }

  async deleteTable(name: string): Promise<void> {
    this.tables.delete(name)
    // 级联删掉两端指向该表的外键，避免出现悬空关联
    for (const [key, fk] of this.foreignKeys) {
      if (fk.fromTable === name || fk.toTable === name) this.foreignKeys.delete(key)
    }
    this.touch()
  }

  async listForeignKeys(): Promise<ForeignKey[]> {
    return [...this.foreignKeys.values()]
  }

  async upsertForeignKeys(fks: ForeignKey[]): Promise<void> {
    for (const fk of fks) this.foreignKeys.set(fkKey(fk), fk)
    this.touch()
  }

  async clear(): Promise<void> {
    this.tables.clear()
    this.foreignKeys.clear()
    this.lastUpdate = null
    localStorage.removeItem(RECENT_KEY)
    // 模板不清：它是用户自己编的配置，不是从数据源缓存来的。
    // 「清空缓存」按钮的语义是丢掉可重新导入的东西，模板重新导入不回来。
    // 配置草稿同理（PRD 5.6）：粘进来的 application.yml 也没法「重新导入」。
    // 我的SQL库的收藏同理：存的是用户手攒的 SQL 成品，删了就得重写。
  }

  async status(): Promise<CacheStatus> {
    const bySource: Partial<Record<DataSource, number>> = {}
    for (const t of this.tables.values()) {
      bySource[t.source] = (bySource[t.source] ?? 0) + 1
    }
    return {
      tableCount: this.tables.size,
      lastUpdate: this.lastUpdate,
      bySource,
      // 内存实现没有真实文件，用序列化长度粗略估算，够状态栏展示用
      sizeBytes: JSON.stringify([...this.tables.values()]).length,
    }
  }

  async getRecent(): Promise<string[]> {
    try {
      const raw = localStorage.getItem(RECENT_KEY)
      const parsed: unknown = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch {
      // localStorage 被禁用或内容损坏，降级为空列表，不影响主流程
      return []
    }
  }

  async pushRecent(tableName: string): Promise<void> {
    const recent = await this.getRecent()
    // 已存在则提到最前，保持「最近」语义
    const next = [tableName, ...recent.filter((n) => n !== tableName)].slice(0, RECENT_LIMIT)
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next))
    } catch {
      // 忽略写入失败（隐私模式等），最近查询只是便利功能
    }
  }

  async removeRecent(tableName: string): Promise<void> {
    const recent = await this.getRecent()
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent.filter((n) => n !== tableName)))
    } catch {
      // 忽略写入失败（隐私模式等），最近查询只是便利功能
    }
  }

  async listTemplates(): Promise<SqlTemplate[]> {
    try {
      return parseTemplates(localStorage.getItem(TEMPLATES_KEY))
    } catch {
      return []
    }
  }

  async saveTemplate(template: SqlTemplate): Promise<void> {
    await this.writeTemplates(upsertTemplate(await this.listTemplates(), template))
  }

  async deleteTemplate(id: string): Promise<void> {
    const next = (await this.listTemplates()).filter((t) => t.id !== id)
    await this.writeTemplates(next)
  }

  private async writeTemplates(list: SqlTemplate[]): Promise<void> {
    try {
      localStorage.setItem(TEMPLATES_KEY, JSON.stringify(list))
    } catch {
      // 配额满或隐私模式，这里抛出去也没有更好的处理，UI 层已有失败提示
    }
  }

  async getConfigDrafts(): Promise<Record<string, string>> {
    return { ...this.configDrafts }
  }

  async saveConfigDraft(key: string, content: string): Promise<void> {
    this.configDrafts = upsertConfigDraft(this.configDrafts, key, content)
  }

  async listFavorites(): Promise<FavoriteSql[]> {
    try {
      return parseFavorites(localStorage.getItem(FAVORITES_LS_KEY))
    } catch {
      return []
    }
  }

  async saveFavorites(items: FavoriteSql[]): Promise<void> {
    try {
      localStorage.setItem(FAVORITES_LS_KEY, JSON.stringify(items))
    } catch (err) {
      // 同 writeArchive：静默吞掉的话用户以为收藏上了其实没存
      console.warn('[storage] 收藏写入失败（隐私模式或配额满），本次改动刷新后会丢：', err)
    }
  }

  async listDbConns(): Promise<DbConn[]> {
    try {
      return parseDbConns(localStorage.getItem(DBCONNS_LS_KEY))
    } catch {
      return []
    }
  }

  async saveDbConns(conns: DbConn[]): Promise<void> {
    try {
      localStorage.setItem(DBCONNS_LS_KEY, JSON.stringify(conns))
    } catch (err) {
      console.warn('[storage] 连接历史写入失败（隐私模式或配额满），本次改动刷新后会丢：', err)
    }
  }

  /* ---------- APIForge 元数据 blob（types.ts 有语义说明） ---------- */

  async getMetaBlob(key: string): Promise<string | null> {
    try {
      const all = META_BLOBS()
      return all[key] ?? null
    } catch {
      return null
    }
  }

  async saveMetaBlob(key: string, value: string): Promise<void> {
    try {
      const all = META_BLOBS()
      all[key] = value
      localStorage.setItem(APIFORGE_META_KEY, JSON.stringify(all))
    } catch (err) {
      console.warn('[storage] APIForge 元数据写入失败（隐私模式或配额满），本次改动刷新后会丢：', err)
    }
  }

  async deleteMetaBlob(key: string): Promise<void> {
    try {
      const all = META_BLOBS()
      if (!(key in all)) return
      delete all[key]
      localStorage.setItem(APIFORGE_META_KEY, JSON.stringify(all))
    } catch (err) {
      // 删不掉只是白占地方，不能因此弄坏调用方的主流程
      console.warn('[storage] APIForge 元数据删除失败：', err)
    }
  }

  private touch() {
    this.lastUpdate = new Date().toISOString()
  }
}
