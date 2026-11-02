/**
 * 批量 INSERT / UPDATE 两页共用的控件。
 *
 * 规则引擎、预览抽样、结果卡都是同一套——拆页是为了别把两种语句的配置
 * 挤在一屏互相显隐，不是为了抄两份生成逻辑。字段规则换了参数，两页必须一起变。
 */
import { useState, type ReactNode } from 'react'
import type { Column, Dialect, TableInfo } from '../../types/schema'
import { requiresDistinct } from '../../types/schema'
import { DIALECT_OPTIONS } from '../../lib/sqlgen/dialect'
import {
  displayCell,
  RULE_KINDS,
  RULE_PARAMS,
  type BatchResult,
  type RuleKind,
  type RuleMap,
} from '../../lib/sqlgen/batchGen'
import {
  Band,
  Card,
  Cb,
  Code,
  EmptyBox,
  Fld,
  Hint,
  Lbl,
  Mono,
  Row,
  Sel,
  Seg,
  Spacer,
  Stack,
  Tbl,
  type TblCol,
} from '../../components/ui'
import { TablePick } from '../../components/TablePick'
import { ExecOnConn } from '../sqlgen/ExecOnConn'
import { FavSqlBtn } from '../sqlfav/FavSqlBtn'

export function TableAndDialect({
  tables,
  table,
  dialect,
  who,
  onTableChange,
  onDialectChange,
  extra,
}: {
  tables: TableInfo[]
  table: TableInfo
  dialect: Dialect
  who?: string
  onTableChange: (name: string) => void
  onDialectChange: (d: Dialect) => void
  extra?: ReactNode
}) {
  return (
    <Card hero title="① 选表和方言" who={who} className="form-card">
      <Stack>
        <Row tight>
          <Lbl>当前表</Lbl>
          <div className="fc-grow">
            <TablePick
              tables={tables}
              value={table.name}
              onChange={onTableChange}
              aria-label="当前表"
            />
          </div>
        </Row>
        <Row tight>
          <Lbl>方言</Lbl>
          <Seg options={DIALECT_OPTIONS} value={dialect} onChange={onDialectChange} />
        </Row>
        {extra}
      </Stack>
    </Card>
  )
}

/** 一行字段规则。INSERT 全列（自增列锁定），UPDATE 只列非主键列并带勾选框 */
export function RuleRow({
  c,
  forInsert,
  rules,
  setOn,
  sid,
  table,
  dialect,
  onPickKind,
  onEditParam,
  onToggleSet,
}: {
  c: Column
  forInsert: boolean
  rules: RuleMap
  setOn?: Record<string, boolean>
  sid: number | null
  table: TableInfo
  dialect: Dialect
  onPickKind: (col: string, k: RuleKind) => void
  onEditParam: (col: string, slot: 'a' | 'b', v: string) => void
  onToggleSet?: (col: string, v: boolean) => void
}) {
  const r = rules[c.name]
  const k: RuleKind = r?.k ?? 'auto'
  // 自增 / 主键 / 单列唯一：不能走「沿用自动值」。散列会撞 UNIQUE，插不进去。
  const lockSerial = forInsert && (c.isAutoIncrement || requiresDistinct(c))
  const serialFrom = sid ?? 1
  return (
    <Row key={c.name} style={{ flexWrap: 'wrap' }}>
      {!forInsert && onToggleSet && (
        <Cb
          checked={!!setOn?.[c.name]}
          title={c.comment || c.name}
          onChange={(v) => onToggleSet(c.name, v)}
        />
      )}
      <Mono>{c.name}</Mono>
      <Hint>{c.comment}</Hint>
      {lockSerial ? (
        // 禁用规则下拉必须说出原因：点了没反应比报错更让人困惑
        <Hint>
          {c.isAutoIncrement && sid === null
            ? `${c.comment ?? ''} · 自动排除`.trimStart()
            : `${c.comment ?? ''} · ${serialFrom} 起连续编号（主键/唯一列）`.trimStart()}
        </Hint>
      ) : (
        <>
          <Sel
            value={k}
            onChange={(v) => onPickKind(c.name, v as RuleKind)}
            options={RULE_KINDS.map((o) => ({ value: o.v, label: o.l }))}
            style={{ width: 150 }}
            aria-label={`${c.name} 的生成规则`}
          />
          {(RULE_PARAMS[k] ?? []).map((sp) => (
            <Fld
              key={sp.slot}
              value={r?.p?.[sp.slot] ?? sp.dft}
              placeholder={sp.ph}
              title={sp.tt}
              aria-label={`${c.name} 规则参数 ${sp.ph}`}
              style={{ width: 108 }}
              onChange={(e) => onEditParam(c.name, sp.slot, e.target.value)}
            />
          ))}
        </>
      )}
      <Spacer />
      {/* Hint 组件没有 title 位，预览值的悬停说明就地用原生 span 挂 */}
      <span className="hint" title="第 1 行的预览值">
        {(() => {
          const v = displayCell(
            table,
            c,
            1,
            rules,
            forInsert ? 'insert' : 'update',
            dialect,
            sid,
          )
          return v === '' ? '（参数未填）' : v
        })()}
      </span>
    </Row>
  )
}

export function PreviewBody({ result }: { result: BatchResult | null }) {
  const pv = result?.preview
  if (!pv) return <EmptyBox>补齐左侧配置后，这里抽样展示</EmptyBox>
  if (pv.kind === 'text')
    return (
      <pre
        style={{
          margin: 0,
          whiteSpace: 'pre-wrap',
          fontFamily: 'var(--mono)',
          fontSize: 12.5,
          lineHeight: 1.6,
        }}
      >
        {pv.text}
      </pre>
    )
  interface PvRow {
    i: number
    vals: string[]
  }
  const rows: PvRow[] = pv.cells.map((vals, i) => ({ i, vals }))
  const cols: Array<TblCol<PvRow>> = [
    {
      key: '#',
      title: '#',
      cls: 'mono',
      render: (r) => <span className="muted">{r.i + 1}</span>,
    },
    ...pv.columns.map((c, ci) => ({
      key: c.name,
      title: c.name,
      render: (r: PvRow) => <span className="mono">{r.vals[ci]}</span>,
    })),
  ]
  return <Tbl scroll cols={cols} rows={rows} rowKey={(r) => String(r.i)} />
}

/** 右栏：生成结果永远第一张；预览默认折起，要核对抽样再展开 */
export function BatchResultCol({
  result,
  fileName,
  dialect,
}: {
  result: BatchResult | null
  fileName: string
  dialect: Dialect
}) {
  const [prevOpen, setPrevOpen] = useState(false)
  return (
    <>
      <Card title="生成结果" who={result?.stat || undefined}>
        <Stack gap={8}>
          {(result?.warnings ?? []).map((w, i) => (
            <Band key={i} tone={w.tone}>
              {w.msg}
            </Band>
          ))}
          <Code
            code={result?.sql ?? ''}
            name={fileName}
            download={fileName}
            size="lg"
            extra={<ExecOnConn sql={result?.sql ?? ''} dialect={dialect} />}
            tools={<FavSqlBtn sql={result?.sql ?? ''} />}
          />
        </Stack>
      </Card>
      <Card
        title="预览"
        who={result?.previewLabel || undefined}
        open={prevOpen}
        onToggle={setPrevOpen}
      >
        <PreviewBody result={result} />
      </Card>
    </>
  )
}
