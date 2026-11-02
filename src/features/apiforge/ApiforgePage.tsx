/**
 * 码上测主页：状态条 + 主线页签（扫描 / 接口 / 报告 / 环境）+「更多」里的其余页。
 * 状态条贴在页顶栏之下不随内容滚；「全自动回归」在顶栏右上，任何页都能点。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { App as AntdApp } from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import { Page } from '../../components/shell/Page'
import { Btn, PopSel, Seg, type SelOption } from '../../components/ui'
import { useApiforgeStore, type ApiforgeView } from '../../store/useApiforgeStore'
import { useDbConnStore } from '../../store/useDbConnStore'
import { useUiStore } from '../../store/useUiStore'
import { loadCachedWorkspace } from '../../lib/apiforge/scan/scanIpc'
import { entryFromScan, historyCardName } from '../../lib/apiforge/scan/history'
import { isAllScope, scopeLabel } from '../../lib/apiforge/runner/scope'
import {
  apiDiscoverLabel,
  isMachineEvent,
  liveTreeFromLog,
  queueFromScan,
  scanQueueFromLog,
  type LiveProject,
  type ScanQueue,
} from '../../lib/apiforge/scan/queue'
import { whoLine } from '../../lib/apiforge/docmeta'
import { fmtLocal } from '../../lib/apiforge/localTime'
import { sessionMismatch } from '../../lib/apiforge/dbSession'
import { apiTotal, useScan } from './apiforgeRun'
import type { AppModal } from './appModal'
import { Verb } from './apiforgeBits'
import { ApiforgeHomeTab } from './ApiforgeHomeTab'
import { ApiforgeOverview } from './ApiforgeOverview'
import { focusScanRoot } from './scanFocus'
import { isAdvancedView, resolveView, scanKinds, viewShown, type ScanKinds } from '../../lib/apiforge/views'
import { ApiforgeApisTab } from './ApiforgeApisTab'
import { ApiforgeTablesTab } from './ApiforgeTablesTab'
import { ApiforgeReportTab } from './ApiforgeReportTab'
import { ApiforgeBenchTab, ApiforgeDataTab, ApiforgePagesTab, ApiforgeScenarioTab, runFullRegression, useBenchEvents } from '@pro'
import { ApiforgeEnvPanel } from './ApiforgeEnvPanel'

/** 顶栏直接露出的主线：扫描 → 发送 / 页面测试 → 看报告，另加常要改的环境 */
const MAIN_TABS: { value: ApiforgeView; label: string; title?: string }[] = [
  { value: 'scan', label: '扫描', title: '选目录扫描，扫描进度和结果也在这里' },
  { value: 'apis', label: '接口' },
  { value: 'pages', label: '页面测试', title: '驱动本机浏览器登录，逐页巡检、逐字段核对查询结果' },
  { value: 'report', label: '报告' },
  { value: 'env', label: '环境 / 连库' },
]

/** 「更多」里的页；都要开「显示高级功能」才列出来 */
const MORE_TABS: { value: ApiforgeView; label: string }[] = [
  { value: 'tables', label: '关联表' },
  { value: 'scenario', label: '场景' },
  { value: 'data', label: '数据驱动' },
  { value: 'bench', label: '压测' },
]

/** 空队列的稳定引用，避免 useMemo 每次渲染换新对象 */
const EMPTY_QUEUE: ScanQueue = { projects: [], activeControllers: [] }

const QUEUE_BADGE = { waiting: '等待', parsing: '解析中', done: '完成', fail: '失败' } as const

/**
 * 顶栏回归范围：全部 / 某个工程。单个 Controller、单个接口在「接口」页「运行▾」里跑，这里不再列（入口太多，用户 10-19）。
 * 单选，选完进 store.runScope（随 apiforge.ui 记住）；「⚡ 全自动回归」只跑范围内的。
 * value 用定长前缀编码（p + projectId）而不是 split(':')——projectId 缺省就是工程路径，带盘符冒号。
 */
function ScopePick() {
  const scan = useApiforgeStore((s) => s.scan)
  const runScope = useApiforgeStore((s) => s.runScope)
  const setRunScope = useApiforgeStore((s) => s.setRunScope)
  const options = useMemo<ReadonlyArray<SelOption<string>>>(
    () => [
      { value: '', label: '全部工程' },
      ...(scan?.projects ?? []).map((p) => ({ value: `p${p.projectId}`, label: p.projectName })),
    ],
    [scan],
  )
  const value = runScope.projectId
    ? `p${runScope.projectId}`
    : runScope.controllerClass
      ? `c${runScope.controllerClass}`
      : ''
  const onChange = (v: string) => setRunScope(v ? { projectId: v.slice(1) } : {})
  // 按钮上显示人话（PopSel 的 displayLabel 覆盖）：范围：全部 / 工程名；老版记住的 Controller 范围照样亮出类名，换一下就没了
  const label = isAllScope(runScope)
    ? '范围：全部'
    : `范围：${scopeLabel(scan, runScope)}`
  // 只有一个工程时「全部」和「这个工程」跑的一样，不显示；已经圈了范围的照样显示，留着切回全部
  if ((scan?.projects.length ?? 0) <= 1 && isAllScope(runScope)) return null
  return (
    <PopSel
      className="apf-scopepick"
      value={value}
      displayLabel={label}
      onChange={onChange}
      options={options}
      searchAt={10}
      searchPlaceholder="搜工程"
      aria-label="回归范围"
      title="全自动回归只跑选中工程的接口；单个 Controller / 接口在「接口」页「运行▾」里跑"
    />
  )
}

/** 扫描中 PROG 攒出的「工程 → Controller → 接口」树。
 *  卡片样式跟左栏工程队列同一套 `.apf-cq`——那边能看见，这边就也能看见，
 *  不再用另一套 `.apf-liveproj` 在 flex 空洞里赌可见性。
 *  接口默认折在 Controller 下，点开才展开（全摊开太长）。 */
function LiveDiscover({ tree }: { tree: LiveProject[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const total = tree.reduce((n, p) => n + p.controllers.reduce((m, c) => m + c.apis.length, 0), 0)
  return (
    <div className="apf-livefind">
      <div className="apf-discover-sum">
        {tree.length} 个工程 · {total} 个接口
      </div>
      {tree.map((p) => (
        <div key={p.name} className="apf-discover-proj">
          <div className="apf-cq st-done">
            <div className="apf-cq-top">
              <span className="apf-cq-name">{p.name}</span>
              <span className="apf-cq-badge">
                {p.controllers.reduce((m, c) => m + c.apis.length, 0)} 个接口
              </span>
            </div>
          </div>
          {p.controllers.map((c) => {
            const key = `${p.name}/${c.name}`
            const expanded = !!open[key]
            return (
              <div key={c.name} className="apf-discover-ctl">
                <button
                  type="button"
                  className="apf-cq st-parsing apf-ctl-toggle"
                  onClick={() => setOpen((s) => ({ ...s, [key]: !expanded }))}
                  title={expanded ? '收起接口' : '展开接口'}
                >
                  <div className="apf-cq-top">
                    <span className="apf-chev">{expanded ? '▾' : '▸'}</span>
                    <span className="apf-cq-name">{c.name}</span>
                    <span className="apf-cq-badge">{c.apis.length} 个接口</span>
                  </div>
                </button>
                {expanded &&
                  c.apis.map((a, i) => {
                    const label = apiDiscoverLabel(a)
                    return (
                      <div key={`${a.method}-${a.path}-${i}`} className="apf-liveapi" title={label || undefined}>
                        <Verb method={a.method || '?'} />
                        {label ? <span className="apf-apiname">{label}</span> : null}
                        <span className="apf-path">{a.path || '(无路径)'}</span>
                      </div>
                    )
                  })}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/** 扫完后的权威树：同 LiveDiscover——接口默认折起，点 Controller 展开 */
function ScanDiscover({
  projects,
}: {
  projects: {
    projectId: string
    projectPath: string
    projectName: string
    controllers: {
      className: string
      description?: string
      filePath: string
      author: string
      date: string
      methods: { id: string; httpMethod: string; path: string; methodName: string; description: string }[]
    }[]
  }[]
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const total = projects.reduce((n, p) => n + p.controllers.reduce((m, c) => m + c.methods.length, 0), 0)
  const ctrlN = projects.reduce((n, p) => n + p.controllers.length, 0)
  return (
    <div className="apf-livefind">
      <div className="apf-discover-sum">
        {projects.length} 个工程 · {ctrlN} 个 Controller · {total} 个接口
      </div>
      {projects.map((p) => (
        <div key={p.projectId || p.projectPath} className="apf-discover-proj">
          <div className="apf-cq st-done">
            <div className="apf-cq-top">
              <span className="apf-cq-name">{p.projectName}</span>
              <span className="apf-cq-badge">
                {p.controllers.reduce((m, c) => m + c.methods.length, 0)} 个接口
              </span>
            </div>
          </div>
          {p.controllers.map((c) => {
            const key = c.filePath || `${p.projectId}/${c.className}`
            const expanded = !!open[key]
            return (
              <div key={key} className="apf-discover-ctl">
                <button
                  type="button"
                  className="apf-cq st-parsing apf-ctl-toggle"
                  title={
                    [c.description, whoLine(c)].filter(Boolean).join(' · ') ||
                    (expanded ? '收起接口' : '展开接口')
                  }
                  onClick={() => setOpen((s) => ({ ...s, [key]: !expanded }))}
                >
                  <div className="apf-cq-top">
                    <span className="apf-chev">{expanded ? '▾' : '▸'}</span>
                    <span className="apf-cq-name">{c.className}</span>
                    <span className="apf-cq-badge">{c.methods.length} 个接口</span>
                  </div>
                </button>
                {expanded &&
                  c.methods.map((m) => {
                    const label = apiDiscoverLabel(m)
                    return (
                      <div key={m.id} className="apf-liveapi" title={label || undefined}>
                        <Verb method={m.httpMethod || '?'} />
                        {label ? <span className="apf-apiname">{label}</span> : null}
                        <span className="apf-path">{m.path || '(无路径)'}</span>
                      </div>
                    )
                  })}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/** 「继续上次项目」确认框本次会话只弹一次：取消后用户自己在扫描页挑历史卡片 */
let resumeAsked = false

/**
 * 首次进到 APIForge：缓存里最近扫过的项目弹窗让用户确认——
 * 确认直接打开上次扫描的结果（不重扫，用户多半只是想先看看，
 * 要新数据工作台里有「重新扫描」），取消就留在扫描首页（历史卡片都在）。
 * 本页在 AppShell 里 keep-alive 不卸载，mount 在应用启动就发生了，
 * 所以「进入首页」盯的是 activeTab 何时切到 apiforge，不是组件 mount。
 */
async function askResumeLastScan(modal: AppModal): Promise<void> {
  if (resumeAsked) return
  resumeAsked = true
  const st = useApiforgeStore.getState()
  // 已有扫描结果或在扫：说明这次会话里已经开工了，不打扰
  if (st.scanning || st.scan) return
  const cached = await loadCachedWorkspace()
  // 缓存里没有完整结果就没有「打开」可给：走首页自己挑卡片扫
  if (!cached) return
  const latest = entryFromScan(cached)
  const apis = latest.projects.reduce((n, p) => n + p.apis, 0)
  modal.confirm({
    title: '继续上次的项目？',
    content: (
      <div>
        <div>
          <b>{historyCardName(latest)}</b>
        </div>
        <div>
          <code>{latest.root}</code>
        </div>
        <div>
          {latest.projects.length} 个工程 · {apis} 个接口 · 上次扫描 {fmtLocal(latest.scannedAt)}
        </div>
        <div>确认后直接打开上次扫描的结果，不用重新扫描。</div>
      </div>
    ),
    okText: '打开结果',
    cancelText: '先不打开',
    onOk: () => {
      // 路径回填输入框，想重扫时不用再找目录
      useApiforgeStore.getState().setScanRoot(latest.root)
      // 恢复缓存结果进工作台：不重扫，要新数据点工作台里的「重新扫描」。
      // 落点直接进接口库——打开的是结果，用户要的是接口不是扫描页
      const st = useApiforgeStore.getState()
      st.setScan(cached)
      st.setView('apis')
    },
  })
}

export function ApiforgePage() {
  const { message, modal } = AntdApp.useApp()
  const view = useApiforgeStore((s) => s.view)
  const setView = useApiforgeStore((s) => s.setView)
  const scan = useApiforgeStore((s) => s.scan)
  const scanning = useApiforgeStore((s) => s.scanning)
  const running = useApiforgeStore((s) => s.running)
  const runScope = useApiforgeStore((s) => s.runScope)
  const loadEnv = useApiforgeStore((s) => s.loadEnv)
  const loadHistory = useApiforgeStore((s) => s.loadHistory)
  const loadUi = useApiforgeStore((s) => s.loadUi)
  const loadBench = useApiforgeStore((s) => s.loadBench)
  const loadLearnedExpectations = useApiforgeStore((s) => s.loadLearnedExpectations)
  const loadScenarios = useApiforgeStore((s) => s.loadScenarios)
  const loadDataDriven = useApiforgeStore((s) => s.loadDataDriven)
  const loadEnvProfiles = useApiforgeStore((s) => s.loadEnvProfiles)
  const loadReportHistory = useApiforgeStore((s) => s.loadReportHistory)
  const { doScan } = useScan(message)

  // 压测事件接线必须挂在页面级：子页签切走再回来，done 事件不能丢
  useBenchEvents()

  useEffect(() => {
    void loadEnv()
    void loadHistory()
    void loadUi()
    void loadBench()
    void loadLearnedExpectations()
    void loadScenarios()
    void loadDataDriven()
    void loadEnvProfiles()
    void loadReportHistory()
  }, [loadEnv, loadHistory, loadUi, loadBench, loadLearnedExpectations, loadScenarios, loadDataDriven, loadEnvProfiles, loadReportHistory])

  // 进入首页先确认要不要打开上次的结果；确认进工作台、取消留在首页
  const activeTab = useUiStore((s) => s.activeTab)
  useEffect(() => {
    if (activeTab === 'apiforge') void askResumeLastScan(modal)
  }, [activeTab, modal])

  const apiCount = scan
    ? scan.projects.reduce((n, p) => n + p.controllers.reduce((m, c) => m + c.methods.length, 0), 0)
    : 0
  // 纯页面工程不显示接口那套页签，纯接口工程不显示页面测试；扫描换了当前页不在了就换到有的那边
  const showAdvanced = useApiforgeStore((s) => s.showAdvanced)
  const kinds = useMemo(() => scanKinds(scan), [scan])
  const shown = resolveView(view, { advanced: showAdvanced, hasScan: !!scan, kinds })

  return (
    <Page
      tab="apiforge"
      // 接口库是工作台布局（fill 同连库/单表 SQL）：.pane 不滚，左树右详情等高铺满、各自内部滚。
      // 扫描工作视图走 bare（不吃 .pane-in 的 1360 限宽）：全屏时三面板跟着窗口拉满，右边不再空一大片。
      // 其余页签保持 1360 限宽整页滚动
      fill={shown === 'apis'}
      bare={shown === 'scan'}
      banner={<MetaBar />}
      actions={
        <>
          {kinds.apis && <ScopePick />}
          {kinds.apis && (
          <Btn
            variant="primary"
            onClick={() => void runFullRegression(message, modal)}
            blocked={!scan || scan.projects.length === 0}
            title={
              !scan || scan.projects.length === 0
                ? '先扫描出一个工程才有得跑'
                : `${
                    isAllScope(runScope) ? '' : `只跑「${scopeLabel(scan, runScope)}」的接口。`
                  }生成用例 → 写操作一次确认 → 跑批 → 报告（含数据库变更摘要）`
            }
          >
            {running ? '回归中…' : (
              <>
                <ThunderboltOutlined aria-hidden="true" /> 全自动回归
              </>
            )}
          </Btn>
          )}
          {/* 重新扫描固定扫当前工程；首页输入框里改过的路径只给首页「开始扫描」用 */}
          <Btn onClick={() => void doScan(scan?.root)} disabled={scanning}>
            {scanning ? '扫描中…' : scan ? '重新扫描' : '开始扫描'}
          </Btn>
        </>
      }
    >
      <div className="apf-tabsrow">
        <Seg<ApiforgeView>
          options={MAIN_TABS.filter((o) => viewShown(o.value, kinds)).map((o) =>
            o.value === 'apis' && apiCount ? { ...o, label: `接口 (${apiCount})` } : o,
          )}
          value={shown}
          onChange={setView}
        />
        <MoreTabs view={shown} onPick={setView} kinds={kinds} />
      </div>
      {shown === 'scan' && <ScanPage />}
      {shown === 'apis' && <ApiforgeApisTab />}
      {shown === 'tables' && <ApiforgeTablesTab />}
      {shown === 'scenario' && <ApiforgeScenarioTab />}
      {shown === 'data' && <ApiforgeDataTab />}
      {shown === 'pages' && <ApiforgePagesTab />}
      {shown === 'report' && <ApiforgeReportTab />}
      {shown === 'bench' && <ApiforgeBenchTab />}
      {shown === 'env' && (
        <div className="apf-pane">
          <div className="apf-panel">
            <div className="apf-panel-h">环境与连库</div>
            <ApiforgeEnvPanel />
          </div>
        </div>
      )}
    </Page>
  )
}

/** 「更多▾」：当前就在其中一页时按钮显示那一页的名字 */
function MoreTabs({ view, onPick, kinds }: { view: ApiforgeView; onPick: (v: ApiforgeView) => void; kinds: ScanKinds }) {
  const showAdvanced = useApiforgeStore((s) => s.showAdvanced)
  const options = MORE_TABS.filter((o) => (showAdvanced || !isAdvancedView(o.value)) && viewShown(o.value, kinds))
  const current = options.find((o) => o.value === view)
  // 高级关着时一页都没有，整个按钮不露
  if (!options.length) return null
  return (
    <PopSel<ApiforgeView | ''>
      className={current ? 'apf-moretabs on' : 'apf-moretabs'}
      value={current ? view : ''}
      displayLabel={current ? current.label : '更多'}
      options={options}
      onChange={(v) => v && onPick(v)}
      aria-label="更多页面"
    />
  )
}

/** 扫描页：上半部选目录 + 最近的工程；扫过、在扫或失败时下半部接上状态和结果 */
function ScanPage() {
  const scan = useApiforgeStore((s) => s.scan)
  const scanning = useApiforgeStore((s) => s.scanning)
  const scanError = useApiforgeStore((s) => s.scanError)
  const workRef = useRef<HTMLDivElement | null>(null)
  // 开始扫描时把进度滚到眼前，不然要自己往下翻
  useEffect(() => {
    if (scanning) workRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [scanning])
  return (
    <>
      <ApiforgeOverview />
      <ApiforgeHomeTab />
      {(scanning || scan || scanError) && (
        <div ref={workRef} className="apf-scanpage-work">
          <ScanTab />
        </div>
      )}
    </>
  )
}

/** 页顶栏下的状态条：目录 / 工程·接口 / 范围 / 连库 / 登录 / 断言，一眼看清这次回归的环境 */
function MetaBar() {
  const scan = useApiforgeStore((s) => s.scan)
  const scanning = useApiforgeStore((s) => s.scanning)
  const token = useApiforgeStore((s) => s.token)
  const env = useApiforgeStore((s) => s.env)
  const runScope = useApiforgeStore((s) => s.runScope)
  const conns = useDbConnStore((s) => s.items)
  const dbSession = useUiStore((s) => s.dbSession)
  const conn = conns.find((c) => c.id === env.connId)
  const otherConn = sessionMismatch(dbSession, env.connId)
  const apiCount = scan ? apiTotal(scan) : 0
  // 只数这次扫描里的工程：projectBaseUrls 还留着以前扫过的目录的地址
  const overrideN = (scan?.projects ?? []).filter((p) => env.projectBaseUrls?.[p.projectId]?.trim()).length
  const scoped = !!scan && !isAllScope(runScope)
  return (
    // 左边是这次扫了什么、发到哪，右边是连库 / 登录两个开关状态
    <div className="apf-metabar">
      <div className="apf-meta-main">
        <span className="apf-meta-item apf-meta-path">
          <i>目录</i>
          <b>{scan?.root ?? '—'}</b>
        </span>
        <span className="apf-meta-item">
          <i>接口</i>
          {scan ? (
            <>
              <b>
                {scan.projects.length} 个工程 · {apiCount} 个接口
              </b>
              <em>{fmtLocal(scan.scannedAt)} 扫描</em>
            </>
          ) : (
            <b>{scanning ? '扫描中…' : '等待扫描'}</b>
          )}
        </span>
        {scoped && (
          <span className="apf-meta-item apf-scope-on">
            <i>范围</i>
            <b>{scopeLabel(scan, runScope)}</b>
          </span>
        )}
        <span className="apf-meta-item apf-meta-path">
          <i>服务</i>
          <b>{env.baseUrl || '—'}</b>
          {overrideN > 0 && <em>另有 {overrideN} 个工程单独配了地址</em>}
        </span>
      </div>
      <div className="apf-meta-side">
        {otherConn ? (
          <span className="apf-tok warn">已连的是另一条连接，到环境页重连</span>
        ) : (
          <span className={dbSession ? 'apf-tok on' : 'apf-tok'}>
            {dbSession ? (conn?.name ?? '已连库') : '未连库'}
          </span>
        )}
        <span className={token ? 'apf-tok on' : 'apf-tok'}>{token ? '已注入 Token' : '未登录'}</span>
      </div>
    </div>
  )
}

/* ================= 扫描页 ================= */

function ScanTab() {
  const { message } = AntdApp.useApp()
  // 输入框在首页；这里只留 HUD 里的目录兜底显示
  const { root, doScan, stopScan } = useScan(message)
  const scan = useApiforgeStore((s) => s.scan)
  const scanning = useApiforgeStore((s) => s.scanning)
  const scanError = useApiforgeStore((s) => s.scanError)
  const scanLog = useApiforgeStore((s) => s.scanLog)
  const setView = useApiforgeStore((s) => s.setView)
  const logRef = useRef<HTMLPreElement | null>(null)
  // 扫描中流水展开跟着看；扫完（含打开历史结果）默认折起，主栏留给实时发现
  const [logOpen, setLogOpen] = useState(scanning)
  const [seenScanning, setSeenScanning] = useState(scanning)
  if (scanning !== seenScanning) {
    setSeenScanning(scanning)
    setLogOpen(scanning)
  }

  // 流水新行到了就滚到底（原型 pushScanLog 的 requestAnimationFrame 滚动同款）
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [scanLog])

  // 扫描中的实时接口数：数 PROG api 行。扫完切回权威总数
  const liveApiCount = useMemo(
    () => scanLog.filter((l) => l.startsWith('PROG api ')).length,
    [scanLog],
  )

  // 流水面板只显示人话解析块（▶ Controller / ▸ 接口 / 注解 / 参数…）；
  // HUD 顶上的实时一行也从这里取，机器行不掺进来
  const displayLog = useMemo(
    () => scanLog.filter((l) => !isMachineEvent(l)).map((l) => l.replace(/^PROG /, '')),
    [scanLog],
  )
  const lastLine = displayLog.length ? displayLog[displayLog.length - 1] : null

  // 第二级 · 工程队列：扫描中从流水还原（靠扫描器的 proj 事件），扫完从缓存结果出
  const queue: ScanQueue = useMemo(
    () => (scanning ? scanQueueFromLog(scanLog) : scan ? queueFromScan(scan) : EMPTY_QUEUE),
    [scanning, scanLog, scan],
  )
  const doneProjects = queue.projects.filter((p) => p.status === 'done').length
  const liveCtrlCount = queue.projects.reduce((n, p) => n + p.controllers, 0)

  // 流水里的实时树：扫描中用来画中间栏；扫完仍留着当权威结果为空时的兜底
  // （以前 scanning=false 时直接清成 []，中间栏一旦没吃到 scan 就剩一块黑）
  const liveTree = useMemo(() => liveTreeFromLog(scanLog), [scanLog])

  // 完成态沿用扫描中的人话解析块（全程叙事留得住），只把结果 JSON 里的
  // 解析失败清单补在尾部：流水里的 ✗ 只报了文件名，这里给全路径和原因
  const logLines = useMemo(() => {
    if (!scan) return displayLog
    const errs: string[] = []
    for (const p of scan.projects) for (const e of p.errors) errs.push(`✗ ${e.file}: ${e.message}`)
    for (const e of scan.errors) errs.push(`✗ ${e.file}: ${e.message}`)
    return errs.length ? [...displayLog, '', `── 解析失败 ${errs.length} 条 ──`, ...errs] : displayLog
  }, [scan, displayLog])

  const done = !scanning && !!scan
  const scanCtrlCount = scan
    ? scan.projects.reduce((n, p) => n + p.controllers.length, 0)
    : 0
  // 页面数按 FTL / Vue 分开数；扫完是纯前端工程时不显示接口那套（接口 0、解析流水）
  const pageN = useMemo(() => {
    const n = { ftl: 0, vue: 0 }
    for (const p of scan?.projects ?? []) n[p.vue ? 'vue' : 'ftl'] += (p.pages ?? []).length
    return n
  }, [scan])
  const pageTotal = pageN.ftl + pageN.vue
  const kinds = useMemo(() => scanKinds(scan), [scan])
  const pagesOnly = done && !scanError && !kinds.apis && kinds.pages
  const scanErrN = scan ? scan.errors.length + scan.projects.reduce((n, p) => n + p.errors.length, 0) : 0

  /** 中间「实时发现」：有树就画树，否则明确空态，绝不留空 div */
  const discoverBody = (() => {
    if (scanning) {
      // 解析阶段一个 Controller 都报不出来：判定要等整个工程解析完（HierarchyResolver 要看
      // 完整棵类目录），单工程扫描时那是全程最后一步。这里就照实空着 —— 不要拿「解析到第几个
      // 文件」去填，用户要的是接口列表，一句会动的进度话只是把「没内容」换成「假装有内容」。
      if (liveTree.length === 0) {
        return <p className="apf-empty apf-discover-empty">等待发现第一个 Controller…</p>
      }
      return <LiveDiscover tree={liveTree} />
    }
    if (scan && scanCtrlCount > 0) {
      return <ScanDiscover projects={scan.projects} />
    }
    // 权威结果没 Controller，但 PROG 里攒过树：兜底画出来，避免中间栏全黑
    if (liveTree.length > 0) return <LiveDiscover tree={liveTree} />
    if (scan) {
      return (
        <p className="apf-empty apf-discover-empty">
          扫描完成，但没发现带 HTTP 映射的 Controller。只认 @RestController / @Controller，且方法上要有
          Get/Post/Put/Delete/PatchMapping。
        </p>
      )
    }
    return <p className="apf-empty apf-discover-empty">等待扫描结果…</p>
  })()

  return (
    <div className="apf-scanwork">
      {/* HUD 压成一行摘要：状态 + KPI + 动作，别占半屏 */}
      <div className={`apf-panel apf-first apf-hud${scanning ? ' live' : ''}`}>
        <div className="apf-hud-row">
          <div className="apf-hud-lead">
            <h2 className="apf-hud-title">
              {scanning ? '正在扫描工程目录' : scanError ? '扫描失败' : scan ? '扫描完成' : '还没有扫描'}
            </h2>
            <p className="apf-hud-detail" title={scanning && lastLine ? lastLine : (scan?.root ?? root)}>
              {scanning && lastLine ? lastLine : (scan?.root ?? root)}
            </p>
          </div>
          <div className="apf-kpis">
            <div>
              <b>
                {scanning
                  ? `${doneProjects}/${queue.projects.length}`
                  : (scan?.projects.length ?? 0)}
              </b>
              <span>工程</span>
            </div>
            {!pagesOnly && (
              <>
                <div>
                  <b>{scanning ? liveApiCount : scan ? apiTotal(scan) : 0}</b>
                  <span>接口</span>
                </div>
                <div>
                  <b>{scanning ? liveCtrlCount : scanCtrlCount}</b>
                  <span>Controller</span>
                </div>
              </>
            )}
            {done && pageTotal > 0 && (
              <div>
                <b>{pageTotal}</b>
                <span>页面</span>
              </div>
            )}
          </div>
          <div className="apf-hud-actions">
            {scanning && <Btn onClick={() => void stopScan()}>停止扫描</Btn>}
            {!scanning && scanError && (
              <>
                {/* 重试扫刚才失败的那个目录（输入框里的），空了才退回当前工程 */}
                <Btn variant="primary" onClick={() => void doScan()}>
                  重试
                </Btn>
                <Btn onClick={focusScanRoot}>换目录</Btn>
                {scan && <Btn onClick={() => setView('apis')}>查看上次的接口</Btn>}
              </>
            )}
            {done && !scanError && (
              <>
                <Btn variant="primary" onClick={() => setView(pagesOnly ? 'pages' : 'apis')}>
                  {pagesOnly ? '查看页面' : '查看接口'}
                </Btn>
                <Btn onClick={() => void doScan(scan?.root)}>重新扫描</Btn>
                <Btn onClick={focusScanRoot}>换个工程</Btn>
              </>
            )}
          </div>
        </div>
        {/* 扫描器不报总进度，只给不定进度条，不写假百分比 */}
        {scanning && (
          <div className="apf-meter compact">
            <div className="apf-meter-track">
              <div className="apf-meter-fill apf-meter-indet" />
            </div>
          </div>
        )}
      </div>

      {scanError && <div className="apf-band bad">原因：{scanError}</div>}

      {/* 单列：扫描中工程进度横条顶置；扫完队列与发现树重复，不再单开左栏留空 */}
      <div className="apf-scan-body">
        {scanning && (
          <div className="apf-panel apf-scan-queue">
            <div className="apf-panel-h row-between">
              <span>工程队列</span>
              <span className="apf-discover-hcount">
                {doneProjects}/{queue.projects.length || 0} 完成
              </span>
            </div>
            <div className="apf-queue-strip">
              {queue.projects.map((p) => {
                const pct =
                  p.status === 'done'
                    ? 100
                    : p.files && p.files.total > 0
                      ? Math.round((p.files.done / p.files.total) * 100)
                      : 0
                return (
                  <div key={p.name} className={`apf-cq st-${p.status}`}>
                    <div className="apf-cq-top">
                      <span className="apf-cq-name">{p.name}</span>
                      <span className="apf-cq-badge">{QUEUE_BADGE[p.status]}</span>
                    </div>
                    <div className="apf-cq-bar">
                      <i style={{ width: `${pct}%` }} />
                    </div>
                    <div className="apf-cq-count">
                      {p.status === 'waiting' && '待解析'}
                      {p.status === 'parsing' &&
                        (p.files ? `${p.files.done}/${p.files.total} · ${p.apis} 个接口` : '解析中…')}
                      {p.status === 'done' && `${p.controllers} 个 Controller · ${p.apis} 个接口`}
                      {p.status === 'fail' && '失败'}
                    </div>
                  </div>
                )
              })}
              {queue.projects.length === 0 && (
                <p className="apf-empty">等待扫描器发现工程…</p>
              )}
            </div>
          </div>
        )}

        {pagesOnly ? (
          <div className="apf-panel apf-scan-discover">
            <p className="apf-empty apf-discover-empty">
              扫出 {pageTotal} 个页面（{[pageN.ftl && `FTL ${pageN.ftl} 个`, pageN.vue && `Vue ${pageN.vue} 个`]
                .filter(Boolean)
                .join('，')}），去「页面测试」跑。
            </p>
          </div>
        ) : (
        <div className="apf-panel apf-scan-discover">
          <div className="apf-panel-h row-between">
            <span>发现的接口</span>
            <span className="apf-discover-hcount">
              {scanning ? '实时更新' : ''}
            </span>
          </div>
          {discoverBody}
        </div>
        )}

        {/* 纯前端的流水只讲 Java 解析，没用；有解析失败时留着看原因 */}
        {(!pagesOnly || scanErrN > 0) && (
        <div className="apf-panel apf-scan-logpane">
          <button
            type="button"
            className="apf-panel-h row-between apf-log-toggle"
            onClick={() => setLogOpen((o) => !o)}
            title={logOpen ? '收起解析流水' : '展开解析流水'}
          >
            <span>解析流水</span>
            <span className="apf-log-chev">{logOpen ? '▾' : '▸'}</span>
          </button>
          {logOpen && (
            <pre className="apf-log" ref={logRef}>
              {scanning
                ? displayLog.join('\n') || '等待扫描输出…'
                : logLines.length
                  ? logLines.join('\n')
                  : '等待扫描输出…'}
            </pre>
          )}
        </div>
        )}
      </div>
    </div>
  )
}
