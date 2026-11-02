/**
 * 未连接时的页面：左边连接表单，右边「我的 Redis 连接」卡片。
 *
 * 规矩跟连库查询一致：存档只记地址，密码跨天免输走本机凭据；生产不记、不回填，
 * 而且连上就是只读。起了名字才存进我的连接，临时连一下的不留痕迹。
 * 单机 / 哨兵 / 集群免费，跳板机是专业版；跳板机密码和拉日志共用一份 ssh 凭据。
 */
import { useEffect, useState } from 'react'
import { App } from 'antd'
import { ApiOutlined } from '@ant-design/icons'
import { DB_ENV, canPersistPass, type DbEnv } from '../../types/dbconn'
import { credErr } from '../../lib/dbCred'
import { canRedisPro } from '../../lib/license'
import { sshCredGet, sshCredSet } from '../../lib/log/sshCred'
import { sshServerLabel } from '../../lib/log/sshServers'
import { isTauri, initStore } from '../../storage'
import {
  parseRedisConns,
  redisCredTarget,
  removeRedisConn,
  upsertRedisConn,
  REDIS_CONNS_KEY,
  type RedisConn,
  type RedisJumpAddr,
  type RedisKind,
} from '../../storage/redisConns'
import {
  redisConnect,
  redisCredDelete,
  redisCredGet,
  redisCredSet,
  type RedisConnectInfo,
} from '../../lib/redisIpc'
import { useLicenseStore } from '../../store/useLicenseStore'
import { useLogStore } from '../../store/useLogStore'
import { Band, Btn, Card, Cb, Col, cx, Fld, Hint, Lbl, Row, Seg, Sel, Spacer, Split, Stack, Tag } from '../../components/ui'

export interface RedisSession {
  name: string
  host: string
  port: string
  user: string
  db: number
  tls: boolean
  env: DbEnv
  kind: RedisKind
  jump: RedisJumpAddr | null
  info: RedisConnectInfo
}

const KIND_LABEL: Record<RedisKind, string> = { single: '单机', sentinel: '哨兵', cluster: '集群' }

const HOST_HINT: Record<RedisKind, string> = {
  single: '如 10.0.1.8',
  sentinel: '哨兵地址，多个用逗号分隔，如 10.0.1.8,10.0.1.9',
  cluster: '任一节点，多个用逗号分隔；其余节点自动发现',
}

const DEFAULT_PORT: Record<RedisKind, string> = { single: '6379', sentinel: '26379', cluster: '6379' }

const CLUSTER_NO_JUMP = '集群暂不支持走跳板机：每个节点都要单独转发。可以先按「单机」连其中一个节点'

export function RedisConnect({ onConnected }: { onConnected: (s: RedisSession) => void }) {
  const { message } = App.useApp()
  const isPro = useLicenseStore((s) => s.isPro)
  const sshServers = useLogStore((s) => s.sshServers)
  const [saved, setSaved] = useState<RedisConn[]>([])
  const [editingId, setEditingId] = useState<string | undefined>()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<RedisKind>('single')
  const [host, setHost] = useState('127.0.0.1')
  const [port, setPort] = useState('6379')
  const [master, setMaster] = useState('')
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [db, setDb] = useState('0')
  const [tls, setTls] = useState(false)
  const [env, setEnv] = useState<DbEnv>('test')
  const [keepPass, setKeepPass] = useState(true)
  const [useJump, setUseJump] = useState(false)
  const [jHost, setJHost] = useState('')
  const [jPort, setJPort] = useState('22')
  const [jUser, setJUser] = useState('')
  const [jPass, setJPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [bad, setBad] = useState<string[]>([])

  useEffect(() => {
    void initStore()
      .then((s) => s.getMetaBlob(REDIS_CONNS_KEY))
      .then((raw) => setSaved(parseRedisConns(raw)))
      .catch(() => setSaved([]))
  }, [])

  const persist = (next: RedisConn[]) => {
    setSaved(next)
    void initStore()
      .then((s) => s.saveMetaBlob(REDIS_CONNS_KEY, JSON.stringify(next)))
      .catch((e: unknown) => message.error(`保存连接失败，刷新后会丢：${credErr(e)}`))
  }

  /** 跳板机地址变了就去凭据库取记住的密码（拉日志时存过的也算） */
  const fillJump = (j: RedisJumpAddr) => {
    setJHost(j.host)
    setJPort(String(j.port))
    setJUser(j.user)
    setJPass('')
    void sshCredGet(j).then(setJPass, () => undefined)
  }

  const fillFrom = (c: RedisConn) => {
    setEditingId(c.id)
    setName(c.name)
    setKind(c.kind)
    setHost(c.host)
    setPort(c.port)
    setMaster(c.master)
    setUser(c.user)
    setDb(String(c.db))
    setTls(c.tls)
    setEnv(c.env)
    setPassword('')
    setErr('')
    setBad([])
    setUseJump(!!c.jump)
    if (c.jump) fillJump(c.jump)
    if (canPersistPass(c.env)) {
      void redisCredGet(redisCredTarget(c)).then(setPassword, () => undefined)
    }
  }

  const remove = (c: RedisConn) => {
    persist(removeRedisConn(saved, c.id))
    void redisCredDelete(redisCredTarget(c))
    if (editingId === c.id) setEditingId(undefined)
  }

  /** 跳板机是专业版：免费版勾了出升级卡，不勾上 */
  const needPro = () => {
    if (canRedisPro(isPro)) return false
    useLicenseStore.getState().openUpgrade()
    return true
  }

  const switchKind = (k: RedisKind) => {
    // 端口还是上一种方式的默认值就跟着换；用户改过的不动
    if (port === DEFAULT_PORT[kind]) setPort(DEFAULT_PORT[k])
    if (k === 'cluster') {
      setDb('0')
      setUseJump(false)
    }
    setKind(k)
  }

  const connect = async () => {
    const jumpOn = useJump && kind !== 'cluster'
    const miss = [
      !host.trim() && 'host',
      !/^\d+$/.test(port.trim()) && 'port',
      !/^\d+$/.test(db.trim()) && 'db',
      kind === 'sentinel' && !master.trim() && 'master',
      jumpOn && !jHost.trim() && 'jhost',
      jumpOn && !/^\d+$/.test(jPort.trim()) && 'jport',
    ].filter(Boolean) as string[]
    setBad(miss)
    if (miss.length) {
      setErr(
        miss.includes('master')
          ? '哨兵要填主节点名（哨兵配置里 sentinel monitor 后面那个，常见 mymaster）'
          : miss.some((m) => m.startsWith('j'))
            ? '跳板机主机不能为空，端口填数字'
            : '主机不能为空，端口和库号填数字',
      )
      return
    }
    if (jumpOn && needPro()) return
    setBusy(true)
    setErr('')
    const addr = { host: host.trim(), port: port.trim(), user: user.trim() }
    const jumpAddr: RedisJumpAddr | null = jumpOn ? { host: jHost.trim(), port: Number(jPort), user: jUser.trim() } : null
    try {
      const info = await redisConnect({
        ...addr,
        password,
        db: Number(db),
        tls,
        // 生产连上就是只读，要写得在工作台里手输名字确认（断开即失效）
        readonly: env === 'prod',
        kind,
        master: master.trim(),
        jump: jumpAddr && { ...jumpAddr, password: jPass },
      })
      try {
        if (keepPass && password && canPersistPass(env)) await redisCredSet(redisCredTarget(addr), password)
        else await redisCredDelete(redisCredTarget(addr))
        if (jumpAddr && jPass && keepPass && canPersistPass(env)) await sshCredSet(jumpAddr, jPass)
      } catch (e) {
        message.warning(`连上了，但密码没记住：${credErr(e)}`)
      }
      if (name.trim()) {
        persist(upsertRedisConn(saved, { id: editingId, name, ...addr, db: Number(db), tls, env, kind, master, jump: jumpAddr }))
      }
      onConnected({ name: name.trim(), ...addr, db: Number(db), tls, env, kind, jump: jumpAddr, info })
    } catch (e) {
      setErr(credErr(e))
    } finally {
      setBusy(false)
    }
  }

  const browserHint = '浏览器模式连不了 Redis，请使用桌面版。'
  const proTag = canRedisPro(isPro) ? '' : ' · 专业版'

  return (
    <div className="dbq-setup">
      {err && (
        <Band tone="err" title="连接失败">
          {err}
        </Band>
      )}
      <Split even>
        <Col>
          <Card hero title="连接信息" who={`${KIND_LABEL[kind]} Redis`}>
            <Stack>
              <Row>
                <Lbl>名称</Lbl>
                <Fld className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="可空；起了名字就存进右边的我的连接" aria-label="名称" />
              </Row>
              <Row>
                <Lbl>连接方式</Lbl>
                <Seg
                  value={kind}
                  onChange={switchKind}
                  options={[
                    { value: 'single', label: '单机', title: '直连一台 Redis（主从里的主节点也算）' },
                    { value: 'sentinel', label: '哨兵', title: `填哨兵地址和主节点名，自动找当前主节点；主从切换后重连会重新找` },
                    { value: 'cluster', label: '集群', title: `填任一节点，自动发现全部主节点；列键逐个节点扫` },
                  ]}
                />
              </Row>
              <Row>
                <Lbl>{kind === 'sentinel' ? '哨兵' : '主机'}</Lbl>
                <Fld className="grow" value={host} onChange={(e) => setHost(e.target.value)} placeholder={HOST_HINT[kind]} bad={bad.includes('host')} aria-label="主机" />
                <Lbl>端口</Lbl>
                <Fld className="fix" value={port} onChange={(e) => setPort(e.target.value)} placeholder={DEFAULT_PORT[kind]} bad={bad.includes('port')} aria-label="端口" />
              </Row>
              {kind === 'sentinel' && (
                <Row>
                  <Lbl>主节点名</Lbl>
                  <Fld className="grow" value={master} onChange={(e) => setMaster(e.target.value)} placeholder="sentinel monitor 后面那个名字，常见 mymaster" bad={bad.includes('master')} aria-label="主节点名" />
                </Row>
              )}
              <Row>
                <Lbl>用户名</Lbl>
                <Fld className="grow" value={user} onChange={(e) => setUser(e.target.value)} placeholder="可空；Redis 6 以上配了 ACL 用户才填" aria-label="用户名" />
              </Row>
              <Row>
                <Lbl>密码</Lbl>
                <Fld
                  className="grow"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={env === 'prod' ? '生产连接每次现输' : kind === 'sentinel' ? '数据节点的密码；哨兵要密码时也用它' : '没设密码就留空'}
                  aria-label="密码"
                />
              </Row>
              <Row>
                <Lbl>库号</Lbl>
                <Fld
                  className="fix"
                  value={db}
                  onChange={(e) => setDb(e.target.value)}
                  placeholder="0"
                  bad={bad.includes('db')}
                  disabled={kind === 'cluster'}
                  title={kind === 'cluster' ? '集群只有 0 号库' : undefined}
                  aria-label="库号"
                />
                <Cb checked={tls} onChange={setTls} title="云上托管的 Redis 常要求 TLS；自签证书也放行">
                  TLS 加密连接
                </Cb>
              </Row>
              <Row>
                <Lbl>环境</Lbl>
                <Seg
                  value={env}
                  onChange={setEnv}
                  options={(['local', 'test', 'prod'] as const).map((e) => ({
                    value: e,
                    label: DB_ENV[e].label,
                    title: e === 'prod' ? '生产：连上默认只读，密码不记住' : undefined,
                  }))}
                />
              </Row>
              <Row>
                <Cb
                  checked={useJump && kind !== 'cluster'}
                  disabled={kind === 'cluster'}
                  title={kind === 'cluster' ? CLUSTER_NO_JUMP : `Redis 在内网、只能从某台服务器连时用：用系统 ssh 做端口转发${proTag}`}
                  onChange={(on) => {
                    if (on && needPro()) return
                    setUseJump(on)
                  }}
                >
                  走跳板机（SSH）
                </Cb>
                {kind === 'cluster' && <Hint>{CLUSTER_NO_JUMP}</Hint>}
              </Row>
              {useJump && kind !== 'cluster' && (
                <Stack className="rk-jump">
                  {sshServers.length > 0 && (
                    <Row>
                      <Lbl>常用服务器</Lbl>
                      <Sel
                        className="grow"
                        value=""
                        onChange={(id) => {
                          const s = sshServers.find((x) => x.id === id)
                          if (s) fillJump(s)
                        }}
                        options={[{ value: '', label: '从拉日志存过的服务器里选…' }, ...sshServers.map((s) => ({ value: s.id, label: sshServerLabel(s) }))]}
                        aria-label="常用服务器"
                      />
                    </Row>
                  )}
                  <Row>
                    <Lbl>跳板机</Lbl>
                    <Fld className="grow" value={jHost} onChange={(e) => setJHost(e.target.value)} placeholder="ssh 能登的服务器，如 10.0.1.20" bad={bad.includes('jhost')} aria-label="跳板机主机" />
                    <Lbl>端口</Lbl>
                    <Fld className="fix" value={jPort} onChange={(e) => setJPort(e.target.value)} placeholder="22" bad={bad.includes('jport')} aria-label="跳板机端口" />
                  </Row>
                  <Row>
                    <Lbl>登录用户</Lbl>
                    <Fld className="grow" value={jUser} onChange={(e) => setJUser(e.target.value)} placeholder="如 root" aria-label="跳板机用户" />
                  </Row>
                  <Row>
                    <Lbl>登录密码</Lbl>
                    <Fld
                      className="grow"
                      type="password"
                      value={jPass}
                      onChange={(e) => setJPass(e.target.value)}
                      placeholder="用密钥登录就留空（~/.ssh 里的密钥和 config 照样生效）"
                      aria-label="跳板机密码"
                    />
                  </Row>
                  <Hint>上面的「{kind === 'sentinel' ? '哨兵' : '主机'}」填从跳板机上看到的 Redis 地址（内网 IP，或装在跳板机本机就填 127.0.0.1）。</Hint>
                </Stack>
              )}
              <Row>
                <Cb
                  checked={keepPass && canPersistPass(env)}
                  disabled={!isTauri() || !canPersistPass(env)}
                  title={!canPersistPass(env) ? '生产连接不记住密码' : '写进本机（当前 Windows 用户才能解开），不进连接存档'}
                  onChange={setKeepPass}
                >
                  记住密码（跨天）
                </Cb>
                {env === 'prod' && <Hint>生产连上默认只读，密码每次现输。</Hint>}
              </Row>
              <Row>
                {!isTauri() && <Hint>{browserHint}</Hint>}
                <Spacer />
                <Btn variant="primary" disabled={!isTauri() || busy} title={!isTauri() ? browserHint : undefined} onClick={() => void connect()}>
                  {busy ? (useJump && kind !== 'cluster' ? '正在登录跳板机…' : '正在连接…') : (<><ApiOutlined aria-hidden="true" /> 连接</>)}
                </Btn>
              </Row>
            </Stack>
          </Card>
        </Col>
        <Col>
          <Card title="我的 Redis 连接" who="点了回填 · 记住的密码会带上">
            {saved.length === 0 ? (
              <Hint>还没有。在左边填个名称再连，连上就存到这里，下次点一下就回填。</Hint>
            ) : (
              <Stack>
                <div className="g-two">
                  {saved.map((c) => {
                    const tone = DB_ENV[c.env]
                    return (
                      <button type="button" key={c.id} className={cx('conncard', editingId === c.id && 'on')} onClick={() => fillFrom(c)}>
                        <div className="fr">
                          <span className="nm">{c.name}</span>
                          <Tag tone={tone.tone}>{tone.label}</Tag>
                        </div>
                        <div className="addr">{`${c.host}:${c.port}${c.kind === 'cluster' ? '' : ` · 库 ${c.db}`}`}</div>
                        <div className="who">
                          <Tag tone="hi">{c.kind === 'single' ? 'Redis' : KIND_LABEL[c.kind]}</Tag>
                          <span>{c.kind === 'sentinel' ? c.master : c.user || '无用户名'}</span>
                          {c.tls && <span>TLS</span>}
                          {c.jump && <span title={`经 ${c.jump.user}@${c.jump.host}:${c.jump.port}`}>跳板机</span>}
                          <Spacer />
                          <span
                            role="button"
                            tabIndex={0}
                            className="rk-del"
                            title="删掉这条连接（记住的 Redis 密码一起删；跳板机密码和拉日志共用，不动）"
                            onClick={(e) => {
                              e.stopPropagation()
                              remove(c)
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.stopPropagation()
                                remove(c)
                              }
                            }}
                          >
                            删除
                          </span>
                        </div>
                      </button>
                    )
                  })}
                </div>
                <Hint>点一下回填地址。测试 / 本地若勾过记住，会带上密码。生产每次现输。</Hint>
              </Stack>
            )}
          </Card>
        </Col>
      </Split>
    </div>
  )
}
