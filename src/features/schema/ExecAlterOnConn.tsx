/**
 * 编辑表结构增量 DDL 旁「在当前连接执行」（PRD 19.8）。
 * 索引落地清单也复用它：建索引走同一条闸门、同一个确认框，不新开写路径。
 * 没连上、方言对不上、没有可执行语句：没连库时点了选连接；其它原因发灰并说出为什么。
 */
import { useEffect, useState } from 'react'
import { App } from 'antd'
import type { Dialect } from '../../types/schema'
import { liveDialect } from '../../lib/dbDialect'
import { alterDisabledReason, planAlter, type AlterPlan } from '../../lib/sqlAlter'
import { isNeedSession } from '../../lib/sqlExec'
import { formatSql } from '../../lib/sqlgen/sqlFormat'
import { isTauri } from '../../storage'
import { useUiStore } from '../../store/useUiStore'
import { PickConnDlg } from '../dbconns/PickConnDlg'
import { Band, Btn, Code, Dlg, Hint } from '../../components/ui'

interface Props {
  sql: string
  dialect: Dialect
  invalid?: string
  /** 库上跑完之后：重拉字典、写入缓存。返回 false 表示没写入缓存 */
  onApplied?: (ran: number) => Promise<boolean | void>
  /** 缓存写完后关掉编辑弹窗。粘贴执行没有弹窗可关 */
  onDone?: () => void
  /**
   * 连库页查询框用：挂载即起确认链、不渲染自己的按钮——2026-09-24 起
   * 查询框什么都收，写语句 / DDL 点「运行」就整份交到这里确认后执行。
   * 取消 / 拦下 / 报错都会调 onDone 让父组件把这次执行撤掉。
   */
  autoStart?: boolean
}

export function ExecAlterOnConn({ sql, dialect, invalid, onApplied, onDone, autoStart }: Props) {
  const { message } = App.useApp()
  const session = useUiStore((s) => s.dbSession)
  const reason = alterDisabledReason({
    sql,
    pageDialect: dialect,
    session,
    isTauri: isTauri(),
    invalid,
  })
  const [dlg, setDlg] = useState<'warn' | 'sql' | null>(null)
  const [pick, setPick] = useState(false)
  const [plan, setPlan] = useState<AlterPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const prod = session?.env === 'prod'
  const drops = Boolean(plan?.drops)
  /** 手写 UPDATE / DELETE / INSERT 的条数：行数据会改会删，确认要点名 */
  const dml = plan?.dml ?? 0
  /** CTAS 的条数：会按 SELECT 的结果建新表 */
  const ctas = plan?.ctas ?? 0
  const needPick = isNeedSession(reason)
  const blocked = Boolean(reason) && !needPick

  const startConfirm = (live = useUiStore.getState().dbSession) => {
    setErr(null)
    try {
      const next = planAlter(sql)
      setPlan(next)
      setDlg(live?.env === 'prod' || next.drops || next.dml > 0 ? 'warn' : 'sql')
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
      if (autoStart) onDone?.()
    }
  }

  /** 收掉所有确认弹窗。autoStart 的这次执行到此为止，让父组件撤掉挂载 */
  const cancel = () => {
    setDlg(null)
    setPlan(null)
    if (autoStart) onDone?.()
  }

  const open = () => {
    if (blocked) {
      message.warning(reason)
      if (autoStart) onDone?.()
      return
    }
    if (!session || needPick) {
      setPick(true)
      return
    }
    startConfirm(session)
  }

  useEffect(() => {
    if (autoStart) open()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载即起确认链，只此一次
  }, [])

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
      const { ran } = await spec.execDdl(plan.statements)
      /* 先关确认框、立刻 toast。缓存重拉可能慢，等它再提示会像「点了没反应」。 */
      setDlg(null)
      setPlan(null)
      message.success(`已在库上执行 ${ran} 条`, 4)
      if (onApplied) {
        try {
          const applied = await onApplied(ran)
          if (applied === false) {
            message.info('库已改。这张表不在缓存里，没有写入字段表', 4)
          }
        } catch (e) {
          message.warning(`库已改，写入缓存失败：${e instanceof Error ? e.message : String(e)}`, 5)
        }
      }
      onDone?.()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setDlg('sql')
    } finally {
      setBusy(false)
    }
  }

  const preview = plan ? plan.statements.map((s) => formatSql(s)).join('\n\n') : ''
  const shown = preview.length > 4000 ? `${preview.slice(0, 4000)}\n-- …已截断预览` : preview
  const warnParts = [
    prod ? '生产连接' : null,
    drops ? '将删除列' : null,
    dml > 0 ? '将改删行' : null,
  ].filter(Boolean)
  const warnTitle = warnParts.join(' · ') || '确认执行'
  const danger = drops || dml > 0

  return (
    <>
      {/* autoStart 由父组件的「运行」触发，自己不再摆一个入口按钮 */}
      {!autoStart && (
        <Btn
          variant={blocked ? 'ghost' : 'primary'}
          blocked={blocked}
          title={needPick ? '还没连库，点了选一个连接' : reason ?? '确认后在当前连接执行这些语句'}
          onClick={open}
        >
          在当前连接执行
        </Btn>
      )}

      <PickConnDlg
        open={pick}
        dialect={dialect}
        onClose={() => setPick(false)}
        onReady={() => {
          setPick(false)
          startConfirm()
        }}
      />

      <Dlg
        title={warnTitle}
        open={dlg === 'warn'}
        onClose={cancel}
        width={520}
        layer
        actions={
          <>
            <Btn onClick={cancel}>取消</Btn>
            <Btn variant="primary" danger onClick={() => setDlg('sql')}>
              继续
            </Btn>
          </>
        }
      >
        <span>
          {prod && (
            <>
              当前连接标了<strong>生产</strong>。账号没写权限会失败，失败会把库的报错原文甩出来。
            </>
          )}
          {drops && (
            <>
              {prod ? ' ' : ''}
              这些语句含<strong>删列</strong>。列里的数据一起没，多数库不能撤回。
            </>
          )}
          {dml > 0 && (
            <>
              {prod || drops ? ' ' : ''}
              这些语句会<strong>改 / 删行数据</strong>，影响多少行由 WHERE 决定；跑完立即提交，不会替你回滚。
            </>
          )}
          {ctas > 0 && (
            <>
              {prod || drops || dml > 0 ? ' ' : ''}
              会按 SELECT 的结果<strong>建新表</strong>。
            </>
          )}
          {' '}仍要执行这 {plan?.statements.length ?? 0} 条语句？
        </span>
      </Dlg>

      <Dlg
        title={plan ? `执行 ${plan.statements.length} 条` : '在当前连接执行'}
        open={dlg === 'sql'}
        onClose={() => { if (!busy) cancel() }}
        width={720}
        layer
        actions={
          <>
            <Btn disabled={busy} onClick={cancel}>取消</Btn>
            <Btn variant="primary" danger={danger} disabled={busy || !plan} onClick={() => void run()}>
              {busy ? '执行中…' : drops ? '确定删除列' : dml > 0 ? '确定改删' : prod ? '仍要执行' : '确定执行'}
            </Btn>
          </>
        }
      >
        {prod && (
          <Band tone="warn" title="生产">
            再确认一次将要执行的 SQL。
          </Band>
        )}
        {drops && (
          <Band tone="err" title="删列">
            库上会 DROP 这些列，列里的数据回不来。下面是将要执行的全部语句，不要只看第一条。
          </Band>
        )}
        {err && (
          <Band tone="err" title="执行失败">
            {err}
          </Band>
        )}
        <Hint>中途失败会停下，前面已执行的不会回滚——每条语句跑完都立即提交（含 UPDATE / DELETE）。</Hint>
        {plan && <Code code={shown} lang="sql" name="将执行" size="sm" />}
      </Dlg>
    </>
  )
}
