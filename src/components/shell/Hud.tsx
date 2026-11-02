/**
 * 背景层：光晕 / 网格 / 扫描线。三个空 `<i>`，画什么全由主题的
 * `--show-aura` / `--show-grid` / `--show-scan` 决定 ——
 * 所以这里**不判断当前是哪套主题**，五套共用同一份 DOM。
 *
 * `pointer-events:none` + `z-index:0` 在 CSS 里，它盖不住任何点击。
 */
export function Hud() {
  return (
    <div className="hud">
      <i className="aura" />
      <i className="grid" />
      <i className="scan" />
    </div>
  )
}
