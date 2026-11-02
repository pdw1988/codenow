import type { DbConn } from '../types/dbconn'
import type { FavoriteSql } from '../types/favorite'
import type {
  CacheStatus,
  ForeignKey,
  TableInfo,
} from '../types/schema'
import type { SqlTemplate } from '../types/template'

/**
 * 元数据存储接口。
 *
 * 这层抽象的目的：前端只依赖这个接口，不知道底下是内存 Map 还是 SQLite。
 * - 浏览器 / 未装 Rust 时 → MemoryStore（mock 数据，功能可点可看）
 * - Tauri 环境 → SqliteStore（tauri-plugin-sql，落盘到 cache.db）
 *
 * 所有方法都是异步的，即使内存实现是同步的也包一层 Promise，
 * 这样切到 SQLite 时调用方一行不用改。
 */
export interface MetaStore {
  /** local = 浏览器 localStorage 持久化（bug5：刷新不丢） */
  readonly kind: 'memory' | 'sqlite' | 'local'

  /** 建表 / 加载缓存到内存，应用启动时调一次 */
  init(): Promise<void>

  listTables(): Promise<TableInfo[]>
  getTable(name: string): Promise<TableInfo | null>
  /** 按表名 upsert，导入时用；同名表整体覆盖 */
  upsertTables(tables: TableInfo[]): Promise<void>
  deleteTable(name: string): Promise<void>

  listForeignKeys(): Promise<ForeignKey[]>
  upsertForeignKeys(fks: ForeignKey[]): Promise<void>

  /** 清空全部缓存（PRD 6.7 的「清空缓存」按钮） */
  clear(): Promise<void>
  status(): Promise<CacheStatus>

  /** 最近查过的表，PRD 3.3 界面底部那一排 */
  getRecent(): Promise<string[]>
  pushRecent(tableName: string): Promise<void>
  /** 从「最近查过」删掉一条（chip 上的 ✕） */
  removeRecent(tableName: string): Promise<void>

  /**
   * SQL 生成模板，PRD 4.13。
   *
   * 两种实现都把模板整体存成一个 JSON blob（SQLite 放 cache_metadata，
   * 内存实现放 localStorage）。不给模板单独建表：模板数量是几十条量级，
   * 不需要按字段查询，而建表要动 Rust 侧的 migration。
   */
  listTemplates(): Promise<SqlTemplate[]>
  /** 按 id upsert */
  saveTemplate(template: SqlTemplate): Promise<void>
  deleteTemplate(id: string): Promise<void>

  /**
   * 配置管理的编辑器草稿，PRD 5.6/7.3。key 是 `${fileName}|${env}`
   * （如 application.yml|dev），value 是编辑器全文。
   *
   * 和模板同一个思路：整体存一个 JSON blob（SQLite 放 cache_metadata），
   * 不为它建表——草稿是用户手写的配置文本，几十 KB 量级、按整份读写，
   * 建表带来的按字段查询能力一样也用不上。
   */
  getConfigDrafts(): Promise<Record<string, string>>
  saveConfigDraft(key: string, content: string): Promise<void>

  /**
   * 我的SQL库（SQL收藏夹），PRD v6.3 §6.1~6.9。
   *
   * 整体读写一份 JSON blob，同模板/草稿的先例：收藏是几十到几百条的量级，
   * 搜索在 UI 内存里做（lib/sqlfav.ts 的纯函数），按字段查询的能力用不上，
   * 不为它建 favorite_sql 真表。UI 全内存编辑，任何变更后整体覆写一次。
   */
  listFavorites(): Promise<FavoriteSql[]>
  saveFavorites(items: FavoriteSql[]): Promise<void>

  /**
   * APIForge 的通用元数据 blob（技术方案 §2.8）：扫描结果、关联表修正、
   * 用例、环境配置都按 key 存一份 JSON 字符串，key 约定以 `apiforge.` 开头。
   * 「清空缓存」不清这个前缀 —— 环境配置和关联表修正是用户手攒的，
   * 跟模板/收藏同一类；扫描缓存重扫一次就有，留着也无害（指纹变了会刷新）。
   */
  getMetaBlob(key: string): Promise<string | null>
  saveMetaBlob(key: string, value: string): Promise<void>
  /**
   * 删一个 blob。给扫描结果的 LRU 淘汰用（lib/apiforge/scan/workspaceCache.ts）：
   * 一份全量结果 0.3~6 MB，分键存多份后必须能把最久没用的那份真删掉，
   * 而不是覆写成空串留着占行。
   */
  deleteMetaBlob(key: string): Promise<void>

  /**
   * 连库的连接历史（「连库·扫源码导入」方式二）。只存类型/主机/端口/用户/第五栏，
   * 密码永不落盘。同收藏的 blob 先例：条目是个位数到十几条，
   * 整体一份 JSON，不建真表。
   */
  listDbConns(): Promise<DbConn[]>
  saveDbConns(conns: DbConn[]): Promise<void>
}

/** 最近查询保留条数 */
export const RECENT_LIMIT = 8
