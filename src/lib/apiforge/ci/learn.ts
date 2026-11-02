/**
 * 期望自动学习（PRD v0.6 模块 4.14）。
 *
 * 严格模式的最大门槛是「期望要手写」。观察模式跑一场回归后，每张关联表的
 * 变更量就在结果里了——整场回归里所有用例对同一张表的变更完全一致，这条
 * 规律就值得学成期望（t_user: +1），一键采纳后随 apiforge.yml 导出给 CI。
 *
 * 诚实边界：
 * - 整场回归里同一张表的 (新增/更新/删除) 有出入 → 不学，标注原因；
 * - 混合变更（既有新增又有删除/更新）→ 期望语法（+N / -N / 0）表达不了，
 *   不硬凑，标注「先人工确认」；
 * - 更新-only 同样表达不了，按混合处理。
 */
import type { CaseRunResult } from '../types'

export interface LearnedExpectation {
  table: string
  /** 学到的期望值（+N / -N）；空串 = 这张表学不出来 */
  spec: string
  /** 整场回归里该表出现变更的结果条数 */
  samples: number
  /** 给人看的解释：为什么能学 / 为什么不学 */
  note: string
}

export function learnExpectations(results: CaseRunResult[]): LearnedExpectation[] {
  interface Seen {
    sig: string
    samples: number
    ins: number
    upd: number
    del: number
    consistent: boolean
  }
  const seen = new Map<string, Seen>()
  for (const r of results) {
    for (const c of r.dbChanges) {
      if (c.op === 'none') continue
      const sig = `${c.rowsInserted}|${c.rowsUpdated}|${c.rowsDeleted}`
      const cur = seen.get(c.tableName)
      if (!cur) {
        seen.set(c.tableName, {
          sig,
          samples: 1,
          ins: c.rowsInserted,
          upd: c.rowsUpdated,
          del: c.rowsDeleted,
          consistent: true,
        })
      } else {
        cur.samples += 1
        if (cur.sig !== sig) cur.consistent = false
      }
    }
  }
  const out: LearnedExpectation[] = []
  for (const [table, s] of seen) {
    if (!s.consistent) {
      out.push({
        table,
        spec: '',
        samples: s.samples,
        note: `${s.samples} 条结果的变更量有出入（${s.ins}/${s.upd}/${s.del} 是其中之一），规律不稳先观察`,
      })
      continue
    }
    if (s.ins > 0 && s.upd === 0 && s.del === 0) {
      out.push({ table, spec: `+${s.ins}`, samples: s.samples, note: `${s.samples} 条结果一致新增 ${s.ins} 行` })
    } else if (s.del > 0 && s.ins === 0 && s.upd === 0) {
      out.push({ table, spec: `-${s.del}`, samples: s.samples, note: `${s.samples} 条结果一致删除 ${s.del} 行` })
    } else {
      out.push({
        table,
        spec: '',
        samples: s.samples,
        note: `混合变更（新增 ${s.ins} / 更新 ${s.upd} / 删除 ${s.del}），期望语法表达不了，先人工确认`,
      })
    }
  }
  return out.sort((a, b) => b.samples - a.samples)
}

/** 只把能表达的期望收进 Record，供 store 保存与 yml 导出（空 spec 的留在明细里给人看） */
export function learnedToRecord(learned: LearnedExpectation[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const l of learned) if (l.spec) out[l.table] = l.spec
  return out
}
