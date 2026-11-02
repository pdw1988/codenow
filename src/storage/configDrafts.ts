/**
 * 配置管理草稿 blob 的读写逻辑，两种持久化实现共用（分工同 templates.ts）。
 *
 * PRD 5.6/7.3 要求配置内容进缓存、按（文件名 × 环境）区分。这里用**一个
 * JSON blob** 承载（SQLite 放 cache_metadata 的 configDrafts 键，浏览器放
 * 独立的 localStorage 键），blob 内部按 `${fileName}|${env}` 键控——PRD 想预留的
 * 两个维度都被键占住了，等真有多环境大文件的查询需求再建 config_cache 表。
 * 这是继唯一键、FTS5 之后第三处对 PRD 的刻意偏差，PROGRESS.md 有记录。
 */

export const CONFIG_DRAFTS_KEY = 'configDrafts'

/** 草稿组合（文件名 × 环境）的上限。超过裁掉插入序最旧的：没有时间戳可比， */
/** Map/Object 字符串键保插入序这一点够用 */
export const CONFIG_DRAFT_LIMIT = 50

/** 逐条校验，坏的跳过而不是整批丢弃；blob 损坏返回空——草稿不能挡着应用起来 */
export function parseConfigDrafts(raw: string | null): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
      if (typeof v === 'string') out[k] = v
    return out
  } catch {
    return {}
  }
}

/** upsert 一条草稿并裁到上限。返回新对象，不改入参 */
export function upsertConfigDraft(
  drafts: Record<string, string>,
  key: string,
  content: string,
): Record<string, string> {
  const next = { ...drafts, [key]: content }
  const keys = Object.keys(next)
  if (keys.length > CONFIG_DRAFT_LIMIT) delete next[keys[0]]
  return next
}
