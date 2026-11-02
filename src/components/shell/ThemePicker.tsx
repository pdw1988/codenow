/**
 * 主题选择器：顶栏只留「当前主题色块 + 名字」，点开浮层选全部。
 *
 * 常驻七枚色块的旧版占了顶栏 ~190px——主题是装好一次半年不碰的低频动作，
 * 不配常驻那么多视觉权重。浮层里仍然是**色块本身**（选择依据就是颜色，
 * 收成纯文字下拉用户只能靠名字猜「石墨」长什么样），只是多一次点击。
 *
 * 色值走内联 `--sw-a/--sw-b` 两个自定义属性（`_theme.css` 的 `.tp .sw::after`
 * 拿它们画斜分割）。这是**唯一允许在组件里出现颜色的地方**：切换器必须在
 * 「还没切过去」的时候就把各套的调子摆出来，那些颜色不可能来自当前主题的变量。
 *
 * 数字键 1-N 切换还在（AppShell 的 pickByIndex），提示写在每个色块的 title 里。
 * 浅色在前、暗色在后：产品气质是办公浅色，极客皮别抢主位。
 */
import type { CSSProperties } from 'react'
import { Popover } from 'antd'
import { THEMES } from '../../theme/themes'
import { useThemeDef, useThemeStore } from '../../store/useThemeStore'
import { cx } from '../ui'

export function ThemePicker() {
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)
  const cur = useThemeDef()

  const light = THEMES.filter((t) => t.scheme === 'light')
  const dark = THEMES.filter((t) => t.scheme === 'dark')

  const sw = (t: (typeof THEMES)[number], i: number) => (
    <button
      key={t.id}
      type="button"
      className={cx('sw', t.id === theme && 'on')}
      // 数字键提示写在 title 里：浮层里一行说明，一个用户只需要读一次
      title={`${i + 1}. ${t.label} — ${t.note}（按数字键 ${i + 1} 切换）`}
      aria-label={t.label}
      aria-pressed={t.id === theme}
      style={{ '--sw-a': t.accent, '--sw-b': t.deep } as CSSProperties}
      onClick={() => setTheme(t.id)}
    />
  )

  const grid = (
    <div className="tp tp-pop" role="radiogroup" aria-label="选择主题">
      <div className="tp-group">
        <span className="tp-cap">浅色</span>
        <div className="tp-row">{light.map((t) => sw(t, THEMES.findIndex((x) => x.id === t.id)))}</div>
      </div>
      <div className="tp-group">
        <span className="tp-cap">深色</span>
        <div className="tp-row">{dark.map((t) => sw(t, THEMES.findIndex((x) => x.id === t.id)))}</div>
      </div>
    </div>
  )

  return (
    <Popover content={grid} trigger="click" placement="bottomRight" arrow={false}>
      <button type="button" className="tp tp-cur" aria-label={`主题：${cur.label}，点开更换`}>
        <i
          className="sw on"
          aria-hidden="true"
          style={{ '--sw-a': cur.accent, '--sw-b': cur.deep } as CSSProperties}
        />
        <span className="nm">{cur.label}</span>
        <span className="cv" aria-hidden="true">
          ▾
        </span>
      </button>
    </Popover>
  )
}
