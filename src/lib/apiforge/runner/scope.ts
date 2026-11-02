/**
 * 回归范围过滤：只跑某个服务（工程）/ 某个 Controller 的接口。
 *
 * 全量回归是默认，但「改了 UserController 只想回归它」是高频动作——
 * 这里把范围收敛成一个纯函数：扫描结果进，过滤后的扫描结果出。
 * GUI 顶栏的范围选择器和回归入口共用 RunScope；CLI 的 yml scope
 * （ci/changed.ts 的 controllers/exclude 白黑名单）语义更全，两边不混用。
 */
import type { WorkspaceScanResult } from '../types'

export interface RunScope {
  /** 工程（服务）白名单，单选 projectId。空 = 不限 */
  projectId?: string
  /** Controller 类简名，单选。空 = 不限；跨工程重名时每个工程里的同名类都算 */
  controllerClass?: string
}

/** 「全部」的稳定引用：比较与持久化缺省都用它 */
export const ALL_SCOPE: RunScope = {}

export const isAllScope = (s: RunScope): boolean => !s.projectId && !s.controllerClass

/** 范围在这次扫描里还有接口：换目录重扫后上次圈的工程不在了，就该退回「全部」 */
export const scopeFits = (ws: WorkspaceScanResult, s: RunScope): boolean =>
  isAllScope(s) || applyRunScope(ws, s).projects.length > 0

/**
 * 按范围过滤扫描结果。空范围原样返回（不复制，调用方当只读值用）；
 * 过滤后工程里一个 Controller 都不剩的整工程剔除——跟 filterScanByScope 同一口径。
 */
export function applyRunScope(ws: WorkspaceScanResult, scope: RunScope): WorkspaceScanResult {
  if (isAllScope(scope)) return ws
  const projects = ws.projects
    .filter((p) => !scope.projectId || p.projectId === scope.projectId)
    .map((p) =>
      scope.controllerClass
        ? { ...p, controllers: p.controllers.filter((c) => c.className === scope.controllerClass) }
        : p,
    )
    .filter((p) => p.controllers.length > 0)
  return { ...ws, projects }
}

/**
 * 范围的人话：全部 / order-service / UserController / order-service · UserController。
 * id 在扫描里找不到（重扫后工程被删）就退回原始 id，别显示成空。
 */
export function scopeLabel(scan: WorkspaceScanResult | null, scope: RunScope): string {
  if (isAllScope(scope)) return '全部'
  const proj = scope.projectId
    ? (scan?.projects.find((p) => p.projectId === scope.projectId)?.projectName ?? scope.projectId)
    : null
  return [proj, scope.controllerClass].filter(Boolean).join(' · ')
}

/** 范围内还有几个接口：空范围不用数（全量），选择器徽标和空范围提醒用 */
export function scopedApiCount(ws: WorkspaceScanResult, scope: RunScope): number {
  if (isAllScope(scope)) {
    return ws.projects.reduce((n, p) => n + p.controllers.reduce((m, c) => m + c.methods.length, 0), 0)
  }
  return applyRunScope(ws, scope).projects.reduce(
    (n, p) => n + p.controllers.reduce((m, c) => m + c.methods.length, 0),
    0,
  )
}
