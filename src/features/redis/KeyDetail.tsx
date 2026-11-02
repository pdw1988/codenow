/**
 * 右边·一个键的详情：头部（类型、大小、过期倒数）+ 值。
 *
 * 字符串整个值进 ValueBox；哈希 / 列表 / 集合 / 有序集合按每页 200 条分批读
 * （HSCAN / SSCAN / LRANGE / ZRANGE），不用 HGETALL / SMEMBERS：大键一句就能把线上卡住。
 * 父组件用 key={b64} 挂它，换键就是重新挂载，不用自己对比上一个键。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { App } from 'antd'
import { credErr } from '../../lib/dbCred'
import { redisExec } from '../../lib/redisIpc'
import { bytesToB64, preview, sizeText, textToB64, textToBytes, ttlText, utf8OrNull } from '../../lib/redis/codec'
import { asArr, asBytes, asInt, asText } from '../../lib/redis/reply'
import { typeLabel, type RedisKey } from '../../lib/redis/keyTree'
import { Band, Btn, Card, Dlg, EmptyBox, Fld, Hint, Lbl, Mono, Row, Seg, Spacer, Stack, TextArea } from '../../components/ui'
import { ValueBox } from './ValueBox'

const PAGE = 200
/** 超过就提示「这是大键」：字符串只读前 1MB，其它类型照样分页读 */
const BIG_BYTES = 1024 * 1024
const BIG_LEN = 10000
/** 内存占用超过这个也算大键：字段不多但每个值都很大的哈希，按条数看不出来 */
const BIG_MEM = 10 * 1024 * 1024

export const READONLY_TIP = '生产连接只读。确实要改，先点左上「临时允许写入」'

interface Meta {
  type: string
  /** 到期时刻（本机时钟）；null = 永不过期 */
  expireAt: number | null
  size: number | null
  len: number
}

interface Item {
  /** 哈希的字段 / 列表的值 / 集合和有序集合的成员 */
  a: Uint8Array
  /** 哈希的值 */
  b?: Uint8Array
  score?: string
  /** 列表下标 */
  idx?: number
}

type ItemDlg = { mode: 'add' } | { mode: 'edit'; item: Item }

const LEN_CMD: Record<string, string> = {
  string: 'STRLEN',
  hash: 'HLEN',
  list: 'LLEN',
  set: 'SCARD',
  zset: 'ZCARD',
  stream: 'XLEN',
}

const LEN_LABEL: Record<string, string> = {
  string: '长度',
  hash: '字段',
  list: '元素',
  set: '成员',
  zset: '成员',
  stream: '条目',
}

const itemId = (it: Item) => bytesToB64(it.a)

interface Props {
  rkey: RedisKey
  writable: boolean
  /** 键被删了 / 已不存在 */
  onGone: (b64: string) => void
  onRenamed: (oldB64: string, next: RedisKey) => void
}

export function KeyDetail({ rkey, writable, onGone, onRenamed }: Props) {
  const { message } = App.useApp()
  const k = useMemo(() => ({ b64: rkey.b64 }), [rkey.b64])
  const [meta, setMeta] = useState<Meta | null>(null)
  const [err, setErr] = useState('')
  const [str, setStr] = useState<{ bytes: Uint8Array; cut: boolean } | null>(null)
  const [items, setItems] = useState<Item[]>([])
  /** 哈希 / 集合是 SCAN 游标；列表 / 有序集合是下一页起始下标。'0' = 没有更多 */
  const [cursor, setCursor] = useState('0')
  const [now, setNow] = useState(() => Date.now())
  const [dlg, setDlg] = useState<ItemDlg | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; body: string; run: () => Promise<unknown> } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [ttlEdit, setTtlEdit] = useState<string | null>(null)

  const loadItems = useCallback(
    async (type: string, len: number, from: string) => {
      const reset = from === '0'
      let got: Item[] = []
      let next = '0'
      if (type === 'hash' || type === 'set') {
        const r = asArr(await redisExec(type === 'hash' ? 'HSCAN' : 'SSCAN', k, from, 'COUNT', String(PAGE)))
        next = r[0] ? asText(r[0]) : '0'
        const flat = r[1] ? asArr(r[1]) : []
        if (type === 'hash') {
          for (let i = 0; i + 1 < flat.length; i += 2) {
            got.push({ a: asBytes(flat[i]!) ?? new Uint8Array(), b: asBytes(flat[i + 1]!) ?? new Uint8Array() })
          }
        } else {
          got = flat.map((m) => ({ a: asBytes(m) ?? new Uint8Array() }))
        }
      } else if (type === 'list' || type === 'zset') {
        const start = Number(from)
        const stop = String(start + PAGE - 1)
        const flat = asArr(
          type === 'list'
            ? await redisExec('LRANGE', k, String(start), stop)
            : await redisExec('ZRANGE', k, String(start), stop, 'WITHSCORES'),
        )
        if (type === 'list') {
          got = flat.map((v, i) => ({ a: asBytes(v) ?? new Uint8Array(), idx: start + i }))
        } else {
          for (let i = 0; i + 1 < flat.length; i += 2) {
            got.push({ a: asBytes(flat[i]!) ?? new Uint8Array(), score: asText(flat[i + 1]!) })
          }
        }
        const end = start + got.length
        next = got.length < PAGE || end >= len ? '0' : String(end)
      }
      // SCAN 允许同一个元素在两批里各出现一次（扫描期间 rehash），按字段 / 成员去重
      setItems((prev) => {
        if (reset) return got
        if (type !== 'hash' && type !== 'set') return [...prev, ...got]
        const seen = new Set(prev.map(itemId))
        return [...prev, ...got.filter((it) => !seen.has(itemId(it)))]
      })
      setCursor(next)
    },
    [k],
  )

  const load = useCallback(async () => {
    try {
      const [t, pttl] = await Promise.all([redisExec('TYPE', k), redisExec('PTTL', k)])
      const type = asText(t)
      if (type === 'none') {
        setMeta(null)
        setErr('这个键已经不存在了（可能刚过期，或被别人删了）')
        return
      }
      // 云上有的把 MEMORY 禁了，拿不到就不显示大小
      const size = await redisExec('MEMORY', 'USAGE', k).then(asInt, () => null)
      const lenCmd = LEN_CMD[type]
      const len = lenCmd ? asInt(await redisExec(lenCmd, k)) : 0
      const ms = asInt(pttl)
      const t0 = Date.now()
      setNow(t0)
      setMeta({ type, expireAt: ms >= 0 ? t0 + ms : null, size, len })
      setErr('')
      if (type === 'string') {
        const cut = len > BIG_BYTES
        const r = cut ? await redisExec('GETRANGE', k, '0', String(BIG_BYTES - 1)) : await redisExec('GET', k)
        setStr({ bytes: asBytes(r) ?? new Uint8Array(), cut })
      } else {
        await loadItems(type, len, '0')
      }
    } catch (e) {
      setErr(credErr(e))
    }
  }, [k, loadItems])

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- 挂载读一次键；load 是异步取数，setState 都在 await 之后
    void load()
  }, [load])

  // 过期倒数每秒走一格。当前时间放状态里：渲染时直接调 Date.now() 是不纯的
  const counting = meta?.expireAt != null
  useEffect(() => {
    if (!counting) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [counting])

  /** 所有写操作走这里：只读先拦（Rust 也会拦，这里只是少跑一趟），成功后整个重读 */
  const write = async (done: string, fn: () => Promise<unknown>): Promise<boolean> => {
    if (!writable) {
      message.warning(READONLY_TIP)
      return false
    }
    try {
      await fn()
      message.success(done)
      await load()
      return true
    } catch (e) {
      message.error(credErr(e))
      return false
    }
  }

  const saveString = (bytes: Uint8Array) =>
    write('已保存', async () => {
      try {
        await redisExec('SET', k, bytes, 'KEEPTTL')
      } catch (e) {
        if (!/syntax/i.test(credErr(e))) throw e
        // Redis 6 以前没有 KEEPTTL：先存再把剩余时间补回去，不然一保存就变成永不过期
        const ms = asInt(await redisExec('PTTL', k))
        await redisExec('SET', k, bytes)
        if (ms > 0) await redisExec('PEXPIRE', k, String(ms))
      }
    })

  const removeKey = () =>
    setConfirm({
      title: '删除这个键',
      body: rkey.name,
      run: async () => {
        if (!writable) {
          message.warning(READONLY_TIP)
          return
        }
        try {
          try {
            await redisExec('UNLINK', k)
          } catch (e) {
            // UNLINK 是 4.0 才有的（不阻塞删大键），老版本退回 DEL
            if (!/unknown command/i.test(credErr(e))) throw e
            await redisExec('DEL', k)
          }
          message.success('已删除')
          onGone(rkey.b64)
        } catch (e) {
          message.error(credErr(e))
        }
      },
    })

  const rename = async (next: string) => {
    const name = next.trim()
    if (!name || name === rkey.name) {
      setRenaming(null)
      return
    }
    if (!writable) {
      message.warning(READONLY_TIP)
      return
    }
    try {
      // RENAMENX：新名字已有键时不覆盖。RENAME 会把对方静默盖掉
      const ok = asInt(await redisExec('RENAMENX', k, name))
      if (!ok) {
        message.error('新名字已经有键了，没有改')
        return
      }
      setRenaming(null)
      message.success('已改名')
      onRenamed(rkey.b64, { b64: textToB64(name), name, type: meta?.type ?? rkey.type })
    } catch (e) {
      message.error(credErr(e))
    }
  }

  const setTtl = async (secs: string | null) => {
    if (secs !== null && !/^\d+$/.test(secs.trim())) {
      message.error('过期时间填秒数，如 3600')
      return
    }
    const ok = await write(secs === null ? '已设为永不过期' : '已设置过期时间', () =>
      secs === null ? redisExec('PERSIST', k) : redisExec('EXPIRE', k, secs.trim()),
    )
    if (ok) setTtlEdit(null)
  }

  const copyName = () =>
    void navigator.clipboard.writeText(rkey.name).then(
      () => message.success('已复制键名'),
      () => message.error('复制失败'),
    )

  const type = meta?.type ?? rkey.type
  const big = meta ? (type === 'string' ? meta.len > BIG_BYTES : meta.len > BIG_LEN) : false
  const heavy = !big && type !== 'string' && meta?.size != null && meta.size > BIG_MEM

  const head = (
    <Row tight>
      <Btn variant="mini" onClick={() => void load()}>
        刷新
      </Btn>
      <Btn variant="mini" onClick={copyName}>
        复制键名
      </Btn>
      <Btn variant="mini" blocked={!writable} title={writable ? undefined : READONLY_TIP} onClick={() => (writable ? setRenaming(rkey.name) : message.warning(READONLY_TIP))}>
        改名
      </Btn>
      <Btn variant="mini" blocked={!writable} title={writable ? undefined : READONLY_TIP} onClick={() => (writable ? setTtlEdit('') : message.warning(READONLY_TIP))}>
        过期时间
      </Btn>
      <Btn variant="mini" danger blocked={!writable} title={writable ? undefined : READONLY_TIP} onClick={removeKey}>
        删除
      </Btn>
    </Row>
  )

  return (
    <Card className="rk-detail" title={<span className="rk-keyname">{rkey.name}</span>} who={typeLabel(type)} extra={head}>
      <Stack>
        {err && (
          <Band tone="err" title="读取失败">
            {err}
            {err.includes('不存在') && (
              <>
                {' '}
                <Btn variant="mini" onClick={() => onGone(rkey.b64)}>
                  从列表里去掉
                </Btn>
              </>
            )}
          </Band>
        )}
        {meta && (
          <div className="connline">
            {LEN_LABEL[type] ?? '长度'} <b>{type === 'string' ? sizeText(meta.len) : meta.len}</b>
            {meta.size !== null && (
              <>
                {' · 占内存 '}
                <b>{sizeText(meta.size)}</b>
              </>
            )}
            {' · 过期 '}
            <b>{meta.expireAt === null ? '永不过期' : ttlText(meta.expireAt - now)}</b>
          </div>
        )}
        {(big || heavy) && (
          <Band tone="warn" title="这是大键">
            {type === 'string'
              ? '只读了前 1MB，不能在这里改。'
              : `共 ${meta?.len} 条，每次只读 ${PAGE} 条，要看更多点下面「再加载」。`}
            别在命令窗口里对它执行 HGETALL / SMEMBERS / LRANGE 0 -1 这类一次取全的命令，会卡住 Redis；删除用的是不阻塞的 UNLINK。
          </Band>
        )}
        {meta && type === 'string' && str && (
          <ValueBox
            bytes={str.bytes}
            from={`Redis ${rkey.name}`}
            lockedWhy={str.cut ? '大键只读了前 1MB，不能在这里改' : writable ? undefined : READONLY_TIP}
            onSave={saveString}
          />
        )}
        {meta && LEN_CMD[type] && type !== 'string' && type !== 'stream' && (
          <Items
            type={type}
            items={items}
            more={cursor !== '0'}
            writable={writable}
            onMore={() => void loadItems(type, meta.len, cursor).catch((e: unknown) => message.error(credErr(e)))}
            onAdd={() => (writable ? setDlg({ mode: 'add' }) : message.warning(READONLY_TIP))}
            onOpen={(item) => setDlg({ mode: 'edit', item })}
            onRemove={(item) =>
              setConfirm({
                title: type === 'hash' ? '删除这个字段' : '删除这一条',
                body: preview(item.a),
                run: () => write('已删除', () => removeItem(k, type, item)),
              })
            }
          />
        )}
        {meta && !LEN_CMD[type] && (
          <EmptyBox>这种类型（{type}）这一版还不能在这里看，请在下面的命令窗口里查。</EmptyBox>
        )}
        {meta && type === 'stream' && (
          <EmptyBox>流（stream）这一版请在下面的命令窗口里看：XRANGE 键名 - + COUNT 20</EmptyBox>
        )}
      </Stack>

      {dlg && (
        <ItemDialog
          type={type}
          dlg={dlg}
          writable={writable}
          from={`Redis ${rkey.name}`}
          onClose={() => setDlg(null)}
          onSubmit={async (next) => {
            const ok = await write(dlg.mode === 'add' ? '已添加' : '已保存', () =>
              saveItem(k, type, dlg.mode === 'edit' ? dlg.item : null, next),
            )
            if (ok) setDlg(null)
          }}
        />
      )}

      <Dlg
        title={confirm?.title ?? ''}
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        width={520}
        actions={
          <>
            <Btn onClick={() => setConfirm(null)}>取消</Btn>
            <Btn
              variant="primary"
              danger
              onClick={() => {
                const c = confirm
                setConfirm(null)
                void c?.run()
              }}
            >
              删除
            </Btn>
          </>
        }
      >
        <Mono className="rk-keyname">{confirm?.body}</Mono>
        <Hint>删了就没有了，Redis 没有回收站。</Hint>
      </Dlg>

      <Dlg
        title="改名"
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        width={560}
        actions={
          <>
            <Btn onClick={() => setRenaming(null)}>取消</Btn>
            <Btn variant="primary" onClick={() => void rename(renaming ?? '')}>
              改名
            </Btn>
          </>
        }
      >
        <Fld className="mono" value={renaming ?? ''} onChange={(e) => setRenaming(e.target.value)} aria-label="新键名" />
        <Hint>新名字已经有键时不会覆盖它。过期时间跟着键走。</Hint>
      </Dlg>

      <Dlg
        title="过期时间"
        open={ttlEdit !== null}
        onClose={() => setTtlEdit(null)}
        width={520}
        actions={
          <>
            <Btn onClick={() => void setTtl(null)}>设为永不过期</Btn>
            <Spacer />
            <Btn onClick={() => setTtlEdit(null)}>取消</Btn>
            <Btn variant="primary" onClick={() => void setTtl(ttlEdit ?? '')}>
              设置
            </Btn>
          </>
        }
      >
        <Row>
          <Lbl>多少秒后过期</Lbl>
          <Fld className="fix" value={ttlEdit ?? ''} onChange={(e) => setTtlEdit(e.target.value)} placeholder="3600" aria-label="过期秒数" />
        </Row>
        <Hint>
          现在：{meta?.expireAt == null ? '永不过期' : ttlText(meta.expireAt - now)}。常用：3600 = 1 小时，86400 = 1 天。
        </Hint>
      </Dlg>
    </Card>
  )
}

/* ------------------------- 集合类的表格 ------------------------- */

function Items({
  type,
  items,
  more,
  writable,
  onMore,
  onAdd,
  onOpen,
  onRemove,
}: {
  type: string
  items: Item[]
  more: boolean
  writable: boolean
  onMore: () => void
  onAdd: () => void
  onOpen: (item: Item) => void
  onRemove: (item: Item) => void
}) {
  const first = type === 'hash' ? '字段' : type === 'list' ? '值' : '成员'
  return (
    <Stack>
      <Row tight>
        <Hint>
          已加载 {items.length} 条。点一行看完整的值{writable ? '、改值' : ''}。
        </Hint>
        <Spacer />
        <Btn variant="mini" blocked={!writable} title={writable ? undefined : READONLY_TIP} onClick={onAdd}>
          添加一条
        </Btn>
      </Row>
      <table className="rk-items">
        <thead>
          <tr>
            {type === 'list' && <th>下标</th>}
            <th>{first}</th>
            {type === 'hash' && <th>值</th>}
            {type === 'zset' && <th>分数</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={type === 'list' ? `i${it.idx}` : itemId(it)} onClick={() => onOpen(it)}>
              {type === 'list' && <td className="n">{it.idx}</td>}
              <td className="v">{preview(it.a)}</td>
              {type === 'hash' && <td className="v">{it.b ? preview(it.b) : ''}</td>}
              {type === 'zset' && <td className="n">{it.score}</td>}
              <td className="ops">
                <Btn
                  variant="mini"
                  danger
                  blocked={!writable}
                  title={writable ? '删除这一条' : READONLY_TIP}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemove(it)
                  }}
                >
                  删除
                </Btn>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length === 0 && <EmptyBox>是空的。</EmptyBox>}
      {more && (
        <Row>
          <Btn variant="mini" onClick={onMore}>
            再加载 {PAGE} 条
          </Btn>
        </Row>
      )}
    </Stack>
  )
}

/* ------------------------- 加一条 / 改一条 ------------------------- */

interface ItemDraft {
  a: string
  b: string
  score: string
  head: boolean
}

function ItemDialog({
  type,
  dlg,
  writable,
  from,
  onClose,
  onSubmit,
}: {
  type: string
  dlg: ItemDlg
  writable: boolean
  from: string
  onClose: () => void
  onSubmit: (next: ItemDraft) => Promise<void>
}) {
  const item = dlg.mode === 'edit' ? dlg.item : null
  const aText = item ? utf8OrNull(item.a) : ''
  const bText = item?.b ? utf8OrNull(item.b) : ''
  // 二进制的字段或值改不了：走一趟文本框字节就变了
  const binary = aText === null || bText === null
  const [draft, setDraft] = useState<ItemDraft>({
    a: aText ?? '',
    b: bText ?? '',
    score: item?.score ?? '0',
    head: false,
  })
  const [busy, setBusy] = useState(false)
  const editing = writable && !binary
  const valueOf = type === 'hash' ? item?.b : item?.a

  const title =
    dlg.mode === 'add'
      ? '添加一条'
      : type === 'hash'
        ? '字段'
        : type === 'list'
          ? `下标 ${item?.idx}`
          : '成员'

  return (
    <Dlg
      title={title}
      open
      onClose={onClose}
      tall
      actions={
        editing ? (
          <>
            <Btn onClick={onClose}>取消</Btn>
            <Btn
              variant="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void onSubmit(draft).finally(() => setBusy(false))
              }}
            >
              {dlg.mode === 'add' ? '添加' : '保存'}
            </Btn>
          </>
        ) : (
          <Btn onClick={onClose}>关闭</Btn>
        )
      }
    >
      {!editing && dlg.mode === 'edit' && valueOf && (
        <>
          {type === 'hash' && item && (
            <Row>
              <Lbl>字段</Lbl>
              <Mono>{preview(item.a, 400)}</Mono>
            </Row>
          )}
          <ValueBox bytes={valueOf} from={from} />
          {binary && writable && <Hint>二进制内容不能在这里改，要改请走业务接口。</Hint>}
        </>
      )}
      {editing && (
        <>
          {type === 'hash' && (
            <Row>
              <Lbl>字段</Lbl>
              <Fld className="grow mono" value={draft.a} onChange={(e) => setDraft({ ...draft, a: e.target.value })} aria-label="字段" />
            </Row>
          )}
          {type === 'zset' && (
            <Row>
              <Lbl>分数</Lbl>
              <Fld className="fix mono" value={draft.score} onChange={(e) => setDraft({ ...draft, score: e.target.value })} aria-label="分数" />
            </Row>
          )}
          {type === 'list' && dlg.mode === 'add' && (
            <Row>
              <Lbl>加到</Lbl>
              <Seg
                value={draft.head ? 'head' : 'tail'}
                onChange={(v) => setDraft({ ...draft, head: v === 'head' })}
                options={[
                  { value: 'tail', label: '末尾（RPUSH）' },
                  { value: 'head', label: '开头（LPUSH）' },
                ]}
              />
            </Row>
          )}
          <Lbl>{type === 'hash' || type === 'list' ? '值' : '成员'}</Lbl>
          <TextArea
            className="rk-val-edit"
            value={type === 'hash' ? draft.b : draft.a}
            onChange={(e) => setDraft(type === 'hash' ? { ...draft, b: e.target.value } : { ...draft, a: e.target.value })}
            aria-label="值"
          />
          {type === 'list' && dlg.mode === 'edit' && <Hint>按下标改。列表刚被别人动过的话下标可能已经对不上，改前先刷新。</Hint>}
        </>
      )}
    </Dlg>
  )
}

/* ------------------------- 写命令 ------------------------- */

type K = { b64: string }

async function saveItem(k: K, type: string, old: Item | null, next: ItemDraft): Promise<void> {
  const a = textToBytes(next.a)
  if (type === 'hash') {
    if (!next.a) throw new Error('字段名不能为空')
    await redisExec('HSET', k, a, textToBytes(next.b))
    // 改了字段名：先写新的再删旧的，中间失败的话至少不丢数据
    if (old && bytesToB64(old.a) !== bytesToB64(a)) await redisExec('HDEL', k, old.a)
    return
  }
  if (type === 'list') {
    if (old?.idx !== undefined) await redisExec('LSET', k, String(old.idx), a)
    else await redisExec(next.head ? 'LPUSH' : 'RPUSH', k, a)
    return
  }
  if (type === 'set') {
    await redisExec('SADD', k, a)
    if (old && bytesToB64(old.a) !== bytesToB64(a)) await redisExec('SREM', k, old.a)
    return
  }
  if (type === 'zset') {
    if (!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$|^[-+]?inf$/i.test(next.score.trim())) {
      throw new Error('分数要填数字')
    }
    await redisExec('ZADD', k, next.score.trim(), a)
    if (old && bytesToB64(old.a) !== bytesToB64(a)) await redisExec('ZREM', k, old.a)
  }
}

async function removeItem(k: K, type: string, it: Item): Promise<void> {
  if (type === 'hash') await redisExec('HDEL', k, it.a)
  else if (type === 'set') await redisExec('SREM', k, it.a)
  else if (type === 'zset') await redisExec('ZREM', k, it.a)
  else if (type === 'list' && it.idx !== undefined) {
    // 列表没有「按下标删」的命令：先把那一格改成一个不会撞的占位值，再按值删一个。
    // 直接 LREM 原值会删掉第一个同值的元素，不一定是用户点的那一条
    const mark = `__codenow_del_${Date.now()}_${Math.random().toString(36).slice(2)}__`
    await redisExec('LSET', k, String(it.idx), mark)
    await redisExec('LREM', k, '1', mark)
  }
}
