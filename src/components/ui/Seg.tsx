/**
 * 分段选择器。互斥的少量选项用它，不要用下拉 ——
 * 下拉藏起了「一共有几个选项」，而这些选项本身就是在告诉用户这个工具支持什么。
 * 方言选择就是这么回事：摆出来是「支持这几种」，收进下拉是「支持某种」。
 */
import type { CSSProperties, ReactNode } from 'react'
import { cx } from './cx'

export interface SegOption<T extends string> {
  value: T
  label: ReactNode
  /** 悬停解释。选项名只有两三个字时，差别往往解释不清 */
  title?: string
  disabled?: boolean
}

interface SegProps<T extends string> {
  options: ReadonlyArray<SegOption<T>>
  value: T
  onChange: (value: T) => void
  /** 布局用途（比如撑满一行）；颜色字号间距仍走主题，别往这塞 */
  style?: CSSProperties
  className?: string
}

export function Seg<T extends string>({ options, value, onChange, style, className }: SegProps<T>) {
  return (
    <div className={cx('seg', className)} style={style}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={cx(o.value === value && 'on')}
          title={o.title}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
