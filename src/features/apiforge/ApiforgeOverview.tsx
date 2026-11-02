/**
 * 扫描页顶上的概览（照极光设计稿「码上测」首页）：四张统计卡 + 回归进度 + 近 7 轮失败数。
 * 数字只拿现成的：当前扫描结果、跑批进度、回归报告历史；一样都没有就整块不出。
 */
import { useMemo } from 'react'
import { Card, Stat, Stats } from '../../components/ui'
import { useApiforgeStore } from '../../store/useApiforgeStore'
import { fmtLocal } from '../../lib/apiforge/localTime'
import type { ReportHistoryEntry } from '../../lib/apiforge/reportHistory'
import { apiTotal } from './apiforgeRun'
import { RunSteps } from './apiforgeBits'

/** 历史里存的是毫秒，fmtLocal 吃 ISO 串 */
const at = (ms: number) => fmtLocal(new Date(ms).toISOString())

const rateOf = (e: ReportHistoryEntry) => (e.passed + e.failed ? (e.passed / (e.passed + e.failed)) * 100 : 0)

export function ApiforgeOverview() {
  const scan = useApiforgeStore((s) => s.scan)
  const running = useApiforgeStore((s) => s.running)
  const progress = useApiforgeStore((s) => s.progress)
  const env = useApiforgeStore((s) => s.env)
  const history = useApiforgeStore((s) => s.reportHistory)
  const setView = useApiforgeStore((s) => s.setView)

  // 只看当前工程的历史；还没打开工程时看全部
  const runs = useMemo(
    () =>
      history
        .filter((e) => !scan || e.projectRoot === scan.root)
        .slice()
        .sort((a, b) => a.ranAt - b.ranAt),
    [history, scan],
  )
  const last = runs.at(-1)
  const prev = runs.at(-2)
  const recent = runs.slice(-7)
  const maxFail = Math.max(1, ...recent.map((e) => e.failed))

  if (!scan && !last && !running) return null

  const apis = scan ? apiTotal(scan) : 0
  const ctrls = scan ? scan.projects.reduce((n, p) => n + p.controllers.length, 0) : 0
  const rate = last ? rateOf(last) : null
  const failDelta = last && prev ? last.failed - prev.failed : null

  return (
    <div className="apf-overview">
      <Stats className="stats-4">
        <Stat t="接口总数" v={apis} f={scan ? `${scan.projects.length} 个工程 · ${ctrls} 个 Controller` : '还没打开工程'} />
        <Stat t="上轮用例" v={last ? last.passed + last.failed : 0} f={last ? `${at(last.ranAt)} · 用时 ${Math.round(last.durationMs / 1000)} 秒` : '还没跑过回归'} />
        <Stat t="上轮通过率" v={rate === null ? '—' : `${rate.toFixed(1)}%`} tone="acc" f={<span className="apf-ov-bar"><i style={{ width: `${rate ?? 0}%` }} /></span>} />
        <Stat
          t="上轮失败"
          v={last ? last.failed : 0}
          tone={last && last.failed > 0 ? 'bad' : 'ok'}
          f={failDelta === null ? '跟同工程上一轮比' : failDelta > 0 ? `比上轮多 ${failDelta}` : failDelta < 0 ? `比上轮少 ${-failDelta}` : '跟上轮持平'}
        />
      </Stats>

      <div className="apf-ov-grid">
        <Card hero title="回归进度" extra={last ? <span className="apf-ov-sub">上轮 {at(last.ranAt)}</span> : undefined}>
          {running && progress ? (
            <>
              <RunSteps progress={progress} needLogin={!!env.loginApi} />
              <div className="apf-ov-big">正在跑回归</div>
              <div className="apf-ov-sub">{progress.label}</div>
              <span className="apf-ov-bar wide">
                <i style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
              </span>
            </>
          ) : last ? (
            <>
              <div className="apf-ov-big">{last.failed > 0 ? `上轮有 ${last.failed} 条没过` : '上轮全部通过'}</div>
              <div className="apf-ov-sub">
                {last.scope ?? '全量'} · 通过 {last.passed} · 失败 {last.failed}
                {last.skipped ? ` · 跳过 ${last.skipped}` : ''}
              </div>
              <span className="apf-ov-bar wide">
                <i style={{ width: `${rateOf(last)}%` }} />
              </span>
              <div className="apf-ov-acts">
                <button type="button" className="ghost" onClick={() => setView('report')}>
                  看报告
                </button>
                {scan && (
                  <button type="button" className="ghost" onClick={() => setView('apis')}>
                    去接口库
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="apf-ov-big">还没跑过回归</div>
              <div className="apf-ov-sub">点右上角「全自动回归」：生成用例 → 跑批 → 报告</div>
            </>
          )}
        </Card>

        <Card title={`近 ${recent.length || 7} 轮失败数`}>
          {recent.length ? (
            <>
              <div className="apf-ov-big">
                {last?.failed ?? 0} <small>个 · 本轮</small>
              </div>
              <div className="apf-ov-bars">
                {recent.map((e, i) => (
                  <i
                    key={e.ranAt}
                    className={i === recent.length - 1 ? 'on' : undefined}
                    style={{ height: `${Math.max(6, (e.failed / maxFail) * 100)}%` }}
                    title={`${at(e.ranAt)} · 失败 ${e.failed} / ${e.passed + e.failed}`}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="apf-ov-sub">跑过回归后这里画每轮的失败数，看在变多还是变少。</div>
          )}
        </Card>
      </div>
    </div>
  )
}
