/**
 * SQL 优化记录。连库查询每跑一次查询（且真的有建议）就记一笔，这一页拿它当数据源。
 *
 * 它回答两个问题：**这条老问题还在不在**（前几次跑都报了「全表扫描」，这次没了，
 * 说明加索引生效了）和**哪条规则老犯**（Top 5 排出来，改表结构时优先治它）。
 * 所以统计必须是真的从记录里数出来的，不是写死的演示数据。
 *
 * 布局：左边统计 + 筛选，右边先列表、详情在列表下面（抄我的SQL库：先找再看，
 * 编辑草稿不跟详情互冲）。**一行 = 一种「语句 + 结论」**，重跑只累加次数，
 * 到 200 种顶掉最旧的。
 *
 * 数据在同名的 store（`useSqlAdviseStore`）：连库查询跑完就写，若只存在本页挂载时
 * 读到的那份，跑完切过来还是空的。解析/统计的规则在 `lib/sqladviseLog.ts`。
 */
import { useMemo, useState } from 'react'
import { Popconfirm } from 'antd'
import { BulbOutlined } from '@ant-design/icons'
import { describeConn } from '../../lib/dbmeta'
import { dialectEntry, liveDialect } from '../../lib/dbDialect'
import { matchFavConn } from '../../lib/sqlfav'
import { ADVICE_LOG_MAX, summarizeAdviceLog, type AdviceLogEntry } from '../../lib/sqladviseLog'
import type { DbKind } from '../../types/dbconn'
import { useDbConnStore } from '../../store/useDbConnStore'
import { useDbPassStore } from '../../store/useDbPassStore'
import { useSqlAdviseStore } from '../../store/useSqlAdviseStore'
import { useUiStore } from '../../store/useUiStore'
import { Page } from '../../components/shell/Page'
import {
  Band,
  Btn,
  Card,
  Code,
  EmptyBox,
  Fld,
  GuideEmpty,
  Hint,
  Mono,
  Row,
  Seg,
  Spacer,
  Stack,
  Stat,
  Stats,
  Tag,
} from '../../components/ui'
import { AdviceItems } from './AdviceItems'

/** 列表预览取首行。SQL 首行基本就是「动哪张表」 */
const firstLine = (sql: string): string => sql.split('\n')[0]?.trim() || '（空语句）'

/**
 * 连接串。SQLite 是本机文件库，不传 `fileBased` 会渲染成 `路径@:` ——
 * 描述连接只有 `lib/dbmeta.ts` 这一份，别自己拼。
 */
const connText = (e: AdviceLogEntry): string =>
  describeConn({
    host: e.conn.host,
    port: e.conn.port,
    db: e.conn.db,
    fileBased: liveDialect(e.dialect)?.fileBased,
  })

/** 一条记录里高危建议的条数。列表上要能一眼看出「这条当时挺严重」 */
const highOf = (e: AdviceLogEntry): number => e.advice.filter((a) => a.severity === 'high').length

export function AdviceLogPage() {
  const items = useSqlAdviseStore((s) => s.items)
  const loaded = useSqlAdviseStore((s) => s.loaded)
  const loadErr = useSqlAdviseStore((s) => s.loadErr)
  const saveErr = useSqlAdviseStore((s) => s.saveErr)
  const clear = useSqlAdviseStore((s) => s.clear)
  const reload = useSqlAdviseStore((s) => s.reload)

  /* 「去连库查询」靠这三个：按 addrKey 找回完整连接、取进程内记住的密码、跳页 */
  const conns = useDbConnStore((s) => s.items)
  const peekPass = useDbPassStore((s) => s.peek)
  const jumpToDbQuery = useUiStore((s) => s.jumpToDbQuery)
  const setActiveTab = useUiStore((s) => s.setActiveTab)

  const [kind, setKind] = useState<DbKind | 'all'>('all')
  const [sev, setSev] = useState<'all' | 'high'>('all')
  const [q, setQ] = useState('')
  const [selId, setSelId] = useState<string | null>(null)

  const sum = useMemo(() => summarizeAdviceLog(items), [items])

  /* 方言筛选项只列记录里出现过的：列全部四种方言，点进去九成是「没有记录」 */
  const kinds = useMemo(() => [...new Set(items.map((e) => e.dialect))], [items])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return items.filter((e) => {
      if (kind !== 'all' && e.dialect !== kind) return false
      if (sev === 'high' && highOf(e) === 0) return false
      if (!needle) return true
      return (
        e.sql.toLowerCase().includes(needle) ||
        (e.table ?? '').toLowerCase().includes(needle) ||
        connText(e).toLowerCase().includes(needle)
      )
    })
  }, [items, kind, sev, q])

  const sel = items.find((x) => x.id === selId) ?? null
  /* 筛选把选中项筛掉了就关掉详情：留着会显示一条「当前筛选下没有」的记录 */
  if (selId !== null && sel === null) setSelId(null)

  const closeDetail = () => setSelId(null)

  /**
   * 灌回连库查询。**只灌不跑**（`run: false`）——记录里的 SQL 未必是 SELECT，
   * 可能是当时改完数又回查的那句，不能替用户按执行（同我的SQL库收藏详情）。
   */
  const goQuery = (e: AdviceLogEntry) => {
    const live = matchFavConn(conns, e.conn)
    jumpToDbQuery({
      conn: live ?? undefined,
      password: live ? peekPass(live) || undefined : undefined,
      sql: e.sql,
      table: e.table,
      run: false,
    })
  }

  /** 找不回连接时把原因说出来，但按钮照样能点（降级成用当前连接） */
  const goQueryTitle = (e: AdviceLogEntry): string => {
    const addr = `${e.conn.host}:${e.conn.port}/${e.conn.db}`
    return matchFavConn(conns, e.conn)
      ? `灌进连库查询的 SQL 框，并选回 ${addr}。不自动执行`
      : `原连接 ${addr} 已不在「我的连接」里，只灌 SQL、用当前连接。不自动执行`
  }

  const row = (e: AdviceLogEntry) => {
    const hi = highOf(e)
    return (
      <div
        key={e.id}
        className={`favitem${selId === e.id ? ' on' : ''}`}
        onClick={() => {
          // 再点已选中的那条：关掉详情，跟我的SQL库一个手势
          setSelId(selId === e.id ? null : e.id)
        }}
      >
        <div className="fr">
          <Mono>{e.at}</Mono>
          {/* 同一条 SQL 结论没变重跑过：一行顶多次，这里把次数说出来 */}
          {e.runs > 1 && <Hint>×{e.runs} 次</Hint>}
          {/* 有高危就着红：一眼看出这条当时挺严重 */}
          <Tag tone={hi > 0 ? 'no' : undefined}>{dialectEntry(e.dialect).label}</Tag>
          {/* Mono 不收 title，连接串长，省略号 + title 少折一行 */}
          <span
            className="mono grow"
            title={connText(e)}
            style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {connText(e)}
          </span>
          <Hint>
            {e.advice.length} 条建议{hi > 0 ? ` · 高危 ${hi}` : ''}
          </Hint>
        </div>
        {e.table && <span className="tblnames">表：{e.table}</span>}
        <pre>{firstLine(e.sql)}</pre>
      </div>
    )
  }

  const detailBody = sel !== null && (
    <Stack>
      <Row tight>
        {/* 重跑过就给出区间「首次 → 最近」：同一条结论跨了几天还在，本身就是信息 */}
        <Mono>{sel.runs > 1 ? `${sel.firstAt} → ${sel.at}` : sel.at}</Mono>
        {sel.runs > 1 && <Hint>累计 {sel.runs} 次</Hint>}
        <Tag tone={highOf(sel) > 0 ? 'no' : undefined}>{dialectEntry(sel.dialect).label}</Tag>
        <Mono>{connText(sel)}</Mono>
        <Spacer />
        {/* 复用的主入口：灌回去自己改。不自动执行，理由见 goQuery */}
        <Btn variant="mini" title={goQueryTitle(sel)} onClick={() => goQuery(sel)}>
          ▶ 去连库查询
        </Btn>
      </Row>
      <AdviceItems items={sel.advice} />
      {/* 当时的完整语句。截断只发生在存的时候（2000 字），这里看到的就是原文 */}
      <Code code={sel.sql} lang="sql" name="当时的 SQL" download={`advice-${sel.id}.sql`} />
    </Stack>
  )

  return (
    <Page
      tab="dbadvice"
      actions={<span className="auto">跑出建议自动记 · 最多 {ADVICE_LOG_MAX} 种</span>}
    >
      {loadErr && (
        <Band tone="err" title="读取优化记录失败">
          {String(loadErr)}
          <Btn variant="mini" onClick={() => void reload()}>
            重试
          </Btn>
        </Band>
      )}
      {!loaded && !loadErr && <EmptyBox>正在读取优化记录…</EmptyBox>}
      {saveErr && (
        <Band tone="err" title="写入失败">
          {saveErr}
        </Band>
      )}

      {loaded && (
        <Stack gap={11}>
          <Stats className="stats-4">
            <Stat t="优化次数" v={sum.runs} tone="acc" f="连库查询跑出建议就记一笔" />
            <Stat t="不同问题" v={sum.entries} f={`同一条只累加次数 · 最多 ${ADVICE_LOG_MAX} 种`} />
            <Stat t="高危" v={sum.high} tone={sum.high ? 'bad' : undefined} f="当时有高危建议的次数" />
            <Stat t="最近 7 天" v={sum.week} tone={sum.week ? 'ok' : undefined} f="这周跑出建议的次数" />
          </Stats>

          {sum.topRules.length > 0 && (
            <Card title="命中最多的规则" who="改表结构时优先治它">
              <Stack gap={6}>
                {sum.topRules.map((r) => (
                  <div key={r.id}>
                    <Row tight>
                      {/* 长标题省略号 + title：规则名可能一整句话 */}
                      <span
                        className="grow"
                        title={r.title}
                        style={{
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontSize: 12.5,
                        }}
                      >
                        {r.title}
                      </span>
                      <Hint>{r.count} 次</Hint>
                    </Row>
                    {/* 横条按第一名归一：比的是相对多少，不是绝对数 */}
                    <div className="pbar" aria-hidden>
                      <i style={{ width: `${(r.count * 100) / sum.topRules[0].count}%` }} />
                    </div>
                  </div>
                ))}
              </Stack>
            </Card>
          )}

          <div className="toolrow">
            <Fld
              className="grow"
              value={q}
              placeholder="筛选：SQL 内容 / 表名 / 连接"
              aria-label="筛选优化记录"
              onChange={(e) => setQ(e.target.value)}
            />
            {kinds.length > 1 && (
              <Seg
                value={kind}
                onChange={setKind}
                options={[
                  { value: 'all', label: `全部 ${items.length}`, title: '所有方言的记录' },
                  ...kinds.map((k) => ({
                    value: k,
                    label: `${dialectEntry(k).label} ${items.filter((e) => e.dialect === k).length}`,
                    title: `只看 ${dialectEntry(k).label} 这一档`,
                  })),
                ]}
              />
            )}
            <Seg
              value={sev}
              onChange={setSev}
              options={[
                { value: 'all', label: `全部 ${items.length}` },
                { value: 'high', label: `只看高危 ${items.filter((e) => highOf(e) > 0).length}`, title: '只看当时有高危建议的那几次' },
              ]}
            />
          </div>
          {items.length >= ADVICE_LOG_MAX && (
            <Band tone="info">
              已记满 {ADVICE_LOG_MAX} 种，出现新情况会顶掉最旧的。
            </Band>
          )}

          <Card
            title="记录"
            who={`${shown.length} 条 / 共 ${items.length} 条`}
            extra={
              <Popconfirm
                title="清空全部优化记录？"
                description="统计和列表都会归零，此操作不可撤销。不影响连库查询本身。"
                okText="确认清空"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => void clear()}
              >
                <Btn variant="mini" danger disabled={items.length === 0} title={items.length === 0 ? '还没有记录可清空' : undefined}>
                  ✕ 清空
                </Btn>
              </Popconfirm>
            }
          >
            {shown.length > 0 ? (
              shown.map(row)
            ) : items.length === 0 ? (
              <GuideEmpty
                icon={<BulbOutlined aria-hidden />}
                title="还没有优化记录"
                desc="连库查询每跑出一条优化建议就自动记一笔，这里看哪条问题还在、哪条规则老犯。"
                steps={[
                  '到「连库查询」连上库，跑一条 SELECT',
                  '跑出优化建议（全表扫描、缺索引等）时，这里自动多一条',
                ]}
                action={{ label: '去连库查询', onClick: () => setActiveTab('dbquery') }}
              />
            ) : (
              <EmptyBox>当前筛选下没有记录，换个关键词或取消筛选。</EmptyBox>
            )}
          </Card>

          {sel !== null && (
            <Card
              title="这条检出了什么"
              who={`${sel.advice.length} 条${highOf(sel) > 0 ? ` · 高危 ${highOf(sel)}` : ''}${sel.runs > 1 ? ` · 累计 ${sel.runs} 次` : ''}`}
              actions={
                <Btn variant="ghost" onClick={closeDetail}>
                  关闭详情
                </Btn>
              }
            >
              {detailBody}
            </Card>
          )}
        </Stack>
      )}
    </Page>
  )
}
