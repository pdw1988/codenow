/**
 * 日志转 SQL，PRD 4.14 —— 对话流改版（原型 mockup/logfill-chat.html）。
 *
 * 这一版把「左输入右结果 + 确认弹窗」换成了对话流，三个理由（原型的设计说明里也写了）：
 *
 * 1. **参数对照表是这个功能可信度的唯一来源，但它原来在弹窗里，点掉就再也看不见了。**
 *    变成回答卡片的一部分之后它常驻历史，随时翻回去核对。确认弹窗因此整个删掉——
 *    它的职责（核对）由常驻的对照表接管，而且比弹窗更持久。
 * 2. **历史不再丢。**原来贴第二段日志，第一段的结果就没了；对话流天然保留，
 *    顶上的会话条还能跳回去。
 * 3. **失败也是一条消息。**认不出来的时候给一张卡片说清楚「我认得哪几种」，
 *    而不是弹一个转瞬即逝的 toast。
 *
 * 有一条底线没有动：**这里没有大模型，也不该有。**本地离线工具，同一段日志
 * 必须每次出一模一样的 SQL。「追问」走固定词表（改第 N 个参数 / 只要第 N 条 /
 * 复制），认不得就明说认不得并列出词表，绝不猜——这个功能错了是不报错的：
 * 参数错位的语句照样能跑，只是数据是错的。解析仍然是 lib/sqlgen/logFill.ts 的确定性规则。
 */
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { App } from 'antd'
import { StarOutlined } from '@ant-design/icons'
import {
  FORMAT_LABELS,
  buildFilledSql,
  inferFillDialect,
  parseLog,
  type FilledStatement,
  type LogStatement,
} from '../../lib/sqlgen/logFill'
import { formatSql } from '../../lib/sqlgen/sqlFormat'
import { useFavoriteStore } from '../../store/useFavoriteStore'
import { Page } from '../../components/shell/Page'
import {
  Auto,
  Band,
  Btn,
  Card,
  Chip,
  Chips,
  Code,
  CopyBtn,
  Fld,
  Fold,
  Hint,
  Hl,
  Kbd,
  Lbl,
  Row,
  Spacer,
  Stack,
  Tag,
  Tbl,
} from '../../components/ui'

/**
 * 点一下就进对话的样例日志。它们走的是和用户粘贴完全同一条 parseLog 路径——样例不是截图。
 *
 * 表只用**订单 + 订单明细**（跟 mockData.ts 的种子表、导入页的两段 DDL 是同一套）：
 * 示例里换一张陌生的表名并没有多演示什么，只会让人先分辨「哪张是工具自带的」。
 * 每条样例钉的是一个**格式**，不是一张表：
 * 单条 INSERT（值里带逗号 + 单引号 + 不带类型的 null）、批量（一个 Preparing 配多行参数）、
 * Hibernate 的 binding parameter（布尔和时间戳按 Oracle 字面量渲染）、日志头混进来（bug1）、个数对不上。
 */
const SAMPLES: Array<{ icon: string; label: string; tone?: 'warn' | 'bad'; log: string }> = [
  {
    icon: 'MYBATIS',
    label: '单条 INSERT',
    log: `[2026-08-20 06:36:13.080]DEBUG [asyncTaskExecutor-1][c.r.s.b.a.o.dao.OrderMapper.insert:159]-> ==>  Preparing: insert into \`order\` (order_no, total, status, remark, create_time, del_flag) values (?, ?, ?, ?, ?, ?)
[2026-08-20 06:36:13.081]DEBUG [asyncTaskExecutor-1][c.r.s.b.a.o.dao.OrderMapper.insert:159]-> ==> Parameters: CT20260820000123(String), 388.00(BigDecimal), 1(Integer), 宁波市, 鄞州区 O'Brien 门店自提(String), 2026-08-20 06:36:13.081(Timestamp), null
[2026-08-20 06:36:13.095]DEBUG [asyncTaskExecutor-1][c.r.s.b.a.o.dao.OrderMapper.insert:159]-> <==    Updates: 1`,
  },
  {
    icon: 'BATCH',
    label: '批量 3 条',
    log: `==>  Preparing: insert into order_detail (order_id, sku, qty, price) values (?, ?, ?, ?)
==> Parameters: 10231(Long), SKU-A-001(String), 2(Integer), 39.90(BigDecimal)
==> Parameters: 10231(Long), SKU-B-114(String), 1(Integer), 128.00(BigDecimal)
==> Parameters: 10231(Long), SKU-C-207(String), 12(Integer), 8.50(BigDecimal)`,
  },
  {
    icon: 'HIBERNATE',
    label: '查询',
    log: `Hibernate: select o.id, o.order_no, o.total, o.status from \`order\` o where o.order_no = ? and o.del_flag = ? and o.create_time > ?
TRACE o.h.type.descriptor.sql.BasicBinder - binding parameter [1] as [VARCHAR] - [CT20260820000123]
TRACE o.h.type.descriptor.sql.BasicBinder - binding parameter [2] as [BOOLEAN] - [false]
TRACE o.h.type.descriptor.sql.BasicBinder - binding parameter [3] as [TIMESTAMP] - [2026-08-01T00:00:00]`,
  },
  {
    icon: 'NOISE',
    label: '日志头混进来',
    tone: 'warn',
    log: `[2026-08-20 06:36:13.080]DEBUG [asyncTaskExecutor-1][c.r.s.b.a.o.dao.OrderDetailMapper.insert:159]-> insert into order_detail (order_id, sku, qty) values (?, ?, ?)
[2026-08-20 06:36:13.080]DEBUG [asyncTaskExecutor-1][c.r.s.b.a.o.dao.OrderDetailMapper.insert:159]-> ==> Parameters: 10231(Long), SKU-A-001(String), 2(Integer)
[2026-08-20 06:36:13.090]DEBUG [asyncTaskExecutor-1][c.r.s.b.a.o.s.i.OrderServiceImpl.searchOrder:88]-> 查询完成`,
  },
  {
    icon: 'ERROR',
    label: '个数对不上',
    tone: 'bad',
    log: `==>  Preparing: update \`order\` set order_no = ?, total = ?, status = ?, remark = ?, create_time = ? where id = ?
==> Parameters: CT20260820000123(String), 388.00(BigDecimal), 1(Integer), 客户改地址(String)`,
  },
]

/** 「打字追问」认得的全部意图。认不得的输入会原样列出这张表，绝不猜 */
const INTENTS = ['第 N 个参数改成 X', '只要第 N 条', '复制']

/** 字面量方言从语句骨架猜（INSERT/UPDATE/DELETE 同一套），看不出来按 Oracle。 */
const fillStmt = (st: LogStatement, overrides?: Parameters<typeof buildFilledSql>[2]) =>
  buildFilledSql(st, inferFillDialect(st.template), overrides)

type Turn =
  | {
      kind: 'log'
      id: number
      /** 用户贴的原文，气泡里折叠显示 */
      text: string
      statements: LogStatement[]
      /** 用户改过的值，statements[i].params 一一对应。不直接改 statements，整批替换才好回退 */
      values: string[][]
    }
  | { kind: 'ok'; id: number; text: string; msg: string; detail: string }
  | { kind: 'nolog'; id: number; text: string; note?: string }
  | { kind: 'bad'; id: number; text: string }

type LogTurn = Extract<Turn, { kind: 'log' }>
/** 去掉 id 的回合草稿。分发版 Omit：直接 Omit 联合类型会把成员特有的字段全丢掉 */
type TurnDraft = Turn extends infer T ? (T extends Turn ? Omit<T, 'id'> : never) : never

interface Computed {
  st: LogStatement
  filled: FilledStatement
}

const isLog = (t: Turn): t is LogTurn => t.kind === 'log'

/** 一段输入是不是「日志本体」。命令都是短句；带换行或超长的直接当日志解析 */
const looksLikeLog = (v: string) => v.includes('\n') || v.length > 80

/** 会话条上每个回合的短名：第一条语句的关键词 + 条数 */
function turnLabel(t: LogTurn): string {
  const word = /select|insert|update|delete|merge/i.exec(t.statements[0]?.template ?? '')?.[0]
  return `${(word ?? 'SQL').toUpperCase()} · ${t.statements.length} 条`
}

/**
 * 打字机。只在新回答挂载那一刻跑一次，快而短——够传达「在生成」就行。
 * 动画期间显示的是挂载时那段 SQL 的前缀；结束后直接渲染最新的 code，
 * 所以改参数值触发的重算不受影响（那时代码早就「打完」了）。
 */
function TypedSql({ code }: { code: string }) {
  /* 挂载那一刻的 SQL 定格成初始 state（不用 ref：渲染期读 ref 是反模式，
     oxlint 也会拦）。动画期间显示它的前缀；shown 追平后直接渲染最新的 code，
     所以改参数值触发的重算不受影响——那时代码早就「打完」了。 */
  const [target] = useState(code)
  const [shown, setShown] = useState(0)

  useEffect(() => {
    let i = 0
    let timer: number | undefined
    const step = () => {
      i = Math.min(target.length, i + Math.max(3, Math.ceil(target.length / 26)))
      setShown(i)
      if (i < target.length) timer = window.setTimeout(step, 16)
    }
    timer = window.setTimeout(step, 90)
    return () => window.clearTimeout(timer)
  }, [target])

  const typing = shown < target.length
  return (
    <>
      <Hl code={typing ? target.slice(0, shown) : code} lang="sql" />
      {typing && <span className="cur" />}
    </>
  )
}

/* ---------- 用户气泡：默认只露 3 行 ---------- */

function LogBubble({ text }: { text: string }) {
  const lines = text.split('\n').length
  const [open, setOpen] = useState(false)

  return (
    <div className="me">
      <div className="bub">
        <div className="lbl">
          <Lbl>粘贴的日志 · {lines} 行</Lbl>
        </div>
        <pre className={open ? 'open' : undefined}>{text}</pre>
        {lines > 3 && (
          <button type="button" className="more" onClick={() => setOpen(!open)}>
            {open ? '收起 ▴' : `展开全部 ${lines} 行 ▾`}
          </button>
        )}
      </div>
    </div>
  )
}

/* ---------- 参数对照表：回答卡的一部分，常驻历史 ---------- */

interface ParamTableProps {
  /** 折叠状态的 key，跟会话里这张卡对应 */
  foldKey: string
  st: LogStatement
  filled: FilledStatement
  values: string[]
  collapsed: boolean
  onToggle: () => void
  onValueChange: (index: number, value: string) => void
}

function ParamTable({ foldKey, st, filled, values, collapsed, onToggle, onValueChange }: ParamTableProps) {
  /** 占位符和参数哪个多就取哪个：缺的那几行也要摆出来让人当场看见 */
  const n = Math.max(st.placeholders, st.params.length)
  const rows = Array.from({ length: n }, (_, i) => ({
    i,
    param: st.params[i],
    value: values[i],
    rendered: filled.params[i],
  }))

  const cols = [
    {
      key: '#',
      title: '#',
      cls: 'num',
      width: 44,
      render: (r: (typeof rows)[number]) => r.i + 1,
    },
    {
      key: 'raw',
      title: '参数',
      cls: 'mono',
      width: '32%',
      render: (r: (typeof rows)[number]) =>
        r.param ? r.param.raw : <span className="muted">— 无对应参数 —</span>,
    },
    {
      key: 'val',
      title: '值',
      width: '26%',
      render: (r: (typeof rows)[number]) =>
        r.param ? (
          <Fld value={r.value} onChange={(e) => onValueChange(r.i, e.target.value)} aria-label={`第 ${r.i + 1} 个参数的值`} />
        ) : null,
    },
    {
      key: 'lit',
      title: '字面量',
      render: (r: (typeof rows)[number]) =>
        r.rendered ? (
          <>
            <span className={r.rendered.uncertain ? 'lit uc' : 'lit'}>{r.rendered.literal}</span>{' '}
            {r.rendered.uncertain && <Tag tone="wr">未能识别类型</Tag>}
          </>
        ) : (
          <span className="lit">?（保留占位符，请勿执行）</span>
        ),
    },
  ]

  return (
    <Fold
      open={!collapsed}
      onToggle={onToggle}
      head={
        <>
          <Lbl>参数对照表</Lbl>
          <Hint>修改「值」后语句即时重算</Hint>
          <Spacer />
          <Auto>即时重算</Auto>
        </>
      }
    >
      <Tbl
        cols={cols}
        rows={rows}
        rowKey={(r) => `${foldKey}-${r.i}`}
        // 缺参数的行整行标红：这一行就是「个数对不上」的具体位置
        rowCls={(r) => (r.param ? undefined : 'bad')}
      />
    </Fold>
  )
}

export function LogFillPanel() {
  const { message } = App.useApp()
  const [turns, setTurns] = useState<Turn[]>([])
  /** 收起来的对照表。放 state 而不是 DOM：改一个值整块重渲染，DOM 状态会被冲掉 */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [draft, setDraft] = useState('')

  const seqRef = useRef(0)
  const flowRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)

  // 新回合落地后滚到底部。closest 找滚动容器：.pane 在 Page 里，这里拿不到引用
  useEffect(() => {
    const pane = flowRef.current?.closest('.pane')
    if (pane) pane.scrollTop = pane.scrollHeight
  }, [turns])

  const nextId = () => ++seqRef.current

  const addTurn = (t: TurnDraft) => setTurns((s) => [...s, { ...t, id: nextId() } as Turn])

  const copyText = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      return true
    } catch {
      message.error('复制失败，请手动选中复制')
      return false
    }
  }

  /** 贴一段日志 = 一个新回合。粘贴、样例按钮、composer 里的多行文本全走这里 */
  const pushLog = (text: string) => {
    const parsed = parseLog(text)
    if (!parsed.statements.length) {
      addTurn({ kind: 'nolog', text, note: parsed.note })
      return
    }
    const id = nextId()
    const values = parsed.statements.map((s) => s.params.map((p) => p.value))
    setTurns((s) => [...s, { kind: 'log', id, text, statements: parsed.statements, values } as Turn])
    // 对照表默认折起：产物是上面的 SQL；个数对不上的那条保持展开
    setCollapsed((prev) => {
      const next = new Set(prev)
      parsed.statements.forEach((st, si) => {
        const filled = fillStmt(
          st,
          st.params.map((p, i) => ({ ...p, value: values[si][i] ?? p.value })),
        )
        if (!filled.error) next.add(`${id}-${si}`)
      })
      return next
    })
  }

  const patchLastLog = (patch: (t: LogTurn) => LogTurn) =>
    setTurns((s) => {
      const i = s.map(isLog).lastIndexOf(true)
      if (i < 0) return s
      const target = s[i]
      if (!isLog(target)) return s
      const next = [...s]
      next[i] = patch(target)
      return next
    })

  /**
   * 固定词表的指令识别。返回 true 表示这条输入被当指令消费掉了。
   * 只在 composer 里敲的短句才会走到这——粘贴路径永远直奔 parseLog。
   */
  const handleCommand = (q: string): boolean => {
    const low = q.toLowerCase()

    const lastLog = [...turns].reverse().find(isLog)

    // 「第 N 个参数改成 X」作用于最近一段日志的第 1 条语句（原型同款约定）
    const pm = /第\s*(\d+)\s*个参数.*?(?:改成|换成|=)\s*(.+)$/.exec(q)
    if (pm && lastLog && lastLog.values[0]?.[Number(pm[1]) - 1] !== undefined) {
      const values = lastLog.values.map((row) => [...row])
      values[0][Number(pm[1]) - 1] = pm[2].trim()
      patchLastLog((t) => ({ ...t, values }))
      addTurn({
        kind: 'ok',
        text: q,
        msg: `第 ${pm[1]} 个参数改成 ${pm[2].trim()}`,
        detail: '对照表与 SQL 已重算（作用于第 1 条语句）。',
      })
      return true
    }

    const only = /只要第\s*(\d+)\s*条/.exec(q)
    if (only && lastLog && Number(only[1]) >= 1 && lastLog.statements[Number(only[1]) - 1]) {
      const keep = Number(only[1]) - 1
      patchLastLog((t) => ({ ...t, statements: [t.statements[keep]], values: [t.values[keep]] }))
      addTurn({ kind: 'ok', text: q, msg: `只保留第 ${only[1]} 条`, detail: '其余语句已从该卡片移除。' })
      return true
    }

    if (/复制|copy/i.test(low) && lastLog) {
      void copyText(lastLog.statements.map((st) => formatSql(fillStmt(st).sql)).join('\n\n'))
      addTurn({
        kind: 'ok',
        text: q,
        msg: '已复制到剪贴板',
        detail: `${lastLog.statements.length} 条语句。`,
      })
      return true
    }

    return false
  }

  /** composer 的发送：短句先试指令词表，没命中就当日志解析 */
  const send = () => {
    const v = draft.trim()
    if (!v) return
    if (looksLikeLog(v)) pushLog(v)
    else if (!handleCommand(v)) addTurn({ kind: 'bad', text: v })
    setDraft('')
    if (composerRef.current) composerRef.current.style.height = 'auto'
  }

  /* 粘贴即识别：从 clipboardData 直接拿（paste 触发时 textarea.value 还是旧的），
     整段替换——这个功能的输入就是「一段日志」，往中间插一半没有意义 */
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const txt = e.clipboardData.getData('text')
    if (!txt.trim()) return
    e.preventDefault()
    setDraft('')
    pushLog(txt)
    if (composerRef.current) composerRef.current.style.height = 'auto'
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const toggleFold = (key: string) =>
    setCollapsed((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const setParamValue = (turnId: number, si: number, pi: number, value: string) =>
    setTurns((s) =>
      s.map((t) => {
        if (t.id !== turnId || t.kind !== 'log') return t
        const values = t.values.map((row, i) => (i === si ? [...row] : row))
        values[si][pi] = value
        return { ...t, values }
      }),
    )

  const clearAll = () => {
    setTurns([])
    setCollapsed(new Set())
  }

  /* ---------- 渲染 ---------- */

  const computedOf = (t: LogTurn): Computed[] =>
    t.statements.map((st, si) => ({
      st,
      filled: fillStmt(
        st,
        st.params.map((p, i) => ({ ...p, value: t.values[si][i] ?? p.value })),
      ),
    }))

  /**
   * 整卡收藏进「我的SQL库」：范围跟「复制全部纯 SQL」完全一致（含批量卡的多条语句）。
   * 同内容去重、自动起名在 lib 的 saveSqlFavorite；落盘和内存列表走 useFavoriteStore，
   * 否则 FavPanel 仍显示挂载时读到的旧列表。
   */
  const favTurn = async (t: LogTurn) => {
    const sql = computedOf(t)
      .map((c) => formatSql(c.filled.sql))
      .join('\n\n')
    try {
      const deduped = await useFavoriteStore.getState().addSql(sql)
      message.success(deduped ? '已收藏（同内容条目已置顶）' : '已收藏到我的SQL库')
    } catch (e) {
      message.error(`收藏失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 样例 chips。空状态和「认不出来」的卡片里都要有——失败之后最近的出口就是它 */
  const chips = (
    <Chips>
      {SAMPLES.map((s) => (
        <Chip key={s.icon} badge={s.icon} tone={s.tone} onClick={() => pushLog(s.log)}>
          {s.label}
        </Chip>
      ))}
    </Chips>
  )

  const hero = (
    <div className="hero">
      <div className="eye">◈ 本地解析 · 离线 · 可复现</div>
      <h1>从日志生成可执行 SQL</h1>
      <p>
        将 <Kbd>?</Kbd> 替换为字面量。参数错位的语句仍可执行，数据会写到错误的列，请核对照表。
      </p>
      {chips}
    </div>
  )

  const replyOf = (t: Turn) => {
    if (t.kind === 'log') {
      const cs = computedOf(t)
      const anyBad = cs.some((c) => c.filled.error)
      const paramCount = cs.reduce((a, c) => a + c.st.params.length, 0)
      const latestId = [...turns].filter(isLog).at(-1)?.id
      const allSql = cs.map((c) => formatSql(c.filled.sql)).join('\n\n')

      return (
        <Card hero
          who="解析结果"
          error={anyBad}
          extra={
            <Row tight>
              <Tag tone="hi">{FORMAT_LABELS[t.statements[0].format]}</Tag>
              <Tag>{cs.length} 条语句</Tag>
              <Tag>{paramCount} 个参数</Tag>
              <Tag tone={anyBad ? 'no' : 'ok'}>{anyBad ? '✕ 个数对不上' : '✓ 个数匹配'}</Tag>
            </Row>
          }
          actions={
            <Row tight>
              <CopyBtn text={allSql}>复制全部纯 SQL</CopyBtn>
              <Btn variant="mini" onClick={() => void favTurn(t)}>
                <StarOutlined aria-hidden="true" /> 收藏
              </Btn>
              <Btn variant="mini" onClick={() => composerRef.current?.focus()}>
                继续粘贴
              </Btn>
            </Row>
          }
        >
          <Stack>
            {cs.map((c, si) => {
              const key = `${t.id}-${si}`
              // bug.txt 优化条：参数值太长后面的列看不到。展示和复制统一用格式化后的
              // 文本——只加换行缩进不改字符，所以「复制出去就能跑」不受影响
              const sql = formatSql(c.filled.sql)
              return (
                <div className="stmt" key={key}>
                  <Stack>
                    {/* 只有一条时不画「第 1 条」的题头——没有区分就没有信息量 */}
                    {cs.length > 1 && (
                      <div className="stmt-h">
                        <b>第 {si + 1} 条</b>
                        <Tag tone={c.filled.error ? 'no' : 'ok'}>
                          {c.st.placeholders} 个 ? / {c.st.params.length} 个参数
                        </Tag>
                      </div>
                    )}
                    <Code
                      code={sql}
                      name={`filled${cs.length > 1 ? `-${si + 1}` : ''}.sql`}
                      body={t.id === latestId ? <TypedSql code={sql} /> : undefined}
                    />
                    {c.filled.error && (
                      <Band tone="err" title={`执行失败：${c.filled.error}`}>
                        请勿直接执行。占位符与参数个数不一致，缺项已在对照表中标出。
                      </Band>
                    )}
                    <ParamTable
                      foldKey={key}
                      st={c.st}
                      filled={c.filled}
                      values={t.values[si]}
                      collapsed={collapsed.has(key)}
                      onToggle={() => toggleFold(key)}
                      onValueChange={(i, v) => setParamValue(t.id, si, i, v)}
                    />
                  </Stack>
                </div>
              )
            })}
          </Stack>
        </Card>
      )
    }

    if (t.kind === 'ok') {
      return (
        <Card who="已执行" extra={<Tag tone="ok">✓ {t.msg}</Tag>}>
          <div className="tx">{t.detail}</div>
        </Card>
      )
    }

    if (t.kind === 'nolog') {
      return (
        <Card who="无法识别" error extra={<Tag tone="wr">不是可识别的日志格式</Tag>}>
          <Stack>
            <div className="tx">
              未识别到 SQL 语句。本功能使用确定性规则解析，不含语言模型，不会推断未知格式。
            </div>
            {t.note && <Hint>{t.note}</Hint>}
            <Row tight>
              {Object.values(FORMAT_LABELS).map((label) => (
                <Tag key={label} tone="hi">
                  {label}
                </Tag>
              ))}
            </Row>
            {chips}
          </Stack>
        </Card>
      )
    }

    // 固定词表外的「追问」：明说认不得，把词表列出来，绝不似是而非地回一条
    return (
      <Card who="无法识别" error extra={<Tag tone="no">未匹配任何指令</Tag>}>
        <Stack>
          <div className="tx">
            未匹配指令。本功能不含语言模型。支持的指令如下；亦可直接粘贴日志。
          </div>
          <Row tight>
            {INTENTS.map((i) => (
              <Tag key={i} tone="hi">
                {i}
              </Tag>
            ))}
          </Row>
        </Stack>
      </Card>
    )
  }

  const logTurns = turns.filter(isLog)

  return (
    <Page
      tab="logfill"
      bare
      actions={
        <Row tight>
          <Auto>粘贴即解析</Auto>
          <Btn variant="ghost" disabled={!turns.length} onClick={clearAll}>
            清空
          </Btn>
        </Row>
      }
      banner={
        logTurns.length > 0 ? (
          <div className="histbar">
            <Lbl>本次会话</Lbl>
            {logTurns.map((t, i) => (
              <Btn
                key={t.id}
                variant="mini"
                on={i === logTurns.length - 1}
                onClick={() => document.getElementById(`turn-${t.id}`)?.scrollIntoView({ block: 'center' })}
              >
                {i + 1} · {turnLabel(t)}
              </Btn>
            ))}
          </div>
        ) : undefined
      }
      dock={
        <div className="dock">
          <div className="dock-in">
            <div className="comp">
              <textarea
                ref={composerRef}
                value={draft}
                spellCheck={false}
                placeholder={'粘贴日志（Ctrl+V 即时解析）\n指令：第 5 个参数改成 null / 只要第 2 条'}
                onChange={(e) => {
                  setDraft(e.target.value)
                  // 高度跟着内容长，封顶 200px 后自己滚
                  e.target.style.height = 'auto'
                  e.target.style.height = `${Math.min(200, e.target.scrollHeight)}px`
                }}
                onPaste={onPaste}
                onKeyDown={onKeyDown}
                aria-label="日志输入"
              />
              <div className="comp-bar">
                <div className="tip">Enter 发送 · Shift+Enter 换行</div>
                <Btn variant="primary" disabled={!draft.trim()} onClick={send}>
                  发送
                </Btn>
              </div>
            </div>
          </div>
        </div>
      }
    >
      <div className="flow-in" ref={flowRef}>
        {turns.length === 0 ? (
          <div className="flow-empty">{hero}</div>
        ) : (
          turns.map((t) => (
            <div className="turn" key={t.id} id={`turn-${t.id}`}>
              <LogBubble text={t.text} />
              <div style={{ marginTop: 11 }}>{replyOf(t)}</div>
            </div>
          ))
        )}
      </div>
    </Page>
  )
}
