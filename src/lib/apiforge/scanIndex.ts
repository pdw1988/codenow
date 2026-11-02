import type { WorkspaceScanResult } from './types'

/** apiId → projectId。按 scan 对象缓存，重扫换了对象才重建；
 *  用例写盘时不用再每条用例遍历全部工程、Controller、接口 */
const cache = new WeakMap<WorkspaceScanResult, Map<string, string>>()

export function apiProjectIndex(scan: WorkspaceScanResult): Map<string, string> {
  let m = cache.get(scan)
  if (!m) {
    m = new Map()
    for (const p of scan.projects) for (const c of p.controllers) for (const api of c.methods) m.set(api.id, p.projectId)
    cache.set(scan, m)
  }
  return m
}

export function projectIdOfApi(scan: WorkspaceScanResult | null | undefined, apiId: string): string | undefined {
  return scan ? apiProjectIndex(scan).get(apiId) : undefined
}
