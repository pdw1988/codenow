/**
 * `_theme.css` 里那些一行 CSS 的小件，包成组件只为了一件事：
 * **让写页面的人拿不到 style 属性**。
 *
 * 直接写 `<div className="row">` 当然也行，但那样 `.row` 到底存不存在、
 * 叫 row 还是 line，只能靠记。包一层之后 TypeScript 会替你记，
 * 而且哪天类名要改，改这一个文件。
 *
 * 唯一的规矩跟 `_theme.css` 的注释一致：**这些组件里不准出现颜色**。
 * 要颜色就加一个语气（tone），色值在主题里。
 */
import type { CSSProperties, ReactNode } from 'react'
import { cx } from './cx'

interface BoxProps {
  children?: ReactNode
  className?: string
  style?: CSSProperties
}

/** 横排，自动换行。`tight` 是间距小一档 */
export function Row({ tight, children, className, style }: BoxProps & { tight?: boolean }) {
  return (
    <div className={cx('row', tight && 'tight', className)} style={style}>
      {children}
    </div>
  )
}

/** 竖排 */
export function Stack({ children, className, style, gap }: BoxProps & { gap?: number }) {
  return (
    <div className={cx('stack', className)} style={gap === undefined ? style : { gap, ...style }}>
      {children}
    </div>
  )
}

/** 把后面的东西挤到右边 */
export function Spacer() {
  return <div className="spacer" />
}

/** 竖直分隔线，顶栏里分组用 */
export function Sep() {
  return <div className="sep" />
}

/** 小节标题那种全大写小字（大小写和字间距跟着主题变，terminal 那套是全大写） */
export function Lbl({ children, className }: BoxProps) {
  return <span className={cx('lbl', className)}>{children}</span>
}

/** 灰色说明文字 */
export function Hint({ children, className }: BoxProps) {
  return <span className={cx('hint', className)}>{children}</span>
}

/** 等宽。表名、字段名、类型、SQL 片段一律用它 —— 对齐了才好扫 */
export function Mono({ children, className, style }: BoxProps) {
  return (
    <span className={cx('mono', className)} style={style}>
      {children}
    </span>
  )
}

export type TagTone = 'ok' | 'no' | 'hi' | 'wr' | 'pk'

/**
 * 小标签。tone 的含义是固定的，别按「好看」挑：
 * ok=真的、no=错的、wr=要人确认的、hi=命中/强调、pk=主键。
 */
export function Tag({
  tone,
  title,
  onClick,
  children,
  className,
}: BoxProps & { tone?: TagTone; title?: string; onClick?: () => void }) {
  if (!onClick) {
    return (
      <span className={cx('tag', tone, className)} title={title}>
        {children}
      </span>
    )
  }
  // 可点的标签用 button：键盘能 Tab 到、回车能触发，读屏也知道这是个操作
  return (
    <button type="button" className={cx('tag', tone, 'click', className)} title={title} onClick={onClick}>
      {children}
    </button>
  )
}

/** 圆角胶囊，「最近查过」那类快捷入口 */
export function Chip({
  badge,
  tone,
  onClick,
  onRemove,
  children,
  className,
}: BoxProps & {
  badge?: ReactNode
  tone?: 'warn' | 'bad'
  onClick?: () => void
  /** 有值就在右侧加个小 ✕；外壳降级成 span，里面「主体 + ✕」两个 button */
  onRemove?: () => void
}) {
  const body = (
    <>
      {badge !== undefined && <i>{badge}</i>}
      {children}
    </>
  )
  if (!onRemove) {
    return (
      <button type="button" className={cx('chip', tone, className)} onClick={onClick}>
        {body}
      </button>
    )
  }
  // button 里嵌不了 button，带 ✕ 时外壳换成 span，胶囊皮样式靠 .chip.wrap 保留
  return (
    <span className={cx('chip', 'wrap', tone, className)}>
      <button type="button" className="chip-main" onClick={onClick}>
        {body}
      </button>
      <button type="button" className="chip-x" title="移除" onClick={onRemove}>
        ✕
      </button>
    </span>
  )
}

export function Chips({ children, className }: BoxProps) {
  return <div className={cx('chips', className)}>{children}</div>
}

export type BandTone = 'info' | 'ok' | 'warn' | 'err'

/**
 * 提示条。替代 antd 的 Alert。
 *
 * `title` 是加粗那半句，children 是解释。写提示的时候把「发生了什么」放 title，
 * 「所以你要怎么办」放 children —— 只有一句话的提示用户读完还是不知道该干什么。
 */
export function Band({
  tone = 'info',
  title,
  children,
  className,
}: BoxProps & { tone?: BandTone; title?: ReactNode }) {
  return (
    <div className={cx('band', tone, className)}>
      {title !== undefined && <b>{title}</b>}
      {title !== undefined && children ? ' ' : null}
      {children}
    </div>
  )
}

/** 空状态。文案要写「接下来做什么」，不要只写「暂无数据」 */
export function EmptyBox({ children, className }: BoxProps) {
  return <div className={cx('empty', className)}>{children}</div>
}

export function Stats({ children, className }: BoxProps) {
  return <div className={cx('stats', className)}>{children}</div>
}

/** KPI 数字块。tone 决定数字的颜色，色值在主题里 */
export function Stat({
  t,
  v,
  f,
  tone,
  className,
}: {
  t: ReactNode
  v: ReactNode
  /** 数字下面一行灰色小字（来源、构成） */
  f?: ReactNode
  tone?: 'ok' | 'warn' | 'bad' | 'acc'
  className?: string
}) {
  return (
    <div className={cx('stat', tone, className)}>
      <div className="t">{t}</div>
      <div className="v">{v}</div>
      {f !== undefined && <div className="f">{f}</div>}
    </div>
  )
}

/**
 * 左右两栏。默认 4:5（左边配置、右边结果），`even` 是对半。
 * 窄到 1180px 以下 `_theme.css` 会自动堆成一栏，这里不用管。
 */
export function Split({ even, children, className }: BoxProps & { even?: boolean }) {
  return <div className={cx('split', even && 'even', className)}>{children}</div>
}

/** Split 里的一栏，内部竖排 */
export function Col({ children, className }: BoxProps) {
  return <div className={cx('col', className)}>{children}</div>
}

/** 「这里不用点按钮」的徽标。砍掉一次点击就挂一个，让人看得见 */
export function Auto({ children }: BoxProps) {
  return <span className="auto">{children}</span>
}

export function Kbd({ children }: BoxProps) {
  return <kbd>{children}</kbd>
}
