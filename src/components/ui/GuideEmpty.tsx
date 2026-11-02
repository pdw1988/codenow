/**
 * 引导式空态：「这是哪 → 几步怎么到位 → 主操作」。整页/整卡没数据时用它；
 * 卡里一句话就能说清的还是用 EmptyBox。样式在 _theme.css 的 .apf-emptystate。
 */
import type { ReactNode } from 'react'
import { Btn } from './Btn'

export function GuideEmpty(props: {
  /** 单色图标件（@ant-design/icons），不用彩色 emoji——大空态的图标最大，越大越扎眼 */
  icon: ReactNode
  title: string
  /** 这页有数据之后是什么样，一两句说清 */
  desc: string
  /** 从零到有数据的路径，2~3 步，别写成使用手册 */
  steps: ReactNode[]
  /** 主操作；配置就在本页的可以不给 */
  action?: { label: string; onClick: () => void }
  /** 次操作，排在主操作右边 */
  secondary?: { label: string; onClick: () => void }
}) {
  return (
    <div className="apf-emptystate">
      <div className="apf-emptystate-ico" aria-hidden>
        {props.icon}
      </div>
      <h3>{props.title}</h3>
      <p className="apf-emptystate-desc">{props.desc}</p>
      <ol className="apf-emptystate-steps">
        {props.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      {props.action && (
        <Btn variant="primary" onClick={props.action.onClick}>
          {props.action.label}
        </Btn>
      )}
      {props.secondary && (
        <Btn className="apf-emptystate-2nd" onClick={props.secondary.onClick}>
          {props.secondary.label}
        </Btn>
      )}
    </div>
  )
}
