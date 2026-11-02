/**
 * 桌面 IPC。不走 `import('@tauri-apps/api/core')`。
 *
 * Vite 会把那个包预打包成 `/node_modules/.vite/deps/@tauri-apps_api_core.js?v=hash`。
 * 开发时一重优化（改 vite 配置、清缓存、两个 dev 抢端口），旧 hash 立刻 404，
 * 浏览器报 Failed to fetch dynamically imported module——看起来像驱动坏了，
 * 其实只是前端通道文件没了。壳已经把同一份 invoke 挂在
 * `window.__TAURI_INTERNALS__` 上，直接用，不经过 Vite 预打包。
 *
 * 浏览器没有这根针，立刻中文拒绝，不要再去 fetch 那个 js。
 */
import { isTauri } from '../storage'

interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

function internals(): TauriInternals | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
}

export function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = internals()?.invoke
  if (!isTauri() || !invoke) {
    return Promise.reject(
      new Error('请用桌面版连库（pnpm tauri:dev 或安装包）。浏览器没有驱动。'),
    )
  }
  return invoke(cmd, args) as Promise<T>
}
