/**
 * 关联表总览页（原型 tables 视图）：全部接口 × 关联表一块看板，
 * 勾选修正与「接口库」同一条数据路径（store.links），改一处两边同步。
 */
import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { App as AntdApp } from 'antd'
import { DatabaseOutlined } from '@ant-design/icons'
import { Btn, CopyBtn, Fld, Fold, Row } from '../../components/ui'
import { useApiforgeStore } from '../../store/useApiforgeStore'
import { useSchemaStore } from '../../store/useSchemaStore'
import { useUiStore } from '../../store/useUiStore'
import { diffEntities, type DriftKind, type EntityDiffResult } from '../../lib/apiforge/entitydiff'
import { mergeLinks, resolveLinks } from '../../lib/apiforge/link/resolveLinks'
import { capRows } from '../../lib/apiforge/uiSearch'
import { Verb } from './apiforgeBits'
import { ApfEmpty } from './ApfEmpty'

export function ApiforgeTablesTab() {
  const { message } = AntdApp.useApp()
  const scan = useApiforgeStore((s) => s.scan)
  const links = useApiforgeStore((s) => s.links)
  const setLinksFor = useApiforgeStore((s) => s.setLinksFor)
  const setView = useApiforgeStore((s) => s.setView)
  const schemaTables = useSchemaStore((s) => s.tables)
  const [filter, setFilter] = useState('')
  /** 实体对账（PRD v0.6 模块 4.15）的结果：点「开始对账」才算，不随重渲自动跑 */
  const [diff, setDiff] = useState<EntityDiffResult | null>(null)
  /** 手动加表名的草稿按接口存在这里：组折起会卸载输入框，放组里会丢 */
  const [addDraft, setAddDraft] = useState<Record<string, string>>({})

  /** 自动识别只随扫描结果变：缓存起来，过滤框每敲一个字不再全量重算 */
  const autoLinks = useMemo(() => {
    const m = new Map<string, ReturnType<typeof resolveLinks>>()
    if (!scan) return m
    for (const p of scan.projects) {
      for (const c of p.controllers) for (const api of c.methods) m.set(api.id, resolveLinks(api, p, false))
    }
    return m
  }, [scan])

  /** 认得的表名：表结构缓存 + 扫描识别出的。手动加的表不在里面只提醒可能打错，不拦 */
  const knownTables = useMemo(() => {
    const s = new Set(schemaTables.map((t) => t.name.toLowerCase()))
    for (const ls of autoLinks.values()) for (const l of ls) s.add(l.tableName.toLowerCase())
    return s
  }, [schemaTables, autoLinks])

  const board = useMemo(() => {
    if (!scan) return []
    const s = filter.trim().toLowerCase()
    const out: { apiId: string; path: string; method: string; project: string; links: ReturnType<typeof mergeLinks> }[] = []
    for (const p of scan.projects) {
      for (const c of p.controllers) {
        for (const api of c.methods) {
          if (s && !api.path.toLowerCase().includes(s) && !c.className.toLowerCase().includes(s)) continue
          out.push({
            apiId: api.id,
            path: api.path,
            method: api.httpMethod,
            project: p.projectName,
            links: mergeLinks(autoLinks.get(api.id) ?? [], links[api.id] ?? []),
          })
        }
      }
    }
    return out
  }, [scan, autoLinks, links, filter])

  const searching = filter.trim() !== ''

  /** 扫描实体（老缓存没有这个键，当空数组——卡片会提示重扫） */
  const entities = useMemo(() => scan?.projects.flatMap((p) => p.entities ?? []) ?? [], [scan])

  const runDiff = () => {
    setDiff(diffEntities(entities, schemaTables))
  }

  const driftMd = (r: EntityDiffResult): string => {
    const label: Record<DriftKind, string> = { codeOnly: '代码有库里无', dbOnly: '库有列无映射', typeMismatch: '类型对不上' }
    const b: string[] = ['# 实体 / 库表结构对账', '', `- 一致：${r.matched.length} 张表 · 库里没读到：${r.missingTables.length} 张 · 没有实体类：${r.unmappedTables.length} 张`, '']
    if (r.rows.length === 0) b.push('实体类和表结构完全一致。')
    let cur: DriftKind | null = null
    for (const row of r.rows) {
      if (row.kind !== cur) {
        cur = row.kind
        b.push(`## ${label[cur]}`, '')
      }
      b.push(`- \`${row.table}\` ${row.field}（${row.className}）—— ${row.detail}`)
    }
    if (r.missingTables.length) {
      b.push('', '## 实体指向、缓存缺表', '')
      for (const m of r.missingTables) b.push(`- \`${m.table}\`（${m.className}）`)
    }
    return b.join('\n')
  }

  /** 大目录多工程时几十个接口平铺一版根本看不过来：按工程分组折叠，
   *  单工程默认摊开（没层次可收），搜索时全放开（命中了却折着等于搜索坏了） */
  const groups = useMemo(() => {
    const m = new Map<string, typeof board>()
    for (const row of board) {
      const arr = m.get(row.project) ?? []
      arr.push(row)
      m.set(row.project, arr)
    }
    return [...m.entries()]
  }, [board])

  if (!scan || scan.projects.length === 0) {
    return (
      <div className="apf-pane">
        <ApfEmpty
          icon={<DatabaseOutlined aria-hidden />}
          title="还没有关联表"
          desc="扫描会从 MyBatis XML 识别「接口 ↔ 数据库表」的关联，回归时据此比对库里的数据变更、报告里给出每张表改了什么。"
          steps={[
            '先到「扫描」页扫出接口',
            '没识别到的接口可以在接口库 / 这里手动补表，重扫不丢',
            '之后跑全自动回归，报告就会带数据库变更摘要',
          ]}
          action={{ label: '去扫描', onClick: () => setView('scan') }}
        />
      </div>
    )
  }

  return (
    <div className="apf-pane">
      <div className="apf-panel">
        <div className="apf-panel-h row-between">
          <span>关联表识别（可修正）</span>
          <Fld value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="按路径 / Controller 过滤…" />
        </div>
        <p className="apf-hint">
          从 MyBatis 语句认出的表默认勾选；按名字猜的表默认不勾。跑批只对比勾选的表。
        </p>
        <div className="apf-board">
          {groups.map(([name, rows]) => {
            const enabledN = rows.reduce((n, r) => n + r.links.filter((l) => l.enabled).length, 0)
            return (
              <LazyGroup
                key={name}
                title={name}
                forceOpen={searching}
                defaultOpen={groups.length === 1}
                summary={`${rows.length} 个接口 · ${enabledN} 张表参与比对`}
              >
                {() => {
                  const { shown, omitted } = capRows(rows, TABLES_ROW_CAP)
                  return (
                    <>
                {shown.map((row) => (
                  <div key={row.apiId} className="apf-tblapi">
                    <div className="apf-tblapih">
                      <Verb method={row.method} />
                      <code>{row.path}</code>
                    </div>
                    {row.links.length === 0 ? (
                      <p className="apf-empty">未识别到关联表，可在下方手动添加</p>
                    ) : (
                      <div className="apf-tbllinks">
                        {row.links.map((l) => (
                          <Fragment key={l.tableName}>
                            <div className="apf-tblpair">
                              <label className={`apf-tbllink conf-${l.confidence}`}>
                                <input
                                  type="checkbox"
                                  checked={l.enabled}
                                  onChange={() => {
                                    const next = row.links.map((x) =>
                                      x.tableName === l.tableName ? { ...x, enabled: !x.enabled } : x,
                                    )
                                    void setLinksFor(row.apiId, next)
                                  }}
                                />
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
                                  })
                                }
                              >
                                查询 ↗
                              </button>
                              {l.confidence === 'user' && (
                                <button
                                  type="button"
                                  className="apf-linkbtn danger"
                                  title="删掉这张手动加的表"
                                  onClick={() =>
                                    void setLinksFor(
                                      row.apiId,
                                      row.links.filter((x) => x.tableName !== l.tableName),
                                    )
                                  }
                                >
                                  删除
                                </button>
                              )}
                            </div>
                          </Fragment>
                        ))}
                      </div>
                    )}
                    <Row>
                      <Fld
                        placeholder="手动加表名，回车确认"
                        value={addDraft[row.apiId] ?? ''}
                        onChange={(e) => {
                          const val = e.target.value
                          setAddDraft((d) => ({ ...d, [row.apiId]: val }))
                        }}
                        onKeyDown={(e) => {
                          const v = (addDraft[row.apiId] ?? '').trim().toLowerCase()
                          if (e.key === 'Enter' && v) {
                            const next = [
                              ...row.links.filter((x) => x.tableName !== v),
                              { tableName: v, confidence: 'user' as const, source: '手动添加', enabled: true },
                            ]
                            void setLinksFor(row.apiId, next)
                            if (knownTables.size > 0 && !knownTables.has(v)) {
                              void message.warning(`已添加 ${v}，但表结构缓存和扫描结果里都没有这张表，确认表名没打错`)
                            } else {
                              void message.info(`已添加关联表 ${v}`)
                            }
                            setAddDraft((d) => ({ ...d, [row.apiId]: '' }))
                          }
                        }}
                      />
                    </Row>
                  </div>
                ))}
                {omitted > 0 && (
                  <p className="apf-more">还有 {omitted} 个接口没显示，用上面的过滤缩小范围</p>
                )}
                    </>
                  )
                }}
              </LazyGroup>
            )
          })}
          {board.length === 0 && <p className="apf-empty">没有匹配「{filter}」的接口</p>}
        </div>
      </div>

      <div className="apf-panel">
        <div className="apf-panel-h row-between">
          <span>实体与表结构对账</span>
          <span className="apf-acts">
            {diff && diff.rows.length > 0 && (
              <CopyBtn text={driftMd(diff)} title="复制对账报告（Markdown 格式）">
                复制报告
              </CopyBtn>
            )}
            <Btn variant="primary" disabled={entities.length === 0} onClick={runDiff}>
              开始对账{entities.length > 0 ? ` · ${entities.length} 个实体类` : ''}
            </Btn>
          </span>
        </div>
        {entities.length === 0 ? (
          <p className="apf-hint">
            当前扫描结果里没有实体清单——实体对账认 @TableName / @Table 注解，需要用新版扫描器重新扫描一次。
          </p>
        ) : schemaTables.length === 0 ? (
          <p className="apf-hint">
            先建立表结构缓存：到「出句」导入建表 DDL，或连库导入表结构。对账就是实体字段 ↔ 这份缓存逐列比。
          </p>
        ) : !diff ? (
          <p className="apf-hint">
            扫描实体 {entities.length} 个 · 表结构缓存 {schemaTables.length} 张表。点「开始对账」逐列比：
            代码有库里无 / 库有列无映射 / 类型对不上。
          </p>
        ) : (
          <>
            <p className="apf-hint">
              一致 {diff.matched.length} 张表 · 不一致 {diff.rows.length} 处 · 库里没读到 {diff.missingTables.length} 张 ·
              没有实体类 {diff.unmappedTables.length} 张（不参与对比）
            </p>
            {diff.rows.length === 0 && <p className="apf-empty">实体类和表结构完全一致。</p>}
            {diff.rows.length > 0 && (
              <ul className="apf-dblist">
                {diff.rows.map((row, i) => (
                  <li key={`${row.kind}-${row.table}-${row.field}-${i}`}>
                    <code>
                      {row.table} · {row.field}
                    </code>{' '}
                    <span className="apf-conftag">
                      {row.kind === 'codeOnly' ? '代码有库里无' : row.kind === 'dbOnly' ? '库有列无映射' : '类型对不上'}
                    </span>{' '}
                    {row.detail}
                  </li>
                ))}
              </ul>
            )}
            {diff.missingTables.length > 0 && (
              <p className="apf-hint">
                实体指向、缓存缺表：{diff.missingTables.map((m) => `${m.table}（${m.className}）`).join('、')}——
                导入 DDL 或连库导入补上这张表再对账。
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** 一组里最多画几个接口：每行带输入框和勾选，几千行一起画会卡 */
const TABLES_ROW_CAP = 200

/** 按工程的折叠组：折着不渲染内容（ApfFold 折着也会画全部子节点） */
function LazyGroup(props: {
  title: ReactNode
  summary: ReactNode
  forceOpen?: boolean
  defaultOpen?: boolean
  children: () => ReactNode
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false)
  const on = props.forceOpen || open
  return (
    <Fold
      open={on}
      onToggle={setOpen}
      className="apf-fold"
      head={
        <>
          <span className="apf-fold-title">{props.title}</span>
          <span className="apf-fold-sum">{props.summary}</span>
        </>
      }
    >
      {on ? props.children() : null}
    </Fold>
  )
}
