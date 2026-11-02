/**
 * 我的连接：给地址起名收藏。连库查询从这里选、现填密码再连。
 *
 * 密码不进这一页的存档。跨天免输写本机；生产不记。
 * 跟连库查询共用一份 blob（useDbConnStore）。
 * 布局照极光设计稿：统计行 → 工具条 → 选中连接的入口卡 → 三列连接卡片。
 */
import { useMemo, useState } from 'react'
import { App } from 'antd'
import {
  DB_ENV,
  DB_SAVED_LIMIT,
  canPersistPass,
  connDisplayName,
  dbKindOf,
  type DbConn,
  type DbEnv,
  type DbKind,
} from '../../types/dbconn'
import {
  DIALECTS,
  DEFAULT_DB_KIND,
  isLiveDbKind,
  liveDialect,
} from '../../lib/dbDialect'
import { namedConns } from '../../storage/dbconn'
import { credDelete, credErr, loadPass } from '../../lib/dbCred'
import { isTauri } from '../../storage'
import { useDbConnStore } from '../../store/useDbConnStore'
import { useUiStore } from '../../store/useUiStore'
import { Page } from '../../components/shell/Page'
import {
  Band,
  Btn,
  Card,
  EmptyBox,
  Fld,
  Hint,
  Lbl,
  Row,
  Seg,
  Spacer,
  Stack,
  Stat,
  Stats,
  Tag,
} from '../../components/ui'

type EnvFilter = 'all' | DbEnv

const EMPTY_FORM = {
  name: '',
  kind: DEFAULT_DB_KIND as DbKind,
  env: 'test' as DbEnv,
  host: '',
  port: liveDialect(DEFAULT_DB_KIND)?.defaultPort ?? '1521',
  user: liveDialect(DEFAULT_DB_KIND)?.defaultUser ?? '',
  db: '',
  remark: '',
}

export function DbConnsPage() {
  const { message } = App.useApp()
  const items = useDbConnStore((s) => s.items)
  const loaded = useDbConnStore((s) => s.loaded)
  const loadErr = useDbConnStore((s) => s.loadErr)
  const saveErr = useDbConnStore((s) => s.saveErr)
  const upsertSaved = useDbConnStore((s) => s.upsertSaved)
  const remove = useDbConnStore((s) => s.remove)
  const jumpToDbQuery = useUiStore((s) => s.jumpToDbQuery)

  const saved = namedConns(items)
  const [q, setQ] = useState('')
  const [envFilter, setEnvFilter] = useState<EnvFilter>('all')
  const [sel, setSel] = useState<string | null>(saved[0]?.id ?? null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [bad, setBad] = useState<string[]>([])
  const [formHint, setFormHint] = useState('')
  const [usePass, setUsePass] = useState('')
  const [armedDel, setArmedDel] = useState<string | null>(null)
  /** 新建表单默认收起；在编辑、或一条都没存时自动展开 */
  const [creating, setCreating] = useState(false)
  const formOpen = creating || editingId !== null || (loaded && saved.length === 0)
  const countEnv = (env: DbEnv) => saved.filter((c) => c.env === env).length

  const spec = liveDialect(form.kind)

  const shown = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return saved.filter((c) => {
      if (envFilter !== 'all' && c.env !== envFilter) return false
      if (!kw) return true
      const label = DIALECTS.find((d) => d.id === dbKindOf(c.kind))?.label ?? ''
      return [c.name, c.host, c.db, c.user, label, c.remark].join(' ').toLowerCase().includes(kw)
    })
  }, [saved, q, envFilter])

  const current = saved.find((c) => c.id === sel) ?? null
  const [passId, setPassId] = useState<string | undefined>(undefined)
  if (current?.id !== passId) {
    setPassId(current?.id)
    setUsePass('')
    if (current && canPersistPass(current.env)) {
      void loadPass(current, current.env)
        .then((p) => {
          if (p) setUsePass(p)
        })
        .catch((e) => {
          message.warning(`读不出记住的密码：${credErr(e)}`)
        })
    }
  }

  const resetForm = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setBad([])
    setFormHint('')
  }

  const fillForm = (c: DbConn) => {
    const k = dbKindOf(c.kind)
    setEditingId(c.id ?? null)
    setForm({
      name: c.name ?? '',
      kind: k,
      env: c.env ?? 'test',
      host: c.host,
      port: c.port,
      user: c.user,
      db: c.db,
      remark: c.remark ?? '',
    })
    setBad([])
    setFormHint('')
  }

  const switchKind = (next: DbKind) => {
    const live = liveDialect(next)
    if (!live || next === form.kind) return
    setForm((f) => ({
      ...f,
      kind: next,
      ...(editingId
        ? {}
        : {
            port: live.defaultPort,
            user: live.defaultUser || f.user,
            ...(live.fileBased ? { host: '.', user: live.defaultUser } : {}),
          }),
    }))
  }

  const save = () => {
    const name = form.name.trim()
    const fileBased = Boolean(spec?.fileBased)
    const host = fileBased ? '.' : form.host.trim()
    const port = fileBased ? '0' : form.port.trim()
    const user = fileBased ? 'sqlite' : form.user.trim()
    const db = form.db.trim()
    const miss: string[] = []
    if (!name) miss.push('name')
    if (!fileBased) {
      if (!host) miss.push('host')
      if (!port) miss.push('port')
      if (!user) miss.push('user')
    }
    if (!db) miss.push('db')
    if (miss.length) {
      setBad(miss)
      setFormHint(fileBased ? '名称和数据库文件路径都要填' : '名称、主机、端口、用户、库名都要填')
      return
    }
    if (!editingId && saved.length >= DB_SAVED_LIMIT) {
      setFormHint(`最多 ${DB_SAVED_LIMIT} 条有名字的连接`)
      return
    }
    if (form.env === 'prod' && !fileBased) {
      void credDelete({ kind: form.kind, host, port, user, db })
    }
    const next = upsertSaved({
      id: editingId ?? undefined,
      name,
      kind: form.kind,
      env: form.env,
      host,
      port,
      user,
      db,
      remark: form.remark.trim() || undefined,
    })
    if (next?.id) setSel(next.id)
    resetForm()
    setCreating(false)
    message.success(
      fileBased
        ? '已保存文件路径'
        : form.env === 'prod'
          ? '已保存地址（生产不记密码）'
          : '已保存地址（密码不进这条记录）',
    )
  }

  const goQuery = () => {
    if (!current) return
    const live = liveDialect(dbKindOf(current.kind))
    if (!isTauri()) {
      jumpToDbQuery({ conn: current })
      message.info('浏览器模式没有驱动。已回填地址，请用桌面版连接。')
      return
    }
    if (!live?.fileBased && !usePass.trim()) {
      message.warning(current.env === 'prod' ? '生产连接请现填密码' : '密码还是空的')
      return
    }
    jumpToDbQuery({ conn: current, password: live?.fileBased ? '' : usePass })
    setUsePass('')
  }

  return (
    <Page tab="dbconns">
      {loadErr && (
        <Band tone="err" title="读存档失败">
          {loadErr}
          <Btn variant="mini" onClick={() => void useDbConnStore.getState().reload()}>
            重试
          </Btn>
        </Band>
      )}
      {saveErr && (
        <Band tone="err" title="写入失败">
          {saveErr}
        </Band>
      )}

      <Stack>
        <Stats className="stats-4">
          <Stat t="已保存连接" v={saved.length} f={`最多 ${DB_SAVED_LIMIT} 条 · 只记地址不记密码`} />
          <Stat t="生产" v={countEnv('prod')} tone="bad" f="每次现输密码" />
          <Stat t="测试" v={countEnv('test')} tone="acc" f="密码可记在本机" />
          <Stat t="本地" v={countEnv('local')} tone="ok" f="本机库 / 文件库" />
        </Stats>

        <div className="toolrow">
          <Fld
            className="grow"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="过滤名称 / 主机 / 库名 / 用户"
            aria-label="过滤连接"
          />
          <Seg
            value={envFilter}
            onChange={setEnvFilter}
            options={(['all', 'prod', 'test', 'local'] as const).map((k) => ({
              value: k,
              label: k === 'all' ? '全部' : DB_ENV[k].label,
            }))}
          />
          <Btn
            variant="primary"
            onClick={() => {
              resetForm()
              setCreating((v) => !(v && !editingId))
            }}
          >
            {formOpen && !editingId ? '收起新建' : '＋ 新建'}
          </Btn>
        </div>

        {formOpen && (
          <Card
            hero
            title={editingId ? '编辑连接' : '新建连接'}
            who="跟连库查询同一张表单 · 不记密码"
            className="form-card"
          >
            <Stack gap={8}>
              <Row>
                <Lbl>名称</Lbl>
                <Fld
                  className="grow"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="如 生产只读、本地 11g"
                  bad={bad.includes('name')}
                  aria-label="名称"
                />
              </Row>
              <Row>
                <Lbl>类型</Lbl>
                <Seg
                  value={form.kind}
                  onChange={switchKind}
                  options={DIALECTS.map((d) => ({
                    value: d.id,
                    label: d.label,
                    disabled: !isLiveDbKind(d),
                    title: isLiveDbKind(d) ? undefined : d.disabled,
                  }))}
                />
              </Row>
              <Row>
                <Lbl>环境</Lbl>
                <Seg
                  value={form.env}
                  onChange={(v) => setForm((f) => ({ ...f, env: v }))}
                  options={(Object.keys(DB_ENV) as DbEnv[]).map((k) => ({
                    value: k,
                    label: DB_ENV[k].label,
                  }))}
                />
              </Row>
              {!spec?.fileBased && (
                <>
                  <Row>
                    <Lbl>主机</Lbl>
                    <Fld
                      className="grow"
                      value={form.host}
                      onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
                      placeholder="如 10.0.1.8"
                      bad={bad.includes('host')}
                      aria-label="主机"
                    />
                    <Lbl>端口</Lbl>
                    <Fld
                      className="fix"
                      value={form.port}
                      onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
                      placeholder="1521"
                      bad={bad.includes('port')}
                      aria-label="端口"
                    />
                  </Row>
                  <Row>
                    <Lbl>用户名</Lbl>
                    <Fld
                      className="grow"
                      value={form.user}
                      onChange={(e) => setForm((f) => ({ ...f, user: e.target.value }))}
                      placeholder="如 SCOTT"
                      bad={bad.includes('user')}
                      aria-label="用户名"
                    />
                  </Row>
                </>
              )}
              <Row>
                <Lbl>{spec?.dbLabel ?? '库'}</Lbl>
                <Fld
                  className="grow mono"
                  value={form.db}
                  onChange={(e) => setForm((f) => ({ ...f, db: e.target.value }))}
                  placeholder={spec?.dbPlaceholder ?? ''}
                  bad={bad.includes('db')}
                  aria-label={spec?.dbLabel ?? '库'}
                />
              </Row>
              {spec && (
                <Hint>
                  {spec.fileBased
                    ? '保存文件路径，连库时直接打开，不问密码。'
                    : `保存时不问密码，连库查询里现填。${spec.dbHint}`}
                </Hint>
              )}
              <Row>
                <Lbl>备注</Lbl>
                <Fld
                  className="grow"
                  value={form.remark}
                  onChange={(e) => setForm((f) => ({ ...f, remark: e.target.value }))}
                  placeholder="可选，如 只读账号，别拿去改数"
                  aria-label="备注"
                />
              </Row>
              <Hint>只记地址，不记密码。同主机上不同库类型是两条。</Hint>
              <Row>
                <Hint>{formHint}</Hint>
                <Spacer />
                {editingId && (
                  <Btn variant="mini" onClick={resetForm}>
                    取消编辑
                  </Btn>
                )}
                <Btn variant="primary" disabled={!loaded} onClick={save}>
                  保存
                </Btn>
              </Row>
            </Stack>
          </Card>
        )}

        {current && (
        <Card hero={!formOpen} title="用这条去连库" who="连库查询的入口">
            {!current ? (
              <EmptyBox>上面点一条。连库查询会带上类型、地址；有密码的在这里现填。</EmptyBox>
            ) : (
              <Stack>
                <Row tight>
                  <b>{current.name}</b>
                  {current.env && <Tag tone={DB_ENV[current.env].tone}>{DB_ENV[current.env].label}</Tag>}
                  <Tag tone="hi">{DIALECTS.find((d) => d.id === dbKindOf(current.kind))?.label ?? 'Oracle'}</Tag>
                </Row>
                <Hint className="mono">
                  {liveDialect(dbKindOf(current.kind))?.fileBased
                    ? current.db
                    : `${current.host}:${current.port}/${current.db} · ${current.user}`}
                </Hint>
                {current.remark ? <Hint>{current.remark}</Hint> : null}
                <Row>
                  {!liveDialect(dbKindOf(current.kind))?.fileBased && (
                    <>
                      <Lbl>密码</Lbl>
                      <Fld
                        className="grow"
                        type="password"
                        value={usePass}
                        onChange={(e) => setUsePass(e.target.value)}
                        placeholder={current.env === 'prod' ? '生产每次现输' : '记住的会带上'}
                        aria-label="密码"
                      />
                    </>
                  )}
                  <Btn
                    variant="primary"
                    disabled={!isLiveDbKind(DIALECTS.find((d) => d.id === dbKindOf(current.kind)) ?? DIALECTS[0])}
                    title={!isTauri() ? '浏览器模式没有驱动，会先回填地址' : undefined}
                    onClick={goQuery}
                  >
                    连接并查询
                  </Btn>
                </Row>
                <Row tight>
                  <Btn variant="mini" onClick={() => fillForm(current)}>
                    编辑这条
                  </Btn>
                  <Btn
                    variant="mini"
                    danger={armedDel === current.id}
                    onClick={() => {
                      if (!current.id) return
                      if (armedDel !== current.id) {
                        setArmedDel(current.id)
                        return
                      }
                      void credDelete(current)
                      remove(current.id)
                      setSel(saved.find((c) => c.id !== current.id)?.id ?? null)
                      setArmedDel(null)
                      resetForm()
                      message.info('已删除这条地址')
                    }}
                  >
                    {armedDel === current.id ? '确认删除？' : '删除'}
                  </Btn>
                  {canPersistPass(current.env) && (
                    <Btn
                      variant="mini"
                      onClick={() => {
                        void credDelete(current)
                        setUsePass('')
                        message.info('已忘掉这条的密码')
                      }}
                    >
                      忘掉密码
                    </Btn>
                  )}
                  <Hint>
                    {current.env === 'prod'
                      ? '生产连接每次现输密码。'
                      : '点了跳到连库查询。密码若记住了会带上，仍不进这条记录。'}
                  </Hint>
                </Row>
              </Stack>
            )}
        </Card>
        )}

        {!loaded && !loadErr && <EmptyBox>正在读取本地存储…</EmptyBox>}
        {loaded && saved.length > 0 && shown.length === 0 && <EmptyBox>没有命中的连接。换个词，或点新建。</EmptyBox>}
        <div className="g-grid3">
          {shown.map((c) => {
            const env = c.env ? DB_ENV[c.env] : null
            const kindLabel = DIALECTS.find((d) => d.id === dbKindOf(c.kind))?.label ?? 'Oracle'
            const fileBased = liveDialect(dbKindOf(c.kind))?.fileBased
            return (
              <button
                key={c.id}
                type="button"
                className={c.id === sel ? 'conncard on' : 'conncard'}
                onClick={() => {
                  setSel(c.id ?? null)
                  setArmedDel(null)
                  resetForm()
                }}
              >
                <div className="fr">
                  <span className="nm">{connDisplayName(c)}</span>
                  {env && <Tag tone={env.tone}>{env.label}</Tag>}
                </div>
                <div className="addr">{fileBased ? c.db : `${c.host}:${c.port}/${c.db}`}</div>
                <div className="who">
                  <Tag tone="hi">{kindLabel}</Tag>
                  <span>
                    {fileBased ? '本机文件' : c.user}
                    {c.remark ? ` · ${c.remark}` : ''}
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      </Stack>
    </Page>
  )
}
