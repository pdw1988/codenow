/**
 * 「第二级 · 工程队列」的数据源（照原型 扫描页左栏）。
 *
 * 两个来源：
 *  - 扫描中：从解析流水（PROG 行）还原，靠扫描器的工程事件实时驱动；
 *  - 扫描完：直接从缓存的工作区结果出（权威、可秒回）。
 * 队列是视图派生态，不进 store —— 流水在，队列就在。
 */
import type { WorkspaceScanResult } from '../types'

export type QueueStatus = 'waiting' | 'parsing' | 'done' | 'fail'

export interface QueueProject {
  name: string
  relPath: string
  status: QueueStatus
  /** 解析中的文件进度（parsing i/N 行），done 后为 null */
  files: { done: number; total: number } | null
  apis: number
  controllers: number
}

export interface QueueController {
  name: string
  apis: number
}

export interface ScanQueue {
  projects: QueueProject[]
  /** 最近一个进入解析的工程的 Controller 清单（「当前工程 Controller」小节） */
  activeControllers: QueueController[]
}

/** 扫描中「实时发现」中间栏：工程 → Controller → 接口（从 PROG 增量攒） */
export interface LiveApi {
  method: string
  path: string
  /** Java 方法名；老扫描器没带时为空串 */
  name: string
}

export interface LiveController {
  name: string
  apis: LiveApi[]
}

export interface LiveProject {
  name: string
  controllers: LiveController[]
}

const emptyQueue = (): ScanQueue => ({ projects: [], activeControllers: [] })

/**
 * 扫描器机器事件行（README「stderr 进度协议」）。判据只有这一份：
 *  - 解析流水只上屏人话解析块，机器行滤掉（`ApiforgePage`）；
 *  - store 封顶流水时**不封机器行**（派生视图靠完整序列，见 `pushScanLog`）。
 */
const MACHINE_EVENT = /^PROG (?:projects |proj |files |parsing |controller |api |err )/

export const isMachineEvent = (line: string): boolean => MACHINE_EVENT.test(line)

/** 流水里人话行的上限：只有人话行进 `<pre>` 渲染，机器行再多也不渲染 */
const HUMAN_LOG_MAX = 200

/**
 * 流水封顶：超龄的**人话行**摘掉，机器行一条都不能少。
 *
 * 反过来封（对整条流水 `slice(-199)`）会把 `files` / `proj` 这些锚行挤出窗口，
 * 而实时发现树和工程队列是**从机器行序列还原**的派生视图：认不出「当前工程」是
 * 哪个之后，后面每一个 controller / api 行都因为挂不上工程而被丢掉，面板从头发到尾
 * 只剩一句不动的空态。单工程 admin-ui 正是这个形状：兜底阶段一行一个 DTO（跨工程源码
 * 兜底 + jar 兜底 + 嵌套类型展开）再加几十条 parsing 行，足够把 200 行的窗口在第一个
 * `controller` 行到达之前占满。
 */
export function capScanLog(lines: readonly string[]): string[] {
  let seen = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isMachineEvent(lines[i])) continue
    seen += 1
    if (seen > HUMAN_LOG_MAX) {
      const start = i
      return lines.filter((l, idx) => idx > start || isMachineEvent(l))
    }
  }
  return [...lines]
}

/**
 * 从 PROG 流水还原队列。扫描器事件契约（README「stderr 进度协议」）：
 *   PROG projects N
 *   PROG proj <name> · <relPath>
 *   PROG files N java / M xml · <name>    （jar 模式是 N class / M xml）
 *   PROG parsing i/N <file>
 *   PROG controller <name> · N api
 *   PROG api <METHOD> <path> · <methodName>   （· 方法名可缺，兼容老 jar）
 *   PROG proj done <name> · N api
 *   PROG proj fail <name>
 * 不认识的行原样跳过 —— 协议向前兼容，老流水顶多少个条目。
 */
export function scanQueueFromLog(lines: readonly string[]): ScanQueue {
  const q = emptyQueue()
  const byName = new Map<string, QueueProject>()
  let active: QueueProject | null = null

  const push = (name: string, relPath: string): QueueProject => {
    const existing = byName.get(name)
    if (existing) return existing
    const p: QueueProject = { name, relPath, status: 'waiting', files: null, apis: 0, controllers: 0 }
    byName.set(name, p)
    q.projects.push(p)
    return p
  }

  for (const line of lines) {
    let m: RegExpMatchArray | null
    if ((m = line.match(/^PROG proj (done|fail) (.+) · (\d+) api$/))) {
      const p = byName.get(m[2])
      if (p) {
        p.status = m[1] === 'fail' ? 'fail' : 'done'
        p.apis = Number(m[3])
      }
      continue
    }
    if ((m = line.match(/^PROG proj fail (.+)$/))) {
      const p = byName.get(m[1])
      if (p) p.status = 'fail'
      continue
    }
    if ((m = line.match(/^PROG proj (.+) · (.*)$/))) {
      push(m[1], m[2])
      continue
    }
    if ((m = line.match(/^PROG files (\d+) (?:java|class) \/ (\d+) xml · (.+)$/))) {
      // 老扫描器没有 proj 行时，files 行也带工程名 —— 兜底建条目
      active = push(m[3], '')
      active.status = 'parsing'
      q.activeControllers = []
      continue
    }
    if ((m = line.match(/^PROG parsing (\d+)\/(\d+)/))) {
      // 行尾还跟着文件名（README 协议），队列只认 i/N
      if (active) active.files = { done: Number(m[1]), total: Number(m[2]) }
      continue
    }
    if ((m = line.match(/^PROG controller (.+) · (\d+) api$/))) {
      if (active) {
        active.controllers++
        q.activeControllers.push({ name: m[1], apis: Number(m[2]) })
      }
      continue
    }
    if (line.startsWith('PROG api ')) {
      if (active) active.apis++
      continue
    }
  }
  return q
}

/**
 * 扫描中的实时发现树：按 PROG controller / api 攒出
 * 「工程 → Controller 名 → 接口」。扫完后 UI 改用权威 scan 结果。
 */
export function liveTreeFromLog(lines: readonly string[]): LiveProject[] {
  const projects: LiveProject[] = []
  const byName = new Map<string, LiveProject>()
  let active: LiveProject | null = null
  let currentCtrl: LiveController | null = null

  const ensure = (name: string): LiveProject => {
    const existing = byName.get(name)
    if (existing) return existing
    const p: LiveProject = { name, controllers: [] }
    byName.set(name, p)
    projects.push(p)
    return p
  }

  for (const line of lines) {
    let m: RegExpMatchArray | null
    if ((m = line.match(/^PROG files \d+ (?:java|class) \/ \d+ xml · (.+)$/))) {
      active = ensure(m[1])
      currentCtrl = null
      continue
    }
    if (
      (m = line.match(/^PROG proj (.+) · /)) &&
      !line.startsWith('PROG proj done') &&
      !line.startsWith('PROG proj fail')
    ) {
      ensure(m[1])
      continue
    }
    if ((m = line.match(/^PROG controller (.+) · (\d+) api$/))) {
      if (!active) continue
      currentCtrl = { name: m[1], apis: [] }
      active.controllers.push(currentCtrl)
      continue
    }
    // path 不含空白；可选 ` · methodName`（老 jar 只有 METHOD path）
    if ((m = line.match(/^PROG api ([A-Z]+) (\S+)(?: · (.+))?$/))) {
      if (!currentCtrl) continue
      currentCtrl.apis.push({ method: m[1], path: m[2], name: (m[3] ?? '').trim() })
      continue
    }
  }
  return projects
}

/** 实时发现接口行标题：方法名 · 业务说明；缺一就显另一个 */
export function apiDiscoverLabel(m: { methodName?: string; name?: string; description?: string }): string {
  const name = (m.methodName || m.name || '').trim()
  const desc = (m.description || '').trim()
  if (name && desc) return `${name} · ${desc}`
  return name || desc
}

/** 扫描完成后的权威队列：直接从缓存结果出，不依赖流水 */
export function queueFromScan(ws: WorkspaceScanResult): ScanQueue {
  const projects = ws.projects.map((p) => ({
    name: p.projectName,
    relPath: p.projectPath.startsWith(ws.root + '/')
      ? p.projectPath.slice(ws.root.length + 1)
      : '',
    status: 'done' as const,
    files: null,
    apis: p.controllers.reduce((n, c) => n + c.methods.length, 0),
    controllers: p.controllers.length,
  }))
  // 完成态没有「当前工程」：Controller 看中间栏完整树，这里不挂以免和 flex 空洞叠出大块空白
  return { projects, activeControllers: [] }
}

/** 接口库 / 实时发现标题：有业务名则「类名 · 业务名」 */
export function controllerLabel(c: { className: string; description?: string; packageName?: string }): string {
  const name = c.className || c.packageName || 'Controller'
  return c.description ? `${name} · ${c.description}` : name
}
