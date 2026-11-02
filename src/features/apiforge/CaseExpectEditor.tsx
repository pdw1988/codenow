/**
 * 期望状态码 + 响应体断言的编辑区。报告页处理抽屉和接口页用例卡共用；受控，保存时机由调用方定。
 */
import { Fld, Sel } from '../../components/ui'
import type { BodyExpect, BodyExpectOp } from '../../lib/apiforge/types'

/** 判定符（「不存在」排第一：HTTP 200 的业务失败信封最常断的就是它） */
const BODY_EXPECT_OPS: { op: BodyExpectOp; label: string }[] = [
  { op: 'notExists', label: '不存在' },
  { op: 'exists', label: '存在' },
  { op: '==', label: '等于' },
  { op: '!=', label: '不等于' },
  { op: 'contains', label: '包含' },
  { op: 'notContains', label: '不包含' },
]

const noValue = (op: BodyExpectOp) => op === 'exists' || op === 'notExists'

export function CaseExpectEditor({
  status,
  onStatus,
  expects,
  onExpects,
  hint,
}: {
  /** 状态码输入框原文（「200,201」），保存时用 parseExpectStatus 解析 */
  status: string
  onStatus: (v: string) => void
  expects: BodyExpect[]
  onExpects: (next: BodyExpect[]) => void
  hint?: string
}) {
  const patch = (i: number, p: Partial<BodyExpect>) => onExpects(expects.map((x, j) => (j === i ? { ...x, ...p } : x)))
  return (
    <>
      <label className="apf-expectedit">
        期望状态码（逗号分隔，留空不校验）
        <Fld value={status} placeholder="200,201" onChange={(e) => onStatus(e.target.value)} />
      </label>
      <div className="apf-panel-h subtle">响应体断言</div>
      {expects.map((ex, i) => (
        <div key={i} className="apf-exprow">
          <Fld value={ex.path} placeholder="$.level" title="取值路径，如 $.data.id" onChange={(e) => patch(i, { path: e.target.value })} />
          <Sel<BodyExpectOp>
            className="apf-exprow-op"
            value={ex.op}
            title="判定方式"
            options={BODY_EXPECT_OPS.map((o) => ({ value: o.op, label: o.label }))}
            onChange={(op) => patch(i, { op })}
          />
          <Fld
            value={ex.value}
            placeholder={noValue(ex.op) ? '（这种判定不用填值）' : '期望值'}
            disabled={noValue(ex.op)}
            onChange={(e) => patch(i, { value: e.target.value })}
          />
          <button className="apf-linkbtn" title="删除这条断言" onClick={() => onExpects(expects.filter((_, j) => j !== i))}>
            删除
          </button>
        </div>
      ))}
      <div className="apf-exprow-add">
        <button className="apf-linkbtn" onClick={() => onExpects([...expects, { path: '', op: 'notExists', value: '' }])}>
          + 添加断言
        </button>
        {hint && <span className="apf-hint apf-gap-left">{hint}</span>}
      </div>
    </>
  )
}
