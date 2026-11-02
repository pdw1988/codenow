/**
 * 接口执行顺序编排，PRD v0.6 模块 4.20。
 *
 * 为什么必须有这个：扫描按代码顺序产接口，CRUD 组合里 GET 常排在 POST 前面——
 * 「新增」还没执行，查询已经查了个空。默认改为按 HTTP 方法排序：
 * POST（新增）→ GET → PUT → PATCH → DELETE，用户可在环境页 / yml / CLI 覆盖。
 *
 * 纯函数放 lib（分层纪律）：并发策略（GET 有限并发、写全局串行）在 regression.ts，
 * 这里只算「组与组的先后」，node:test 直接钉。
 */

/** 默认执行顺序：新增先跑建出数据，查询/修改/删除才有对象 */
export const DEFAULT_METHOD_ORDER = ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'] as const

const KNOWN = new Set<string>(DEFAULT_METHOD_ORDER)

/**
 * 脏输入 → 合法的方法顺序表：大写、去重、只留认识的动词。
 * 环境 blob / yml / CLI 三路都走它，坏配置静默归位而不是炸掉一次回归。
 * 全不认识（空串、乱码）返回空数组 = 用默认顺序。
 */
export function normalizeMethodOrder(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,，>/\s]+/) : []
  const out: string[] = []
  for (const item of list) {
    const m = String(item ?? '')
      .trim()
      .toUpperCase()
    if (KNOWN.has(m) && !out.includes(m)) out.push(m)
  }
  return out
}

/** 实际生效的顺序：自定义的在前，没提到的按默认顺序跟在后面 */
export function effectiveMethodOrder(custom?: string[]): string[] {
  const head = normalizeMethodOrder(custom)
  return [...head, ...DEFAULT_METHOD_ORDER.filter((m) => !head.includes(m))]
}

export interface MethodGroup<T> {
  method: string
  items: T[]
  /** 只有 GET 组内并发（3）；写动词全局串行，编排不碰这条红线 */
  concurrent: boolean
}

/**
 * 平铺的用例 → 按方法顺序分好组。排序稳定：同方法内保持传入顺序
 * （= 扫描的代码顺序），编排不重排组内。不认识的动词排在最后，
 * 彼此之间按首次出现顺序。
 */
export function groupByMethodOrder<T>(
  items: T[],
  methodOf: (x: T) => string,
  custom?: string[],
): MethodGroup<T>[] {
  const order = effectiveMethodOrder(custom)
  const rank = new Map(order.map((m, i) => [m, i]))
  const firstSeen = new Map<string, number>()
  const keyOf = (x: T): string => methodOf(x).trim().toUpperCase()
  for (const x of items) {
    const k = keyOf(x)
    if (!firstSeen.has(k)) firstSeen.set(k, firstSeen.size)
  }
  const rankOf = (x: T): number => {
    const r = rank.get(keyOf(x))
    return r !== undefined ? r : order.length + (firstSeen.get(keyOf(x)) ?? 0)
  }
  // Map 保插入序 + 稳定遍历：items 本来就按方法聚在相邻位置的场景（单个 Controller）
  // 一次遍历就能成组；跨 Controller 混排时靠 rank 重排。
  const grouped = new Map<string, T[]>()
  for (const x of [...items].sort((a, b) => rankOf(a) - rankOf(b))) {
    const k = keyOf(x)
    const bucket = grouped.get(k)
    if (bucket) bucket.push(x)
    else grouped.set(k, [x])
  }
  return [...grouped.entries()].map(([method, groupItems]) => ({
    method,
    items: groupItems,
    concurrent: method === 'GET',
  }))
}

/** 日志/报告用的一行顺序说明，如「POST → GET → PUT → PATCH → DELETE」 */
export function describeOrder(custom?: string[]): string {
  return effectiveMethodOrder(custom).join(' → ')
}
