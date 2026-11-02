/**
 * 我的SQL库的业务纯函数，PRD v6.3 §6.1~6.9（原型 `mockup/sqlfav.html`）。
 *
 * 五项拍板里落在代码里的三条：①排序带「最常用」——use_count 就在 §6.8 的
 * 表结构里，不加白存了；②表名自动识别精度有限（别名/子查询抓不全），但识别
 * 结果永远可手改；③导入按「名称+SQL 都相同才跳过」合并，id 不参与比对。
 * ④「编辑→生成器」不做硬灌，复制为主；⑤团队共享属商业版，本地单机不做同步。
 */
import { FAVORITE_LIMIT, type FavoriteConn, type FavoriteSql } from '../types/favorite'
import { addrKey, type DbConn } from '../types/dbconn'

export type FavSort = 'recent' | 'often'

/** §6.5 四路合一搜的干草堆：名称/标签/表名/SQL 内容/备注一起小写 */
const hayOf = (it: FavoriteSql): string =>
  (
    it.name +
    '\n' +
    it.tags.join('\n') +
    '\n' +
    it.tables.join('\n') +
    '\n' +
    it.sql +
    '\n' +
    it.remark
  ).toLowerCase()

/**
 * 关键词 + 标签 + 表名三层过滤。「全部」用 null 表示，不参与匹配——
 * 和可执行 SELECT 条件同一个 API 纪律：没动过和明确清空必须分得开。
 */
export function filterFavorites(
  items: FavoriteSql[],
  q: string,
  tag: string | null,
  tbl: string | null,
): FavoriteSql[] {
  const needle = q.trim().toLowerCase()
  return items.filter(
    (it) =>
      (!needle || hayOf(it).includes(needle)) &&
      (tag === null || it.tags.includes(tag)) &&
      (tbl === null || it.tables.includes(tbl)),
  )
}

/** 排序不改入参。「最常用」的平局比最近使用——刚收藏还没复制过的两条不至于随机排 */
export function sortFavorites(items: FavoriteSql[], sort: FavSort): FavoriteSql[] {
  const arr = [...items]
  if (sort === 'often')
    arr.sort((a, b) => b.useCount - a.useCount || b.lastUsedAt.localeCompare(a.lastUsedAt))
  else arr.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
  return arr
}

/**
 * §6.7 自动关联表名：抓 FROM/JOIN/UPDATE/INTO 后面的标识符，库名前缀取末段、
 * 小写去重保序。别名、子查询会抓不全，information_schema 这类系统视图也会被
 * 当表名认出来——没关系，识别结果永远可清空手改（拍板②）。
 */
export function extractTables(sql: string): string[] {
  const out: string[] = []
  const re = /\b(?:from|join|update|into)\s+[`"[]?([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)[`"\]]?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(String(sql)))) {
    const t = m[1].split('.').pop()!.toLowerCase()
    if (!out.includes(t)) out.push(t)
  }
  return out
}

/**
 * 新建收藏时所属表名跟着 SQL 走（PRD §6.4「自动识别或用户选择」）。
 * 用户一旦在表名框里改过，就不再覆盖——识别精度有限，手改必须保住（拍板②）。
 */
export function followTables(sql: string, tablesTouched: boolean, current: string): string {
  if (tablesTouched) return current
  return extractTables(sql).join(', ')
}

/** 本地时间 'YYYY-MM-DD HH:MM'。字典序即时间序，排序不用解析日期 */
export function favNow(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 收藏条目的 id。时间戳 + 随机后缀而不是 crypto.randomUUID()：后者在非 https
 * 的浏览器环境不一定可用（同 useTemplateStore.newTemplateId 的理由）；
 * 前缀不同，跟模板 id 永远不会撞。
 */
export function newFavoriteId(): string {
  return `fav${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 复制成功后刷新使用痕迹：use_count +1、last_used_at 到现在。
 * 返回新对象不改入参——items 在 React state 里，原地改等于骗过渲染。
 */
export function markUsed(item: FavoriteSql): FavoriteSql {
  return { ...item, useCount: item.useCount + 1, lastUsedAt: favNow() }
}

/**
 * 日志转SQL 结果卡的「⭐ 收藏」：整卡语句存成一条，名字自动起（首表名 · 月-日 时:分，
 * 进库后可改名）。库按**内容**寻址：同 SQL 已存在时不新建，原条目**原样**置顶——
 * 重复点击、跨会话重贴同一段日志都不会攒出一堆副本，用户改过的名字/标签/备注一字不动；
 * 改了参数值就是另一条 SQL，照常新建。上限语义同 upsertFavorite（挤掉最旧的）。
 *
 * 纯函数：读写编排在 useFavoriteStore（多页都会写，不能只存在 FavPanel 挂载时那份）。
 */
export function saveSqlFavorite(
  list: FavoriteSql[],
  sql: string,
  now = favNow(),
): { list: FavoriteSql[]; deduped: boolean } {
  return saveFavoriteDetailed(list, { sql }, now)
}

/**
 * 自动起的名字：首表名 · 月-日 时:分。也是连库查询那个收藏弹框的预填值——
 * 预填而不是留空，回车就能存，想起名才改。
 *
 * 没认出表名时给 `SQL`，不是 `UNDEFINED`：`tables[0] ?? 'sql'` 要在 `toUpperCase()`
 * 前面兑现，否则报错或拼出个假表名。
 */
export function defaultFavName(tables: string[], now = favNow()): string {
  return `${(tables[0] ?? 'sql').toUpperCase()} · ${now.slice(5)}`
}

/**
 * 「a, b，c」→ `['a','b','c']`。标签 / 表名输入框共用，中英文逗号都认。
 * （原来是 FavPanel 里的局部 const，连库查询的收藏弹框也要用，挂到 lib 不抄两份。）
 */
export function splitFavList(v: string): string[] {
  return v
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export interface FavoriteInput {
  sql: string
  /** 空/缺省就用 `defaultFavName`——名称是必填项，不能落个空串进库 */
  name?: string
  remark?: string
  tags?: string[]
  /** 表名缺省从 SQL 自动识别（精度有限但永远可手改，拍板②） */
  tables?: string[]
  conn?: FavoriteConn
}

/**
 * 收藏一条，带名字/备注/标签/连接。连库查询页那个弹框用这个；
 * `saveSqlFavorite`（日志转SQL / 生成器的一键收藏）委托给它，行为逐字不变。
 *
 * 库按**内容**寻址：同 SQL 已存在时不新建，原条目**原样**置顶——用户改过的
 * 名字/标签/备注一字不动，这次弹框里填的也不覆盖。重复点击不会攒出副本；
 * 改了 SQL 就是另一条，照常新建。上限语义同 `upsertFavorite`（挤掉最旧的）。
 */
export function saveFavoriteDetailed(
  list: FavoriteSql[],
  input: FavoriteInput,
  now = favNow(),
): { list: FavoriteSql[]; deduped: boolean } {
  const found = list.find((x) => x.sql === input.sql)
  if (found) return { list: [found, ...list.filter((x) => x.id !== found.id)], deduped: true }
  const tables = input.tables ?? extractTables(input.sql)
  const item: FavoriteSql = {
    id: newFavoriteId(),
    name: input.name?.trim() || defaultFavName(tables, now),
    sql: input.sql,
    tables,
    tags: input.tags ?? [],
    remark: input.remark ?? '',
    createdAt: now,
    lastUsedAt: now,
    useCount: 0,
  }
  // 没带连接就不写这个键（而不是写 undefined）：JSON.stringify 会把 undefined 键丢掉，
  // 但内存里多一个 `conn: undefined` 会让 deepEqual 断言对不上，得不偿失
  if (input.conn) item.conn = input.conn
  return { list: [item, ...list].slice(0, FAVORITE_LIMIT), deduped: false }
}

/**
 * 拿收藏里存的连接去「我的连接」里找回完整记录（带 id/name/env，还能拿到记住的密码）。
 * 比对用 `addrKey` 而不是逐字段：它已经把 trim 和 kind 归一的口径定了，不再抄一份。
 *
 * 找不回（没存连接、或那个连接已被删）返回 null——调用方降级成「只灌 SQL、用当前连接」，
 * 绝不因为这个就把按钮禁掉。
 */
export function matchFavConn(conns: DbConn[], fav: FavoriteConn | undefined): DbConn | null {
  if (!fav) return null
  const key = addrKey(fav)
  return conns.find((c) => addrKey(c) === key) ?? null
}

export interface FavImportOk {
  list: FavoriteSql[]
  added: number
  skipped: number
  invalid: number
}

export interface FavImportFail {
  error: string
}

/**
 * §6.6 导入合并：名称+SQL 都相同才跳过（拍板③）；坏行单独计数不中断；
 * 导入条目一律重新分配本地 id，避免跟现有条目或 JSON 内部互相撞车。
 * 去重查的是累积后的列表——JSON 自己内部有重复条目也只收第一条。
 */
export function importFavorites(list: FavoriteSql[], jsonText: string): FavImportOk | FavImportFail {
  let arr: unknown
  try {
    arr = JSON.parse(String(jsonText))
  } catch {
    return { error: 'JSON 解析失败' }
  }
  if (!Array.isArray(arr)) return { error: '顶层必须是数组' }

  let added = 0
  let skipped = 0
  let invalid = 0
  const next = [...list]
  for (const raw of arr) {
    if (typeof raw !== 'object' || raw === null) {
      invalid++
      continue
    }
    const r = raw as Record<string, unknown>
    if (typeof r.name !== 'string' || typeof r.sql !== 'string') {
      invalid++
      continue
    }
    const name = r.name.trim()
    const sql = r.sql.trim()
    // 名称和内容是 §6.4 仅有的两个必填项，缺一即坏行
    if (!name || !sql) {
      invalid++
      continue
    }
    if (next.some((x) => x.name === name && x.sql === sql)) {
      skipped++
      continue
    }
    next.push({
      id: newFavoriteId(),
      name,
      sql,
      tables: Array.isArray(r.tables) ? r.tables.filter((x): x is string => typeof x === 'string') : [],
      tags: Array.isArray(r.tags) ? r.tags.filter((x): x is string => typeof x === 'string') : [],
      remark: typeof r.remark === 'string' ? r.remark : '',
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : favNow(),
      lastUsedAt: typeof r.lastUsedAt === 'string' ? r.lastUsedAt : favNow(),
      useCount:
        typeof r.useCount === 'number' && Number.isFinite(r.useCount) && r.useCount >= 0
          ? Math.floor(r.useCount)
          : 0,
    })
    added++
  }
  return { list: next, added, skipped, invalid }
}
