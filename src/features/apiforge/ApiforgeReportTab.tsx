/**
 * 报告页（原型 report 视图）：汇总大数字 + 失败横幅 + 结果表格（库变更迷你摘要）
 * + 失败处理抽屉（改期望 / 暂时禁用 / 复制 curl / 单条重跑）+ 自动流程日志。
 * 失败置顶贯穿所有视图（落地约束 7）。
 */
import { useEffect, useMemo, useState } from 'react'
import { App as AntdApp } from 'antd'
import { FileDoneOutlined } from '@ant-design/icons'
import { ClearOutlined } from '@ant-design/icons'
import { Btn, PopSel } from '../../components/ui'
import { useApiforgeStore } from '../../store/useApiforgeStore'
import { assembleReport, changeLine, reportToHtml, reportToJson, reportToMarkdown, STATE_ORDER } from '../../lib/apiforge/report'
import { toCurl } from '../../lib/apiforge/curl'
import { countResults, isFailed, passRate, resultState } from '../../lib/apiforge/runner/resultState'
import { reportToJunitXml } from '../../lib/apiforge/ci/junit'
import { learnedToRecord, learnExpectations } from '../../lib/apiforge/ci/learn'
import { attributeFailure, attributeSummary } from '../../lib/apiforge/attribution'
import { runCase } from '../../lib/apiforge/runner/runCase'
import { fullBodyOf } from '../../lib/apiforge/http/prettyJson'
import { login } from '../../lib/apiforge/runner/login'
import { caseOk, judgeCase } from '../../lib/apiforge/runner/judge'
import { schemaCheck } from '../../lib/apiforge/scan/schemaAssert'
import { padWindow } from '../../lib/log/window'
import { isAllScope, scopeLabel } from '../../lib/apiforge/runner/scope'
import { useLogStore } from '../../store/useLogStore'
import type { BodyExpect, CaseRunResult, TestCase, WorkspaceScanResult } from '../../lib/apiforge/types'
import { cleanBodyExpects, cloneExpects, parseExpectStatus } from '../../lib/apiforge/cases/caseEdit'
import { CaseExpectEditor } from './CaseExpectEditor'
import { blockedByRunning, currentDbConn, makeDeps } from './apiforgeRun'
import { residueConnMismatch } from '../../lib/apiforge/residue'
import { buildRequest } from '../../lib/apiforge/http/request'
import { download } from './download'
import { ApfFold, DbMini, ResponsePreview, RunSteps, Verb } from './apiforgeBits'
import { ApfEmpty } from './ApfEmpty'
import { useUiStore } from '../../store/useUiStore'
import { liveDialect } from '../../lib/dbDialect'
import { CI_EXPORTS_SHOWN, runEnvOf } from '../../lib/apiforge/views'

export function ApiforgeReportTab() {
  const { message, modal } = AntdApp.useApp()
  const results = useApiforgeStore((s) => s.results)
  const running = useApiforgeStore((s) => s.running)
  const progress = useApiforgeStore((s) => s.progress)
  const runLog = useApiforgeStore((s) => s.runLog)
  const scan = useApiforgeStore((s) => s.scan)
  const env = useApiforgeStore((s) => s.env)
  const cases = useApiforgeStore((s) => s.cases)
  const requestStop = useApiforgeStore((s) => s.requestStop)
  const residue = useApiforgeStore((s) => s.residue)
  const setResidue = useApiforgeStore((s) => s.setResidue)
  const reportDiff = useApiforgeStore((s) => s.reportDiff)
  const dbSession = useUiStore((s) => s.dbSession)
  const clearResults = useApiforgeStore((s) => s.clearResults)
  const setView = useApiforgeStore((s) => s.setView)
  /** 默认只看失败；没有失败时自然列出全部 */
  const [failOnly, setFailOnly] = useState(true)
  const showAdvanced = useApiforgeStore((s) => s.showAdvanced)
  const [handleId, setHandleId] = useState<string | null>(null)
  /** 归因桶 / 工程筛选：点摘要区的 chips 切换，再点一次取消（都隐含「只看失败」） */
  const [bucketFilter, setBucketFilter] = useState<string | null>(null)
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  /** 从接口树 Controller 行红点跳来：只看该 Controller 的失败 */
  const [ctrlFilter, setCtrlFilter] = useState<{ name: string; apiIds: string[] } | null>(null)

  /**
   * 接口层跳报告的焦点（store.reportFocus）：apiId 带过来时直接打开该接口
   * 第一条失败用例的处理抽屉，让「树上点 FAIL」落到「报告里那条失败」。
   * 渲染期校正消费（不用 effect，防闪烁一帧 + oxlint set-state-in-effect）；
   * 用 ts 记消费进度，同一次跳转不会被重复应用，也不必清回 null。
   */
  const reportFocus = useApiforgeStore((s) => s.reportFocus)
  const [seenFocus, setSeenFocus] = useState(0)
  if (reportFocus && reportFocus.ts !== seenFocus) {
    setSeenFocus(reportFocus.ts)
    setFailOnly(true)
    setBucketFilter(null)
    setProjectFilter(reportFocus.project ?? null)
    setCtrlFilter(reportFocus.controller ?? null)
    const firstFail = [...results].reverse().find((r) => isFailed(r) && r.apiId === reportFocus.apiId)
    setHandleId(firstFail?.caseId ?? null)
  }

  /** Esc 关处理抽屉：抽屉是固定层，键盘逃逸是标配 */
  useEffect(() => {
    if (!handleId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHandleId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleId])

  const { passed, failed, skipped } = countResults(results)
  const rate = passRate({ passed, failed })
  const withDb = results.filter((r) => r.dbChanges.some((c) => c.op !== 'none')).length
  /** 失败归因桶（PRD v0.6 模块 4.18）：大数字下方醒目 chips，点击筛选失败行。
   *  baseUrl 进归因：「服务连不上」最常见就是地址填错，hint 里带上当前值省得翻环境页 */
  const buckets = useMemo(() => attributeSummary(results, env.baseUrl).slice(0, 6), [results, env.baseUrl])

  /** apiId → 工程名（按工程筛选用） */
  const projectNameOf = useMemo(() => {
    const m = new Map<string, string>()
    if (scan)
      for (const p of scan.projects)
        for (const c of p.controllers) for (const api of c.methods) m.set(api.id, p.projectName)
    return (apiId: string) => m.get(apiId)
  }, [scan])

  /** 失败置顶 + 三重筛选（只看失败 / 归因桶 / 工程）。chips 筛选隐含只看失败 */
  const rows = useMemo(() => {
    const sorted = [...results].sort(
      (a, b) => STATE_ORDER[resultState(a)] - STATE_ORDER[resultState(b)] || a.apiPath.localeCompare(b.apiPath),
    )
    let list = sorted
    if ((failOnly && failed > 0) || bucketFilter || projectFilter || ctrlFilter) list = list.filter(isFailed)
    if (bucketFilter) list = list.filter((r) => attributeFailure(r, env.baseUrl)?.bucket === bucketFilter)
    if (projectFilter) list = list.filter((r) => projectNameOf(r.apiId) === projectFilter)
    if (ctrlFilter) {
      const ids = new Set(ctrlFilter.apiIds)
      list = list.filter((r) => ids.has(r.apiId))
    }
    return list
  }, [results, failed, failOnly, bucketFilter, projectFilter, ctrlFilter, projectNameOf, env.baseUrl])

  const filterActive = bucketFilter !== null || projectFilter !== null || ctrlFilter !== null
  const clearFilters = () => {
    setBucketFilter(null)
    setProjectFilter(null)
    setCtrlFilter(null)
  }

  /** 按工程聚合失败数（原型 failByProject） */
  const failByProject = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of results.filter(isFailed)) {
      const k = projectNameOf(r.apiId) ?? '?'
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [results, projectNameOf])

  const enabledCaseCount = useMemo(
    () => Object.values(cases).reduce((n, list) => n + list.filter((c) => c.enabled).length, 0),
    [cases],
  )

  const exportReport = (fmt: 'md' | 'json' | 'html' | 'junit') => {
    if (!results.length) return
    // 耗时、范围与管线自动生成的报告同口径
    const { runWindow, runScope } = useApiforgeStore.getState()
    const durationMs = runWindow?.until ? runWindow.until - runWindow.since : 0
    const scopeDesc = scan && !isAllScope(runScope) ? scopeLabel(scan, runScope) : undefined
    const report = assembleReport(scan?.root ?? '', results, durationMs, scopeDesc, residue ?? undefined)
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
    const [name, body, mime] =
      fmt === 'md'
        ? [`apiforge-report-${stamp}.md`, reportToMarkdown(report, env.baseUrl), 'text/markdown']
        : fmt === 'json'
          ? [`apiforge-report-${stamp}.json`, reportToJson(report), 'application/json']
          : fmt === 'junit'
            ? [`junit-${stamp}.xml`, reportToJunitXml(report, { suiteOf: suiteOfOf(scan), baseUrl: env.baseUrl }), 'text/xml']
            : [`apiforge-report-${stamp}.html`, reportToHtml(report, env.baseUrl), 'text/html']
    download(name, body, mime)
    // 浏览器下载不弹框，不说文件名和位置就像没反应
    void message.success(`已导出到「下载」文件夹：${name}`, 5)
  }

  const handle = results.find((r) => r.caseId === handleId) ?? null

  /**
   * 失败用例 → 码上追「看日志」：把这次跑批的墙钟（startRun 起、finishRun 收）
   * 垫 ±2 分钟当过滤时间窗带过去。没有 per-case 时间戳，整场跑批的窗口是
   * 不动 types/runner 就能拿到的最准口径；窗口到了日志页还能手调。
   */
  const jumpToLogs = () => {
    const w = useApiforgeStore.getState().runWindow
    const now = Date.now()
    const win = padWindow(w?.since ?? now - 5 * 60_000, w?.until ?? null, 2 * 60_000, now)
    useLogStore.getState().requestJump({
      since: win.since,
      until: win.until,
      label: `回归 ${passed}/${passed + failed} 通过`,
    })
    useUiStore.getState().setActiveTab('logview')
  }

  /** 期望自动学习（PRD v0.6 模块 4.14）：观察模式跑完，把稳定的库变更一键学成期望 */
  const learnExpectationsAction = () => {
    const learned = learnExpectations(results)
    const usable = learned.filter((l) => l.spec)
    if (!usable.length) {
      void message.info(
        learned.length ? '本轮没有可直接采纳的期望（变更量不一致或混合变更，明细建议看导出的报告）' : '本轮没有检测到库变更；连库跑一轮写接口再试',
      )
      return
    }
    modal.confirm({
      title: `把 ${usable.length} 条稳定的库变更学成期望？`,
      content: (
        <div>
          {usable.map((l) => (
            <div key={l.table}>
              <code>
                {l.table}: {l.spec}
              </code>{' '}
              <span className="apf-hint">{l.note}</span>
            </div>
          ))}
          <div className="apf-hint apf-gap-top">
            采纳后随「环境」页导出的 apiforge.yml 给 CI 严格模式用；可重复学习覆盖。
          </div>
        </div>
      ),
      okText: '采纳',
      cancelText: '先不了',
      onOk: () => {
        const merged = { ...useApiforgeStore.getState().learnedExpectations, ...learnedToRecord(usable) }
        useApiforgeStore.getState().setLearnedExpectations(merged)
        void message.success(`已学 ${usable.length} 条期望；到「环境」页导出 apiforge.yml 生效`)
      },
    })
  }

  /** 残留清理（PRD v0.6 模块 4.16）：SQL 是检测时按方言生成好的，这里只做
   *  确认与执行——生产连接把话挑明，工具不替用户删行 */
  const residueCleanupAction = () => {
    if (!residue || residue.cleanupSql.length === 0) return
    const live = dbSession ? liveDialect(dbSession.kind) : undefined
    if (!live) {
      void message.warning('清理要连着库才能执行；到「环境 / 连库」连上再回来')
      return
    }
    // 只在检测时那个库上删：主键是从那个库查出来的，换了库会误删同主键的真数据
    const conn = currentDbConn()
    const mismatch = residueConnMismatch(residue.conn, conn)
    if (mismatch) {
      void message.error(`不能清理：${mismatch}。连回原来的库，或重新跑一轮回归再检测`)
      return
    }
    const prod = dbSession?.env === 'prod'
    modal.confirm({
      title: `在「${conn?.label ?? '当前连接'}」上执行 ${residue.cleanupSql.length} 条清理 DELETE？`,
      content: (
        <div>
          <pre className="apf-code apf-code-tall">
            {residue.cleanupSql.join('\n')}
          </pre>
          <p className="apf-hint">
            按子表在前排序，只删检测认到主键的行。清完想复核，再跑一轮回归看「测试残留」。
          </p>
          {prod && (
            <p className="apf-hint apf-bad">
              当前是生产连接——删的是用户库的真数据，务必逐条看过再点。
            </p>
          )}
        </div>
      ),
      okText: '执行清理',
      okButtonProps: { danger: true },
      cancelText: '先不删',
      onOk: async () => {
        try {
          const { affected, ran } = await live.execSql(residue.cleanupSql)
          useApiforgeStore.getState().pushRunLog(`残留清理：执行 ${ran} 条 DELETE，影响 ${affected} 行`)
          setResidue(null)
          void message.success(`已清理 ${affected} 行`)
        } catch (e) {
          void message.error(`清理失败：${String(e)}`)
        }
      },
    })
  }

  if (!results.length) {
    return (
      <div className="apf-pane">
        <div className="apf-panel">
          <div className="apf-panel-h">测试结果</div>
          {running && progress && <RunSteps progress={progress} needLogin={!!env.loginApi} />}
          {running ? (
            <div className="apf-busy">
              <span className="apf-dot" />
              运行中 · {progress ? `${progress.label}（${progress.done}/${progress.total}）` : '准备中'}
            </div>
          ) : (
            <ApfEmpty
              icon={<FileDoneOutlined aria-hidden />}
              title="还没有回归报告"
              desc="全自动回归会生成并运行用例、比对库变更，跑完这里出完整报告。"
              steps={[
                '「环境 / 连库」页配好 baseUrl；接口要登录就粘上 Token',
                '点右上「全自动回归」（多工程时可以先选只跑某个工程；单个 Controller 在接口页「运行」里跑）',
                '跑完这里出结果：大数字 + 失败归因 + 每张表的数据变更',
              ]}
              action={{ label: '去环境配置', onClick: () => setView('env') }}
            />
          )}
          {/* 跑过却没结果（多半登录失败）：原因只在日志里，默认展开 */}
          {runLog.length > 0 && (
            <ApfFold title="自动流程日志" summary={`${runLog.length} 行`} forceOpen={running} defaultOpen>
              <pre className="apf-log">{runLog.join('\n')}</pre>
            </ApfFold>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="apf-pane">
      <div className="apf-panel apf-first">
        <div className="apf-panel-h row-between">
          <span>测试结果</span>
          <span className="apf-acts">
            {/* 导出、学习期望、清空不常用，收进「更多▾」 */}
            <PopSel<ReportAction>
              className="apf-runmenu"
              value=""
              displayLabel="更多"
              aria-label="报告操作"
              options={[
                { value: 'md', label: '导出 Markdown' },
                { value: 'html', label: '导出网页（HTML）' },
                // JSON / JUnit / 学习期望都是给程序和流水线用的，开了高级才列；三样都暂时藏起
                ...(showAdvanced && CI_EXPORTS_SHOWN
                  ? [
                      { value: 'json' as const, label: '导出 JSON' },
                      { value: 'junit' as const, label: '导出 JUnit 结果（给流水线用）' },
                    ]
                  : []),
                // 只有观察模式跑出来的结果才值得学
                ...(showAdvanced && CI_EXPORTS_SHOWN && env.assertMode !== 'strict' ? [{ value: 'learn' as const, label: '学习期望' }] : []),
                { value: 'clear', label: '清空结果' },
              ]}
              onChange={(v) => {
                if (v === 'learn') learnExpectationsAction()
                else if (v === 'clear')
                  modal.confirm({
                    title: `清空这一轮 ${results.length} 条结果？`,
                    content: '清空后报告、日志和测试残留提示都会没有，只能重新跑。',
                    okText: '清空',
                    okButtonProps: { danger: true },
                    cancelText: '取消',
                    onOk: clearResults,
                  })
                else if (v) exportReport(v)
              }}
            />
          </span>
        </div>

        {running && progress && <RunSteps progress={progress} needLogin={!!env.loginApi} />}
        {running && (
          <div className="apf-busy">
            <span className="apf-dot" />
            运行中 · {progress ? `${progress.label}（${progress.done}/${progress.total}）` : '准备中'}
            <Btn danger onClick={requestStop}>
              停止
            </Btn>
          </div>
        )}
        {/* 完整日志在表格底下，跑的时候这里露最后几行，不用翻下去看跑到哪 */}
        {running && runLog.length > 0 && <pre className="apf-log">{runLog.slice(-6).join('\n')}</pre>}

        <div className="apf-summary">
          <div className={`apf-rate ${failed ? 'bad' : 'ok'}`}>{rate}%</div>
          <div className="apf-summeta">
            <div>
              通过 <b>{passed}</b> / 失败 <b className="apf-bad">{failed}</b>
              {skipped ? <> / 跳过 {skipped}</> : null} / 共 {results.length}
            </div>
            <div>
              启用用例 {enabledCaseCount} · 工程 {scan?.projects.length ?? 0} · 库变更观察 {withDb} 条有写影响
            </div>
            {reportDiff && (
              <div className="apf-atchips">
                <span className="apf-atchips-lbl">和上次比</span>
                <span className="apf-hint">
                  上次 {new Date(reportDiff.prevRanAt).toLocaleString()}：通过率{' '}
                  <b>{reportDiff.prevRate}%</b> → <b>{reportDiff.currRate}%</b> · 失败{' '}
                  <b>{reportDiff.prevFailed}</b> →{' '}
                  <b className={reportDiff.currFailed > reportDiff.prevFailed ? 'apf-bad' : undefined}>
                    {reportDiff.currFailed}
                  </b>
                  {reportDiff.newCount > 0 ? ` · 新增 ${reportDiff.newCount} 条（上次没跑）` : ''}
                </span>
                {reportDiff.regressed.length > 0 && (
                  <p className="apf-atchip-hint">
                    新失败 {reportDiff.regressed.length} 条：
                    {reportDiff.regressed
                      .slice(0, 5)
                      .map((f) => f.key)
                      .join('；')}
                    {reportDiff.regressed.length > 5 ? '；…' : ''}
                  </p>
                )}
                {reportDiff.fixed.length > 0 && (
                  <p className="apf-atchip-hint">
                    已修好 {reportDiff.fixed.length} 条：
                    {reportDiff.fixed
                      .slice(0, 5)
                      .map((f) => f.key)
                      .join('；')}
                    {reportDiff.fixed.length > 5 ? '；…' : ''}
                  </p>
                )}
              </div>
            )}
            {buckets.length > 0 && (
              <div className="apf-atchips">
                <span className="apf-atchips-lbl">失败归因</span>
                {buckets.map((s) => (
                  <button
                    key={s.bucket}
                    className={`apf-atchip${bucketFilter === s.bucket ? ' on' : ''}`}
                    title={`${s.hint}（点击只看这一类）`}
                    onClick={() => setBucketFilter(bucketFilter === s.bucket ? null : s.bucket)}
                  >
                    {s.bucket}
                    <b>{s.count}</b>
                  </button>
                ))}
                {/* 选中的归因建议直接亮出来，不靠悬停——处理建议是用户当下要读的 */}
                {bucketFilter && (
                  <p className="apf-atchip-hint">
                    {buckets.find((b) => b.bucket === bucketFilter)?.hint}
                  </p>
                )}
              </div>
            )}
            {failByProject.length > 0 && (
              <div className="apf-atchips">
                <span className="apf-atchips-lbl">按工程</span>
                {failByProject.map(([name, n]) => (
                  <button
                    key={name}
                    className={`apf-atchip proj${projectFilter === name ? ' on' : ''}`}
                    title={`只看 ${name} 的失败（再点一次取消）`}
                    onClick={() => setProjectFilter(projectFilter === name ? null : name)}
                  >
                    {name}
                    <b>{n}</b>
                  </button>
                ))}
              </div>
            )}
            {ctrlFilter && (
              <div className="apf-atchips">
                <span className="apf-atchips-lbl">按 Controller</span>
                <button className="apf-atchip on" title="取消这个筛选" onClick={() => setCtrlFilter(null)}>
                  {ctrlFilter.name} ×
                </button>
              </div>
            )}
          </div>
        </div>

        {failed > 0 && (
          <div className="apf-failbanner">
            <div>
              <b className="apf-bad">失败 {failed} 条</b>
              <span>
                {failOnly && passed + skipped > 0
                  ? `下面只列失败的；通过和跳过的 ${passed + skipped} 条点「显示全部」`
                  : '已置顶 · 可一键重跑或逐条处理'}
              </span>
              {filterActive && (
                <span>
                  已筛出 <b>{rows.length}</b> / 失败 {failed} ·{' '}
                  <button className="apf-linkbtn" onClick={clearFilters}>
                    清除筛选
                  </button>
                </span>
              )}
            </div>
            <div className="apf-acts">
              <Btn variant="primary" disabled={running} onClick={() => void rerunFailed(message)}>
                ↻ 只重跑失败
              </Btn>
              <Btn onClick={() => setFailOnly(!failOnly)}>{failOnly ? `显示全部（${results.length}）` : '只看失败'}</Btn>
              <Btn onClick={jumpToLogs} title="去码上追，按这次回归的时间窗过滤服务器/本机日志——异常堆栈就在那个时间段里">
                看日志
              </Btn>
            </div>
          </div>
        )}

        {/* 没发现残留就不挂横幅 */}
        {residue && residue.findings.length > 0 && (
          /* 测试残留（PRD v0.6 模块 4.16）：全部是候选，清理 SQL 已按子表在前排好 */
          <div className="apf-failbanner warn">
            <div>
              <b className="apf-warn">
                测试残留 {residue.findings.length > 0 ? `候选 ${residue.findings.length} 条` : '未发现'}
                {/* 新增接口插的行工具不自动删（10-20 定：手动删），单独点一下数 */}
                {residue.findings.some((f) => f.kind === 'apiInserted')
                  ? `（含本次接口新增的数据 ${residue.findings.filter((f) => f.kind === 'apiInserted').reduce((n, f) => n + (f.count ?? f.pks.length), 0)} 行）`
                  : ''}
              </b>
              <span>回归跑完自动检测 · 只是候选，删不删你说了算</span>
            </div>
            <div className="apf-acts">
              <Btn disabled={residue.cleanupSql.length === 0} onClick={residueCleanupAction}>
                <ClearOutlined aria-hidden="true" /> 清理
              </Btn>
              <Btn onClick={() => setResidue(null)}>收掉</Btn>
            </div>
          </div>
        )}
        {residue && residue.findings.length > 0 && (
          <details className="apf-datalog" open>
            <summary>残留明细 · {residue.findings.length} 条候选（检测时间 {new Date(residue.ranAt).toLocaleTimeString()}）</summary>
            <ul className="apf-dblist">
              {residue.findings.map((f, i) => (
                <li key={`${f.table}-${f.kind}-${i}`}>
                  <code>
                    {f.table}
                    {f.pkCol ? ` · ${f.pkCol}` : ''}
                  </code>{' '}
                  {f.count != null ? `${f.count} 行` : `样本 ${f.pks.length} 个主键`} —— {f.detail}
                </li>
              ))}
              {residue.skipped.map((s) => (
                <li key={`skip-${s.table}`}>
                  <code>{s.table}</code> 跳过：{s.reason}
                </li>
              ))}
            </ul>
          </details>
        )}

        {/* 报告表不再套内层滚动框，跟整页滚动 */}
        <div className="apf-restable-wrap apf-restable-page">
          <table className="apf-restable">
            <thead>
              <tr>
                <th>结果</th>
                <th>接口</th>
                <th>用例</th>
                <th>HTTP</th>
                <th>库变更</th>
                <th>说明</th>
                <th>处理</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const state = resultState(r)
                const bucket = state === 'fail' ? attributeFailure(r, env.baseUrl) : null
                return (
                  <tr key={r.caseId} className={state === 'fail' ? 'fail' : state === 'skip' ? 'skip' : ''}>
                    <td className="nw">
                      {state === 'pass' ? (
                        <span className="apf-okmark">通过</span>
                      ) : state === 'fail' ? (
                        <span className="apf-failmark">失败</span>
                      ) : (
                        <span className="apf-skipmark">跳过</span>
                      )}
                      {r.stale && (
                        <span className="apf-stalemark" title="这条用例跑完后又改过，结果可能已经不准，重跑后消失">
                          改过，没重跑
                        </span>
                      )}
                    </td>
                    <td className="nw">
                      <span className="apf-cellverb">
                        <Verb method={r.httpMethod} />
                        {/* 省略号吃在 path 上（title 看全），窄屏也不把处理列挤换行 */}
                        <span className="apf-cellpath" title={r.apiPath}>
                          {r.apiPath}
                        </span>
                      </span>
                    </td>
                    <td className="nw">{r.caseName}</td>
                    <td className="nw">{r.httpStatus ?? '—'}</td>
                    <td className="nw">
                      <DbMini changes={r.dbChanges} />
                    </td>
                    {/* 失败行的说明点了也打开处理面板：用户看到异常就想点它（10-19） */}
                    <td
                      className="apf-td-note"
                      title={[...(r.assertFails ?? []), ...(r.schemaIssues ?? [])].join('\n') || (state === 'fail' ? '点开看请求和响应' : undefined)}
                      style={state === 'fail' ? { cursor: 'pointer' } : undefined}
                      onClick={state === 'fail' ? () => setHandleId(r.caseId) : undefined}
                    >
                      {/* 归因标签行内前置：扫一眼就知道这行败在哪一类，不用悬停 */}
                      {bucket && <span className="apf-rowbucket">{bucket.bucket}</span>}
                      {r.error ??
                        (r.assertFails?.length
                          ? `断言失败：${r.assertFails[0]}${r.assertFails.length > 1 ? `（共 ${r.assertFails.length} 条）` : ''}`
                          : r.ok
                            ? '—'
                            : `期望 ${expectedOf(r)}，实际 ${r.httpStatus ?? '—'}`)}
                      {/* 结构差异单独一行（观察模式下用例可能是绿的）：状态码和体断言
                          都管不住「字段被悄悄改掉」，这行就是给它的信号位 */}
                      {r.schemaIssues?.length ? (
                        <span className="apf-schema-note" title={r.schemaIssues.join('\n')}>
                          结构差异 {r.schemaIssues.length} 处：{r.schemaIssues[0]}
                          {r.schemaIssues.length > 1 ? '…' : ''}
                        </span>
                      ) : null}
                      {/* 库变化核对只提示不判失败（10-20 定），绿的行也要看得见 */}
                      {r.dbHint ? <span className="apf-schema-note">{r.dbHint}</span> : null}
                    </td>
                    <td className="nw">
                      {state === 'fail' ? (
                        <button className="apf-linkbtn" onClick={() => setHandleId(r.caseId)}>
                          处理
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* 流程日志是过程量不是产物：折在尾部，跑批中自动展开跟进度，跑完收起让位给结果 */}
        <ApfFold title="自动流程日志" summary={runLog.length ? `${runLog.length} 行` : undefined} forceOpen={running}>
          <pre className="apf-log">{runLog.length ? runLog.join('\n') : '—'}</pre>
        </ApfFold>
      </div>

      {/* 处理抽屉是固定层（遮罩 + 右侧面板）：之前渲染在长表格尾部，
          点「处理」后抽屉在视口外，看起来跟没反应一样 */}
      {handle && <HandleDrawer r={handle} onClose={() => setHandleId(null)} onMessage={message} />}
    </div>
  )
}

function expectedOf(r: CaseRunResult): string {
  // expectedHttpStatus 不在结果里冗余存（用例里才是真源），从用例反查
  const list = useApiforgeStore.getState().cases[r.apiId] ?? []
  const c = list.find((x) => x.id === r.caseId)
  if (!c) return '—'
  // 空期望 = 不校验（caseOk 直接放行）。原来写「任意」容易读成「任意状态码都行却判了失败」
  const http = c.expectedHttpStatus.join('/') || '不校验'
  const n = c.expectBody?.length ?? 0
  return n ? `${http}；体断言 ${n} 条` : http
}

/** apiId → Controller 类名（JUnit 的 suite 维度） */
function suiteOfOf(scan: WorkspaceScanResult | null): (apiId: string) => string {
  const map = new Map<string, string>()
  if (scan) {
    for (const p of scan.projects)
      for (const c of p.controllers) for (const m of c.methods) map.set(m.id, c.className)
  }
  return (apiId) => map.get(apiId) ?? '码上测'
}

/** 只重跑失败：从 store 拿失败清单，逐条重跑后替换原结果 */
async function rerunFailed(message: ReturnType<typeof AntdApp.useApp>['message']): Promise<void> {
  const s = useApiforgeStore.getState()
  // 已禁用的用例不重跑（手动发过的失败结果也算）
  const enabledOf = (r: CaseRunResult) => (s.cases[r.apiId] ?? []).some((c) => c.id === r.caseId && c.enabled)
  const failed = s.results.filter((r) => isFailed(r) && enabledOf(r))
  if (!s.scan || !failed.length) return
  if (blockedByRunning(message)) return
  const byId = new Map<string, import('../../lib/apiforge/types').ApiMethod>()
  for (const p of s.scan.projects)
    for (const c of p.controllers) for (const m of c.methods) byId.set(m.id, m)

  let deps = makeDeps()
  if (deps.env.loginApi) {
    const outcome = await login(deps)
    if (!outcome.ok) {
      // 拿旧 token 硬跑只会得到一片 401，还被归因成「鉴权」
      s.pushRunLog(`↻ 只重跑失败：重新登录失败（${outcome.message}），没有重跑`)
      void message.error(`重新登录失败：${outcome.message}。先到环境页检查登录配置再重跑`)
      return
    }
    useApiforgeStore.getState().setToken(outcome.token, outcome.message)
    deps = { ...deps, token: outcome.token }
  }
  const items = failed
    .map((r) => {
      const api = byId.get(r.apiId)
      if (!api) return null
      const testCase = (s.cases[api.id] ?? []).find((c) => c.id === r.caseId)
      if (!testCase) return null
      return { api, testCase, relations: s.links[api.id] ?? [] }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  // 登录要等，这期间可能开了别的任务：紧贴开跑再拦一次
  if (blockedByRunning(message)) return
  s.pushRunLog(`↻ 只重跑失败 ${items.length} 条…`)
  // 不走 startRun：整轮的流水、测试残留、「和上次比」都要留着
  s.beginPartialRun(items.length)
  const fresh: CaseRunResult[] = []
  try {
    // 失败重跑多为写操作，保持串行（与跑批的并发策略一致）
    for (const item of items) {
      if (useApiforgeStore.getState().stopRequested) break
      const out = await runCase(item.api, item.testCase, item.relations, deps)
      const judged = judgeCase(
        item.testCase.expectedHttpStatus,
        item.testCase.expectBody,
        out.httpStatus,
        out.error,
        out.responseBodyText,
        schemaCheck(item.api.responseType, item.testCase, deps.dict, deps.env.assertMode === 'strict'),
      )
      // 与跑批同口径：只给仍失败的用例留完整请求/响应
      const keepFull = !judged.ok
      const full = keepFull ? fullBodyOf(out.responseBodyText) : undefined
      fresh.push({
        caseId: item.testCase.id,
        apiId: item.api.id,
        apiPath: item.api.path,
        httpMethod: item.api.httpMethod,
        caseName: item.testCase.name,
        caseType: item.testCase.type,
        ok: judged.ok,
        httpStatus: out.httpStatus,
        durationMs: out.durationMs,
        responsePreview: out.responsePreview,
        ...(full ? { responseFull: full } : {}),
        requestBodyPreview: out.requestBodyPreview,
        ...(keepFull && out.requestBodyFull ? { requestBodyFull: out.requestBodyFull } : {}),
        ...(judged.assertFails.length ? { assertFails: judged.assertFails } : {}),
        ...(judged.schemaIssues.length ? { schemaIssues: judged.schemaIssues } : {}),
        ...(out.dbHint ? { dbHint: out.dbHint } : {}),
        error: out.error,
        dbChanges: out.dbChanges.changes,
        snapshotErrors: out.dbChanges.snapshotErrors,
        dataLog: out.log,
        // 与跑批同口径：完整地址（含主机和查询参数），curl 才能直接重放
        requestUrl: buildRequest(deps.env, item.api, item.testCase, null)?.url ?? item.api.path,
      })
      useApiforgeStore.getState().tickProgress(`${item.api.path} · ${item.testCase.name}`)
    }
  } finally {
    const st = useApiforgeStore.getState()
    // 用新结果替换同 caseId 的旧结果；没跑到（被停止）的保持原样
    st.upsertResults(fresh)
    st.finishRun()
  }
  const left = useApiforgeStore.getState().results.filter(isFailed).length
  useApiforgeStore.getState().pushRunLog(`↻ 重跑完成 · 仍失败 ${left} 条`)
  void message.info(left ? `仍有 ${left} 条失败，可继续处理` : '失败项已全部通过')
}

/** zustand 快照必须引用稳定：缺用例时也不能每次给新数组，否则无限重渲（真踩过） */
const EMPTY_CASES: TestCase[] = []

/** 报告头「更多▾」的动作；'' 是菜单没选中时的占位 */
type ReportAction = '' | 'md' | 'html' | 'json' | 'junit' | 'learn' | 'clear'

/** 失败处理抽屉：期望/实际对照 + 改期望 / 暂时禁用 / 复制 curl / 单条重跑 */
function HandleDrawer({
  r,
  onClose,
  onMessage,
}: {
  r: CaseRunResult
  onClose: () => void
  onMessage: ReturnType<typeof AntdApp.useApp>['message']
}) {
  const casesRecord = useApiforgeStore((s) => s.cases)
  const cases = casesRecord[r.apiId] ?? EMPTY_CASES
  /** 重跑中禁用按钮：互斥已经挡住重复请求，这里只是不让人连点出一串提示 */
  const busy = useApiforgeStore((s) => s.running)
  // selector 里不能现造对象（快照要引用稳定），分开取再合
  const rawEnv = useApiforgeStore((s) => s.env)
  const advanced = useApiforgeStore((s) => s.showAdvanced)
  const env = runEnvOf(rawEnv, advanced)
  const scan = useApiforgeStore((s) => s.scan)
  const tc = cases.find((x) => x.id === r.caseId)
  /** 备数/清理的逐条日志：一直有记，现在直接摆进抽屉——用户才知道造数发生了什么 */
  const dataLines = r.dataLog ?? []
  const [seenCase, setSeenCase] = useState(r.caseId)
  const [reqAll, setReqAll] = useState(false)
  const [expect, setExpect] = useState((tc?.expectedHttpStatus ?? []).join(','))
  const [bodyExpects, setBodyExpects] = useState<BodyExpect[]>(() => cloneExpects(tc?.expectBody))
  // 抽屉不随「处理」目标切换重挂载：状态跟着当前用例走渲染期校正（不用 effect，
  // 否则先按旧值渲染一帧，还踩 oxlint 的 set-state-in-effect）
  if (r.caseId !== seenCase) {
    setSeenCase(r.caseId)
    setReqAll(false)
    setExpect((tc?.expectedHttpStatus ?? []).join(','))
    setBodyExpects(cloneExpects(tc?.expectBody))
  }
  const { modal } = AntdApp.useApp()
  // 点遮罩或「关闭」时，改了期望没保存先问一句，免得误点丢编辑
  const dirty =
    expect !== (tc?.expectedHttpStatus ?? []).join(',') ||
    JSON.stringify(bodyExpects) !== JSON.stringify(cloneExpects(tc?.expectBody))
  const requestClose = () => {
    if (!dirty) {
      onClose()
      return
    }
    modal.confirm({
      title: '改过的期望还没保存，确定关闭？',
      content: '关闭后这次改的状态码和响应体断言都会丢掉。',
      okText: '不保存，关闭',
      okButtonProps: { danger: true },
      cancelText: '继续编辑',
      onOk: onClose,
    })
  }
  const respTypes = scan?.projects.find((p) =>
    p.controllers.some((c) => c.methods.some((m) => m.id === r.apiId)),
  )?.types

  const saveExpected = () => {
    const nums = parseExpectStatus(expect)
    const cleanBody = cleanBodyExpects(bodyExpects)
    if (!tc || (nums.length === 0 && cleanBody.length === 0)) {
      void onMessage.warning('请输入期望状态码（如 200 或 200,201），或至少配一条响应体断言')
      return
    }
    useApiforgeStore.getState().updateCase(r.apiId, tc.id, { expectedHttpStatus: nums, expectBody: cleanBody })
    // 结果行同步重判：HTTP 部分就地重判（caseOk）；体断言没有原始响应体、就地重判不了，
    // 只能沿用已存的 assertFails —— 想按新断言立即出结论走「重跑该条」。结构差异
    // 同理沿用已存结论：严格模式下有差异的行不许被「保存期望」洗绿
    const schemaBlocks =
      env.assertMode === 'strict' && (r.schemaIssues ?? []).length > 0
    const okNow = caseOk(nums, r.httpStatus, r.error) && (r.assertFails ?? []).length === 0 && !schemaBlocks
    useApiforgeStore.setState({
      results: useApiforgeStore.getState().results.map((x) =>
        x.caseId === r.caseId
          ? // 状态码不符的说明由表格按新期望现算；这里只保留真实的失败原因（连不上、超时等），
            // 顺手清掉旧版本写进 error 的「期望 X，实际 Y」
            { ...x, ok: okNow || x.ok, error: okNow || !x.error || /^期望 [\d/]*，实际 /.test(x.error) ? undefined : x.error }
          : x,
      ),
    })
    void onMessage.info('期望已保存；响应体断言按新配置重判请点「重跑该条」')
    onClose()
  }

  const disableCase = () => {
    if (!tc) return
    useApiforgeStore.getState().setCaseEnabled(r.apiId, tc.id, false)
    void onMessage.info('已禁用该用例，报告里记为跳过')
    onClose()
  }

  const copyCurl = () => {
    // 优先用当时发出去的完整 URL（已含按工程覆盖的 baseUrl）
    const url = r.requestUrl || `${env.baseUrl.replace(/\/+$/, '')}${r.apiPath}`
    void navigator.clipboard.writeText(toCurl(r.httpMethod, url, r.requestBodyFull ?? r.requestBodyPreview))
    void onMessage.info('已复制 curl（不含登录令牌，需要的话自己加）')
  }

  const rerunOne = async () => {
    if (!tc) return
    // 和其它运行互斥；下面置 running 也顺带挡住连点
    if (blockedByRunning(onMessage)) return
    // 编辑器里改了还没保存的断言先落库：重跑必须按「屏幕上看到的配置」跑，
    // 否则改完直接点重跑会拿旧断言跑，红绿对不上
    const nums = parseExpectStatus(expect)
    const cleanBody = cleanBodyExpects(bodyExpects)
    const effective: typeof tc =
      dirty && (nums.length || cleanBody.length)
        ? { ...tc, expectedHttpStatus: nums, expectBody: cleanBody }
        : tc
    if (effective !== tc) {
      useApiforgeStore.getState().updateCase(r.apiId, tc.id, { expectedHttpStatus: nums, expectBody: cleanBody })
    }
    const deps = makeDeps()
    // 单条重跑直接用当前 deps（token 已在 store 里）。用扫描结果里的真实接口定义，
    // 否则查询参数、{id} 路径和工程地址覆盖都会丢；扫描里找不到才退回最小形状
    const api = apiOf(scan, r.apiId) ?? emptyApi(r)
    const runCaseFor = { ...effective, enabled: true }
    useApiforgeStore.getState().beginPartialRun(1)
    const out = await runCase(
      api,
      runCaseFor,
      useApiforgeStore.getState().links[r.apiId] ?? [],
      deps,
    ).finally(() => useApiforgeStore.getState().finishRun())
    const judged = judgeCase(
      effective.expectedHttpStatus,
      effective.expectBody,
      out.httpStatus,
      out.error,
      out.responseBodyText,
      schemaCheck(responseTypeOf(scan, r.apiId), effective, deps.dict, deps.env.assertMode === 'strict'),
    )
    useApiforgeStore.setState({
      results: useApiforgeStore.getState().results.map((x) =>
        x.caseId === r.caseId
          ? {
              ...x,
              ok: judged.ok,
              stale: undefined,
              httpStatus: out.httpStatus,
              durationMs: out.durationMs,
              responsePreview: out.responsePreview,
              // 显式覆盖：这次没有的字段要清掉，不能留着上一轮的失败和完整响应
              responseFull: fullBodyOf(out.responseBodyText),
              assertFails: judged.assertFails.length ? judged.assertFails : undefined,
              schemaIssues: judged.schemaIssues.length ? judged.schemaIssues : undefined,
              dbHint: out.dbHint,
              requestBodyPreview: out.requestBodyPreview,
              requestBodyFull: out.requestBodyFull,
              requestUrl: buildRequest(deps.env, api, runCaseFor, null)?.url ?? x.requestUrl,
              error: out.error,
              dbChanges: out.dbChanges.changes,
              snapshotErrors: out.dbChanges.snapshotErrors,
              dataLog: out.log,
            }
          : x,
      ),
    })
    const reasons = [
      judged.assertFails.length ? `断言失败：${judged.assertFails[0]}` : '',
      judged.schemaIssues.length ? `结构差异 ${judged.schemaIssues.length} 处：${judged.schemaIssues[0]}` : '',
    ].filter(Boolean)
    void onMessage.info(`HTTP ${out.httpStatus ?? '失败'}${reasons.length ? `；${reasons.join('；')}` : ''}`)
    onClose()
  }

  return (
    // 处理抽屉是固定层（遮罩 + 右侧面板），不跟长表格走
    <div className="apf-mask" onClick={requestClose}>
    <div className="apf-panel apf-drawer" onClick={(e) => e.stopPropagation()}>
      <div className="apf-panel-h row-between">
        <span>处理失败用例</span>
        <Btn onClick={requestClose}>关闭</Btn>
      </div>
      {/* 操作按钮放顶部吸顶，不用滚到底才找得到 */}
      <div className="apf-acts apf-drawer-acts">
        <Btn variant="primary" onClick={() => saveExpected()}>
          仅保存期望
        </Btn>
        <Btn onClick={() => void rerunOne()} disabled={busy} title="按当前期望重跑这一条">
          {busy ? '运行中…' : '重跑该条'}
        </Btn>
        <Btn onClick={disableCase}>暂时禁用</Btn>
        <Btn onClick={copyCurl}>复制 curl</Btn>
      </div>
      <div className="apf-handletitle">
        <span className="apf-failmark">失败</span>
        <div>
          <div>{r.caseName}</div>
          <div className="apf-src">
            {r.httpMethod} {r.apiPath}
          </div>
        </div>
      </div>
      <div className="apf-compare">
        <div>
          <div className="apf-panel-h subtle">期望</div>
          <pre className="apf-code">
            {tc?.expectedHttpStatus.length ? `HTTP ${tc.expectedHttpStatus.join(' / ')}` : '不校验状态码'}
            {bodyExpects.length ? `\n体断言 ${bodyExpects.length} 条` : ''}
          </pre>
        </div>
        <div>
          <div className="apf-panel-h subtle">实际</div>
          <pre className="apf-code bad">
            {`HTTP ${r.httpStatus ?? '—'}${r.error ? `\n${r.error}` : ''}${
              r.assertFails?.length ? `\n${r.assertFails.map((x) => `断言失败：${x}`).join('\n')}` : ''
            }${r.schemaIssues?.length ? `\n${r.schemaIssues.map((x) => `结构差异：${x}`).join('\n')}` : ''}`}
          </pre>
        </div>
      </div>
      {/* 请求、响应上下排：640px 宽的抽屉左右分栏太挤 */}
      <div className="apf-drawer-stack">
        <div>
          <div className="apf-panel-h subtle">请求</div>
          {/* 实际发出的 URL + body（抓包时已 pretty）。之前只有 URL，
              「到底发的啥参数」得回试跑卡对——排查 400 对不上号。 */}
          {r.requestBodyFull && (
            <div className="apf-respbar">
              <Btn variant="mini" onClick={() => setReqAll((v) => !v)}>
                {reqAll ? '收起' : `展开全部（${r.requestBodyFull.length.toLocaleString()} 字符）`}
              </Btn>
            </div>
          )}
          <pre className="apf-code">
            {r.requestBodyPreview
              ? `${r.requestUrl}\n${reqAll && r.requestBodyFull ? r.requestBodyFull : r.requestBodyPreview}`
              : r.requestUrl}
          </pre>
        </div>
        <div>
          <div className="apf-panel-h subtle">响应</div>
          <ResponsePreview
            key={r.caseId + r.durationMs}
            text={r.responsePreview || r.error || ''}
            full={r.responseFull}
            types={respTypes}
          />
        </div>
      </div>
      <div className="apf-panel-h subtle">数据库变更摘要</div>
      <ul className="apf-dblist">
        {changeLine(r)
          .split('\n')
          .map((line, i) => (
            <li key={i}>{line}</li>
          ))}
      </ul>
      {dataLines.length > 0 && (
        <>
          <div className="apf-panel-h subtle">数据日志（这条用例备了什么、清了什么）</div>
          <ul className="apf-dblist">
            {dataLines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </>
      )}
      <CaseExpectEditor
        status={expect}
        onStatus={setExpect}
        expects={bodyExpects}
        onExpects={setBodyExpects}
        hint="HTTP 200 的业务失败信封要在这里断，如 $.level 不存在；改完点「重跑该条」生效"
      />
    </div>
    </div>
  )
}

/** 结果行反查不出完整 ApiMethod 时补一个最小形状（runCase 只读 httpMethod/path/parameters/requestBody） */
function emptyApi(r: CaseRunResult): import('../../lib/apiforge/types').ApiMethod {
  return {
    id: r.apiId,
    methodName: r.caseName,
    httpMethod: r.httpMethod as import('../../lib/apiforge/types').ApiMethod['httpMethod'],
    path: r.apiPath,
    parameters: [],
    requestBodyType: null,
    requestBodyFields: [],
    responseType: '',
    description: '',
    controllerClass: '',
    filePath: '',
    projectId: '',
  }
}

/** 按 apiId 从扫描结果反查真实接口定义 */
function apiOf(scan: WorkspaceScanResult | null, apiId: string): import('../../lib/apiforge/types').ApiMethod | undefined {
  for (const p of scan?.projects ?? []) {
    for (const c of p.controllers) {
      for (const m of c.methods) if (m.id === apiId) return m
    }
  }
  return undefined
}

/** 结果行反查响应类型（结构断言拿它对照扫描字典）。查不出 = null，不校验 */
function responseTypeOf(scan: WorkspaceScanResult | null, apiId: string): string | null {
  for (const p of scan?.projects ?? []) {
    for (const c of p.controllers) {
      for (const m of c.methods) if (m.id === apiId) return m.responseType
    }
  }
  return null
}
