/**
 * 当前整体样式。切换只做两件事：改 `<html data-theme>`、记进 localStorage。
 *
 * 为什么值也存在 zustand 里而不是只读 DOM：antd 的 `colorPrimary` 要跟着变
 * （overlay 类组件 —— Modal / Tooltip / message —— 还是 antd 画的，
 * 它们不读 CSS 变量），所以 React 侧必须知道「现在是哪一套」才能重算 token。
 *
 * 主题在模块加载时就先贴到 documentElement 上，不等 React 首帧：
 * 等 useEffect 的话会先用默认主题渲染一帧，视觉上是一次闪烁。
 */
import { create } from 'zustand'
import { DEFAULT_THEME, THEMES, themeOf, type ThemeDef, type ThemeId } from '../theme/themes'

const LS_KEY = 'devtools-theme'

const read = (): ThemeId => {
  try {
    return themeOf(localStorage.getItem(LS_KEY)).id
  } catch {
    // Tauri 的 file:// 或隐私模式下会抛，主题这种小事不值得让启动失败
    return DEFAULT_THEME
  }
}

const paint = (id: ThemeId) => {
  document.documentElement.dataset.theme = id
  try {
    localStorage.setItem(LS_KEY, id)
  } catch {
    /* 存不上就算了，下次开回默认 */
  }
}

const initial = read()
paint(initial)

interface ThemeState {
  theme: ThemeId
  setTheme: (id: ThemeId) => void
  /** 数字键 1–N 用：越界返回 false，调用方据此决定要不要 preventDefault */
  pickByIndex: (n: number) => boolean
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: initial,

  setTheme: (theme) => {
    paint(theme)
    set({ theme })
  },

  pickByIndex: (n) => {
    const hit = THEMES[n - 1]
    if (!hit) return false
    paint(hit.id)
    set({ theme: hit.id })
    return true
  },
}))

/** 组件里要色值时用这个，省得每处都 THEMES.find */
export const useThemeDef = (): ThemeDef => themeOf(useThemeStore((s) => s.theme))
