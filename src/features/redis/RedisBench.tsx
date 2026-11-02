/**
 * 已连接的工作台，布局跟连库查询同一套（dbq-bench）：
 * 左栏「已连接」+ 键树，右栏键详情在上、命令窗口在下。
 *
 * 列键只用 SCAN，每批 500 个，没扫完底部给「再加载」。搜索框回车才搜：
 * 边打边扫等于每敲一个字符就把线上库扫一遍。集群的游标由 Rust 编成「节点:游标」，
 * 这里当不透明字符串原样传回去。
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { App } from 'antd'
import { DB_ENV } from '../../types/dbconn'
import { credErr } from '../../lib/dbCred'
import {
  redisDbs,
  redisDeleteMatching,
  redisDisconnect,
  redisExec,
  redisScan,
  redisSelect,
  redisSetWritable,
  type RedisDbKeys,
} from '../../lib/redisIpc'
import { b64ToBytes, escapeBytes, textToB64, textToBytes, utf8OrNull } from '../../lib/redis/codec'
import { allGroupIds, groupPattern, keyRows, typeLabel, type RedisKey } from '../../lib/redis/keyTree'
import { asInt } from '../../lib/redis/reply'
import { Band, Btn, Card, cx, Dlg, EmptyBox, Fld, Hint, Lbl, Mono, Row, Sel, Seg, Stack, Tag, TextArea } from '../../components/ui'
import type { RedisSession } from './RedisConnect'
import { KeyDetail, READONLY_TIP } from './KeyDetail'
import { RedisConsole } from './RedisConsole'

const BATCH = 500
const SEP = ':'

/** 正常的键名原样显示；不是 UTF-8 的（JDK 序列化的键常见）写成 \xHH */
const keyOf = (k: { k: string; t: string }): RedisKey => {
  const bytes = b64ToBytes(k.k)
  return { b64: k.k, name: utf8OrNull(bytes) ?? escapeBytes(bytes), type: k.t }
}

type NewType = 'string' | 'hash' | 'list' | 'set' | 'zset'

export function RedisBench({ session, onClose }: { session: RedisSession; onClose: () => void }) {
  const { message } = App.useApp()
  const prod = session.env === 'prod'
  const label = session.name || `${session.host}:${session.port}`
  const [db, setDb] = useState(session.db)
  const [dbs, setDbs] = useState<RedisDbKeys[]>(session.info.dbs)
  const [writable, setWritable] = useState(session.info.writable)
  const [pattern, setPattern] = useState('')
  const [applied, setApplied] = useState('')
  const [keys, setKeys] = useState<RedisKey[]>([])
  const [cursor, setCursor] = useState('0')
  // 初始为 true：一进来就在扫第一批（见下面的 effect）
  const [scanning, setScanning] = useState(true)
  const [scanErr, setScanErr] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [sel, setSel] = useState<RedisKey | null>(null)
  const [conOpen, setConOpen] = useState(true)
  const [unlock, setUnlock] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [groupDel, setGroupDel] = useState<{ prefix: string; loaded: number } | null>(null)
  const cluster = session.info.kind === 'cluster'

  /** from = '0' 从头扫；否则接着上次的游标往下扫。返回的游标为 '0' = 扫完了 */
  const scan = useCallback(async (from: string, pat: string) => {
    try {
      const page = await redisScan(from, pat, BATCH)
      const got = page.keys.map(keyOf)
      setKeys((prev) => {
        if (from === '0') return got
        const seen = new Set(prev.map((k) => k.b64))
        return [...prev, ...got.filter((k) => !seen.has(k.b64))]
      })
      setCursor(page.cursor)
      setScanErr('')
      // 搜索时命中的通常不多，组全展开才看得到；不搜时全收着，不然一屏全是组
      if (from === '0') setOpen(pat ? allGroupIds(got, SEP) : new Set())
    } catch (e) {
      setScanErr(credErr(e))
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- 挂载扫第一批；scan 是异步取数，setState 都在 await 之后
    void scan('0', '')
  }, [scan])

  const rescan = (from: string, pat: string) => {
    setScanning(true)
    void scan(from, pat)
  }

  const refreshDbs = () => void redisDbs().then(setDbs, () => undefined)

  const search = () => {
    const p = pattern.trim()
    // 没写通配符就当「包含」搜：用户输 token 想找的是 user:1:token 这种，不是叫 token 的键
    const pat = !p ? '' : /[*?[]/.test(p) ? p : `*${p}*`
    setApplied(pat)
    setSel(null)
    rescan('0', pat)
  }

  const switchDb = async (next: number) => {
    try {
      await redisSelect(next)
      setDb(next)
      setSel(null)
      refreshDbs()
      rescan('0', applied)
    } catch (e) {
      message.error(credErr(e))
    }
  }

  const disconnect = async () => {
    try {
      await redisDisconnect()
    } finally {
      onClose()
    }
  }

  const setWrite = async (on: boolean) => {
    try {
      await redisSetWritable(on)
      setWritable(on)
      setUnlock(null)
      message[on ? 'warning' : 'success'](on ? '已临时允许写入生产，断开后自动恢复只读' : '已恢复只读')
    } catch (e) {
      message.error(credErr(e))
    }
  }

  const rows = useMemo(() => keyRows(keys, SEP, open), [keys, open])
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const dbCount = Math.min(Math.max(session.info.dbCount, db + 1), 256)
  const dbOptions = Array.from({ length: dbCount }, (_, i) => {
    const n = dbs.find((d) => d.db === i)?.keys ?? 0
    return { value: String(i), label: `库 ${i}${n ? `（${n} 个键）` : ''}` }
  })
  const env = DB_ENV[session.env]

  return (
    <div className="dbq-bench">
      <div className="navcol">
        <Card
          title="已连接"
          who={<Tag tone={env.tone}>{env.label}</Tag>}
          extra={
            <Btn variant="mini" onClick={() => void disconnect()}>
              断开
            </Btn>
          }
        >
          <Stack>
            <div className="connline">
              Redis <b>{session.info.version || '?'}</b>
              {` · ${label}`}
            </div>
            {session.info.kind === 'sentinel' && <Hint>哨兵指到的主节点：{session.info.nodes[0]}</Hint>}
            {cluster && (
              <Hint>
                <span title={session.info.nodes.join('\n')}>
                  集群 {session.info.nodes.length} 个主节点 · 共 {dbs[0]?.keys ?? 0} 个键
                </span>
              </Hint>
            )}
            {session.jump && <Hint>经跳板机 {`${session.jump.user ? `${session.jump.user}@` : ''}${session.jump.host}`}</Hint>}
            <Row tight>
              {!cluster && <Sel value={String(db)} onChange={(v) => void switchDb(Number(v))} options={dbOptions} aria-label="库号" />}
              {prod &&
                (writable ? (
                  <Btn variant="mini" on onClick={() => void setWrite(false)}>
                    恢复只读
                  </Btn>
                ) : (
                  <Btn variant="mini" danger onClick={() => setUnlock('')}>
                    临时允许写入
                  </Btn>
                ))}
            </Row>
            {prod && <Hint>{writable ? '正在写生产，断开后自动恢复只读。' : '生产连接只读。'}</Hint>}
          </Stack>
        </Card>

        <Card
          className="grow"
          title="键"
          who={`${keys.length}${cursor !== '0' ? '+' : ''}`}
          extra={
            <Row tight>
              <Btn variant="mini" disabled={!keys.length} onClick={() => setOpen(allGroupIds(keys, SEP))}>
                全部展开
              </Btn>
              <Btn variant="mini" disabled={!open.size} onClick={() => setOpen(new Set())}>
                全部收起
              </Btn>
              <Btn variant="mini" blocked={!writable} title={writable ? undefined : READONLY_TIP} onClick={() => (writable ? setCreating(true) : message.warning(READONLY_TIP))}>
                新建键
              </Btn>
            </Row>
          }
        >
          <div className="tfilter">
            <Fld
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') search()
              }}
              placeholder="搜键名，回车搜；支持 user:*:token"
              aria-label="搜索键名"
            />
          </div>
          <div className="tlist rk-tree" role="tree">
            {scanErr && (
              <Band tone="err" title="列键失败">
                {scanErr}
              </Band>
            )}
            {!scanErr && !scanning && keys.length === 0 && (
              <Hint>{applied ? `没有匹配 ${applied} 的键${cursor !== '0' ? '（还没扫完，点下面继续扫）' : ''}` : '这个库是空的'}</Hint>
            )}
            {rows.map((r) =>
              r.kind === 'group' ? (
                <div
                  key={`g${r.id}`}
                  className="trow rk-grp"
                  role="treeitem"
                  aria-expanded={r.open}
                  style={{ '--d': r.depth } as CSSProperties}
                  onClick={() => toggle(r.id)}
                >
                  <span className="rk-car">{r.open ? '▾' : '▸'}</span>
                  <span className="tn" title={r.id}>
                    {r.label}
                  </span>
                  <span className="tc">{r.count}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    className="rk-gdel"
                    title={writable ? `删除库里所有以 ${r.id} 开头的键` : READONLY_TIP}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (!writable) message.warning(READONLY_TIP)
                      else setGroupDel({ prefix: r.id, loaded: r.count ?? 0 })
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.stopPropagation()
                        if (!writable) message.warning(READONLY_TIP)
                        else setGroupDel({ prefix: r.id, loaded: r.count ?? 0 })
                      }
                    }}
                  >
                    删整组
                  </span>
                </div>
              ) : (
                <div
                  key={`k${r.id}`}
                  className={cx('trow', sel?.b64 === r.id && 'on')}
                  role="treeitem"
                  style={{ '--d': r.depth } as CSSProperties}
                  onClick={() => setSel(r.key!)}
                >
                  <Tag tone={r.key!.type === 'string' ? 'ok' : 'hi'}>{typeLabel(r.key!.type)}</Tag>
                  <span className="tn" title={r.key!.name}>
                    {r.label}
                  </span>
                </div>
              ),
            )}
          </div>
          <div className="rk-more">
            <Row tight>
              <Hint>{scanning ? '正在扫描…' : cursor !== '0' ? `已加载 ${keys.length} 个，还没扫完` : `共 ${keys.length} 个`}</Hint>
              {cursor !== '0' && (
                <Btn variant="mini" disabled={scanning} onClick={() => rescan(cursor, applied)}>
                  再加载 {BATCH} 个
                </Btn>
              )}
              <Btn variant="mini" disabled={scanning} onClick={() => rescan('0', applied)}>
                刷新
              </Btn>
            </Row>
          </div>
        </Card>
      </div>

      <div className="workcol">
        {session.info.kind === 'single' && session.info.mode === 'cluster' && (
          <Band tone="warn" title="这是集群里的一个节点">
            现在只看得到这个节点上的键，操作别的节点上的键会报 MOVED。断开后把连接方式改成「集群」再连。
          </Band>
        )}
        {session.info.kind === 'single' && session.info.mode === 'sentinel' && (
          <Band tone="warn" title="连的是哨兵，不是数据节点">
            哨兵里没有业务数据。断开后把连接方式改成「哨兵」、填上主节点名再连（主节点名可在命令窗口执行 SENTINEL masters 查）。
          </Band>
        )}
        {sel ? (
          <KeyDetail
            key={sel.b64}
            rkey={sel}
            writable={writable}
            onGone={(b64) => {
              setKeys((prev) => prev.filter((k) => k.b64 !== b64))
              setSel(null)
              refreshDbs()
            }}
            onRenamed={(old, next) => {
              setKeys((prev) => prev.map((k) => (k.b64 === old ? next : k)))
              setSel(next)
            }}
          />
        ) : (
          <Card className="rk-detail" title="值">
            <EmptyBox>点左边一个键看它的值。键多的话先在搜索框里输前缀，如 user:</EmptyBox>
          </Card>
        )}
        <RedisConsole open={conOpen} onToggle={setConOpen} db={db} />
      </div>

      <Dlg
        title="临时允许写入生产"
        open={unlock !== null}
        onClose={() => setUnlock(null)}
        width={560}
        actions={
          <>
            <Btn onClick={() => setUnlock(null)}>取消</Btn>
            <Btn variant="primary" danger disabled={unlock?.trim() !== label} onClick={() => void setWrite(true)}>
              允许写入
            </Btn>
          </>
        }
      >
        <Band tone="warn" title="生产">
          放开后改值、删键都会真的写到生产 Redis。断开连接就自动恢复只读；所有写操作都记在本机操作日志里。
        </Band>
        <Row>
          <Lbl>输入连接名确认</Lbl>
          <Fld className="grow mono" value={unlock ?? ''} onChange={(e) => setUnlock(e.target.value)} placeholder={label} aria-label="连接名" />
        </Row>
      </Dlg>

      {groupDel && (
        <GroupDeleteDialog
          prefix={groupDel.prefix}
          loaded={groupDel.loaded}
          prod={prod}
          onClose={(changed) => {
            setGroupDel(null)
            if (!changed) return
            setSel(null)
            refreshDbs()
            rescan('0', applied)
          }}
        />
      )}

      {creating && (
        <NewKeyDialog
          onClose={() => setCreating(false)}
          onCreated={(k) => {
            setCreating(false)
            setKeys((prev) => [k, ...prev.filter((x) => x.b64 !== k.b64)])
            setSel(k)
            refreshDbs()
          }}
        />
      )}
    </div>
  )
}

/**
 * 删整组：删的是库里所有匹配的键，不只是左边已加载的那些——所以要手输前缀确认。
 * Rust 一轮最多删 2 万个，没删完就停下来给「继续删」，不一口气把线上压死
 */
function GroupDeleteDialog({
  prefix,
  loaded,
  prod,
  onClose,
}: {
  prefix: string
  loaded: number
  prod: boolean
  onClose: (changed: boolean) => void
}) {
  const { message } = App.useApp()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [total, setTotal] = useState(0)
  const [more, setMore] = useState(false)
  const pattern = groupPattern(prefix)
  const started = total > 0 || more

  const run = async () => {
    setBusy(true)
    try {
      const r = await redisDeleteMatching(pattern)
      const sum = total + r.deleted
      setTotal(sum)
      setMore(r.more)
      if (!r.more) {
        message.success(`已删除 ${sum} 个键`)
        onClose(true)
      }
    } catch (e) {
      message.error(credErr(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dlg
      title="删除整组"
      open
      onClose={() => onClose(started)}
      width={600}
      actions={
        <>
          <Btn onClick={() => onClose(started)}>{started ? '先到这里' : '取消'}</Btn>
          <Btn variant="primary" danger disabled={busy || typed !== prefix} onClick={() => void run()}>
            {busy ? '正在删…' : more ? '继续删' : '删除'}
          </Btn>
        </>
      }
    >
      <Band tone="warn" title={prod ? '生产' : '删了就没有了'}>
        会删掉库里所有以 <Mono>{prefix}</Mono> 开头的键——不只是左边已加载的 {loaded} 个。Redis 没有回收站。
      </Band>
      {more && <Band tone="info">已删 {total} 个，还没删完。一轮只删一部分，免得把 Redis 压得太重；点「继续删」接着删。</Band>}
      <Row>
        <Lbl>输入前缀确认</Lbl>
        <Fld className="grow mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={prefix} aria-label="前缀" />
      </Row>
      <Hint>匹配模式：{pattern}。删除记在本机操作日志里。</Hint>
    </Dlg>
  )
}

function NewKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (k: RedisKey) => void }) {
  const { message } = App.useApp()
  const [type, setType] = useState<NewType>('string')
  const [name, setName] = useState('')
  const [field, setField] = useState('')
  const [value, setValue] = useState('')
  const [score, setScore] = useState('0')
  const [ttl, setTtl] = useState('')
  const [busy, setBusy] = useState(false)

  const create = async () => {
    const key = name.trim()
    if (!key) return message.error('键名不能为空')
    if (ttl.trim() && !/^\d+$/.test(ttl.trim())) return message.error('过期时间填秒数，不填就是永不过期')
    if (type === 'hash' && !field) return message.error('字段名不能为空')
    if (type === 'zset' && !Number.isFinite(Number(score))) return message.error('分数要填数字')
    setBusy(true)
    try {
      // 已有的键不覆盖：新建是新建，改值请去点那个键
      if (asInt(await redisExec('EXISTS', key))) {
        message.error('这个键已经有了，在左边搜它再改')
        return
      }
      const v = textToBytes(value)
      if (type === 'string') await redisExec('SET', key, v)
      else if (type === 'hash') await redisExec('HSET', key, field, v)
      else if (type === 'list') await redisExec('RPUSH', key, v)
      else if (type === 'set') await redisExec('SADD', key, v)
      else await redisExec('ZADD', key, score.trim(), v)
      if (ttl.trim()) await redisExec('EXPIRE', key, ttl.trim())
      message.success('已新建')
      onCreated({ b64: textToB64(key), name: key, type })
    } catch (e) {
      message.error(credErr(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dlg
      title="新建键"
      open
      onClose={onClose}
      width={640}
      actions={
        <>
          <Btn onClick={onClose}>取消</Btn>
          <Btn variant="primary" disabled={busy} onClick={() => void create()}>
            新建
          </Btn>
        </>
      }
    >
      <Row>
        <Lbl>类型</Lbl>
        <Seg
          value={type}
          onChange={setType}
          options={(['string', 'hash', 'list', 'set', 'zset'] as const).map((t) => ({ value: t, label: typeLabel(t) }))}
        />
      </Row>
      <Row>
        <Lbl>键名</Lbl>
        <Fld className="grow mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="如 user:1001:profile" aria-label="键名" />
      </Row>
      {type === 'hash' && (
        <Row>
          <Lbl>字段</Lbl>
          <Fld className="grow mono" value={field} onChange={(e) => setField(e.target.value)} aria-label="字段" />
        </Row>
      )}
      {type === 'zset' && (
        <Row>
          <Lbl>分数</Lbl>
          <Fld className="fix mono" value={score} onChange={(e) => setScore(e.target.value)} aria-label="分数" />
        </Row>
      )}
      <Lbl>{type === 'set' || type === 'zset' ? '第一个成员' : type === 'list' ? '第一个值' : '值'}</Lbl>
      <TextArea className="rk-val-edit" value={value} onChange={(e) => setValue(e.target.value)} aria-label="值" />
      <Row>
        <Lbl>过期秒数</Lbl>
        <Fld className="fix" value={ttl} onChange={(e) => setTtl(e.target.value)} placeholder="不填永不过期" aria-label="过期秒数" />
      </Row>
    </Dlg>
  )
}
