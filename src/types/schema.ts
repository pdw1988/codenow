/**
 * 领域模型：表结构 / 字段 / 外键
 *
 * 这套类型是整个应用的中心契约，三个数据来源（DDL 粘贴、数据库连接、
 * 项目源码扫描）解析后都收敛到这里，SQL 生成器只消费这里的类型。
 */

/** 表结构的来源，对应 PRD 6.3 cached_tables.data_source */
export type DataSource = 'sql' | 'db' | 'project'

/** 支持的 SQL 方言（生成页 / 导出 / 批量 / 模板都认这四种） */
export type Dialect = 'mysql' | 'postgresql' | 'oracle' | 'sqlite'

export function isDialect(v: unknown): v is Dialect {
  return v === 'mysql' || v === 'postgresql' || v === 'oracle' || v === 'sqlite'
}

/** 主键或单列唯一索引：批量插入必须连号，不能用「沿用自动值」的散列 */
export function requiresDistinct(c: Column): boolean {
  return c.isPrimaryKey || !!c.isUnique
}

/** JOIN 类型。放在这里而不是 lib/sqlgen 里，因为模板类型也要用到它 */
export type JoinType = 'INNER' | 'LEFT' | 'RIGHT'

/**
 * 输出模式，PRD 4.3。
 * 'prepared'   预编译：值是 #{param} 占位符，拿去 MyBatis / JPA 用
 * 'executable' 可执行：值直接填进去，复制到数据库客户端就能跑
 * 同样放在这里是因为模板要存它。
 */
export type OutputKind = 'prepared' | 'executable'

export interface Column {
  /** 字段名，如 user_name */
  name: string
  /** 原始类型，含长度，如 VARCHAR(50) */
  type: string
  nullable: boolean
  isPrimaryKey: boolean
  isAutoIncrement: boolean
  /**
   * 单列 UNIQUE 约束 / 唯一索引。主键本身已经唯一，不必再标。
   * 复合唯一（多列一组）不写在这里——那是元组唯一，单列仍可重复。
   * 批量 INSERT 对这类列不能走散列自动值：撞上唯一约束，语句能生成、插不进去。
   */
  isUnique?: boolean
  /**
   * 单列普通索引（非唯一）。主键 / 唯一键不必再标。
   * 复合索引不写在这里——跟 isUnique 同一口径，只收「这一列自己有索引」。
   * 只影响界面字段清单排序，不参与 SQL 生成。
   */
  isIndexed?: boolean
  defaultValue?: string
  comment?: string
  /** 由 type 推导，如 userName */
  javaField: string
  /** 由 type 推导，如 String */
  javaType: string
}

export interface ForeignKey {
  /** 外键所在表（从表），如 order */
  fromTable: string
  /** 外键字段，如 user_id */
  fromColumn: string
  /** 被引用表（主表），如 user */
  toTable: string
  /** 被引用字段，如 id */
  toColumn: string
  /** 约束名，来自 DDL/数据库元数据 */
  constraintName?: string
  /**
   * 可信度。'constraint' = 有真实外键约束；'naming' = 仅靠命名规则猜出来的。
   * PRD 4.3 的关联确认面板靠这个字段区分绿色 ✅ 和黄色 ⚠️。
   * 'manual' = 用户在多表关联页自己挑的关联：它只活在那个页面的 state 里，
   * 既不写进 foreignKeys 缓存，也不会被 DDL 导出当成外键（ddlExport 只认
   * 'constraint'）。加它是为了不把用户亲手选的关联谎报成「命名推断」。
   */
  confidence: 'constraint' | 'naming' | 'manual'
}

export interface TableInfo {
  name: string
  comment?: string
  /** 映射的 Java 类名，如 User */
  javaClass?: string
  source: DataSource
  columns: Column[]
  createdAt: string
  updatedAt: string
}

/** 缓存整体状态，用于底部状态栏（PRD 6.7） */
export interface CacheStatus {
  tableCount: number
  lastUpdate: string | null
  /** 按来源分组的表数量，如 { db: 45, sql: 5 } */
  bySource: Partial<Record<DataSource, number>>
  /** 缓存字节数，内存实现下为估算值 */
  sizeBytes: number
}

/** 一条搜索命中，含命中原因，用于在结果里高亮说明为什么匹配 */
export interface SearchHit {
  table: TableInfo
  /** 命中方式，对应 PRD 3.4 的匹配规则表 */
  reasons: MatchReason[]
  /** 排序分数，越大越靠前 */
  score: number
}

export type MatchReason =
  | { kind: 'tableExact' }
  | { kind: 'tableFuzzy' }
  | { kind: 'tablePinyin' }
  | { kind: 'tableComment' }
  | { kind: 'javaClass' }
  | { kind: 'column'; columns: string[] }
  | { kind: 'columnComment'; columns: string[] }
