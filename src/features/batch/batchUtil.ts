/**
 * 批量两页共用的小函数。不放进 batchBits.tsx：那边是组件，
 * 混导出函数会让 Fast Refresh 整页失效。
 */
import type { FieldRule, RuleKind } from '../../lib/sqlgen/batchGen'
import { RULE_PARAMS } from '../../lib/sqlgen/batchGen'

export const isDigits = (s: string) => /^\d+$/.test(s.trim())

/** 换规则就给一套默认参数——空白必配会让「随机数字」产出空串，用户还以为坏了 */
export function ruleOf(k: RuleKind): FieldRule {
  const ps = RULE_PARAMS[k]
  return {
    k,
    p: ps
      ? {
          a: ps.find((x) => x.slot === 'a')?.dft,
          b: ps.find((x) => x.slot === 'b')?.dft,
        }
      : undefined,
  }
}
