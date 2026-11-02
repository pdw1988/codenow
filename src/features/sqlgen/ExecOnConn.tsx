/**
 * 生成结果旁「在当前连接执行」（PRD 19.5）。
 * INSERT / UPDATE / DELETE 确认后走写命令。SELECT 送到连库查询跑，不走写命令。
 * 没连上弹出选连接；方言对不上、预编译、XML：发灰并说出为什么。
 */
import { useState } from 'react'
import { App } from 'antd'
import type { DbConn } from '../../types/dbconn'
import type { Dialect } from '../../types/schema'
import { liveDialect } from '../../lib/dbDialect'
import { lastConnForKind } from '../../lib/dbLive'
import { extractRunnableSelect } from '../../lib/sqlReadonly'
import { execDisabledReason, isNeedSession, planExec, type ExecPlan } from '../../lib/sqlExec'
import { formatSql } from '../../lib/sqlgen/sqlFormat'
import { isTauri } from '../../storage'
import { useDbPassStore } from '../../store/useDbPassStore'
import { useUiStore } from '../../store/useUiStore'
import { PickConnDlg } from '../dbconns/PickConnDlg'
import { Band, Btn, Code, Dlg, Hint } from '../../components/ui'

interface Props {
  sql: string
  dialect: Dialect
  executable?: boolean
  output?: 'sql' | 'mybatis'
  table?: string
}

export function ExecOnConn({ sql, dialect, executable = true, output = 'sql', table }: Props) {
  const { message } = App.useApp()
  const session = useUiStore((s) => s.dbSession)
  const jumpToDbQuery = useUiStore((s) => s.jumpToDbQuery)
  const peekPass = useDbPassStore((s) => s.peek)
  const querySql = extractRunnableSelect(sql)
  const reason = execDisabledReason({
    sql,
    pageDialect: dialect,
    session,
    isTauri: isTauri(),
    output,
    executable,
  })
  const [dlg, setDlg] = useState<'prod' | 'sql' | null>(null)
  const [pick, setPick] = useState(false)
  const [plan, setPlan] = useState<ExecPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const needPick = isNeedSession(reason)
  const blocked = Boolean(reason) && !needPick

  const sendQuery = (conn?: DbConn) => {
    if (!querySql) return
    const live = conn ?? lastConnForKind(dialect)
    jumpToDbQuery({
      conn: live ?? undefined,
      password: live ? peekPass(live) || undefined : undefined,
      sql: querySql,
      table,
    })
  }

  const startConfirm = (live = useUiStore.getState().dbSession) => {
    setErr(null)
    try {
      const next = planExec(sql)
      setPlan(next)
      setDlg(live?.env === 'prod' ? 'prod' : 'sql')
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    }
  }

  const open = () => {
    if (blocked) {
      message.warning(reason)
      return
    }
    if (!session || needPick) {
      setPick(true)
      return
    }
    if (querySql) {
      sendQuery()
      return
    }
    startConfirm(session)
  }

  const run = async () => {
    if (!plan || !session) return
    const spec = liveDialect(session.kind)
    if (!spec) {
      setErr('当前连接没有执行入口')
      setDlg('sql')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const { affected, ran } = await spec.execSql(plan.statements)
      setDlg(null)
      setPlan(null)
      message.success(`已执行 ${ran} 条，影响 ${affected} 行`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setDlg('sql')
    } finally {
      setBusy(false)
    }
  }

  const preview = plan
    ? plan.statements.length === 1
      ? formatSql(plan.statements[0])
      : `${formatSql(plan.statements[0])}\n\n-- …其余 ${plan.statements.length - 1} 条确认后依次执行`
    : ''
  const shown = preview.length > 4000 ? `${preview.slice(0, 4000)}\n-- …已截断预览` : preview

  return (
    <>
      <Btn
        variant={blocked ? 'ghost' : 'primary'}
        blocked={blocked}
        title={
          needPick
            ? '还没连库，点了选一个连接'
            : reason ??
              (querySql ? '送到连库查询运行这条 SELECT' : '确认后在当前连接执行这些语句')
        }
        onClick={open}
      >
        {querySql ? '在当前连接查询' : '在当前连接执行'}
      </Btn>

      <PickConnDlg
        open={pick}
        dialect={dialect}
        handshake={!querySql}
        onClose={() => setPick(false)}
        onReady={(conn) => {
          setPick(false)
          if (querySql) sendQuery(conn)
          else startConfirm()
        }}
      />

      <Dlg
        title="这是生产连接"
        open={dlg === 'prod'}
        onClose={() => { setDlg(null); setPlan(null) }}
        width={520}
        actions={
          <>
            <Btn onClick={() => { setDlg(null); setPlan(null) }}>取消</Btn>
            <Btn variant="primary" danger onClick={() => setDlg('sql')}>
              继续
            </Btn>
          </>
        }
      >
        <span>
          当前连接标了<strong>生产</strong>。账号没写权限会失败，失败会把库的报错原文甩出来。
          仍要执行这 {plan?.statements.length ?? 0} 条语句？
        </span>
      </Dlg>

      <Dlg
        title={plan ? `执行 ${plan.statements.length} 条` : '在当前连接执行'}
        open={dlg === 'sql'}
        onClose={() => { if (!busy) { setDlg(null); setPlan(null) } }}
        width={720}
        actions={
          <>
            <Btn disabled={busy} onClick={() => { setDlg(null); setPlan(null) }}>取消</Btn>
            <Btn variant="primary" disabled={busy || !plan} onClick={() => void run()}>
              {busy ? '执行中…' : session?.env === 'prod' ? '仍要执行' : '确定执行'}
            </Btn>
          </>
        }
      >
        {session?.env === 'prod' && (
          <Band tone="warn" title="生产">
            再确认一次将要执行的 SQL。
          </Band>
        )}
        {err && (
          <Band tone="err" title="执行失败">
            {err}
          </Band>
        )}
        <Hint>中途失败会停下，前面的已经提交。</Hint>
        {plan && <Code code={shown} lang="sql" name="将执行" size="sm" />}
      </Dlg>
    </>
  )
}
