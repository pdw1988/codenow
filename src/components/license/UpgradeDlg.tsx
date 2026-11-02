/**
 * 全应用就这一张升级卡。各页闸门只负责 openUpgrade，文案不各自发明。
 */
import { useState } from 'react'
import { App } from 'antd'
import { COPY, LICENSE_ENABLED } from '../../lib/license'
import { useLicenseStore } from '../../store/useLicenseStore'
import { Band, Btn, Dlg, Fld, Hint, Lbl, Row, Stack, Tbl, type TblCol } from '../ui'

type RowT = { k: string; item: string; free: string; pro: string }

const ROWS: RowT[] = [
  { k: 'ac', item: '码上测：本接口全部用例 / 本 Controller / 全自动回归', free: '单接口发送', pro: '不限' },
  { k: 'ai', item: '复制给 AI 用的接口说明', free: '—', pro: '✓' },
  { k: 'pg', item: '页面测试', free: '—', pro: '✓' },
  { k: 'lg', item: '日志查看：连服务器拉日志、多份按时间交错', free: '—', pro: '✓' },
  { k: 'ssh', item: 'SSH 终端与文件互传', free: '—', pro: '✓' },
  { k: 'rd', item: 'Redis：Java 序列化解析、走跳板机', free: '单机 / 哨兵 / 集群', pro: '✓' },
]

const COLS: Array<TblCol<RowT>> = [
  { key: 'item', title: '', render: (r) => r.item },
  { key: 'free', title: '免费', width: 90, render: (r) => r.free },
  { key: 'pro', title: '专业', width: 140, render: (r) => r.pro },
]

export function UpgradeDlg() {
  const { message } = App.useApp()
  const open = useLicenseStore((s) => s.upgradeOpen)
  const close = useLicenseStore((s) => s.closeUpgrade)
  const activate = useLicenseStore((s) => s.activate)
  const err = useLicenseStore((s) => s.activateErr)
  const license = useLicenseStore((s) => s.license)
  const trial = useLicenseStore((s) => s.trial)
  const startTrial = useLicenseStore((s) => s.startTrial)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  if (!LICENSE_ENABLED) return null

  const bought = !!license
  // trial 为 null：浏览器里或查询失败，不给试用按钮
  const canTry = !bought && !!trial && !trial.started
  const trialLeft = !bought && trial?.active ? trial.remaining_days : null
  const trialOver = !bought && !!trial?.started && !trial.active

  const tryNow = async () => {
    setBusy(true)
    const ok = await startTrial()
    setBusy(false)
    if (ok) {
      close()
      message.success(`已开始 ${trial?.total_days ?? 7} 天试用，专业版功能全部放开`)
    } else {
      message.error('试用没开成，可以重开软件再试')
    }
  }

  const submit = async () => {
    const trimmed = code.trim()
    if (!trimmed) return
    setBusy(true)
    const ok = await activate(trimmed)
    setBusy(false)
    if (ok) {
      setCode('')
      message.success('已激活专业版')
    }
  }

  return (
    <Dlg
      title="码上 CodeNow 专业版"
      open={open}
      onClose={close}
      width={640}
      actions={
        <>
          <Btn onClick={close}>{bought ? '关闭' : '稍后再说'}</Btn>
          {!bought && (
            <Btn variant={canTry ? undefined : 'primary'} disabled={busy || !code.trim()} onClick={() => void submit()}>
              {busy ? '校验中…' : '激活许可码'}
            </Btn>
          )}
          {canTry && (
            <Btn variant="primary" disabled={busy} onClick={() => void tryNow()}>
              免费试用 {trial.total_days} 天
            </Btn>
          )}
        </>
      }
    >
      <Stack gap={12}>
        <Hint>查表、测接口、看日志、上服务器，一个窗口搞定。本地运行，不上传。</Hint>
        <Tbl cols={COLS} rows={ROWS} rowKey={(r) => r.k} />
        {canTry && (
          <Band tone="ok" title={`不用加微信，点右下角就能试用 ${trial.total_days} 天`}>
            试用期间上面所有专业功能全部放开；到期自动回免费版，导过的表、收藏都不丢。每台电脑一次。
          </Band>
        )}
        {trialLeft !== null && <Band tone="ok">{COPY.statusTrial(trialLeft)}</Band>}
        {trialOver && (
          <Band tone="warn">
            {trial?.clock_tampered ? '系统时间被往回调过，试用已结束。' : '试用已结束。'}导过的表、收藏都还在，免费功能照常用。
          </Band>
        )}
        <Band tone="ok">{COPY.payHint}</Band>
        {bought ? (
          <Band tone="ok" title="本机已是专业版">
            批量回归、多页巡检、连服务器拉日志、SSH 终端全放开。
          </Band>
        ) : (
          <>
            <Lbl>许可码</Lbl>
            <Row>
              <Fld
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="粘贴微信回复的许可码"
                aria-label="许可码"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit()
                }}
              />
            </Row>
            {err && <Band tone="err">{err}</Band>}
          </>
        )}
      </Stack>
    </Dlg>
  )
}
