/**
 * 「正常·按 xxx 查」的核对：用借来的真实值查，列表不该是空的，每条这个字段都要对得上。
 * 找不到列表就不核对（只剩信封检查）；列表里没有这个字段就只看非空。
 */
import type { TestCase } from '../types'
import { parsePreservingBig, unwrapSentinelStrings } from '../../bigIntJson'

export interface QueryByCheck {
  field: string
  mode: 'eq' | 'contains'
  value: string
}

/** 发出去的用例里这个条件实际填了什么。没填（报告里重跑不取真实值）就不核对 */
export function queryByCheckOf(tc: Pick<TestCase, 'queryBy' | 'parameters'>): QueryByCheck | null {
  const q = tc.queryBy
  if (!q) return null
  let v: unknown
  if (q.position === 'query') v = tc.parameters[q.field]
  else if (typeof tc.parameters.__body === 'string') {
    try {
      const b: unknown = parsePreservingBig(tc.parameters.__body)
      if (b && typeof b === 'object' && !Array.isArray(b)) v = unwrapSentinelStrings((b as Record<string, unknown>)[q.field])
    } catch {
      v = undefined
    }
  }
  if (v === undefined || v === null || String(v) === '') return null
  return { field: q.field, mode: q.mode, value: String(v) }
}

/** 列表在响应里的常见位置，按顺序找第一个数组 */
const LIST_PATHS = [
  ['data', 'records'], ['data', 'list'], ['data', 'rows'], ['data', 'items'], ['data', 'content'],
  ['data', 'dataList'], ['data'], ['rows'], ['records'], ['list'], [],
]

export function findList(root: unknown): unknown[] | null {
  for (const path of LIST_PATHS) {
    let cur: unknown = root
    for (const k of path) cur = cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Record<string, unknown>)[k] : undefined
    if (Array.isArray(cur)) return cur
  }
  return null
}

function matches(actual: unknown, want: string, mode: QueryByCheck['mode']): boolean {
  const a = String(actual)
  if (mode === 'contains') return a.includes(want)
  if (a === want) return true
  // 库里取的是文本："1.50" 和 1.5、"1" 和 1 算相等
  return a.trim() !== '' && want.trim() !== '' && Number.isFinite(Number(a)) && Number(a) === Number(want)
}

/** 核对失败明细；空数组 = 过了（或没法核对） */
export function queryByFails(check: QueryByCheck, bodyText: string | null | undefined): string[] {
  let root: unknown
  try {
    root = unwrapSentinelStrings(parsePreservingBig((bodyText ?? '').trim()))
  } catch {
    return []
  }
  const list = findList(root)
  if (!list) return []
  const cond = `按 ${check.field}=${check.value} 查`
  if (list.length === 0) return [`${cond}，列表是空的（这条值取自库里的真实数据，应该查得出来）`]
  for (const [i, item] of list.entries()) {
    if (!item || typeof item !== 'object' || !(check.field in item)) continue
    const actual = (item as Record<string, unknown>)[check.field]
    if (actual === null || actual === undefined || !matches(actual, check.value, check.mode)) {
      return [`${cond}，第 ${i + 1} 条的 ${check.field} 是 ${String(actual)}，${check.mode === 'contains' ? '不包含' : '不等于'}查询值`]
    }
  }
  return []
}
