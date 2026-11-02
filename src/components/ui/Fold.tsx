/**
 * 折叠块。整个 `.fold-h` 都能点（一行里只有小三角能点的折叠很难命中），
 * 但落在按钮/输入/可点 Tag 上的点击不算 —— 规则在 `headToggle` 里，
 * 整张卡片折叠的 `Card` 用的是同一份。
 *
 * 受控组件。展开状态属于页面（「哪几张表是展开的」要能被外面一键全部收起），
 * 不属于这一块。
 */
import type { ReactNode } from 'react'
import { cx } from './cx'
import { headToggle } from './headToggle'

interface FoldProps {
  open: boolean
  onToggle: (open: boolean) => void
  /** 表头内容，会排在小三角右边 */
  head: ReactNode
  children: ReactNode
  className?: string
}

export function Fold({ open, onToggle, head, children, className }: FoldProps) {
  return (
    <div className={cx('fold', open && 'on', className)}>
      <div className="fold-h" {...headToggle(open, onToggle)}>
        <span className="caret">▶</span>
        {head}
      </div>
      {/* 折起来时靠 CSS display:none，不卸载 —— 里面可能有用户改了一半的输入 */}
      <div className="fold-b">{children}</div>
    </div>
  )
}
