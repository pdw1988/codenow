/**
 * API Diff 破坏性变更告警（PRD v0.6 模块 4.13）。
 *
 * 对两次扫描结果做接口签名 diff：CI 里 MR 一合，调用方就被删参数、改路径
 * 打爆是经典事故。这里把「破坏性 / 仅提示」的判定做成纯函数，CLI diff 命令
 * 和 GUI 扫描后的自动对比共用。
 *
 * 匹配身份：工程 + Controller 类 + 方法名 + HTTP 方法。路径变了身份不变，
 * 才能识别出「路径变更」这种破坏性；身份对不上的走兜底配对（同名同 Controller
 * 但方法不同 → HTTP 方法变更）。重载同名同方法但路径不同的极端情况会交叉
 * 配对出两条路径变更——明细是诚实的，宁可误报也不漏报。
 */
import type { ApiMethod, WorkspaceScanResult } from '../types'

export interface ApiDiffEntry {
  kind: 'added' | 'removed' | 'changed'
  breaking: boolean
  project: string
  controller: string
  method: string
  /** 新扫描的 `POST /api/users`；removed 用旧扫描的 */
  signature: string
  details: string[]
}

export interface ApiDiffResult {
  entries: ApiDiffEntry[]
  breakingCount: number
  addedCount: number
  removedCount: number
  changedCount: number
}

type Side = { api: ApiMethod; project: string; controller: string }

const keyOf = (projectId: string, controller: string, method: string, httpMethod: string): string =>
  `${projectId}|${controller}|${method}|${httpMethod}`

const flatten = (ws: WorkspaceScanResult): Map<string, Side> => {
  const m = new Map<string, Side>()
  for (const p of ws.projects) {
    for (const c of p.controllers) {
      for (const api of c.methods) {
        m.set(keyOf(p.projectId, c.className, api.methodName, api.httpMethod), {
          api,
          project: p.projectName,
          controller: c.className,
        })
      }
    }
  }
  return m
}

/** 参数的对比身份：位置 + 名字（同名不同位置的参数是两个东西） */
const paramKey = (p: { name: string; position: string }): string => `${p.position}:${p.name}`

interface ParamLike {
  name: string
  javaType: string
  required: boolean
  position?: string
}

/** 参数/body 字段逐个对比，破坏性判定按 PRD 4.13：必填删除、类型变更、新增必填 */
function diffParams(
  label: (p: ParamLike) => string,
  before: ParamLike[],
  after: ParamLike[],
): { breaking: string[]; info: string[] } {
  const breaking: string[] = []
  const info: string[] = []
  const newBy = new Map(after.map((p) => [paramKey(p as { name: string; position: string }), p]))
  const oldBy = new Map(before.map((p) => [paramKey(p as { name: string; position: string }), p]))
  for (const [k, old] of oldBy) {
    const now = newBy.get(k)
    if (!now) {
      const line = `删除了${old.required ? '必填' : '可选'}参数 ${label(old)}`
      if (old.required) breaking.push(line)
      else info.push(line)
      continue
    }
    if (now.javaType !== old.javaType) {
      breaking.push(`参数 ${label(old)} 类型变更 ${old.javaType} → ${now.javaType}`)
    }
  }
  for (const [k, now] of newBy) {
    if (!oldBy.has(k)) {
      const line = `新增${now.required ? '必填' : '可选'}参数 ${label(now)}`
      if (now.required) breaking.push(line)
      else info.push(line)
    }
  }
  return { breaking, info }
}

export function diffScans(oldWs: WorkspaceScanResult | null, newWs: WorkspaceScanResult): ApiDiffResult {
  const entries: ApiDiffEntry[] = []
  if (!oldWs) {
    return { entries, breakingCount: 0, addedCount: 0, removedCount: 0, changedCount: 0 }
  }
  const before = flatten(oldWs)
  const after = flatten(newWs)

  // 兜底配对先行：身份没对上（HTTP 方法变了）但工程+Controller+方法名相同 →
  // 记方法变更，并把这些键排除出下面的新增/删除，避免一条变更记两遍
  const pairedOldKeys = new Set<string>()
  const pairedNewKeys = new Set<string>()
  for (const [newKey, now] of after) {
    if (before.has(newKey)) continue
    for (const [oldKey, old] of before) {
      if (after.has(oldKey) || pairedOldKeys.has(oldKey)) continue
      if (
        old.api.projectId === now.api.projectId &&
        old.controller === now.controller &&
        old.api.methodName === now.api.methodName
      ) {
        pairedOldKeys.add(oldKey)
        pairedNewKeys.add(newKey)
        entries.push({
          kind: 'changed',
          breaking: true,
          project: now.project,
          controller: now.controller,
          method: now.api.methodName,
          signature: `${old.api.httpMethod} ${old.api.path} → ${now.api.httpMethod} ${now.api.path}`,
          details: [`HTTP 方法变更 ${old.api.httpMethod} → ${now.api.httpMethod}`],
        })
        break
      }
    }
  }

  for (const [key, now] of after) {
    if (pairedNewKeys.has(key)) continue
    const old = before.get(key)
    if (!old) {
      entries.push({
        kind: 'added',
        breaking: false,
        project: now.project,
        controller: now.controller,
        method: now.api.methodName,
        signature: `${now.api.httpMethod} ${now.api.path}`,
        details: ['新增接口'],
      })
      continue
    }
    const breaking: string[] = []
    const info: string[] = []
    if (old.api.path !== now.api.path) breaking.push(`路径 ${old.api.path} → ${now.api.path}`)
    const params = diffParams(
      (p) => `${p.name}(${p.position ?? 'body'})`,
      old.api.parameters,
      now.api.parameters,
    )
    breaking.push(...params.breaking)
    info.push(...params.info)
    const body = diffParams((p) => p.name, old.api.requestBodyFields, now.api.requestBodyFields)
    breaking.push(...body.breaking)
    info.push(...body.info)
    if (old.api.description !== now.api.description) info.push('描述变更')
    if (breaking.length || info.length) {
      entries.push({
        kind: 'changed',
        breaking: breaking.length > 0,
        project: now.project,
        controller: now.controller,
        method: now.api.methodName,
        signature: `${now.api.httpMethod} ${now.api.path}`,
        details: [...breaking, ...info],
      })
    }
  }

  for (const [oldKey, old] of before) {
    if (after.has(oldKey) || pairedOldKeys.has(oldKey)) continue
    entries.push({
      kind: 'removed',
      breaking: true,
      project: old.project,
      controller: old.controller,
      method: old.api.methodName,
      signature: `${old.api.httpMethod} ${old.api.path}`,
      details: ['接口被删除：存量调用方直接 404'],
    })
  }

  entries.sort(
    (a, b) =>
      Number(b.breaking) - Number(a.breaking) ||
      a.project.localeCompare(b.project) ||
      a.signature.localeCompare(b.signature),
  )
  return {
    entries,
    breakingCount: entries.filter((e) => e.breaking).length,
    addedCount: entries.filter((e) => e.kind === 'added').length,
    removedCount: entries.filter((e) => e.kind === 'removed').length,
    changedCount: entries.filter((e) => e.kind === 'changed').length,
  }
}

/** MR 评论 / 工件用的 Markdown。没有差异给一句明确的「没有」，别让 CI 日志空着 */
export function apiDiffToMarkdown(d: ApiDiffResult): string {
  const b: string[] = []
  b.push(`# 码上测 API Diff`)
  b.push('')
  b.push(
    `破坏性变更 **${d.breakingCount}** · 新增 ${d.addedCount} · 删除 ${d.removedCount} · 修改 ${d.changedCount}`,
  )
  b.push('')
  if (!d.entries.length) {
    b.push('✓ 两次扫描没有接口差异。')
    return b.join('\n')
  }
  if (d.breakingCount) {
    b.push(`## 破坏性变更（${d.breakingCount}）`)
    b.push('')
    for (const e of d.entries.filter((x) => x.breaking)) {
      b.push(`- **${e.signature}**（${e.project} · ${e.controller}）：${e.details.join('；')}`)
    }
    b.push('')
  }
  const only = d.entries.filter((x) => !x.breaking)
  if (only.length) {
    b.push(`## 仅提示（${only.length}）`)
    b.push('')
    for (const e of only) {
      b.push(`- ${e.signature}（${e.project} · ${e.controller}）：${e.details.join('；')}`)
    }
  }
  return b.join('\n')
}
