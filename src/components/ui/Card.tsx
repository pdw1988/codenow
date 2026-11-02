/**
 * 卡片。整个应用的内容都装在卡片里，所以这个组件的形状决定了页面的形状。
 *
 * 三段固定：头（标题 + 右上角）、身（内容）、脚（一排操作按钮）。
 * 脚单独开一段而不是让调用方把按钮塞进 children，是因为按钮的位置得一致 ——
 * 一个页面上有的卡片按钮在右下、有的在内容中间，用户就得每张卡片重新找一遍。
 *
 * `.corner` 那两个 HUD 角标一直渲染，由主题的 `--show-corner` 决定显不显示：
 * 石墨和蓝图关掉了。所以别在这里判断当前主题 —— 判断了就有两处规则。
 */
import type { ReactNode } from 'react'
import { cx } from './cx'
import { headToggle } from './headToggle'

interface CardProps {
  /** 头部左边的标题。不传就整个头不渲染 */
  title?: ReactNode
  /** 标题右边的等宽小字，通常是「谁负责这一步」或适用范围 */
  who?: ReactNode
  /** 挤到头部最右边的东西，一般是计数或一个小控件 */
  extra?: ReactNode
  /** 卡片底部那一排操作 */
  actions?: ReactNode
  /** 出错态：边框和小圆点变红 */
  error?: boolean
  /** 一页的主卡（通常是填参数那张）：极光主题下铺蓝紫渐变底，石墨下不变 */
  hero?: boolean
  /** 内容区不要内边距（整张表格铺满时用） */
  tight?: boolean
  /** 内容区最大高度，超出滚动 */
  maxBody?: number
  /**
   * 给了 `onToggle` 这张卡就能折叠：整个头可点，收起时身和脚一起藏
   * （`.card.foldable`，CSS 管显隐，不卸载内容）。展开状态受控 ——
   * 「哪几张卡是开的」属于页面，页面才做得到「一键全部收起」。
   */
  open?: boolean
  onToggle?: (open: boolean) => void
  children?: ReactNode
  className?: string
}

export function Card({
  title,
  who,
  extra,
  actions,
  error,
  hero,
  tight,
  maxBody,
  open,
  onToggle,
  children,
  className,
}: CardProps) {
  const foldable = onToggle !== undefined
  const on = !foldable || open === true

  return (
    <section
      className={cx('card', error && 'err', hero && 'card-hero', foldable && 'foldable', foldable && on && 'on', className)}
    >
      <i className="corner tl" />
      <i className="corner br" />

      {(title !== undefined || who !== undefined || extra !== undefined) && (
        <div className="chead" {...(onToggle ? headToggle(on, onToggle) : {})}>
          {/* 折叠卡用小三角代替常亮的圆点：两个状态指示灯摆一起，用户会去猜它们的区别 */}
          {foldable ? <span className="caret">▶</span> : <i className="dot" />}
          {title !== undefined && <div className="h">{title}</div>}
          {who !== undefined && <span className="who">{who}</span>}
          {extra !== undefined && (
            <>
              <div className="spacer" />
              {extra}
            </>
          )}
        </div>
      )}

      <div
        className={cx('cbody', tight && 'tight')}
        style={maxBody === undefined ? undefined : { maxHeight: maxBody, overflow: 'auto' }}
      >
        {children}
      </div>

      {actions !== undefined && <div className="acts">{actions}</div>}
    </section>
  )
}
