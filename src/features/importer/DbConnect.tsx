/**
 * 连库查询工作台（独立页「连库查询」），PRD §5.1 方式二 + 只读查询。
 *
 * 这是共用壳：连接、表清单、勾选导入、只读查询。方言差异只在 `lib/dbDialect*.ts`
 * （怎么连、字典怎么查、查询怎么跑）。接入 MySQL 不要改这个文件（不要写 if kind === mysql）。
 *
 * 连上之后的布局对齐原型 `mockup/db-query.html`：左窄栏（已连接 + 表），
 * 右栏 SQL 在上、查询结果在下。
 *
 * 三条硬边界：
 * ①存档只记地址。跨天密码进本机凭据（Windows DPAPI / macOS 钥匙串），不进 JSON / cache.db。生产不记、不回填；
 * ②SQL 框只读（SELECT/WITH/SHOW，行数封顶）；勾选行可按主键删或改；生成页可把已拼好的语句丢给当前连接；
 * ③两步拉取：连接时只拉表清单+字段数+全库外键，逐表字段留到点「导入」。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { App } from 'antd'
import { ApiOutlined } from '@ant-design/icons'
import { DB_ENV, canPersistPass, isNamedConn, sameAddress, type DbConn, type DbEnv } from '../../types/dbconn'
import { credErr, loadPass, persistPass } from '../../lib/dbCred'
import type { ForeignKey, TableInfo } from '../../types/schema'
import {
  dbKindOf,
  DIALECTS,
  isLiveDbKind,
  liveDialect,
  DEFAULT_DB_KIND,
  type DbKind,
} from '../../lib/dbDialect'
import {
  describeConn,
  mapMetaCounts,
  mapMetaForeignKeys,
  mapMetaTables,
} from '../../lib/dbmeta'
import { inferForeignKeys } from '../../lib/ddlParser'
import { previewSql } from '../../lib/sqlReadonly'
import { namedConns } from '../../storage/dbconn'
import { sessionAddr } from '../../lib/dbLive'
import { isTauri } from '../../storage'
import { fkKey } from '../../storage/memoryStore'
import { useSchemaStore } from '../../store/useSchemaStore'
import { useDbConnStore } from '../../store/useDbConnStore'
import { useDbPassStore } from '../../store/useDbPassStore'
import { useUiStore } from '../../store/useUiStore'
import { DbQuery } from './DbQuery'
import {
  Band,
  Btn,
  Card,
  Cb,
  Col,
  cx,
  EmptyBox,
  Fld,
  Hint,
  Lbl,
  Row,
  Seg,
  Spacer,
  Split,
  Stack,
  Tag,
} from '../../components/ui'

interface DbTableLite {
  name: string
  comment?: string
  colCount: number
}

const DEFAULT = liveDialect(DEFAULT_DB_KIND)

export function DbConnect() {
  const { message } = App.useApp()
  const existing = useSchemaStore((s) => s.tables)
  const cachedFks = useSchemaStore((s) => s.foreignKeys)
  const importTables = useSchemaStore((s) => s.importTables)
  const setDbConnected = useUiStore((s) => s.setDbConnected)
  const setDbSession = useUiStore((s) => s.setDbSession)
  const peekPass = useDbPassStore((s) => s.peek)
  const setActiveTab = useUiStore((s) => s.setActiveTab)
  const seed = useUiStore((s) => s.dbQuerySeed)
  const history = useDbConnStore((s) => s.items)
  const touchConn = useDbConnStore((s) => s.touch)

  const [kind, setKind] = useState<DbKind>(DEFAULT_DB_KIND)
  const spec = liveDialect(kind) ?? DEFAULT
  const [host, setHost] = useState('localhost')
  const [port, setPort] = useState(spec?.defaultPort ?? '1521')
  const [user, setUser] = useState(spec?.defaultUser ?? '')
  const [password, setPassword] = useState('')
  const [keepPass, setKeepPass] = useState(true)
  const [db, setDb] = useState('')
  const [bad, setBad] = useState<string[]>([])

  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'connect' | 'catalog'>('idle')
  const [cpct, setCpct] = useState(0)
  const [clog, setClog] = useState<Array<{ cls: 'fp' | 'fh' | 'fn' | 'fs'; text: string }>>([])
  const [version, setVersion] = useState('')
  const [status, setStatus] = useState<{ tone: 'ok' | 'err'; title: string; text?: string } | null>(null)

  const [tables, setTables] = useState<DbTableLite[] | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [fks, setFks] = useState<ForeignKey[]>([])
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState('')
  const [result, setResult] = useState<{ added: number; covered: number; naming: number } | null>(null)
  const [seedSql, setSeedSql] = useState('')
  const [seedTable, setSeedTable] = useState('')
  const [seedRev, setSeedRev] = useState(0)
  /** 灌进去要不要自动跑。默认 true（点左侧表清单、旧跳转入口都该跑）；
   *  收藏详情跳过来才是 false——收藏里可能是 DELETE/UPDATE */
  const [seedRun, setSeedRun] = useState(true)
  const [connEnv, setConnEnv] = useState<DbEnv>('test')
  const pendingQuery = useRef<{ sql: string; table: string; run: boolean } | null>(null)
  /** 连上的是哪条 / 哪个地址：下面同步 session 的 effect 要带上，否则会把它们刷掉 */
  const sessionWho = useRef<{ connId?: string; addr?: string }>({})

  const existingNames = new Set(existing.map((t) => t.name.toLowerCase()))

  const [seenSeed, setSeenSeed] = useState(0)
  const [autoRev, setAutoRev] = useState(0)

  if (seed && seed.rev !== seenSeed) {
    setSeenSeed(seed.rev)
    if (seed.conn) {
      const k = dbKindOf(seed.conn.kind)
      if (liveDialect(k)) setKind(k)
      setHost(seed.conn.host)
      setPort(seed.conn.port)
      setUser(seed.conn.user)
      setDb(seed.conn.db)
      setPassword(seed.password ?? '')
      setKeepPass(canPersistPass(seed.conn.env))
      setBad([])
      setConnEnv(seed.conn.env ?? 'test')
      if (!seed.password && canPersistPass(seed.conn.env)) {
        void loadPass(seed.conn, seed.conn.env)
          .then((p) => {
            if (p) setPassword(p)
          })
          .catch((e) => {
            message.warning(`读不出记住的密码：${credErr(e)}`)
          })
      }
    }
    if (seed.sql) {
      pendingQuery.current = { sql: seed.sql, table: seed.table ?? '', run: seed.run !== false }
    }
    if (connected && seed.sql) {
      setSeedSql(seed.sql)
      setSeedTable(seed.table ?? '')
      setSeedRun(seed.run !== false)
      setSeedRev((n) => n + 1)
      pendingQuery.current = null
    } else if (seed.conn && seed.password && isTauri() && !connected) {
      setAutoRev(seed.rev)
    }
  }

  // 跟本页 connected 对齐。只在已连接时写 session；断开由 disconnect / switchKind 清。
  useEffect(() => {
    setDbConnected(connected)
    if (!connected) return
    setDbSession({ kind, env: connEnv, ...sessionWho.current })
  }, [connected, kind, connEnv, setDbConnected, setDbSession])

  // 切走或切换方言时关掉连接：池子占着对端的连接数配额
  useEffect(() => {
    const current = liveDialect(kind)
    return () => {
      if (isTauri()) void current?.disconnect().catch(() => {})
    }
  }, [kind])

  const fillFrom = (c: DbConn) => {
    const k = dbKindOf(c.kind)
    const live = liveDialect(k)
    if (live) setKind(k)
    setHost(c.host)
    setPort(c.port)
    setUser(c.user)
    setDb(c.db)
    setPassword(peekPass(c))
    setConnEnv(c.env ?? 'test')
    setKeepPass(canPersistPass(c.env))
    const mem = peekPass(c)
    if (mem) {
      message.info('已回填地址和这次记住的密码')
    } else if (canPersistPass(c.env) && isTauri()) {
      void loadPass(c, c.env)
        .then((p) => {
          if (p) {
            setPassword(p)
            message.info('已回填地址和记住的密码')
          } else {
            message.info('已回填地址，请填密码')
          }
        })
        .catch((e) => {
          message.warning(`已回填地址，但读不出记住的密码：${credErr(e)}`)
        })
    } else {
      message.info(c.env === 'prod' ? '已回填地址。生产连接每次现输密码' : '已回填地址，请填密码')
    }
  }

  const switchKind = (next: DbKind) => {
    const live = liveDialect(next)
    if (!live || next === kind) return
    setKind(next)
    setPort(live.defaultPort)
    setUser(live.defaultUser)
    if (live.fileBased) {
      setHost('.')
      setPassword('')
      setKeepPass(false)
    }
    setTables(null)
    setSel(new Set())
    setFks([])
    setConnected(false)
    setVersion('')
    setStatus(null)
    setResult(null)
    setSeedSql('')
    setSeedTable('')
    setSeedRev((n) => n + 1)
    setBad([])
    setConnEnv('test')
    setKeepPass(true)
    setDbConnected(false)
    setDbSession(null)
  }

  const connect = async () => {
    if (busy || !spec) return
    const need: Array<[string, string, string]> = spec.fileBased
      ? [[db, spec.dbLabel, 'db']]
      : [
          [host, '主机', 'host'],
          [port, '端口', 'port'],
          [user, '用户名', 'user'],
          [password, '密码', 'password'],
          [db, spec.dbLabel, 'db'],
        ]
    const miss = need.filter(([v]) => !v.trim())
    if (miss.length) {
      setBad(miss.map(([, , k]) => k))
      setStatus({ tone: 'err', title: `还差 ${miss.length} 项：${miss.map(([, l]) => l).join('、')} 不能为空` })
      return
    }
    setBad([])
    setResult(null)
    setBusy(true)
    setStatus(null)
    setConnected(false)
    setDbConnected(false)
    setDbSession(null)
    setPhase('connect')
    setCpct(8)
    const where = spec.fileBased
      ? db.trim()
      : `${host.trim()}:${port.trim()}/${db.trim()}`
    setClog([{ cls: 'fp', text: `连接 ${spec.label} ${where} …` }])

    try {
      if (isTauri()) {
        try {
          await spec.disconnect()
        } catch {
          /* 还没连过也当成功 */
        }
      }
      const catalog = await spec.connect({
        host: host.trim() || '.',
        port: port.trim() || '0',
        user: user.trim() || 'sqlite',
        password: spec.fileBased ? '' : password,
        db: db.trim(),
      })
      setPhase('catalog')
      setCpct(48)
      setClog((xs) => [
        ...xs,
        {
          cls: 'fn',
          text: spec.fileBased ? `打开文件成功` : `握手成功 · 用户 ${user.trim()}`,
        },
        { cls: 'fp', text: spec.catalogHint },
      ])

      const list = mapMetaTables(catalog.tables).map((t) => ({
        ...t,
        colCount: mapMetaCounts(catalog.counts).get(t.name) ?? 0,
      }))
      const mappedFks = mapMetaForeignKeys(catalog.fks)
      setCpct(100)
      setClog((xs) => [
        ...xs,
        { cls: 'fh', text: `✓ 读完 ${list.length} 张表 · 外键 ${mappedFks.length} 条` },
      ])
      setVersion(catalog.version)
      setTables(list)
      setFks(mappedFks)
      setSel(new Set(list.map((t) => t.name)))
      setStatus({
        tone: 'ok',
        title: `✓ 已连接 ${spec.label}${catalog.version ? ` 版本 ${catalog.version}` : ''} · ${describeConn({ host, port, db, fileBased: spec.fileBased })} · ${list.length} 张表`,
      })
      touchConn({
        kind,
        host: (host.trim() || '.'),
        port: (port.trim() || '0'),
        user: (user.trim() || 'sqlite'),
        db: db.trim(),
      })
      const addr = {
        kind,
        host: host.trim() || '.',
        port: port.trim() || '0',
        user: user.trim() || 'sqlite',
        db: db.trim(),
      }
      const named = namedConns(history).find((c) => sameAddress(c, addr))
      setConnEnv(named?.env ?? connEnv)
      setConnected(true)
      setDbConnected(true)
      sessionWho.current = { connId: named?.id, addr: sessionAddr(addr) }
      setDbSession({ kind, env: named?.env ?? connEnv, ...sessionWho.current })
      setPhase('idle')
      if (!spec.fileBased) {
        try {
          await persistPass(
            { kind, host: host.trim(), port: port.trim(), user: user.trim(), db: db.trim() },
            password,
            keepPass,
            named?.env ?? connEnv,
          )
        } catch (e) {
          message.warning(`已连接，但没记住密码：${credErr(e)}`)
        }
      }
      const q = pendingQuery.current
      if (q?.sql) {
        setSeedSql(q.sql)
        setSeedTable(q.table)
        setSeedRun(q.run)
        setSeedRev((n) => n + 1)
        pendingQuery.current = null
      }
    } catch (err) {
      setConnected(false)
      setVersion('')
      setTables(null)
      setFks([])
      setPhase('idle')
      const text = err instanceof Error ? err.message : String(err)
      setClog((xs) => [...xs, { cls: 'fs', text: `连接失败：${text}` }])
      setStatus({ tone: 'err', title: '连接失败', text })
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (autoRev === 0) return
    void connect()
    // 只跟这次跳转走。connect 关着当时的表单，写进 deps 会连两次。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上
  }, [autoRev])

  const toggle = (name: string, on: boolean) => {
    setSel((prev) => {
      const next = new Set(prev)
      if (on) next.add(name)
      else next.delete(name)
      return next
    })
  }

  const shown = (tables ?? []).filter((t) => {
    const kw = filter.trim().toLowerCase()
    return !kw || t.name.toLowerCase().includes(kw) || (t.comment ?? '').toLowerCase().includes(kw)
  })
  const doImport = async () => {
    if (!tables || !sel.size || importing || busy || !connected || !spec) return
    const names = [...sel]
    setImporting(true)
    setResult(null)
    try {
      const imported: TableInfo[] = []
      for (let i = 0; i < names.length; i++) {
        const lite = tables.find((t) => t.name === names[i])
        if (!lite) continue
        imported.push({
          name: lite.name,
          comment: lite.comment,
          source: 'db',
          columns: await spec.fetchColumns(lite.name),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        setProgress(`逐表拉取字段中 ${i + 1}/${names.length}`)
      }

      const pickedFks = fks.filter((f) => sel.has(f.fromTable) && sel.has(f.toTable))

      // 去重键必须小写：Oracle 表名通常是大写，inferForeignKeys 内部键是小写。
      const constraintKeys = new Set(
        [...cachedFks, ...pickedFks]
          .filter((f) => f.confidence === 'constraint')
          .map((f) => fkKey(f).toLowerCase()),
      )
      const namingFks = inferForeignKeys([...existing, ...imported], constraintKeys)

      await importTables(imported, [...pickedFks, ...namingFks])

      const covered = imported.filter((t) => existingNames.has(t.name.toLowerCase())).length
      setResult({ added: imported.length - covered, covered, naming: namingFks.length })
      setProgress('')
    } catch (err) {
      message.error(`导入失败：${err instanceof Error ? err.message : String(err)}`)
      setProgress('')
    } finally {
      setImporting(false)
    }
  }

  const pickTable = (name: string) => {
    if (!spec) return
    setSeedSql(previewSql(spec.id, name))
    setSeedTable(name)
    // 点表名就是要看数据，且 previewSql 永远是 SELECT——这里必须跑
    setSeedRun(true)
    setSeedRev((n) => n + 1)
  }

  const disconnect = async () => {
    if (spec && isTauri()) {
      try {
        await spec.disconnect()
      } catch {
        /* 已经断了也当成功 */
      }
    }
    setConnected(false)
    setVersion('')
    setTables(null)
    setSel(new Set())
    setFks([])
    setStatus(null)
    setResult(null)
    setSeedSql('')
    setSeedTable('')
    setSeedRun(true)
    setSeedRev((n) => n + 1)
    setPhase('idle')
    setCpct(0)
    setClog([])
    setConnEnv('test')
    setDbConnected(false)
    setDbSession(null)
  }

  const target = { host, port, db }
  const browserHint = spec ? `浏览器模式无${spec.driverName}，请使用桌面版连接。` : '浏览器模式请使用桌面版连接。'
  const tableNames = useMemo(() => (tables ?? []).map((t) => t.name), [tables])

  const connForm = (
    <Card hero title="连接信息" who={spec?.who}>
      <Stack>
        <Row>
          <Lbl>类型</Lbl>
          <Seg
            value={kind}
            onChange={switchKind}
            options={DIALECTS.map((d) => ({
              value: d.id,
              label: d.label,
              disabled: !isLiveDbKind(d),
              title: isLiveDbKind(d) ? undefined : d.disabled,
            }))}
          />
        </Row>
        {!spec?.fileBased && (
          <>
            <Row>
              <Lbl>主机</Lbl>
              <Fld className="grow" value={host} onChange={(e) => setHost(e.target.value)} placeholder="如 10.0.1.8" bad={bad.includes('host')} aria-label="主机" />
              <Lbl>端口</Lbl>
              <Fld className="fix" value={port} onChange={(e) => setPort(e.target.value)} placeholder="1521" bad={bad.includes('port')} aria-label="端口" />
            </Row>
            <Row>
              <Lbl>用户名</Lbl>
              <Fld className="grow" value={user} onChange={(e) => setUser(e.target.value)} placeholder="如 SCOTT" bad={bad.includes('user')} aria-label="用户名" />
            </Row>
            <Row>
              <Lbl>密码</Lbl>
              <Fld
                className="grow"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={connEnv === 'prod' ? '生产连接每次现输' : '可记住到本机'}
                bad={bad.includes('password')}
                aria-label="密码"
              />
            </Row>
            <Row>
              <Cb
                checked={keepPass}
                disabled={!isTauri()}
                title={
                  !isTauri()
                    ? '浏览器不能记住密码'
                    : connEnv === 'prod'
                      ? '生产连接不记住密码'
                      : '写进本机（当前 Windows 用户才能解开），不进「我的连接」'
                }
                onChange={(v) => {
                  if (!isTauri()) {
                    message.warning('浏览器不能记住密码，请用桌面版')
                    return
                  }
                  if (v && !canPersistPass(connEnv)) {
                    message.warning('生产连接不记住密码')
                    return
                  }
                  setKeepPass(v)
                }}
              >
                记住密码（跨天）
              </Cb>
              {!isTauri() && <Hint>浏览器模式不能记住。</Hint>}
              {connEnv === 'prod' && <Hint>生产连接每次现输，不写凭据。</Hint>}
            </Row>
          </>
        )}
        <Row>
          <Lbl>{spec?.dbLabel ?? '库'}</Lbl>
          <Fld
            className="grow mono"
            value={db}
            onChange={(e) => setDb(e.target.value)}
            placeholder={spec?.dbPlaceholder ?? ''}
            bad={bad.includes('db')}
            aria-label={spec?.dbLabel ?? '库'}
          />
        </Row>
        {spec && <Hint>{spec.dbHint}</Hint>}
        <Row>
          {!isTauri() && <Hint>{browserHint}</Hint>}
          <Spacer />
          <Btn
            variant="primary"
            disabled={!isTauri() || busy || !spec}
            title={!isTauri() ? browserHint : undefined}
            onClick={() => void connect()}
          >
            {busy ? '正在连接…' : (<><ApiOutlined aria-hidden="true" /> 连接并读取</>)}
          </Btn>
        </Row>
      </Stack>
    </Card>
  )

  const chips = namedConns(history).length ? namedConns(history) : history
  const historyCard = (
    <Card
      title="我的连接"
      who="点了回填地址 · 记住的密码会带上"
      extra={
        <Btn variant="mini" onClick={() => setActiveTab('dbconns')}>
          去管理
        </Btn>
      }
    >
      {chips.length === 0 ? (
        <Hint>
          还没有收藏。到「我的连接」起个名字，或先连一次——连上后记下类型、主机、端口、用户与
          {spec?.dbLabel ?? '库名'}。
        </Hint>
      ) : (
        <Stack>
          {/* 跟「我的连接」页同一种连接卡：名字 + 环境 / 地址 / 类型·用户，当前表单对应的那条高亮 */}
          <div className="g-two">
            {chips.map((c) => {
              const env = c.env ? DB_ENV[c.env] : null
              const on = dbKindOf(c.kind) === kind && c.host === host && c.port === port && c.db === db
              return (
                <button
                  type="button"
                  key={c.id ?? `${dbKindOf(c.kind)}:${c.host}:${c.port}/${c.db}`}
                  className={cx('conncard', on && 'on')}
                  onClick={() => fillFrom(c)}
                >
                  <div className="fr">
                    <span className="nm">{isNamedConn(c) ? c.name : `${c.host}/${c.db}`}</span>
                    {env && <Tag tone={env.tone}>{env.label}</Tag>}
                  </div>
                  <div className="addr">{`${c.host}:${c.port}/${c.db}`}</div>
                  <div className="who">
                    <Tag tone="hi">{dialectEntryLabel(c)}</Tag>
                    <span>{c.user}</span>
                  </div>
                </button>
              )
            })}
          </div>
          <Hint>点一下回填地址。测试/本地若勾过记住，会带上密码。生产每次现输。</Hint>
        </Stack>
      )}
    </Card>
  )

  const statTitle =
    phase === 'connect' ? '正在连接' : phase === 'catalog' ? '正在读取表清单' : status?.tone === 'err' ? '连接失败' : '还未连接'
  const statWho = phase !== 'idle' ? spec?.label : status?.tone === 'err' ? spec?.label : '点左边「连接并读取」'

  if (!connected) {
    return (
      <div className="dbq-setup">
        {status && phase === 'idle' && clog.length === 0 && (
          <Band tone={status.tone} title={status.title}>
            {status.text}
          </Band>
        )}
        <Split even>
          <Col>{connForm}</Col>
          {/* 没在连时右栏放我的连接（点一下就回填），连接进度只在连的时候出来 */}
          <Col>
            {historyCard}
            {(phase !== 'idle' || clog.length > 0) && (
            <Card title={statTitle} who={statWho}>
              {phase !== 'idle' || clog.length > 0 ? (
                <Stack>
                  <div className="pbar" aria-hidden>
                    <i style={{ width: `${cpct}%` }} />
                  </div>
                  <div className="scanlog">
                    {clog.map((l, i) => (
                      <div key={i} className={l.cls}>
                        {l.text}
                      </div>
                    ))}
                  </div>
                  {status?.tone === 'err' && phase === 'idle' && <Band tone="err" title={status.title}>{status.text}</Band>}
                </Stack>
              ) : (
                <EmptyBox>
                  填完左边再连。右边会出连接进度。
                </EmptyBox>
              )}
            </Card>
            )}
          </Col>
        </Split>
      </div>
    )
  }

  return (
    <div className="dbq-bench">
      <div className="navcol">
        <Card
          title="已连接"
          who={spec?.label}
          extra={
            <Btn variant="mini" onClick={() => void disconnect()}>
              断开
            </Btn>
          }
        >
          <div className="connline">
            {version ? (
              <>
                版本 <b>{version}</b>
              </>
            ) : (
              <b>{spec?.label}</b>
            )}
            {` · ${describeConn(target)} · ${user}`}
          </div>
          <Hint>先 200 行，加载全部最多 1 万。</Hint>
        </Card>

        <Card
          className="grow"
          title="表"
          who={tables ? String(tables.length) : '0'}
          extra={
            <Row tight>
              <Btn
                variant="mini"
                disabled={!tables?.length}
                onClick={() => setSel(new Set((tables ?? []).map((t) => t.name)))}
              >
                全选
              </Btn>
              <Btn variant="mini" disabled={!sel.size} onClick={() => setSel(new Set())}>
                全不选
              </Btn>
              <Btn
                variant="mini"
                disabled={!sel.size || importing}
                onClick={() => void doImport()}
              >
                {importing ? progress || '导入中…' : `导入勾选${sel.size ? ` ${sel.size}` : ''}`}
              </Btn>
            </Row>
          }
        >
          <div className="tfilter">
            <Fld value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="过滤表名 / 注释" aria-label="过滤表名" />
          </div>
          <div className="tlist" role="list">
            {shown.length === 0 && <Hint>过滤条件下没有命中的表</Hint>}
            {shown.map((t) => (
              <div
                key={t.name}
                className={cx('trow', seedTable === t.name && 'on')}
                role="listitem"
                onClick={() => pickTable(t.name)}
              >
                <input
                  type="checkbox"
                  checked={sel.has(t.name)}
                  aria-label={`导入 ${t.name}`}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => toggle(t.name, e.target.checked)}
                />
                <span className="tn" title={t.name}>
                  {t.name}
                </span>
                {t.comment ? <span className="tc" title={t.comment}>{t.comment}</span> : null}
                {existingNames.has(t.name.toLowerCase()) ? <Tag tone="wr">覆盖</Tag> : <Tag tone="ok">新增</Tag>}
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="workcol">
        {status?.tone === 'err' && (
          <Band tone="err" title={status.title}>
            {status.text}
          </Band>
        )}
        {result && (
          <Band tone="ok" title={`✓ 导入完成：新增 ${result.added} 张 · 覆盖 ${result.covered} 张（整表替换）`}>
            请到「查看表结构」确认。同名表后进覆盖先进，跟粘贴 DDL 是同一份缓存。
            {result.naming > 0 ? ` ${result.naming} 条关系为命名推断（默认不参与 JOIN）。` : ''}
          </Band>
        )}
        {tables?.length === 0 && spec && (
          <Band tone="warn" title={spec.emptyTitle}>
            {spec.emptyText}
          </Band>
        )}
        {spec && (
          <DbQuery
            spec={spec}
            seedSql={seedSql}
            seedTable={seedTable}
            seedRev={seedRev}
            seedRun={seedRun}
            env={connEnv}
            conn={{ kind, host, port, user, db }}
            tableNames={tableNames}
          />
        )}
      </div>
    </div>
  )
}

function dialectEntryLabel(c: DbConn): string {
  const e = DIALECTS.find((d) => d.id === dbKindOf(c.kind))
  return e?.label ?? 'Oracle'
}
