/**
 * 方言 + 注释头两个控件。单表页和多表页各有一份配置，抽出来是为了
 * 让两页的控件顺序、间距、文案完全一致——拆页最容易出现的问题就是
 * 「同一件事在两个地方长成两个样子」。
 */
import type { Dialect } from '../../types/schema'
import { DIALECT_OPTIONS } from '../../lib/sqlgen/dialect'
import { Cb, Lbl, Row, Seg, Spacer } from '../../components/ui'

interface Props {
  dialect: Dialect
  onDialectChange: (d: Dialect) => void
  withHeader: boolean
  onWithHeaderChange: (v: boolean) => void
}

export function DialectBar({
  dialect,
  onDialectChange,
  withHeader,
  onWithHeaderChange,
}: Props) {
  return (
    <Row tight>
      <Lbl>方言</Lbl>
      <Seg options={DIALECT_OPTIONS} value={dialect} onChange={onDialectChange} />
      <Spacer />
      <Cb checked={withHeader} onChange={onWithHeaderChange}>
        注释头
      </Cb>
    </Row>
  )
}
