/**
 * 扫描历史：首页「之前扫描过的工程」卡片的数据源。
 *
 * 缓存位 apiforge.history 只存摘要（根目录 + 各工程 Controller/接口计数），
 * 全量扫描结果仍只有 apiforge.workspace 一份 —— 历史卡片点下去要么打开
 * 当前缓存要么重扫，不背 N 份完整结果。
 */
import { initStore } from '../../../storage'
import { normalizeRoot } from './workspaceCache'
import type { WorkspaceScanResult } from '../types'

export const APF_HISTORY_KEY = 'apiforge.history'

/** 历史封顶：卡片网格两列摆 4 行正好，再多就得翻页了 */
export const HISTORY_MAX = 8

export interface ScanHistoryEntry {
  root: string
  scannedAt: string
  projects: { name: string; controllers: number; apis: number }[]
}

/** 扫描结果 → 历史摘要。mergeHistory 和首页「继续上次项目」弹窗共用 */
export function entryFromScan(ws: WorkspaceScanResult): ScanHistoryEntry {
  return {
    root: ws.root,
    scannedAt: ws.scannedAt,
    // 0 接口的工程不进历史卡片（与 normalizeScan 的空工程过滤同一口径）
    projects: ws.projects
      .map((p) => ({
        name: p.projectName,
        controllers: p.controllers.length,
        apis: p.controllers.reduce((n, c) => n + c.methods.length, 0),
      }))
      .filter((p) => p.apis > 0),
  }
}

/** 纯合并：同根目录去重（新扫的覆盖旧记录），最新在前，封顶 HISTORY_MAX */
export function mergeHistory(old: ScanHistoryEntry[], ws: WorkspaceScanResult): ScanHistoryEntry[] {
  return [entryFromScan(ws), ...old.filter((e) => e.root !== ws.root)].slice(0, HISTORY_MAX)
}

/** 卡片标题照原型 DEMO_TARGETS 的叫法：目录名 +（大目录 · 多工程）/（单工程）/（jar 包） */
export function historyCardName(entry: ScanHistoryEntry): string {
  const base = entry.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || entry.root
  if (/\.jar$/i.test(base)) return `${base}（jar 包）`
  return entry.projects.length > 1 ? `${base}（大目录 · 多工程）` : `${base}（单工程）`
}

function isEntry(v: unknown): v is ScanHistoryEntry {
  if (!v || typeof v !== 'object') return false
  const e = v as Partial<ScanHistoryEntry>
  return (
    typeof e.root === 'string' &&
    typeof e.scannedAt === 'string' &&
    Array.isArray(e.projects) &&
    e.projects.every((p) => p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string')
  )
}

/** 纯摘除：按根目录删一条历史（路径归一化后比对，尾斜杠/斜杠方向都认得） */
export function removeHistoryEntry(old: ScanHistoryEntry[], root: string): ScanHistoryEntry[] {
  const key = normalizeRoot(root)
  return old.filter((e) => normalizeRoot(e.root) !== key)
}

/** 删除一条历史并落盘（配合 deleteCachedWorkspace 用）。写失败只影响首页卡片 */
export async function removeScanHistory(root: string): Promise<ScanHistoryEntry[]> {
  const next = removeHistoryEntry(await loadScanHistory(), root)
  try {
    const store = await initStore()
    await store.saveMetaBlob(APF_HISTORY_KEY, JSON.stringify(next))
  } catch {
    // 同 recordScan：写失败不阻断，本次会话内存里已经是删过的
  }
  return next
}

export async function loadScanHistory(): Promise<ScanHistoryEntry[]> {
  try {
    const store = await initStore()
    const raw = await store.getMetaBlob(APF_HISTORY_KEY)
    if (!raw) return []
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter(isEntry) : []
  } catch {
    return []
  }
}

/** 扫描成功后记一笔。存不进去就只活在本次会话，不阻断扫描 */
export async function recordScan(ws: WorkspaceScanResult): Promise<ScanHistoryEntry[]> {
  const next = mergeHistory(await loadScanHistory(), ws)
  try {
    const store = await initStore()
    await store.saveMetaBlob(APF_HISTORY_KEY, JSON.stringify(next))
  } catch {
    // 历史写失败只影响首页卡片，扫描结果本身另有缓存位
  }
  return next
}
