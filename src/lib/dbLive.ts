/**
 * 生成页 / 编辑表结构里「选一个连接再执行」。
 *
 * 只握手：现有 connect 会顺带拉表清单，大库会等一会儿——执行这条路暂时复用，
 * 丢掉目录。独立握手命令以后再拆。密码先走 useDbPassStore；跨天免输由调用方写系统凭据。
 */
import type { DbConn } from '../types/dbconn'
import { dbKindOf } from '../types/dbconn'
import type { Dialect } from '../types/schema'
import { liveDialect } from './dbDialect'
import { DIALECTS } from './sqlgen/dialect'
import { isTauri } from '../storage'
import { useDbConnStore } from '../store/useDbConnStore'
import { useDbPassStore } from '../store/useDbPassStore'
import { useUiStore } from '../store/useUiStore'

/** 选的连接和当前 SQL 方言不一致：挡住，不自动改生成页方言。 */
export function pickConnBlocked(pageDialect: Dialect, conn: DbConn): string | null {
  const kind = dbKindOf(conn.kind)
  if (kind === pageDialect) return null
  const want = DIALECTS[pageDialect].label
  const live = DIALECTS[kind].label
  return `这句话是 ${want}，你选的是 ${live}。把上面的方言改成 ${live}，或换一条 ${want} 连接`
}

/** 最近连过或收藏里、和当前方言对得上的那条。生成页 SELECT 跳连库时带上地址。 */
export function lastConnForKind(kind: Dialect): DbConn | null {
  return useDbConnStore.getState().items.find((c) => dbKindOf(c.kind) === kind) ?? null
}

/** 会话里认库用的地址：同一个库不管从哪页连的都得到同一串 */
export function sessionAddr(a: { host: string; port: string; user: string; db: string }): string {
  return `${a.user.trim()}@${a.host.trim()}:${a.port.trim()}/${a.db.trim()}`.toLowerCase()
}

export async function openLiveSession(conn: DbConn, password: string): Promise<void> {
  if (!isTauri()) throw new Error('浏览器模式没有驱动，请用桌面版')
  const kind = dbKindOf(conn.kind)
  const spec = liveDialect(kind)
  if (!spec) throw new Error('这个类型还不能连')
  const p = password.trim()
  if (!spec.fileBased && !p) throw new Error('密码还是空的')
  const addr = {
    kind,
    host: conn.host.trim() || '.',
    port: conn.port.trim() || '0',
    user: conn.user.trim() || 'sqlite',
    db: conn.db.trim(),
  }
  try {
    await spec.disconnect()
  } catch {
    /* 还没连过也当成功 */
  }
  await spec.connect({
    host: addr.host,
    port: addr.port,
    user: addr.user,
    password: spec.fileBased ? '' : p,
    db: addr.db,
  })
  if (!spec.fileBased) useDbPassStore.getState().remember(addr, p)
  useDbConnStore.getState().touch(addr)
  useUiStore.getState().setDbSession({ kind, env: conn.env, connId: conn.id, addr: sessionAddr(addr) })
}
