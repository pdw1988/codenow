/**
 * 高亮片段。`lib/highlight.ts` 出 token，这里渲染成 `<span class="k|s|n|f|c">`。
 *
 * 单独抽出来是因为「要高亮的东西」不止代码块一处：JSONPath 的结果面板、
 * 日志确认框里的 SQL 预览都要用，而它们外面套的不是 `.code` 框。
 *
 * 不用 `dangerouslySetInnerHTML`：这里显示的内容里有用户粘进来的表名、注释、
 * 字面量，注释里写个 `<img onerror=...>` 就直接执行了。
 */
import { Fragment, useMemo } from 'react'
import { highlight, type Lang } from '../../lib/highlight'

export function Hl({ code, lang = 'text' }: { code: string; lang?: Lang }) {
  const tokens = useMemo(() => highlight(code, lang), [code, lang])

  return (
    <>
      {tokens.map((t, i) =>
        t.cls ? (
          <span key={i} className={t.cls}>
            {t.text}
          </span>
        ) : (
          <Fragment key={i}>{t.text}</Fragment>
        ),
      )}
    </>
  )
}
