/** 日志页单份列表和时间线视图（pro/）共用的常量与 hook */
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

export const LEVELS = ['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'] as const
/** 列表固定行高（px），虚拟滚动的定位全靠它 */
export const ROW_H = 28
export const WINDOW_PAD = 12

/**
 * 虚拟列表的可视高度。用 ref 回调挂观察器：列表 div 按 key 重挂（改一次过滤就重挂），
 * effect 版本只在第一次挂上、之后监视的是已卸载的旧节点——高度回调成 0，
 * 只渲染 24 行，屏幕高一点列表下半截是空的
 */
export function useViewHeight(): [number, (el: HTMLDivElement | null) => void] {
  const [viewH, setViewH] = useState(480)
  const roRef = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect()
    roRef.current = null
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (el.clientHeight > 0) setViewH(el.clientHeight)
    })
    ro.observe(el)
    roRef.current = ro
  }, [])
  return [viewH, ref]
}

// ---- 详情卡高度：拖分隔条定高、双击回到「跟着内容走」，选一次记住 ----
const DETAIL_H_KEY = 'codenow.logvDetailH'
const DETAIL_H_MIN = 220
/** 与 _theme.css 里 .logv-list 的 min-height 保持一致 */
const LIST_H_MIN = 120

function loadDetailH(): number | null {
  try {
    const v = Number(localStorage.getItem(DETAIL_H_KEY))
    return Number.isFinite(v) && v >= DETAIL_H_MIN && v <= 3000 ? v : null
  } catch {
    return null
  }
}

function saveDetailH(h: number | null): void {
  try {
    if (h === null) localStorage.removeItem(DETAIL_H_KEY)
    else localStorage.setItem(DETAIL_H_KEY, String(h))
  } catch {
    // 存不了就本次会话有效
  }
}

/** 详情卡高度拖拽（单条视图与时间线视图共用）：拖分隔条定高、双击恢复「跟内容
 * 走」，高度记 localStorage。move/up 挂 window 不挂元素——不赌 pointer capture
 * 在各家 WebView 里的性子，按下去之后指针到哪儿都收得到；pointercancel（中键
 * 弹窗、系统手势打断拖拽）同样收尾，绝不留死监听 */
export function useDetailDrag() {
  const [detailH, setDetailH] = useState<number | null>(() => loadDetailH())
  const detailBodyRef = useRef<HTMLPreElement | null>(null)
  const detailHRef = useRef<number | null>(detailH)

  const onVsplitDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // 从「跟着内容走」开始拖：起点高度量的是当下渲染出来的实际高度
    const startH = detailH ?? (detailBodyRef.current?.getBoundingClientRect().height ?? 260)
    const startY = e.clientY
    // 上限 = 列表缩到最小高度为止；超过它列表缩不动，详情只会把页面往下撑
    const listH = (e.currentTarget.previousElementSibling as HTMLElement | null)?.getBoundingClientRect().height ?? 0
    const maxH = Math.max(startH + listH - LIST_H_MIN, startH)
    e.preventDefault()
    const move = (ev: PointerEvent) => {
      ev.preventDefault()
      const next = Math.min(Math.max(startH + (startY - ev.clientY), DETAIL_H_MIN), maxH)
      detailHRef.current = next
      setDetailH(next)
    }
    const done = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', done)
      window.removeEventListener('pointercancel', done)
      saveDetailH(detailHRef.current)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', done)
    window.addEventListener('pointercancel', done)
  }
  const onVsplitDouble = () => {
    setDetailH(null)
    saveDetailH(null)
  }
  return {
    detailBodyRef,
    /** 拖过 = 定高；没拖 = undefined，让 CSS 的「跟内容走」生效 */
    preStyle: detailH !== null ? { height: detailH, maxHeight: 'none' } : undefined,
    onVsplitDown,
    onVsplitDouble,
  }
}
