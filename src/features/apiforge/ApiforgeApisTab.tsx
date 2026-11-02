/**
 * 接口库页：左树（大目录 → 工程 → Controller → 接口，带搜索）
 * + 右详情。右栏第一张卡永远是「接口调试（HTTP + 库变更）」——布局纪律的产物首卡。
 */
import { useCallback, useEffect, Fragment, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { App as AntdApp, Modal } from 'antd'
import { AimOutlined, ApiOutlined } from '@ant-design/icons'
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import { Btn, Card, Cb, cx, Fld, Lbl, PopSel, Row, Seg, Sel, TextArea, useCopy, type SelOption } from '../../components/ui'
import { useApiforgeStore } from '../../store/useApiforgeStore'
import { useLicenseStore } from '../../store/useLicenseStore'
import { useSchemaStore } from '../../store/useSchemaStore'
import { useUiStore } from '../../store/useUiStore'
import { canAiContextExport, canBatchCases } from '../../lib/license'
import { mergeLinks, resolveLinks } from '../../lib/apiforge/link/resolveLinks'
import { buildBody, generateCases } from '../../lib/apiforge/cases/generate'
import { dictOfScan } from '../../lib/apiforge/scan/bodyFields'
import { assembleDocsChunked, docsToHtml, docsToMarkdown, docsToOpenApi } from '../../lib/apiforge/docs/docs'
import { changeLine } from '../../lib/apiforge/report'
import { quickCheckSql } from '../../lib/apiforge/dbjump'
import { CI_EXPORTS_SHOWN } from '../../lib/apiforge/views'
import { API_ACTION_LABEL, apiActionOf, guessApiAction, isReadAction } from '../../lib/apiforge/cases/apiAction'
import { buildRequest, resolveBaseUrl } from '../../lib/apiforge/http/request'
import { prettyJson } from '../../lib/apiforge/http/prettyJson'
import type {
  ApiAction,
  ApiMethod,
  CaseRunResult,
  CaseType,
  ProjectScanResult,
  TableRelation,
  TestCase,
  WorkspaceScanResult,
} from '../../lib/apiforge/types'
import { runSingleCase } from './apiforgeRun'
import { docsToAiContext, junitForApi, runApiCases, runControllerCases } from '@pro'
import { pickSendCase } from '../../lib/apiforge/cases/pickSendCase'
import { cleanBodyExpects, cloneExpects, originOf, parseExpectStatus, regenerateKeeping, type CasePatch } from '../../lib/apiforge/cases/caseEdit'
import { isFailed, resultState } from '../../lib/apiforge/runner/resultState'
import { CaseExpectEditor } from './CaseExpectEditor'
import { download } from './download'
import { whoLine } from '../../lib/apiforge/docmeta'
import { paramHint } from '../../lib/apiforge/paramHint'
import { ResponsePreview, Verb } from './apiforgeBits'
import { ApfEmpty } from './ApfEmpty'
import { capRows, hitParts, normalizeApiQuery, pathMatches } from '../../lib/apiforge/uiSearch'
import { toCurl } from '../../lib/apiforge/curl'
import { jsonProblem } from '../../lib/apiforge/http/jsonCheck'

/** 接口类型下拉：auto = 不手改，按请求方法和接口名自动认 */
type ActionChoice = ApiAction | 'auto'
const ACTION_NAME: Record<ApiAction, string> = {
  query: '查询',
  insert: '新增',
  update: '修改',
  delete: '删除',
  unknown: '认不出',
}

/** 手改接口类型：存下来，再把自动生成的用例按新类型重建（改过的、手加的不动）。接口详情和「认不出的接口」清单共用 */
async function applyApiAction(api: ApiMethod, action: ApiAction | null): Promise<ApiMethod> {
  await useApiforgeStore.getState().setApiAction(api.id, action)
  const st = useApiforgeStore.getState()
  const { action: _old, ...base } = api
  const nextApi: ApiMethod = action ? { ...base, action } : base
  const dict = dictOfScan(st.scan)
  const generated = generateCases(nextApi, dict, st.scan)
  const fresh = st.fullBodyDefault ? fillFullBody(nextApi, dict, generated) : generated
  const next = regenerateKeeping(st.cases[api.id] ?? [], fresh)
  void st.setCasesFor(api.id, next)
  const ids = new Set(next.map((c) => c.id))
  useApiforgeStore.setState({ results: st.results.filter((r) => r.apiId !== api.id || ids.has(r.caseId)) })
  return nextApi
}

/** 认不出类型（树上显示「?」）的接口集中在一个清单里改，不用一个个点开找（用户 10-20） */
function UnknownActions({ scan }: { scan: WorkspaceScanResult }) {
  const { message } = AntdApp.useApp()
  const [open, setOpen] = useState(false)
  // 打开时定下清单：改完一个不从列表里跳走，看得见自己改成了什么
  const [list, setList] = useState<{ api: ApiMethod; project: string }[]>([])
  const [picked, setPicked] = useState<Record<string, ApiAction>>({})
  const unknown = useMemo(
    () =>
      scan.projects.flatMap((p) =>
        p.controllers.flatMap((c) =>
          c.methods.filter((m) => apiActionOf(m) === 'unknown').map((api) => ({ api, project: p.projectName })),
        ),
      ),
    [scan],
  )
  if (!unknown.length && !open) return null
  const choices: SelOption<ApiAction>[] = (['query', 'insert', 'update', 'delete'] as const).map((a) => ({ value: a, label: ACTION_NAME[a] }))
  return (
    <>
      <button
        type="button"
        className="apf-linkbtn apf-unknownact"
        title="树上显示「?」的接口：按请求方法和接口名认不出是查 / 增 / 改 / 删，在这里一次改完"
        onClick={() => {
          setList(unknown)
          setPicked({})
          setOpen(true)
        }}
      >
        认不出类型的接口 {unknown.length} 个，点这里集中改
      </button>
      <Modal
        open={open}
        title={`认不出类型的接口（${list.length} 个）`}
        width={760}
        footer={null}
        onCancel={() => setOpen(false)}
      >
        <p className="apf-hint">给每个接口选一下是查询、新增、修改还是删除，选了就存，自动生成的用例跟着重建。不确定的先空着。</p>
        <div className="apf-unknownlist">
          {list.map(({ api, project }) => (
            <div key={api.id} className="apf-unknownrow">
              <Verb method={api.httpMethod} />
              <span className="apf-path" title={`${project} · ${api.path}`}>
                {api.path}
              </span>
              <span className="apf-mini">{api.description || project}</span>
              <Sel<ApiAction | ''>
                value={picked[api.id] ?? ''}
                options={[{ value: '', label: '— 选类型 —' }, ...choices]}
                onChange={(v) => {
                  if (!v) return
                  setPicked((s) => ({ ...s, [api.id]: v }))
                  void applyApiAction(api, v).then(() => message.success(`${api.path} 改成「${ACTION_NAME[v]}」`))
                }}
              />
            </div>
          ))}
        </div>
      </Modal>
    </>
  )
}

/** 连库查询「查接口 ↗」焦点已消费到的 ts。模块级：接口库页随子页签切换卸载重挂，
 *  ref 记不住，旧焦点会被重放一遍（重复展开 + 重复 persist links）。 */
let apisFocusSeen = 0

/** 左树的搜索词和展开状态：切页签会卸载本组件，记在模块级，回来原样 */
const railMemo: { q: string; projOpen: Record<string, boolean>; expanded: Record<string, boolean> } = {
  q: '',
  projOpen: {},
  expanded: {},
}

/** 接口所在的工程和 Controller（展开路径）；找不到给 null */
function locateApi(
  scan: { projects: ProjectScanResult[] } | null,
  apiId: string | null,
): { projectId: string; ctrlKey: string } | null {
  if (!scan || !apiId) return null
  for (const p of scan.projects) {
    for (const c of p.controllers) {
      if (c.methods.some((m) => m.id === apiId)) return { projectId: p.projectId, ctrlKey: c.filePath }
    }
  }
  return null
}

export function ApiforgeApisTab() {
  const { message } = AntdApp.useApp()
  const scan = useApiforgeStore((s) => s.scan)
  const selectedApiId = useApiforgeStore((s) => s.selectedApiId)
  const selectApi = useApiforgeStore((s) => s.selectApi)
  const setView = useApiforgeStore((s) => s.setView)
  const links = useApiforgeStore((s) => s.links)
  const cases = useApiforgeStore((s) => s.cases)
  const env = useApiforgeStore((s) => s.env)
  const setLinksFor = useApiforgeStore((s) => s.setLinksFor)
  const results = useApiforgeStore((s) => s.results)
  const railW = useApiforgeStore((s) => s.railW)
  const setRailW = useApiforgeStore((s) => s.setRailW)
  const persistUi = useApiforgeStore((s) => s.persistUi)
  const [q, setQ] = useState(() => railMemo.q)
  // 树默认只放工程行：工程、Controller 两层都折叠（点击逐层展开），搜索时全放开。
  // 回到本页时沿用上次的展开，并把当前接口所在的路径打开
  const [projOpen, setProjOpen] = useState<Record<string, boolean>>(() => {
    const st = useApiforgeStore.getState()
    const at = locateApi(st.scan, st.selectedApiId)
    return at ? { ...railMemo.projOpen, [at.projectId]: true } : railMemo.projOpen
  })
  /** Controller 层的接口展开表：多工程默认收起（不然几千行），点头展开；搜索时全展开 */
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const st = useApiforgeStore.getState()
    const at = locateApi(st.scan, st.selectedApiId)
    return at ? { ...railMemo.expanded, [at.ctrlKey]: true } : railMemo.expanded
  })
  useEffect(() => {
    railMemo.q = q
    railMemo.projOpen = projOpen
    railMemo.expanded = expanded
  }, [q, projOpen, expanded])

  /**
   * 搜索态的渲染预算。搜索 = 工程、Controller 全展开，几千接口全命中时一次
   * 就是上万行 DOM，每个键击重渲一遍必卡（几千个接口搜单字就到顶）。
   * 超出预算的行数按 Controller 诚实标出来，引导收窄搜索词。
   */
  const SEARCH_RENDER_CAP = 400
  const railRef = useRef<HTMLElement>(null)
  /** 右栏滚动容器：切接口时回顶——上一接口留下的滚动位置会让人「迷路」 */
  const paneRef = useRef<HTMLElement>(null)
  const [dragging, setDragging] = useState(false)

  /** 拖右缘调宽（280–720px），松手落盘，双击回默认 */
  const startRailResize = (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = railRef.current?.getBoundingClientRect().width ?? 340
    setDragging(true)
    const move = (ev: globalThis.PointerEvent) => {
      const w = Math.min(720, Math.max(280, Math.round(startW + ev.clientX - startX)))
      setRailW(w)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragging(false)
      void persistUi()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const failedApiIds = useMemo(
    () => new Set(results.filter(isFailed).map((r) => r.apiId)),
    [results],
  )

  /**
   * 接口层 → 报告：树上/详情里的失败标记点了就跳，报告页自动筛失败并
   * 落到该接口第一条失败用例的处理抽屉。带焦点过去，不让用户再手动切页签翻表。
   */
  const jumpToReport = (focus: { apiId?: string; project?: string; controller?: { name: string; apiIds: string[] } }) => {
    useApiforgeStore.getState().setReportFocus(focus)
    setView('report')
  }

  /**
   * 四个导出共用的「生成中」态。assembleDocs 对几千接口是几百毫秒到秒级的重活
   * （buildBody 造嵌套骨架是大头），整包同步跑主线程卡死，点了毫无反应——
   * 用户原话「点了后一下子没反应，太突兀」。所以分帧跑（assembleDocsChunked）
   * + 按钮就地出百分比 + keyed loading toast，点了立刻有反馈，跑完原位收掉。
   */
  const [busy, setBusy] = useState<{ what: 'md' | 'html' | 'openapi' | 'ai'; pct: number } | null>(null)

  /** 接口文档一键导出（PRD v0.4 模块 4.7）：数据就是现有扫描结果 + 用户勾选的关联表 */
  const exportDocs = async (fmt: 'md' | 'html' | 'openapi') => {
    if (!scan) return
    if (busy) {
      void message.warning('正在生成，先等这一轮结束')
      return
    }
    const key = `apf-doc-${fmt}`
    void message.loading({ key, content: '正在生成文档…', duration: 0 })
    setBusy({ what: fmt, pct: 0 })
    try {
      const docs = await assembleDocsChunked(scan, links, (done, total) => {
        // 组装占 0–90%；后面压格式 + 触发下载通常是一瞬间，不单拆档位
        const pct = Math.round((done / Math.max(1, total)) * 90)
        setBusy({ what: fmt, pct })
        void message.loading({ key, content: `正在生成文档… ${pct}%`, duration: 0 })
      })
      if (!docs.length) {
        void message.warning({ key, content: '没有接口可导出' })
        return
      }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
      const name =
        fmt === 'md' ? `apiforge-docs-${stamp}.md` : fmt === 'html' ? `apiforge-docs-${stamp}.html` : `apiforge-openapi-${stamp}.json`
      if (fmt === 'md') download(name, docsToMarkdown(docs), 'text/markdown')
      else if (fmt === 'html') download(name, docsToHtml(docs), 'text/html')
      else download(name, docsToOpenApi(docs, { baseUrl: env.baseUrl }), 'application/json')
      void message.success({ key, content: `接口文档已导出到「下载」文件夹：${name}（${docs.length} 个接口）`, duration: 5 })
    } catch (e) {
      void message.error({ key, content: `文档生成失败：${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setBusy(null)
    }
  }

  /**
   * AI 上下文一键复制（定位「接口上下文提取器」的第一块）：扫描结果压成
   * 扁平 Markdown，粘贴给 Cursor / Claude 写单测、文档、调用代码。
   * 剪贴板失败兜底下载 .md（useCopy 的 legacy 兜底之下仍可能失败，如非安全上下文）。
   */
  const { state: copyState, copy } = useCopy()
  // 付费点：整包 AI 上下文是专业版功能；MD / HTML / OpenAPI 导出与单接口冒烟免费保留
  const isPro = useLicenseStore((s) => s.isPro)
  const exportAiContext = async () => {
    if (!canAiContextExport(isPro)) {
      useLicenseStore.getState().openUpgrade()
      return
    }
    if (!scan) return
    if (busy) {
      void message.warning('正在生成，先等这一轮结束')
      return
    }
    const key = 'apf-doc-ai'
    void message.loading({ key, content: '正在生成 AI 上下文…', duration: 0 })
    setBusy({ what: 'ai', pct: 0 })
    try {
      const docs = await assembleDocsChunked(scan, links, (done, total) => {
        const pct = Math.round((done / Math.max(1, total)) * 90)
        setBusy({ what: 'ai', pct })
        void message.loading({ key, content: `正在生成 AI 上下文… ${pct}%`, duration: 0 })
      })
      if (!docs.length) {
        void message.warning({ key, content: '没有接口可导出' })
        return
      }
      // 压平 + 写剪贴板：大字符串 writeText 也要一小会，让进度条先爬到头
      setBusy({ what: 'ai', pct: 95 })
      const text = docsToAiContext(docs)
      if (await copy(text)) {
        void message.success({ key, content: `AI 上下文已复制（${docs.length} 个接口），可直接粘贴给 Cursor / Claude` })
        return
      }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
      const name = `apiforge-ai-context-${stamp}.md`
      download(name, text, 'text/markdown')
      void message.success({ key, content: `剪贴板不可用，已保存到「下载」文件夹：${name}（${docs.length} 个接口）`, duration: 5 })
    } catch (e) {
      void message.error({ key, content: `AI 上下文生成失败：${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setBusy(null)
    }
  }

  /** 搜索过滤后的树：路径 / 类名 / 描述命中即留，工程下全空则整工程隐藏。
   *  搜索态另吃渲染预算（SEARCH_RENDER_CAP）：超出的行不渲染、按 Controller
   *  报数——几千接口全展开渲染是每个键击一次的重活，截掉的部分明说。 */
  const tree = useMemo(() => {
    if (!scan) return []
    // 粘贴的完整地址先去掉主机和查询串，路径按后半段匹配（兼容上下文路径）
    const s = normalizeApiQuery(q)
    const active = q.trim() !== ''
    let budget = SEARCH_RENDER_CAP
    const out: {
      project: ProjectScanResult
      controllers: {
        controller: (typeof scan.projects)[number]['controllers'][number]
        methods: (typeof scan.projects)[number]['controllers'][number]['methods']
        shown: (typeof scan.projects)[number]['controllers'][number]['methods']
        omitted: number
      }[]
      omitted: number
    }[] = []
    for (const p of scan.projects) {
      const controllers = [] as (typeof out)[number]['controllers']
      let projOmitted = 0
      for (const c of p.controllers) {
        const methods = active
          ? c.methods.filter(
              (m) =>
                pathMatches(m.path, s) ||
                m.controllerClass.toLowerCase().includes(s) ||
                m.methodName.toLowerCase().includes(s) ||
                c.className.toLowerCase().includes(s) ||
                (c.description && c.description.toLowerCase().includes(s)) ||
                m.description.includes(q.trim()),
            )
          : c.methods
        if (methods.length === 0) continue
        // 非搜索态不裁：默认全折叠，展开多少是用户自己的选择
        const { shown, omitted } = active
          ? capRows(methods, budget)
          : { shown: methods, omitted: 0 }
        budget -= shown.length
        projOmitted += omitted
        controllers.push({ controller: c, methods, shown, omitted })
      }
      if (controllers.length > 0) out.push({ project: p, controllers, omitted: projOmitted })
    }
    return out
  }, [scan, q])

  /** 选中的接口及其工程。纯查找很便宜，不值得 useMemo */
  const selected = (() => {
    if (!scan) return null
    for (const p of scan.projects) {
      for (const c of p.controllers) {
        const m = c.methods.find((x) => x.id === selectedApiId)
        if (m) return { api: m, project: p }
      }
    }
    return null
  })()

  /**
   * 点接口：选中 + 立刻认表/造用例。放在点击处理器而不是 effect——
   * resolveLinks/generateCases 是便宜纯函数，同步做完就没有「闪一帧旧数据」，
   * 也省掉 exhaustive-deps 里那串「故意只触发一次」的依赖豁免。
   */
  const openApi = (api: ApiMethod, project: ProjectScanResult) => {
    selectApi(api.id)
    // 滚动回顶：详情首卡从身份行读起，不继承上一接口的滚动位置
    paneRef.current?.scrollTo({ top: 0 })
    const st = useApiforgeStore.getState()
    const merged = mergeLinks(resolveLinks(api, project, false), st.links[api.id] ?? [])
    void st.setLinksFor(api.id, merged)
    const dict = dictOfScan(st.scan)
    const existing = st.cases[api.id]
    let next = existing ?? generateCases(api, dict, st.scan)
    // 「默认全字段」偏好开着：点开接口就把最小 body 展开成骨架，不用每次手点
    if (st.fullBodyDefault) next = fillFullBody(api, dict, next)
    if (next !== existing) void st.setCasesFor(api.id, next)
  }

  /** 连库查询「查接口 ↗」的焦点，消费过哪次记在模块级：useRef 会随子页签
      切换卸载重挂归零，旧焦点就重放了——必须活过重挂（同 ApiforgePage.resumeAsked） */
  const apisFocus = useApiforgeStore((s) => s.apisFocus)
  useEffect(() => {
    if (!apisFocus || apisFocus.ts === apisFocusSeen) return
    apisFocusSeen = apisFocus.ts
    const st = useApiforgeStore.getState()
    if (!st.scan) return
    for (const p of st.scan.projects) {
      for (const c of p.controllers) {
        const m = c.methods.find((x) => x.id === apisFocus.apiId)
        if (!m) continue
        // 搜索态开着时目标行可能被滤掉：先清掉，展开链路才看得见
        setQ('')
        setProjOpen((s) => ({ ...s, [p.projectId]: true }))
        setExpanded((s) => ({ ...s, [c.filePath]: true }))
        openApi(m, p)
        // 状态提交后再滚：行还没渲染出来 scrollIntoView 找不到目标
        window.setTimeout(() => {
          const row = railRef.current?.querySelector(`[data-apfid="${CSS.escape(m.id)}"]`)
          row?.scrollIntoView({ block: 'nearest' })
        }, 0)
        return
      }
    }
    // openApi 是组件内闭包（store 方法都从 getState 取），焦点变化时它不构成新依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apisFocus])

  const searching = q.trim() !== ''

  /** 把当前接口滚进左树可视范围（等展开的行渲染出来再滚） */
  const scrollToSelected = () =>
    window.setTimeout(() => {
      const id = useApiforgeStore.getState().selectedApiId
      if (!id) return
      railRef.current?.querySelector(`[data-apfid="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
    }, 0)
  /** 清空搜索：回到折叠树，但保留当前接口所在的展开路径 */
  const clearSearch = () => {
    setQ('')
    const at = locateApi(scan, selectedApiId)
    if (!at) return
    setProjOpen((s) => ({ ...s, [at.projectId]: true }))
    setExpanded((s) => ({ ...s, [at.ctrlKey]: true }))
    scrollToSelected()
  }
  // 回到本页时把当前接口滚出来；按 / 聚焦搜索框（输入框里按不算）
  useEffect(() => {
    const t = scrollToSelected()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))) return
      const box = railRef.current?.querySelector<HTMLInputElement>('.apf-searchrow input')
      if (!box) return
      e.preventDefault()
      box.focus()
      box.select()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('keydown', onKey)
    }
    // 只在挂载时做一次；scrollToSelected 里的值都从 getState / ref 取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!scan || scan.projects.length === 0) {
    return (
      <div className="apf-pane">
        <div className="apf-panel">
          <div className="apf-panel-h">接口</div>
          <ApfEmpty
            icon={<ApiOutlined aria-hidden />}
            title="还没有接口"
            desc="扫描会读本机 Spring Boot 源码，把所有 Controller 和接口列在这里——纯本地解析，不上传源码。"
            steps={[
              '到「扫描」页选工程目录（多模块 / 多工程可以一起扫）',
              '点开始扫描，几秒到几分钟（看工程大小），结果存本地缓存下次秒回',
              '回来浏览接口、调试、导出 AI 上下文喂给 Cursor / Claude',
            ]}
            action={{ label: '去扫描', onClick: () => setView('scan') }}
          />
        </div>
      </div>
    )
  }

  return (
    <div
      className={`apf-split${dragging ? ' dragging' : ''}`}
      style={{ '--rail-w': railW != null ? `${railW}px` : undefined } as CSSProperties}
    >
      <aside className="apf-rail" ref={railRef}>
        <div className="apf-searchrow">
          <Fld
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && q) {
                e.preventDefault()
                clearSearch()
              }
            }}
            placeholder="搜路径 / 类名 / 说明，可粘完整地址"
            title={`工作区：${scan.root}\n按 / 聚焦搜索，Esc 清空`}
          />
          {searching && (
            <button className="apf-qclear" title="清空搜索（Esc）" aria-label="清空搜索" onClick={clearSearch}>
              ×
            </button>
          )}
          {/* 四种导出收成一个菜单，把竖向空间让给接口树 */}
          <PopSel<'' | 'md' | 'html' | 'openapi' | 'ai'>
            className="apf-exportmenu"
            value=""
            displayLabel={busy ? `生成中 ${busy.pct}%` : copyState === 'ok' ? '已复制' : '导出'}
            disabled={!!busy}
            aria-label="导出"
            title="导出接口文档，或复制给 AI 用的接口说明"
            options={[
              { value: 'md', label: '接口文档（Markdown）' },
              { value: 'html', label: '接口文档（网页）' },
              { value: 'openapi', label: '接口定义（OpenAPI 格式）' },
              { value: 'ai', label: isPro ? '复制给 AI 用的接口说明' : '复制给 AI 用的接口说明（专业版）' },
            ]}
            onChange={(v) => {
              if (v === 'ai') void exportAiContext()
              else if (v) void exportDocs(v)
            }}
          />
        </div>
        <UnknownActions scan={scan} />
        <div className="apf-tree">
          {tree.map(({ project, controllers }) => {
            // 默认折叠；搜索时全放开——搜命中了却折叠着，等于搜索坏了
            const open = searching || !!projOpen[project.projectId]
            const projFailN = controllers.reduce((n, c) => n + c.methods.filter((m) => failedApiIds.has(m.id)).length, 0)
            return (
              <div key={project.projectId} className="apf-projblock">
                <button
                  className="apf-projrow"
                  // 直接对当前 state 取反才是切换；用 !open 等于把 open 再取反一次，
                  // 写回去的永远是原值（展开时点收缩写 false，等于没点）
                  onClick={() =>
                    setProjOpen((s) => ({ ...s, [project.projectId]: !s[project.projectId] }))
                  }
                >
                  <span className="apf-chev">{open ? '▾' : '▸'}</span>
                  <span className="apf-projname">
                    {searching ? <HitText text={project.projectName} q={q} /> : project.projectName}
                  </span>
                  {projFailN > 0 && (
                    <span
                      className="apf-failn clickable"
                      role="button"
                      title={`${projFailN} 个接口失败，点开报告`}
                      onClick={(e) => {
                        e.stopPropagation()
                        jumpToReport({ project: project.projectName })
                      }}
                    >
                      {projFailN}
                    </span>
                  )}
                  <span className="apf-projcount">
                    {controllers.reduce((m, c) => m + c.methods.length, 0)}
                  </span>
                </button>
                {open &&
                  controllers.map(({ controller: c, methods, shown, omitted }) => {
                    // Controller 也默认收起：树先只放工程，点工程出 Controller，再点才出接口
                    const ctrlOpen = searching || !!expanded[c.filePath]
                    const ctrlFailN = methods.filter((m) => failedApiIds.has(m.id)).length
                    return (
                      <div key={c.filePath} className="apf-ctrlnested">
                        {/* 树上只放类名：业务描述、作者·日期窄栏都放不下，
                            悬浮时一起进 title（描述优先；与 ApiforgePage 的 Controller 行同一条口径） */}
                        <button
                          className="apf-ctrlh"
                          onClick={() => setExpanded((s) => ({ ...s, [c.filePath]: !ctrlOpen }))}
                          title={
                            [c.description, whoLine(c)].filter(Boolean).join(' · ') ||
                            (ctrlOpen ? '收起接口' : '展开接口')
                          }
                        >
                          <span className="apf-ctrlleft">
                            <span className="apf-chev">{ctrlOpen ? '▾' : '▸'}</span>
                            <span className="apf-ctrlname">
                              {searching ? <HitText text={c.className} q={q} /> : c.className}
                            </span>
                            {ctrlFailN > 0 && (
                              <span
                                className="apf-failn clickable"
                                role="button"
                                title={`${ctrlFailN} 个接口失败，点开报告（只看这个 Controller）`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  jumpToReport({ controller: { name: c.className, apiIds: methods.map((m) => m.id) } })
                                }}
                              >
                                {ctrlFailN}
                              </span>
                            )}
                          </span>
                          {/* 接口数 */}
                          <span className="apf-ctrlcount">{methods.length}</span>
                        </button>
                        {ctrlOpen &&
                          shown.map((m) => (
                            <button
                              key={m.id}
                              data-apfid={m.id}
                              className={`apf-apirow${m.id === selectedApiId ? ' on' : ''}${failedApiIds.has(m.id) ? ' has-fail' : ''}`}
                              onClick={() => openApi(m, project)}
                              title={`${m.httpMethod} ${m.path}${m.description ? ` · ${m.description}` : ''}`}
                            >
                              <Verb method={m.httpMethod} />
                              <span
                                className={cx('apf-acttag', m.action && 'manual')}
                                title={m.action ? '手改过的接口类型' : '按请求方法和接口名自动认的类型，点开接口可以改'}
                              >
                                {API_ACTION_LABEL[apiActionOf(m)]}
                              </span>
                              <span className="apf-path">
                                {searching ? <HitText text={m.path} q={q} /> : m.path}
                              </span>
                              {failedApiIds.has(m.id) && (
                                <span
                                  className="apf-faildot clickable"
                                  role="button"
                                  title="最近跑批失败，点开报告定位这条"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    jumpToReport({ apiId: m.id })
                                  }}
                                />
                              )}
                            </button>
                          ))}
                        {/* 渲染预算截断的尾巴要明说：不写，用户会以为搜索漏了 */}
                        {ctrlOpen && omitted > 0 && (
                          <p className="apf-more" title={`超过单次渲染上限 ${SEARCH_RENDER_CAP} 行的截断提示`}>
                            还有 {omitted} 条未显示 · 收窄搜索词
                          </p>
                        )}
                      </div>
                    )
                  })}
              </div>
            )
          })}
          {tree.length === 0 && <p className="apf-empty">没有匹配「{q}」的接口</p>}
        </div>
        <i
          className="apf-railresizer"
          title="拖动改变左树宽度，双击恢复默认"
          onPointerDown={startRailResize}
          onDoubleClick={() => {
            setRailW(null)
            void persistUi()
          }}
        />
      </aside>
      <section className="apf-pane" ref={paneRef}>
        {selected ? (
          <ApiDetail
            key={selected.api.id}
            api={selected.api}
            project={selected.project}
            links={mergeLinks(resolveLinks(selected.api, selected.project, false), links[selected.api.id] ?? [])}
            cases={cases[selected.api.id] ?? []}
            onToggleLink={(table, on) => {
              // 对显示出来的合并列表改（同关联表页）：重扫后新识别的表还没存盘，只改存盘的会点了没反应
              const next = mergeLinks(resolveLinks(selected.api, selected.project, false), links[selected.api.id] ?? []).map((x) =>
                x.tableName === table ? { ...x, enabled: on } : x,
              )
              void setLinksFor(selected.api.id, next)
            }}
            onAddLink={(table) => {
              const cur = mergeLinks(resolveLinks(selected.api, selected.project, false), links[selected.api.id] ?? [])
              const next: TableRelation[] = [
                ...cur.filter((x) => x.tableName !== table),
                { tableName: table, confidence: 'user', source: '手动添加', enabled: true },
              ]
              void setLinksFor(selected.api.id, next)
            }}
            onQuickRun={(caseId) => runSingleCase(selected.api, message, caseId)}
          />
        ) : (
          <div className="apf-panel">
            <div className="apf-panel-h">接口调试</div>
            <ApfEmpty
              icon={<AimOutlined aria-hidden />}
              title="从左侧选一个接口"
              desc="选中后自动生成正常 / 边界 / 异常用例，改参数点「发送」就能看响应和库变更。"
              steps={[
                '展开工程 → Controller，点一个接口',
                '也可以在左上角搜路径、类名、说明，或直接粘贴完整地址',
              ]}
            />
          </div>
        )}
      </section>
    </div>
  )
}

/** 等待秒数（0.1s 步进）。单独成组件：每 100ms 只重画这几个字，不带着整张调试卡（含大响应）一起重画 */
function WaitTimer({ label }: { label: string }) {
  const [sec, setSec] = useState(0)
  useEffect(() => {
    const t0 = Date.now()
    const timer = setInterval(() => setSec((Date.now() - t0) / 1000), 100)
    return () => clearInterval(timer)
  }, [])
  return (
    <>
      {label} {sec.toFixed(1)}s
    </>
  )
}

/** 搜索态把命中片段标亮（<mark class="apf-hit">）；分词边界/元字符转义在 uiSearch 落测 */
function HitText({ text, q }: { text: string; q: string }) {
  return (
    <>
      {hitParts(text, q).map((seg, i) =>
        seg.hit ? (
          <mark key={i} className="apf-hit">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  )
}

/**
 * 「默认全字段」的展开：第一条正常用例的 body 还是最小合法（{}，09-17 口径）
 * 时，按类型字典展开成全字段骨架——detailList 这类嵌套集合就在这一步长出来。
 * 与「填入全部字段」按钮同一条写回路径（面板所见即用例所存，回归也发这些字段），
 * 所以它挂在显式偏好开关上而不是默认行为。
 */
function fillFullBody(api: ApiMethod, dict: ReturnType<typeof dictOfScan>, cases: TestCase[]): TestCase[] {
  if (api.requestBodyFields.length === 0) return cases
  const target =
    cases.find((c) => c.enabled && c.type === 'normal') ??
    cases.find((c) => c.type === 'normal') ??
    cases[0]
  if (!target) return cases
  const raw = target.parameters.__body
  const s = raw === undefined || raw === null ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw)
  // 只展开还空着的 body；用户编辑过的、生成器已给骨架的（如分页）原样保留
  if (s.trim() !== '' && s.trim() !== '{}') return cases
  return cases.map((c) =>
    c.id === target.id ? { ...c, parameters: { ...c.parameters, __body: buildBody(api, {}, dict) } } : c,
  )
}

function ApiDetail({
  api,
  project,
  links,
  cases,
  onToggleLink,
  onAddLink,
  onQuickRun,
}: {
  api: ApiMethod
  project: ProjectScanResult
  links: TableRelation[]
  cases: TestCase[]
  onToggleLink: (table: string, on: boolean) => void
  onAddLink: (table: string) => void
  onQuickRun: (caseId?: string) => Promise<void>
}) {
  const { message, modal } = AntdApp.useApp()
  const env = useApiforgeStore((s) => s.env)
  const token = useApiforgeStore((s) => s.token)
  const results = useApiforgeStore((s) => s.results)
  const running = useApiforgeStore((s) => s.running)
  const schemaTables = useSchemaStore((s) => s.tables)
  const setCasesFor = useApiforgeStore((s) => s.setCasesFor)
  const enabledN = cases.filter((c) => c.enabled).length
  const [addTable, setAddTable] = useState('')
  /**
   * 「▶ 发送」在飞的是哪个接口（store）。running 是和跑批共用的，得分清
   * 「本接口发送中」「上一个接口还在发」和「跑批中」
   */
  const sendingApiId = useApiforgeStore((s) => s.sendingApiId)
  const sending = sendingApiId === api.id
  const otherSending = !!sendingApiId && !sending
  const runLabel = sending ? '发送中' : otherSending ? '上一个接口还在发送' : '运行中'
  /** 发送区选中的用例；没选过就按老挑法（启用的正常用例优先）。切接口时组件重挂，自然重置 */
  const [pickedId, setPickedId] = useState<string | null>(null)
  /** 用例卡里展开编辑的那条 */
  const [openId, setOpenId] = useState<string | null>(null)
  const sendCase = cases.find((c) => c.id === pickedId) ?? pickSendCase(cases) ?? null
  const changeAction = async (v: ActionChoice) => {
    const nextApi = await applyApiAction(api, v === 'auto' ? null : v)
    setPickedId(null)
    setOpenId(null)
    void message.success(`接口类型改成「${ACTION_NAME[apiActionOf(nextApi)]}」，自动生成的用例已按新类型重建`)
  }
  const sendNow = () => {
    if (running) return
    void onQuickRun(sendCase?.id)
  }
  /** 发完如果响应不在可视范围（请求体长时常见），滚到响应 */
  const respRef = useRef<HTMLDivElement>(null)
  const wasSending = useRef(sending)
  useEffect(() => {
    if (wasSending.current && !sending) {
      const el = respRef.current
      if (el && el.getBoundingClientRect().top > window.innerHeight - 120) {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' })
      }
    }
    wasSending.current = sending
  }, [sending])
  const { copy: copyText } = useCopy()
  /** 次要卡一律默认折起：首屏只留结果 + 试跑参数（产物优先） */
  const [linksOpen, setLinksOpen] = useState(false)
  const [metaOpen, setMetaOpen] = useState(false)
  const showAdvanced = useApiforgeStore((s) => s.showAdvanced)
  /** 本接口所属 Controller：「运行▾」里「本 Controller」用 */
  const ctrl = project.controllers.find((c) => c.methods.some((m) => m.id === api.id))

  /** 用例沉淀回代码（PRD v0.6 模块 4.17）：把调好的用例导成 JUnit 5 测试类，
   *  提交进被测工程仓库。付费闸与整包导出同口径；令牌绝不落生成的代码。 */
  const isPro = useLicenseStore((s) => s.isPro)
  const exportJunit = () => {
    if (!canBatchCases(isPro)) {
      useLicenseStore.getState().openUpgrade()
      return
    }
    try {
      const out = junitForApi(env, api, cases, {
        packageName: project.controllers.find((c) => c.packageName)?.packageName,
      })
      if (!out) {
        void message.warning('没有启用的用例：先勾选要沉淀的用例')
        return
      }
      download(out.fileName, out.code, 'text/x-java-source')
      void message.success(
        `已导出到「下载」文件夹：${out.fileName}（${out.exportedCases} 条用例${out.skippedCases ? `，另有 ${out.skippedCases} 条缺路径参数未导出` : ''}），放进工程 src/test/java 即可跑`,
      )
    } catch (e) {
      void message.error(`JUnit 生成失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 该接口最近一次执行（试跑或跑批）——首卡展示它，没有就显示「未执行」；禁用跳过的不算执行
  const last = useMemo(
    () => [...results].reverse().find((r) => r.apiId === api.id && !r.skipped),
    [results, api.id],
  )
  // 本接口启用用例最新一次的通过数：跳过和禁用的不计，和左树红点同口径
  const tally = useMemo(() => {
    const enabledIds = new Set(cases.filter((c) => c.enabled).map((c) => c.id))
    const byCase = new Map<string, boolean>()
    for (const r of results) {
      if (r.apiId === api.id && !r.skipped && enabledIds.has(r.caseId)) byCase.set(r.caseId, r.ok)
    }
    let pass = 0
    for (const ok of byCase.values()) if (ok) pass++
    return { pass, total: byCase.size }
  }, [results, api.id, cases])
  /** 每条用例最近一次的结果（用例卡每行显示） */
  const latestByCase = useMemo(() => {
    const m = new Map<string, CaseRunResult>()
    for (const r of results) if (r.apiId === api.id) m.set(r.caseId, r)
    return m
  }, [results, api.id])
  /** 启用用例里最近一次失败的条数：写在用例卡标题上，有失败就自动展开 */
  const failN = cases.filter((c) => {
    const r = latestByCase.get(c.id)
    return c.enabled && !!r && isFailed(r)
  }).length
  const [casesOpen, setCasesOpen] = useState(failN > 0)
  const [seenFail, setSeenFail] = useState(failN)
  if (failN !== seenFail) {
    setSeenFail(failN)
    if (failN > seenFail) setCasesOpen(true)
  }
  const fullUrl = `${resolveBaseUrl(env, api.projectId).replace(/\/+$/, '')}${api.path}`
  // 发送条显示真正会发的地址（带参数），取的是「▶ 发送」用的同一条用例
  const sendUrl = (sendCase && buildRequest(env, api, sendCase, token)?.url) || fullUrl
  /** 跳去连库查询时带上，那边一键回到这个接口 */
  const backTo = { apiId: api.id, label: `${api.httpMethod} ${api.path}` }
  const enabledLinks = links.filter((l) => l.enabled).length
  /** 没勾关联表时并排「库变更」是空占位，挤掉响应可读面积 */
  // 查询接口不查库对比（runCase 同一口径），整栏不出，响应占满
  const showDbPane =
    !!last &&
    !isReadAction(api) &&
    (enabledLinks > 0 ||
      last.dbChanges.some((c) => c.op !== 'none') ||
      last.snapshotErrors.length > 0)
  /**
   * 「查库 ↗」的落点：调完接口最想看刚动过的那张表（有主键值就带上 WHERE）。
   * SQL 纯函数在 dbjump.ts；这里只算一次，last/勾选/表缓存不变就不重算。
   */
  // 稳定引用：ResponsePreview 是 memo 的，每次新建函数会让大响应跟着重画
  const lastJson = last ? (last.responseFull ?? last.responsePreview) : ''
  const openJson = useCallback(
    () => useUiStore.getState().jumpToJsonPath({ json: lastJson, from: `${api.httpMethod} ${api.path}` }),
    [lastJson, api.httpMethod, api.path],
  )
  const dbJump = useMemo(
    () =>
      quickCheckSql({
        changed: last?.dbChanges ?? [],
        enabledTables: links.filter((l) => l.enabled).map((l) => l.tableName),
        schemaTables,
      }),
    [last, links, schemaTables],
  )

  return (
    <>
      <div
        className="apf-first apf-panel"
        onKeyDown={(e) => {
          // Ctrl+Enter（Mac 上 Cmd+Enter）发送：改完参数不用再去摸鼠标
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            sendNow()
          }
        }}
      >
        <div className="apf-panel-h row-between">
          <span>接口调试</span>
          <span className="apf-acts">
            {/* 批量跑都收在「运行▾」里；全量回归在顶栏右上，带范围选择 */}
            <PopSel<'' | 'api' | 'ctrl'>
              className="apf-runmenu"
              value=""
              displayLabel={running ? '运行中…' : '运行'}
              disabled={running}
              aria-label="批量运行"
              title={running ? '正在运行，等这一轮结束或到报告页停止' : '跑本接口或本 Controller 的启用用例，结果进报告'}
              options={[
                { value: 'api', label: `本接口全部用例${enabledN ? ` · ${enabledN} 条` : ''}` },
                ...(ctrl ? [{ value: 'ctrl' as const, label: `本 Controller · ${ctrl.className}` }] : []),
              ]}
              onChange={(v) => {
                if (v === 'api') void runApiCases(api, message, modal)
                else if (v === 'ctrl' && ctrl) void runControllerCases(project, ctrl, message, modal)
              }}
            />
          </span>
        </div>

        {/* 身份行：调的是谁 + 最近一次结果。读卡顺序 = 身份 → 发送 → 参数 → 结果 */}
        <div className="apf-runhead">
          <Verb method={api.httpMethod} />
          <Sel<ActionChoice>
            aria-label="接口类型"
            title="这个接口是查询、新增、修改还是删除。决定正常用例发什么、要不要造数据、只读跑发不发；认错了在这里改，重扫不丢"
            style={{ width: 'auto', flex: 'none' }}
            value={api.action ?? 'auto'}
            options={[
              { value: 'auto', label: `自动（${ACTION_NAME[guessApiAction(api)]}）` },
              { value: 'query', label: '查询' },
              { value: 'insert', label: '新增' },
              { value: 'update', label: '修改' },
              { value: 'delete', label: '删除' },
              { value: 'unknown', label: '认不出' },
            ]}
            onChange={(v) => void changeAction(v)}
          />
          <code title={fullUrl}>{api.path}</code>
          {api.description && (
            <span className="apf-dbg-desc" title={api.description}>
              {api.description}
            </span>
          )}
          <span className="apf-runhead-status">
            {running ? (
              /* 在跑/在发就顶掉旧结果徽标：秒数在跳 + apf-pulse，一眼知道请求活着。
                 不再放 ⏳：彩色 emoji 与等待氛围相性差，脉冲动画自己会说话 */
              <span className="apf-pill run" role="status">
                <WaitTimer label={runLabel} />
              </span>
            ) : last ? (
              tally.total === 0 ? (
                /* 只发过已禁用的用例：结果照常显示，但不算进通过数 */
                <span className={`apf-pill ${last.ok ? 'ok' : 'bad'}`} title="这条用例已禁用，结果不计入通过数">
                  {last.ok ? '通过' : '失败'}
                </span>
              ) : tally.pass === tally.total ? (
                <span className="apf-pill ok" title="本接口各用例最近一次都通过">
                  {tally.pass}/{tally.total} 通过
                </span>
              ) : (
                /* 失败即入口：点了直接跳报告定位这条失败，不等用户切页签翻表 */
                <button
                  className="apf-pill bad apf-pillbtn"
                  title="本接口有失败用例，点开报告定位"
                  onClick={() => {
                    useApiforgeStore.getState().setReportFocus({ apiId: api.id })
                    useApiforgeStore.getState().setView('report')
                  }}
                >
                  {tally.pass}/{tally.total} 通过 ↗
                </button>
              )
            ) : (
              <span className="apf-pill idle">未执行</span>
            )}
            {!running && last?.stale && (
              <span className="apf-stalemark" title="这条用例跑完后又改过，结果可能已经不准，重跑后消失">
                改过，没重跑
              </span>
            )}
          </span>
        </div>

        {/* 发送条：完整 URL + 认证态 + 发送按钮同一条；认证态在「环境 / 连库」配 */}
        <div className="apf-sendbar">
          <button
            type="button"
            className={cx('apf-authchip', token && 'on')}
            title="Token 可选；要带就点这里去「环境 / 连库」粘"
            onClick={() => {
              const st = useApiforgeStore.getState()
              st.setEnvFocus('auth')
              st.setView('env')
            }}
          >
            {token ? '已带 Token' : '未带 Token'}
          </button>
          <code
            className="apf-sendurl"
            title={`${sendUrl}\n点一下复制完整地址`}
            onClick={() =>
              void copyText(sendUrl).then((ok) =>
                ok ? message.success('已复制地址') : message.error('复制失败，请手动选中'),
              )
            }
          >
            {sendUrl}
          </code>
          <Btn
            variant="mini"
            title="复制成 curl 命令（不含登录令牌），贴进终端就能重放"
            onClick={() => {
              const built = sendCase ? buildRequest(env, api, sendCase, null) : null
              const text = toCurl(api.httpMethod, built?.url ?? sendUrl, built?.body)
              void copyText(text).then((ok) =>
                ok ? message.success('已复制 curl') : message.error('复制失败'),
              )
            }}
          >
            复制 curl
          </Btn>
          <Btn
            variant="primary"
            onClick={sendNow}
            blocked={running}
            title={
              running
                ? sending
                  ? '这一发还在路上，等响应回来'
                  : otherSending
                    ? '上一个接口还在发送，等它回来'
                    : '正在跑用例，等这一轮结束'
                : `发送用例「${sendCase?.name ?? ''}」（Ctrl+Enter）`
            }
          >
            {sending ? '发送中…' : '▶ 发送'}
          </Btn>
        </div>

        <div className="apf-panel-h subtle row-between">
          <span>请求参数</span>
          {cases.length > 1 && sendCase && (
            <Sel
              className="apf-casepick"
              title="发送哪条用例；下面改的参数也写回这条"
              value={sendCase.id}
              options={cases.map((c) => ({
                value: c.id,
                // 自动生成的名字已带类型（正常·list），不再重复加前缀
                label: `${c.name.startsWith(CASE_TYPE_LABEL[c.type]) ? '' : `${CASE_TYPE_LABEL[c.type]} · `}${c.name}${c.enabled ? '' : '（已禁用）'}`,
              }))}
              onChange={(id) => {
                void useApiforgeStore.getState().flushCases()
                setPickedId(id)
              }}
            />
          )}
        </div>
        <TryRunParamsInline
          api={api}
          cases={cases}
          target={sendCase}
          onPatchCases={(next) => void setCasesFor(api.id, next)}
        />

        {last && (
          <div ref={respRef} className="apf-respblock">
            {/* 库变更通常就几行：压成响应上方一条摘要，响应占整行 */}
            {showDbPane && (
              <div className="apf-dbsum">
                <span className="apf-dbsum-lbl">数据库变更</span>
                <DbChips text={changeLine(last)} />
                {dbJump && (
                  <Btn
                    variant="mini"
                    title={`到「连库查询」执行：${dbJump.sql}（未连库时连上自动查）`}
                    onClick={() =>
                      useUiStore.getState().jumpToDbQuery({ sql: dbJump.sql, run: true, back: backTo })
                    }
                  >
                    查库 ↗
                  </Btn>
                )}
              </div>
            )}
            <div>
              <div className="apf-panel-h subtle row-between">
                <span className="apf-resp-title" title={last.caseName}>
                  响应 · {last.caseName}
                </span>
                {/* 计时只在顶部状态里跳一处；这里只放状态码和耗时 */}
                <span className="apf-dbg-ms">
                  {running
                    ? '等待响应…'
                    : `${last.httpStatus != null ? `HTTP ${last.httpStatus}` : '请求出错'} · ${last.durationMs}ms`}
                </span>
              </div>
              <ResponsePreview
                key={last.caseId + last.durationMs}
                text={last.responsePreview || last.error || ''}
                full={last.responseFull}
                types={project.types}
                extra={api.requestBodyFields}
                onJsonPath={openJson}
              />
              {/* 响应结构差异（schemaAssert）：观察模式只记录，默认折着不占地方 */}
              {last.schemaIssues?.length ? (
                <details className="apf-datalog apf-schemalog">
                  <summary>
                    响应结构差异 · {last.schemaIssues.length} 处（对照返回类型 {api.responseType}）
                  </summary>
                  <ul className="apf-dblist">
                    {last.schemaIssues.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          </div>
        )}
        {!last && <p className="apf-empty">改参数后点「发送」，响应与数据库变更会显示在这里。</p>}
        {last && last.dataLog.length > 0 && (
          /* 备数/清理由来有记没处看：折在这里，开发/测试逐条可查证 */
          <details className="apf-datalog">
            <summary>数据日志 · {last.dataLog.length} 条（备了什么数据、清了什么）</summary>
            <ul className="apf-dblist">
              {last.dataLog.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <Card
        title={
          <>
            用例 · {cases.length}
            {failN > 0 && <span className="apf-bad"> · {failN} 失败</span>}
          </>
        }
        who="点名称展开编辑；要新加一条就「复制」一条再改"
        open={casesOpen}
        onToggle={setCasesOpen}
        actions={
          <>
            {showAdvanced && CI_EXPORTS_SHOWN && (
              <Btn
                title="用例沉淀回代码：把启用的用例导成 JUnit 5 测试类（RestTemplate + json-path 断言），提交进被测工程的 src/test/java；令牌不落代码"
                onClick={exportJunit}
              >
                <DownloadOutlined aria-hidden="true" /> 沉淀 JUnit
              </Btn>
            )}
            <Btn
              title="按当前扫描结果重建本接口用例；默认保留改过的和自己加的"
              onClick={() => {
                const regen = (keep: boolean) => {
                  const st = useApiforgeStore.getState()
                  const dict = dictOfScan(st.scan)
                  const generated = generateCases(api, dict, st.scan)
                  // 重建后同样尊重「默认全字段」偏好：新生成的 {} 立刻展开
                  const fresh = st.fullBodyDefault ? fillFullBody(api, dict, generated) : generated
                  const next = keep ? regenerateKeeping(st.cases[api.id] ?? [], fresh) : fresh
                  void setCasesFor(api.id, next)
                  // 不在新用例里的结果对不上了，从报告去掉
                  const ids = new Set(next.map((c) => c.id))
                  useApiforgeStore.setState({
                    results: st.results.filter((r) => r.apiId !== api.id || ids.has(r.caseId)),
                  })
                  setPickedId(null)
                  setOpenId(null)
                  setCasesOpen(true)
                  void message.success(`重新生成完成，现在 ${next.length} 条用例`)
                }
                const keptN = cases.filter((c) => originOf(c) !== 'auto').length
                const inst = modal.confirm({
                  title: '重新生成本接口用例？',
                  content: keptN
                    ? `改过的和自己加的 ${keptN} 条会保留，其余按当前扫描结果重建。点「全部重生」则一条不留。`
                    : `现在 ${cases.length} 条都是自动生成的，按当前扫描结果重建。`,
                  okText: keptN ? '重新生成（保留改过的）' : '重新生成',
                  cancelText: '取消',
                  onOk: () => regen(true),
                  footer: (_, { OkBtn, CancelBtn }) => (
                    <>
                      <CancelBtn />
                      {keptN > 0 && (
                        <Btn
                          danger
                          onClick={() => {
                            inst.destroy()
                            regen(false)
                          }}
                        >
                          全部重生
                        </Btn>
                      )}
                      <OkBtn />
                    </>
                  ),
                })
              }}
            >
              <ReloadOutlined aria-hidden="true" /> 重新生成
            </Btn>
          </>
        }
      >
        <ul className="apf-caselist">
          {cases.map((c) => {
            const r = latestByCase.get(c.id)
            const origin = originOf(c)
            return (
              <li key={c.id} className={cx('apf-caserow', c.id === sendCase?.id && 'on', !c.enabled && 'off')}>
                <div className="apf-caserow-h">
                  <Cb
                    checked={c.enabled}
                    title={c.enabled ? '取消勾选 = 禁用，跑批时跳过' : '勾上重新启用'}
                    onChange={(on) => useApiforgeStore.getState().setCaseEnabled(api.id, c.id, on)}
                  />
                  <span className={`apf-casetag ${c.type}`}>{CASE_TYPE_LABEL[c.type]}</span>
                  <button
                    type="button"
                    className="apf-casename"
                    title="展开编辑；上方发送区也切到这条"
                    onClick={() => {
                      void useApiforgeStore.getState().flushCases()
                      setPickedId(c.id)
                      setOpenId(openId === c.id ? null : c.id)
                    }}
                  >
                    {c.name}
                  </button>
                  {origin === 'edited' && <span className="apf-origintag">改过</span>}
                  {origin === 'user' && <span className="apf-origintag user">我加的</span>}
                  <em>
                    {c.expectedHttpStatus.length ? `期望状态码 ${c.expectedHttpStatus.join(' / ')}` : '不校验状态码'}
                    {c.expectBody?.length ? ` · 响应断言 ${c.expectBody.length} 条` : ''}
                  </em>
                  <CaseResultMark r={r} />
                  <span className="apf-caserow-acts">
                    <button
                      type="button"
                      className="apf-linkbtn"
                      title={c.enabled ? '只发这一条' : '只发这一条（已禁用，结果照常记）'}
                      onClick={() => {
                        if (running) {
                          void message.warning('正在运行，等这一轮结束')
                          return
                        }
                        setPickedId(c.id)
                        void onQuickRun(c.id)
                      }}
                    >
                      ▶ 发送
                    </button>
                    <button
                      type="button"
                      className="apf-linkbtn"
                      title="复制一条放在它下面"
                      onClick={() => {
                        const copy = useApiforgeStore.getState().duplicateCase(api.id, c.id)
                        if (!copy) return
                        setPickedId(copy.id)
                        setOpenId(copy.id)
                        void message.success(`已复制成「${copy.name}」，发送区已切到这条`)
                      }}
                    >
                      复制
                    </button>
                    <button
                      type="button"
                      className="apf-linkbtn danger"
                      onClick={() =>
                        modal.confirm({
                          title: `删除用例「${c.name}」？`,
                          content: '它在报告里的结果会一起去掉。自动生成的用例点「重新生成」还能找回来。',
                          okText: '删除',
                          okButtonProps: { danger: true },
                          cancelText: '取消',
                          onOk: () => {
                            useApiforgeStore.getState().removeCase(api.id, c.id)
                            if (pickedId === c.id) setPickedId(null)
                            if (openId === c.id) setOpenId(null)
                          },
                        })
                      }
                    >
                      删除
                    </button>
                  </span>
                </div>
                {openId === c.id && (
                  <CaseEditor
                    key={c.id}
                    apiId={api.id}
                    c={c}
                    onSend={() => {
                      if (running) {
                        void message.warning('正在运行，等这一轮结束')
                        return
                      }
                      void onQuickRun(c.id)
                    }}
                  />
                )}
              </li>
            )
          })}
        </ul>
      </Card>

      <Card
        title={
          <>
            关联表{enabledLinks ? ` · ${enabledLinks}` : ''}
          </>
        }
        who={isReadAction(api) ? '查询接口不做库验证' : '勾选的表参与库验证'}
        open={linksOpen}
        onToggle={setLinksOpen}
      >
        {links.length === 0 ? (
          <p className="apf-empty">未识别到关联表。可手动加表名。</p>
        ) : (
          <>
            <div className="apf-tbllinks">
              {links.map((l) => (
                <Fragment key={l.tableName}>
                  <div className="apf-tblpair">
                    <label className={`apf-tbllink conf-${l.confidence}`}>
                      <Cb checked={l.enabled} onChange={(on) => onToggleLink(l.tableName, on)} />
                      <b>{l.tableName}</b>
                      <span className="apf-conftag">
                        {l.confidence === 'mapper' ? '代码识别' : l.confidence === 'user' ? '手动' : '推断'}
                      </span>
                      <span className="apf-tblsrc">{l.source}</span>
                    </label>
                    <button
                      type="button"
                      className="apf-tbldata"
                      title={`跳到「连库查询」自动执行：SELECT * FROM ${l.tableName}（未连库时连上自动查）`}
                      onClick={() =>
                        useUiStore.getState().jumpToDbQuery({
                          sql: `SELECT * FROM ${l.tableName}`,
                          table: l.tableName,
                          run: true,
                          back: backTo,
                        })
                      }
                    >
                      查询 ↗
                    </button>
                  </div>
                </Fragment>
              ))}
            </div>
          </>
        )}
        <Row>
          <Fld
            value={addTable}
            onChange={(e) => setAddTable(e.target.value)}
            placeholder="手动加表名，回车确认"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && addTable.trim()) {
                onAddLink(addTable.trim().toLowerCase())
                setAddTable('')
                void message.info(`已添加关联表 ${addTable.trim().toLowerCase()}`)
              }
            }}
          />
        </Row>
      </Card>

      <Card
        // 工程和类名在正文第一行
        title="参数明细"
        open={metaOpen}
        onToggle={setMetaOpen}
      >
        <p className="apf-src" title={api.filePath}>
          {project.projectName} · {api.controllerClass}.{api.methodName}()
        </p>
        {api.parameters.length === 0 && !api.requestBodyType ? (
          <p className="apf-empty">无声明参数</p>
        ) : (
          <table className="apf-params">
            <thead>
              <tr>
                <th>参数</th>
                <th>说明</th>
                <th>位置</th>
                <th>类型</th>
                <th>必填</th>
              </tr>
            </thead>
            <tbody>
              {api.parameters.map((p) => (
                <tr key={p.name}>
                  <td>{p.name}</td>
                  <td className="apf-param-desc" title={paramHint(p) || undefined}>
                    {paramHint(p) || '—'}
                  </td>
                  <td>{posLabel(p.position)}</td>
                  <td>{p.javaType}</td>
                  <td>{p.required ? <span className="apf-tryreq">必填</span> : ''}</td>
                </tr>
              ))}
              {api.requestBodyType && (
                <tr>
                  <td>请求体</td>
                  <td className="apf-param-desc">—</td>
                  <td>请求体</td>
                  <td>{api.requestBodyType}</td>
                  <td>—</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </Card>
    </>
  )
}

const CASE_TYPE_LABEL: Record<CaseType, string> = { normal: '正常', boundary: '边界', exception: '异常' }

const POS_LABEL: Record<string, string> = { path: '路径', query: '查询', body: '请求体', header: '请求头', form: '表单' }
/** 参数位置显示成中文；认不得的原样 */
const posLabel = (p: string): string => POS_LABEL[p] ?? p

/** 用例卡每行的最近结果：通过 / 失败 / 跳过 / 未运行，改过没重跑的加注 */
function CaseResultMark({ r }: { r?: CaseRunResult }) {
  if (!r) return <span className="apf-caseres idle">未运行</span>
  const s = resultState(r)
  return (
    <span
      className={`apf-caseres ${s}`}
      title={r.stale ? '这条用例跑完后又改过，结果可能已经不准' : r.error || undefined}
    >
      {s === 'pass' ? '通过' : s === 'fail' ? '失败' : '跳过'}
      {r.stale ? '（改过，没重跑）' : ''}
    </span>
  )
}

const CASE_TYPE_OPTIONS = (Object.keys(CASE_TYPE_LABEL) as CaseType[]).map((value) => ({ value, label: CASE_TYPE_LABEL[value] }))

/**
 * 用例卡里展开的一条：名称、类型、期望。参数和请求体在上方「请求参数」里改
 * （点开时发送区已切到这条），两边不重复放编辑框。
 */
function CaseEditor({ apiId, c, onSend }: { apiId: string; c: TestCase; onSend: () => void }) {
  const { message } = AntdApp.useApp()
  const [name, setName] = useState(c.name)
  const [status, setStatus] = useState(c.expectedHttpStatus.join(','))
  const [expects, setExpects] = useState(() => cloneExpects(c.expectBody))
  const update = (p: CasePatch) => useApiforgeStore.getState().updateCase(apiId, c.id, p)
  const dirty =
    status !== c.expectedHttpStatus.join(',') || JSON.stringify(expects) !== JSON.stringify(cloneExpects(c.expectBody))
  const commitName = () => {
    const v = name.trim()
    if (!v) {
      setName(c.name)
      void message.warning('名称不能为空，已恢复原名')
      return
    }
    if (v !== c.name) update({ name: v })
  }
  const saveExpect = () => {
    const nums = parseExpectStatus(status)
    const body = cleanBodyExpects(expects)
    update({ expectedHttpStatus: nums, expectBody: body })
    setStatus(nums.join(','))
    setExpects(cloneExpects(body))
  }
  return (
    <div className="apf-caseedit">
      <div className="apf-caseedit-row">
        <Lbl>名称</Lbl>
        <Fld
          className="apf-caseedit-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitName()
          }}
        />
        <Lbl>类型</Lbl>
        <Seg<CaseType> options={CASE_TYPE_OPTIONS} value={c.type} onChange={(type) => type !== c.type && update({ type })} />
      </div>
      <CaseExpectEditor status={status} onStatus={setStatus} expects={expects} onExpects={setExpects} />
      <div className="apf-caseedit-foot">
        <Btn
          variant="primary"
          title="保存期望，立刻按新期望发一次"
          onClick={() => {
            if (dirty) saveExpect()
            onSend()
          }}
        >
          {dirty ? '保存并发送' : '▶ 发送'}
        </Btn>
        <Btn
          disabled={!dirty}
          onClick={() => {
            saveExpect()
            void message.success('期望已保存')
          }}
        >
          只保存
        </Btn>
        {dirty && (
          <Btn
            onClick={() => {
              setStatus(c.expectedHttpStatus.join(','))
              setExpects(cloneExpects(c.expectBody))
            }}
          >
            撤销
          </Btn>
        )}
        <span className="apf-hint">参数和请求体在上方「请求参数」里改，已切到这条</span>
      </div>
    </div>
  )
}

/** changeLine 的多行文本 → 一排库变更小标签（响应上方的摘要条用） */
function DbChips({ text }: { text: string }) {
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length === 1 && text.includes('未关联表')) return <span className="apf-dbsum-none">{text}</span>
  return (
    <>
      {lines.map((line, i) => {
        const op = line.includes('新增') ? 'insert' : line.includes('更新') ? 'update' : line.includes('删除') ? 'delete' : 'none'
        return (
          <span key={i} className={`apf-op op-${op}`} title={line}>
            {line.replace(/^[^ ]+ /, '')}
          </span>
        )
      })}
    </>
  )
}

/**
 * 试跑实际发出的 path/query/body：嵌在结果首卡里，能看能改。
 * 写回发送区选中的用例（跟 ▶ 发送同一条），改过就标「改过」，重扫不丢。
 */
function TryRunParamsInline({
  api,
  cases,
  target,
  onPatchCases,
}: {
  api: ApiMethod
  cases: TestCase[]
  target: TestCase | null
  onPatchCases: (next: TestCase[]) => void
}) {
  const scan = useApiforgeStore((s) => s.scan)
  const fullBodyDefault = useApiforgeStore((s) => s.fullBodyDefault)
  /** 嵌套骨架的类字典：detailList 这类对象集合要按元素类型往深里造 */
  const typeDict = useMemo(() => dictOfScan(scan), [scan])

  // 和「▶ 发送」取同一条：这里改的就是会发出去的
  const normal = target

  const pathQuery = api.parameters.filter((p) => p.position === 'path' || p.position === 'query')
  const wantsBody =
    api.requestBodyType !== null ||
    api.parameters.some((p) => p.position === 'body') ||
    (normal !== null && typeof normal.parameters.__body === 'string')

  const patchValue = (name: string, value: string) => {
    if (!normal) return
    useApiforgeStore.getState().updateCase(api.id, normal.id, { parameters: { ...normal.parameters, [name]: value } })
  }

  const rawBody = (() => {
    if (!normal) return ''
    const raw = normal.parameters.__body
    return typeof raw === 'string' ? raw : wantsBody ? buildBody(api, {}, typeDict) : ''
  })()
  /**
   * Body 文本框用草稿：只在载入、换用例、外部改写（填入全部字段）和点「格式化」时美化。
   * 边打字边美化会把光标踢到末尾。pushed = 自己刚写回去的原文，它回流时不重置草稿
   */
  const [bodyDraft, setBodyDraft] = useState(() => prettyJson(rawBody))
  const [pushed, setPushed] = useState<string | null>(null)
  const bodyKey = `${normal?.id ?? ''}\n${rawBody}`
  const [seenBodyKey, setSeenBodyKey] = useState(bodyKey)
  /** 请求体不是合法 JSON：离开输入框时查一次，只提示不拦发送；改对了就消失 */
  const [bodyErr, setBodyErr] = useState<ReturnType<typeof jsonProblem>>(null)
  if (bodyKey !== seenBodyKey) {
    setSeenBodyKey(bodyKey)
    if (rawBody !== pushed) {
      setBodyDraft(prettyJson(rawBody))
      setBodyErr(null)
    }
  }
  const editBody = (v: string) => {
    setBodyDraft(v)
    setPushed(v)
    patchValue('__body', v)
    if (bodyErr) setBodyErr(jsonProblem(v))
  }
  const flush = () => void useApiforgeStore.getState().flushCases()
  // 卸载（切接口、关页签）时把防抖中的改动落盘
  useEffect(() => () => void useApiforgeStore.getState().flushCases(), [])

  if (!normal) {
    return <p className="apf-empty">还没有用例，点左侧接口会自动生成。</p>
  }
  if (pathQuery.length === 0 && !wantsBody) {
    return <p className="apf-empty">这个接口不用传参数，直接发送即可。</p>
  }

  return (
    <>
      {pathQuery.length > 0 && (
        <div className="apf-tryparams">
          {pathQuery.map((p) => {
            const raw = normal.parameters[p.name]
            const value = raw === undefined || raw === null ? '' : String(raw)
            const hint = paramHint(p)
            return (
              <div key={p.name} className="apf-tryparam">
                <Lbl>
                  {p.name}
                  <span className="apf-trypos">{posLabel(p.position)}</span>
                  {p.required ? <span className="apf-tryreq">必填</span> : null}
                </Lbl>
                {hint ? <p className="apf-tryhint" title={hint}>{hint}</p> : null}
                <Fld
                  value={value}
                  onChange={(e) => patchValue(p.name, e.target.value)}
                  onBlur={flush}
                  placeholder={hint || p.defaultValue || p.javaType}
                />
              </div>
            )
          })}
        </div>
      )}
      {wantsBody && (
        <div className="apf-trybody">
          <Lbl>
            请求体（JSON）
            <Btn onClick={() => editBody(prettyJson(bodyDraft))} title="按 JSON 缩进重排；不是合法 JSON 时原样不动">
              格式化
            </Btn>
            {api.requestBodyFields.length > 0 && (
              <>
                <Btn
                  onClick={() => patchValue('__body', buildBody(api, {}, typeDict))}
                  title="把扫描解析出的字段全量填入，对象/集合元素按类型字典嵌套造骨架"
                >
                  填入全部字段
                </Btn>
                <Cb
                  checked={fullBodyDefault}
                  onChange={(on) => {
                    useApiforgeStore.getState().setFullBodyDefault(on)
                    // 勾上的那一刻就把当前接口展开，别让用户再点一次按钮
                    if (on) onPatchCases(fillFullBody(api, typeDict, cases))
                  }}
                  title="记住偏好：以后点开接口自动把全字段骨架填进正常用例（会随用例库保存，回归也发这些字段）"
                >
                  默认全字段
                </Cb>
              </>
            )}
          </Lbl>
          <TextArea
            big
            rows={5}
            value={bodyDraft}
            onChange={(e) => editBody(e.target.value)}
            onBlur={() => {
              setBodyErr(jsonProblem(bodyDraft))
              flush()
            }}
            placeholder="{}"
          />
          {bodyErr && (
            <p className="apf-bodyerr">
              {bodyErr.line ? `第 ${bodyErr.line} 行附近` : '这里'}不是合法的 JSON，发出去服务端多半会报错
              {bodyErr.why ? `：${bodyErr.why}` : ''}
            </p>
          )}
        </div>
      )}
    </>
  )
}
