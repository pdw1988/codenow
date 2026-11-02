/**
 * 我的SQL库的收藏条目，PRD v6.3 §6.8 favorite_sql 表。
 *
 * 存的是 SQL 本身而不是生成器配置——§4.13 模板存配置、这里存成品，两回事：
 * 收藏的多是能直接跑的查询/改数脚本，换台机器粘出来照样能用。
 *
 * 规格里的落库形态是 SQLite 真表（table_names/tags 落库时 join(',') 成 TEXT）。
 * 本项目沿用模板的 blob 先例整体存 JSON（cache_metadata 一行，见 storage/favorites.ts），
 * 所以这两个字段保持数组、不做 join；id 也用字符串（同 SqlTemplate），导入合并时
 * 一律重新分配本地 id——跨机器的 id 本来就不保证一致（拍板③不按 id 覆盖）。
 *
 * 时间统一 'YYYY-MM-DD HH:MM' 字符串：字典序即时间序，排序不用解析日期。
 */
import { isDbKind, type DbKind } from './dbconn'

/**
 * 收藏时用的哪个库。只存定位信息，**密码永不存**——`DbConn` 本身也故意没有
 * password 字段（见 types/dbconn.ts）。跑的时候拿这几个字段去「我的连接」里按 addrKey
 * 找回完整记录（带 id/name/env），找不回就降级成「只灌 SQL、用当前连接」。
 */
export interface FavoriteConn {
  kind: DbKind
  host: string
  port: string
  user: string
  db: string
}

export function isFavoriteConn(value: unknown): value is FavoriteConn {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Record<string, unknown>
  return (
    isDbKind(c.kind) &&
    typeof c.host === 'string' &&
    typeof c.port === 'string' &&
    typeof c.user === 'string' &&
    typeof c.db === 'string'
  )
}

/** 收藏条目本体。字段口径见文件头那段说明。 */
export interface FavoriteSql {
  id: string
  /** §6.4 带 * 必填 */
  name: string
  /** §6.4 带 * 必填；MyBatis XML 片段也能收 */
  sql: string
  /** §6.7 从 SQL 自动识别 FROM/JOIN/UPDATE/INTO 得到，识别结果永远可手改（拍板②） */
  tables: string[]
  tags: string[]
  remark: string
  createdAt: string
  lastUsedAt: string
  /** 复制成功即 +1——「3 秒复用」验收线的量化，也是「最常用」排序的数据源（拍板①做排序入口） */
  useCount: number
  /**
   * 收藏时跑在哪个库（连库查询页收藏时带上）。SQL 离了原库往往跑不通（表名、方言都不同），
   * 存了详情里才能一点回到当时现场。
   *
   * **必须可选**：`isFavoriteSql` 是严格校验、坏条目整条丢，这个字段是后加的——
   * 写成必填会让用户既有的收藏全部校验不过、被静默清空。
   */
  conn?: FavoriteConn
}

/** 收藏条数上限。理由同 TEMPLATE_LIMIT：超过就该做文件夹分组了，那是另一个功能。
 *  收藏比模板更接近「片段库」，给得宽一些。 */
export const FAVORITE_LIMIT = 300

/**
 * 校验从 blob 里读出来的条目。blob 是本应用自己写的、格式自洽，所以可以严格：
 * 核心字段不合格整条丢掉——宁少一条，不让整个列表崩。
 * 外部来的 JSON 不走这里，importFavorites 有自己的宽容解析。
 */
export function isFavoriteSql(value: unknown): value is FavoriteSql {
  if (typeof value !== 'object' || value === null) return false
  const f = value as Record<string, unknown>
  return (
    typeof f.id === 'string' &&
    f.id !== '' &&
    typeof f.name === 'string' &&
    f.name.trim() !== '' &&
    typeof f.sql === 'string' &&
    f.sql.trim() !== '' &&
    Array.isArray(f.tables) &&
    f.tables.every((x) => typeof x === 'string') &&
    Array.isArray(f.tags) &&
    f.tags.every((x) => typeof x === 'string') &&
    typeof f.remark === 'string' &&
    typeof f.createdAt === 'string' &&
    typeof f.lastUsedAt === 'string' &&
    typeof f.useCount === 'number' &&
    Number.isFinite(f.useCount)
  )
}

/**
 * 洗而不丢：conn 是后加的可选辅助字段，它格式不对不配搭掉用户手写的 SQL。
 * 所以 `isFavoriteSql` 不校 conn，由这里把不合格的 conn 抹掉、整条保住。
 */
export function sanitizeFavoriteConn(item: FavoriteSql): FavoriteSql {
  if (item.conn === undefined || isFavoriteConn(item.conn)) return item
  const { conn: _drop, ...rest } = item
  return rest
}
