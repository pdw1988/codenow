/**
 * 复制按钮。**成功/失败的反馈就在按钮自己身上**，不弹 toast ——
 * 用户的眼睛在按钮上，反馈出现在屏幕角落等于没有反馈。
 *
 * 文案集中在这里而不是各调用点自己写，是因为「✓ 已复制」这种状态文案
 * 一旦有两份，改一处就有一处不一样。
 */
import type { ReactNode } from 'react'
import { Btn } from './Btn'
import { useCopy, type CopyState } from './useCopy'

const LABEL: Record<CopyState, string> = {
  idle: '复制',
  ok: '✓ 已复制',
  fail: '✗ 复制失败',
}

export function CopyBtn({
  text,
  children,
  onCopied,
  disabled,
  title,
}: {
  text: string
  children?: ReactNode
  /** 复制真的成功后才触发（我的SQL库靠它计 use_count——失败还计数，数据就虚了） */
  onCopied?: () => void
  disabled?: boolean
  title?: string
}) {
  const { state, copy } = useCopy()

  return (
    <Btn
      variant="mini"
      title={title}
      onClick={() => {
        void copy(text).then((ok) => {
          if (ok) onCopied?.()
        })
      }}
      disabled={disabled || !text}
      on={state === 'ok'}
    >
      {state === 'idle' && children !== undefined ? children : LABEL[state]}
    </Btn>
  )
}
