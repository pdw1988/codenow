/**
 * 字段清单「加载更多 / 收起」共用逻辑。
 * 查询字段、条件字段都走这一套：默认只露 PK/UK/IDX/日期。
 *
 * 按钮在 PickMoreBtn.tsx——hook 和组件混在一个文件里 fast refresh 会失效，
 * 所以按「一个文件一种导出」拆开。
 */
import { useState } from 'react'
import { splitPickColumns } from '../../lib/columnPick'
import type { ColumnOrderInput } from '../../lib/columnOrder'

export function usePickMoreColumns<T extends ColumnOrderInput>(columns: readonly T[]) {
  const { shown, more } = splitPickColumns(columns)
  const moreKey = more.map((c) => c.name).join('\0')
  const [moreOpen, setMoreOpen] = useState(false)
  const [seenMoreKey, setSeenMoreKey] = useState(moreKey)
  if (moreKey !== seenMoreKey) {
    setSeenMoreKey(moreKey)
    setMoreOpen(false)
  }

  const visible = moreOpen ? [...shown, ...more] : shown
  return {
    shown,
    more,
    moreOpen,
    setMoreOpen,
    visible,
    toggleMore: () => setMoreOpen((v) => !v),
  }
}
