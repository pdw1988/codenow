/**
 * 码上追 · 日志查看：本机大日志文件秒开，不用再 SSH 拖文件回来用文本编辑器找；
 * 专业版还能直接连服务器把日志片段拉下来看（SshPanel）。
 *
 * 数据流：Rust 字节切片/SSH 字节流 → TextDecoder 拆行（store）→ 当前 pattern
 * 归组（useMemo）→ 过滤（useMemo）→ 虚拟滚动列表。pattern 改了只重归组，
 * 不重读文件。列表固定行高、滚动窗口渲染——几十万条记录一次全渲染会把页面拖死。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { App as AntdApp } from 'antd'
import { Band, Btn, Cb, CopyBtn, Fld, Hint, Row, Seg, Spacer, useWidthDrag } from '../../components/ui'
import { isTauri } from '../../storage'
import { canSshLogs } from '../../lib/license'
import { compilePattern, type CompiledPattern } from '../../lib/log/pattern'
import { groupRecords, groupRecordsChunked, type LogRecord } from '../../lib/log/records'
import { EMPTY_FILTER, isValidRegex, makePredicate } from '../../lib/log/filter'
import { inputFromWindow, windowFromInput } from '../../lib/log/window'
import { matchRate, sniffPattern } from '../../lib/log/sniff'
import { prettyJsonInText } from '../../lib/log/prettyMsg'
import { aroundView, centerTop, type Around } from '../../lib/log/around'
import { fmtBytes, fmtTime } from '../../lib/log/fmt'
import { useLogStore } from '../../store/useLogStore'
import { useLicenseStore } from '../../store/useLicenseStore'
import { SshPanel, TimelineView } from '@pro'
import { LEVELS, ROW_H, WINDOW_PAD, useDetailDrag, useViewHeight } from './viewParts'

/** 超过这么多行就分批归组，不卡住窗口 */
const SYNC_LINES = 100_000
const NO_RECORDS: LogRecord[] = []

/**
 * 停手再提交的输入框：pattern / 关键字每改一次都要对几十万条记录重算，逐字提交
 * 会让打字卡顿。回车立即提交；外部改了值（MDC 按钮、自动识别）输入框跟着变
 */
function DebouncedFld({
  value,
  onCommit,
  delay = 300,
  ...rest
}: { value: string; onCommit: (v: string) => void; delay?: number } & Omit<ComponentProps<typeof Fld>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    setDraft(value)
  }
  useEffect(() => {
    if (draft === value) return
    const t = setTimeout(() => onCommit(draft), delay)
    return () => clearTimeout(t)
  }, [draft, value, delay, onCommit])
  return (
    <Fld
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && draft !== value) onCommit(draft)
      }}
    />
  )
}

export function LogViewPage() {
  const { message } = AntdApp.useApp()
  const sources = useLogStore((s) => s.sources)
  const activeId = useLogStore((s) => s.activeId)
  const lastPattern = useLogStore((s) => s.lastPattern)
  const filter = useLogStore((s) => s.filter)
  const pendingJump = useLogStore((s) => s.pendingJump)
  const clearJump = useLogStore((s) => s.clearJump)
  const timelineOn = useLogStore((s) => s.timelineOn)
  const setTimeline = useLogStore((s) => s.setTimeline)
  const newestFirst = useLogStore((s) => s.newestFirst)
  const setNewestFirst = useLogStore((s) => s.setNewestFirst)
  const recents = useLogStore((s) => s.recents)
  const openLogFile = useLogStore((s) => s.openLogFile)
  const openPath = useLogStore((s) => s.openPath)
  const closeSource = useLogStore((s) => s.closeSource)
  const reloadSource = useLogStore((s) => s.reloadSource)
  const setActive = useLogStore((s) => s.setActive)
  const setPatternText = useLogStore((s) => s.setPatternText)
  const resetPattern = useLogStore((s) => s.resetPattern)
  const sniffIfBad = useLogStore((s) => s.sniffIfBad)
  const setFilter = useLogStore((s) => s.setFilter)
  const isPro = useLicenseStore((s) => s.isPro)

  // SSH 面板开关。面板要挂在页面最外层（两种空态/非空态共用一个树位），
  // 不然从空态拉到第一份日志时组件重挂，密码表单就被清了
  const [sshOpen, setSshOpen] = useState(false)
  // pattern 输入行平时收起（设一次就不动了，常驻占一整行）；拆不出头行或写错时自动展开
  const [patOpen, setPatOpen] = useState(false)
  // 服务器侧栏宽度：右边日志区至少留 420（与 _theme.css 里 .logv-side 的 max-width 一致）
  const side = useWidthDrag({ storageKey: 'codenow.logvSideW', min: 300, restMin: 420, edge: 'right' })
  const toggleSsh = () => {
    if (!sshOpen && !canSshLogs(isPro)) {
      useLicenseStore.getState().openUpgrade()
      return
    }
    setSshOpen((v) => !v)
  }

  const src = sources.find((s) => s.fileId === activeId) ?? sources[0] ?? null
  /** 时间线在混排多份：此时没有「当前那份」 */
  const mixed = timelineOn && sources.length > 1
  const filterTags = [
    filter.levels.length > 0 && `级别 ${filter.levels.join('/')}`,
    filter.text && `关键字「${filter.text}」`,
    (filter.since !== null || filter.until !== null) && '时间窗',
  ].filter((x): x is string => typeof x === 'string' && x !== '')
  // pattern 跟着当前来源走（两份日志格式不同不打架）；没来源时显示上次用过的
  const patternText = src?.patternText ?? lastPattern

  // pattern 编译不出来就按普通文本逐行看（每行一条），查看器永远有东西可看
  const compiled = useMemo(() => compilePattern(patternText), [patternText])
  const pattern = 'regex' in compiled ? compiled : null
  const patternError = 'error' in compiled ? compiled.error : null

  // 加载中不算记录：查看器这时本来就不显示，但这行 memo 不管显示不显示都会
  // 跑——拉取时每 256KB 一块 set 一份新 src，几十万行的 groupRecords 会跟着
  // 全量重跑一路，越拉越卡
  // 超过 SYNC_LINES 行分批归组：一气归完要好几秒，窗口点不动（从服务器拉 100MB 真机踩过）
  const ready = !!src && !src.loading
  const lines = src?.lines
  const big = ready && (lines?.length ?? 0) > SYNC_LINES
  const syncRecords = useMemo(
    () => (ready && !big && lines ? groupRecords(lines, pattern) : null),
    [ready, big, lines, pattern],
  )
  const [bigRec, setBigRec] = useState<{ lines: string[]; pattern: CompiledPattern | null; records: LogRecord[] } | null>(null)
  /** 分批归组进度 0~1；null = 没在归 */
  const [grouping, setGrouping] = useState<number | null>(null)
  useEffect(() => {
    if (!big || !lines) return
    let stale = false
    setGrouping(0)
    void groupRecordsChunked(lines, pattern, () => stale, (n) => setGrouping(n / lines.length)).then((r) => {
      if (!r || stale) return
      setBigRec({ lines, pattern, records: r })
      setGrouping(null)
    })
    return () => {
      stale = true
      setGrouping(null)
    }
  }, [big, lines, pattern])
  const records =
    syncRecords ?? (big && bigRec && bigRec.lines === lines && bigRec.pattern === pattern ? bigRec.records : NO_RECORDS)

  const regexOk = !filter.regex || isValidRegex(filter.text)
  const predicate = useMemo(
    () => makePredicate(regexOk ? filter : { ...filter, regex: false }),
    [filter, regexOk],
  )
  // 文件顺序就是写入顺序：倒过来就是最新的在上（filter 已是新数组，就地 reverse 无害）
  const filtered = useMemo(() => {
    const f = records.filter(predicate)
    return newestFirst ? f.reverse() : f
  }, [records, predicate, newestFirst])
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of records) if (r.level) c[r.level] = (c[r.level] ?? 0) + 1
    return c
  }, [records])
  // pattern 命中率：对不上要让人看得见——命中率低下时整份文件会塌成一条无头记录，
  // 级别全是空，看起来就像「筛选有 bug」（第一版真出过这个冤案）。加载中不算
  //（半份数据的命中率没意义，还每块重算一次）
  const hitRate = useMemo(
    () => (src && !src.loading ? matchRate(src.lines, patternText) : null),
    [src, patternText],
  )
  const patternShown = patOpen || !!patternError || (hitRate !== null && hitRate < 0.01)
  const autoPattern = () => {
    if (!src) return
    const s = sniffPattern(src.lines)
    if (!s) {
      void message.warning('常见格式都没认出来。把你工程 logback.xml 里 <pattern> 那行原样贴进输入框试试。')
      return
    }
    setPatternText(s.pattern)
    // 头行命中率在堆栈重的日志里就几个百分点，是正常数字，明说免得看着像坏了
    void message.success(`已按「${s.label}」解析，头行命中率 ${Math.round(s.rate * 100)}%`)
  }
  // 功能上线前就开着的来源（或识别前加载完的）补一次自动识别：store 里幂等，
  // 识别过/在加载中的一律直接返回
  useEffect(() => {
    if (src) sniffIfBad(src.fileId)
  }, [src, src?.loading, src?.sniffed, sniffIfBad])

  // 码上测跳转：等有就绪的日志来源再把时间窗套上去，套完消费掉。来源还在
  // 加载中不抢跑——窗口要落在最终那份数据上；没来源时引导卡会接住这个请求
  useEffect(() => {
    if (!pendingJump || !src || src.loading) return
    setFilter({ since: pendingJump.since, until: pendingJump.until })
    clearJump()
    void message.info(`已按「${pendingJump.label}」的时间窗过滤日志`)
  }, [pendingJump, src, src?.loading, setFilter, clearJump, message])

  // 虚拟滚动：滚动窗口 + 上下各多渲染几行，快速滚动时不露白
  const [viewH, listRef] = useViewHeight()
  const [scrollTop, setScrollTop] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  /** 查周边：非 null 时暂停筛选，列表显示锚点前后的完整日志 */
  const [around, setAround] = useState<Around | null>(null)
  const shown = useMemo(
    () => (around ? aroundView(records, around, newestFirst) : filtered),
    [around, records, newestFirst, filtered],
  )
  // 进出查周边要把某条滚到中间：列表按 key 重挂，只能等提交后（下一帧）拿新节点设 scrollTop，
  // 设完触发 onScroll 再回填 scrollTop 状态
  const listEl = useRef<HTMLDivElement | null>(null)
  const setListEl = useCallback(
    (el: HTMLDivElement | null) => {
      listEl.current = el
      listRef(el)
    },
    [listRef],
  )
  const scrollToRecord = (list: LogRecord[], index: number) => {
    const pos = list.findIndex((r) => r.index === index)
    if (pos < 0) return
    requestAnimationFrame(() => {
      const el = listEl.current
      if (el) el.scrollTop = centerTop(pos, ROW_H, el.clientHeight)
    })
  }
  const enterAround = (r: LogRecord) => {
    const next: Around = { index: r.index, thread: r.thread, sameThread: false }
    setAround(next)
    setSelected(r.index)
    scrollToRecord(aroundView(records, next, newestFirst), r.index)
  }
  const leaveAround = () => {
    if (!around) return
    setAround(null)
    setSelected(around.index)
    scrollToRecord(filtered, around.index)
  }
  const toggleSameThread = () => {
    if (!around) return
    if (around.thread === null) {
      void message.info('这条记录没拆出线程名（pattern 里没有 %thread），没法按线程筛')
      return
    }
    const next = { ...around, sameThread: !around.sameThread }
    const list = aroundView(records, next, newestFirst)
    // 选中的那条在新列表里还在就定位它，不在（别的线程）就回锚点
    const focus = selected !== null && list.some((r) => r.index === selected) ? selected : around.index
    setAround(next)
    setSelected(focus)
    scrollToRecord(list, focus)
  }
  /** 详情卡高度拖拽（与时间线视图共用一个 hook / 一份记忆） */
  const { detailBodyRef, preStyle, onVsplitDown, onVsplitDouble } = useDetailDrag()
  // 换来源 / pattern / 过滤变了：选中和查周边作废（旧行号对不上新列表）、滚动归零。
  // 只换排序或进出查周边：列表重挂、滚动归零，选中留着（由上面几个函数滚过去）。
  // 渲染期调整状态 + key 重挂列表，比 effect 里 setState 干净（react-compiler 认）
  const baseId = `${src?.fileId ?? 0}|${timelineOn}|${patternText}|${filter.levels.join(',')}|${filter.text}|${filter.regex}|${filter.caseSensitive}|${filter.since ?? ''}|${filter.until ?? ''}`
  const resetId = `${baseId}|${newestFirst}|${around ? `${around.index}|${around.sameThread}` : ''}`
  const [lastBase, setLastBase] = useState(baseId)
  const [lastReset, setLastReset] = useState(resetId)
  if (lastReset !== resetId) {
    setLastReset(resetId)
    setScrollTop(0)
    if (lastBase !== baseId) {
      setLastBase(baseId)
      setSelected(null)
      setAround(null)
    }
  }
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - WINDOW_PAD)
  const end = Math.min(shown.length, start + Math.ceil(viewH / ROW_H) + WINDOW_PAD * 2)
  const rows = shown.slice(start, end)

  const onOpen = () => {
    openLogFile().catch((e: unknown) => message.error(e instanceof Error ? e.message : String(e)))
  }
  const onOpenPath = (path: string) => {
    openPath(path).catch((e: unknown) => message.error(e instanceof Error ? e.message : String(e)))
  }

  if (!isTauri()) {
    return (
      <div className="logv">
        <Hint>打开本机日志文件、连服务器拉日志，都要用桌面版（pnpm tauri:dev 或安装包）——浏览器里没有这根针。</Hint>
      </div>
    )
  }

  return (
    <div className="logv">
      {/* SSH 侧栏（CRT 式布局）：左边选服务器、浏览目录、拉取，右边看日志。拉取
          成功整个侧栏自动收起（onPulled）——日志展示后服务器列表就该让位。收起后
          从左缘细条或工具条按钮再展开；重开按最近连接预填、密码自动回填 */}
      {/* 收起只是藏起来不卸载：卸载的话当前目录、搜索结果、密码全丢，再展开从头来 */}
      <aside className="logv-side" hidden={!sshOpen} style={side.widthStyle}>
        <SshPanel onPulled={() => setSshOpen(false)} />
      </aside>
      {/* 侧栏与日志区之间的拖拽条：紧跟 aside（拖动时读 previousElementSibling 量宽度） */}
      {sshOpen && (
        <div
          className="hsplit"
          title="左右拖调侧栏宽度，双击恢复默认"
          onPointerDown={side.onSplitDown}
          onDoubleClick={side.onSplitDouble}
        />
      )}

      <div className="logv-main">
      {/* 码上测跳转但还没有任何日志来源：先把「要什么时间段」交代清楚再引导开文件/连服务器 */}
      {!sshOpen && pendingJump && sources.length === 0 && (
        <Band tone="info">
          码上测的失败用例想看日志（{pendingJump.label}，{fmtTime(pendingJump.since)} ～{' '}
          {fmtTime(pendingJump.until)}）：打开覆盖这个时间段的日志文件，或连服务器拉取——
          就绪后自动按时间窗过滤。
        </Band>
      )}

      {sources.length === 0 ? (
        // 空态：一份日志都没开过，光给个按钮等于让用户猜这页是干嘛的——把「它替你
        // 干掉了哪个苦活、三步怎么用」写成引导卡，最近打开的文件也从这里进
        <div className="logv-hero">
          <div className="logv-hero-mark" aria-hidden="true">
            ▤
          </div>
          <h3>日志查看：本机大文件秒开，支持直连服务器拉取</h3>
          <p className="logv-hero-sub">
            面向问题排查的日志分析工具：支持 GB 级本机日志文件（catalina.out / app.log
            等），按 logback pattern 自动拆列，提供级别过滤、关键字（含堆栈）检索与
            完整异常查看。纯本机只读分析，无需部署任何组件，日志数据不出本机。
          </p>
          <div className="logv-hero-btns">
            <Btn variant="primary" onClick={onOpen}>
              打开日志文件
            </Btn>
            <Btn variant="ghost" onClick={toggleSsh}>
              连服务器拉日志
            </Btn>
          </div>
          {recents.length > 0 && (
            <div className="logv-hero-recents">
              <span>最近打开：</span>
              {recents.slice(0, 5).map((p) => (
                <Btn key={p} variant="mini" onClick={() => onOpenPath(p)} title={p}>
                  {p.split(/[\\/]/).pop()}
                </Btn>
              ))}
            </div>
          )}
          <ol className="logv-hero-steps">
            <li>打开日志文件——仅构建行偏移索引，不整读内存，GB 级文件秒级就绪</li>
            <li>拆列不准时，将 logback.xml 中的 pattern 粘贴至输入框（已内置常见格式自动识别）</li>
            <li>按级别过滤、关键字检索（含堆栈），点击任意行查看完整异常，支持一键复制</li>
          </ol>
          <p className="logv-hero-tip">自动识别 GBK / UTF-8 编码；无法解析的行按普通文本展示，不影响检索。</p>
        </div>
      ) : (
        <>
          <Row>
            <Btn variant="primary" onClick={onOpen}>
              打开日志文件
            </Btn>
            <Btn variant="ghost" on={sshOpen} onClick={toggleSsh}>
              连服务器拉日志
            </Btn>
            {/* 时间线混排全部来源时没有「当前那份」：路径框写份数，只对单份生效的按钮藏起来 */}
            <Fld
              value={mixed ? `时间线：${sources.length} 份日志按时间混排` : (src?.path ?? '')}
              onChange={() => undefined}
              readOnly
              style={{ flex: 1, minWidth: 200 }}
            />
            {!mixed && src && !src.loading && (src.kind === 'file' || src.sshPull) && (
              <Btn
                variant="mini"
                title={
                  src.kind === 'ssh'
                    ? '从服务器重新拉一遍这个文件，看新写进来的行（就在这个页签里刷新，pattern 保留）'
                    : '重新读一遍这个文件，看日志新写进来的行（pattern 保留）'
                }
                onClick={() =>
                  reloadSource(src.fileId).catch((e: unknown) => message.error(e instanceof Error ? e.message : String(e)))
                }
              >
                重新加载
              </Btn>
            )}
            {!mixed && src && (
              <Btn
                variant="mini"
                title="关掉这份日志（释放内存；拉取中的会一并取消）"
                onClick={() => closeSource(src.fileId)}
              >
                关闭
              </Btn>
            )}
          </Row>

          {sources.length > 1 && (
            <Row>
              {sources.map((s) => (
                // 页签 + 自己的 ×：不用先切过去再点工具条「关闭」
                <span key={s.fileId} className="logv-tab">
                  <Btn
                    // 时间线混排的是全部来源，点页签只换高亮看着像没切过去：点了就回单份看这一份
                    variant={!timelineOn && s.fileId === src?.fileId ? 'primary' : 'ghost'}
                    onClick={() => {
                      setActive(s.fileId)
                      setTimeline(false)
                    }}
                    title={timelineOn ? `${s.path}——点一下退出时间线，只看这一份` : s.path}
                  >
                    {s.kind === 'ssh' ? `${s.name}（服务器）` : s.name}
                  </Btn>
                  <button
                    type="button"
                    className="logv-tab-x"
                    title="关掉这份日志"
                    onClick={() => closeSource(s.fileId)}
                  >
                    ×
                  </button>
                </span>
              ))}
              {!mixed && (
                <Btn
                  variant="mini"
                  title="只留当前这份，其余页签全部关掉"
                  onClick={() => {
                    for (const s of sources) if (s.fileId !== src?.fileId) closeSource(s.fileId)
                  }}
                >
                  只留当前
                </Btn>
              )}
            </Row>
          )}

          {src?.loading && src.kind === 'file' && (
            <Band tone="info">
              加载中 {src.loadedLines.toLocaleString()} / {(src.totalLines - src.lineOffset).toLocaleString()} 行…
              （一次性整文件扫描建索引，几 GB 的文件也就几十秒）
            </Band>
          )}
          {src?.loading && src.kind === 'ssh' && (
            <Band tone="info">
              正在从服务器拉取，已接收 {fmtBytes(src.loadedLines)}…（慢的话多半是服务器在读大文件；
              不想等就点右边取消）
              <Btn variant="mini" onClick={() => closeSource(src.fileId)}>
                取消拉取
              </Btn>
            </Band>
          )}
          {src?.truncated && src.kind === 'file' && (
            <Band tone="warn">
              文件共 {src.totalLines.toLocaleString()} 行，只加载了最后 {src.loadedLines.toLocaleString()} 行（最新的部分，内存保护）。
              要看更早的，先按时间截一段再打开。
            </Band>
          )}
          {src?.truncated && src.kind === 'ssh' && src.pullMode === 'tail' && (
            <Band tone="warn">
              超过单次拉取的体积上限，只保留了最近的 {fmtBytes(src.sizeBytes)}（{src.totalLines.toLocaleString()} 行）。
              要更早的：在服务器上按时间先截一段，再点开那个文件。
            </Band>
          )}
          {src?.truncated && src.kind === 'ssh' && src.pullMode === 'range' && (
            <Band tone="warn">
              这个行区间超过单次拉取的体积上限，只拉到了前 {src.totalLines.toLocaleString()} 行；把区间收窄再拉。
            </Band>
          )}
          {/* 「服务器上还有更早的」只对按行数拉的有意义：行区间是用户点名要的那段 */}
          {src?.kind === 'ssh' && !src.loading && src.pullMode === 'tail' && src.sshTotalLines !== null && src.sshTotalLines > src.totalLines && (
            <Band tone="info">
              服务器上共 {src.sshTotalLines.toLocaleString()} 行，这次拉了 {src.totalLines.toLocaleString()} 行——更早的还在服务器上。
            </Band>
          )}
          {/* 头行命中率低不等于错：debug 打 SQL 的日志九成是堆栈/续行，正确 pattern
              也只拆出几个百分点的头行（自动识别已按「更能拆」选好了）。真正要人管
              的是一条头行都拆不出 */}
          {src && !src.loading && hitRate !== null && hitRate < 0.01 && (
            <Band tone="warn">
              当前 pattern 一条头行都没拆出来，整份文件会塌成逐行记录、时间级别全是空。
              点「自动识别」换常见格式，或把你工程 logback.xml 里的 pattern 原样贴进输入框。
            </Band>
          )}
          {grouping !== null && (
            <Band tone="info">正在整理日志 {Math.round(grouping * 100)}%…（{(lines?.length ?? 0).toLocaleString()} 行）</Band>
          )}
          {src?.error && (
            <Band tone="err" title="读取失败">
              {src.error}
              <br />
              <Hint>检查路径是否还在、有没有权限读，再重新打开这个文件</Hint>
            </Band>
          )}

          {/* 级别 / 关键字 / 时间窗两种模式共用：之前只挂在单份分支里，时间线里点了 MDC
              筛完没地方清，只能切回单份 */}
          {(timelineOn || (src && !src.loading)) && (
            <>
              <Row>
                {LEVELS.map((lv) => (
                  <Cb
                    key={lv}
                    checked={filter.levels.includes(lv)}
                    onChange={(on) =>
                      setFilter({
                        levels: on
                          ? [...filter.levels, lv]
                          : filter.levels.filter((x) => x !== lv),
                      })
                    }
                  >
                    {timelineOn ? lv : `${lv}（${counts[lv] ?? 0}）`}
                  </Cb>
                ))}
                <Spacer />
                <Seg
                  options={[
                    { value: 'one', label: '单份' },
                    { value: 'line', label: '时间线', title: '把开着的几份日志按发生时间交错排成一条（专业版）' },
                  ]}
                  value={timelineOn ? 'line' : 'one'}
                  onChange={(v) => {
                    if (v === 'line' && !canSshLogs(isPro)) {
                      useLicenseStore.getState().openUpgrade()
                      return
                    }
                    setTimeline(v === 'line')
                  }}
                />
                <Seg
                  options={[
                    { value: 'new', label: '降序', title: '按时间降序：刚写进去的日志排最上面' },
                    { value: 'old', label: '升序', title: '按时间升序：文件原本的顺序，从早到晚' },
                  ]}
                  value={newestFirst ? 'new' : 'old'}
                  onChange={(v) => {
                    setNewestFirst(v === 'new')
                    // 查周边里换排序：选中那条照样留在屏幕中间，不然一换就找不着了
                    if (around) scrollToRecord(aroundView(records, around, v === 'new'), selected ?? around.index)
                  }}
                />
              </Row>
              <Row>
                <DebouncedFld
                  value={filter.text}
                  onCommit={(t) => setFilter({ text: t })}
                  placeholder="关键字（搜头行 + 堆栈，比如异常类名；回车立即搜）"
                  style={{ flex: 1, minWidth: 180 }}
                />
                {filter.text && (
                  <Btn variant="mini" title="清掉关键字" onClick={() => setFilter({ text: '' })}>
                    清空
                  </Btn>
                )}
                <Cb
                  checked={filter.regex}
                  onChange={(on) => setFilter({ regex: on })}
                >
                  正则
                </Cb>
                <Cb
                  checked={!!filter.caseSensitive}
                  onChange={(on) => setFilter({ caseSensitive: on })}
                >
                  区分大小写
                </Cb>
            <span className="logv-winlbl">时间窗</span>
            <Fld
              type="datetime-local"
              value={inputFromWindow(filter.since)}
              onChange={(e) => setFilter({ since: windowFromInput(e.target.value) })}
              style={{ width: 190 }}
            />
            <span>到</span>
            <Fld
              type="datetime-local"
              value={inputFromWindow(filter.until)}
              onChange={(e) => setFilter({ until: windowFromInput(e.target.value) })}
              style={{ width: 190 }}
            />
            {(filter.since !== null || filter.until !== null) && (
              <Btn
                variant="mini"
                title="清掉时间窗——被挡掉的无时间戳行也会回来"
                onClick={() => setFilter({ since: null, until: null })}
              >
                清除
              </Btn>
            )}
          </Row>
          {filter.regex && !regexOk && <Hint>正则写错了（比如括号没闭合），暂按普通文本搜。</Hint>}
          {(filter.since !== null || filter.until !== null) && (
            <Hint>
              时间窗生效中——pattern 没拆出时间戳的行（堆栈、无头行）会被排除，想要回来就清掉时间窗。
            </Hint>
          )}
            </>
          )}

          {!timelineOn && src && !src.loading && patternShown && (
            <>
              <Row>
                <span className="logv-winlbl">拆列</span>
                <DebouncedFld
                  value={patternText}
                  onCommit={setPatternText}
                  delay={500}
                  placeholder="logback pattern，如 %d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] %-5level %logger - %msg%n"
                  style={{ flex: 2, minWidth: 260, fontFamily: 'monospace' }}
                />
                <Btn variant="mini" onClick={autoPattern} title="拿常见 logback 格式对文件试匹配，换命中率最高的">
                  自动识别
                </Btn>
                <Btn variant="mini" onClick={resetPattern} title="恢复成最常见的 logback 组合">
                  还原默认
                </Btn>
                {patOpen && (
                  <Btn variant="mini" onClick={() => setPatOpen(false)}>
                    收起
                  </Btn>
                )}
              </Row>
              {patternError && <Hint>pattern 有点问题：{patternError}。当前按普通文本逐行看。</Hint>}
            </>
          )}

          {/* 筛选是所有页签共用的：在别的页签设的关键字/时间窗带过来会把这份筛空，看着像没日志 */}
          {/* 查周边：筛选暂停，给一条明显的出口回到筛选结果 */}
          {around && !timelineOn && src && !src.loading && (
            <Band tone="info" className="logv-filterband">
              <span className="logv-filterband-t">
                查周边：第 <b>{(around.index + 1 + src.lineOffset).toLocaleString()}</b> 行前后的完整日志
                {around.sameThread && around.thread !== null && (
                  <>
                    ，只看线程 <b>{around.thread}</b>
                  </>
                )}
                （筛选已暂停，改筛选条件会自动退出）
              </span>
              <Btn
                variant="mini"
                on={around.sameThread}
                blocked={around.thread === null}
                title={
                  around.thread === null
                    ? '这条记录没拆出线程名（pattern 里没有 %thread），没法按线程筛'
                    : '并发请求的日志交错在一起时，只留这条记录所在线程的日志'
                }
                onClick={toggleSameThread}
              >
                只看同线程
              </Btn>
              <Btn variant="mini" onClick={leaveAround} title="回到筛选结果，定位到刚才那条">
                返回筛选结果
              </Btn>
            </Band>
          )}
          {!around && filterTags.length > 0 && (timelineOn || (src && !src.loading)) && (
            <Band tone="warn" className="logv-filterband">
              <span className="logv-filterband-t">
                筛选生效中（所有页签共用）：
                {filterTags.map((t) => (
                  <b key={t}>{t}</b>
                ))}
              </span>
              <Btn variant="mini" onClick={() => setFilter({ ...EMPTY_FILTER })}>
                清空筛选
              </Btn>
            </Band>
          )}
          {mixed && (
            <Hint>时间线：下面是上面 {sources.length} 个页签按时间混在一起的结果，每行标了来自哪份；点某个页签就回到只看那一份。</Hint>
          )}
          {timelineOn ? (
            <TimelineView
              sources={sources}
              filter={filter}
              onFilterText={(t) => setFilter({ text: t, regex: false })}
            />
          ) : src && !src.loading && (
            <>
              <div className="logv-stats">
                共 {records.length.toLocaleString()} 条记录，
                {around ? `查周边显示 ${shown.length.toLocaleString()} 条` : `筛出 ${filtered.length.toLocaleString()} 条`}
                （{src.kind === 'ssh' ? '已拉' : '文件'} {fmtBytes(src.sizeBytes)} · {src.encoding.toUpperCase()} ·{' '}
                {src.kind === 'file' && src.lines.length < src.totalLines
                  ? `载入最后 ${src.lines.length.toLocaleString()} / 共 ${src.totalLines.toLocaleString()}`
                  : src.totalLines.toLocaleString()}{' '}
                行 · pattern 头行命中率{' '}
                <b className={hitRate !== null && hitRate < 0.01 ? 'logv-rate-bad' : ''}>
                  {hitRate === null ? '—' : `${Math.round(hitRate * 100)}%`}
                </b>
                ）· 点任意一行看完整内容与堆栈，双击看它前后的日志
                {!patternShown && (
                  <button type="button" className="logv-patlink" onClick={() => setPatOpen(true)}>
                    列拆得不对？改 pattern
                  </button>
                )}
              </div>

              <div
                key={resetId}
                className="logv-list"
                ref={setListEl}
                onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
              >
                {shown.length === 0 ? (
                  <div className="logv-empty">
                    {grouping !== null || (big && records.length === 0)
                      ? '正在整理日志…'
                      : records.length === 0
                      ? src.kind === 'ssh'
                        ? '拉到的内容是空的——区间可能越界，或文件正好是空的。'
                        : '这份文件一行都没有。'
                      : '没有命中的记录——换换关键字或放宽级别。'}
                  </div>
                ) : (
                  <div style={{ height: shown.length * ROW_H, position: 'relative' }}>
                    {rows.map((r, i) => (
                      <div
                        key={r.index}
                        className={`logv-row${selected === r.index ? ' on' : ''}${around?.index === r.index ? ' anchor' : ''}`}
                        style={{ top: (start + i) * ROW_H }}
                        onClick={() => setSelected(r.index)}
                        onDoubleClick={() => enterAround(r)}
                      >
                        <span className="logv-ts">{fmtTime(r.ts)}</span>
                        <span className={`logv-lv logv-lv-${(r.level ?? 'NONE').toLowerCase()}`}>
                          {r.level ?? '—'}
                        </span>
                        <span className="logv-thread">{r.thread ?? ''}</span>
                        <span className="logv-logger">{r.logger ?? ''}</span>
                        <span className="logv-msg">{r.msg}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {(() => {
                if (selected === null) return null
                const r = records.find((x) => x.index === selected)
                if (!r) return null
                const mdcEntries = Object.entries(r.mdc)
                return (
                  <>
                    {/* 列表与详情之间的拖拽条：上下拖定详情高度，双击回到跟内容走 */}
                    <div
                      className="logv-vsplit"
                      title="上下拖调详情高度，双击恢复默认"
                      onPointerDown={onVsplitDown}
                      onDoubleClick={onVsplitDouble}
                    />
                    <div className="logv-detail">
                    <div className="logv-detail-head">
                      <span className={`logv-lv logv-lv-${(r.level ?? 'none').toLowerCase()}`}>
                        {r.level ?? '—'}
                      </span>
                      <b>{fmtTime(r.ts)}</b>
                      {r.thread && <span>线程 {r.thread}</span>}
                      {r.logger && <span>{r.logger}</span>}
                      <span className="logv-detail-line">第 {(r.index + 1 + src.lineOffset).toLocaleString()} 行起</span>
                      <span style={{ flex: 1 }} />
                      <Btn
                        variant="mini"
                        title="暂停筛选，看这条前后的完整日志（双击列表里的行也行）"
                        onClick={() => enterAround(r)}
                      >
                        查周边
                      </Btn>
                      <CopyBtn text={[r.raw, ...r.stack].join('\n')} />
                      <Btn
                        variant="mini"
                        title="关掉详情卡"
                        onClick={() => setSelected(null)}
                      >
                        ×
                      </Btn>
                    </div>
                    {/* MDC（traceId 这类一次请求的标记）：pattern 里有 %X 才拆得出。
                        点一个值就把全日志里带它的记录筛出来——一个请求的完整链路 */}
                    {mdcEntries.length > 0 && (
                      <div className="logv-mdc">
                        <span className="logv-ssh-hint">MDC：</span>
                        {mdcEntries.slice(0, 4).map(([k, v]) => (
                          <Btn
                            key={k}
                            variant="mini"
                            title={`筛出日志里所有 ${k}=${v} 的记录（这一笔请求的完整链路）`}
                            onClick={() => setFilter({ text: v, regex: false })}
                          >
                            {k}={v}
                          </Btn>
                        ))}
                        {mdcEntries.length > 4 && (
                          <span className="logv-ssh-hint">…共 {mdcEntries.length} 项</span>
                        )}
                      </div>
                    )}
                    <pre className="logv-detail-body" ref={detailBodyRef} style={preStyle}>
                      {[prettyJsonInText(r.msg), ...r.stack].join('\n')}
                    </pre>
                    </div>
                  </>
                )
              })()}
            </>
          )}
        </>
      )}
      </div>
    </div>
  )
}
