/**
 * UI 原子层的出口。业务代码只从 `components/ui` 引，不要深引具体文件 ——
 * 这样以后拆/合文件不用改调用点。
 *
 * 这一层的铁律：**不许出现颜色、字号、间距的字面量**。全部靠 `_theme.css` 的类和变量，
 * 因为要同时活在 5 套主题下，写死一处就等于有 4 套是坏的。
 * 需要区分语义时，参数收「语气」（tone: ok/warn/bad/...），不收颜色。
 */
export { cx } from './cx'

export {
  Auto,
  Band,
  Chip,
  Chips,
  Col,
  EmptyBox,
  Hint,
  Kbd,
  Lbl,
  Mono,
  Row,
  Sep,
  Spacer,
  Split,
  Stack,
  Stat,
  Stats,
  Tag,
} from './bits'
export type { BandTone, TagTone } from './bits'

export { Btn } from './Btn'
export { Card } from './Card'
export { Cb } from './Cb'
export { Code } from './Code'
export { CopyBtn } from './CopyBtn'
export { Dlg } from './Dlg'
export { Fld, Sel, TextArea } from './Fld'
export type { SelOption } from './Fld'
export { PopSel } from './PopSel'
export { Fold } from './Fold'
export { GuideEmpty } from './GuideEmpty'
export { Hl } from './Hl'
export { Seg } from './Seg'
export type { SegOption } from './Seg'
export { Tbl } from './Tbl'
export type { TblCol } from './Tbl'
export { WaitMask } from './WaitMask'
export { useCopy } from './useCopy'
export { useWidthDrag } from './useWidthDrag'
export type { CopyState } from './useCopy'
