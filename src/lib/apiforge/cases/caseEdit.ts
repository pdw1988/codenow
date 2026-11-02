import type { BodyExpect, CaseRunResult, TestCase } from '../types'

export type CaseOrigin = NonNullable<TestCase['origin']>

/** 老用例没有来源标记，一律当生成器出的 */
export const originOf = (c: Pick<TestCase, 'origin'>): CaseOrigin => c.origin ?? 'auto'

let seq = 0
/** 手加 / 复制的用例 id：带时间和随机串，重启后也不会和生成器的「#序号」撞上 */
export function newCaseId(apiId: string): string {
  seq += 1
  return `${apiId}#user#${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`
}

export type CasePatch = Partial<Omit<TestCase, 'id' | 'origin' | 'enabled'>>

/** 改一条用例：生成器出的改过就标 edited，手加的仍是 user。不改入参 */
export function patchCase(c: TestCase, patch: CasePatch): TestCase {
  return { ...c, ...patch, origin: originOf(c) === 'user' ? 'user' : 'edited' }
}

function uniqueName(base: string, taken: readonly TestCase[]): string {
  const names = new Set(taken.map((c) => c.name))
  if (!names.has(base)) return base
  let i = 2
  while (names.has(`${base} ${i}`)) i++
  return `${base} ${i}`
}

/** 复制一条做底稿：新 id、名字加「副本」、标 user、默认启用 */
export function duplicateCase(c: TestCase, apiId: string, taken: readonly TestCase[]): TestCase {
  return {
    ...structuredClone(c),
    id: newCaseId(apiId),
    name: uniqueName(`${c.name} 副本`, taken),
    origin: 'user',
    enabled: true,
  }
}

const sameSlot = (a: TestCase, b: TestCase): boolean => a.type === b.type && a.name === b.name

/**
 * 「重新生成」只换生成器出的：改过的和手加的原样留下（id 不变，结果还对得上）。
 * 新生成的若和旧的同类型同名：沿用旧 id 和启用状态；被改过的那条顶替它的位置。
 */
export function regenerateKeeping(old: readonly TestCase[], fresh: readonly TestCase[]): TestCase[] {
  const kept = old.filter((c) => originOf(c) !== 'auto')
  const placed = new Set<TestCase>()
  const out: TestCase[] = []
  for (const f of fresh) {
    const edited = kept.find((k) => !placed.has(k) && originOf(k) === 'edited' && sameSlot(k, f))
    if (edited) {
      placed.add(edited)
      out.push(edited)
      continue
    }
    const prev = old.find((o) => originOf(o) === 'auto' && sameSlot(o, f))
    out.push(prev ? { ...f, id: prev.id, enabled: prev.enabled } : f)
  }
  for (const k of kept) if (!placed.has(k)) out.push(k)
  // 生成器序号重启后会从 1 数起，撞上留下来的 id 就给新生成的换一个（留下的不动，结果才对得上）
  const keptSet = new Set(kept)
  const keptIds = new Set(kept.map((k) => k.id))
  const ids = new Set<string>()
  return out.map((c) => {
    if (!ids.has(c.id) && (keptSet.has(c) || !keptIds.has(c.id))) {
      ids.add(c.id)
      return c
    }
    const id = `${c.id}~${Date.now().toString(36)}${ids.size}`
    ids.add(id)
    return { ...c, id }
  })
}

/** 「200, 201」→ [200, 201]；中英文逗号和空格都认，非法的丢掉 */
export function parseExpectStatus(text: string): number[] {
  return text
    .split(/[,，\s]+/)
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
}

/** 编辑区用的副本：改草稿不动用例里的原对象 */
export const cloneExpects = (list?: readonly BodyExpect[]): BodyExpect[] => (list ?? []).map((x) => ({ ...x }))

/** 没填完的断言丢掉：路径空且判定不是「存在 / 不存在」的是半截行 */
export function cleanBodyExpects(list: readonly BodyExpect[]): BodyExpect[] {
  return list.filter((x) => x.path.trim() || x.op === 'exists' || x.op === 'notExists')
}

/** 用例改过后，它已有的结果标「改过，没重跑」；跳过的不标 */
export function markStale(results: CaseRunResult[], caseId: string): CaseRunResult[] {
  if (!results.some((r) => r.caseId === caseId && !r.skipped && !r.stale)) return results
  return results.map((r) => (r.caseId === caseId && !r.skipped ? { ...r, stale: true } : r))
}
