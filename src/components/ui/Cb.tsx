/**
 * 勾选框。原生 checkbox 在深色下各平台长得都不一样（Windows 上是亮蓝方块，
 * 跟任何一套主题都不搭），所以 `_theme.css` 里用 appearance:none 自己画了一个。
 *
 * 外面是 `<label>`，所以点文字也能勾上 —— 只有 16px 见方能点的勾选框，
 * 一列几十个字段勾起来会很烦。
 *
 * 切换只走 label 的 click：input / 文字都 pointer-events:none，避免点方块时
 * 「label 自己切一次 + 关联再激活一次」连跳两下，勾看起来掉不掉。
 * WebView2 里 appearance:none 的 change 事件本来也不稳，别靠它。
 */
import type { ReactNode, MouseEvent } from 'react'
import { cx } from './cx'

interface CbProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** 橙色勾（命名推断这类「你得自己确认」的东西用它） */
  dim?: boolean
  disabled?: boolean
  indeterminate?: boolean
  title?: string
  children?: ReactNode
  className?: string
}

export function Cb({
  checked,
  onChange,
  dim,
  disabled,
  indeterminate,
  title,
  children,
  className,
}: CbProps) {
  const toggle = () => {
    if (disabled) return
    onChange(!checked)
  }

  const onLabelClick = (e: MouseEvent) => {
    e.preventDefault()
    toggle()
  }

  return (
    <label
      className={cx('cb', dim && 'dim', disabled && 'is-off', className)}
      title={title}
      onClick={onLabelClick}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        readOnly
        aria-checked={indeterminate ? 'mixed' : checked}
        onChange={() => {
          /* 真切换在 label.onClick */
        }}
        onKeyDown={(e) => {
          if (e.key !== ' ' && e.key !== 'Enter') return
          e.preventDefault()
          toggle()
        }}
      />
      {children !== undefined && <span>{children}</span>}
    </label>
  )
}
