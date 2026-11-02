/**
 * 自绘窗口标题栏。系统标题栏不跟主题走（极光下一条死白、石墨下一条亮灰），
 * 所以 tauri.conf 关了 decorations，这里补拖动 + 最小化 / 最大化 / 关闭。
 * 浏览器里（vite dev / preview）没有窗口可控，不渲染。
 */
import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export function TitleBar() {
  const [max, setMax] = useState(false)

  useEffect(() => {
    if (!inTauri) return
    document.documentElement.classList.add('has-tbar')
    const w = getCurrentWindow()
    const sync = () => void w.isMaximized().then(setMax, () => {})
    sync()
    const un = w.onResized(sync)
    return () => {
      document.documentElement.classList.remove('has-tbar')
      void un.then((f) => f(), () => {})
    }
  }, [])

  if (!inTauri) return null
  const w = getCurrentWindow()
  return (
    <div className="tbar" data-tauri-drag-region>
      <span className="tbar-title" data-tauri-drag-region>
        码上 CodeNow · Java 开发平台
      </span>
      <div className="tbar-btns">
        <button type="button" title="最小化" onClick={() => void w.minimize()}>
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" /></svg>
        </button>
        <button type="button" title={max ? '还原' : '最大化'} onClick={() => void w.toggleMaximize()}>
          {max ? (
            <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" /></svg>
          ) : (
            <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M.5 .5h9v9h-9z" /></svg>
          )}
        </button>
        {/* 关窗口照旧走 CloseRequested：主窗口藏到托盘，不是退出 */}
        <button type="button" className="tbar-close" title="关闭（缩到托盘）" onClick={() => void w.close()}>
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10" /></svg>
        </button>
      </div>
    </div>
  )
}
