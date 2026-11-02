/**
 * 连接历史的 blob 读写（storage/templates.ts 同款分工）。
 *
 * 历史只存地址四项不存密码（见 types/dbconn.ts），整体存一份 JSON：
 * 条目是个位数到十几条的量级，建真表的按字段查询能力一样用不上。
 */
import {
  DB_CONN_LIMIT,
  DB_SAVED_LIMIT,
  isDbConn,
  isNamedConn,
  newConnId,
  sameAddress,
  type DbConn,
} from '../types/dbconn'

/** SQLite cache_metadata 的键。与模板/草稿/收藏互不相同——清空缓存的白名单靠它区分 */
export const DBCONNS_KEY = 'dbConns'

/** 浏览器实现的独立 localStorage 键 */
export const DBCONNS_LS_KEY = 'devtools.dbconns'

/**
 * 坏 JSON / 非数组 / 坏条目逐条跳过：历史只是便利功能，宁可丢一条不让整页崩。
 * 载入时给缺 id 的条目补一个：老存档里有没有 id 的连接（connect 时 addr 不带
 * id 就 touch 过库），环境页的连接下拉拿它当 option key/value，两个 undefined
 * 撞成一个 '' 就刷「重复 key」告警——id 在这里归一化，下拉永远有唯一值。
 */
export function parseDbConns(raw: string | null): DbConn[] {
  if (!raw) return []
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  return arr.filter(isDbConn).map((c) => ({
    host: c.host.trim(),
    port: c.port.trim(),
    user: c.user.trim(),
    db: c.db.trim(),
    ...(c.kind ? { kind: c.kind } : {}),
    id: c.id?.trim() || newConnId(),
    ...(c.name?.trim() ? { name: c.name.trim() } : {}),
    ...(c.env ? { env: c.env } : {}),
    ...(c.remark?.trim() ? { remark: c.remark.trim() } : {}),
  }))
}

export function namedConns(list: DbConn[]): DbConn[] {
  return list.filter(isNamedConn)
}

/**
 * 连过一次就记一笔：同地址提到最前，新的插最前，超上限裁尾部。
 * 不改入参——调用方拿它算 next 存档，原地改等于骗过 React state。
 */
export function upsertDbConn(list: DbConn[], conn: DbConn): DbConn[] {
  const rest = list.filter((c) => !sameAddress(c, conn))
  return [conn, ...rest].slice(0, DB_CONN_LIMIT)
}

/**
 * 连上之后记一笔。同地址若已经是「我的连接」，保住名字，只挪到前面。
 * 没名字的最近记录仍封 8 条；有名字的走 20 条上限。
 */
export function touchDbConn(list: DbConn[], addr: DbConn): DbConn[] {
  const hit = list.find((c) => sameAddress(c, addr))
  const rest = list.filter((c) => !sameAddress(c, addr))
  const next: DbConn = hit
    ? {
        ...hit,
        host: addr.host,
        port: addr.port,
        user: addr.user,
        db: addr.db,
        kind: addr.kind ?? hit.kind,
      }
    : // 连库入口（lib/dbLive）的 addr 不带 id：没有就现补一个，否则环境页的
      // 连接下拉会出现两个空 value 的 option（React 重复 key 告警的根源）
      { ...addr, id: addr.id?.trim() || newConnId() }
  const named = [next, ...rest].filter(isNamedConn).slice(0, DB_SAVED_LIMIT)
  const unnamed = [next, ...rest].filter((c) => !isNamedConn(c)).slice(0, DB_CONN_LIMIT)
  return [...named, ...unnamed]
}

export function upsertSavedDbConn(list: DbConn[], patch: DbConn): DbConn[] {
  const name = patch.name?.trim()
  if (!name) return list
  const id = patch.id?.trim() || newConnId()
  const next: DbConn = {
    id,
    name,
    host: patch.host.trim(),
    port: patch.port.trim(),
    user: patch.user.trim(),
    db: patch.db.trim(),
    ...(patch.kind ? { kind: patch.kind } : {}),
    ...(patch.env ? { env: patch.env } : {}),
    ...(patch.remark?.trim() ? { remark: patch.remark.trim() } : {}),
  }
  // 同地址的无名最近记录并进这一条，避免列表里一记两笔
  const rest = list.filter((c) => c.id !== id && !sameAddress(c, next))
  const named = [next, ...rest.filter(isNamedConn)].slice(0, DB_SAVED_LIMIT)
  const unnamed = rest.filter((c) => !isNamedConn(c))
  return [...named, ...unnamed]
}

export function removeDbConn(list: DbConn[], id: string): DbConn[] {
  return list.filter((c) => c.id !== id)
}
