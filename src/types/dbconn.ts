/**
 * 连接历史的一条记录（「连库·扫源码导入」页的方式二，PRD §5.1 方式二）。
 *
 * **故意没有 password 字段**。存档只记地址。可选跨天免输走系统凭据
 * （`credTarget`），不进这份 JSON、不进 cache.db。生产连接不准写凭据。
 * `db` 的含义跟方言走：Oracle 是服务名（或 `:SID`），MySQL / PostgreSQL 是数据库名。
 */
export type DbKind = 'oracle' | 'mysql' | 'postgresql' | 'sqlite'

export function isDbKind(v: unknown): v is DbKind {
  return v === 'oracle' || v === 'mysql' || v === 'postgresql' || v === 'sqlite'
}

/** 老历史没有 kind 字段，按 Oracle 认——当时界面只连这一种 */
export function dbKindOf(kind: DbKind | undefined): DbKind {
  return kind && isDbKind(kind) ? kind : 'oracle'
}

export type DbEnv = 'prod' | 'test' | 'local'

export function isDbEnv(v: unknown): v is DbEnv {
  return v === 'prod' || v === 'test' || v === 'local'
}

export const DB_ENV: Record<DbEnv, { label: string; tone: 'wr' | 'hi' | 'ok' }> = {
  prod: { label: '生产', tone: 'wr' },
  test: { label: '测试', tone: 'hi' },
  local: { label: '本地', tone: 'ok' },
}

export interface DbConn {
  host: string
  port: string
  user: string
  db: string
  /** 缺省当 oracle：上线 kind 字段之前记下的地址 */
  kind?: DbKind
  /** 我的连接才有。没有名字的是连过就记的最近记录 */
  id?: string
  name?: string
  env?: DbEnv
  remark?: string
}

/** 没名字的最近连接上限 */
export const DB_CONN_LIMIT = 8
/** 起名保存的「我的连接」上限 */
export const DB_SAVED_LIMIT = 20

export function isNamedConn(c: DbConn): boolean {
  return Boolean(c.name?.trim())
}

export function connDisplayName(c: DbConn): string {
  if (c.name?.trim()) return c.name.trim()
  // 文件型库没有主机端口可读——路径本身就是地址（DbKind 里 sqlite）
  if (dbKindOf(c.kind) === 'sqlite') return c.db
  return `${c.host}:${c.port}/${c.db}`
}

export function newConnId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 存档里逐条校验。外部 JSON 可能缺字段、可能混进旧版本多出来的字段
 * （比如哪天误存过密码的存档——校验白名单之外的字段一律丢弃，读进来就洗掉）。
 */
export function isDbConn(value: unknown): value is DbConn {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    typeof r.host === 'string' &&
    r.host.trim() !== '' &&
    typeof r.port === 'string' &&
    r.port.trim() !== '' &&
    typeof r.user === 'string' &&
    r.user.trim() !== '' &&
    typeof r.db === 'string' &&
    r.db.trim() !== '' &&
    (r.kind === undefined || isDbKind(r.kind)) &&
    (r.id === undefined || (typeof r.id === 'string' && r.id.trim() !== '')) &&
    (r.name === undefined || typeof r.name === 'string') &&
    (r.env === undefined || isDbEnv(r.env)) &&
    (r.remark === undefined || typeof r.remark === 'string')
  )
}

/** 地址 + 类型全同才算同一条（同主机上 Oracle 和 MySQL 是两笔） */
export const sameAddress = (a: DbConn, b: DbConn): boolean =>
  a.host === b.host &&
  a.port === b.port &&
  a.user === b.user &&
  a.db === b.db &&
  dbKindOf(a.kind) === dbKindOf(b.kind)

/**
 * 进程内记密码用的键。不含密码本身。
 * 关掉进程就没了——这份键不准拿去写盘。
 */
export function addrKey(c: Pick<DbConn, 'host' | 'port' | 'user' | 'db' | 'kind'>): string {
  return `${dbKindOf(c.kind)}\0${c.host.trim()}\0${c.port.trim()}\0${c.user.trim()}\0${c.db.trim()}`
}

/** 生产连接不写系统凭据、也不从凭据回填 */
export function canPersistPass(env?: DbEnv): boolean {
  return env !== 'prod'
}

/**
 * 系统凭据的键。不能用 addrKey 的 \\0：Windows 凭据名不收控制字符。
 * 只当不透明键，Rust 侧不解析。
 */
export function credTarget(c: Pick<DbConn, 'host' | 'port' | 'user' | 'db' | 'kind'>): string {
  // eslint-disable-next-line no-control-regex -- 这条正则的功能就是把控制字符洗掉（Windows 凭据名不收它们）
  const clean = (s: string) => s.trim().replace(/[\u0000-\u001f|]/g, '_')
  return `${dbKindOf(c.kind)}|${clean(c.host)}|${clean(c.port)}|${clean(c.user)}|${clean(c.db)}`
}
