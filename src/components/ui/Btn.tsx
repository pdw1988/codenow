/**
 * 按钮。三档，对应 `_theme.css` 的 `.primary` / `.ghost` / `.mini`。
 *
 * 一屏只准有一个 primary：primary 的意思是「这一页你要点的就是它」，
 * 有两个就等于没有。次要操作用 ghost，卡片脚上那排小动作用 mini。
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'

interface BtnProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: 'primary' | 'ghost' | 'mini'
  /** 选中态（只有 mini 有这个样式） */
  on?: boolean
  /**
   * 强调态（只有 ghost 有这个样式）。给「这张卡上你多半要点的那个」用：
   * 默认 ghost 是灰字灰边，摆在标题条里看不出能点。primary 名额已经被占了时，
   * 次一档的主线操作挂 hi。别整排都挂，挂满了等于没挂。
   */
  hi?: boolean
  danger?: boolean
  /**
   * 看起来像禁用，但还能点。原生 `disabled` 在 Windows 上连 `title` 都不出，
   * 点了毫无反应。需要把原因 toast 出来的按钮走这条，不要再用 disabled。
   */
  blocked?: boolean
  children?: ReactNode
  className?: string
}

export function Btn({ variant = 'ghost', on, hi, danger, blocked, className, children, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      className={cx(variant, on && 'on', hi && 'hi', danger && 'bad', blocked && 'is-off', className)}
      aria-disabled={blocked || rest.disabled}
      {...rest}
    >
      {children}
    </button>
  )
}
