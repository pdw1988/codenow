/**
 * 界面导航状态。
 *
 * 没有引 react-router：这是单窗口工具应用，Tab 切换不需要 URL，
 * 而且 Tauri 里也没有地址栏。真需要深链接时再引。
 */
import { create } from 'zustand'
import type { DbConn, DbEnv, DbKind } from '../types/dbconn'
import type { Dialect } from '../types/schema'

export type TabKey =
  | 'schema'
  /** 单表 CRUD：SQL 生成拆成两页后的一页，见 features/sqlgen/SingleSqlPage */
  | 'sqlgen-single'
  /** 多表关联：同上，关联由用户自己挑，见 features/sqlgen/MultiSqlPage */
  | 'sqlgen-multi'
  | 's2u'
  /** 批量 INSERT：造测试数据。跟 UPDATE 拆开，见 features/batch/BatchInsertPage */
  | 'batch-insert'
  /** 批量 UPDATE：按主键 / 条件改已有行。见 features/batch/BatchUpdatePage */
  | 'batch-update'
  | 'sqlfav'
  | 'logfill'
  | 'config'
  | 'import'
  /** 连库查询工作台：独立一级菜单，不再埋在导入页 Seg 里 */
  | 'dbquery'
  /** Redis 客户端：键树 + 值详情 + 命令窗口，见 features/redis/RedisPage */
  | 'redis'
  /** 起名收藏的连接地址。密码不进这一页 */
  | 'dbconns'
  /** 历史 SQL 优化记录：连库查询每次跑出来的建议 */
  | 'dbadvice'
  /**
   * APIForge：Spring Boot 接口自动回归（PRD v0.3）。
   * 扫描 → 登录 → 用例 → 调接口 → 数据库变更对比 → 报告。
   */
  | 'apiforge'
  /** 码上追 · 日志查看：本机大日志文件秒开，见 features/logview/LogViewPage */
  | 'logview'
  /** 码上连 · SSH 终端：应用里直接开交互式终端，见 features/term/TermPage */
  | 'term'
  | 'regex'
  | 'jsonpath'
  /** Cron 表达式生成器：小工具组第三件，规则在 lib/cron.ts */
  | 'cron'
  /** 常用信息：VPN / 堡垒机 / 生产库等账号地址，见 features/vault/VaultPage */
  | 'vault'

/**
 * 从「表结构速查」跳到「SQL 生成」时携带的上下文，
 * 对应 PRD 4.1 的「从速查跳转」入口。
 */
export interface SqlGenContext {
  /** 主表 */
  tableName: string
  /** 外键对面的表。单表页拿它提示「还有 N 张表可以 JOIN」，不用来自动切多表 */
  relatedTables: string[]
}

/** 连库查询勾选行送到 SELECT转UPDATE */
export interface S2uSeed {
  tableName: string
  dialect: Dialect
  paste: string
  rev: number
}

interface UiState {
  activeTab: TabKey
  sqlGenContext: SqlGenContext | null
  /**
   * 多表关联每次被点开（从别的菜单进来，或再点一次当前菜单）加一。
   * 用来卸掉这一页的本地 state：主表、JOIN 行、方言。
   * 别的页仍 keep-alive——导入页粘一半 DDL 切去速查再回来，不能把输入清掉。
   */
  multiVisit: number

  setActiveTab: (tab: TabKey) => void
  /** 速查页点「生成SQL」：带上下文切到单表页 */
  jumpToSqlGen: (context: SqlGenContext) => void
  clearSqlGenContext: () => void
  s2uSeed: S2uSeed | null
  jumpToS2u: (seed: Omit<S2uSeed, 'rev'>) => void
  /**
   * 码上测的 HTTP 响应 → JSONPath 查询：把响应体原文带过去，
   * 省得用户「复制 → 切页 → 粘贴」三步。
   *
   * `json` 是抓包时 pretty 过的响应（`lib/apiforge/http/prettyJson.ts`），
   * 码上测调试卡传的是完整响应（超过收包上限的除外）——JSONPath 页解析失败会说第几行第几列，
   * 不会假装那是完整的响应。`from` 只是给人看的一行来源，不参与计算。
   */
  jsonPathSeed: { json: string; from: string; rev: number } | null
  jumpToJsonPath: (seed: { json: string; from: string }) => void
  /**
   * 「我的连接」/ 生成页 SELECT 跳到连库查询。
   * password、sql 只活在这次跳转的内存里，不落盘。
   */
  dbQuerySeed: {
    conn?: DbConn
    password?: string
    sql?: string
    table?: string
    /**
     * 灌进去要不要立刻执行。**缺省视作 true**：表卡片、生成器「在连接上执行」、
     * 我的连接这三个旧入口灌的都是 `previewSql` 这种 SELECT，自动跑是对的。
     * 收藏详情跳过来传 `false`——收藏里可能是 DELETE/UPDATE，不能替用户按执行。
     */
    run?: boolean
    /** 从码上测某个接口跳过来的：连库查询页给一个「回到接口」 */
    back?: { apiId: string; label: string }
    rev: number
  } | null
  jumpToDbQuery: (seed: {
    conn?: DbConn
    password?: string
    sql?: string
    table?: string
    run?: boolean
    back?: { apiId: string; label: string }
  }) => void
  /**
   * 连库查询已连上。这一页要把左侧菜单收成图标栏，
   * 把宽度让给「表」清单，否则表名+注释挤成一条ellipsis。
   * 切走别的页不收——别的页还要靠菜单字认路。
   */
  dbConnected: boolean
  setDbConnected: (on: boolean) => void
  /** 码上连有连着的终端：同样把左侧菜单收成图标栏，宽度让给终端 */
  termConnected: boolean
  setTermConnected: (on: boolean) => void
  /** 连上之后生成页要知道方言和环境，才能决定「在当前连接执行」能不能点 */
  /** connId：连的是「我的连接」里哪条；addr：user@host:port/db，不管从哪页连的都有，残留清理靠它认库 */
  dbSession: { kind: DbKind; env?: DbEnv; connId?: string; addr?: string } | null
  setDbSession: (s: { kind: DbKind; env?: DbEnv; connId?: string; addr?: string } | null) => void
}

export const useUiStore = create<UiState>((set) => ({
  activeTab: 'schema',
  sqlGenContext: null,
  multiVisit: 0,

  setActiveTab: (activeTab) =>
    set((s) => ({
      activeTab,
      // 点「多表关联」就算已经在这一页，也当重新进来：主表和 JOIN 从空白开始。
      // 切去别的页再点回来同样加一。点别的菜单不加。
      multiVisit: activeTab === 'sqlgen-multi' ? s.multiVisit + 1 : s.multiVisit,
    })),

  /*
   * 一律进单表页：PRD 1.3 的主场景是「插一条测试数据验证功能」，那个场景要的是
   * 单表可执行 SQL。进多表要用户自己点菜单过去——JOIN 查询是另一种产物，
   * 替他决定容易迷路。relatedTables 照样带过去，单表页拿它提示还有表能 JOIN。
   */
  jumpToSqlGen: (sqlGenContext) => set({ sqlGenContext, activeTab: 'sqlgen-single' }),

  clearSqlGenContext: () => set({ sqlGenContext: null }),

  s2uSeed: null,
  jumpToS2u: (seed) =>
    set((s) => ({
      activeTab: 's2u',
      s2uSeed: { ...seed, rev: (s.s2uSeed?.rev ?? 0) + 1 },
    })),

  jsonPathSeed: null,
  jumpToJsonPath: (seed) =>
    set((s) => ({
      activeTab: 'jsonpath',
      jsonPathSeed: { ...seed, rev: (s.jsonPathSeed?.rev ?? 0) + 1 },
    })),

  dbQuerySeed: null,
  jumpToDbQuery: (seed) =>
    set((s) => ({
      activeTab: 'dbquery',
      dbQuerySeed: { ...seed, rev: (s.dbQuerySeed?.rev ?? 0) + 1 },
    })),

  dbConnected: false,
  setDbConnected: (dbConnected) => set({ dbConnected }),
  termConnected: false,
  setTermConnected: (termConnected) => set({ termConnected }),
  dbSession: null,
  setDbSession: (dbSession) => set({ dbSession }),
}))
