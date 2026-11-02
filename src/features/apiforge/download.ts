/**
 * 前端生成文件触发下载。报告 / 接口文档导出共用 —— 放纯 TS 模块是为了
 * 别跟组件同文件（fast-refresh 只认组件文件）。
 */
export function download(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}
