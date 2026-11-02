/**
 * 自绘下拉。原生 `<select>` 在 Windows 上有两条会让「表名显示不全」的行为：
 *
 *   1. 弹出的选项列表跟控件等宽，长标识符直接裁掉，没有折行也没有 title
 *   2. 祖先带 `overflow:hidden` + `backdrop-filter`（`.card` 就是）时，
 *      Chromium 把 fixed 弹层当成卡片内部绘制，清单被卡片底裁掉
 *
 * TypePick 用 fixed 弹层躲过了第 2 条，是因为编辑表结构在 antd Modal 里，
 * Modal 已经 portal 到 body。这里的调用点在卡片里，必须自己 portal，
 * 否则 `position:fixed` 相对的是带 backdrop-filter 的卡片，不是视口。
 *
 * 键盘 / 点外面 / 滚动收起抄 TypePick：那套已经在弹窗表格里跑过。
 * 选项多时出搜索框——原生 select 只能靠系统那一小截滚动条翻，表一多就找不到。
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx } from './cx'
import type { SelOption } from './Fld'
import { textMatchesQuery } from '../../lib/search'

interface Props<T extends string> {
  options: ReadonlyArray<SelOption<T>>
  value: T
  onChange: (value: T) => void
  className?: string
  style?: CSSProperties
  /** 未选时按钮上的字。选项里的空 value 项（「请选择」）也会显示这个 */
  placeholder?: string
  /**
   * 按钮上的字覆盖。缺省显示 value（「按钮上只出 value」的老约定）；
   * value 是 id/编码（范围选择器的 `p`+projectId）时用它显示人话
   */
  displayLabel?: ReactNode
  disabled?: boolean
  'aria-label'?: string
  title?: string
  /** 超过这么多项才出搜索框。字段下拉经常不到，表下拉经常超过 */
  searchAt?: number
  /** 搜索框占位。表下拉会写成「表名 / 注释 / 拼音」 */
  searchPlaceholder?: string
}

function asText(label: ReactNode): string {
  return typeof label === 'string' || typeof label === 'number' ? String(label) : ''
}

export function PopSel<T extends string>({
  options,
  value,
  onChange,
  className,
  style,
  placeholder = '请选择',
  displayLabel,
  disabled,
  title,
  searchAt = 8,
  searchPlaceholder = '筛选',
  'aria-label': ariaLabel,
}: Props<T>) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number }>({
    left: 0,
    width: 0,
  })
  const wrapRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const current = options.find((o) => o.value === value)
  /** 按钮上只出 value（表名 / 字段名）。完整「名 — 注释」放清单里，挤进按钮又会被裁。
   *  displayLabel 是给「value 是编码、按钮要显示人话」的调用点（如回归范围）的覆盖 */
  const trigger = displayLabel !== undefined ? displayLabel : value || placeholder
  const searchable = options.length >= searchAt
  const needle = q.trim()
  const shown = needle
    ? options.filter((o) => {
        if (!o.value) return false
        return (
          textMatchesQuery(o.value, needle) ||
          textMatchesQuery(asText(o.label), needle) ||
          textMatchesQuery(o.hay, needle)
        )
      })
    : options

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!popRef.current?.contains(t) && !wrapRef.current?.contains(t)) setOpen(false)
    }
    const onScroll = (e: Event) => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (open && searchable) searchRef.current?.focus()
  }, [open, searchable])

  const toggle = () => {
    if (disabled) return
    if (open) {
      setOpen(false)
      return
    }
    const r = wrapRef.current?.getBoundingClientRect()
    if (!r) return
    // 弹层至少跟按钮一样宽，再放宽一点让「表名 — 注释」能折全；贴右边就往左挪
    const width = Math.min(Math.max(r.width, 280), window.innerWidth - 16)
    const left = Math.min(r.left, Math.max(8, window.innerWidth - 8 - width))
    setPos(
      window.innerHeight - r.bottom > 280
        ? { left, top: r.bottom + 3, width }
        : { left, bottom: window.innerHeight - r.top + 3, width },
    )
    setQ('')
    setOpen(true)
  }

  const pick = (v: T) => {
    onChange(v)
    setOpen(false)
  }

  return (
    <>
      <button
        ref={wrapRef}
        type="button"
        className={cx('fld', 'popsel', className)}
        style={style}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        data-value={value}
        title={title ?? (value ? asText(current?.label) || value : undefined)}
        onClick={toggle}
      >
        <span className={cx('popsel-lab', !value && 'ph')}>{trigger}</span>
        <span className="popsel-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open &&
        createPortal(
          <div
            className="popsel-pop"
            ref={popRef}
            role="listbox"
            aria-label={ariaLabel}
            style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width }}
          >
            {searchable && (
              <input
                ref={searchRef}
                className="fld"
                value={q}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                onChange={(e) => setQ(e.target.value)}
              />
            )}
            <div className="popsel-list">
              {shown.length === 0 ? (
                <div className="popsel-empty">无匹配</div>
              ) : (
                shown.map((o) => (
                  <button
                    key={o.value || '__empty'}
                    type="button"
                    role="option"
                    data-value={o.value}
                    aria-selected={o.value === value}
                    className={cx(o.value === value && 'on')}
                    onClick={() => pick(o.value)}
                  >
                    {o.label}
                  </button>
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
