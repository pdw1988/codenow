/**
 * 收藏 blob 的读写逻辑，两种存储实现共用。
 *
 * 分工同 storage/templates.ts：MemoryStore 和 SqliteStore 只有「一个字符串
 * 存哪」不同（localStorage vs cache_metadata），解析、校验这些规则不抄两遍。
 */
import {
  FAVORITE_LIMIT,
  isFavoriteSql,
  sanitizeFavoriteConn,
  type FavoriteSql,
} from '../types/favorite'

/** SQLite cache_metadata 里的键；localStorage 实现另有自己的键（memoryStore 里） */
export const FAVORITES_KEY = 'favoriteSql'

/**
 * 逐条校验，坏的跳过而不是整批丢弃。保持存储顺序——列表展示顺序由 UI
 * 按 lastUsedAt/use_count 排出来，blob 里是什么序无所谓。
 */
export function parseFavorites(raw: string | null): FavoriteSql[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // conn 是后加的可选字段，洗而不丢：它坏了只抹掉 conn，不搭掉整条收藏
    return parsed.filter(isFavoriteSql).map(sanitizeFavoriteConn)
  } catch {
    // blob 损坏按空库处理：收藏是便利功能，不能因为它打不开整个应用
    return []
  }
}

/** 按 id upsert，并裁到上限。返回新数组，不改入参 */
export function upsertFavorite(list: FavoriteSql[], item: FavoriteSql): FavoriteSql[] {
  const rest = list.filter((f) => f.id !== item.id)
  return [item, ...rest].slice(0, FAVORITE_LIMIT)
}
