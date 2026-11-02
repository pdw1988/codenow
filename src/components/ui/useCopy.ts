/**
 * 复制到剪贴板 + 一个自己会消失的结果提示。
 *
 * 为什么不用 toast：复制是就地反馈，按钮上直接变成「✓ 已复制」比屏幕角落
 * 弹一条更快看见，也不用依赖 message 的 context。原型就是这么做的。
 *
 * 必须有 execCommand 兜底：Tauri 的 `navigator.clipboard` 要权限，
 * 浏览器里非 https 也可能直接拒。没有兜底的表现是「点了没反应、也不报错」，
 * 用户只会以为是这个工具坏了。
 *
 * copy() 返回是否真的复制成功（异步）。现有调用点大多不接返回值；
 * 我的SQL库靠它做「复制成功才计 use_count」，计数虚高比不计数更糟。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export type CopyState = 'idle' | 'ok' | 'fail'

const HOLD_MS = 1300

function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;opacity:0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  return ok
}

export function useCopy() {
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // 组件先卸载、定时器后到的话，setState 会打在已卸载的组件上
  useEffect(() => () => clearTimeout(timer.current), [])

  const flash = useCallback((next: CopyState) => {
    setState(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), HOLD_MS)
  }, [])

  const copy = useCallback(
    (text: string): Promise<boolean> => {
      if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text).then(
          () => {
            flash('ok')
            return true
          },
          () => {
            const ok = legacyCopy(text)
            flash(ok ? 'ok' : 'fail')
            return ok
          },
        )
      }
      const ok = legacyCopy(text)
      flash(ok ? 'ok' : 'fail')
      return Promise.resolve(ok)
    },
    [flash],
  )

  return { state, copy }
}
