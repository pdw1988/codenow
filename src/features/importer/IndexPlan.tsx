/**
 * 索引落地清单。
 *
 * 优化建议是按规则一条条报的，同一条 `t_order(buyer_name)` 会被「等值条件没有索引」
 * 和「JOIN 关联列没有索引」各报一次，用户读完十几条建议，还是得自己翻「到底要给
 * 哪几个列建索引」。这里把 `advise()` 汇总好的清单整份摆出来：表、列、为什么、
 * 按方言生成好的 DDL。
 *
 * DDL 一句不缺是重点：只写「给 order_no 加索引」的话，用户还得自己去翻
 * MySQL 的 ALTER TABLE、Oracle 的 ONLINE、SQLite 的 ANALYZE。
 *
 * 清单自己带「在当前连接执行」：用户要的是「在这个工具里把事办完」，
 * 复制出去再开一个客户端建索引，等于把最后一步又推回给他。执行走
 * `ExecAlterOnConn`——跟编辑表结构、粘贴 ALTER 是同一条闸门、同一个确认框，
 * 不新开写路径。
 */
import type { Dialect } from '../../types/schema'
import type { IndexNeed } from '../../lib/sqladvise'
import { CopyBtn } from '../../components/ui'
import { ExecAlterOnConn } from '../schema/ExecAlterOnConn'

/** 整份抄走的脚本：每条索引前面带一行注释说明它是被哪条建议推出来的 */
function scriptOf(items: IndexNeed[]): string {
  return items
    .map((n) =>
      [
        `-- ${n.table}(${n.cols.join(', ')})：${n.reasons.map((r) => r.title).join('；')}`,
        n.ddl,
      ].join('\n'),
    )
    .join('\n\n')
}

export function IndexPlan({
  items,
  dialect,
  onExecuted,
}: {
  items: IndexNeed[]
  /** 当前连接的方言。执行入口只在这一种方言下亮着 */
  dialect: Dialect
  /** 库上跑完之后：清索引缓存、让体检重算。同一个索引不该再报一遍 */
  onExecuted?: () => void
}) {
  if (items.length === 0) return null
  const script = scriptOf(items)
  return (
    <div className="idxplan">
      <div className="idxplan-head">
        <b>索引落地</b>
        <span className="idxplan-n">建议加 {items.length} 个索引</span>
        <span className="idxplan-act">
          <CopyBtn text={script} title="把这一整份抄走，粘到别处执行">
            复制全部 DDL
          </CopyBtn>
          <ExecAlterOnConn
            sql={script}
            dialect={dialect}
            onApplied={async () => {
              onExecuted?.()
            }}
          />
        </span>
      </div>
      {items.map((n) => (
        // 键用表 + 列：同一个键在 advise() 里已经去过重，这里不会再撞
        <div key={`${n.table}(${n.cols.join(', ')})`} className="adv-item">
          <div className="adv-main">
            <div className="adv-title">
              <i className="adv-dot" aria-hidden />
              <code className="idxrow-cols">
                {n.table}({n.cols.join(', ')})
              </code>
            </div>
            <div className="adv-why">{n.reasons.map((r) => r.title).join('；')}</div>
          </div>
          <div className="adv-fix">
            <pre>{n.ddl}</pre>
            <CopyBtn text={n.ddl} title="复制这一条建索引语句">
              复制
            </CopyBtn>
          </div>
        </div>
      ))}
    </div>
  )
}
