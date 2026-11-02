/**
 * 优化建议列表。
 *
 * 连库查询的「优化建议」卡和「优化记录」页的详情都画它。原先内联在 DbQuery 里，
 * 历史记录要做同一份展示时再抄一遍就成了两份规则——以后改建议条目的长相只改这里。
 *
 * 左右两栏：左边结论 + 为什么，右边能直接抄走的修复。一栏一条的话，
 * 一条建议要占 70px 左右，面板一屏只看得到一两条。
 *
 * `lead` 插在列表最前面：连库查询把「索引落地」清单放这儿，它是十几条建议里
 * 唯一能直接执行的部分，不该埋在第 8 条底下。不传就还是纯建议列表
 * （优化记录页的详情不显示它——历史里存的是当时的结论，不是待办清单）。
 *
 * `onLocate` / `onApply` 只有连库查询给。点条目主体在 SQL 框里选中触发片段
 * （引擎给的 at 偏移）；带 apply 的（SELECT * 展开）再给「应用到 SQL」按钮。
 * 优化记录页两个都不传：历史里存的是当时的偏移，对着现在的输入框早对不上号，
 * 可点反而是在骗人。
 */
import type { ReactNode } from 'react'
import type { SqlAdvice } from '../../lib/sqladvise'
import { Btn, CopyBtn } from '../../components/ui'

export function AdviceItems({ items, lead, onLocate, onApply }: {
  items: SqlAdvice[]
  lead?: ReactNode
  /** 点条目主体：把触发片段在 SQL 输入框里选中。不传 = 不可点 */
  onLocate?: (a: SqlAdvice) => void
  /** 一键改写应用回 SQL 输入框。不传 = 不出按钮 */
  onApply?: (a: SqlAdvice) => void
}) {
  return (
    <div className="adv-list">
      {lead}
      {items.map((a) => {
        const locatable = !!onLocate && !!a.at
        return (
          <div
            key={`${a.id}·${a.scene ?? ''}`}
            className={`adv-item adv-${a.severity}${locatable ? ' adv-locatable' : ''}`}
            onClick={locatable ? () => onLocate(a) : undefined}
            title={locatable ? '点击在 SQL 里定位这段' : undefined}
          >
            <div className="adv-main">
              <div className="adv-title">
                <i className="adv-dot" aria-hidden />
                <span>{a.title}</span>
                {a.scene && <code className="adv-scene">{a.scene}</code>}
              </div>
              <div className="adv-why">{a.why}</div>
            </div>
            {(a.fix || (onApply && a.apply)) && (
              /* 右栏整体挡掉冒泡：点按钮不能顺带触发左边的定位 */
              <div className="adv-fix" onClick={(e) => e.stopPropagation()}>
                {a.fix && <pre>{a.fix}</pre>}
                <div className="adv-fixbtns">
                  {onApply && a.apply && (
                    <Btn
                      variant="mini"
                      onClick={() => onApply(a)}
                      title="把改写替换进 SQL 输入框（不自动运行）"
                    >
                      应用到 SQL
                    </Btn>
                  )}
                  {a.fix && (
                    <CopyBtn text={a.fix} title="复制修复内容">
                      {a.fixKind === 'sql' ? '复制 SQL' : '复制'}
                    </CopyBtn>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
