/** 扫描器写的是 UTC（Instant.toString，带 Z），直接截字符串会慢 8 小时；这里转本地时间 'MM-DD HH:mm'。
 *  解析不了时原样截取，不抛错。 */
export function fmtLocal(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(5, 16).replace('T', ' ')
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
