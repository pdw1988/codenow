/**
 * 输入控件。三个都挂 `.fld`，长相和聚焦效果跟着主题走。
 *
 * 下拉用**原生 `<select>`**，不是自绘的。原因不是省事：
 * 自绘下拉要自己处理键盘、滚动、失焦、贴边翻转，而这里的下拉最多 10 项。
 * 顺带解决一个真踩过的坑 —— antd 的 Select 监听 mousedown，
 * `element.click()` 打不开它，e2e 里得手动派发三个事件（CLAUDE.md 有记）。
 * 原生 select 在自动化里就是设个 value 再 dispatch 一个 change。
 */
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { cx } from './cx'

type Common = {
  /** 校验没过：红边框 */
  bad?: boolean
  /** 大一号，页面主输入用 */
  big?: boolean
  className?: string
}

export function Fld({
  bad,
  big,
  className,
  ...rest
}: Common & Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>) {
  return <input className={cx('fld', bad && 'bad', big && 'big', className)} {...rest} />
}

export function TextArea({
  bad,
  big,
  className,
  ...rest
}: Common & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>) {
  return (
    <textarea
      spellCheck={false}
      className={cx('fld', bad && 'bad', big && 'big', className)}
      {...rest}
    />
  )
}

export interface SelOption<T extends string> {
  value: T
  label: ReactNode
  /** 不显示、只参与筛选（Java 类名、字段名）。表下拉靠它搜到不在按钮上的词 */
  hay?: string
}

interface SelProps<T extends string>
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'value' | 'onChange'> {
  options: ReadonlyArray<SelOption<T>>
  value: T
  onChange: (value: T) => void
  bad?: boolean
  className?: string
}

export function Sel<T extends string>({
  options,
  value,
  onChange,
  bad,
  className,
  ...rest
}: SelProps<T>) {
  return (
    <select
      className={cx('fld', bad && 'bad', className)}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      {...rest}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
