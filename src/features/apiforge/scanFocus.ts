/** 扫描页上半部路径框的 id */
export const SCAN_ROOT_INPUT_ID = 'apf-scan-root'

/** 「换目录」一类按钮：滚回扫描页上半部并把光标放进路径框 */
export function focusScanRoot(): void {
  const el = document.getElementById(SCAN_ROOT_INPUT_ID)
  if (!(el instanceof HTMLInputElement)) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.focus()
  el.select()
}
