/** 码上测只认「环境页选的那条连接」。会话记了 connId 且和环境页不一致时按未连库处理；
 *  没记 connId 的会话（从「我的连接」等页面连上的）照旧可用。 */
export interface SessionLike {
  kind?: string
  connId?: string
}

export function sessionMismatch(session: SessionLike | null | undefined, connId: string | undefined): boolean {
  return !!session?.connId && session.connId !== (connId ?? '')
}

export function sessionForConn<T extends SessionLike>(session: T | null | undefined, connId: string | undefined): T | null {
  if (!session || sessionMismatch(session, connId)) return null
  return session
}
