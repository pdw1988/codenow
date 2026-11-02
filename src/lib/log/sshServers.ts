/**
 * 常用 SSH 服务器名册（用户手动存的地址簿，「连服务器拉日志」里那台下拉）。
 *
 * 只存地址 + 备注名 + 默认目录。密码铁律不变：它在本机凭据库按
 * 「用户@主机:端口」加密存（sshCred，连上一次自动记），名册里连存没存密码
 * 都不知道。放纯函数是为了去重 / 更新这些边界能单测：同地址重存算更新不算
 * 两条、主机名大小写不算两台，这些在这里钉死。
 */
export interface SshServer {
  /** `${user}@${小写host}:${port}` —— 身份键。同地址只有一条，重存就是更新 */
  id: string
  /** 备注名，缺省 user@host；名册里显示它，直接选的时候也是它好认 */
  name: string
  host: string
  port: number
  user: string
  /** 上次用的目录，选中时预填路径框 */
  remotePath: string
  /** 最近使用时间，名册按它排：常用的自然浮到上面 */
  lastUsed: number
}

/** 身份键。主机名按 DNS 惯例不分大小写，归一小写免得存出两条同一台机器 */
export function sshServerId(host: string, port: number, user: string): string {
  return `${user}@${host.trim().toLowerCase()}:${port}`
}

/** 下拉 / 管理弹窗里的一条标签：备注名带地址，重名的机器一眼分得开 */
export function sshServerLabel(s: SshServer): string {
  return `${s.name}（${s.user}@${s.host}:${s.port}）`
}

/**
 * 存一台：新机器插到最前；地址已存在就是更新——默认目录跟手走，
 * 备注名保留用户起过的那份（这次显式给了新名字才换）。
 */
export function upsertSshServer(
  list: SshServer[],
  input: { host: string; port: number; user: string; remotePath: string; name?: string },
): SshServer[] {
  const host = input.host.trim()
  const user = input.user.trim()
  const id = sshServerId(host, input.port, user)
  const old = list.find((s) => s.id === id)
  const item: SshServer = {
    id,
    name: input.name?.trim() || old?.name || `${user}@${host}`,
    host,
    port: input.port,
    user,
    remotePath: input.remotePath.trim() || old?.remotePath || '/var/log',
    lastUsed: Date.now(),
  }
  return [item, ...list.filter((s) => s.id !== id)]
}

/** 改备注名。清空不算改名（空名字没法认），保留原值 */
export function renameSshServer(list: SshServer[], id: string, name: string): SshServer[] {
  const n = name.trim()
  if (!n) return list
  return list.map((s) => (s.id === id ? { ...s, name: n } : s))
}

export function removeSshServer(list: SshServer[], id: string): SshServer[] {
  return list.filter((s) => s.id !== id)
}

/** 名册展示顺序：最近用过的在前。存的时候就排好，读的人不用再排 */
export function sortSshServers(list: SshServer[]): SshServer[] {
  return [...list].sort((a, b) => b.lastUsed - a.lastUsed)
}

/** localStorage 读回来的容错：字段缺一个就丢掉这条，宁缺毋滥不崩页面 */
export function loadSshServers(raw: unknown): SshServer[] {
  if (!Array.isArray(raw)) return []
  const out: SshServer[] = []
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const s = x as Partial<SshServer>
    if (typeof s.id !== 'string' || !s.id) continue
    if (typeof s.host !== 'string' || !s.host) continue
    if (typeof s.user !== 'string' || !s.user) continue
    if (typeof s.port !== 'number' || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535) continue
    if (typeof s.name !== 'string') continue
    if (typeof s.remotePath !== 'string') continue
    if (typeof s.lastUsed !== 'number') continue
    out.push({
      id: s.id,
      name: s.name,
      host: s.host,
      port: s.port,
      user: s.user,
      remotePath: s.remotePath,
      lastUsed: s.lastUsed,
    })
  }
  return out
}
