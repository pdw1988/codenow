/**
 * 外键关系展示，对应 PRD 3.3 的「外键关系」区块。
 *
 * 两个方向分开列，因为开发时关心的问题不同：
 * - 引用了谁 → 决定 JOIN 时往哪边挂
 * - 被谁引用 → 决定删数据会不会崩
 *
 * 一条都没有时也要出一行字，并且说清「为什么没有」：
 * 空白会被读成「这功能坏了」，而真实原因（没建约束、字段名也不像 xxx_id）
 * 恰好是用户接下来要处理的事。
 */
import { FkLine } from '../../components/FkLine'
import { Hint, Lbl } from '../../components/ui'
import type { ForeignKey } from '../../types/schema'

interface ForeignKeyListProps {
  /** 当前表引用别人 */
  outgoing: ForeignKey[]
  /** 别人引用当前表 */
  incoming: ForeignKey[]
}

export function ForeignKeyList({ outgoing, incoming }: ForeignKeyListProps) {
  const total = outgoing.length + incoming.length

  if (total === 0) {
    return (
      <div className="fkbox">
        <Hint>无外键关系：未声明 FOREIGN KEY，字段名亦无法按 xxx_id 推断。</Hint>
      </div>
    )
  }

  return (
    <div className="fkbox">
      <Lbl>外键关系 · {total} 条</Lbl>

      {outgoing.length > 0 && (
        <>
          <Hint>引用了其他表（当前表为从表）</Hint>
          {outgoing.map((fk) => (
            <FkLine key={`out-${fk.fromColumn}-${fk.toTable}-${fk.toColumn}`} fk={fk} dir="out" />
          ))}
        </>
      )}

      {incoming.length > 0 && (
        <>
          <Hint>被其他表引用（当前表为主表）</Hint>
          {incoming.map((fk) => (
            <FkLine key={`in-${fk.fromTable}-${fk.fromColumn}`} fk={fk} dir="in" />
          ))}
        </>
      )}
    </div>
  )
}
