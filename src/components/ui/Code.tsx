/**
 * 代码块。`.code` 外框 + `.code-bar` 工具条 + `<pre>` 正文。
 *
 * 高亮和复制都不在这里实现：`Hl` 负责着色、`CopyBtn` 负责复制，
 * 因为这两件事在别的外框里（结果面板、确认弹窗）也要用。
 *
 * 行数/字符数默认显示：生成 SQL 的场景里，「这次比上次短了」是用户判断
 * 「我刚才那下点对了吗」最快的信号。
 *
 * 复制永远在顶上：选表就能点，不用先滚完语句（产物优先）。
 * 正文超出预览高度会在框里滚，看完停在底下——那种情况脚上再给一次复制。
 * 下载用得少，只放脚上，不跟复制抢首屏。
 */
import type { ReactNode } from 'react'
import type { Lang } from '../../lib/highlight'
import { Btn } from './Btn'
import { CopyBtn } from './CopyBtn'
import { cx } from './cx'
import { Hl } from './Hl'

interface CodeProps {
  code: string
  lang?: Lang
  /** 工具条左侧的文件名/说明 */
  name?: ReactNode
  /** 给了才出现「下载」按钮，值就是保存的文件名 */
  download?: string
  size?: 'sm' | 'md' | 'lg'
  /** 工具条右侧塞额外按钮（放在复制左边） */
  extra?: ReactNode
  /**
   * 紧挨复制 / 下载（工具条和脚上都出现）。
   * 生成结果的「收藏」走这里，不要塞进 extra——extra 是「在当前连接执行」，脚上没有。
   */
  tools?: ReactNode
  /** 复制真的成功后触发（透传 CopyBtn；我的SQL库靠它计 use_count） */
  onCopied?: () => void
  /** 关掉「N 行 / N 字符」 */
  noMeta?: boolean
  /** 代码为空时显示这句 */
  empty?: ReactNode
  /**
   * 替换整个正文（连高亮一起自己管）。日志转SQL 的打字机效果要用它：
   * 正文在动画期间是一段「还没打完的前缀」，普通高亮接管不了。
   */
  body?: ReactNode
  className?: string
}

/** 超过这个行数，预览框会自己滚（跟 `.code pre` / `.lg` / `.sm` 的高度对齐） */
const PREVIEW_LINES = { sm: 8, md: 14, lg: 18 } as const

function save(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // 立刻 revoke 在部分内核里会让下载拿到空文件，等一帧再放
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function Code({
  code,
  lang = 'sql',
  name,
  download,
  size = 'md',
  extra,
  tools,
  onCopied,
  noMeta,
  empty,
  body,
  className,
}: CodeProps) {
  const lines = code ? code.split('\n').length : 0
  const long = lines > PREVIEW_LINES[size]
  const foot = download !== undefined || long || tools != null

  return (
    <div className={cx('code', className)}>
      <div className="code-bar">
        <span className="fn">{name}</span>
        {!noMeta && (
          <span className="lbl">
            {lines} 行 / {code.length} 字符
          </span>
        )}
        {extra}
        {tools}
        <CopyBtn text={code} onCopied={onCopied} />
      </div>
      <pre className={cx(size !== 'md' && size)}>
        {body !== undefined
          ? body
          : !code && empty !== undefined
            ? <span className="hint">{empty}</span>
            : <Hl code={code} lang={lang} />}
      </pre>
      {foot && (
        <div className="code-foot">
          {download !== undefined && (
            <Btn variant="mini" onClick={() => save(code, download)} disabled={!code}>
              下载
            </Btn>
          )}
          {long && <CopyBtn text={code} onCopied={onCopied} />}
          {tools}
        </div>
      )}
    </div>
  )
}
