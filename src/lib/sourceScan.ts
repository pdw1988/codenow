/**
 * 方式三「扫描项目源码」的解析引擎，PRD §5.1 方式三。
 *
 * 文件遍历和读盘在 UI 层（webkitdirectory 的 FileList + file.text()，
 * 不用动 Rust 也不用加 capabilities），这里只做两件纯计算：
 * ①从文件清单里挑出三类来源并做防护（排除构建目录、大小/数量上限）；
 * ②把文本解析成表结构并按可信度合并——*.sql > @Entity > Mapper XML。
 *
 * 合并的可信度哲学和外键两级可信度是同一条：推断出来的东西不许悄悄混进
 * 结果。只有 Mapper XML 来源的表拿不到完整字段清单（resultMap 只含出现过的列），
 * 标不完整且默认不勾——少字段是安静的错，比报错难查。
 */
import type { Column } from '../types/schema'

/* ================= 一、文件挑选与防护 ================= */

export interface ScanFileMeta {
  /** 相对路径，分隔符统一成 / */
  path: string
  size: number
}

export type ScanKind = 'sql' | 'ent' | 'xml'

export interface ScanOptions {
  sql: boolean
  ent: boolean
  xml: boolean
}

/** 固定排除的目录段（小写比对）。都是构建产物或版本库，里面翻不出新东西还慢 */
export const SCAN_SKIP_DIRS = ['target', 'node_modules', '.git', 'dist', 'build']

/** 总文件数上限：超了直接停，让用户缩小范围，绝不把界面卡死 */
export const SCAN_MAX_FILES = 5000

/** 单文件上限：2MB 的「实体类」不是实体类，硬读只会拖垮扫描 */
export const SCAN_MAX_FILE_BYTES = 2 * 1024 * 1024

export interface ScanPick {
  path: string
  kind: ScanKind
}

export interface PickResult {
  picks: ScanPick[]
  /** 命中排除目录被跳过的文件数——日志里给用户看规模，不然像没扫过 */
  skippedByDir: number
  /** 单文件超限跳过数 */
  skippedBig: number
  /** 总数超上限中途停下（picks 是不完整的，UI 必须提示而不是当全量导入） */
  overflow: boolean
}

const EXT_KINDS: Array<[string, ScanKind]> = [
  ['.sql', 'sql'],
  ['.java', 'ent'],
  ['.xml', 'xml'],
]

export function pickScanFiles(metas: ScanFileMeta[], opts: ScanOptions): PickResult {
  const result: PickResult = { picks: [], skippedByDir: 0, skippedBig: 0, overflow: false }
  let considered = 0

  for (const meta of metas) {
    const path = meta.path.replace(/\\/g, '/')
    const segments = path.toLowerCase().split('/')
    if (segments.some((seg) => SCAN_SKIP_DIRS.includes(seg))) {
      result.skippedByDir++
      continue
    }

    considered++
    // 防护先于挑选：超限就整体停，picks 保持「到当前为止」的不完整状态
    if (considered > SCAN_MAX_FILES) {
      result.overflow = true
      break
    }
    // webkitdirectory 给的是相对路径，最后一段才是文件名
    const name = segments[segments.length - 1] ?? ''
    const hit = EXT_KINDS.find(([ext]) => name.toLowerCase().endsWith(ext))
    if (!hit) continue
    if (!opts[hit[1] === 'sql' ? 'sql' : hit[1] === 'ent' ? 'ent' : 'xml']) continue

    if (meta.size > SCAN_MAX_FILE_BYTES) {
      result.skippedBig++
      continue
    }
    result.picks.push({ path, kind: hit[1] })
  }
  return result
}

/* ================= 二、@Entity 实体类 ================= */

/**
 * Java 类型 → 猜的 SQL 类型。这是**猜的**：实体类里没有长度信息，
 * VARCHAR(255)/DECIMAL(20,2) 都是占位值。敢猜是因为实体一般照着表写、
 * 字段名和注释是真的，类型错了用户在预览里一眼能看出来。
 */
export function sqlTypeFromJava(javaType: string): string {
  const t = javaType.replace(/^java\.(lang|math|time|util)\./, '')
  if (/(^|\b)(String)$/.test(t)) return 'VARCHAR(255)'
  if (/^(Long|long)$/.test(t)) return 'BIGINT'
  if (/^(Integer|int)$/.test(t)) return 'INT'
  if (/^(Short|short)$/.test(t)) return 'SMALLINT'
  if (/^BigDecimal$/.test(t)) return 'DECIMAL(20,2)'
  if (/^(Double|double)$/.test(t)) return 'DOUBLE'
  if (/^(Float|float)$/.test(t)) return 'FLOAT'
  if (/^(Boolean|boolean)$/.test(t)) return 'TINYINT(1)'
  if (/^BigInteger$/.test(t)) return 'BIGINT'
  if (/^LocalDateTime$/.test(t)) return 'DATETIME'
  if (/^LocalDate$/.test(t)) return 'DATE'
  if (/^LocalTime$/.test(t)) return 'TIME'
  if (/^Date$/.test(t)) return 'DATETIME'
  if (/byte(\[\]|$)|Byte(\[\]|$)/.test(t)) return 'BLOB'
  return 'VARCHAR(255)'
}

/**
 * userName → user_name。第二条规则处理连续大写缩写：UserID → user_id
 * （只靠第一条会切在 D 前面变成 user_i_d 的邻居 user__id）。
 */
export function camelToSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}

/**
 * 实体类名 → 表名：剥掉常见后缀再转下划线。
 * UserEntity → user，OrderDO → order；没有后缀的原样转。
 */
export function entityNameToTable(cls: string): string {
  return camelToSnake(cls.replace(/(?:Entity|DTO|DO|BO|PO)$/i, ''))
}

export interface ScannedField {
  column: string
  javaField: string
  javaType: string
  nullable: boolean
  isPrimaryKey: boolean
  comment?: string
}

export interface EntityParse {
  table: string
  javaClass: string
  columns: ScannedField[]
}

const FIELD_RE =
  /\b(?:public|protected|private)\s+(?!static\b|final\b)([\w.$]+(?:<[^<>]*>)?(?:\[\])?)\s+(\w+)\s*(?:=[^;]+)?;/

/** 从声明位置往前找注解和注释的窗口：跨得太远就是上一个成员的东西了 */
const LOOKBACK_LIMIT = 600

/**
 * 解析一个 Java 源文件。没有 @Entity / @Table 的普通类返回 null——
 * 项目里几百个类大多数不是实体，null 是常态不是错误。
 */
export function parseEntity(text: string): EntityParse | null {
  if (!/@(?:Entity|Table)\b/.test(text)) return null

  const classMatch = /\bclass\s+(\w+)/.exec(text)
  if (!classMatch) return null
  const javaClass = classMatch[1]

  const tableAttr = /@Table\s*\([^)]*?\bname\s*=\s*"([^"]+)"/.exec(text)
  const table = tableAttr?.[1] ?? entityNameToTable(javaClass)

  const columns: ScannedField[] = []
  const seen = new Set<string>()
  let cursor = 0

  for (;;) {
    const rest = text.slice(cursor)
    const m = FIELD_RE.exec(rest)
    if (!m) break
    const declStart = cursor + m.index
    // 上下文窗口从**上一条成员声明结束处**开始：否则上一个字段的 @Column
    // 落在窗口里，会被当成这一个字段的注解——列名悄悄串门比解析失败难查多了
    const context = text.slice(Math.max(cursor, declStart - LOOKBACK_LIMIT), declStart)
    cursor += m.index + m[0].length

    const javaType = m[1]
    const javaField = m[2]
    if (seen.has(javaField)) continue
    seen.add(javaField)

    // @Transient 是 ORM 明说「这列不存在」，比什么都权威
    if (/@Transient\b/.test(context)) continue

    // 注释取窗口里最后一份 javadoc（没有才退到最后的行注释）；
    // javadoc 可能和字段之间隔着 @Column，所以不能锚定在声明紧前面
    const jdocs = [...context.matchAll(/\/\*\*\s*([\s\S]*?)\*\//g)]
    const lcoms = [...context.matchAll(/\/\/\s*([^\n]*)/g)]
    const raw = jdocs.length ? jdocs[jdocs.length - 1][1] : lcoms.length ? lcoms[lcoms.length - 1][1] : ''
    const comment = raw
      .split('\n')
      .map((l) => l.replace(/^\s*\*?\s?/, '').trim())
      .filter(Boolean)
      .join(' ')
      .trim()

    const colAttr = /@Column\s*\(([^)]*)\)/.exec(context)
    const colName = colAttr ? /\bname\s*=\s*"([^"]+)"/.exec(colAttr[1])?.[1] : undefined

    // nullable=false 显式声明才收窄；基本类型默认非空但实体字段几乎全是包装类型，不猜
    const nullableFalse = colAttr ? /nullable\s*=\s*false/.test(colAttr[1]) : false

    columns.push({
      column: colName ?? camelToSnake(javaField),
      javaField,
      javaType,
      nullable: !nullableFalse,
      isPrimaryKey: /@(?:Id|PrimaryKey)\b/.test(context),
      comment: comment || undefined,
    })
  }

  return { table, javaClass, columns }
}

/** EntityParse → 领域 Column。类型映射在这里集中发生，测试钉住它 */
export function entityColumnsToDomain(fields: ScannedField[]): Column[] {
  return fields.map((f) => ({
    name: f.column,
    type: sqlTypeFromJava(f.javaType),
    nullable: f.nullable,
    isPrimaryKey: f.isPrimaryKey,
    isAutoIncrement: false, // 实体类里看不出自增，宁可不标也不瞎猜
    defaultValue: undefined,
    javaField: f.javaField,
    javaType: f.javaType,
    comment: f.comment,
  }))
}

/* ================= 三、MyBatis Mapper XML ================= */

export interface XmlTableHit {
  table: string
  /** 出现过的列名，按出现顺序去重保序 */
  columns: string[]
  via: 'resultMap' | 'insert'
}

/**
 * resultMap 的 type 属性是实体类全名 → 表名；INSERT INTO 直接给表名。
 * 两者都拿不到的 mapper 不出结果——namespace 是接口名不是表名，不猜。
 */
export function parseMapperXml(text: string): XmlTableHit[] {
  const out: XmlTableHit[] = []
  const push = (table: string, columns: string[], via: XmlTableHit['via']) => {
    const cleaned = [...new Set(columns.map((c) => c.trim()).filter(Boolean))]
    if (table && cleaned.length) out.push({ table, columns: cleaned, via })
  }

  // resultMap：<id>/<result> 的 column 属性就是真实列名
  for (const rm of text.matchAll(/<resultMap\b[^>]*>/g)) {
    const tag = rm[0]
    const type = /\btype\s*=\s*"([^"]+)"/.exec(tag)?.[1]
    if (!type) continue
    const end = text.indexOf('</resultMap>', rm.index)
    if (end < 0) continue
    const block = text.slice(rm.index, end)
    const cols = [...block.matchAll(/<(?:id|result)\b[^>]*\bcolumn\s*=\s*"([^"]+)"/g)].map(
      (m) => m[1],
    )
    push(entityNameToTable(type.split('.').pop() ?? ''), cols, 'resultMap')
  }

  // insert into t (a, b, c)：列清单是括号里那串
  for (const ins of text.matchAll(/\binsert\s+into\s+[`"[]?([\w$]+)[`"\]]?\s*\(([^)]*)\)/gi)) {
    const cols = ins[2].split(',').map((c) => c.trim().replace(/[`"[\]]/g, ''))
    push(ins[1], cols, 'insert')
  }

  return out
}

/* ================= 四、按可信度合并 ================= */

export type SourceKind = 'sql' | 'ent' | 'xml'

/** UI 上展示的来源标签，顺序即可信度顺序 */
export const SOURCE_LABELS: ReadonlyArray<{ kind: SourceKind; label: string }> = [
  { kind: 'sql', label: 'SQL 脚本' },
  { kind: 'ent', label: '@Entity' },
  { kind: 'xml', label: 'Mapper XML' },
]

/** 合并前的通用形状：三种来源各自解析后都收敛到这里 */
export interface RawScanned {
  name: string
  comment?: string
  javaClass?: string
  columns: Column[]
  kind: SourceKind
}

export interface ScannedTable {
  name: string
  comment?: string
  javaClass?: string
  columns: Column[]
  /** 命中的全部来源（去重），展示用 */
  srcs: SourceKind[]
  /**
   * 只有 Mapper XML 来源 = false：resultMap 里没出现的列拿不到，
   * 缺多少不知道——所以默认不勾，让用户想清楚再导。
   */
  complete: boolean
}

const KIND_RANK: Record<SourceKind, number> = { sql: 3, ent: 2, xml: 1 }

/**
 * 同名表被多个来源命中时按可信度合并：内容取最高优先级来源的，
 * 来源标签全部保留（速查页要能看出每张表从哪来）。排序：完整的在前，
 * 残缺的沉底但不藏；同类之间按名称稳定排序。
 */
export function mergeScanned(raws: RawScanned[]): ScannedTable[] {
  const byName = new Map<string, RawScanned[]>()
  for (const raw of raws) {
    const key = raw.name.toLowerCase()
    const list = byName.get(key) ?? []
    list.push(raw)
    byName.set(key, list)
  }

  const merged: ScannedTable[] = []
  for (const group of byName.values()) {
    const winner = [...group].sort((a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind])[0]
    const srcs = SOURCE_LABELS.map((s) => s.kind).filter((kind) =>
      group.some((r) => r.kind === kind),
    )
    merged.push({
      name: winner.name,
      comment: winner.comment,
      javaClass: winner.javaClass,
      columns: winner.columns,
      srcs,
      complete: srcs.some((k) => k !== 'xml'),
    })
  }

  return merged.sort(
    (a, b) =>
      Number(b.complete) - Number(a.complete) ||
      a.name.localeCompare(b.name),
  )
}
