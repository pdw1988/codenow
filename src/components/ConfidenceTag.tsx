/**
 * 外键可信度标签。全项目**只准有这一份**：
 * 绿 ✓ = 真有 FOREIGN KEY 约束，橙 ⚠ = 只是从 `xxx_id` 这种命名猜的，
 * ✋ = 用户在多表关联页自己挑的关联。
 *
 * 之前速查页、关联面板、DDL 导入预览各写了一份，颜色和文案就开始飘。
 * 这个区分是要用户拿它做决定的（要不要让它参与 JOIN），三个地方长得不一样
 * 就等于告诉用户「这三处说的不是一回事」。
 *
 * 图标用 @ant-design/icons 的单色件，不再用 emoji：✅/⚠️ 的系统彩色配色
 * 跟主题不搭（同一套绿在标签底色和图标上是两种绿）。
 */
import type { ForeignKey } from '../types/schema'
import { CheckCircleOutlined, StopOutlined, WarningOutlined } from '@ant-design/icons'
import { Tag } from './ui'

interface Props {
  confidence: ForeignKey['confidence']
  /** 约束名，有就一起显示 —— 用户拿它去数据库里对得上 */
  constraintName?: string
  /** 省掉「外键约束」四个字，只留图标。地方实在不够时用 */
  compact?: boolean
}

export function ConfidenceTag({ confidence, constraintName, compact }: Props) {
  if (confidence === 'constraint') {
    return (
      <Tag tone="ok" title={constraintName ? `约束名 ${constraintName}` : '来自真实的外键约束'}>
        <CheckCircleOutlined aria-hidden="true" />
        {compact ? '' : ' 外键约束'}
        {!compact && constraintName ? ` ${constraintName}` : ''}
      </Tag>
    )
  }
  if (confidence === 'manual') {
    return (
      <Tag title="多表关联页手工指定，非外键约束、非命名推断">
        <StopOutlined aria-hidden="true" />
        {compact ? '' : ' 手工指定'}
      </Tag>
    )
  }
  return (
    <Tag tone="wr" title="按字段命名推断出来的，可能是错的，默认不参与 JOIN">
      <WarningOutlined aria-hidden="true" />
      {compact ? '' : ' 命名推断'}
    </Tag>
  )
}
