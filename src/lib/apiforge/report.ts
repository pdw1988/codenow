/**
 * 报告生成，PRD v0.3 模块 4.6 / 技术方案 §2.6。
 *
 * 报告是产品的交付物：HTTP 结果 + **数据库变更摘要**（核心指标）。
 * 三个格式都是纯函数拼字符串，UI 下载即可。失败置顶在所有格式里都成立
 * （落地约束 7），Token 不可能出现在报告里 —— 结果里就没存过它。
 */
import type { CaseRunResult, RegressionReport, ResidueReport } from './types'
import { summarizeChanges } from './dbdiff/dbdiff'
import { attributeFailure, attributeSummary } from './attribution'
import { countResults, resultState } from './runner/resultState'

/** 由结果列表组装报告。root 取扫描根目录，duration 由调用方计；
 *  scope 是本次范围的人话（指定服务/Controller 回归时传，全量缺省）；
 *  residue 是管线收尾的残留检测结果（没连库 / 没检测就缺省） */
export function assembleReport(
  projectRoot: string,
  results: CaseRunResult[],
  durationMs: number,
  scope?: string,
  residue?: ResidueReport,
): RegressionReport {
  const { total, passed, failed, skipped } = countResults(results)
  return {
    generatedAt: new Date().toISOString(),
    projectRoot,
    ...(scope ? { scope } : {}),
    summary: { total, passed, failed, ...(skipped ? { skipped } : {}), durationMs },
    // 完整请求 / 响应只给界面看，导出的报告里不带，免得一份报告几 MB
    results: results.map(({ responseFull: _full, requestBodyFull: _req, ...r }) => r),
    dbChangeSummary: summarizeChanges(results.map((r) => r.dbChanges)),
    ...(residue ? { residue } : {}),
  }
}

/** 失败 → 通过 → 跳过，同组内按接口路径稳定排序 —— 报告顶部永远是用户要处理的东西 */
export const STATE_ORDER = { fail: 0, pass: 1, skip: 2 } as const
const sortedResults = (report: RegressionReport): CaseRunResult[] =>
  [...report.results].sort(
    (a, b) =>
      STATE_ORDER[resultState(a)] - STATE_ORDER[resultState(b)] ||
      a.apiPath.localeCompare(b.apiPath) ||
      a.caseName.localeCompare(b.caseName),
  )

const STATE_ICON = { pass: '✅', fail: '❌', skip: '⏭' } as const

/** 「N 通过 / N 失败 / [N 跳过 /] 共 N 条」。老报告没有 skipped 按 0，不显示 */
const summaryText = (s: RegressionReport['summary']): string =>
  `${s.passed} 通过 / ${s.failed} 失败 / ${s.skipped ? `${s.skipped} 跳过 / ` : ''}共 ${s.total} 条（耗时 ${(s.durationMs / 1000).toFixed(1)}s）`

const CHANGE_ICONS: Record<string, string> = { insert: '🟢', update: '🟡', delete: '🔴', none: '⚪' }

/** 字段值给人看的形态：空串显式化（否则像渲染 bug），超长截断（PRD v0.6 模块 4.11） */
const showValue = (v: string): string => (v === '' ? "''" : v.length > 40 ? `${v.slice(0, 39)}…` : v)

/** 变更一行的展示文本。空变更显示「无」而不是空串 —— 空串像渲染 bug。
 *  UPDATE 命中主键时引擎算出的字段级前后值跟在表行下面（`  · 字段: 前 → 后`），
 *  报告 / 抽屉 / JUnit 失败正文共用这一份，看改动不用再去翻库。 */
export function changeLine(r: CaseRunResult): string {
  const parts: string[] = []
  for (const c of r.dbChanges) {
    const seg: string[] = []
    if (c.rowsInserted) seg.push(`新增 ${c.rowsInserted}${c.insertedIds.length ? ` (id=${c.insertedIds.join(',')})` : ''}`)
    if (c.rowsUpdated) seg.push(`更新 ${c.rowsUpdated}${c.updatedIds.length ? ` (id=${c.updatedIds.join(',')})` : ''}`)
    if (c.rowsDeleted) seg.push(`删除 ${c.rowsDeleted}${c.deletedIds.length ? ` (id=${c.deletedIds.join(',')})` : ''}`)
    parts.push(`${CHANGE_ICONS[c.op] ?? '⚪'} ${c.tableName}：${seg.length ? seg.join('，') : (c.note ?? '无变化')}`)
    for (const d of c.fieldDiffs) {
      parts.push(`  · ${d.field}: ${showValue(d.before)} → ${showValue(d.after)}`)
    }
  }
  if (!parts.length) return '（未关联表或未连库，无数据验证）'
  return parts.join('\n')
}

/** 残留检测章节（PRD v0.6 模块 4.16）。md / html 各自包一行文本的样式，
 *  内容同一份：候选清单 + 检测时生成好的清理 SQL（子表在前）。没检测过就不出章节 */
function residueLines(report: RegressionReport, emit: (head: string, lines: string[]) => void): void {
  const r = report.residue
  if (!r) return
  const kindLabel: Record<ResidueReport['findings'][number]['kind'], string> = {
    unclaimed: '未被认领',
    orphanFk: '外键空值',
    testPrefix: 'test前缀',
    apiInserted: '本次接口新增',
  }
  const lines: string[] = []
  if (r.findings.length === 0 && r.skipped.length === 0) {
    lines.push(`检查了 ${r.tables.length} 张关联表，没发现残留候选。`)
  }
  for (const f of r.findings) {
    const n = f.count != null ? `${f.count} 行` : `样本 ${f.pks.length} 个主键`
    lines.push(
      `- [${kindLabel[f.kind]}] ${f.table}：${n} —— ${f.detail}${
        f.pkCol ? '' : '（无主键 / 复合主键，定位不到行，不生成清理 SQL）'
      }`,
    )
  }
  for (const s of r.skipped) lines.push(`- ⏭ ${s.table}：${s.reason}`)
  if (r.cleanupSql.length) {
    lines.push(`清理 SQL（子表在前，${r.cleanupSql.length} 条——确认过再执行，工具不替你删）：`)
    lines.push('```sql')
    for (const s of r.cleanupSql) lines.push(s)
    lines.push('```')
  }
  emit(`## 测试残留（回归跑完自动检测，全部是候选，要人工确认）`, lines)
}

export function reportToJson(report: RegressionReport): string {
  return JSON.stringify(report, null, 2)
}

export function reportToMarkdown(report: RegressionReport, baseUrl?: string): string {
  const b: string[] = []
  b.push(`# 码上测 回归报告`)
  b.push('')
  b.push(`- 工程：\`${report.projectRoot}\``)
  if (report.scope) b.push(`- 范围：${report.scope}`)
  b.push(`- 生成时间：${report.generatedAt}`)
  b.push(`- 总览：${summaryText(report.summary)}`)
  b.push('')
  // 失败归因（PRD v0.6 模块 4.18）：先给桶级结论，明细里每条失败再带一行建议
  const buckets = attributeSummary(report.results, baseUrl)
  if (buckets.length) {
    b.push(`## 失败归因`)
    b.push('')
    for (const s of buckets) {
      b.push(`- **${s.bucket}** ×${s.count} —— ${s.hint}（${s.apis.slice(0, 5).join('、')}${s.apis.length > 5 ? ' 等' : ''}）`)
    }
    b.push('')
  }
  if (report.dbChangeSummary.length) {
    b.push(`## 数据库变更汇总`)
    b.push('')
    b.push(`| 表 | 新增 | 更新 | 删除 |`)
    b.push(`|---|---:|---:|---:|`)
    for (const t of report.dbChangeSummary) {
      b.push(`| ${t.tableName} | ${t.totalInserted} | ${t.totalUpdated} | ${t.totalDeleted} |`)
    }
    b.push('')
  }
  residueLines(report, (head, lines) => {
    b.push(head)
    b.push('')
    for (const l of lines) b.push(l)
    b.push('')
  })
  b.push(`## 用例明细`)
  b.push('')
  for (const r of sortedResults(report)) {
    b.push(`### ${STATE_ICON[resultState(r)]} ${r.apiPath} · ${r.caseName}`)
    b.push('')
    if (r.skipped) {
      b.push(`- 已禁用，本次不算通过也不算失败`)
      b.push('')
      continue
    }
    b.push(`- 请求：\`${r.httpMethod} ${r.requestUrl}\``)
    // 请求体跟响应同规则（pretty + 截断在抓包时已做）。MD 里截前 10 行，
    // 跟响应块一个口径——排查 400 时「发的啥」和「回的啥」要对得上。
    if (r.requestBodyPreview) {
      b.push(`- 请求体（截断）：`)
      b.push('  ```json')
      for (const line of r.requestBodyPreview.split('\n').slice(0, 10)) b.push(`  ${line}`)
      b.push('  ```')
    }
    b.push(`- HTTP：${r.httpStatus ?? '—'}（${r.durationMs}ms）${r.error ? ` · 错误：${r.error}` : ''}`)
    for (const x of r.assertFails ?? []) b.push(`- 断言失败：${x}`)
    for (const x of r.schemaIssues ?? []) b.push(`- 结构差异：${x}`)
    const a = attributeFailure(r, baseUrl)
    if (a) b.push(`- 归因：${a.bucket} —— ${a.hint}`)
    b.push(`- 数据库变更：`)
    for (const line of changeLine(r).split('\n')) {
      // 字段级明细行（`  · field: a → b`）不做列表项，缩进挂在表行下面
      b.push(line.trimStart().startsWith('·') ? `    ${line.trim()}` : `  - ${line}`)
    }
    if (r.responsePreview) {
      b.push(`- 响应（截断）：`)
      b.push('  ```json')
      for (const line of r.responsePreview.split('\n').slice(0, 10)) b.push(`  ${line}`)
      b.push('  ```')
    }
    for (const l of r.dataLog) b.push(`- 日志：${l}`)
    b.push('')
  }
  return b.join('\n')
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function reportToHtml(report: RegressionReport, baseUrl?: string): string {
  const rows = sortedResults(report)
    .map((r) => {
      if (r.skipped) {
        return `<tr class="skip">
  <td>⏭</td>
  <td>${esc(r.apiPath)}<div class="muted">${esc(r.caseName)}</div></td>
  <td>${esc(r.httpMethod)}</td>
  <td colspan="2" class="muted">已禁用（跳过）</td>
</tr>`
      }
      const change = changeLine(r)
        .split('\n')
        .map((l) => (l.trimStart().startsWith('·') ? `&ensp;&ensp;${esc(l.trim())}` : esc(l)))
        .join('<br/>')
      // 响应体是报告的一部分（PRD 4.6），截 300 字符防一屏糊满；esc 防注入
      const preview = r.responsePreview
        ? `<div class="muted">${esc(r.responsePreview.slice(0, 300))}</div>`
        : ''
      // 失败行内带归因建议（PRD v0.6 模块 4.18）
      const a = attributeFailure(r, baseUrl)
      const hint = a ? `<div class="muted">💡 ${esc(a.bucket)}：${esc(a.hint)}</div>` : ''
      // 判定明细跟 UI 同口径：体断言取第一条带总数，结构差异单独一行
      const assertNote = r.assertFails?.length
        ? `<div class="muted">断言失败：${esc(r.assertFails[0])}${r.assertFails.length > 1 ? `（共 ${r.assertFails.length} 条）` : ''}</div>`
        : ''
      const schemaNote = r.schemaIssues?.length
        ? `<div class="muted">结构差异 ${r.schemaIssues.length} 处：${esc(r.schemaIssues[0])}</div>`
        : ''
      // 库变化核对只提示不判失败，通过的行也要带上
      const dbNote = r.dbHint ? `<div class="muted">${esc(r.dbHint)}</div>` : ''
      /*
       * 造数 / 清理日志（PRD 4.4 落地约束 4：清理 SQL 要进报告）。MD 里是 `- 日志：` 列表，
       * HTML 这份以前漏了——而用户真正打开看的是 HTML。SQL 长，逐行小字排在库变更下面，
       * 超 20 行截断，别把表格撑到看不见别的列。
       */
      const fx = r.dataLog.length
        ? `<div class="muted">${r.dataLog
            .slice(0, 20)
            .map((l) => esc(l))
            .join('<br/>')}${
            r.dataLog.length > 20 ? `<br/>…其余 ${r.dataLog.length - 20} 行省略` : ''
          }</div>`
        : ''
      return `<tr class="${r.ok ? 'ok' : 'fail'}">
  <td>${r.ok ? '✅' : '❌'}</td>
  <td>${esc(r.apiPath)}<div class="muted">${esc(r.caseName)}</div></td>
  <td>${esc(r.httpMethod)}</td>
  <td>${r.httpStatus ?? '—'}<div class="muted">${r.durationMs}ms</div>${preview}${hint}${assertNote}${schemaNote}${dbNote}</td>
  <td class="change">${change}${fx}</td>
</tr>`
    })
    .join('\n')

  const summaryRows = report.dbChangeSummary
    .map(
      (t) =>
        `<tr><td>${esc(t.tableName)}</td><td>${t.totalInserted}</td><td>${t.totalUpdated}</td><td>${t.totalDeleted}</td></tr>`,
    )
    .join('\n')

  // 桶级归因表：CI 日志里扫一眼就知道这轮败在哪类问题上
  const buckets = attributeSummary(report.results, baseUrl)
  const bucketRows = buckets
    .map(
      (s) =>
        `<tr><td>${esc(s.bucket)} ×${s.count}</td><td>${esc(s.hint)}</td><td>${esc(s.apis.slice(0, 5).join('、'))}${s.apis.length > 5 ? ' 等' : ''}</td></tr>`,
    )
    .join('\n')

  let residueHtml = ''
  residueLines(report, (head, lines) => {
    residueHtml = `<h2>${esc(head)}</h2>
<pre style="white-space:pre-wrap;font-size:12.5px">${lines.map(esc).join('\n')}</pre>`
  })

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>码上测 回归报告</title>
<style>
body{font-family:system-ui,'Segoe UI',sans-serif;margin:24px;color:#1f2328;max-width:1080px}
h1{font-size:20px}.muted{color:#8b949e;font-size:12px}
table{border-collapse:collapse;width:100%;font-size:13px;margin:12px 0}
th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left;vertical-align:top}
th{background:#f6f8fa}.fail td:first-child{background:#fff1f0}
.ok{color:#1a7f37}.fail{color:#cf222e}.skip{color:#8b949e}
.chg{font-variant-numeric:tabular-nums}
</style></head><body>
<h1>码上测 回归报告</h1>
<p>工程 <code>${esc(report.projectRoot)}</code>${report.scope ? ` · 范围 <b>${esc(report.scope)}</b>` : ''} · 生成于 ${esc(report.generatedAt)} ·
${esc(summaryText(report.summary))}</p>
${report.dbChangeSummary.length ? `<h2>数据库变更汇总</h2>
<table><tr><th>表</th><th>新增</th><th>更新</th><th>删除</th></tr>${summaryRows}</table>` : ''}
${buckets.length ? `<h2>失败归因</h2>
<table><tr><th>桶</th><th>建议</th><th>涉及接口</th></tr>${bucketRows}</table>` : ''}
${residueHtml}
<h2>用例明细</h2>
<table>
<tr><th></th><th>接口 / 用例</th><th>方法</th><th>HTTP</th><th>数据库变更</th></tr>
${rows}
</table>
</body></html>`
}
