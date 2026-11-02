/**
 * Oracle 连库导入的纯映射层。
 *
 * 查询语句的执行正本在 `src-tauri/src/oracle.rs`（官方 oracledb 驱动，只跑 SELECT）。
 * 这里只做两件事，因此可以脱离真库单测：
 * 1. 拼 Easy Connect 串（跟 Rust 侧同一套规则，改了必须两边一起改）
 * 2. 字典行 → 类型文本 / Column[]
 *
 * 类型必须拼成用户在 DDL 里会写的样子（NUMBER(19)、VARCHAR2(50)），
 * 再交给 `toJavaType`——那份规则是 NUMBER(1) 不当布尔、NUMBER(25) 不给 Long，
 * 连库导入跟粘贴 DDL 必须走同一口径，否则同一张表两种来源 Java 类型对不上。
 * 长度单位（CHAR/BYTE 语义）不拼：NVARCHAR2(n CHAR) 本身就不是合法 Oracle 语法，
 * 用户也确认过导出只要长度。
 */
import type { Column } from '../types/schema'
import { toCamelCase, toJavaType } from './javaType'

const s = (v: string | null | undefined): string => (typeof v === 'string' ? v.trim() : '')

const num = (v: string | null | undefined): number | undefined => {
  const t = s(v)
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Easy Connect。日常填服务名；老库只有 SID 时服务名写成 `:ORCL`。
 * 整段描述符或已经带主机的串原样交给驱动，避免再包一层 host:port/。
 *
 * SID 不能拼成 `host:port:sid`：官方薄驱动不认，会当成 tnsnames 别名，
 * 没设 TNS_ADMIN 就报 “no configuration directory specified”。
 * 规则跟 `src-tauri/src/oracle.rs` 的 `connect_string` 必须逐条相同。
 */
export function buildOracleConnectString(host: string, port: string, service: string): string {
  const h = host.trim()
  const p = port.trim()
  const svc = service.trim()
  if (svc.startsWith('(') || svc.includes('/')) return svc
  const legacy = parseHostPortSid(svc)
  if (legacy) return sidDescriptor(legacy.host, legacy.port, legacy.sid)
  if (svc.startsWith(':')) return sidDescriptor(h, p, svc.slice(1))
  if (/^[^:]+:\d+$/.test(svc)) return svc
  return `${h}:${p}/${svc}`
}

function parseHostPortSid(s: string): { host: string; port: string; sid: string } | undefined {
  const parts = s.split(':')
  if (parts.length !== 3) return undefined
  const [host, port, sid] = parts
  if (!host || !sid || !/^\d+$/.test(port)) return undefined
  return { host, port, sid }
}

function sidDescriptor(host: string, port: string, sid: string): string {
  return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))(CONNECT_DATA=(SID=${sid})))`
}

const CHAR_TYPES = new Set(['VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR'])

/**
 * 从 USER_TAB_COLUMNS 的拆列拼回类型文本。
 *
 * DATA_TYPE 有时已经自带括号（`TIMESTAMP(6) WITH TIME ZONE`），原样用。
 * NUMBER 的精度/小数位在独立列上：不拼的话界面上只剩 `NUMBER`，导出 DDL
 * 会把 NUMBER(19) 的主键改成无精度的 NUMBER，Java 类型也会从 Long 变成 BigDecimal。
 */
export function formatOracleType(row: {
  dtype: string | null
  dlen?: string | null
  dprec?: string | null
  dscale?: string | null
  clen?: string | null
  cused?: string | null
}): string {
  const dtype = s(row.dtype)
  if (!dtype) return ''
  if (dtype.includes('(')) return dtype

  const upper = dtype.toUpperCase()
  if (upper === 'NUMBER') {
    const p = num(row.dprec)
    const sc = num(row.dscale)
    if (p == null) return sc == null ? 'NUMBER' : `NUMBER(*,${sc})`
    if (sc == null || sc === 0) return `NUMBER(${p})`
    return `NUMBER(${p},${sc})`
  }
  if (upper === 'FLOAT') {
    const p = num(row.dprec)
    return p == null ? 'FLOAT' : `FLOAT(${p})`
  }
  if (upper === 'RAW') {
    const n = num(row.dlen)
    return n == null ? 'RAW' : `RAW(${n})`
  }
  if (CHAR_TYPES.has(upper)) {
    const n = num(row.clen) ?? num(row.dlen)
    if (n == null) return upper
    // cused（CHAR_USED）的 C/B 语义不拼进类型：只要长度，别把 NVARCHAR2(1000 CHAR) 这种
    // 非法写法导出去
    return `${upper}(${n})`
  }
  return dtype
}

export interface OracleColumnRow {
  cname: string | null
  dtype: string | null
  dlen?: string | null
  dprec?: string | null
  dscale?: string | null
  clen?: string | null
  cused?: string | null
  cnull: string | null
  cdef?: string | null
  ccmt?: string | null
  ident?: string | null
  pk?: string | null
  uniq?: string | null
  /** 单列非唯一普通索引 Y/N */
  idx?: string | null
}

const yn = (v: string | null | undefined): boolean => s(v).toUpperCase() === 'Y'

/**
 * 逐表字段。Oracle 可空是 Y/N（不是 information_schema 的 YES/NO）。
 * 自增只认 identity 列（12c+）；11g 的序列+触发器在字典里看不出来，保持手标。
 * 主键不再标 isUnique——跟 MySQL 映射同一口径，批量 INSERT 靠 isPrimaryKey 连号。
 */
export function mapOracleColumns(rows: OracleColumnRow[]): Column[] {
  const out: Column[] = []
  for (const r of rows) {
    const name = s(r.cname)
    const type = formatOracleType(r)
    if (!name || !type) continue
    const isPrimaryKey = yn(r.pk)
    out.push({
      name,
      type,
      nullable: s(r.cnull).toUpperCase() === 'Y',
      isPrimaryKey,
      isAutoIncrement: yn(r.ident),
      isUnique: !isPrimaryKey && yn(r.uniq),
      isIndexed: !isPrimaryKey && !yn(r.uniq) && yn(r.idx),
      defaultValue: s(r.cdef) || undefined,
      comment: s(r.ccmt) || undefined,
      javaField: toCamelCase(name),
      javaType: toJavaType(type),
    })
  }
  return out
}
