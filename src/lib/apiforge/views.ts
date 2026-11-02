import type { EnvironmentConfig } from './types'

/** 码上测的子页面。'home' 是旧名，现在和「扫描」是同一页 */
export type ApfView = 'home' | 'scan' | 'apis' | 'tables' | 'scenario' | 'data' | 'pages' | 'report' | 'env' | 'bench'

/** 「显示高级功能」关着时藏起来的页 */
export const ADVANCED_VIEWS: readonly ApfView[] = ['tables', 'scenario', 'data', 'bench']

/** 顶栏直接露出的主线页；其余进「更多」 */
export const MAIN_VIEWS: readonly ApfView[] = ['scan', 'apis', 'pages', 'report', 'env']

export const isAdvancedView = (v: ApfView): boolean => ADVANCED_VIEWS.includes(v)

/** 暂时整页藏起来的（用户 2026-10-20：已有功能跑细了再放出来），开了高级也不显示，存过的数据不删 */
export const SHELVED_VIEWS: readonly ApfView[] = ['tables', 'scenario', 'data', 'bench']

/** 给流水线用的 JUnit / JSON 导出（接口页、报告页、页面测试）和报告页「学习期望」同样暂时藏起 */
export const CI_EXPORTS_SHOWN: boolean = false

/** 断言严格度暂时藏起：藏着时一律按观察跑，省得以前选的「严格」看不见还在生效 */
export const ASSERT_MODE_SHOWN: boolean = false

/** 执行顺序编排暂时藏起：藏着时一律按默认顺序跑 */
export const METHOD_ORDER_SHOWN: boolean = false

/** 认证只留粘 Token（用户 2026-10-20）：登录接口藏着时不自动登录，省得以前填的看不见还在登 */
export const LOGIN_API_SHOWN: boolean = false

/** 「显示高级功能」开关暂时去掉：高级里只剩只跑查询和清空对比记录，直接常显（开关当永远开着） */
export const ADVANCED_TOGGLE_SHOWN: boolean = false

/** 扫出来的东西里有没有接口 / 页面。还没扫描两样都算有（页签全显示） */
export interface ScanKinds {
  apis: boolean
  pages: boolean
}

export function scanKinds(
  scan: { projects: readonly { controllers: readonly { methods: readonly unknown[] }[]; pages?: readonly unknown[] }[] } | null,
): ScanKinds {
  if (!scan) return { apis: true, pages: true }
  return {
    apis: scan.projects.some((p) => p.controllers.some((c) => c.methods.length > 0)),
    pages: scan.projects.some((p) => (p.pages ?? []).length > 0),
  }
}

/**
 * 只扫了一个 Vue 工程、没有接口时返回它的 projectId。这时默认 Base URL 不会是接口地址，
 * Vue 没单独填地址就用它，环境页跟 FTL 工程一样只露 Base URL + 工号。
 */
export function soloVueId(
  scan: {
    projects: readonly {
      projectId: string
      vue?: unknown
      controllers: readonly { methods: readonly unknown[] }[]
      pages?: readonly unknown[]
    }[]
  } | null,
): string | null {
  if (!scan || scan.projects.length !== 1) return null
  const p = scan.projects[0]!
  return p.vue && !scanKinds(scan).apis ? p.projectId : null
}

/** 只对接口有用的页：纯页面工程（前端 Vue）不显示 */
const API_VIEWS: readonly ApfView[] = ['apis', 'report', 'tables', 'scenario', 'data', 'bench']

export const viewShown = (v: ApfView, k: ScanKinds): boolean =>
  SHELVED_VIEWS.includes(v) ? false : API_VIEWS.includes(v) ? k.apis : v === 'pages' ? k.pages : true

/**
 * 实际落到哪一页：旧名 home 归到扫描；高级页在开关关着时回落到接口页，
 * 还没扫描就回落到扫描页；工程里没有的（纯页面没接口、纯接口没页面）换到有的那边。
 */
export function resolveView(v: ApfView, o: { advanced: boolean; hasScan: boolean; kinds?: ScanKinds }): ApfView {
  if (v === 'home') return 'scan'
  const r = (!o.advanced && isAdvancedView(v)) || SHELVED_VIEWS.includes(v) ? (o.hasScan ? 'apis' : 'scan') : v
  if (!o.kinds || viewShown(r, o.kinds)) return r
  return o.kinds.apis ? 'apis' : o.kinds.pages ? 'pages' : 'scan'
}

/**
 * 跑用例实际用的环境：断言严格度、执行顺序、只跑查询只在高级功能里能改，
 * 关着时按默认（观察、默认顺序、全跑）跑，免得看不见的旧设置还在生效。
 * 只跑查询开着时数据准备一并关掉（造数要写库）。
 */
export function runEnvOf(env: EnvironmentConfig, advanced: boolean): EnvironmentConfig {
  let e = LOGIN_API_SHOWN ? env : { ...env, loginApi: '' }
  if (!advanced) return { ...e, assertMode: 'observe', methodOrder: undefined, readOnlyRun: undefined }
  if (!ASSERT_MODE_SHOWN) e = { ...e, assertMode: 'observe' }
  if (!METHOD_ORDER_SHOWN) e = { ...e, methodOrder: undefined }
  return e.readOnlyRun ? { ...e, autoPrepare: false } : e
}
