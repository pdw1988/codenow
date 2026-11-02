export type StepState = 'done' | 'active' | 'todo'

export interface RunStep {
  label: string
  detail: string
  state: StepState
}

/**
 * 跑批进度条上的四步：备用例 → 登录 → 跑用例 → 收尾出报告。
 * 只从 progress 推：用例和登录都在 startRun 之前做完，跑满 total 之后剩残留检测和汇总。
 */
export function runSteps(progress: { done: number; total: number }, needLogin: boolean): RunStep[] {
  const { done, total } = progress
  const ran = done >= total
  return [
    { label: '备用例', detail: `${total} 条`, state: 'done' },
    { label: '登录', detail: needLogin ? '已登录' : '免登录', state: 'done' },
    { label: '跑用例', detail: `已跑 ${done} / ${total}`, state: ran ? 'done' : 'active' },
    { label: '出报告', detail: ran ? '残留检测 · 汇总中' : '等待中', state: ran ? 'active' : 'todo' },
  ]
}
