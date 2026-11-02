/**
 * 模板 blob 的读写逻辑，两种存储实现共用。
 *
 * MemoryStore 和 SqliteStore 只有「一个字符串存哪」不同（localStorage vs
 * cache_metadata），解析、排序、上限裁剪这些规则不该抄两遍。
 */
import { isSqlTemplate, TEMPLATE_LIMIT, type SqlTemplate } from '../types/template'

export const TEMPLATES_KEY = 'templates'

/** 逐条校验，坏的跳过而不是整批丢弃；按更新时间倒序，最近改的排前面 */
export function parseTemplates(raw: string | null): SqlTemplate[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(isSqlTemplate)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch {
    // blob 损坏时返回空列表：模板是便利功能，不能因为它打不开整个应用
    return []
  }
}

/** 按 id upsert，并裁到上限。返回新数组，不改入参 */
export function upsertTemplate(list: SqlTemplate[], template: SqlTemplate): SqlTemplate[] {
  const rest = list.filter((t) => t.id !== template.id)
  return [template, ...rest].slice(0, TEMPLATE_LIMIT)
}
