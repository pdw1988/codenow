/**
 * 关联关系确认面板，PRD 4.3（原型 mockup/sqlgen.html 的「③ 关联关系」卡）。
 *
 * 这个面板的存在理由：命名推断出来的关联是猜的，猜错了生成的 JOIN
 * 就是错的 SQL。所以不能默认勾上直接生成——绿色（真外键约束）默认勾，
 * 橙色（命名推断）默认不勾，逼用户看一眼。卡片头那句 who 写的就是这条规则。
 *
 * JOIN 类型只给 LEFT / INNER 两个选项（原型同款）：从表可能没有匹配记录时用 LEFT，
 * 否则主表记录会被过滤掉；RIGHT JOIN 在「主表 LEFT 从表」的世界里没有正着用的场景，
 * 摆出来只是多一个能选错的选项。
 */
import { Band, Cb, EmptyBox, Hint, Seg, Spacer, Tag } from '../../components/ui'
import { CheckCircleOutlined, WarningOutlined } from '@ant-design/icons'
import type { JoinType } from '../../types/schema'
import { fkKey, type JoinLink } from '../../lib/sqlgen/multiTable'

const JOIN_OPTIONS = [
  { value: 'LEFT', label: 'LEFT' },
  { value: 'INNER', label: 'INNER' },
] as const

interface RelationPanelProps {
  links: JoinLink[]
  onChange: (links: JoinLink[]) => void
  /** 被丢弃的孤立关联（跟主表连不通），生成后回填提示 */
  droppedKeys?: string[]
}

export function RelationPanel({ links, onChange, droppedKeys = [] }: RelationPanelProps) {
  if (!links.length) {
    return <EmptyBox>这张表没有任何关联，只能生成单表 SQL</EmptyBox>
  }

  return (
    <>
      {droppedKeys.length > 0 && (
        <Band tone="err" title={`${droppedKeys.length} 个关联跟主表连不通，已从生成结果中排除`}>
          {droppedKeys.join('、')}
        </Band>
      )}

      {links.map((l) => (
        <div className="rel" key={fkKey(l.fk)}>
          {/* 命名推断的勾选框给 dim（橙勾）：颜色本身就是「这个要你确认」的信号 */}
          <Cb
            checked={l.enabled}
            dim={l.fk.confidence === 'naming'}
            title={
              l.fk.confidence === 'constraint'
                ? l.fk.constraintName ?? '数据库外键约束'
                : '根据 xxx_id 字段命名推断，请人工确认'
            }
            onChange={(checked) =>
              onChange(links.map((x) => (fkKey(x.fk) === fkKey(l.fk) ? { ...x, enabled: checked } : x)))
            }
          />
          <span className="fk">
            {l.fk.fromTable}.{l.fk.fromColumn} → {l.fk.toTable}.{l.fk.toColumn}
          </span>
          {l.fk.confidence === 'constraint' ? (
            <Tag tone="ok" title={l.fk.constraintName ?? '数据库外键约束'}>
              <CheckCircleOutlined aria-hidden="true" /> {l.fk.constraintName ?? '外键约束'}
            </Tag>
          ) : (
            <Tag tone="wr"><WarningOutlined aria-hidden="true" /> 命名推断</Tag>
          )}
          <Spacer />
          <Seg<JoinType>
            options={JOIN_OPTIONS.map((o) => ({ ...o, disabled: !l.enabled }))}
            value={l.joinType}
            onChange={(joinType) =>
              onChange(links.map((x) => (fkKey(x.fk) === fkKey(l.fk) ? { ...x, joinType } : x)))
            }
          />
        </div>
      ))}

      <Hint>从表可能没有匹配记录时用 LEFT，否则主表记录会被过滤掉</Hint>
    </>
  )
}
