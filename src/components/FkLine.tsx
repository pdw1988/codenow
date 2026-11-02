/**
 * 一条外键关系：`order.user_id → user.id` + 可信度标签。
 *
 * 方向靠箭头本身表达，不靠「从表/主表」这种词 —— 中文里这两个词太容易读反，
 * 而读反的后果是 JOIN 写反。`dir` 说的是**站在当前这张表看**：
 * out = 我引用别人（我是从表），in = 别人引用我（我是主表）。
 */
import type { ForeignKey } from '../types/schema'
import { ConfidenceTag } from './ConfidenceTag'

interface Props {
  fk: ForeignKey
  dir: 'out' | 'in'
  /** 右边再挂点东西（勾选框、跳转按钮之类） */
  children?: React.ReactNode
}

export function FkLine({ fk, dir, children }: Props) {
  return (
    <div className="fkline">
      <span>
        {fk.fromTable}.{fk.fromColumn}
      </span>
      <span className="arw">{dir === 'out' ? '→' : '←'}</span>
      <span>
        {fk.toTable}.{fk.toColumn}
      </span>
      <ConfidenceTag confidence={fk.confidence} constraintName={fk.constraintName} />
      {children}
    </div>
  )
}
