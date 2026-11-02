/**
 * 左右拖分隔条调一块的宽度：拖动定宽、双击回到 CSS 默认，宽度记 localStorage。
 *
 * 分隔条紧挨着被调的那块：edge='right' = 那块在分隔条左边（往右拖变宽），
 * edge='left' = 那块在右边（往左拖变宽）。move/up 挂 window，pointercancel 同样收尾。
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

export interface WidthDragOpts {
  storageKey: string
  /** 被调那块最窄 */
  min: number
  /** 父容器里另一侧至少留多宽（与 CSS 里那块的 max-width 保持一致） */
  restMin: number
  edge: 'left' | 'right'
}

function loadW(key: string, min: number): number | null {
  try {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v >= min && v <= 4000 ? v : null
  } catch {
    return null
  }
}

function saveW(key: string, w: number | null): void {
  try {
    if (w === null) localStorage.removeItem(key)
    else localStorage.setItem(key, String(w))
  } catch {
    // 存不了就本次会话有效
  }
}

export function useWidthDrag({ storageKey, min, restMin, edge }: WidthDragOpts) {
  const [w, setW] = useState<number | null>(() => loadW(storageKey, min))
  const wRef = useRef<number | null>(w)

  const onSplitDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const bar = e.currentTarget
    const box = (edge === 'right' ? bar.previousElementSibling : bar.nextElementSibling) as HTMLElement | null
    const parentW = bar.parentElement?.getBoundingClientRect().width ?? 0
    const startW = box?.getBoundingClientRect().width ?? min
    const maxW = Math.max(parentW - restMin, min)
    const sign = edge === 'right' ? 1 : -1
    const startX = e.clientX
    e.preventDefault()
    document.body.style.cursor = 'col-resize'
    const move = (ev: PointerEvent) => {
      ev.preventDefault()
      const next = Math.min(Math.max(startW + sign * (ev.clientX - startX), min), maxW)
      wRef.current = next
      setW(next)
    }
    const done = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', done)
      window.removeEventListener('pointercancel', done)
      document.body.style.cursor = ''
      saveW(storageKey, wRef.current)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', done)
    window.addEventListener('pointercancel', done)
  }
  const onSplitDouble = () => {
    wRef.current = null
    setW(null)
    saveW(storageKey, null)
  }
  return {
    /** 拖过 = 定宽；没拖 = undefined，让 CSS 默认宽度生效 */
    widthStyle: w !== null ? { width: w } : undefined,
    onSplitDown,
    onSplitDouble,
  }
}
