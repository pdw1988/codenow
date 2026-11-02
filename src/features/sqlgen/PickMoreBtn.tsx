/**
 * 字段清单的「加载更多 / 收起」按钮。逻辑（展开状态）在 usePickMore.tsx；
 * 拆开是因为 hook 和组件混在一个文件里 fast refresh 会失效。
 */
import type { ReactNode } from 'react'
import { Btn } from '../../components/ui'

export function PickMoreBtn({
  moreCount,
  moreOpen,
  hiddenChecked,
  onToggle,
  /** 收起后已勾仍进 WHERE / SELECT 的提示文案里用「SQL」或「条件」 */
  keepHint = 'SQL',
}: {
  moreCount: number
  moreOpen: boolean
  hiddenChecked: boolean
  onToggle: () => void
  keepHint?: string
}): ReactNode {
  if (moreCount <= 0) return null
  return (
    <Btn
      variant="mini"
      className="pick-more"
      onClick={onToggle}
      title={
        moreOpen
          ? `收起后仍只显示关键列；已勾选的其它字段继续进 ${keepHint}`
          : hiddenChecked
            ? `还有 ${moreCount} 个字段（其中有已勾选的，收起后仍进 ${keepHint}）`
            : `还有 ${moreCount} 个字段`
      }
    >
      {moreOpen
        ? '收起'
        : hiddenChecked
          ? `加载更多（${moreCount}，含已勾）`
          : `加载更多（${moreCount}）`}
    </Btn>
  )
}
