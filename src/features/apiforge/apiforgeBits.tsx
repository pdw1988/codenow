/**
 * APIForge 各子页签共用的小件：动词徽章、库变更迷你摘要、带字段含义的响应、
 * 次级设置折叠块、二选一的单选卡组。样式在 _theme.css 的 .apf-verb / .apf-dbmini /
 * .apf-fold / .apf-modes，颜色走主题变量。
 */
import { memo, useMemo, useState, type ReactNode } from 'react'
import { CompassOutlined } from '@ant-design/icons'
import { Btn, CopyBtn, cx, Fold, Tag } from '../../components/ui'

/**
 * 「接口运行 ↔ 数据库」原理的四步说明：一句话——发请求前后各给相关表拍一张
 * 只读快照，两张一对比，接口的真实效果一目了然。首页弹窗与环境页顶部共用
 * 这一份，心智模型只讲一遍，其余触点（调试卡/报告）直接引用它的词汇。
 */
export function HowDbWorks() {
  return (
    <div className="apf-how">
      <p className="apf-how-lead">
        光看 HTTP 状态码会被骗：业务失败也回 200。所以调接口<b>前后</b>，对相关表各做一次
        <b>只读快照</b>，两张一对比——接口新增 / 修改 / 删除了什么一目了然，<b>数据库说了算</b>。
      </p>
      <ol>
        <li>
          <b>认表</b>：扫描时从 MyBatis Mapper 语句认出每个接口读写哪些表；没认准的在接口页「关联表」卡里勾选修正。
        </li>
        <li>
          <b>拍照</b>：发送请求前，把这些表的行数、主键、行内容记下来（只读 SELECT，不动数据）。
        </li>
        <li>
          <b>对比</b>：请求返回后再拍一次，两张相减：新增 +N / 更新 ~N / 删除 −N——出现在调试卡的「数据库变更」和报告里。
        </li>
        <li>
          <b>判定</b>：断言「观察」只把变更列出来，不据此判失败；「严格」按库变更期望判失败——期望由报告页学出、随
          apiforge.yml 交给 CI 无头运行检查。HTTP 200 的假绿靠这两档现形。
        </li>
      </ol>
      <p className="apf-how-extra">
        接口要的数据还没有？跑前会自动备：查询接口借库里现成的一条，改 / 删接口先造一条自己的、
        跑完删掉；备不出来的，在环境页「数据准备 · 手工补值」里补一个。
      </p>
      <p className="apf-how-safe">
        安全边界：快照永远只读；数据准备只清自己造的那几行，库里其他数据不动。
      </p>
    </div>
  )
}

/**
 * 单选卡组。二选一的设置项用它，不用 Seg。
 *
 * Seg 只摆得下选项名，解释只能塞进 hover 才可见的 title —— 而「观察 / 严格」
 * 「自动准备 / 不准备」这类选项名**不解释等于没写**（用户原话：「观察是什么
 * 意思，严格又是什么」）。卡里放得下三行：做什么、什么时候用、在哪生效。
 *
 * `role="radiogroup"` + `role="radio"`：键盘和读屏都按单选语义走，比一排
 * 装成按钮的 div 更接近原生 radio 的行为。样式在 `_theme.css` 的 `.apf-modes`。
 */
export interface ChoiceCardItem<T extends string> {
  value: T
  name: string
  what: string
  when: string
  /** 名字后面的小标签，如「默认」 */
  tag?: string
}

export function ChoiceCards<T extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label: string
  items: ReadonlyArray<ChoiceCardItem<T>>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="apf-modes" role="radiogroup" aria-label={label}>
      {items.map((m) => (
        <button
          key={m.value}
          type="button"
          role="radio"
          aria-checked={m.value === value}
          className={cx('apf-mode', m.value === value && 'on')}
          onClick={() => onChange(m.value)}
        >
          <span className="apf-mode-h">
            <i className="apf-mode-dot" />
            {m.name}
            {m.tag && <Tag tone="hi">{m.tag}</Tag>}
          </span>
          <span className="apf-mode-b">{m.what}</span>
          <span className="apf-mode-b dim">{m.when}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * 自管开关的折叠块：码上测各页「次级设置」的统一收口件（层次感三段式：
 * 主链路平铺 → 细节折叠 → 深水区折叠，折叠头永远带当前值摘要，
 * 折起 ≠ 看不见配置了什么）。展开状态归块自己管；ui/Fold 的受控形态
 * 留给「页面要一键全收」的场景。forceOpen 给搜索态等必须全放开的时刻。
 */
export function ApfFold(props: {
  title: ReactNode
  /** 折着也要看得见的当前值，如「自动 · 样本 2 条」 */
  summary?: ReactNode
  forceOpen?: boolean
  /** 内容不多时可以默认展开（如只有一个工程），折叠是为多内容准备的 */
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false)
  const on = props.forceOpen || open
  return (
    <Fold
      open={on}
      onToggle={setOpen}
      className="apf-fold"
      head={
        <>
          <span className="apf-fold-title">{props.title}</span>
          {props.summary != null && props.summary !== '' && (
            <span className="apf-fold-sum">{props.summary}</span>
          )}
        </>
      }
    >
      {props.children}
    </Fold>
  )
}
import { annotateJsonKeys } from '../../lib/apiforge/http/annotateJson'
import { fieldDocsOf, fieldHint } from '../../lib/apiforge/fieldHint'
import type { DtoField, ScannedType, TableChange } from '../../lib/apiforge/types'
import { runSteps } from '../../lib/apiforge/runner/runSteps'

/** 跑批步骤条：备用例 → 登录 → 跑用例 → 出报告，跑批中挂在报告页顶部 */
export function RunSteps({ progress, needLogin }: { progress: { done: number; total: number }; needLogin: boolean }) {
  return (
    <div className="apf-steps">
      {runSteps(progress, needLogin).map((s, i) => (
        <div key={s.label} className={`apf-step ${s.state}`}>
          <i>{s.state === 'done' ? '✓' : s.state === 'active' ? '●' : i + 1}</i>
          <b>{s.label}</b>
          <span>{s.detail}</span>
        </div>
      ))}
    </div>
  )
}

/** GET/POST/PUT/DELETE/PATCH 徽章（对齐原型：GET 蓝、POST 绿、PUT 黄、DELETE 红、PATCH 紫） */
export function Verb({ method }: { method: string }) {
  const m = (method || '?').toUpperCase()
  return <span className={`apf-verb m-${m.toLowerCase()}`}>{m}</span>
}

/** 报告表格里的库变更迷你摘要：每张表一行 `t_user +1`，无写变更显示灰字 */
export function DbMini({ changes }: { changes: TableChange[] }) {
  if (!changes.length) return <span className="apf-dim">—</span>
  const writers = changes.filter((c) => c.rowsInserted || c.rowsUpdated || c.rowsDeleted)
  if (!writers.length) return <span className="apf-dbnone">无写变更</span>
  return (
    <span className="apf-dbmini">
      {writers.map((c) => (
        <span key={c.tableName}>
          {c.tableName}{' '}
          {c.rowsInserted ? `+${c.rowsInserted}` : ''}
          {c.rowsUpdated ? `~${c.rowsUpdated}` : ''}
          {c.rowsDeleted ? `−${c.rowsDeleted}` : ''}
        </span>
      ))}
    </span>
  )
}

/**
 * HTTP 响应：行末标字段含义（扫描说明优先，常见名兜底）。
 * 复制按钮给不含注释的原文，粘出去仍能 JSON.parse。
 *
 * `onJsonPath` 给了才摆「去 JSON 查看」：把这段响应体带过去展开看、搜字段。
 * 只在像 JSON 时给（`jsonLike`）——HTML 错误页、纯文本 OK 里没什么可查的。
 * memo + 缓存注释拆行：展开后几万行，父级打字或计时时不该跟着重算。
 * onJsonPath 要稳定（父级 useCallback），否则 memo 白设。
 */
export const ResponsePreview = memo(function ResponsePreview({
  text,
  full,
  types,
  extra,
  onJsonPath,
}: {
  text: string
  /** 完整响应；text 被截断时才给，给了就摆「展开全部」 */
  full?: string
  types?: readonly ScannedType[]
  extra?: readonly DtoField[]
  onJsonPath?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const body = expanded && full ? full : text
  const lines = useMemo(() => {
    if (!body) return []
    const docs = fieldDocsOf(types, extra)
    return annotateJsonKeys(body, (k) => fieldHint(k, docs)).split('\n')
  }, [body, types, extra])
  if (!text) return <pre className="apf-code">—</pre>
  const jsonLike = /^\s*[[{]/.test(text)
  return (
    <>
      <div className="apf-respbar">
        {onJsonPath && jsonLike && (
          <Btn
            variant="mini"
            title="把完整响应体带过去，在 JSON 查看页里展开、搜字段"
            onClick={onJsonPath}
          >
            <CompassOutlined aria-hidden="true" /> 去 JSON 查看
          </Btn>
        )}
        {full && (
          <Btn variant="mini" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '收起' : `展开全部（${full.length.toLocaleString()} 字符）`}
          </Btn>
        )}
        <CopyBtn text={full || text} title={jsonLike ? '复制不含注释的原文，可直接 JSON.parse' : '复制原文'}>
          {jsonLike ? '复制 JSON' : '复制'}
        </CopyBtn>
      </div>
      {/* 展开后放到 70vh，否则全文仍挤在原来的矮框里 */}
      <pre className={expanded && full ? 'apf-code apf-code-full' : 'apf-code'}>
        {lines.map((line, i) => {
          const cut = line.lastIndexOf('  // ')
          const hint = cut >= 0 ? line.slice(cut) : ''
          const body = cut >= 0 ? line.slice(0, cut) : line
          return (
            <span key={i}>
              {body}
              {hint ? <span className="apf-jsonhint">{hint}</span> : null}
              {i < lines.length - 1 ? '\n' : null}
            </span>
          )
        })}
      </pre>
    </>
  )
})
