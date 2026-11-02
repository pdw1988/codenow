/**
 * 扫描的桌面 IPC + 结果缓存读取。
 *
 * 扫描走 Rust apiforge_scan（起 Java 进程）；进度行走 Rust 转发的
 * `apiforge-scan-log` 事件（Java stderr 的 PROG/ERR 行）。缓存读写走
 * MetaStore 的 apiforge.* blob（技术方案 §2.8）。浏览器模式 tauriInvoke
 * 直接中文拒绝，这里不另设开关。
 */
import { initStore } from '../../../storage'
import type { MetaStore } from '../../../storage/types'
import { tauriInvoke } from '../../tauriInvoke'
import { apiforgeLinksKey } from '../../../store/useApiforgeStore'
import { normalizeScanJson } from './normalize'
import {
  APF_WORKSPACE_INDEX_KEY,
  APF_WORKSPACE_LEGACY_KEY,
  cachedRootsOf,
  evictCacheIndex,
  findCacheEntry,
  parseCacheIndex,
  removeCacheEntry,
  rootHash,
  touchCacheIndex,
  utf8Bytes,
  workspaceKey,
  workspaceKeyOfHash,
  type WorkspaceCacheEntry,
} from './workspaceCache'
import { removeScanHistory, type ScanHistoryEntry } from './history'
import { mergeVueProjects, pageHooks } from './pageHooks'
import type { TableRelation, WorkspaceScanResult } from '../types'

/** 手动停止的报错标记：doScan 靠它把「停止」显示成提示而不是红色失败 */
export const SCAN_STOPPED_MSG = '已手动停止扫描'

/**
 * 监听扫描进度事件。不引 @tauri-apps/api/event（tauriInvoke.ts 同款理由：
 * Vite 预打包的 hash 一重优化就 404），直接走 internals 原语 —— 这三行就是
 * @tauri-apps/api/event 的 listen/unlisten 干的事。
 */
async function listenScanLog(onLog: (line: string) => void): Promise<() => void> {
  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: {
      transformCallback: (cb: (e: { payload: string }) => void) => number
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
    }
  }).__TAURI_INTERNALS__
  if (!internals) return () => {}
  const handler = internals.transformCallback((e) => onLog(e.payload))
  try {
    await internals.invoke('plugin:event|listen', {
      event: 'apiforge-scan-log',
      target: { kind: 'Any' },
      handler,
    })
  } catch {
    // 事件通道起不来只影响流水显示，扫描本身照跑
    return () => {}
  }
  return () => {
    void internals.invoke('plugin:event|unlisten', { eventId: handler }).catch(() => {})
  }
}

export async function scanWorkspace(
  root: string,
  onLog?: (line: string) => void,
): Promise<WorkspaceScanResult> {
  const unlisten = onLog ? await listenScanLog(onLog) : () => {}
  try {
    // Vue 工程扫描是页面测试的，开源版没有
    const vue = (await pageHooks()?.scanVue(root)) ?? []
    let text: string
    try {
      text = await tauriInvoke<string>('apiforge_scan', { root })
    } catch (e) {
      // 纯前端目录里 jar 找不到 Java 工程会报错：有 Vue 工程就照样出结果；手动停止照常抛
      if (!vue.length || String(e).includes(SCAN_STOPPED_MSG)) throw e
      onLog?.(`ERR Java 扫描没有结果：${String(e)}`)
      text = JSON.stringify({ root, projects: [] })
    }
    const ws = normalizeScanJson(mergeVueProjects(text, vue))
    if (!ws) {
      throw new Error('扫描器输出不是合法的扫描结果（JSON 解析失败）。请把控制台日志发给开发者。')
    }
    // 扫描成功就刷新缓存：下次打开秒回，指纹不一致由「重新扫描」覆盖
    try {
      const store = await initStore()
      await saveCachedWorkspace(store, ws)
      for (const p of ws.projects) {
        // 新工程的关联表缓存位先占住：读侧按需解析，写侧 setLinksFor 覆盖
        void store.getMetaBlob(apiforgeLinksKey(p.projectId))
      }
    } catch {
      // 缓存写失败不阻断：本次扫描结果已经在内存里
    }
    return ws
  } finally {
    unlisten()
  }
}

/** 停止当前扫描：Rust 侧按 PID 杀掉扫描器进程，正在 await 的 scanWorkspace 会以 SCAN_STOPPED_MSG 报错收场 */
export async function stopScan(): Promise<void> {
  await tauriInvoke('apiforge_scan_stop')
}

/* ================= 全量结果缓存：一个目录一份 + LRU =================
   算法（算 key / 提队首 / 该删哪几份）全在 workspaceCache.ts 的纯函数里，
   这里只负责落盘。 */

async function readIndex(store: MetaStore): Promise<WorkspaceCacheEntry[]> {
  return parseCacheIndex(await store.getMetaBlob(APF_WORKSPACE_INDEX_KEY))
}

/** 写回索引并把被淘汰的那几份 blob 真删掉 */
async function commitIndex(
  store: MetaStore,
  touched: readonly WorkspaceCacheEntry[],
): Promise<WorkspaceCacheEntry[]> {
  const { kept, dropped } = evictCacheIndex(touched)
  for (const d of dropped) await store.deleteMetaBlob(workspaceKeyOfHash(d.hash))
  await store.saveMetaBlob(APF_WORKSPACE_INDEX_KEY, JSON.stringify(kept))
  return kept
}

/**
 * 老键迁移：以前全量结果固定存在不带 hash 的 `apiforge.workspace`。
 * 首次读到就搬到分键位置、登记进索引，然后删掉老键——不搬的话用户现有那份
 * 缓存会凭空少一次（得重扫一遍才回来）。幂等：老键没了就直接返回现有索引。
 */
async function migrateLegacy(store: MetaStore): Promise<WorkspaceCacheEntry[]> {
  const index = await readIndex(store)
  let raw: string | null = null
  try {
    raw = await store.getMetaBlob(APF_WORKSPACE_LEGACY_KEY)
  } catch {
    return index
  }
  if (!raw) return index
  const ws = normalizeScanJson(raw)
  if (!ws) {
    // 老键里是坏数据：删掉，别每次读缓存都白试一次
    await store.deleteMetaBlob(APF_WORKSPACE_LEGACY_KEY)
    return index
  }
  await store.saveMetaBlob(workspaceKey(ws.root), raw)
  const kept = await commitIndex(
    store,
    touchCacheIndex(index, { root: ws.root, hash: rootHash(ws.root), bytes: utf8Bytes(raw) }),
  )
  await store.deleteMetaBlob(APF_WORKSPACE_LEGACY_KEY)
  return kept
}

/** 扫描成功后写一份，并把它提到 LRU 队首 */
async function saveCachedWorkspace(store: MetaStore, ws: WorkspaceScanResult): Promise<void> {
  // 先收拾老键：它跟本次是同一个根目录时，搬过去会盖掉刚写的新结果
  const index = await migrateLegacy(store)
  const json = JSON.stringify(ws)
  await store.saveMetaBlob(workspaceKey(ws.root), json)
  await commitIndex(
    store,
    touchCacheIndex(index, { root: ws.root, hash: rootHash(ws.root), bytes: utf8Bytes(json) }),
  )
}

/**
 * 读缓存里的全量结果。传 root 读那个目录的（首页历史卡片 / API Diff 的「上一次」），
 * 不传读最近用过的那一份（「继续上次项目」弹窗）。读到也算「用过」，会提到队首。
 */
export async function loadCachedWorkspace(root?: string): Promise<WorkspaceScanResult | null> {
  try {
    const store = await initStore()
    const index = await migrateLegacy(store)
    const entry = root ? findCacheEntry(index, root) : (index[0] ?? null)
    if (!entry) return null
    const raw = await store.getMetaBlob(workspaceKeyOfHash(entry.hash))
    // 索引有条目但 blob 没了（被手动清过等）：把这条从索引里拿下去，卡片就不会再说能秒开
    if (!raw) {
      await commitIndex(
        store,
        index.filter((x) => x.hash !== entry.hash),
      )
      return null
    }
    const ws = normalizeScanJson(raw)
    if (!ws) return null
    // 已经在队首且体积已知就不白写一次索引
    if (index[0]?.hash !== entry.hash || entry.bytes === 0) {
      await commitIndex(store, touchCacheIndex(index, { ...entry, bytes: entry.bytes || utf8Bytes(raw) }))
    }
    return ws
  } catch {
    return null
  }
}

/**
 * 当下能秒开的根目录清单（最近用过的在前）。首页卡片的「打开缓存 →」角标用它：
 * LRU 上限之外的卡片点下去要重扫，必须在点之前就写清楚。
 */
export async function cachedWorkspaceRoots(): Promise<string[]> {
  try {
    const store = await initStore()
    return cachedRootsOf(await migrateLegacy(store))
  } catch {
    return []
  }
}

/** 删除扫描工程的第一步：把这份全量结果从 LRU 摘掉并真删 blob。删不干净不阻断（历史摘掉后入口已经没了） */
export async function deleteCachedWorkspace(root: string): Promise<void> {
  try {
    const store = await initStore()
    const index = await migrateLegacy(store)
    const entry = findCacheEntry(index, root)
    if (entry) await store.deleteMetaBlob(workspaceKeyOfHash(entry.hash))
    await commitIndex(store, removeCacheEntry(index, root))
  } catch {
    // 缓存删不动就算了：历史还在的话卡片下次点会走「一键扫描」
  }
}

/**
 * 「删除扫描工程」整件事：摘 LRU 缓存 + 摘历史摘要，返回删完的历史列表。
 * **用例与关联表的用户修正保留**（按工程路径存，重扫同一工程会接回来）——
 * 删除的语义是「这条扫描记录不要了」，不是「连我的修正一起扔」。
 */
export async function deleteScannedWorkspace(root: string): Promise<ScanHistoryEntry[]> {
  await deleteCachedWorkspace(root)
  return removeScanHistory(root)
}

export async function loadLinksBlob(projectId: string): Promise<Record<string, TableRelation[]>> {
  try {
    const store = await initStore()
    const raw = await store.getMetaBlob(apiforgeLinksKey(projectId))
    if (!raw) return {}
    const v: unknown = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, TableRelation[]>) : {}
  } catch {
    return {}
  }
}
