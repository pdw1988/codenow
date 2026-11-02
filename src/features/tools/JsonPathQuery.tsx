/**
 * JSON 查看（原 JSONPath 查询，导航 key 仍是 jsonpath）。
 *
 * 左边贴 JSON，粘贴即格式化；右边是可展开折叠的树，父节点标出子节点概况，
 * 搜索字段名 / 值直接定位。大整数全程走 bigIntJson，格式化不丢精度。
 *
 * 码上测的 HTTP 响应点「去 JSON 查看」会把响应体塞进 `useUiStore.jsonPathSeed`，
 * 这里渲染期接住（不落盘）。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ClipboardEvent, type KeyboardEvent } from 'react'
import { Page } from '../../components/shell/Page'
import { useUiStore } from '../../store/useUiStore'
import { parsePreservingBig, stringifyPreservingBig } from '../../lib/bigIntJson'
import {
  allBoxes,
  ancestors,
  copyText,
  defaultOpen,
  findHits,
  indexTree,
  isBox,
  KID_PAGE,
  leafText,
  preview,
  revealShown,
  splitHit,
  summary,
  visibleRows,
} from '../../lib/jsonTree'
import { autoTitle, historySize, historyTime, matchJsonHistory, type JsonHistoryEntry } from '../../lib/jsonHistory'
import { extractJson } from '../../lib/jsonPaste'
import { useJsonHistoryStore } from '../../store/useJsonHistoryStore'
import { Auto, Band, Btn, Card, Col, CopyBtn, Dlg, Fld, Hint, Mono, Row, Split, Tag, TextArea, cx } from '../../components/ui'

const SAMPLE = JSON.stringify(
  {
    code: 0,
    message: 'ok',
    data: {
      total: 3,
      page: 1,
      size: 20,
      list: [
        {
          id: 1001,
          username: 'alice',
          status: 1,
          amount: 199.0,
          createTime: '2026-08-24 10:30:00',
          orders: [{ orderNo: 'NO20260824001', total: 199.0, status: 1 }],
        },
        { id: 1002, username: 'bob', status: 0, amount: 0, createTime: '2026-08-23 09:12:44', orders: [] },
        {
          id: 1003,
          username: 'carol',
          status: 1,
          amount: 528.5,
          createTime: '2026-08-22 21:05:07',
          orders: [
            { orderNo: 'NO20260822007', total: 329.5, status: 3 },
            { orderNo: 'NO20260822008', total: 199.0, status: 1 },
          ],
        },
      ],
    },
  },
  null,
  2,
)

interface Parsed {
  /** parsePreservingBig 的结果：大整数是哨兵串 */
  data: unknown
  ok: boolean
  msg: string
  /** 「第几行第几列」，只有 SyntaxError 带 position 时才有 */
  where: string
}

/** 解析并定位错误。行列自己算：只有 position 靠得住 */
function parseJson(src: string): Parsed {
  if (!src.trim()) return { data: undefined, ok: false, msg: '', where: '' }
  try {
    // 先用裸 parse 报错：wrap 大整数会挪动 position
    JSON.parse(src)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const pos = /position\s+(\d+)/.exec(msg)?.[1]
    if (!pos) return { data: undefined, ok: false, msg, where: '' }
    const head = src.slice(0, Number(pos))
    return {
      data: undefined,
      ok: false,
      msg,
      where: `第 ${head.split('\n').length} 行 第 ${Number(pos) - head.lastIndexOf('\n')} 列`,
    }
  }
  try {
    return { data: parsePreservingBig(src), ok: true, msg: '', where: '' }
  } catch (e) {
    return { data: undefined, ok: false, msg: String(e), where: '' }
  }
}

function formatJson(src: string): string | null {
  try {
    return stringifyPreservingBig(parsePreservingBig(src), 2)
  } catch {
    return null
  }
}

/** 压成一行，历史记录存这个；不是合法 JSON 返回 null */
function compactJson(src: string): string | null {
  try {
    return stringifyPreservingBig(parsePreservingBig(src))
  } catch {
    return null
  }
}

const SAMPLE_ONE = compactJson(SAMPLE)

/** 超过这么多字符，手打字停手 LAZY_MS 才重新解析 */
const LAZY_CHARS = 200_000
const LAZY_MS = 400

const VAL_CLS = { string: 's', number: 'n', boolean: 'k', null: 'k', object: '', array: '' } as const

/** 命中的部分套 em.hit */
function Marked({ text, q }: { text: string; q: string }) {
  return (
    <>
      {splitHit(text, q).map(([s, hit], i) =>
        hit ? (
          <em key={i} className="hit">
            {s}
          </em>
        ) : (
          s
        ),
      )}
    </>
  )
}

export function JsonPathQuery() {
  /* 码上测带过来的响应体。render-time 校正而不是 useEffect，免得示例数据闪一下 */
  const seed = useUiStore((s) => s.jsonPathSeed)
  const [seenSeed, setSeenSeed] = useState(0)

  const [raw, setRaw] = useState(SAMPLE)
  /**
   * 大段 JSON 手打字时，右边树暂用的旧内容；停手 LAZY_MS 后置回 null 再解析。
   * 几 MB 的 JSON 每敲一个字全量解析一遍，输入会一顿一顿的
   */
  const [lazy, setLazy] = useState<string | null>(null)
  const lazyTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(lazyTimer.current), [])
  /** 这段 JSON 是哪来的（码上测的某个接口）；null = 自己贴的 */
  const [src, setSrc] = useState<string | null>(null)
  /** 整段换数据时 +1，树的展开状态跟着重置；手打字不动它 */
  const [gen, setGen] = useState(1)
  const [openGen, setOpenGen] = useState(0)
  const [open, setOpen] = useState<Set<string>>(new Set())
  /** 子节点超过 KID_PAGE 的容器点过「再显示」后放出多少项 */
  const [shown, setShown] = useState<Map<string, number>>(new Map())
  const [q, setQ] = useState('')
  const [cur, setCur] = useState(0)
  const [sel, setSel] = useState<string | null>(null)
  /** 跳到某个命中后 +1，触发滚动 */
  const [nav, setNav] = useState(0)
  const treeRef = useRef<HTMLDivElement>(null)

  const history = useJsonHistoryStore((s) => s.items)
  const histErr = useJsonHistoryStore((s) => s.saveErr)
  const [histOpen, setHistOpen] = useState(false)
  const [histQ, setHistQ] = useState('')
  /** 「清空全部」要点两下 */
  const [clearArm, setClearArm] = useState(false)
  /** 历史弹窗里正在改名的那条 */
  const [editing, setEditing] = useState<string | null>(null)
  /** 没起名的显示自动标题；要解析整段，只在历史变了时算 */
  const titles = useMemo(() => new Map(history.map((e) => [e.id, autoTitle(e)])), [history])

  useEffect(() => {
    void useJsonHistoryStore.getState().reload()
  }, [])

  /** 记进历史：只记合法 JSON，示例不记；同样内容只留一条 */
  const remember = (text: string, from: string | null) => {
    const c = compactJson(text)
    if (c && c !== SAMPLE_ONE) void useJsonHistoryStore.getState().add(c, from)
  }

  // 码上测带过来的响应体也记一笔（写的是外部 store，不动本组件 state）
  useEffect(() => {
    const c = seed ? compactJson(seed.json) : null
    if (seed && c) void useJsonHistoryStore.getState().add(c, seed.from)
  }, [seed])

  if (seed && seed.rev !== seenSeed) {
    setSeenSeed(seed.rev)
    setSrc(seed.from)
    setRaw(formatJson(seed.json) ?? seed.json)
    setQ('')
    setGen((g) => g + 1)
  }

  const parsed = useMemo(() => parseJson(lazy ?? raw), [lazy, raw])
  const index = useMemo(() => (parsed.ok ? indexTree(parsed.data) : null), [parsed])

  // 打字没停手时 index 还是旧内容的，等它跟上再重置展开
  if (index && lazy === null && openGen !== gen) {
    setOpenGen(gen)
    setOpen(defaultOpen(index))
    setShown(new Map())
    setSel(null)
    setCur(0)
  }

  const hits = useMemo(() => (index ? findHits(index, q) : []), [index, q])
  const at = hits.length ? Math.min(cur, hits.length - 1) : -1
  const curId = at >= 0 ? hits[at]! : null
  const hitSet = useMemo(() => new Set(hits), [hits])
  const rows = useMemo(() => (index ? visibleRows(index, open, shown) : []), [index, open, shown])

  useEffect(() => {
    // 只滚树自己，把命中行放到中间；scrollIntoView 会连整页一起滚
    const box = treeRef.current
    const row = box?.querySelector<HTMLElement>('.jt-row.jt-cur')
    if (nav && box && row) box.scrollTop = row.offsetTop - (box.clientHeight - row.offsetHeight) / 2
  }, [nav])

  const goTo = (list: string[], i: number) => {
    if (!index || !list.length) return
    const n = (i + list.length) % list.length
    setCur(n)
    setOpen((prev) => new Set([...prev, ...ancestors(index, list[n]!)]))
    setShown((prev) => revealShown(index, list[n]!, prev))
    setNav((x) => x + 1)
  }

  /** 输入法拼音过程中不定位，选完字再跳，否则每敲一个字母树就跳一下 */
  const composing = useRef(false)

  const onQuery = (v: string) => {
    setQ(v)
    setCur(0)
    if (!composing.current) goTo(index ? findHits(index, v) : [], 0)
  }

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') goTo(hits, at + (e.shiftKey ? -1 : 1))
    if (e.key === 'Escape') onQuery('')
  }

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  // 几 MB 的 JSON 每次重画都序列化一遍会拖慢展开 / 搜索，只在内容变时算
  const pretty = useMemo(() => (parsed.ok ? stringifyPreservingBig(parsed.data, 2) : ''), [parsed])
  const oneLine = useMemo(() => (parsed.ok ? stringifyPreservingBig(parsed.data) : ''), [parsed])
  const lineCount = useMemo(() => (lazy ?? raw).split('\n').length, [lazy, raw])
  /** 左边这段在历史里的那条（同内容就是同一条） */
  const curEntry = oneLine ? history.find((e) => e.json === oneLine) : undefined

  /** 给左边这段起名：已在历史里就改名，还没记过就带名字记一条 */
  const nameCurrent = (value: string) => {
    const v = value.trim()
    if (curEntry) {
      if (v !== (curEntry.name ?? '')) void useJsonHistoryStore.getState().rename(curEntry.id, v)
    } else if (v && oneLine) void useJsonHistoryStore.getState().add(oneLine, src, v)
  }

  /** 用户自己动过 JSON 就撤掉「来自码上测」那句话 */
  const editRaw = (next: string) => {
    setRaw(next)
    setSrc(null)
  }

  const onType = (next: string) => {
    clearTimeout(lazyTimer.current)
    if (next.length >= LAZY_CHARS) {
      if (lazy === null) setLazy(raw)
      lazyTimer.current = setTimeout(() => setLazy(null), LAZY_MS)
    } else setLazy(null)
    editRaw(next)
  }

  /**
   * 粘贴即格式化（只在粘贴这一下做，打字时重排会把光标弹走）。
   * 贴进来的本身是完整 JSON、拼上原文反而坏了：多半是没先全选，整段换掉。
   * 贴的是日志整行这类前后夹着别的字：去掉 { 之前和 } 之后的再格式化。
   */
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const txt = e.clipboardData.getData('text')
    if (!txt) return
    e.preventDefault()
    const el = e.currentTarget
    const merged = raw.slice(0, el.selectionStart ?? 0) + txt + raw.slice(el.selectionEnd ?? 0)
    const done =
      formatJson(merged) ?? (/^\s*[[{]/.test(txt) ? formatJson(txt) : null) ?? extractJson(txt, formatJson)
    editRaw(done ?? merged)
    if (done !== null) {
      setGen((g) => g + 1)
      remember(done, null)
    }
  }

  const openHistory = (e: JsonHistoryEntry) => {
    setRaw(formatJson(e.json) ?? e.json)
    setSrc(null)
    setQ('')
    setGen((g) => g + 1)
    setHistOpen(false)
  }

  const shownHistory = history.filter((e) => matchJsonHistory(e, histQ))

  const focus = sel ?? curId
  const focusNode = focus && index ? (index.get(focus) ?? null) : null

  const renderRow = (r: (typeof rows)[number]) => {
    const n = r.node
    const pad = { '--d': n.depth } as CSSProperties
    const comma = n.last ? '' : ','
    if (r.t === 'more') {
      const step = Math.min(r.rest, KID_PAGE)
      return (
        <div
          key={`${n.id}+`}
          className="jt-row jt-more"
          style={{ '--d': n.depth + 1 } as CSSProperties}
          onClick={() => setShown((prev) => new Map(prev).set(n.id, n.kids.length - r.rest + step))}
        >
          <span className="jt-tog" />
          <span className="jt-txt">
            … 还有 {r.rest} 项，点这里再显示 {step} 项
          </span>
        </div>
      )
    }
    if (r.t === 'close') {
      return (
        <div key={`${n.id}#`} className="jt-row" style={pad}>
          <span className="jt-tog" />
          <span className="jt-txt">
            {n.kind === 'array' ? ']' : '}'}
            {comma}
          </span>
        </div>
      )
    }
    const box = isBox(n) && n.kids.length > 0
    return (
      <div
        key={n.id}
        className={cx(
          'jt-row',
          box && 'jt-box',
          hitSet.has(n.id) && 'jt-hit',
          n.id === curId && 'jt-cur',
          n.id === sel && 'jt-sel',
        )}
        style={pad}
        title={n.id}
        onClick={() => {
          setSel(n.id)
          if (box) toggle(n.id)
        }}
      >
        <span className="jt-tog">{box ? (r.open ? '▼' : '▶') : ''}</span>
        <span className="jt-txt">
          {typeof n.key === 'string' && (
            <>
              <span className="key">
                &quot;
                <Marked text={n.key} q={q} />
                &quot;
              </span>
              {': '}
            </>
          )}
          {typeof n.key === 'number' && <span className="idx">{n.key}: </span>}
          {box ? (
            r.open ? (
              n.kind === 'array' ? '[' : '{'
            ) : (
              <>
                <span className="jt-pv">{preview(index!, n)}</span>
                {comma}
              </>
            )
          ) : (
            <>
              <span className={VAL_CLS[n.kind]}>
                <Marked text={leafText(n)} q={q} />
              </span>
              {comma}
            </>
          )}
        </span>
        {isBox(n) && <span className="jt-meta">{summary(index!, n)}</span>}
      </div>
    )
  }

  const empty = !raw.trim() ? '把 JSON 贴到左边' : '左边的 JSON 有错，改好了这里才有内容'

  return (
    <Page tab="jsonpath" actions={<Auto>粘贴即格式化 · 输入即定位</Auto>}>
      <Split even>
        {/* 两栏都 stretch + fill：左右卡一样高（用户 2026-09-22）。高度由右边树的定高给 */}
        <Col className="stretch">
          <Card hero
            className="fill"
            title="JSON"
            who={`${raw.length} 字符 · ${lineCount} 行`}
            extra={
              <Row tight>
                <Btn
                  variant="mini"
                  disabled={!parsed.ok || lazy !== null}
                  onClick={() => setRaw(raw === pretty ? oneLine : pretty)}
                >
                  {raw === pretty ? '压缩成一行' : '格式化'}
                </Btn>
                <Btn
                  variant="mini"
                  onClick={() => {
                    setHistQ('')
                    setClearArm(false)
                    setHistOpen(true)
                  }}
                  title="粘贴过、从码上测带过来、手改过的 JSON 都会记在这里，最多 50 条"
                >
                  历史 {history.length}
                </Btn>
                <Btn
                  variant="mini"
                  onClick={() => {
                    setRaw(SAMPLE)
                    setSrc(null)
                    setGen((g) => g + 1)
                  }}
                >
                  填示例
                </Btn>
              </Row>
            }
            tight
            error={!parsed.ok && raw.trim() !== ''}
            actions={
              <>
                {parsed.ok && oneLine !== SAMPLE_ONE && (
                  <label className="jh-cur">
                    名称
                    {/* 不受控：换了一段 JSON（key 变）就重新取它的名字；离开或回车才存 */}
                    <input
                      key={curEntry?.id ?? `new:${oneLine.length}`}
                      defaultValue={curEntry?.name ?? ''}
                      placeholder="给这段 JSON 起个名，比如「订单详情 · sit」，历史里一眼能认出来"
                      maxLength={80}
                      onBlur={(e) => nameCurrent(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur()
                      }}
                    />
                  </label>
                )}
                {src !== null && (
                  <Band tone="info" title="这段 JSON 来自码上测">
                    {src} 的响应体。点「填示例」或自己改过就不再是它。
                  </Band>
                )}
                {!parsed.ok && raw.trim() !== '' && (
                  <Band tone="err" title="JSON 解析失败">
                    {parsed.where}
                    <br />
                    <Mono>{parsed.msg}</Mono>
                  </Band>
                )}
              </>
            }
          >
            <TextArea
              className="flush tall"
              value={raw}
              onChange={(e) => onType(e.target.value)}
              onPaste={onPaste}
              onBlur={() => remember(raw, src)}
              placeholder="粘一段 JSON 进来 —— 格式化是自动的，不用点按钮。贴日志整行也行，{ 前面和 } 后面的字会自动去掉"
              aria-label="JSON 输入"
            />
          </Card>
        </Col>

        <Col className="stretch">
          <Card
            className="fill"
            title="JSON 结构"
            who={index ? `${index.size} 个节点` : undefined}
            extra={
              <Row tight>
                <Btn variant="mini" disabled={!index} onClick={() => index && setOpen(allBoxes(index))}>
                  全部展开
                </Btn>
                <Btn variant="mini" disabled={!index} onClick={() => setOpen(new Set(['$']))}>
                  全部折叠
                </Btn>
                <CopyBtn text={pretty} title="复制格式化后的整段 JSON" />
              </Row>
            }
            tight
          >
            <div className="jt-bar">
              <div className="expr">
                <span className="sl">⌕</span>
                <input
                  value={q}
                  onChange={(e) => onQuery(e.target.value)}
                  onKeyDown={onSearchKey}
                  onCompositionStart={() => (composing.current = true)}
                  onCompositionEnd={(e) => {
                    composing.current = false
                    onQuery(e.currentTarget.value)
                  }}
                  disabled={!index}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="搜字段名或值，回车下一个；也可以贴路径 $.data.list[0]"
                  aria-label="搜索节点"
                />
                {q.trim() !== '' && <span className="jt-n">{hits.length ? `${at + 1} / ${hits.length}` : '没找到'}</span>}
              </div>
              <Btn variant="mini" disabled={hits.length < 2} onClick={() => goTo(hits, at - 1)} title="上一个（Shift+回车）">
                ↑
              </Btn>
              <Btn variant="mini" disabled={hits.length < 2} onClick={() => goTo(hits, at + 1)} title="下一个（回车）">
                ↓
              </Btn>
            </div>
            <div className="jt" ref={treeRef}>
              {index ? rows.map(renderRow) : <Hint>{empty}</Hint>}
            </div>
            <div className="jt-foot">
              {focusNode ? (
                <>
                  <Mono>{focusNode.id}</Mono>
                  <CopyBtn text={focusNode.id}>复制路径</CopyBtn>
                  <CopyBtn text={copyText(focusNode)}>复制值</CopyBtn>
                </>
              ) : (
                <Hint>点一行，这里显示它的路径，可复制路径和值</Hint>
              )}
            </div>
          </Card>
        </Col>
      </Split>

      <Dlg
        title={`JSON 历史记录（${history.length} / 50）`}
        open={histOpen}
        onClose={() => setHistOpen(false)}
        width={860}
        actions={
          history.length ? (
            <Btn
              variant="mini"
              danger
              onClick={() => {
                if (!clearArm) return setClearArm(true)
                setClearArm(false)
                void useJsonHistoryStore.getState().clear()
              }}
            >
              {clearArm ? '再点一次确认清空' : '清空全部'}
            </Btn>
          ) : undefined
        }
      >
        <Fld
          value={histQ}
          onChange={(e) => setHistQ(e.target.value)}
          placeholder="搜名称、内容或接口名"
          aria-label="搜索历史记录"
        />
        {histErr && <Band tone="err" title="历史记录">{histErr}</Band>}
        <div className="jh-list">
          {shownHistory.length === 0 ? (
            <Hint>{history.length ? '没有匹配的记录' : '还没有记录：粘贴一段 JSON，或从码上测点「去 JSON 查看」'}</Hint>
          ) : (
            shownHistory.map((e) => (
              <div key={e.id} className="jh-row" onClick={() => editing !== e.id && openHistory(e)} title="点击打开">
                <div className="jh-main">
                  <div className="jh-title">
                    {editing === e.id ? (
                      <input
                        className="jh-edit"
                        autoFocus
                        defaultValue={e.name ?? ''}
                        placeholder={titles.get(e.id)}
                        maxLength={80}
                        onClick={(ev) => ev.stopPropagation()}
                        onBlur={(ev) => {
                          void useJsonHistoryStore.getState().rename(e.id, ev.currentTarget.value)
                          setEditing(null)
                        }}
                        onKeyDown={(ev) => {
                          if (ev.key === 'Enter' && !ev.nativeEvent.isComposing) ev.currentTarget.blur()
                          if (ev.key === 'Escape') {
                            // 先拦住：否则弹窗跟着关；不存，直接退出编辑
                            ev.stopPropagation()
                            ev.currentTarget.value = e.name ?? ''
                            ev.currentTarget.blur()
                          }
                        }}
                      />
                    ) : e.name ? (
                      <span className="jh-name">{e.name}</span>
                    ) : (
                      <span className="jh-auto" title="还没起名，这是按内容猜的">
                        {titles.get(e.id)}
                      </span>
                    )}
                    {/* 没起名时标题就是接口名，这里不重复；起了名接口名挤到标签上 */}
                    <Tag tone={e.from ? 'hi' : undefined}>{e.from ? (e.name ? e.from : '码上测') : '粘贴'}</Tag>
                  </div>
                  <span className="jh-pv">{e.json.slice(0, 200)}</span>
                </div>
                <span className="jh-at">{historyTime(e.at)}</span>
                <span className="jh-size">{historySize(e.json.length)}</span>
                <Btn
                  variant="mini"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    setEditing(e.id)
                  }}
                >
                  {e.name ? '改名' : '起名'}
                </Btn>
                <Btn
                  variant="mini"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    void useJsonHistoryStore.getState().remove(e.id)
                  }}
                >
                  删除
                </Btn>
              </div>
            ))
          )}
        </div>
      </Dlg>
    </Page>
  )
}
