/**
 * 查周边：从筛选结果里点一条，暂停筛选看它前后的完整日志——报错前后发生了什么，
 * 筛选只留命中行是看不出来的。条数不预设：滚多远看多远。
 */
import type { LogRecord } from './records'

export interface Around {
  /** 锚点记录的起始行号（LogRecord.index） */
  index: number
  /** 锚点的线程名；pattern 没拆出线程时为 null，「只看同线程」不可用 */
  thread: string | null
  /** 只留同线程：并发请求的日志交错在一起时，把别的请求的行拿掉 */
  sameThread: boolean
}

/** 查周边要显示的记录（不套任何筛选，只按排序方向和「同线程」取） */
export function aroundView(records: LogRecord[], around: Around, newestFirst: boolean): LogRecord[] {
  const f =
    around.sameThread && around.thread !== null
      ? records.filter((r) => r.thread === around.thread)
      : records.slice()
  return newestFirst ? f.reverse() : f
}

/** 让第 pos 条落在可视区中间的 scrollTop（顶部不足半屏时贴顶） */
export function centerTop(pos: number, rowH: number, viewH: number): number {
  return Math.max(0, pos * rowH - (viewH - rowH) / 2)
}
