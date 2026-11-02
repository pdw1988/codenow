/**
 * 尚未实现的功能占位。
 *
 * 关键是「结构完整、路径可点」，所以每个未实现的入口都放一个写明归属阶段和
 * 待做项的占位，而不是空白页 —— 空白页过两周自己也说不清这里缺什么。
 */
import { Band, Card, Hint, Lbl, Stack } from './ui'

interface PlaceholderProps {
  title: string
  /** 归属阶段，如 'Phase 2' */
  phase: string
  /** 该功能要做的事，逐条列出 */
  todos: string[]
}

export function Placeholder({ title, phase, todos }: PlaceholderProps) {
  return (
    <Card title={`${title}（开发中）`} who={`计划在 ${phase} 实现`}>
      <Stack>
        <Band tone="info" title="这一块还没做。">
          现在能用的是「粘贴建表语句」那一路 —— 从 Navicat / DataGrip / PL-SQL Developer
          导出 DDL 再粘进来，结果是一样的。
        </Band>
        <div>
          <Lbl>待实现</Lbl>
          <ul>
            {todos.map((todo) => (
              <li key={todo}>
                <Hint>{todo}</Hint>
              </li>
            ))}
          </ul>
        </div>
      </Stack>
    </Card>
  )
}
