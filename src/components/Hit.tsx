/**
 * 把文字里命中关键字的部分套上 `<em class="hit">`。
 *
 * 用 indexOf 循环切，不用正则：关键字是用户直接敲进搜索框的，
 * 里面出现 `(`、`*`、`[` 是常事（字段名 `remark(备注)`、类型 `NUMBER(10,2)`），
 * 拿它去 `new RegExp` 会抛「Invalid regular expression」，整页白屏。
 *
 * 也不用 innerHTML：这里的 text 是表注释、字段注释，全是用户粘贴进来的内容。
 */
interface Props {
  text: string | undefined
  /** 搜索关键字。空的时候原样输出 */
  kw?: string
}

export function Hit({ text, kw }: Props) {
  if (!text) return null
  const needle = kw?.trim()
  if (!needle) return <>{text}</>

  const hay = text.toLowerCase()
  const low = needle.toLowerCase()
  const parts: React.ReactNode[] = []
  let at = 0

  for (;;) {
    const i = hay.indexOf(low, at)
    if (i < 0) break
    if (i > at) parts.push(text.slice(at, i))
    parts.push(
      <em className="hit" key={i}>
        {text.slice(i, i + needle.length)}
      </em>,
    )
    at = i + needle.length
  }

  if (parts.length === 0) return <>{text}</>
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}
