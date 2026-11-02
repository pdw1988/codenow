/**
 * 桌面版 Redis 的 IPC 封装（Rust 侧 src-tauri/src/redis_client.rs）。
 *
 * 改值、删键、命令窗口都走 `redisExec`：只读和危险命令拦截只在 Rust 那一处判，
 * 前端不再另写一份规则。参数一律 base64，二进制键也能原样传回去。
 */
import { isTauri } from '../storage'
import { bytesToB64, textToB64 } from './redis/codec'
import type { Reply } from './redis/reply'
import type { RedisKind } from '../storage/redisConns'
import { tauriInvoke } from './tauriInvoke'

export interface RedisDbKeys {
  db: number
  keys: number
}

export interface RedisConnectInfo {
  version: string
  /** 服务端自己报的 standalone / cluster / sentinel */
  mode: string
  /** 我们怎么连的 */
  kind: RedisKind
  /** 哨兵：问到的主节点；集群：全部主节点；单机为空 */
  nodes: string[]
  dbCount: number
  dbs: RedisDbKeys[]
  writable: boolean
}

export interface RedisJump {
  host: string
  port: number
  user: string
  password: string
}

export function redisConnect(args: {
  host: string
  port: string
  user: string
  password: string
  db: number
  tls: boolean
  readonly: boolean
  kind: RedisKind
  master: string
  /** 走跳板机：主机栏填的是「跳板机上看到的」Redis 地址。密码空 = 用私钥 */
  jump: RedisJump | null
}): Promise<RedisConnectInfo> {
  return tauriInvoke<RedisConnectInfo>('redis_connect', args)
}

export const redisDisconnect = () => tauriInvoke<void>('redis_disconnect')
export const redisSelect = (db: number) => tauriInvoke<void>('redis_select', { db })
export const redisDbs = () => tauriInvoke<RedisDbKeys[]>('redis_dbs')
export const redisSetWritable = (writable: boolean) => tauriInvoke<void>('redis_set_writable', { writable })

export function redisScan(cursor: string, pattern: string, count: number) {
  return tauriInvoke<{ cursor: string; keys: Array<{ k: string; t: string }> }>('redis_scan', {
    cursor,
    pattern,
    count,
  })
}

/** 参数：字符串按 UTF-8，Uint8Array 原样；已经是 base64 的键用 `{ b64 }` */
export type RedisArg = string | Uint8Array | { b64: string }

export function redisExec(...args: RedisArg[]): Promise<Reply> {
  const enc = args.map((a) =>
    typeof a === 'string' ? textToB64(a) : a instanceof Uint8Array ? bytesToB64(a) : a.b64,
  )
  return tauriInvoke<Reply>('redis_exec', { args: enc })
}

/**
 * 按模式批量删（组的「删除整组」）。一轮有上限，more = 还没删完；
 * 只读、纯通配符这些拦截在 Rust 那边
 */
export function redisDeleteMatching(pattern: string) {
  return tauriInvoke<{ deleted: number; more: boolean }>('redis_delete_matching', { pattern: textToB64(pattern) })
}

/* ---- 密码：同一套 cred_*，键用 redisCredTarget ---- */

export async function redisCredGet(target: string): Promise<string> {
  if (!isTauri()) return ''
  return (await tauriInvoke<string | null>('cred_get', { target })) ?? ''
}

export async function redisCredSet(target: string, password: string): Promise<void> {
  await tauriInvoke('cred_set', { target, password })
}

export async function redisCredDelete(target: string): Promise<void> {
  if (!isTauri()) return
  try {
    await tauriInvoke('cred_delete', { target })
  } catch {
    /* 没有这条也算清掉 */
  }
}
