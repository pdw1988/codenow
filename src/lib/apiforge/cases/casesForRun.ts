import type { TestCase } from '../types'

/**
 * 跑批前取一个接口要跑的用例。「有没有用例」看存了几条而不是启用了几条：
 * 全部禁用不等于没有，重新生成会把改过的期望和禁用状态一起冲掉。
 * generated 非空时调用方要存盘。
 */
export function casesForRun(
  stored: readonly TestCase[] | undefined,
  generate: () => TestCase[],
): { cases: TestCase[]; generated: TestCase[] | null; allDisabled: boolean } {
  if (stored?.length) {
    const cases = stored.filter((c) => c.enabled)
    return { cases, generated: null, allDisabled: cases.length === 0 }
  }
  const generated = generate()
  return { cases: generated.filter((c) => c.enabled), generated, allDisabled: false }
}
