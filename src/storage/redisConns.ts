/**
 * Redis 连接的存档。和数据库「我的连接」分开存：DbConn 的校验要求用户名和库名非空、
 * 类型只认 4 种 SQL 方言，强塞进去会在载入时被静默丢掉，还会把方言下拉、
 * SQL 方言表这些穷举查找一并打穿。
 *
 * 同样不存密码：跨天免输走系统凭据（`redisCredTarget`），生产不写。
 */
import { isDbEnv, newConnId, type DbEnv } from '../types/dbconn'

/** SQLite cache_metadata 的键。清空缓存的白名单里要有它（sqliteStore.clear） */
export const REDIS_CONNS_KEY = 'redisConns'

export const REDIS_SAVED_LIMIT = 20

/** 单机 / 哨兵（主机栏填哨兵）/ 集群（主机栏填任一节点） */
export type RedisKind = 'single' | 'sentinel' | 'cluster'
const KINDS: readonly RedisKind[] = ['single', 'sentinel', 'cluster']

/** 跳板机地址。密码跟拉日志共用 ssh 凭据（sshCredTarget），这里不存 */
export interface RedisJumpAddr {
  host: string
  port: number
  user: string
}

export interface RedisConn {
  id: string
  name: string
  host: string
  port: string
  /** Redis 6 的 ACL 用户名，老版本只有密码时留空 */
  user: string
  db: number
  tls: boolean
  env: DbEnv
  kind: RedisKind
  /** 哨兵的主节点名（sentinel monitor 后面那个），其它方式为空 */
  master: string
  jump: RedisJumpAddr | null
}

function isJump(v: unknown): v is RedisJumpAddr {
  if (typeof v !== 'object' || v === null) return false
  const j = v as Record<string, unknown>
  return (
    typeof j.host === 'string' &&
    j.host.trim() !== '' &&
    typeof j.port === 'number' &&
    Number.isInteger(j.port) &&
    j.port > 0 &&
    j.port < 65536 &&
    typeof j.user === 'string'
  )
}

function isRedisConn(v: unknown): v is RedisConn {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    r.id.trim() !== '' &&
    typeof r.name === 'string' &&
    r.name.trim() !== '' &&
    typeof r.host === 'string' &&
    r.host.trim() !== '' &&
    typeof r.port === 'string' &&
    /^\d+$/.test(r.port.trim()) &&
    (r.user === undefined || typeof r.user === 'string') &&
    (r.db === undefined || (typeof r.db === 'number' && Number.isInteger(r.db) && r.db >= 0)) &&
    (r.tls === undefined || typeof r.tls === 'boolean') &&
    (r.env === undefined || isDbEnv(r.env)) &&
    (r.kind === undefined || KINDS.includes(r.kind as RedisKind)) &&
    (r.master === undefined || typeof r.master === 'string') &&
    (r.jump === undefined || r.jump === null || isJump(r.jump))
  )
}

/** 坏 JSON / 坏条目逐条跳过；白名单之外的字段（比如误存的密码）读进来就洗掉 */
export function parseRedisConns(raw: string | null): RedisConn[] {
  if (!raw) return []
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  return arr.filter(isRedisConn).map((c) => ({
    id: c.id.trim(),
    name: c.name.trim(),
    host: c.host.trim(),
    port: c.port.trim(),
    user: (c.user ?? '').trim(),
    db: c.db ?? 0,
    tls: c.tls ?? false,
    env: c.env ?? 'test',
    kind: c.kind ?? 'single',
    master: (c.master ?? '').trim(),
    jump: c.jump ? { host: c.jump.host.trim(), port: c.jump.port, user: c.jump.user.trim() } : null,
  }))
}

const sameAddr = (a: RedisConn, b: RedisConn) =>
  a.host === b.host && a.port === b.port && a.user === b.user && a.db === b.db && a.kind === b.kind && a.master === b.master

/** 新的或改过的放最前；同地址的旧条并进来，避免一记两笔 */
export function upsertRedisConn(list: RedisConn[], patch: Omit<RedisConn, 'id'> & { id?: string }): RedisConn[] {
  const next: RedisConn = {
    ...patch,
    id: patch.id?.trim() || newConnId(),
    name: patch.name.trim(),
    host: patch.host.trim(),
    port: patch.port.trim(),
    user: patch.user.trim(),
    master: patch.master.trim(),
  }
  const rest = list.filter((c) => c.id !== next.id && !sameAddr(c, next))
  return [next, ...rest].slice(0, REDIS_SAVED_LIMIT)
}

export function removeRedisConn(list: RedisConn[], id: string): RedisConn[] {
  return list.filter((c) => c.id !== id)
}

/**
 * 系统凭据的键。不含库号：同一台 Redis 各库是同一个密码。
 * 前缀 redis| 跟数据库的 credTarget（oracle| / mysql| …）不会撞。
 */
export function redisCredTarget(c: Pick<RedisConn, 'host' | 'port' | 'user'>): string {
  // eslint-disable-next-line no-control-regex -- 洗掉控制字符：Windows 凭据名不收
  const clean = (s: string) => s.trim().replace(/[\u0000-\u001f|]/g, '_')
  return `redis|${clean(c.host)}|${clean(c.port)}|${clean(c.user)}`
}
