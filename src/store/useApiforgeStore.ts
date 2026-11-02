/**
 * APIForge 的全局状态。只搬数据 + 持久化转发，不做计算（分层纪律）：
 * 关联表识别在 lib/apiforge/link，用例生成在 lib/apiforge/cases，
 * 这里只存「算完的结果」。
 *
 * 持久化走 MetaStore 的 apiforge.* blob（技术方案 §2.8）：
 * - workspace 扫描结果：重开应用秒回，指纹变了由扫描侧刷新；
 * - links / cases 按工程存：用户修正（勾选、禁用、改期望）重扫不丢，重启也载回来；
 * - env 不存 password —— 密码只活在内存，跟「我的连接」同一条铁律。
 */
import { create } from 'zustand'
import { initStore } from '../storage'
import { loadScanHistory, type ScanHistoryEntry } from '../lib/apiforge/scan/history'
import type { ApiDiffResult } from '../lib/apiforge/scan/apidiff'
import type {
  ApiAction,
  BenchConfig,
  BenchMetrics,
  BenchReport,
  CaseRunResult,
  DataDriven,
  DataDrivenRunResult,
  EnvironmentConfig,
  EnvProfile,
  PageRunReport,
  PageRunResult,
  PageWriteState,
  ResidueReport,
  Scenario,
  ScenarioOutlineRunResult,
  ScenarioRunResult,
  TableRelation,
  TestCase,
  WorkspaceScanResult,
  WriteLeftover,
  WriteSpec,
} from '../lib/apiforge/types'
import { withoutScreenshots } from '../lib/apiforge/page/report'
import * as writeSpec from '../lib/apiforge/page/write/writeSpec'
import * as pageHist from '../lib/apiforge/page/history'
import { DEFAULT_BENCH_CONFIG } from '../lib/apiforge/bench/defaults'
import { normalizeMethodOrder } from '../lib/apiforge/runner/order'
import { mergeResults } from '../lib/apiforge/runner/mergeResults'
import { ADVANCED_TOGGLE_SHOWN, resolveView, scanKinds, type ApfView } from '../lib/apiforge/views'
import { applyCaseEnabled } from '../lib/apiforge/runner/resultState'
import { ALL_SCOPE, scopeFits, type RunScope } from '../lib/apiforge/runner/scope'
import { refreshStaleBodies } from '../lib/apiforge/cases/generate'
import { applyActionOverrides } from '../lib/apiforge/cases/apiAction'
import { duplicateCase, markStale, patchCase, type CasePatch } from '../lib/apiforge/cases/caseEdit'
import { capScanLog } from '../lib/apiforge/scan/queue'
import { apiProjectIndex, projectIdOfApi } from '../lib/apiforge/scanIndex'
import { parseProfiles, upsertProfile } from '../lib/apiforge/envProfiles'
import {
  comparableEntry,
  diffRuns,
  parseHistory,
  upsertEntry,
  type ReportDiff,
  type ReportHistoryEntry,
} from '../lib/apiforge/reportHistory'

export const APF_ENV_KEY = 'apiforge.env'
/* 全量扫描结果的键不在这里：它按根目录分键（`apiforge.workspace.<hash>`），
   算法和老键全在 lib/apiforge/scan/workspaceCache.ts，只准有一份。 */
/** 纯 UI 偏好（左树宽度、回归范围）：跟 env 分开，丢了也不影响功能 */
export const APF_UI_KEY = 'apiforge.ui'
/** 压测配置（PRD v0.4 模块 4.8）：只有数字和 apiId，没有秘密 */
export const APF_BENCH_KEY = 'apiforge.bench'
/** 学来的库变更期望（PRD v0.6 模块 4.14）：表名 → +N/-N，随 apiforge.yml 导出 */
export const APF_EXPECTATIONS_KEY = 'apiforge.expectations'
/** 多步场景（接口改进 #1）：场景列表整体一份 blob，量小（几 KB 级）不分键 */
export const APF_SCENARIOS_KEY = 'apiforge.scenarios'
/** 数据驱动表（接口改进 #2）：同上，整表一份 blob（一张表几十行 = 几 KB 级） */
export const APF_DATADRIVEN_KEY = 'apiforge.datadriven'
/** 最近一次页面测试报告（不含截图）：重开应用还看得到哪些页挂了 */
export const APF_PAGERUN_KEY = 'apiforge.pagerun'
/** 页面测试写操作：白名单（确认过的草稿）+ 没收拾干净的数据，一份 blob */
export const APF_PAGEWRITE_KEY = 'apiforge.pagewrite'
/** 页面测试每条用例的上次结果 + 已知问题，一份 blob */
export const APF_PAGEHIST_KEY = 'apiforge.pagehist'
/** 接口「查/增/改/删」手改：apiId → 分类，一份 blob；重扫后套回去 */
export const APF_API_ACTIONS_KEY = 'apiforge.apiActions'
/** 手改分类的内存副本；null = 还没读过盘 */
let apiActions: Record<string, ApiAction> | null = null

async function loadApiActions(): Promise<Record<string, ApiAction>> {
  if (apiActions) return apiActions
  try {
    const store = await initStore()
    const raw = await store.getMetaBlob(APF_API_ACTIONS_KEY)
    const v: unknown = raw ? JSON.parse(raw) : {}
    const ok = new Set(['query', 'insert', 'update', 'delete', 'unknown'])
    apiActions = {}
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, a] of Object.entries(v)) if (typeof a === 'string' && ok.has(a)) apiActions[k] = a as ApiAction
    }
  } catch {
    apiActions = {}
  }
  return apiActions
}
/** 页面测试日志的刷新节流计时器 */
let logFlush: ReturnType<typeof setTimeout> | null = null
/** 环境组（接口改进 · 体验）：整套环境配置的命名快照，一份 blob（每份 = 完整 env） */
export const APF_ENV_PROFILES_KEY = 'apiforge.envProfiles'
/** 回归报告历史（复盘短板 ③）：每次回归收尾一条小摘要，「和上次比」的基准 */
export const APF_REPORT_HISTORY_KEY = 'apiforge.reportHistory'
export const apiforgeLinksKey = (projectId: string) => `apiforge.links.${projectId}`
export const apiforgeCasesKey = (projectId: string) => `apiforge.cases.${projectId}`

/** 数据驱动表整体一份 blob 写回（upsert / remove 共用一条口径） */
async function persistDataDriven(list: DataDriven[]): Promise<void> {
  try {
    const store = await initStore()
    await store.saveMetaBlob(APF_DATADRIVEN_KEY, JSON.stringify(list))
  } catch {
    // 记不住下次重建就是了，不打断
  }
}

async function persistPageHistory(v: pageHist.PageHistory): Promise<void> {
  try {
    const store = await initStore()
    await store.saveMetaBlob(APF_PAGEHIST_KEY, JSON.stringify(v))
  } catch {
    // 存不进去只是重开应用后标记丢了
  }
}

/** 写操作状态整份写回；leftover 要在点保存前落盘，调用方会 await */
async function persistPageWrite(v: PageWriteState): Promise<void> {
  try {
    const store = await initStore()
    await store.saveMetaBlob(APF_PAGEWRITE_KEY, JSON.stringify(v))
  } catch {
    // 存不进去只影响重开应用后的白名单和残留清单
  }
}

/** patchEnv 的防抖写盘计时器；关窗 / 刷新前立刻写掉没落盘的那次 */
let envPersistTimer: ReturnType<typeof setTimeout> | null = null
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (!envPersistTimer) return
    clearTimeout(envPersistTimer)
    envPersistTimer = null
    void useApiforgeStore.getState().persistEnv()
  })
}

/** 环境组整体一份 blob 写回（save / apply / remove 共用一条口径） */
async function persistEnvProfiles(list: EnvProfile[]): Promise<void> {
  try {
    const store = await initStore()
    await store.saveMetaBlob(APF_ENV_PROFILES_KEY, JSON.stringify(list))
  } catch {
    // 记不住下次重建就是了，不打断
  }
}

/** 报告历史整体一份 blob 写回（saveReportHistory 一条口径；parse 时坏条目已逐条丢） */
async function persistReportHistory(list: ReportHistoryEntry[]): Promise<void> {
  try {
    const store = await initStore()
    await store.saveMetaBlob(APF_REPORT_HISTORY_KEY, JSON.stringify(list))
  } catch {
    // 历史丢了不致命：大不了下次「和上次比」不出来
  }
}

/** 某工程的用例 blob 整体重写（setCasesFor / setScan 刷新老用例共用一份口径） */
async function persistProjectCases(get: () => ApiforgeState, projectId: string): Promise<void> {
  const scan = get().scan
  if (!scan) return
  const index = apiProjectIndex(scan)
  const all: Record<string, TestCase[]> = {}
  for (const [id, cs] of Object.entries(get().cases)) {
    if (index.get(id) === projectId) all[id] = cs
  }
  try {
    const store = await initStore()
    await store.saveMetaBlob(apiforgeCasesKey(projectId), JSON.stringify(all))
  } catch {
    /* 持久化失败下次重算，不打断 */
  }
}

/** 用例写盘防抖：参数框每敲一个字都会改用例，合并成 500ms 后一次；
 *  跑批里逐个补用例也就自然合成一次。发送读内存，不受影响 */
const pendingCaseProjects = new Set<string>()
let caseTimer: ReturnType<typeof setTimeout> | null = null
let caseGet: (() => ApiforgeState) | null = null

function scheduleCasesPersist(get: () => ApiforgeState, projectId: string): void {
  caseGet = get
  pendingCaseProjects.add(projectId)
  if (caseTimer) clearTimeout(caseTimer)
  caseTimer = setTimeout(() => void flushCasesNow(), 500)
}

async function flushCasesNow(): Promise<void> {
  if (caseTimer) clearTimeout(caseTimer)
  caseTimer = null
  const ids = [...pendingCaseProjects]
  pendingCaseProjects.clear()
  const get = caseGet
  if (!get) return
  await Promise.all(ids.map((id) => persistProjectCases(get, id)))
}

if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => void flushCasesNow())

/** 载过 blobs 的工程：setScan 每次都会路过（开机读缓存 + 每次重扫），别反复读盘 */
const blobsLoadedProjects = new Set<string>()

/** 工程的 links/cases 缓存 → 内存。store 已有的条目优先：现场生成的用例、用户刚改的
 *  勾选不能被缓存盖回去（点击和载入赛跑时，先到的算数）。读不到就当空，现场重算。 */
async function loadProjectBlobsInto(
  get: () => ApiforgeState,
  set: (partial: Partial<ApiforgeState>) => void,
  projectId: string,
): Promise<void> {
  try {
    const store = await initStore()
    const [linksRaw, casesRaw] = await Promise.all([
      store.getMetaBlob(apiforgeLinksKey(projectId)),
      store.getMetaBlob(apiforgeCasesKey(projectId)),
    ])
    const parse = <T,>(raw: string | null): Record<string, T> => {
      if (!raw) return {}
      try {
        const v: unknown = JSON.parse(raw)
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {}
      } catch {
        return {}
      }
    }
    set({
      links: { ...parse<TableRelation[]>(linksRaw), ...get().links },
      cases: { ...parse<TestCase[]>(casesRaw), ...get().cases },
    })
  } catch {
    /* 读不出来就现场重算 */
  }
}

export const DEFAULT_ENV: EnvironmentConfig = {
  baseUrl: 'http://localhost:8080',
  loginApi: '',
  username: '',
  password: undefined,
  tokenJsonPath: undefined,
  tokenHeader: 'Authorization',
  tokenPrefix: 'Bearer',
  timeoutMs: 10000,
  connId: '',
  assertMode: 'observe',
  // 数据准备默认自动（2026-09-19 拍板）：连库的目的就是数据验证，不该再让人找开关
  autoPrepare: true,
  prepV2: true,
  projectBaseUrls: {},
}

/** 环境配置落盘时剥掉密码。函数只此一份，所有保存路径都必须走它 */
export const envWithoutSecret = (env: EnvironmentConfig): EnvironmentConfig => {
  const { password: _password, pagePassword: _pagePassword, ...rest } = env
  return rest
}

/** 老缓存 / 脏数据 → 干净的 projectId→url 表 */
export function normalizeProjectBaseUrls(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || typeof v !== 'string') continue
    const t = v.trim()
    if (t) out[k] = t
  }
  return out
}

interface RunProgress {
  done: number
  total: number
  label: string
}

/**
 * 页内子页签（原型 的五个视图 + PRD v0.4 模块 4.8 的压测）。
 * 放 store 而不是组件 state：跑完回归要自动切到「报告」，
 * 扫描完要点「查看接口库」——跨组件跳转不能靠 props 钻。
 */
export type ApiforgeView = ApfView

/**
 * 跨页签跳报告的焦点信号（接口层 → 报告）：左树 FAIL 标记 / 调试卡 FAIL pill
 * 点了以后 setView('report') 带上它，报告页消费后定位到那条失败（开处理抽屉
 * 或按工程筛选）。ts 用于「消费过没」的判定，同一次跳转不会被重复应用。
 */
export interface ReportFocus {
  apiId?: string
  project?: string
  /** Controller 行红点跳过来：只看这个 Controller 下的接口 */
  controller?: { name: string; apiIds: string[] }
  ts: number
}

/**
 * 数据库侧 → 接口侧的焦点信号（连库查询「查接口 ↗」）：定位到用了这张表的接口。
 * 接口库页按 ts 消费一次（同 reportFocus 口径）：展开工程和 Controller、
 * 选中并滚到该接口。apiId 在扫描结果里找不到时（重扫后 id 变了）静默忽略。
 */
export interface ApisFocus {
  apiId: string
  ts: number
}

interface ApiforgeState {
  scan: WorkspaceScanResult | null
  scanning: boolean
  scanError: string | null
  /**
   * 扫描页输入框的路径。放 store 而不是 useScan 的局部 state：
   * HUD 和扫描页各调一次 useScan 会各得一份局部 root，首次使用时
   * 填了路径点顶栏「开始扫描」会误报「先填目录」（HUD 实例里是空串），
   * 扫过 A 后改填 B 点顶栏则会静默重扫旧的 A。
   */
  scanRoot: string
  setScanRoot: (s: string) => void

  /** 当前子页签 */
  view: ApiforgeView
  setView: (v: ApiforgeView) => void
  /** 接口层跳报告的焦点；报告页按 ts 消费一次，用完不清（重复渲染不会重复应用） */
  reportFocus: ReportFocus | null
  setReportFocus: (f: Omit<ReportFocus, 'ts'>) => void
  /** 连库查询跳接口库的焦点；接口库页按 ts 消费一次，口径同 reportFocus */
  apisFocus: ApisFocus | null
  setApisFocus: (f: Omit<ApisFocus, 'ts'>) => void

  env: EnvironmentConfig
  /** env 从存储读完了才允许覆盖保存，否则会把 DEFAULT_ENV 写回去 */
  envLoaded: boolean
  /** 登录拿到的 token。只活在内存（useDbPassStore 同哲学） */
  token: string | null
  tokenSource: string | null

  /** apiId → 关联表 / 用例。按工程持久化，重扫经 mergeLinks 保留勾选 */
  links: Record<string, TableRelation[]>
  cases: Record<string, TestCase[]>
  selectedApiId: string | null
  /** 「▶ 发送」正在飞的接口：切到别的接口时要知道是「上一个还在发」，不是本接口在跑 */
  sendingApiId: string | null
  setSendingApiId: (id: string | null) => void

  running: boolean
  /** 用户点了「停止」：跑批编排每步前看一眼 */
  stopRequested: boolean
  progress: RunProgress | null
  results: CaseRunResult[]
  /** 自动流程日志（原型「自动流程日志」卡）：登录/用例/跑批的人话步骤 */
  runLog: string[]
  /** 扫描实时流水（Java stderr PROG 行 → Rust 事件）。只活在内存 */
  scanLog: string[]
  /** 最近一次扫描 vs 上一次的接口差异（PRD v0.6 模块 4.13）。只活在内存 */
  apiDiff: ApiDiffResult | null
  setApiDiff: (d: ApiDiffResult | null) => void

  /** 最近一次回归收尾的测试残留检测（PRD v0.6 模块 4.16）。只活在内存，跑新一轮清空 */
  residue: ResidueReport | null
  setResidue: (r: ResidueReport | null) => void

  /** 学来的库变更期望（PRD v0.6 模块 4.14）：观察模式跑完一键采纳，随 yml 导出 */
  learnedExpectations: Record<string, string>
  setLearnedExpectations: (r: Record<string, string>) => void
  loadLearnedExpectations: () => Promise<void>

  /* ---- 场景编排（接口改进 #1）---- */
  /**
   * 多步场景（新建 → 查 → 改 → 删 这类链子）：列表持久化（apiforge.scenarios），
   * 步骤引用接口库的 apiId——重扫后接口没了的步骤跑时给可读原因，不静默丢。
   */
  scenarios: Scenario[]
  upsertScenario: (s: Scenario) => void
  removeScenario: (id: string) => void
  loadScenarios: () => Promise<void>
  /** 场景跑批状态：与回归 running 分开记，但两边互斥（都在发真实写请求） */
  scnRunning: boolean
  setScnRunning: (on: boolean) => void
  /** 最近一次场景跑批结果，只活在内存（每步跑完渐进更新） */
  scnResults: ScenarioRunResult | null
  setScnResults: (r: ScenarioRunResult | null) => void
  /** 最近一次 Outline（场景 × 数据表）结果，只活在内存（每行跑完渐进更新） */
  scnOutlineResults: ScenarioOutlineRunResult | null
  setScnOutlineResults: (r: ScenarioOutlineRunResult | null) => void

  /* ---- 数据驱动用例（接口改进 #2）---- */
  /** 数据驱动表（一个接口 × N 行数据）：列表持久化，表绑定 apiId */
  dataDrivenSets: DataDriven[]
  upsertDataDriven: (t: DataDriven) => void
  removeDataDriven: (id: string) => void
  loadDataDriven: () => Promise<void>
  /** 数据驱动跑批状态：与回归 / 场景互斥（都在发真实写请求） */
  ddRunning: boolean
  setDdRunning: (on: boolean) => void
  /** 最近一次数据驱动跑批结果，只活在内存（每行跑完渐进更新） */
  ddResults: DataDrivenRunResult | null
  setDdResults: (r: DataDrivenRunResult | null) => void

  /* ---- 页面测试 ---- */
  /** 页面测试运行中：与回归 / 场景 / 数据驱动互斥（共用一个「停止」） */
  pageRunning: boolean
  setPageRunning: (on: boolean) => void
  /** 正在做的那一步（登录 / 打开第几页 / 查哪个字段），跑完清空 */
  pageStep: string
  setPageStep: (t: string) => void
  /** 本轮要跑的页面数，进度条的分母 */
  pageTotal: number
  /** 从别的页点「去设置」：环境页打开时展开并滚到这一块，用完清空 */
  envFocus: 'pageTest' | 'baseUrl' | 'auth' | null
  setEnvFocus: (f: 'pageTest' | 'baseUrl' | 'auth' | null) => void
  /** 本轮运行日志（带时刻），开跑时清空、跑完保留，排障时复制出去 */
  pageLog: string[]
  /** 日志变更计数：pageLog 原地追加，界面订阅这个才会刷新 */
  pageLogN: number
  appendPageLog: (line: string) => void
  /** 最近一次报告。内存里带截图，落盘的没有 */
  pageReport: PageRunReport | null
  setPageReport: (r: PageRunReport | null) => void
  savePageReport: () => Promise<void>
  loadPageReport: () => Promise<void>
  /** 每条用例的上次结果 + 已知问题；读完了才允许写回 */
  pageHistory: pageHist.PageHistory
  pageHistoryLoaded: boolean
  loadPageHistory: () => Promise<void>
  /** 跑出一条结果：打上跟上次比的结论并记下（只改内存，跑完 savePageReport 时一起落盘） */
  notePageResult: (r: PageRunResult) => PageRunResult
  setPageKnown: (caseIds: string[], on: boolean) => Promise<void>
  clearPageHistory: (pageIds: string[]) => Promise<void>
  /** 写操作白名单 + 没收拾干净的数据；读完了才允许写回（同 env 的时序坑） */
  pageWrite: PageWriteState
  pageWriteLoaded: boolean
  loadPageWrite: () => Promise<void>
  setWriteSpec: (spec: WriteSpec) => Promise<void>
  removeWriteSpec: (pageId: string) => Promise<void>
  upsertLeftover: (l: WriteLeftover) => Promise<void>
  dropLeftover: (l: WriteLeftover) => Promise<void>

  /* ---- 压测（PRD v0.4 模块 4.8）---- */
  benchConfig: BenchConfig
  /** 压测配置从存储读完了才允许覆盖保存（同 env 的时序坑） */
  benchLoaded: boolean
  benchRunning: boolean
  /** Rust 每 500ms 推的实时指标；null = 没在跑或还没来第一条 */
  benchLive: BenchMetrics | null
  /** 实时 TPS 曲线（Rust 每次事件带最近 120 秒）；报告出来后以报告的 samples 为准 */
  benchTpsSeries: number[]
  benchReport: BenchReport | null

  /** 首页「之前扫描过的工程」卡片（摘要，最新在前，封顶 HISTORY_MAX） */
  history: ScanHistoryEntry[]

  /** 接口库左树宽度（px）。null = 用 CSS 默认的 minmax(300px, 360px) */
  railW: number | null
  setRailW: (w: number | null) => void
  /**
   * 回归范围（PRD 模块「指定服务/Controller 回归」）：顶栏选择器选的
   * 全部 / 某工程 / 某 Controller。UI 偏好：随 apiforge.ui 记住；新扫描里没有这个范围就退回全部。
   */
  runScope: RunScope
  setRunScope: (s: RunScope) => void
  /**
   * 调试面板默认填入全部字段（用户拍板 2026-09-19）：开着时点开接口就把
   * detailList 这类嵌套骨架填进正常用例（与「填入全部字段」按钮同一条路径），
   * 不用每次手点。默认关——回归口径仍是最小合法（09-17），开了等于声明
   * 「这些接口我就是要带全字段调/回归」。UI 偏好：随 apiforge.ui 记住。
   */
  fullBodyDefault: boolean
  setFullBodyDefault: (on: boolean) => void
  /** 「显示高级功能」：关着时场景、数据驱动、压测和两种导出都不显示，数据不删 */
  showAdvanced: boolean
  setShowAdvanced: (on: boolean) => void
  persistUi: () => Promise<void>
  loadUi: () => Promise<void>

  setScan: (ws: WorkspaceScanResult | null) => void
  setScanning: (on: boolean) => void
  setScanError: (msg: string | null) => void
  pushScanLog: (line: string) => void
  resetScanLog: () => void
  setHistory: (h: ScanHistoryEntry[]) => void
  loadHistory: () => Promise<void>

  patchEnv: (patch: Partial<EnvironmentConfig>) => void
  loadEnv: () => Promise<void>
  persistEnv: () => Promise<void>
  /** 环境组（lib/apiforge/envProfiles）：命名快照的存 / 切 / 删，切换整体覆盖当前 env */
  envProfiles: EnvProfile[]
  envProfilesLoaded: boolean
  loadEnvProfiles: () => Promise<void>
  saveEnvProfile: (name: string) => boolean
  applyEnvProfile: (id: string) => boolean
  removeEnvProfile: (id: string) => void
  /**
   * 回归报告历史（lib/apiforge/reportHistory）：每次回归收尾存一条小摘要，
   * 报告页拿它跟当前这份出「和上次比」。diff 只认同工程 + 同范围的上一次，
   * 没有可比的就不出对比带（首次跑 / 范围换了都是这个语义）。
   */
  reportHistory: ReportHistoryEntry[]
  reportHistoryLoaded: boolean
  /** 最近一次回归 vs 上一次的对比。只活在内存，新一轮开跑 / 清空结果时清掉 */
  reportDiff: ReportDiff | null
  /**
   * 最近一次跑批的墙钟（startRun 起、finishRun 收）。码上追「看日志」跳转
   * 按它定过滤时间窗；until = null 表示这轮还在跑或没正常收口。
   */
  runWindow: { since: number; until: number | null } | null
  loadReportHistory: () => Promise<void>
  saveReportHistory: (entry: ReportHistoryEntry) => void
  setToken: (token: string | null, source: string | null) => void

  setLinksFor: (apiId: string, links: TableRelation[]) => Promise<void>
  setCasesFor: (apiId: string, cases: TestCase[]) => Promise<void>
  /** 手改接口的「查/增/改/删」；null = 恢复自动认。落到 scan 上并存盘 */
  setApiAction: (apiId: string, action: ApiAction | null) => Promise<void>
  /** 启用 / 禁用一条用例，已有结果跟着变：禁用改「跳过」，重新启用去掉跳过那条 */
  setCaseEnabled: (apiId: string, caseId: string, enabled: boolean) => void
  /** 改一条用例：标「改过」，它已有的结果标「改过，没重跑」 */
  updateCase: (apiId: string, caseId: string, patch: CasePatch) => void
  /** 复制一条插在它后面，返回新用例；找不到返回 null */
  duplicateCase: (apiId: string, caseId: string) => TestCase | null
  /** 删一条用例，它的结果一起从报告去掉 */
  removeCase: (apiId: string, caseId: string) => void
  /** 把防抖中的用例立即写盘（失焦 / 切接口 / 卸载时调） */
  flushCases: () => Promise<void>
  loadProjectBlobs: (projectId: string) => Promise<void>
  selectApi: (apiId: string | null) => void

  startRun: (total: number) => void
  /** 局部重跑开跑：只置 running / 进度，不清上一轮的结果、流水、残留和「和上次比」 */
  beginPartialRun: (total: number) => void
  tickProgress: (label: string) => void
  pushResult: (r: CaseRunResult) => void
  /** 局部重跑的结果按 caseId 覆盖进现有结果 */
  upsertResults: (fresh: CaseRunResult[]) => void
  /** 正在跑什么（人话）；null = 空闲。所有发请求 / 换扫描结果的入口共用这一道互斥 */
  anyRunning: () => string | null
  pushRunLog: (line: string) => void
  finishRun: () => void
  requestStop: () => void
  clearResults: () => void

  patchBenchConfig: (patch: Partial<BenchConfig>) => void
  loadBench: () => Promise<void>
  setBenchRunning: (on: boolean) => void
  setBenchLive: (m: BenchMetrics | null, tpsSeries: number[]) => void
  setBenchReport: (r: BenchReport | null) => void
  clearBench: () => void
}

export const useApiforgeStore = create<ApiforgeState>((set, get) => ({
  scan: null,
  scanning: false,
  scanError: null,
  scanRoot: '',
  setScanRoot: (s) => set({ scanRoot: s }),

  // 进码上测先落扫描页：扫描入口和历史工程卡片都在，有缓存由「继续上次项目」领走
  view: 'scan',
  // 所有跳转都过一遍：旧名 home 归到扫描页，藏起来的高级页回落
  setView: (v) =>
    set({ view: resolveView(v, { advanced: get().showAdvanced, hasScan: !!get().scan, kinds: scanKinds(get().scan) }) }),
  reportFocus: null,
  setReportFocus: (f) => set({ reportFocus: { ...f, ts: Date.now() } }),
  apisFocus: null,
  setApisFocus: (f) => set({ apisFocus: { ...f, ts: Date.now() } }),

  env: DEFAULT_ENV,
  envLoaded: false,
  envProfiles: [],
  envProfilesLoaded: false,
  reportHistory: [],
  reportHistoryLoaded: false,
  reportDiff: null,
  runWindow: null,
  token: null,
  tokenSource: null,

  links: {},
  cases: {},
  selectedApiId: null,
  sendingApiId: null,
  setSendingApiId: (sendingApiId) => set({ sendingApiId }),

  running: false,
  stopRequested: false,
  progress: null,
  results: [],
  runLog: [],
  scanLog: [],
  apiDiff: null,
  setApiDiff: (apiDiff) => set({ apiDiff }),

  residue: null,
  setResidue: (residue) => set({ residue }),

  learnedExpectations: {},
  setLearnedExpectations: (learnedExpectations) => {
    set({ learnedExpectations })
    void (async () => {
      try {
        const store = await initStore()
        await store.saveMetaBlob(APF_EXPECTATIONS_KEY, JSON.stringify(learnedExpectations))
      } catch {
        // 记不住下次重新学就是了，不打断
      }
    })()
  },
  loadLearnedExpectations: async () => {
    try {
      const store = await initStore()
      const raw = await store.getMetaBlob(APF_EXPECTATIONS_KEY)
      if (!raw) return
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        set({ learnedExpectations: parsed as Record<string, string> })
      }
    } catch {
      // 读不出来就当没学过
    }
  },

  scenarios: [],
  scnRunning: false,
  scnResults: null,
  scnOutlineResults: null,
  upsertScenario: (scn) => {
    // updatedAt 由 store 盖章：组件里调 Date.now() 会吃 react-compiler 的
    // purity 警告，而且「改了没改都以时间为准」本来就是持久层的职责
    const stamped = { ...scn, updatedAt: Date.now() }
    // 同 id 覆盖、其余保序，新建的排最前
    const list = [stamped, ...get().scenarios.filter((x) => x.id !== scn.id)]
    set({ scenarios: list })
    void (async () => {
      try {
        const store = await initStore()
        await store.saveMetaBlob(APF_SCENARIOS_KEY, JSON.stringify(list))
      } catch {
        // 记不住下次重建就是了，不打断
      }
    })()
  },
  removeScenario: (id) => {
    const list = get().scenarios.filter((x) => x.id !== id)
    set({
      scenarios: list,
      scnResults: get().scnResults?.scenarioId === id ? null : get().scnResults,
      scnOutlineResults: get().scnOutlineResults?.scenarioId === id ? null : get().scnOutlineResults,
    })
    void (async () => {
      try {
        const store = await initStore()
        await store.saveMetaBlob(APF_SCENARIOS_KEY, JSON.stringify(list))
      } catch {
        // 同上
      }
    })()
  },
  loadScenarios: async () => {
    try {
      const store = await initStore()
      const raw = await store.getMetaBlob(APF_SCENARIOS_KEY)
      if (!raw) return
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        // 宽容洗一遍：残缺条目丢掉，坏 blob 当空，不能挡页面
        const list = parsed.filter(
          (x): x is Scenario =>
            !!x && typeof x === 'object' && typeof (x as Scenario).id === 'string' &&
            typeof (x as Scenario).name === 'string' && Array.isArray((x as Scenario).steps),
        )
        set({ scenarios: list })
      }
    } catch {
      // 读不出来就当没有场景
    }
  },
  // 开跑时清掉上一轮留下的「停止」，否则第一步前就退出、还报「全过」
  setScnRunning: (on) => set(on ? { scnRunning: true, stopRequested: false } : { scnRunning: false }),
  setScnResults: (r) => set({ scnResults: r }),
  setScnOutlineResults: (r) => set({ scnOutlineResults: r }),

  /* ---- 数据驱动用例（接口改进 #2）---- */
  /**
   * 数据驱动表（一个接口 × N 行数据）：列表持久化（apiforge.datadriven），表绑定
   * 接口库的 apiId——重扫后接口没了的表跑时给可读原因，不静默丢。
   */
  dataDrivenSets: [],
  ddRunning: false,
  ddResults: null,
  upsertDataDriven: (t) => {
    // updatedAt 由 store 盖章（同场景：组件里调 Date.now() 吃 purity 警告）
    const stamped = { ...t, updatedAt: Date.now() }
    const list = [stamped, ...get().dataDrivenSets.filter((x) => x.id !== t.id)]
    set({ dataDrivenSets: list })
    void persistDataDriven(list)
  },
  removeDataDriven: (id) => {
    const list = get().dataDrivenSets.filter((x) => x.id !== id)
    set({ dataDrivenSets: list, ddResults: get().ddResults?.setId === id ? null : get().ddResults })
    void persistDataDriven(list)
  },
  loadDataDriven: async () => {
    try {
      const store = await initStore()
      const raw = await store.getMetaBlob(APF_DATADRIVEN_KEY)
      if (!raw) return
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        // 宽容洗一遍：残缺条目丢掉，坏 blob 当空，不能挡页面
        const list = parsed.filter(
          (x): x is DataDriven =>
            !!x && typeof x === 'object' && typeof (x as DataDriven).id === 'string' &&
            typeof (x as DataDriven).name === 'string' && typeof (x as DataDriven).apiId === 'string' &&
            Array.isArray((x as DataDriven).columns) && Array.isArray((x as DataDriven).rows),
        )
        set({ dataDrivenSets: list })
      }
    } catch {
      // 读不出来就当没有数据表
    }
  },
  setDdRunning: (on) => set(on ? { ddRunning: true, stopRequested: false } : { ddRunning: false }),
  setDdResults: (r) => set({ ddResults: r }),

  pageRunning: false,
  // 开跑时顺手清掉上一轮留下的「停止」，否则新一轮一开始就停
  setPageRunning: (on) =>
    set(on ? { pageRunning: true, stopRequested: false, pageLog: [], pageLogN: 0 } : { pageRunning: false, pageStep: '' }),
  pageStep: '',
  setPageStep: (t) => set({ pageStep: t }),
  pageTotal: 0,
  envFocus: null,
  setEnvFocus: (envFocus) => set({ envFocus }),
  pageLog: [],
  pageLogN: 0,
  appendPageLog: (line) => {
    const d = new Date()
    const ts = `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`
    // 整工程一轮几万行：原地 push 免得每行复制整个数组，靠 pageLogN 变化通知界面；超 6 万行丢最早的
    const log = get().pageLog
    log.push(`${ts}  ${line}`)
    if (log.length > 60000) log.splice(0, 10000)
    // 每 200ms 最多通知一次界面：CDP 事件密的时候一秒几十行
    if (logFlush) return
    logFlush = setTimeout(() => {
      logFlush = null
      set({ pageLogN: get().pageLogN + 1 })
    }, 200)
  },
  pageReport: null,
  setPageReport: (r) => set({ pageReport: r }),
  savePageReport: async () => {
    const r = get().pageReport
    if (!r) return
    try {
      const store = await initStore()
      await store.saveMetaBlob(APF_PAGERUN_KEY, JSON.stringify(withoutScreenshots(r)))
      if (get().pageHistoryLoaded) await store.saveMetaBlob(APF_PAGEHIST_KEY, JSON.stringify(get().pageHistory))
    } catch {
      // 存不进去只是重开应用看不到上次报告，不挡这次
    }
  },
  loadPageReport: async () => {
    if (get().pageReport) return
    try {
      const store = await initStore()
      const raw = await store.getMetaBlob(APF_PAGERUN_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as PageRunReport
      if (parsed && Array.isArray(parsed.results) && parsed.summary) set({ pageReport: parsed })
    } catch {
      // 坏 blob 当没有
    }
  },
  pageHistory: pageHist.emptyHistory(),
  pageHistoryLoaded: false,
  loadPageHistory: async () => {
    if (get().pageHistoryLoaded) return
    try {
      const store = await initStore()
      set({ pageHistory: pageHist.parseHistory(await store.getMetaBlob(APF_PAGEHIST_KEY)), pageHistoryLoaded: true })
    } catch {
      set({ pageHistoryLoaded: true })
    }
  },
  notePageResult: (r) => {
    const { result, history } = pageHist.noteResult(r, get().pageHistory)
    set({ pageHistory: history })
    return result
  },
  setPageKnown: async (caseIds, on) => {
    await get().loadPageHistory()
    set({ pageHistory: pageHist.setKnown(get().pageHistory, caseIds, on) })
    await persistPageHistory(get().pageHistory)
  },
  clearPageHistory: async (pageIds) => {
    await get().loadPageHistory()
    set({ pageHistory: pageHist.clearPages(get().pageHistory, pageIds) })
    await persistPageHistory(get().pageHistory)
  },
  pageWrite: { specs: [], leftovers: [] },
  pageWriteLoaded: false,
  loadPageWrite: async () => {
    if (get().pageWriteLoaded) return
    try {
      const store = await initStore()
      set({ pageWrite: writeSpec.parsePageWrite(await store.getMetaBlob(APF_PAGEWRITE_KEY)), pageWriteLoaded: true })
    } catch {
      set({ pageWriteLoaded: true })
    }
  },
  setWriteSpec: async (spec) => {
    await get().loadPageWrite()
    set({ pageWrite: { ...get().pageWrite, specs: writeSpec.upsertSpec(get().pageWrite.specs, spec) } })
    await persistPageWrite(get().pageWrite)
  },
  removeWriteSpec: async (pageId) => {
    await get().loadPageWrite()
    set({ pageWrite: { ...get().pageWrite, specs: get().pageWrite.specs.filter((x) => x.pageId !== pageId) } })
    await persistPageWrite(get().pageWrite)
  },
  upsertLeftover: async (l) => {
    await get().loadPageWrite()
    set({ pageWrite: { ...get().pageWrite, leftovers: writeSpec.upsertLeftover(get().pageWrite.leftovers, l) } })
    await persistPageWrite(get().pageWrite)
  },
  dropLeftover: async (l) => {
    await get().loadPageWrite()
    set({ pageWrite: { ...get().pageWrite, leftovers: writeSpec.dropLeftover(get().pageWrite.leftovers, l) } })
    await persistPageWrite(get().pageWrite)
  },

  loadEnvProfiles: async () => {
    try {
      const store = await initStore()
      const raw = await store.getMetaBlob(APF_ENV_PROFILES_KEY)
      set({ envProfiles: parseProfiles(raw), envProfilesLoaded: true })
    } catch {
      // 读不出来就当没有环境组
      set({ envProfilesLoaded: true })
    }
  },
  saveEnvProfile: (name) => {
    const trimmed = name.trim()
    if (!trimmed) return false
    // 密码（和页面测试密码）在 envWithoutSecret 里剥掉，快照里只有测试数据没有凭据
    const { list } = upsertProfile(get().envProfiles, trimmed, envWithoutSecret(get().env))
    set({ envProfiles: list })
    void persistEnvProfiles(list)
    return true
  },
  applyEnvProfile: (id) => {
    const p = get().envProfiles.find((x) => x.id === id)
    if (!p) return false
    // 接口和页面测试两个密码都留在内存不动（同一套账密跨环境很常见）；token 清空——老环境签的对新环境
    // 没有意义，重跑时 loginApi 在就会自动登录（401 自救也兜底）
    set({ env: { ...p.env, password: get().env.password, pagePassword: get().env.pagePassword }, token: null })
    void get().persistEnv()
    return true
  },
  removeEnvProfile: (id) => {
    const list = get().envProfiles.filter((x) => x.id !== id)
    set({ envProfiles: list })
    void persistEnvProfiles(list)
  },

  loadReportHistory: async () => {
    try {
      const store = await initStore()
      const raw = await store.getMetaBlob(APF_REPORT_HISTORY_KEY)
      set({ reportHistory: parseHistory(raw), reportHistoryLoaded: true })
    } catch {
      // 读不出来就当没有历史，「和上次比」自然不出现
      set({ reportHistoryLoaded: true })
    }
  },
  saveReportHistory: (entry) => {
    // 先在插入前找基准、算好 diff，再进历史——报告页读的是这一份内存 diff
    const prev = comparableEntry(get().reportHistory, entry)
    const diff = prev ? diffRuns(prev, entry) : null
    const list = upsertEntry(get().reportHistory, entry)
    set({ reportDiff: diff, reportHistory: list })
    void persistReportHistory(list)
  },

  benchConfig: DEFAULT_BENCH_CONFIG,
  benchLoaded: false,
  benchRunning: false,
  benchLive: null,
  benchTpsSeries: [],
  benchReport: null,

  setScan: (scan) => {
    set({ scan, scanError: null })
    if (!scan) return
    if (!scopeFits(scan, get().runScope)) get().setRunScope(ALL_SCOPE)
    // 开机读缓存和每次重扫都走这里：先把各工程的 links/cases 缓存载进内存，
    // **载完再**刷老用例固化的空 body——顺序反了，刚载进来的 '{}' 会把刷好的盖回去。
    // fire-and-forget：扫描结果先上屏，blob 晚一拍到位（载入合并 store 已有条目优先）
    void (async () => {
      for (const p of scan.projects) {
        if (blobsLoadedProjects.has(p.projectId)) continue
        blobsLoadedProjects.add(p.projectId)
        await loadProjectBlobsInto(get, set, p.projectId)
      }
      // 手改的「查/增/改/删」套回去：重扫出来的是全新对象，不套就丢了
      const acts = await loadApiActions()
      const cur = get().scan
      if (cur && Object.keys(acts).length) {
        const applied = applyActionOverrides(cur, acts)
        if (applied !== cur) set({ scan: applied })
      }
      // 缓存用例优先于现场生成（buildRequest 的约定），扫描器后来才认出的 DTO 字段
      // （依赖 jar 兜底）不刷这里永远发不出去。判据都在 generate.ts 的
      // refreshStaleBodies：只动存着 '{}' 或还带着老占位值（test_demo）的，
      // 用户填过的值一个不碰。
      const patch: Record<string, TestCase[]> = {}
      const touchedProjects = new Set<string>()
      for (const p of scan.projects) {
        for (const c of p.controllers) {
          for (const m of c.methods) {
            const cs = get().cases[m.id]
            if (!cs) continue
            const fresh = refreshStaleBodies(m, cs)
            if (fresh) {
              patch[m.id] = fresh
              touchedProjects.add(p.projectId)
            }
          }
        }
      }
      if (!Object.keys(patch).length) return
      set({ cases: { ...get().cases, ...patch } })
      for (const projectId of touchedProjects) void persistProjectCases(get, projectId)
    })()
  },
  setScanning: (scanning) => set({ scanning }),
  setScanError: (scanError) => set({ scanError }),
  /**
   * 流水进内存。**封顶只封人话行**（渲染的那个 <pre> 里只有人话行）。
   *
   * 机器事件行（`PROG controller/api/files…`）一条都不能丢：实时发现树、工程队列、
   * 接口数 KPI 全是从机器行**序列**还原的派生视图，`liveTreeFromLog` 靠 `files` 行
   * 认出「当前工程」，那一行被挤掉之后，后面每一个 controller / api 行都因为挂不上
   * 工程而被丢掉——面板从头发到尾只剩一句不动的空态，看着像卡死。
   *
   * 实测就是这么发生的：单工程 admin-ui 的兜底阶段一行一个 DTO（跨工程源码 / jar
   * 兜底 + 嵌套类型展开），这些行加上几十条 parsing 行，足够把 200 行的窗口在第一个
   * `controller` 行到达之前占满（哪一次扫描真的越了界没法回放——流水只在内存里；
   * 但「锚行恰好还在窗口里」本来就不该是派生视图的前提）。
   */
  pushScanLog: (line) =>
    set((s) => ({ scanLog: capScanLog([...s.scanLog, line]) })),
  resetScanLog: () => set({ scanLog: [] }),

  history: [],
  setHistory: (history) => set({ history }),
  loadHistory: async () => set({ history: await loadScanHistory() }),

  railW: null,
  setRailW: (railW) => set({ railW }),

  runScope: ALL_SCOPE,
  setRunScope: (runScope) => {
    set({ runScope })
    void get().persistUi()
  },

  fullBodyDefault: false,
  setFullBodyDefault: (fullBodyDefault) => {
    set({ fullBodyDefault })
    void get().persistUi()
  },
  showAdvanced: !ADVANCED_TOGGLE_SHOWN,
  setShowAdvanced: (showAdvanced) => {
    set({ showAdvanced })
    get().setView(get().view)
    void get().persistUi()
  },
  persistUi: async () => {
    try {
      const store = await initStore()
      await store.saveMetaBlob(
        APF_UI_KEY,
        JSON.stringify({
          railW: get().railW,
          runScope: get().runScope,
          fullBodyDefault: get().fullBodyDefault,
          showAdvanced: get().showAdvanced,
        }),
      )
    } catch {
      // 偏好记不住就每次用默认值，不打断
    }
  },
  loadUi: async () => {
    try {
      const store = await initStore()
      const raw = await store.getMetaBlob(APF_UI_KEY)
      if (!raw) return
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      const p = parsed as { railW?: unknown; runScope?: unknown; fullBodyDefault?: unknown; showAdvanced?: unknown }
      if (typeof p.railW === 'number' && p.railW >= 260 && p.railW <= 800) set({ railW: p.railW })
      if (typeof p.fullBodyDefault === 'boolean') set({ fullBodyDefault: p.fullBodyDefault })
      if (ADVANCED_TOGGLE_SHOWN && typeof p.showAdvanced === 'boolean') {
        set({ showAdvanced: p.showAdvanced })
        get().setView(get().view)
      }
      // 范围洗一遍：只认非空字符串字段，脏数据当「全部」
      if (p.runScope && typeof p.runScope === 'object' && !Array.isArray(p.runScope)) {
        const r = p.runScope as Record<string, unknown>
        const runScope: RunScope = {}
        if (typeof r.projectId === 'string' && r.projectId) runScope.projectId = r.projectId
        if (typeof r.controllerClass === 'string' && r.controllerClass) runScope.controllerClass = r.controllerClass
        const cur = get().scan
        set({ runScope: cur && !scopeFits(cur, runScope) ? ALL_SCOPE : runScope })
      }
    } catch {
      // 读不出来就用默认值
    }
  },

  patchEnv: (patch) => {
    const next = { ...get().env, ...patch }
    if (patch.projectBaseUrls !== undefined) {
      next.projectBaseUrls = normalizeProjectBaseUrls(patch.projectBaseUrls)
    }
    if (patch.pageUsers !== undefined) {
      next.pageUsers = normalizeProjectBaseUrls(patch.pageUsers)
    }
    // 执行顺序（PRD v0.6 4.20）：洗成大写去重的合法动词表，脏配置不会进持久层
    if (patch.methodOrder !== undefined) {
      next.methodOrder = normalizeMethodOrder(patch.methodOrder)
    }
    set({ env: next })
    // 打字时每个字都会走这里：合并成 300ms 一次写盘，关窗前补写
    if (envPersistTimer) clearTimeout(envPersistTimer)
    envPersistTimer = setTimeout(() => {
      envPersistTimer = null
      void get().persistEnv()
    }, 300)
  },

  loadEnv: async () => {
    try {
      const store = await initStore()
      const raw = await store.getMetaBlob(APF_ENV_KEY)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const p = parsed as Partial<EnvironmentConfig>
          const env: EnvironmentConfig = {
            ...DEFAULT_ENV,
            ...p,
            // 老 blob 没有 projectBaseUrls；展开后可能盖成 undefined，强制回空对象
            projectBaseUrls: normalizeProjectBaseUrls(p.projectBaseUrls),
            pageUsers: normalizeProjectBaseUrls(p.pageUsers),
            // 脏/老数据的方法顺序洗一遍；没有这一字段 normalize 返回空 = 用默认
            methodOrder: normalizeMethodOrder(p.methodOrder),
          }
          // 一次性迁移（2026-09-19 拍板）：数据准备默认自动。老 blob 里存的 false
          // 多半是旧默认不是明确选择；打过标记的 blob 尊重原值，关过就是关
          if (p.prepV2 !== true) {
            env.autoPrepare = true
            env.prepV2 = true
            await store.saveMetaBlob(APF_ENV_KEY, JSON.stringify(envWithoutSecret(env)))
          }
          set({ env, envLoaded: true })
          return
        }
      }
      set({ envLoaded: true })
    } catch {
      // 读不出来就用默认值：环境配置不能挡着页面打开
      set({ envLoaded: true })
    }
  },

  persistEnv: async () => {
    if (!get().envLoaded) return
    try {
      const store = await initStore()
      await store.saveMetaBlob(APF_ENV_KEY, JSON.stringify(envWithoutSecret(get().env)))
    } catch {
      // 保存失败下次重新填就是了，不打断当前操作
    }
  },

  setToken: (token, tokenSource) => set({ token, tokenSource }),

  setLinksFor: async (apiId, links) => {
    set({ links: { ...get().links, [apiId]: links } })
    const project = get().scan?.projects.find((p) =>
      p.controllers.some((c) => c.methods.some((m) => m.id === apiId)),
    )
    if (!project) return
    // 同工程的所有 api 的 links 收进一份 blob 存
    const all: Record<string, TableRelation[]> = {}
    for (const [id, ls] of Object.entries(get().links)) {
      if (get().scan?.projects.some((p) => p.projectId === project.projectId &&
        p.controllers.some((c) => c.methods.some((m) => m.id === id)))) {
        all[id] = ls
      }
    }
    try {
      const store = await initStore()
      await store.saveMetaBlob(apiforgeLinksKey(project.projectId), JSON.stringify(all))
    } catch {
      /* 持久化失败下次重算，不打断 */
    }
  },

  setCasesFor: (apiId, cases) => {
    set({ cases: { ...get().cases, [apiId]: cases } })
    const projectId = projectIdOfApi(get().scan, apiId)
    if (projectId) scheduleCasesPersist(get, projectId)
    return Promise.resolve()
  },

  setApiAction: async (apiId, action) => {
    const map = { ...(await loadApiActions()) }
    if (action) map[apiId] = action
    else delete map[apiId]
    apiActions = map
    const scan = get().scan
    if (scan) set({ scan: applyActionOverrides(scan, map) })
    try {
      const store = await initStore()
      await store.saveMetaBlob(APF_API_ACTIONS_KEY, JSON.stringify(map))
    } catch {
      /* 存不进去只是重开应用后恢复自动认 */
    }
  },

  setCaseEnabled: (apiId, caseId, enabled) => {
    const cases = get().cases[apiId] ?? []
    void get().setCasesFor(
      apiId,
      cases.map((c) => (c.id === caseId ? { ...c, enabled } : c)),
    )
    set({ results: applyCaseEnabled(get().results, caseId, enabled) })
  },

  updateCase: (apiId, caseId, patch) => {
    const cases = get().cases[apiId] ?? []
    void get().setCasesFor(
      apiId,
      cases.map((c) => (c.id === caseId ? patchCase(c, patch) : c)),
    )
    set({ results: markStale(get().results, caseId) })
  },

  duplicateCase: (apiId, caseId) => {
    const cases = get().cases[apiId] ?? []
    const i = cases.findIndex((c) => c.id === caseId)
    if (i < 0) return null
    const copy = duplicateCase(cases[i]!, apiId, cases)
    void get().setCasesFor(apiId, [...cases.slice(0, i + 1), copy, ...cases.slice(i + 1)])
    return copy
  },

  removeCase: (apiId, caseId) => {
    const cases = get().cases[apiId] ?? []
    void get().setCasesFor(
      apiId,
      cases.filter((c) => c.id !== caseId),
    )
    set({ results: get().results.filter((r) => r.caseId !== caseId) })
  },

  flushCases: () => flushCasesNow(),

  loadProjectBlobs: async (projectId) => {
    await loadProjectBlobsInto(get, set, projectId)
  },

  selectApi: (selectedApiId) => {
    // 切接口前把上一个接口改到一半的用例落盘
    void flushCasesNow()
    set({ selectedApiId })
  },

  startRun: (total) =>
    set({
      running: true,
      stopRequested: false,
      progress: { done: 0, total, label: '准备中' },
      results: [],
      runLog: [],
      residue: null,
      reportDiff: null,
      // 跑批墙钟从这一刻起记：码上测的「看日志」跳转按它定时间窗。
      // 不放 results 里逐条记——每条用例记时间戳会改共享类型，跑批起止够用
      runWindow: { since: Date.now(), until: null },
    }),
  tickProgress: (label) => {
    const p = get().progress
    if (!p) return
    set({ progress: { ...p, done: Math.min(p.done + 1, p.total), label } })
  },
  beginPartialRun: (total) =>
    set({ running: true, stopRequested: false, progress: { done: 0, total, label: '准备中' } }),
  pushResult: (r) => set({ results: [...get().results, r] }),
  upsertResults: (fresh) => set({ results: mergeResults(get().results, fresh) }),
  anyRunning: () => {
    const s = get()
    if (s.scanning) return '正在扫描'
    if (s.running) return '正在跑用例'
    if (s.scnRunning) return '正在跑场景'
    if (s.ddRunning) return '正在跑数据表'
    if (s.pageRunning) return '正在跑页面测试'
    if (s.benchRunning) return '正在压测'
    return null
  },
  pushRunLog: (line) => set({ runLog: [...get().runLog, line] }),
  finishRun: () =>
    set((s) => ({
      running: false,
      progress: null,
      // 跑完收口；没记过起始（老入口直接 finishRun）就不造窗口
      runWindow: s.runWindow ? { ...s.runWindow, until: Date.now() } : null,
    })),
  requestStop: () => set({ stopRequested: true }),
  // runWindow 不清：「看日志」按钮只在有失败结果时出现，旧窗口留着无害
  clearResults: () => set({ results: [], progress: null, runLog: [], reportDiff: null }),

  patchBenchConfig: (patch) => {
    set({ benchConfig: { ...get().benchConfig, ...patch } })
    void (async () => {
      if (!get().benchLoaded) return
      try {
        const store = await initStore()
        await store.saveMetaBlob(APF_BENCH_KEY, JSON.stringify(get().benchConfig))
      } catch {
        // 配置记不住下次重填就是了，不打断
      }
    })()
  },

  loadBench: async () => {
    try {
      const store = await initStore()
      const raw = await store.getMetaBlob(APF_BENCH_KEY)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          set({
            benchConfig: { ...DEFAULT_BENCH_CONFIG, ...(parsed as Partial<BenchConfig>) },
            benchLoaded: true,
          })
          return
        }
      }
      set({ benchLoaded: true })
    } catch {
      set({ benchLoaded: true })
    }
  },

  setBenchRunning: (benchRunning) =>
    set(benchRunning ? { benchRunning, benchReport: null, benchTpsSeries: [] } : { benchRunning }),
  setBenchLive: (benchLive, benchTpsSeries) => set({ benchLive, benchTpsSeries }),
  setBenchReport: (benchReport) => set({ benchReport }),
  clearBench: () => set({ benchReport: null, benchLive: null, benchTpsSeries: [] }),
}))
