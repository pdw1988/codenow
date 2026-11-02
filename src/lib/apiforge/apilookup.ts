/**
 * 连库查询 → 接口库的反向查找：这张表是哪些接口在用。
 *
 * 口径与「关联表」页同一条链路（resolveLinks：Mapper 语句 + 用户手改的 links），
 * 不发明第二套识别——那页能看到的关联，这里就能匹配到；**不含**命名推断
 * （低可信默认关闭，拿它匹配会把没真正用到这张表的接口也捞进来）。
 * 匹配按小写比，schema 前缀（schema.table）剥掉再比：连接里的表名常带前缀，
 * mapper 语句里从不带。
 */
import type { TableRelation, WorkspaceScanResult } from './types'
import { mergeLinks, resolveLinks } from './link/resolveLinks'

export interface ApiHit {
  apiId: string
  path: string
  httpMethod: string
  controllerClass: string
  project: string
  /** 命中的关联表里有没有「启用」的——启用的开箱就能做库变更对比，排前面 */
  enabled: boolean
}

/** schema.t → t；本来就没前缀的原样返回 */
const bareName = (t: string): string => t.toLowerCase().trim().split('.').pop() ?? ''

export function apisForTables(args: {
  scan: WorkspaceScanResult
  links: Record<string, TableRelation[]>
  tables: string[]
}): ApiHit[] {
  const want = new Set(args.tables.map(bareName).filter(Boolean))
  if (want.size === 0) return []
  const hits: ApiHit[] = []
  for (const p of args.scan.projects) {
    for (const c of p.controllers) {
      for (const api of c.methods) {
        const merged = mergeLinks(resolveLinks(api, p, false), args.links[api.id] ?? [])
        let hit = false
        let enabled = false
        for (const l of merged) {
          if (want.has(bareName(l.tableName))) {
            hit = true
            if (l.enabled) enabled = true
          }
        }
        if (hit) {
          hits.push({
            apiId: api.id,
            path: api.path,
            httpMethod: api.httpMethod,
            controllerClass: c.className,
            project: p.projectName,
            enabled,
          })
        }
      }
    }
  }
  return hits.sort((a, b) => Number(b.enabled) - Number(a.enabled))
}
