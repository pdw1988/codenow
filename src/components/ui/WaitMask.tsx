/**
 * 全页等待遮罩。加载一万行时 IPC + 画表会停好几秒，只改按钮文字看不见。
 * 不能点遮罩关掉——关掉等于以为没在跑，其实主线程还在灌数据。
 */
import { useEffect, useState } from 'react'

interface Props {
  open: boolean
  title: string
  text: string
}

export function WaitMask({ open, title, text }: Props) {
  const [sec, setSec] = useState(0)
  const [was, setWas] = useState(open)
  if (open !== was) {
    setWas(open)
    setSec(0)
  }
  useEffect(() => {
    if (!open) return
    const t0 = Date.now()
    const id = window.setInterval(() => setSec(Math.floor((Date.now() - t0) / 1000)), 250)
    return () => window.clearInterval(id)
  }, [open])
  if (!open) return null
  return (
    <div className="waitmask" role="alert" aria-busy="true" aria-live="polite">
      <div className="waitbox">
        <div className="pbar waitbar" aria-hidden>
          <i />
        </div>
        <b>{title}</b>
        <span>
          {text}
          {sec >= 1 ? ` · 已 ${sec} 秒` : ''}
        </span>
      </div>
    </div>
  )
}
