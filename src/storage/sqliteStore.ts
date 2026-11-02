/**
 * MetaStore 的 SQLite 实现，走 tauri-plugin-sql，落盘到
 * %AppData%\com.pdw.devtools\cache.db。建表脚本在 src-tauri/src/lib.rs 的
 * migration 里，这里只管读写。
 *
 * 注意：这个文件只能在 Tauri 壳内工作，浏览器里 import 会失败，
 * 所以 storage/index.ts 用动态 import 按环境加载。
 */
import Database from '@tauri-apps/plugin-sql'
import type { CacheStatus, Column, DataSource, ForeignKey, TableInfo } from '../types/schema'
import type { SqlTemplate } from '../types/template'
import type { FavoriteSql } from '../types/favorite'
import type { DbConn } from '../types/dbconn'
import { CONFIG_DRAFTS_KEY, parseConfigDrafts, upsertConfigDraft } from './configDrafts'
import { DBCONNS_KEY, parseDbConns } from './dbconn'
import { FAVORITES_KEY, parseFavorites } from './favorites'
import { parseTemplates, TEMPLATES_KEY, upsertTemplate } from './templates'
import { ADVICE_LOG_KEY } from './adviceLog'
import { JSON_HISTORY_KEY } from './jsonHistory'
import { REDIS_CONNS_KEY } from './redisConns'
import { VAULT_KEY } from './vault'
import { RECENT_LIMIT, type MetaStore } from './types'

const DB_PATH = 'sqlite:cache.db'

const META_LAST_UPDATE = 'lastUpdate'
const META_RECENT = 'recentTables'

interface TableRow {
  id: number
  table_name: string
  table_comment: string | null
  java_class: string | null
  data_source: string
  created_at: string
  updated_at: string
}

interface ColumnRow {
  table_id: number
  column_name: string
  column_type: string
  nullable: number
  is_primary_key: number
  is_auto_increment: number
  is_unique?: number
  is_indexed?: number
  default_value: string | null
  column_comment: string | null
  java_field: string | null
  java_type: string | null
}

interface FkRow {
  from_table: string
  from_column: string
  to_table: string
  to_column: string
  constraint_name: string | null
  confidence: string
}

/** SQLite 没有布尔类型，存的是 0/1 */
const toBool = (n: number) => n !== 0
const fromBool = (b: boolean) => (b ? 1 : 0)

/** 生成 ($1,$2,$3),($4,$5,$6) 形式的占位符，用于多行批量插入 */
function placeholders(rowCount: number, colCount: number): string {
  const rows: string[] = []
  for (let r = 0; r < rowCount; r++) {
    const cols: string[] = []
    for (let c = 0; c < colCount; c++) cols.push(`$${r * colCount + c + 1}`)
    rows.push(`(${cols.join(',')})`)
  }
  return rows.join(',')
}

function toColumn(row: ColumnRow): Column {
  return {
    name: row.column_name,
    type: row.column_type,
    nullable: toBool(row.nullable),
    isPrimaryKey: toBool(row.is_primary_key),
    isAutoIncrement: toBool(row.is_auto_increment),
    isUnique: toBool(row.is_unique ?? 0),
    isIndexed: toBool(row.is_indexed ?? 0),
    defaultValue: row.default_value ?? undefined,
    comment: row.column_comment ?? undefined,
    javaField: row.java_field ?? '',
    javaType: row.java_type ?? 'Object',
  }
}

export class SqliteStore implements MetaStore {
  readonly kind = 'sqlite' as const

  private db: Database | null = null

  async init(): Promise<void> {
    // load 会触发 Rust 侧的 migration，建表就在这一步完成
    this.db = await Database.load(DB_PATH)
  }

  /** 所有读写都先过这里，避免 init 之前被调用时报 null 引用 */
  private conn(): Database {
    if (!this.db) throw new Error('SqliteStore 尚未 init()')
    return this.db
  }

  async listTables(): Promise<TableInfo[]> {
    const db = this.conn()
    // 一次把表和字段都捞上来，避免 N+1 次 IPC
    const [tableRows, columnRows] = await Promise.all([
      db.select<TableRow[]>('SELECT * FROM cached_tables ORDER BY table_name'),
      db.select<ColumnRow[]>('SELECT * FROM cached_columns ORDER BY table_id, ordinal'),
    ])

    const columnsByTableId = new Map<number, Column[]>()
    for (const row of columnRows) {
      const list = columnsByTableId.get(row.table_id) ?? []
      list.push(toColumn(row))
      columnsByTableId.set(row.table_id, list)
    }

    return tableRows.map((row) => ({
      name: row.table_name,
      comment: row.table_comment ?? undefined,
      javaClass: row.java_class ?? undefined,
      source: row.data_source as DataSource,
      columns: columnsByTableId.get(row.id) ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  async getTable(name: string): Promise<TableInfo | null> {
    const db = this.conn()
    const rows = await db.select<TableRow[]>(
      'SELECT * FROM cached_tables WHERE table_name = $1',
      [name],
    )
    const row = rows[0]
    if (!row) return null

    const columnRows = await db.select<ColumnRow[]>(
      'SELECT * FROM cached_columns WHERE table_id = $1 ORDER BY ordinal',
      [row.id],
    )

    return {
      name: row.table_name,
      comment: row.table_comment ?? undefined,
      javaClass: row.java_class ?? undefined,
      source: row.data_source as DataSource,
      columns: columnRows.map(toColumn),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  async upsertTables(tables: TableInfo[]): Promise<void> {
    const db = this.conn()

    for (const table of tables) {
      await db.execute(
        `INSERT INTO cached_tables
           (table_name, table_comment, java_class, data_source, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT(table_name) DO UPDATE SET
           table_comment = excluded.table_comment,
           java_class    = excluded.java_class,
           data_source   = excluded.data_source,
           updated_at    = excluded.updated_at`,
        [
          table.name,
          table.comment ?? null,
          table.javaClass ?? null,
          table.source,
          table.createdAt,
          table.updatedAt,
        ],
      )

      const idRows = await db.select<Array<{ id: number }>>(
        'SELECT id FROM cached_tables WHERE table_name = $1',
        [table.name],
      )
      const tableId = idRows[0]?.id
      if (tableId === undefined) continue

      // 字段整体替换而非逐字段 diff：DDL 重新导入时字段可能增删改名，
      // 全量覆盖比对齐差异简单且不会留下脏数据
      await db.execute('DELETE FROM cached_columns WHERE table_id = $1', [tableId])

      if (table.columns.length) {
        const COLS = 14
        const values = table.columns.flatMap((c, i) => [
          tableId,
          i,
          c.name,
          c.type,
          fromBool(c.nullable),
          fromBool(c.isPrimaryKey),
          fromBool(c.isAutoIncrement),
          fromBool(!!c.isUnique),
          fromBool(!!c.isIndexed),
          c.defaultValue ?? null,
          c.comment ?? null,
          c.javaField,
          c.javaType,
          null, // 预留列，保持占位符数量与列清单一致
        ])
        await db.execute(
          `INSERT INTO cached_columns
             (table_id, ordinal, column_name, column_type, nullable, is_primary_key,
              is_auto_increment, is_unique, is_indexed, default_value, column_comment, java_field, java_type, id)
           VALUES ${placeholders(table.columns.length, COLS)}`,
          values,
        )
      }
    }

    await this.touch()
  }

  async deleteTable(name: string): Promise<void> {
    const db = this.conn()
    // cached_columns 有 ON DELETE CASCADE，但 SQLite 默认不开外键约束，
    // 所以显式删子表，不依赖 pragma foreign_keys
    const idRows = await db.select<Array<{ id: number }>>(
      'SELECT id FROM cached_tables WHERE table_name = $1',
      [name],
    )
    const tableId = idRows[0]?.id
    if (tableId !== undefined) {
      await db.execute('DELETE FROM cached_columns WHERE table_id = $1', [tableId])
    }
    await db.execute('DELETE FROM cached_tables WHERE table_name = $1', [name])
    await db.execute(
      'DELETE FROM cached_foreign_keys WHERE from_table = $1 OR to_table = $1',
      [name],
    )
    await this.touch()
  }

  async listForeignKeys(): Promise<ForeignKey[]> {
    const rows = await this.conn().select<FkRow[]>('SELECT * FROM cached_foreign_keys')
    return rows.map((row) => ({
      fromTable: row.from_table,
      fromColumn: row.from_column,
      toTable: row.to_table,
      toColumn: row.to_column,
      constraintName: row.constraint_name ?? undefined,
      confidence: row.confidence === 'naming' ? 'naming' : 'constraint',
    }))
  }

  async upsertForeignKeys(fks: ForeignKey[]): Promise<void> {
    if (!fks.length) return
    const db = this.conn()
    const COLS = 6
    const values = fks.flatMap((fk) => [
      fk.fromTable,
      fk.fromColumn,
      fk.toTable,
      fk.toColumn,
      fk.constraintName ?? null,
      fk.confidence,
    ])
    await db.execute(
      `INSERT INTO cached_foreign_keys
         (from_table, from_column, to_table, to_column, constraint_name, confidence)
       VALUES ${placeholders(fks.length, COLS)}
       ON CONFLICT(from_table, from_column, to_table, to_column) DO UPDATE SET
         constraint_name = excluded.constraint_name,
         confidence      = excluded.confidence`,
      values,
    )
    await this.touch()
  }

  async clear(): Promise<void> {
    const db = this.conn()
    await db.execute('DELETE FROM cached_columns')
    await db.execute('DELETE FROM cached_tables')
    await db.execute('DELETE FROM cached_foreign_keys')
    // 模板、配置管理草稿、我的SQL库收藏、连接历史都留着：它们是用户自己编的内容，
    // 不是从数据源缓存来的。「清空缓存」的语义是丢掉可重新导入的东西，这些重新导不回来。
    // 优化记录、JSON 查看历史同理：都是一次次攒出来的，清了不会自己长回来。
    // apiforge.* 同理：环境配置、关联表修正是用户手攒的；扫描缓存指纹变了会自己刷新。
    // 常用信息更是：清掉了密码还在凭据库里、条目却没了。
    await db.execute(
      "DELETE FROM cache_metadata WHERE key <> $1 AND key <> $2 AND key <> $3 AND key <> $4 AND key <> $5 AND key <> $6 AND key <> $7 AND key <> $8 AND key NOT LIKE 'apiforge.%'",
      [TEMPLATES_KEY, CONFIG_DRAFTS_KEY, FAVORITES_KEY, DBCONNS_KEY, ADVICE_LOG_KEY, JSON_HISTORY_KEY, REDIS_CONNS_KEY, VAULT_KEY],
    )
  }

  async status(): Promise<CacheStatus> {
    const db = this.conn()
    const [counts, lastUpdate, size] = await Promise.all([
      db.select<Array<{ data_source: string; n: number }>>(
        'SELECT data_source, COUNT(*) AS n FROM cached_tables GROUP BY data_source',
      ),
      this.getMeta(META_LAST_UPDATE),
      this.dbSizeBytes(),
    ])

    const bySource: Partial<Record<DataSource, number>> = {}
    let tableCount = 0
    for (const row of counts) {
      bySource[row.data_source as DataSource] = row.n
      tableCount += row.n
    }

    return { tableCount, lastUpdate, bySource, sizeBytes: size }
  }

  async getRecent(): Promise<string[]> {
    const raw = await this.getMeta(META_RECENT)
    if (!raw) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }

  async pushRecent(tableName: string): Promise<void> {
    const recent = await this.getRecent()
    const next = [tableName, ...recent.filter((n) => n !== tableName)].slice(0, RECENT_LIMIT)
    await this.setMeta(META_RECENT, JSON.stringify(next))
  }

  async removeRecent(tableName: string): Promise<void> {
    const next = (await this.getRecent()).filter((n) => n !== tableName)
    await this.setMeta(META_RECENT, JSON.stringify(next))
  }

  async listTemplates(): Promise<SqlTemplate[]> {
    return parseTemplates(await this.getMeta(TEMPLATES_KEY))
  }

  async saveTemplate(template: SqlTemplate): Promise<void> {
    const next = upsertTemplate(await this.listTemplates(), template)
    await this.setMeta(TEMPLATES_KEY, JSON.stringify(next))
  }

  async deleteTemplate(id: string): Promise<void> {
    const next = (await this.listTemplates()).filter((t) => t.id !== id)
    await this.setMeta(TEMPLATES_KEY, JSON.stringify(next))
  }

  async getConfigDrafts(): Promise<Record<string, string>> {
    return parseConfigDrafts(await this.getMeta(CONFIG_DRAFTS_KEY))
  }

  async saveConfigDraft(key: string, content: string): Promise<void> {
    const current = parseConfigDrafts(await this.getMeta(CONFIG_DRAFTS_KEY))
    await this.setMeta(CONFIG_DRAFTS_KEY, JSON.stringify(upsertConfigDraft(current, key, content)))
  }

  async listFavorites(): Promise<FavoriteSql[]> {
    return parseFavorites(await this.getMeta(FAVORITES_KEY))
  }

  async saveFavorites(items: FavoriteSql[]): Promise<void> {
    await this.setMeta(FAVORITES_KEY, JSON.stringify(items))
  }

  async listDbConns(): Promise<DbConn[]> {
    return parseDbConns(await this.getMeta(DBCONNS_KEY))
  }

  async saveDbConns(conns: DbConn[]): Promise<void> {
    await this.setMeta(DBCONNS_KEY, JSON.stringify(conns))
  }

  /* APIForge 元数据 blob：直接复用 getMeta/setMeta，key 约定见 types.ts */
  async getMetaBlob(key: string): Promise<string | null> {
    return this.getMeta(key)
  }

  async saveMetaBlob(key: string, value: string): Promise<void> {
    await this.setMeta(key, value)
  }

  async deleteMetaBlob(key: string): Promise<void> {
    await this.conn().execute('DELETE FROM cache_metadata WHERE key = $1', [key])
  }

  private async getMeta(key: string): Promise<string | null> {
    const rows = await this.conn().select<Array<{ value: string | null }>>(
      'SELECT value FROM cache_metadata WHERE key = $1',
      [key],
    )
    return rows[0]?.value ?? null
  }

  private async setMeta(key: string, value: string): Promise<void> {
    await this.conn().execute(
      `INSERT INTO cache_metadata (key, value) VALUES ($1, $2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    )
  }

  private async touch(): Promise<void> {
    await this.setMeta(META_LAST_UPDATE, new Date().toISOString())
  }

  private async dbSizeBytes(): Promise<number> {
    try {
      const rows = await this.conn().select<Array<{ size: number }>>(
        'SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()',
      )
      return rows[0]?.size ?? 0
    } catch {
      // pragma 函数在某些 SQLite 编译选项下不可用，状态栏显示 0 不影响功能
      return 0
    }
  }
}
