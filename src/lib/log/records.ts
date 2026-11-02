/**
 * 行 → 记录归组（码上追第二步）。
 *
 * 日志的一「条」不只是一行：异常堆栈、多行消息都挂在头行下面。规则很朴素——
 * 匹配 pattern 的行开新记录，不匹配的行归入上一条的 stack；文件开头就在半截
 * 堆栈中间的（按行号切过/轮转切过），落成一条无头记录，内容不丢、级别未知。
 * pattern 编译不出来时兜底：每行一条，级别从行内嗅探——查看器永远有东西可看。
 */
import { parseLineWith, parseStamp, type CompiledPattern, type ParsedHead } from './pattern'

export interface LogRecord {
  /** 起始行号（0 起），跳转 / 定位全靠它 */
  index: number
  /** 头行原文；堆栈在 stack 里 */
  raw: string
  ts: number | null
  /** 归一化大写（WARNING → WARN） */
  level: string | null
  thread: string | null
  logger: string | null
  msg: string
  stack: string[]
  mdc: Record<string, string>
}

/** JULI / 老容器的级别词归一到 logback 那套：过滤时用户只配一套词。FATAL 单列一档 */
const LEVEL_ALIAS: Record<string, string> = {
  WARNING: 'WARN',
  SEVERE: 'ERROR',
  FINE: 'DEBUG',
  FINER: 'TRACE',
  FINEST: 'TRACE',
  CONFIG: 'INFO',
}

export function normLevel(v: string | undefined): string | null {
  if (!v) return null
  const up = v.toUpperCase()
  return LEVEL_ALIAS[up] ?? up
}

const SNIFF = /\b(FATAL|ERROR|SEVERE|WARN|WARNING|INFO|DEBUG|TRACE)\b/

export function groupRecords(lines: readonly string[], p: CompiledPattern | null): LogRecord[] {
  const g = grouper(p)
  g.feed(lines, 0, lines.length)
  return g.out
}

/**
 * 分批归组：每批之间让出主线程。几十万行一气归完要好几秒，窗口整个点不动。
 * stale() 返回 true（换了文件 / 改了 pattern）就放弃，给 null
 */
export async function groupRecordsChunked(
  lines: readonly string[],
  p: CompiledPattern | null,
  stale: () => boolean,
  onProgress?: (doneLines: number) => void,
  chunk = 50_000,
): Promise<LogRecord[] | null> {
  const g = grouper(p)
  for (let from = 0; from < lines.length; from += chunk) {
    await new Promise((r) => setTimeout(r, 0))
    if (stale()) return null
    g.feed(lines, from, Math.min(lines.length, from + chunk))
    onProgress?.(Math.min(lines.length, from + chunk))
  }
  return g.out
}

/** 归组状态机：堆栈行要挂到上一条，分批时 cur 得跨批保留 */
function grouper(p: CompiledPattern | null) {
  const out: LogRecord[] = []
  let cur: LogRecord | null = null
  const feed = (lines: readonly string[], from: number, to: number) => {
    for (let i = from; i < to; i++) {
      const line = lines[i]!
      const head = p
        ? parseLineWith(line, p)
        : ((): ParsedHead => {
            const m = SNIFF.exec(line)
            return { level: normLevel(m?.[1] ?? undefined) ?? undefined, msg: line, mdc: {} }
          })()
      if (head) {
        cur = {
          index: i,
          raw: line,
          ts: head.ts && p?.tsFormat ? parseStamp(head.ts, p.tsFormat) : null,
          level: normLevel(head.level),
          thread: head.thread ?? null,
          logger: head.logger ?? null,
          msg: head.msg,
          stack: [],
          mdc: head.mdc,
        }
        out.push(cur)
      } else if (cur) {
        cur.stack.push(line)
      } else {
        // 开头就在堆栈中间：落成无头记录，内容不丢
        cur = {
          index: i,
          raw: line,
          ts: null,
          level: null,
          thread: null,
          logger: null,
          msg: line,
          stack: [],
          mdc: {},
        }
        out.push(cur)
      }
    }
  }
  return { out, feed }
}
