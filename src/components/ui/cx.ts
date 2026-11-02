/**
 * 拼 className 的小工具。false / undefined / '' 一律丢掉。
 *
 * 单独一个文件是为了 oxlint 的 `react/only-export-components`：
 * 组件文件里再导出一个普通函数会告警（会破坏 react-refresh 的粒度）。
 */
export const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ')
