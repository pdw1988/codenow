/**
 * 我的SQL库（SQL收藏夹），PRD v6.3 §6.1~6.9 · MVP#13（原型 `mockup/sqlfav.html`）。
 *
 * 存的是 SQL 本身（成品），§4.13 模板存的是生成器配置——两回事。
 * 五项拍板的落点：①排序带「最常用」；②表名识别结果永远可手改；
 * ③导入按「名称+SQL 都相同」去重、id 重新分配；④不做「硬灌进生成器」，
 * 复制就是复用的主入口（验收线：收藏 → 搜到 → 一键复制，全程 3 秒）；
 * ⑤团队共享属商业版，本地单机不做同步。
 *
 * 新建时粘贴 SQL 即填所属表名（PRD §6.4），不必先点「自动识别」；
 * 手改过表名框之后不再覆盖。按钮只留给「改完再扫一遍」。
 *
 * 布局（照极光设计稿）：统计行 → 搜索工具条 → 三列卡片；「＋ 新建」展开表单，
 * 点卡片在网格上方出详情/编辑，新建与编辑草稿互不冲。再点已选中卡片可关掉详情。
 *
 * 数据流：列表走 useFavoriteStore（跟模板同一类：多页都会写，不能只存在 FavPanel
 * 挂载时读到的那份）。搜索 / 去重 / 起名仍是 lib 纯函数。
 * 初次 load 完成前 UI 不给编辑入口——store 里空数组还没被存档替换。
 */
import { Fragment, useMemo, useRef, useState } from 'react'
import { CopyOutlined, DownloadOutlined, EditOutlined, UploadOutlined } from '@ant-design/icons'
import type { ReactNode } from 'react'
import { upsertFavorite } from '../../storage/favorites'
import {
  extractTables,
  followTables,
  favNow,
  filterFavorites,
  importFavorites,
  markUsed,
  matchFavConn,
  newFavoriteId,
  sortFavorites,
  splitFavList,
  type FavSort,
} from '../../lib/sqlfav'
import type { FavoriteSql } from '../../types/favorite'
import { useFavoriteStore } from '../../store/useFavoriteStore'
import { useDbConnStore } from '../../store/useDbConnStore'
import { useDbPassStore } from '../../store/useDbPassStore'
import { useUiStore } from '../../store/useUiStore'
import { Page } from '../../components/shell/Page'
import {
  Band,
  Btn,
  Card,
  Chip,
  Chips,
  Code,
  CopyBtn,
  EmptyBox,
  Fld,
  Hint,
  Lbl,
  PopSel,
  Row,
  Seg,
  Spacer,
  Stack,
  Stat,
  Stats,
  Tag,
  TextArea,
} from '../../components/ui'

/** 口径搬到 lib/sqlfav.ts（连库查询的收藏弹框共用同一份） */
const splitList = splitFavList

/** 列表预览取前 4 行——再多就是详情卡的活了 */
const previewOf = (sql: string): string => sql.split('\n').slice(0, 4).join('\n')

type FavDraft = {
  name: string
  tbls: string
  tags: string
  sql: string
  remark: string
  /** 用户动过所属表名框（含点「自动识别」合并）之后，SQL 再变也不准覆盖手改 */
  tblsTouched: boolean
}

const emptyDraft = (): FavDraft => ({
  name: '',
  tbls: '',
  tags: '',
  sql: '',
  remark: '',
  tblsTouched: false,
})

/**
 * 搜索命中的片段包 <mark>（_theme.css 有全局样式）。逐段渲染而不是拼
 * HTML 字符串——Hl.tsx 同一条纪律：内容里有用户粘的 SQL，别给它执行机会。
 */
function Hi({ text, q }: { text: string; q: string }) {
  const needle = q.trim().toLowerCase()
  if (!needle) return <>{text}</>
  const low = text.toLowerCase()
  const parts: ReactNode[] = []
  let i = 0
  for (;;) {
    const j = low.indexOf(needle, i)
    if (j < 0) {
      parts.push(text.slice(i))
      break
    }
    if (j > i) parts.push(text.slice(i, j))
    parts.push(<mark key={`${j}`}>{text.slice(j, j + needle.length)}</mark>)
    i = j + needle.length
  }
  return <>{parts}</>
}

type FormMsg = { tone: 'ok' | 'err' | 'info'; msg: string }

export function FavPanel() {
  const items = useFavoriteStore((s) => s.items)
  const loaded = useFavoriteStore((s) => s.loaded)
  const loadErr = useFavoriteStore((s) => s.loadErr)
  const saveErr = useFavoriteStore((s) => s.saveErr)
  const setItems = useFavoriteStore((s) => s.setItems)

  /* 新建与编辑各一份草稿：点列表看详情时左栏新建不能被冲掉 */
  const [createDraft, setCreateDraft] = useState<FavDraft>(emptyDraft)
  const [editDraft, setEditDraft] = useState<FavDraft | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [createMsg, setCreateMsg] = useState<FormMsg | null>(null)
  const [editMsg, setEditMsg] = useState<FormMsg | null>(null)

  /* 搜索与筛选。「全部」用 null 表示 */
  const [q, setQ] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [tbl, setTbl] = useState<string | null>(null)
  const [sort, setSort] = useState<FavSort>('recent')

  const [selId, setSelId] = useState<string | null>(null)
  /** 两段式删除：第一次点只武装成「确认删除？」，误触多一道闸 */
  const [armedDel, setArmedDel] = useState<string | null>(null)
  const [ioMsg, setIoMsg] = useState('')
  /** 新建表单默认收起，点「＋ 新建」展开（一条都没有时常开） */
  const [creating, setCreating] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  /* 「去连库查询」靠这三个：按 addrKey 找回完整连接、取进程内记住的密码、跳页 */
  const conns = useDbConnStore((s) => s.items)
  const peekPass = useDbPassStore((s) => s.peek)
  const jumpToDbQuery = useUiStore((s) => s.jumpToDbQuery)

  const allTags = useMemo(() => [...new Set(items.flatMap((x) => x.tags))], [items])
  const allTbls = useMemo(() => [...new Set(items.flatMap((x) => x.tables))], [items])

  /* 某类标签/表名删空后筛选项失效：渲染期校正回「全部」，不用 effect（oxlint 那条） */
  if (tag !== null && !allTags.includes(tag)) setTag(null)
  if (tbl !== null && !allTbls.includes(tbl)) setTbl(null)

  const shown = useMemo(
    () => sortFavorites(filterFavorites(items, q, tag, tbl), sort),
    [items, q, tag, tbl, sort],
  )
  const sel = items.find((x) => x.id === selId) ?? null
  /** 右栏列表下面：编辑优先于详情；都没有就只剩列表 */
  const rightPane: 'list' | 'edit' | 'detail' =
    editingId !== null && editDraft !== null ? 'edit' : sel !== null ? 'detail' : 'list'

  const stopEdit = () => {
    setEditingId(null)
    setEditDraft(null)
    setEditMsg(null)
  }

  /** 关掉详情（左栏新建本来就在，不必「返回」） */
  const closeDetail = () => {
    setSelId(null)
    setArmedDel(null)
    if (editingId !== null) stopEdit()
  }

  const detectTables = (
    draft: FavDraft,
    setDraft: (d: FavDraft) => void,
    setMsg: (m: FormMsg | null) => void,
  ) => {
    const found = extractTables(draft.sql)
    const next: FavDraft = { ...draft, tblsTouched: true }
    if (found.length) {
      next.tbls = [...new Set([...splitList(draft.tbls), ...found])].join(', ')
      setDraft(next)
      setMsg({ tone: 'info', msg: `识别到 ${found.length} 个表名，可修改` })
    } else {
      setDraft(next)
      setMsg({ tone: 'info', msg: '未能识别表名，请手工填写' })
    }
  }

  const submitCreate = () => {
    const name = createDraft.name.trim()
    const sql = createDraft.sql.trim()
    if (!name || !sql) {
      setCreateMsg({ tone: 'err', msg: '名称和 SQL 内容为必填' })
      return
    }
    const item: FavoriteSql = {
      id: newFavoriteId(),
      name,
      sql,
      tables: splitList(createDraft.tbls),
      tags: splitList(createDraft.tags),
      remark: createDraft.remark.trim(),
      createdAt: favNow(),
      lastUsedAt: favNow(),
      useCount: 0,
    }
    setItems((prev) => upsertFavorite(prev, item))
    setSelId(item.id)
    setCreateDraft(emptyDraft())
    setCreateMsg({ tone: 'ok', msg: '已收藏 ✓' })
    setCreating(false)
  }

  const submitEdit = () => {
    if (editingId === null || editDraft === null) return
    const name = editDraft.name.trim()
    const sql = editDraft.sql.trim()
    if (!name || !sql) {
      setEditMsg({ tone: 'err', msg: '名称和 SQL 内容为必填' })
      return
    }
    const target = items.find((x) => x.id === editingId)
    if (!target) {
      stopEdit()
      return
    }
    setItems((prev) =>
      prev.map((it) =>
        it.id === editingId
          ? {
              ...it,
              name,
              sql,
              tables: splitList(editDraft.tbls),
              tags: splitList(editDraft.tags),
              remark: editDraft.remark.trim(),
            }
          : it,
      ),
    )
    stopEdit()
    setEditMsg({ tone: 'ok', msg: '已保存 ✓' })
  }

  const startEdit = (it: FavoriteSql) => {
    setEditingId(it.id)
    setSelId(it.id)
    setEditDraft({
      name: it.name,
      sql: it.sql,
      tbls: it.tables.join(', '),
      tags: it.tags.join(', '),
      remark: it.remark ?? '',
      tblsTouched: true,
    })
    setEditMsg(null)
  }

  const removeOne = (id: string) => {
    setItems((prev) => prev.filter((x) => x.id !== id))
    if (selId === id) setSelId(null)
    if (editingId === id) stopEdit()
    setArmedDel(null)
  }

  const appendTag = (draft: FavDraft, setDraft: (d: FavDraft) => void, t: string) => {
    const cur = splitList(draft.tags)
    if (!cur.includes(t)) setDraft({ ...draft, tags: [...cur, t].join(', ') })
  }

  const doExport = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'favorite_sql.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setIoMsg(`已导出 ${items.length} 条 → favorite_sql.json`)
  }

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    const rd = new FileReader()
    rd.onload = () => {
      const r = importFavorites(items, String(rd.result))
      if ('error' in r) {
        setIoMsg(r.error)
        return
      }
      setItems(r.list)
      setIoMsg(`导入完成：新增 ${r.added}，重复跳过 ${r.skipped}，坏行 ${r.invalid}`)
    }
    rd.readAsText(f)
    e.target.value = ''
  }

  /* ---------- 渲染 ---------- */

  const countByTag = (t: string) => items.filter((x) => x.tags.includes(t)).length

  const tagChip = (t: string | null, label: string) => {
    const on = tag === t
    const badge = t === null ? items.length : countByTag(t)
    // 选中的用 Tag hi（acc 高亮），没选中用 Chip——现成组件里最接近原型 chip.on 的组合
    return on ? (
      <Tag tone="hi" onClick={() => setTag(t)}>
        {label} {badge}
      </Tag>
    ) : (
      <Chip badge={badge} onClick={() => setTag(t)}>
        {label}
      </Chip>
    )
  }

  const favCard = (it: FavoriteSql) => (
    <Card
      key={it.id}
      className={`favcard${selId === it.id ? ' on' : ''}`}
      title={<Hi text={it.name} q={q} />}
      extra={it.tags.length > 0 ? <Tag tone="hi">{it.tags[0]}</Tag> : undefined}
      actions={
        <>
          <CopyBtn text={it.sql} onCopied={() => setItems((prev) => prev.map((x) => (x.id === it.id ? markUsed(x) : x)))}>
            复制
          </CopyBtn>
          <Btn variant="mini" onClick={() => startEdit(it)}>
            编辑
          </Btn>
          <Btn variant="mini" danger onClick={() => (armedDel === it.id ? removeOne(it.id) : setArmedDel(it.id))}>
            {armedDel === it.id ? '确认删除？' : '删除'}
          </Btn>
        </>
      }
    >
      <div
        className="favcard-body"
        onClick={() => {
          setArmedDel(null)
          // 再点已选中的卡片：关掉详情
          if (selId === it.id && editingId === null) {
            closeDetail()
            return
          }
          setSelId(it.id)
          if (editingId !== null) stopEdit()
        }}
      >
        <pre>
          <Hi text={previewOf(it.sql)} q={q} />
        </pre>
        <Hint>
          {it.tables.length ? `${it.tables.slice(0, 2).join(', ')} · ` : ''}复制 {it.useCount} 次 · {it.lastUsedAt}
        </Hint>
      </div>
    </Card>
  )

  const formBody = (
    mode: 'create' | 'edit',
    draft: FavDraft,
    setDraft: (d: FavDraft) => void,
    msg: FormMsg | null,
    setMsg: (m: FormMsg | null) => void,
  ) => (
    <Stack gap={8}>
      <Row tight>
        <Lbl>名称 *</Lbl>
        <Fld
          value={draft.name}
          className="grow"
          placeholder="必填，如 查未发货订单"
          aria-label="SQL名称"
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </Row>
      <Row tight>
        <Lbl>所属表</Lbl>
        <Fld
          value={draft.tbls}
          className="grow"
          placeholder="粘贴 SQL 后自动填写，可修改"
          aria-label="所属表名"
          onChange={(e) => setDraft({ ...draft, tblsTouched: true, tbls: e.target.value })}
        />
        <Btn
          variant="mini"
          title="粘贴 SQL 已自动填写。修改所属表名后再点，会合并新识别的表名"
          onClick={() => detectTables(draft, setDraft, setMsg)}
        >
          自动识别
        </Btn>
      </Row>
      <Row tight>
        <Lbl>标签</Lbl>
        <Fld
          value={draft.tags}
          className="grow"
          placeholder="可选，逗号分隔"
          aria-label="标签"
          onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
        />
        {allTags.length > 0 && (
          <Chips className="fc-under">
            {allTags.map((t) => (
              <Chip key={t} onClick={() => appendTag(draft, setDraft, t)}>
                ＋ {t}
              </Chip>
            ))}
          </Chips>
        )}
      </Row>
      <Row tight className="lbl-top">
        <Lbl>SQL *</Lbl>
        <div className="fc-grow">
          <TextArea
            value={draft.sql}
            rows={7}
            aria-label="SQL内容"
            placeholder={'必填；可含 MyBatis XML 片段'}
            style={{ resize: 'vertical', fontFamily: 'var(--mono)', fontSize: 12.5 }}
            onChange={(e) => {
              const v = e.target.value
              setDraft({
                ...draft,
                sql: v,
                tbls: followTables(v, draft.tblsTouched, draft.tbls),
              })
            }}
          />
        </div>
      </Row>
      <Row tight>
        <Lbl>备注</Lbl>
        <Fld
          value={draft.remark}
          className="grow"
          placeholder="可选"
          aria-label="备注"
          onChange={(e) => setDraft({ ...draft, remark: e.target.value })}
        />
      </Row>
      {msg && <Band tone={msg.tone}>{msg.msg}</Band>}
      <Row tight className="fc-indent">
        <Btn
          variant="primary"
          onClick={mode === 'create' ? submitCreate : submitEdit}
        >
          {mode === 'edit' ? '保存修改' : '保存'}
        </Btn>
        {mode === 'edit' && (
          <Btn variant="ghost" onClick={stopEdit}>
            取消编辑
          </Btn>
        )}
      </Row>
    </Stack>
  )

  /**
   * 去连库查询跑这段收藏。收藏里存了当时的库就选回去，并带上记住的密码（有才带）。
   *
   * **只灌不跑**：`run: false`。收藏库里存的未必是 SELECT——可能是一条 DELETE，
   * 不能替用户按执行。旧的三个跳转入口灌的是 previewSql，仍然自动跑（run 缺省 true）。
   *
   * 去执行也算用过一次，跟「复制」同一口径计 use_count。
   */
  const goQuery = (it: FavoriteSql) => {
    const live = matchFavConn(conns, it.conn)
    jumpToDbQuery({
      conn: live ?? undefined,
      password: live ? peekPass(live) || undefined : undefined,
      sql: it.sql,
      table: it.tables[0],
      run: false,
    })
    setItems((prev) => prev.map((x) => (x.id === it.id ? markUsed(x) : x)))
  }

  /** 找不回连接时把原因说出来，但按钮照样能点（降级成用当前连接） */
  const goQueryTitle = (it: FavoriteSql): string => {
    if (!it.conn) return '灌进连库查询的 SQL 框（这条没存连接，用当前连接）。不自动执行'
    const addr = `${it.conn.host}:${it.conn.port}/${it.conn.db}`
    return matchFavConn(conns, it.conn)
      ? `灌进连库查询的 SQL 框，并选回 ${addr}。不自动执行`
      : `原连接 ${addr} 已不在「我的连接」里，只灌 SQL、用当前连接。不自动执行`
  }

  const detailBody = sel !== null && (
    <Stack>
      <Row tight>
        <span className="favname">{sel.name}</span>
        <Hint>
          创建 {sel.createdAt} · 复制 {sel.useCount} 次 · 最近 {sel.lastUsedAt}
        </Hint>
      </Row>
      <Row tight>
        {sel.tags.map((t) => (
          <Tag key={t}>{t}</Tag>
        ))}
        <Spacer />
        {/* 去跑一下——原来只能「复制 → 手动切页 → 选连接 → 粘上」四步。
            只灌不跑（run:false）：收藏里存的未必是 SELECT。 */}
        <Btn variant="mini" title={goQueryTitle(sel)} onClick={() => goQuery(sel)}>
          ▶ 去连库查询
        </Btn>
        {/* 复制为主（拍板④）：这就是复用的主入口，成功才计 use_count */}
        <CopyBtn text={sel.sql} onCopied={() => setItems((prev) => prev.map((x) => (x.id === sel.id ? markUsed(x) : x)))}>
          <CopyOutlined aria-hidden="true" /> 复制全文
        </CopyBtn>
      </Row>
      <span className="tblnames">所属表：{sel.tables.length ? sel.tables.join(', ') : '（未关联）'}</span>
      {sel.remark && <Hint>备注：{sel.remark}</Hint>}
      {/* Code 工具条上的复制也计次：onCopied 同一个出口，「复制=使用」只有一条规则 */}
      <Code code={sel.sql} name={`${sel.name}.sql`} lang="sql" onCopied={() => setItems((prev) => prev.map((x) => (x.id === sel.id ? markUsed(x) : x)))} />
    </Stack>
  )

  const totalUses = items.reduce((n, x) => n + x.useCount, 0)
  const showCreate = creating || (loaded && items.length === 0)

  return (
    <Page tab="sqlfav">
      {loadErr && (
        <Band tone="err" title="读存档失败">
          {loadErr}
          <Btn variant="mini" onClick={() => void useFavoriteStore.getState().reload()}>
            重试
          </Btn>
        </Band>
      )}
      {!loaded && !loadErr && <EmptyBox>正在读取本地存储…</EmptyBox>}
      {saveErr && (
        <Band tone="err" title="写入失败">
          {saveErr}
        </Band>
      )}
      {loaded && (
        <Stack>
          <Stats className="stats-4">
            <Stat t="收藏" v={items.length} f="SQL 成品，跟生成器模板分开存" />
            <Stat t="标签" v={allTags.length} f={allTags.slice(0, 3).join(' · ') || '还没打标签'} />
            <Stat t="关联表" v={allTbls.length} f={allTbls.slice(0, 3).join(' · ') || '粘 SQL 自动识别'} />
            <Stat t="累计复制" v={totalUses} tone="acc" f="复制或去连库查询各算一次" />
          </Stats>

          <div className="toolrow">
            <Fld
              value={q}
              className="grow"
              placeholder="名称 / 标签 / 表名 / SQL 内容"
              aria-label="搜索收藏"
              onChange={(e) => setQ(e.target.value)}
            />
            <Seg
              value={sort}
              onChange={(v) => setSort(v as FavSort)}
              options={[
                { value: 'recent', label: '最近使用', title: '按最后使用时间倒序' },
                { value: 'often', label: '最常用', title: '按复制次数排序' },
              ]}
            />
            <PopSel
              value={tbl ?? ''}
              aria-label="按表名筛选"
              onChange={(v) => setTbl(v || null)}
              searchAt={1}
              searchPlaceholder="表名"
              placeholder="全部表"
              options={[{ value: '', label: '全部表' }, ...allTbls.map((t) => ({ value: t, label: t }))]}
            />
            <Btn variant="ghost" title="本地备份，无云同步" onClick={doExport}>
              <DownloadOutlined aria-hidden="true" /> 导出 JSON
            </Btn>
            <Btn variant="ghost" title="按名称与 SQL 均相同去重，其余追加；无效行跳过并计数" onClick={() => fileRef.current?.click()}>
              <UploadOutlined aria-hidden="true" /> 导入
            </Btn>
            <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={onFile} />
            <Btn variant="primary" onClick={() => setCreating((v) => !v)}>
              {showCreate ? '收起新建' : '＋ 新建'}
            </Btn>
          </div>
          {ioMsg && <Band tone="info">{ioMsg}</Band>}
          {allTags.length > 0 && (
            <Chips>
              {tagChip(null, '全部')}
              {allTags.map((t) => (
                <Fragment key={t}>{tagChip(t, t)}</Fragment>
              ))}
            </Chips>
          )}

          {showCreate && (
            <Card hero title="新建收藏" who="名称与内容必填" className="form-card">
              {formBody('create', createDraft, setCreateDraft, createMsg, setCreateMsg)}
            </Card>
          )}
          {rightPane === 'edit' && editDraft !== null && (
            <Card title={<><EditOutlined aria-hidden="true" /> 编辑收藏</>} className="form-card">
              {formBody('edit', editDraft, setEditDraft, editMsg, setEditMsg)}
            </Card>
          )}
          {rightPane === 'detail' && sel !== null && (
            <Card
              title="详情与复用"
              who={`${sel.sql.split('\n').length} 行 / ${sel.sql.length} 字符`}
              actions={
                <Btn variant="ghost" onClick={closeDetail}>
                  关闭详情
                </Btn>
              }
            >
              {detailBody}
            </Card>
          )}

          {shown.length ? (
            <div className="g-grid3">{shown.map(favCard)}</div>
          ) : (
            items.length > 0 && <EmptyBox>无匹配项，请更换关键词或清除筛选。</EmptyBox>
          )}
        </Stack>
      )}
    </Page>
  )
}
