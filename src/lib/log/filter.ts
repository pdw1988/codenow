/**
 * 记录过滤（码上追第三步）。全部是 AND 组合：级别多选、时间窗、关键字（包含
 * 或正则）。关键字搜的是「头行原文 + 堆栈」——查异常名是最高频的用法，只搜头行
 * 会漏掉 `Caused by:` 里的东西。
 */
import type { LogRecord } from './records'

export interface LogFilter {
  /** 选中的级别；空数组 = 不过滤 */
  levels: string[]
  since: number | null
  until: number | null
  text: string
  regex: boolean
  /** 区分大小写；缺省不区分——搜异常名时没人记得 NullPointer 的 P 是不是大写 */
  caseSensitive?: boolean
}

export const EMPTY_FILTER: LogFilter = { levels: [], since: null, until: null, text: '', regex: false, caseSensitive: false }

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 界面在输入时就校验，坏正则提前提示，别等运行时整条过滤静默失效 */
export function isValidRegex(text: string): boolean {
  if (!text) return true
  try {
    new RegExp(text)
    return true
  } catch {
    return false
  }
}

export function makePredicate(f: LogFilter): (r: LogRecord) => boolean {
  // 包含匹配也转成正则：忽略大小写走 i 标志，比逐条 toLowerCase 快得多
  const flags = f.caseSensitive ? '' : 'i'
  let re: RegExp | null = null
  if (f.text) {
    try {
      re = new RegExp(f.regex ? f.text : escapeRegex(f.text), flags)
    } catch {
      re = new RegExp(escapeRegex(f.text), flags)
    }
  }
  return (r) => {
    if (f.levels.length && (!r.level || !f.levels.includes(r.level))) return false
    // ts 未知（pattern 没解析出时间）的记录：有窗时按挡掉算——放进来会让「这个
    // 时间段什么都没有」的结果里混着来路不明的行
    if (f.since !== null && (r.ts === null || r.ts < f.since)) return false
    if (f.until !== null && (r.ts === null || r.ts > f.until)) return false
    if (re) {
      // 逐段试、命中即停：几十万条记录每条都 join 一份堆栈再搜，打一个字卡一下。
      // msg 单列：raw 已含 msg，但外部手搓的记录可能只填了 msg
      if (re.test(r.raw) || re.test(r.msg)) return true
      for (const s of r.stack) if (re.test(s)) return true
      return false
    }
    return true
  }
}
