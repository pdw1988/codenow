/**
 * 界面上的字段清单排序（勾选 / 下拉 / 字段表怎么画）。
 *
 * 顺序：主键 → 唯一键 → 普通索引 → 日期相关 → 其余；每一档内部按字段名排。
 * 生成 SQL、编辑表结构、导出 DDL 仍用表里的原顺序——那是库上的列序，不能按字母重排。
 */

/** 比较用的最小字段形状；缺 isUnique / isIndexed / type / javaType 时对应档位就跳过 */
export type ColumnOrderInput = {
  name: string
  isPrimaryKey: boolean
  isUnique?: boolean
  isIndexed?: boolean
  isAutoIncrement?: boolean
  type?: string
  javaType?: string
}

const NAME_CMP = { numeric: true, sensitivity: 'base' } as const

function nameCmp(a: string, b: string): number {
  return a.localeCompare(b, undefined, NAME_CMP)
}

/**
 * 日期 / 时间列：看类型、Java 类型，再看常见命名（*_time / *_date / *_at、create_time 等）。
 * 只靠名字猜，避免把 timeout、status 这类误收进来。
 */
export function isDateRelatedColumn(c: {
  name: string
  type?: string
  javaType?: string
}): boolean {
  const jt = (c.javaType ?? '').trim()
  if (
    /^java\.time\.(LocalDate|LocalDateTime|LocalTime|Instant|OffsetDateTime|ZonedDateTime)$/.test(
      jt,
    )
  ) {
    return true
  }
  if (
    jt === 'java.util.Date' ||
    jt === 'java.sql.Date' ||
    jt === 'java.sql.Timestamp' ||
    jt === 'java.sql.Time'
  ) {
    return true
  }

  const t = (c.type ?? '').trim()
  // DATE / DATETIME / TIMESTAMP[(n)] [WITH TIME ZONE] / TIME / TIMESTAMPTZ …
  if (/^(date|datetime|smalldatetime|timestamp|timestamptz|time)\b/i.test(t)) return true

  const n = c.name
  // 审计 / 业务时间常见名（跟 mockValue 的 create/update 口径对齐，并多几种到期类）
  if (
    /^(gmt_)?(create|created|update|updated|modify|modified|edit|edited)_(time|at|date)$/i.test(n)
  ) {
    return true
  }
  if (/^(gmt_)?(create|created|update|updated)(time|at|date)$/i.test(n)) return true
  if (
    /^(birth|birthday|expire|expiry|expired|start|end|begin|finish|publish|deadline|due)(_?(time|date|at))?$/i.test(
      n,
    )
  ) {
    return true
  }
  // 后缀约定：xxx_time / xxx_date / xxx_at（timeout 这种整词不含下划线，不会误伤）
  if (/_(time|date|at)$/i.test(n)) return true
  return false
}

/** 0 主键 → 1 唯一键 → 2 普通索引 → 3 日期 → 4 其余 */
export function columnUiTier(c: ColumnOrderInput): number {
  if (c.isPrimaryKey) return 0
  if (c.isUnique) return 1
  if (c.isIndexed) return 2
  if (isDateRelatedColumn(c)) return 3
  return 4
}

export function compareColumnsForUi(a: ColumnOrderInput, b: ColumnOrderInput): number {
  const ta = columnUiTier(a)
  const tb = columnUiTier(b)
  if (ta !== tb) return ta - tb
  return nameCmp(a.name, b.name)
}

export function sortColumnsForUi<T extends ColumnOrderInput>(cols: readonly T[]): T[] {
  return [...cols].sort(compareColumnsForUi)
}
