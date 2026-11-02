/**
 * 整体样式的清单（2026-10-22 收成极光 + 石墨两套）。**配色本身不在这里** —— 在 `mockup/_theme.css` 的
 * `[data-theme=xxx]` 段里，切主题就是改 `<html data-theme>` 一个属性。
 *
 * 这里只留三样 CSS 变量拿不到的东西：
 *  1. 主题的中文名（要显示在界面上）
 *  2. 色板上那两块颜色（`<button>` 的 `--sw-a` / `--sw-b` 内联变量，
 *     必须在切过去之前就知道，不能等切过去再读 `getComputedStyle`）
 *  3. antd 的 `colorPrimary` —— antd 要用它现算一整条色阶（hover/active/边框），
 *     喂 `var(--acc)` 进去算不出来，只能给真色值
 *
 * 跟 `mockup/_shell.js` 的 THEMES 是同一份数据。没有做成一个模块两边引：
 * 原型跑在 `file://` 下，浏览器禁掉了 file:// 的 ES module（CORS），
 * `<script type="module">` 一引就整页白屏。这几行是全项目唯一一处刻意的重复，
 * 加主题时记得两边都加。
 *
 * 旧版存的 frost / nebula / terminal 等 id 走 themeOf 退回默认极光。
 */
export const THEMES = [
  { id: 'aurora', label: '极光', accent: '#3b63e0', deep: '#dfe3f6', note: '浅色渐变底 + 毛玻璃卡片', scheme: 'light' },
  { id: 'graphite', label: '石墨', accent: '#5b9bc4', deep: '#181c22', note: '中性深灰，平面无发光', scheme: 'dark' },
] as const

export type ThemeId = (typeof THEMES)[number]['id']
export type ThemeDef = (typeof THEMES)[number]

/** 默认浅色：整天对着 SQL，不要默认进深色 */
export const DEFAULT_THEME: ThemeId = 'aurora'

const BY_ID = new Map<string, ThemeDef>(THEMES.map((t) => [t.id, t]))

/** 认不出来的 id 一律退回默认，不要抛 —— localStorage 里可能是上个版本存的旧 id */
export const themeOf = (id: string | null | undefined): ThemeDef =>
  BY_ID.get(id ?? '') ?? BY_ID.get(DEFAULT_THEME)!
