import type { TestCase } from '../types'

/**
 * 「▶ 发送」用哪条用例：启用的正常用例 → 任意正常用例 → 第一条。
 * 调试卡编辑、发送条地址、实际发送、场景/数据驱动的参数基准都走这一个，
 * 改的和发的才是同一条。
 */
export function pickSendCase(cases: TestCase[]): TestCase | undefined {
  return (
    cases.find((c) => c.enabled && c.type === 'normal') ??
    cases.find((c) => c.type === 'normal') ??
    cases[0]
  )
}
