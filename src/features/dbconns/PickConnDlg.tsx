/**
 * 没连库时「在当前连接执行」弹出的选连接。
 *
 * 密码先看这次进程，再问本机凭据（生产不回填）。方言对不上挡住，
 * 不自动改生成页方言——悄悄换引号会把已经生成的 SQL 改错。
 */
import { useState } from 'react'
import { App } from 'antd'
import type { Dialect } from '../../types/schema'
import {
  DB_ENV,
  addrKey,
  canPersistPass,
  connDisplayName,
  dbKindOf,
  isNamedConn,
  type DbConn,
} from '../../types/dbconn'
import { namedConns } from '../../storage/dbconn'
import { liveDialect } from '../../lib/dbDialect'
import { DIALECTS } from '../../lib/sqlgen/dialect'
import { credErr, loadPass, persistPass } from '../../lib/dbCred'
import { openLiveSession, pickConnBlocked } from '../../lib/dbLive'
import { useDbConnStore } from '../../store/useDbConnStore'
import { useDbPassStore } from '../../store/useDbPassStore'
import { useUiStore } from '../../store/useUiStore'
import { Band, Btn, Chip, Chips, Dlg, EmptyBox, Fld, Hint, Lbl, Row, Spacer, Stack, Tag } from '../../components/ui'

interface Props {
  open: boolean
  dialect: Dialect
  onClose: () => void
  /** 握手成功（或查询这条路只记住密码），调用方接着走原来的确认 / 跳连库 */
  onReady: (conn: DbConn) => void
  /**
   * 写路径要先握手（池子留给确认框执行）。
   * SELECT 送到连库查询：这里不连，让连库页自己连上再跑，避免连两次。
   */
  handshake?: boolean
}

function defaultConn(items: DbConn[], dialect: Dialect): DbConn | null {
  const named = namedConns(items)
  const recent = items.filter((c) => !isNamedConn(c))
  const all = [...named, ...recent]
  return all.find((c) => dbKindOf(c.kind) === dialect) ?? all[0] ?? null
}

function ConnChips({
  items,
  sel,
  onPick,
}: {
  items: DbConn[]
  sel: DbConn | null
  onPick: (c: DbConn) => void
}) {
  return (
    <Chips>
      {items.map((c) => {
        const on = sel !== null && addrKey(sel) === addrKey(c)
        const kind = dbKindOf(c.kind)
        return (
          <Chip
            key={c.id ?? addrKey(c)}
            className={on ? 'on' : undefined}
            badge={isNamedConn(c) ? c.name : DIALECTS[kind].label}
            tone={c.env === 'prod' ? 'warn' : undefined}
            onClick={() => onPick(c)}
          >
            {`${c.host}:${c.port}/${c.db}`}
          </Chip>
        )
      })}
    </Chips>
  )
}

export function PickConnDlg({ open, dialect, onClose, onReady, handshake = true }: Props) {
  const { message } = App.useApp()
  const items = useDbConnStore((s) => s.items)
  const peek = useDbPassStore((s) => s.peek)
  const setActiveTab = useUiStore((s) => s.setActiveTab)
  const named = namedConns(items)
  const recent = items.filter((c) => !isNamedConn(c))

  const [sel, setSel] = useState<DbConn | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [seen, setSeen] = useState(false)
  if (open !== seen) {
    setSeen(open)
    if (open) {
      const next = defaultConn(items, dialect)
      setSel(next)
      setPassword(next ? peek(next) : '')
      setErr(null)
      setBusy(false)
      if (next && !peek(next) && canPersistPass(next.env)) {
        void loadPass(next, next.env)
          .then((p) => {
            if (p) setPassword(p)
          })
          .catch((e) => {
            message.warning(`读不出记住的密码：${credErr(e)}`)
          })
      }
    }
  }

  const mismatch = sel ? pickConnBlocked(dialect, sel) : null
  const remembered = Boolean(sel && peek(sel))
  const spec = sel ? liveDialect(dbKindOf(sel.kind)) : undefined

  const pick = (c: DbConn) => {
    setSel(c)
    setPassword(peek(c))
    setErr(null)
    if (!peek(c) && canPersistPass(c.env)) {
      void loadPass(c, c.env)
        .then((p) => {
          if (p) setPassword(p)
        })
        .catch((e) => {
          message.warning(`读不出记住的密码：${credErr(e)}`)
        })
    }
  }

  const goQuery = () => {
    onClose()
    setActiveTab('dbquery')
  }

  const run = async () => {
    if (!sel || mismatch || busy) return
    if (!password.trim()) {
      setErr('密码还是空的')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      if (handshake) await openLiveSession(sel, password)
      else useDbPassStore.getState().remember(sel, password)
      try {
        await persistPass(sel, password, canPersistPass(sel.env), sel.env)
      } catch (e) {
        message.warning(`已连上，但没记住密码：${credErr(e)}`)
      }
      onReady(sel)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dlg
      title="选一个连接"
      open={open}
      onClose={() => { if (!busy) onClose() }}
      width={560}
      layer
      actions={
        <>
          {/* 分支入口靠左，取消 / 主操作靠右 */}
          <Btn disabled={busy} onClick={goQuery}>
            去连库查询
          </Btn>
          <Spacer />
          <Btn disabled={busy} onClick={onClose}>取消</Btn>
          <Btn
            variant="primary"
            disabled={busy || !sel || Boolean(mismatch)}
            title={
              mismatch ??
              (sel
                ? handshake
                  ? '连上之后接着确认执行'
                  : '连上之后到连库查询跑这条 SELECT'
                : '还没有可选手')
            }
            onClick={() => void run()}
          >
            {busy ? '连接中…' : handshake ? '连接并继续' : '连接并查询'}
          </Btn>
        </>
      }
    >
      <Stack>
        {named.length === 0 && recent.length === 0 ? (
          <EmptyBox>
            还没有收藏或最近连接。到「我的连接」起名，或去「连库查询」连一次。
          </EmptyBox>
        ) : (
          <>
            {named.length > 0 && (
              <>
                <Lbl>我的连接</Lbl>
                <ConnChips items={named} sel={sel} onPick={pick} />
              </>
            )}
            {recent.length > 0 && (
              <>
                <Lbl>最近连过</Lbl>
                <ConnChips items={recent} sel={sel} onPick={pick} />
              </>
            )}
          </>
        )}
        {sel && (
          <>
            <Row>
              <Hint>
                {connDisplayName(sel)} · {DIALECTS[dbKindOf(sel.kind)].label}
                {sel.env ? ` · ${DB_ENV[sel.env].label}` : ''}
              </Hint>
              {sel.env && <Tag tone={DB_ENV[sel.env].tone}>{DB_ENV[sel.env].label}</Tag>}
            </Row>
            {mismatch && (
              <Band tone="err" title="方言对不上">
                {mismatch}
              </Band>
            )}
            <Row>
              <Lbl>密码</Lbl>
              <Fld
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={spec ? `${spec.label} 密码` : '密码'}
                aria-label="连接密码"
                className="grow"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void run()
                }}
              />
            </Row>
            <Hint>
              {sel.env === 'prod'
                ? '生产连接每次现输密码，不写本机。'
                : remembered
                  ? '这次打开里连过，密码已带上。'
                  : '测试/本地可记住密码，不进「我的连接」。'}
            </Hint>
          </>
        )}
        {err && (
          <Band tone="err" title="连接失败">
            {err}
          </Band>
        )}
      </Stack>
    </Dlg>
  )
}
