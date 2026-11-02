/**
 * 方言选择器。选项一律来自 `DIALECT_OPTIONS`，也就是 `dialect.ts` 里
 * `DIALECTS` 的键顺序（oracle → mysql → postgresql → sqlite）。
 *
 * 全项目所有方言选择都从这里出，是为了钉住「页面所有的方言顺序都一样」：
 * 几个页面各写一份 options 数组，加一种方言就得改多处，漏一处的表现是
 * 同一个下拉在两页里顺序不同 —— 用户会以为自己点错了。
 */
import type { Dialect } from '../types/schema'
import { DIALECT_OPTIONS } from '../lib/sqlgen/dialect'
import { Seg, Sel } from './ui'

interface Props {
  value: Dialect
  onChange: (dialect: Dialect) => void
  className?: string
}

/** 摆开的按钮。地方够就用它 —— 展开摆着等于在说「支持这几种」 */
export function DialectSeg({ value, onChange, className }: Props) {
  return <Seg options={DIALECT_OPTIONS} value={value} onChange={onChange} className={className} />
}

/** 收起来的下拉。弹窗里、表格单元格里这种真放不下的地方用 */
export function DialectSel({ value, onChange, className }: Props) {
  return <Sel options={DIALECT_OPTIONS} value={value} onChange={onChange} className={className} />
}
