/**
 * 扫描结果缓存的分键 + LRU（纯函数，落盘在 scanIpc.ts）。
 *
 * 为什么要分键：全量结果原来固定存在 `apiforge.workspace` 一个键里，每次扫描
 * 整份覆盖。于是扫了 A 再扫 B，A 的接口清单就没了——首页历史卡片点 A 只能重扫
 * （`apiforge.history` 只存摘要）。改成 `apiforge.workspace.<hash>` 一个目录一份，
 * 常用的几个工程就能来回秒开。
 *
 * 为什么要 LRU：一份不小。一个一百多接口的工程约 300 KB，
 * 约 1.8 KB/接口；把整个大目录扫（三四千接口）一份约 6 MB。
 * 不设上限的话扫得多了 cache.db 会无声变肥，所以只留最近用过的几份。
 *
 * 本文件不碰 store：所有决定（算 key、提到队首、该删哪几份）都是纯函数，
 * 删除动作交给调用方执行。这样 node:test 能直接盯住淘汰边界。
 */
import { fingerprintOf } from './normalize'

/** 老键（不带 hash）。迁移完就不再写，只读一次 */
export const APF_WORKSPACE_LEGACY_KEY = 'apiforge.workspace'

/** LRU 索引的键。hash 固定 8 位十六进制，不会跟 `.index` 撞 */
export const APF_WORKSPACE_INDEX_KEY = 'apiforge.workspace.index'

/** 最多留几份全量结果。单工程口径下 3 份不到 5 MB，最狠的大目录口径 3 份约 19 MB */
export const WORKSPACE_CACHE_MAX = 3

/**
 * 所有份加起来的字节上限。份数封顶之外再卡一道总量：万一以后有人扫一个
 * 比 shop 还大的目录，不能把库无声撑到几百 MB。
 */
export const WORKSPACE_CACHE_MAX_BYTES = 20 * 1024 * 1024

/** 索引一条：哪个目录、存在哪个键里、多大 */
export interface WorkspaceCacheEntry {
  /** 原始根目录（原样存，给 UI 显示和比对用） */
  root: string
  /** 归一化后的 hash，拼出存储键 */
  hash: string
  /** 那份 JSON 的 UTF-8 字节数，按总量淘汰时要用 */
  bytes: number
}

/**
 * 路径归一化：反斜杠→正斜杠、去尾斜杠、转小写。
 *
 * Windows 路径大小写不敏感，而扫描器回的 root 跟用户在输入框里敲的可能差一个
 * 尾斜杠或斜杠方向——不归一化的话 `D:\work\a` 和 `D:/work/a/` 会各存一份，
 * 白白占两个 LRU 位。
 */
export function normalizeRoot(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 根目录 → 8 位 hash。不直接用路径当键：带冒号反斜杠、长度不定，拼出来的键很脏 */
export function rootHash(root: string): string {
  return fingerprintOf(normalizeRoot(root))
}

/** 这个根目录的全量结果存在哪个键 */
export function workspaceKey(root: string): string {
  return `${APF_WORKSPACE_LEGACY_KEY}.${rootHash(root)}`
}

/** hash → 存储键（淘汰时只有 hash，手上没 root） */
export function workspaceKeyOfHash(hash: string): string {
  return `${APF_WORKSPACE_LEGACY_KEY}.${hash}`
}

/** UTF-8 字节数。TextEncoder 在浏览器 / Tauri / Node 都有，不在时退回字符数 */
export function utf8Bytes(s: string): number {
  try {
    return new TextEncoder().encode(s).length
  } catch {
    return s.length
  }
}

/** 宽容解析索引：没有 / 坏 JSON / 不是数组 / 条目残缺都当空，不报错 */
export function parseCacheIndex(raw: string | null): WorkspaceCacheEntry[] {
  if (!raw) return []
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(v)) return []
  const out: WorkspaceCacheEntry[] = []
  for (const x of v) {
    if (!x || typeof x !== 'object') continue
    const e = x as Partial<WorkspaceCacheEntry>
    if (typeof e.root !== 'string' || !e.root) continue
    if (typeof e.hash !== 'string' || !e.hash) continue
    out.push({ root: e.root, hash: e.hash, bytes: typeof e.bytes === 'number' ? e.bytes : 0 })
  }
  return out
}

/**
 * 把一份提到队首（最近用过）。同 hash 的老条目丢掉，不留重复。
 *
 * 「用过」包括扫描完写入和从缓存打开——所以你天天开的那个工程永远不会被挤掉，
 * 偶尔扫一次的先出局。
 */
export function touchCacheIndex(
  index: readonly WorkspaceCacheEntry[],
  entry: WorkspaceCacheEntry,
): WorkspaceCacheEntry[] {
  return [entry, ...index.filter((e) => e.hash !== entry.hash)]
}

/** 按根目录摘掉一份缓存条目（「删除扫描工程」用）。路径归一化后比对，尾斜杠/斜杠方向都认得 */
export function removeCacheEntry(
  index: readonly WorkspaceCacheEntry[],
  root: string,
): WorkspaceCacheEntry[] {
  const key = normalizeRoot(root)
  return index.filter((e) => normalizeRoot(e.root) !== key)
}

/**
 * 按份数 + 总字节双上限淘汰。`kept` 写回索引，`dropped` 的 blob 由调用方删。
 *
 * 队首那一份永远保住，就算它单独超了总量上限：它是刚写进去 / 刚打开的那份，
 * 删了等于扫完立马失效，下一次点卡片又要重扫——那正是这整个改动要治的毛病。
 */
export function evictCacheIndex(
  index: readonly WorkspaceCacheEntry[],
  opts: { maxEntries?: number; maxBytes?: number } = {},
): { kept: WorkspaceCacheEntry[]; dropped: WorkspaceCacheEntry[] } {
  const maxEntries = opts.maxEntries ?? WORKSPACE_CACHE_MAX
  const maxBytes = opts.maxBytes ?? WORKSPACE_CACHE_MAX_BYTES
  const kept: WorkspaceCacheEntry[] = []
  const dropped: WorkspaceCacheEntry[] = []
  let sum = 0
  for (const e of index) {
    const first = kept.length === 0
    const overCount = kept.length >= maxEntries
    const overBytes = sum + e.bytes > maxBytes
    if (!first && (overCount || overBytes)) {
      dropped.push(e)
      continue
    }
    kept.push(e)
    sum += e.bytes
  }
  return { kept, dropped }
}

/** 索引里这个根目录的条目（归一化后比） */
export function findCacheEntry(
  index: readonly WorkspaceCacheEntry[],
  root: string,
): WorkspaceCacheEntry | null {
  const h = rootHash(root)
  return index.find((e) => e.hash === h) ?? null
}

/** 当下能秒开的根目录清单（队首在前）。首页卡片的「打开缓存 →」角标看它 */
export function cachedRootsOf(index: readonly WorkspaceCacheEntry[]): string[] {
  return index.map((e) => e.root)
}
