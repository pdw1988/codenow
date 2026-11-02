/**
 * CREATE TABLE 解析，PRD 5.2。
 *
 * 基于 node-sql-parser 的 AST，而不是正则：DDL 的括号嵌套、字符串里的逗号、
 * 各种约束写法用正则处理会不断打补丁。AST 路线的代价是要贴合它的节点形状，
 * 这些形状已在 probe 中逐个确认过（字段注释、长度/精度、默认值、外键引用都有）。
 */
import pkg from 'node-sql-parser'
import type { Column, Dialect, ForeignKey, TableInfo } from '../types/schema'
import { toCamelCase, toJavaType, toPascalCase } from './javaType'
import { isRepairedType, prepareOracleDdl, type OraclePrep } from './oracleDdl'
import { splitStatements } from './sqlgen/statements'

const { Parser } = pkg

/** node-sql-parser 的 TS 类型很宽，这里按 probe 到的实际形状收窄 */
interface AstValue {
  type?: string
  value?: unknown
  name?: unknown
  args?: unknown
}

interface AstColumnDef {
  resource: 'column'
  // column 在 postgresql 下是对象而不是字符串，统一交给 unquote 挖
  column: { column: unknown }
  definition: { dataType: string; length?: number; scale?: number; expr?: AstValue }
  nullable?: { type?: string; value?: string }
  primary_key?: string
  unique?: string
  auto_increment?: string
  default_val?: { value?: AstValue }
  comment?: { value?: AstValue }
}

interface AstConstraintDef {
  resource: 'constraint'
  constraint?: string | null
  constraint_type?: string
  definition?: Array<{ column?: unknown }>
  reference_definition?: {
    table?: Array<{ table?: unknown }>
    definition?: Array<{ column?: unknown }>
  }
}

type AstCreateDef = AstColumnDef | AstConstraintDef

interface AstCreateTable {
  type?: string
  keyword?: string
  table?: Array<{ table?: unknown }>
  create_definitions?: AstCreateDef[] | null
  table_options?: Array<{ keyword?: string; value?: unknown }> | null
}

/**
 * `alter table T add constraint … primary key (ID)`。
 * 注意这里的 `create_definitions` 是**单个对象**，不是数组（跟 create table 里不一样），
 * 但对象形状跟 AstConstraintDef 完全一致，所以约束处理能共用一份。
 */
interface AstAlterTable {
  type?: string
  table?: Array<{ table?: unknown }>
  expr?: Array<{
    action?: string
    resource?: string
    create_definitions?: AstConstraintDef | null
  }> | null
}

export interface ParseResult {
  tables: TableInfo[]
  foreignKeys: ForeignKey[]
  /** 致命错误：整段 SQL 没能解析 */
  errors: string[]
  /** 非致命提示：跳过的语句、推断出的关联等 */
  warnings: string[]
}

/**
 * PRD 的方言选项 → node-sql-parser 的 database 名。
 *
 * **oracle 故意映射成 mysql**：node-sql-parser 当前版本对 `plsql` 直接抛
 * 「plsql is not supported currently」，选了 Oracle 等于一条都解析不出来。
 * Oracle 特有的写法由 `oracleDdl.ts` 在解析前抹平，所以这里用 mysql 语法就够了。
 */
const DIALECT_MAP: Record<Dialect, string> = {
  mysql: 'mysql',
  postgresql: 'postgresql',
  oracle: 'mysql',
  // node-sql-parser 认 sqlite；SQLite DDL 跟 MySQL 接近，预处理对它也是恒等
  sqlite: 'sqlite',
}

/** AST 的 constraint_type 大小写不统一（"primary key" / "FOREIGN KEY"），统一比较 */
const isType = (raw: string | undefined, expected: string) =>
  (raw ?? '').toLowerCase().replace(/\s+/g, ' ').trim() === expected

/** 表级 UNIQUE / UNIQUE KEY / UNIQUE INDEX。复合唯一不往单列上打标 */
const isUniqueConstraint = (raw: string | undefined) => {
  const n = (raw ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  return n === 'unique' || n === 'unique key' || n === 'unique index'
}

/** 表级 KEY / INDEX（非唯一）。复合索引不往单列上打标 */
const isPlainIndexConstraint = (raw: string | undefined) => {
  const n = (raw ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  return n === 'key' || n === 'index' || n === 'fulltext index' || n === 'spatial index'
}

const isColumnDef = (def: AstCreateDef): def is AstColumnDef => def.resource === 'column'

/**
 * 标识符 → 裸名字。反引号 / 双引号 / 方括号包裹的都剥掉。
 *
 * 另外要兼容 **postgresql 的 AST 把列名包成 `{expr:{type:'default',value:'id'}}`**
 * （mysql 给的是纯字符串）。不兼容这一层，选 PostgreSQL 方言导入时会直接抛
 * `name.replace is not a function`——以前这个分支到不了（`comment on` 先让整段解析失败了），
 * Oracle 预处理修好解析之后就露出来了。
 */
function unquote(raw: unknown): string {
  if (typeof raw === 'string') return raw.replace(/^[`"[\]]+|[`"[\]]+$/g, '')
  if (raw && typeof raw === 'object') {
    const node = raw as { value?: unknown; expr?: unknown }
    if (typeof node.value === 'string') return unquote(node.value)
    if (node.expr) return unquote(node.expr)
  }
  return ''
}

/** VARCHAR + length 50 → VARCHAR(50)；DECIMAL + 10,2 → DECIMAL(10,2) */
function buildTypeString(def: AstColumnDef['definition']): string {
  const base = (def.dataType ?? 'UNKNOWN').toUpperCase()
  if (def.length === undefined || def.length === null) return base
  return def.scale === undefined || def.scale === null
    ? `${base}(${def.length})`
    : `${base}(${def.length},${def.scale})`
}

/**
 * 这些是不带括号的 SQL 关键字，但 node-sql-parser 把它们归到 function 节点。
 * 拼回 DDL 时加括号 MySQL 也认，但展示出来跟用户写的不一致，容易让人以为解析错了。
 */
const BARE_KEYWORDS = new Set([
  'CURRENT_TIMESTAMP',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'LOCALTIME',
  'LOCALTIMESTAMP',
])

/** 从 function 节点里挖出函数名，兼容 string / {name:[{value}]} 两种形状 */
function readFunctionName(name: unknown): string | undefined {
  if (typeof name === 'string') return name
  if (name && typeof name === 'object' && 'name' in name) {
    const inner = (name as { name?: unknown }).name
    if (Array.isArray(inner) && inner[0] && typeof inner[0] === 'object') {
      const v = (inner[0] as { value?: unknown }).value
      if (typeof v === 'string') return v
    }
  }
  return undefined
}

/**
 * 默认值节点 → 展示用字符串。
 * 字符串字面量保留引号（'x'），数字和 CURRENT_TIMESTAMP 之类的原样输出，
 * 这样生成 DDL 时可以直接拼回去。
 */
function readDefault(node: AstValue | undefined): string | undefined {
  if (!node) return undefined

  switch (node.type) {
    case 'single_quote_string':
    case 'string':
      return `'${String(node.value)}'`
    case 'double_quote_string':
      return `"${String(node.value)}"`
    case 'number':
      return String(node.value)
    case 'bool':
      return node.value ? 'TRUE' : 'FALSE'
    case 'null':
      return 'NULL'
    case 'origin':
      // CURRENT_TIMESTAMP 这类关键字走这里，大写更符合 DDL 习惯
      return String(node.value).toUpperCase()
    case 'function': {
      const name = readFunctionName(node.name)?.toUpperCase()
      if (!name) return 'FUNCTION()'
      // CURRENT_TIMESTAMP 不带括号，NOW() / UUID() 带
      return BARE_KEYWORDS.has(name) ? name : `${name}()`
    }
    default:
      return node.value === undefined ? undefined : String(node.value)
  }
}

/**
 * 字符串字面量 → 展示用文本：剥掉外层引号，并把转义的 '' 还原成 '。
 *
 * 只用在注释上，不用在默认值上——默认值要保留引号原样拼回 DDL。
 * 不还原的话 `COMMENT 'user''s table'` 会显示成 user''s table，
 * 再导出一次变成四个引号，每来回一轮就翻倍。
 */
function unquoteLiteral(literal: string): string {
  return literal.replace(/^'|'$/g, '').replace(/''/g, "'")
}

/** 表级 COMMENT='用户表' 的值带引号，去掉 */
function readTableComment(options: AstCreateTable['table_options']): string | undefined {
  const hit = options?.find((o) => (o.keyword ?? '').toLowerCase() === 'comment')
  if (!hit || typeof hit.value !== 'string') return undefined
  return unquoteLiteral(hit.value) || undefined
}

function toColumn(def: AstColumnDef): Column {
  const name = unquote(def.column.column)
  const type = buildTypeString(def.definition)
  return {
    name,
    type,
    // 只有显式 NOT NULL 才是必填；PRIMARY KEY 隐含 NOT NULL，在下面统一补
    nullable: !isType(def.nullable?.type, 'not null'),
    isPrimaryKey: Boolean(def.primary_key),
    isAutoIncrement: Boolean(def.auto_increment),
    // 列级 UNIQUE：主键已经唯一，不必再标，免得界面上 PK+UK 叠两枚
    isUnique: Boolean(def.unique) && !def.primary_key,
    defaultValue: readDefault(def.default_val?.value),
    comment: (() => {
      const c = readDefault(def.comment?.value)
      // 注释走的也是字符串字面量，展示时不需要引号
      return c ? unquoteLiteral(c) || undefined : undefined
    })(),
    javaField: toCamelCase(name),
    javaType: toJavaType(type),
  }
}

/**
 * 解析一段可能含多条 CREATE TABLE 的 SQL。
 *
 * 流程：`prepareOracleDdl` 抹平 Oracle 写法 → 整段 astify（失败则逐条）→
 * 收表 → 回填 `alter table add constraint` → 回填 Oracle 的注释和原始类型 → 收尾推断。
 *
 * 整段失败时逐条 astify：一条语句写错不该让整批导入失败，
 * 用户粘贴的往往是从 Navicat / PL-SQL Developer 导出的一大坨，
 * 里面混着 DROP、SET、序列、触发器。
 */
export function parseDdl(sql: string, dialect: Dialect = 'mysql'): ParseResult {
  const result: ParseResult = { tables: [], foreignKeys: [], errors: [], warnings: [] }

  const trimmed = sql.trim()
  if (!trimmed) {
    result.errors.push('没有输入内容')
    return result
  }

  const prep = prepareOracleDdl(trimmed)
  const parser = new Parser()
  const opt = { database: DIALECT_MAP[dialect] }

  let ast: unknown
  try {
    ast = parser.astify(prep.sql, opt)
  } catch {
    return parseStatementByStatement(prep, parser, opt, result)
  }

  const statements = (Array.isArray(ast) ? ast : [ast]) as AstCreateTable[]
  collectTables(statements, result)
  applyAlterConstraints(statements as AstAlterTable[], result)
  applyOracleExtras(prep, result)
  finalize(result)
  return result
}

/** 整段失败时的兜底：按分号切分，能解析几条算几条 */
function parseStatementByStatement(
  prep: OraclePrep,
  parser: InstanceType<typeof Parser>,
  opt: { database: string },
  result: ParseResult,
): ParseResult {
  // 用 splitStatements 而不是 sql.split(';')：它带引号/注释掩码，
  // 默认值里写了分号（`default 'a;b'`）也不会被切断
  const chunks = splitStatements(prep.sql)
    .map((s) => s.text.trim())
    .filter(Boolean)

  // ALTER 也要收：Oracle 导出的主键是独立的 `alter table … add constraint … primary key`，
  // 丢掉它整张表就没有主键，后面的 UPDATE/DELETE by pk、JOIN 推断全都做不了
  const alters: AstAlterTable[] = []
  let parsedAny = false

  for (const chunk of chunks) {
    const isCreate = /create\s+(?:global\s+temporary\s+)?table/i.test(chunk)
    const isAlter = /^\s*alter\s+table/i.test(chunk)
    if (!isCreate && !isAlter) continue

    try {
      const ast = parser.astify(chunk, opt)
      const list = Array.isArray(ast) ? ast : [ast]
      if (isCreate) {
        collectTables(list as AstCreateTable[], result)
        parsedAny = true
      } else {
        alters.push(...(list as AstAlterTable[]))
      }
    } catch {
      const name = /(?:create|alter)\s+table\s+(?:if\s+not\s+exists\s+)?([`"\w.]+)/i.exec(chunk)?.[1]
      result.warnings.push(`跳过无法解析的语句${name ? `（${unquote(name)}）` : ''}`)
    }
  }

  if (!parsedAny) {
    result.errors.push('没有解析出任何 CREATE TABLE 语句，请检查 SQL 语法和方言设置')
    return result
  }

  applyAlterConstraints(alters, result)
  applyOracleExtras(prep, result)
  finalize(result)
  return result
}

/**
 * 一条表级约束回填到字段上。
 *
 * create table 里的约束和 `alter table add constraint` 的约束共用这一份：
 * 两处 AST 节点形状相同，各写一份的话必然只修好一处
 * （Oracle 导出的主键全在 ALTER 里，MySQL 的全在 CREATE 里，分头写等于分头漏）。
 */
function applyConstraint(
  def: AstConstraintDef,
  tableName: string,
  byName: Map<string, Column>,
  result: ParseResult,
): void {
  // 表级 PRIMARY KEY (id, ...) —— 回填到对应字段上
  if (isType(def.constraint_type, 'primary key')) {
    for (const ref of def.definition ?? []) {
      const col = byName.get(unquote(ref.column ?? '').toLowerCase())
      if (col) col.isPrimaryKey = true
    }
    return
  }

  // 表级 UNIQUE (col) —— 只收单列。复合唯一是元组约束，单列仍可重复，
  // 标成 isUnique 会让批量 INSERT 把外键列也连号，指向不存在的父行。
  if (isUniqueConstraint(def.constraint_type)) {
    const refs = def.definition ?? []
    if (refs.length === 1) {
      const col = byName.get(unquote(refs[0]?.column ?? '').toLowerCase())
      if (col && !col.isPrimaryKey) col.isUnique = true
    }
    return
  }

  // 表级 KEY / INDEX (col) —— 只收单列普通索引
  if (isPlainIndexConstraint(def.constraint_type)) {
    const refs = def.definition ?? []
    if (refs.length === 1) {
      const col = byName.get(unquote(refs[0]?.column ?? '').toLowerCase())
      if (col && !col.isPrimaryKey && !col.isUnique) col.isIndexed = true
    }
    return
  }

  // 表级 FOREIGN KEY —— 有真实约束，可信度最高
  if (isType(def.constraint_type, 'foreign key')) {
    const fromColumn = unquote(def.definition?.[0]?.column ?? '')
    const toTable = unquote(def.reference_definition?.table?.[0]?.table ?? '')
    const toColumn = unquote(def.reference_definition?.definition?.[0]?.column ?? '')
    if (fromColumn && toTable && toColumn) {
      result.foreignKeys.push({
        fromTable: tableName,
        fromColumn,
        toTable,
        toColumn,
        constraintName: def.constraint ?? undefined,
        confidence: 'constraint',
      })
    }
  }
}

/** 从语句列表中挑出 CREATE TABLE，转成 TableInfo + ForeignKey */
function collectTables(statements: AstCreateTable[], result: ParseResult): void {
  const now = new Date().toISOString()

  for (const stmt of statements) {
    if (stmt?.type !== 'create' || (stmt.keyword ?? '').toLowerCase() !== 'table') continue

    const tableName = unquote(stmt.table?.[0]?.table ?? '')
    if (!tableName) continue

    const defs = stmt.create_definitions ?? []
    const columns = defs.filter(isColumnDef).map(toColumn)

    if (!columns.length) {
      result.warnings.push(`${tableName}：没有解析出字段，已跳过`)
      continue
    }

    const byName = new Map(columns.map((c) => [c.name.toLowerCase(), c]))
    for (const def of defs) {
      if (!isColumnDef(def)) applyConstraint(def, tableName, byName, result)
    }

    result.tables.push({
      name: tableName,
      comment: readTableComment(stmt.table_options),
      javaClass: toPascalCase(tableName),
      source: 'sql',
      columns,
      createdAt: now,
      updatedAt: now,
    })
  }
}

/**
 * `alter table … add constraint …` 回填到已收好的表上。
 *
 * Oracle 导出的建表语句里没有主键，主键是后面一条独立的
 * `alter table T add constraint PK_X primary key (ID)`。之前这条语句在「只看 create table」
 * 的过滤里被直接丢掉，结果整张表一个主键都没有——UPDATE/DELETE 按主键、JOIN 推断全废。
 */
function applyAlterConstraints(statements: AstAlterTable[], result: ParseResult): void {
  if (!result.tables.length) return
  const tableByName = new Map(result.tables.map((t) => [t.name.toLowerCase(), t]))

  for (const stmt of statements) {
    if (stmt?.type !== 'alter') continue

    const table = tableByName.get(unquote(stmt.table?.[0]?.table ?? '').toLowerCase())
    if (!table) continue
    const byName = new Map(table.columns.map((c) => [c.name.toLowerCase(), c]))

    for (const expr of stmt.expr ?? []) {
      const def = expr?.create_definitions
      if (!def || expr.action !== 'add' || def.resource !== 'constraint') continue
      applyConstraint(def, table.name, byName, result)
    }
  }
}

/**
 * 把 Oracle 的 `comment on` 注释和用户原样写的类型贴回来。
 *
 * 类型只在「被替换动过」的字段上覆盖（`isRepairedType`）：用户写的是 `NVARCHAR2(40)`，
 * 解析器看到的是替换后的 `VARCHAR(40)`，不盖回去的话界面上显示的类型是用户没写过的，
 * 再点一次「导出 DDL」就把人家 Oracle 表的类型给改了。
 */
function applyOracleExtras(prep: OraclePrep, result: ParseResult): void {
  if (!prep.tableComments.size && !prep.columnComments.size && !prep.declaredTypes.size) return

  for (const table of result.tables) {
    const key = table.name.toLowerCase()

    const tableComment = prep.tableComments.get(key)
    if (tableComment) table.comment = tableComment

    const declared = prep.declaredTypes.get(key)
    for (const col of table.columns) {
      const colKey = col.name.toLowerCase()

      const comment = prep.columnComments.get(`${key}.${colKey}`)
      if (comment) col.comment = comment

      const original = declared?.get(colKey)
      if (original && original !== col.type && isRepairedType(original)) {
        col.type = original
        col.javaType = toJavaType(original)
      }

      // Oracle 的 DATE 是「日期 + 时分秒」，不是只有日期。按通用规则映射成 LocalDate
      // 会把时间部分悄悄丢掉，create_time / update_time 这种字段最容易踩
      if (prep.oracleSyntax && /^date$/i.test(col.type)) col.javaType = 'java.time.LocalDateTime'
    }
  }
}

/** 解析收尾：主键补 NOT NULL + 去重外键 + 命名推断 */
function finalize(result: ParseResult): void {
  // 主键隐含 NOT NULL，补上，否则生成的 INSERT 会把主键当可选字段。
  // 放在收尾而不是 collectTables 里：Oracle 的主键是后面的 ALTER 才带来的，
  // 在 collectTables 里补等于只覆盖了 MySQL 那一种写法
  for (const table of result.tables) {
    for (const col of table.columns) {
      if (col.isPrimaryKey) col.nullable = false
    }
  }

  const fkKey = (fk: ForeignKey) =>
    `${fk.fromTable}.${fk.fromColumn}->${fk.toTable}.${fk.toColumn}`.toLowerCase()

  const seen = new Set(result.foreignKeys.map(fkKey))
  const inferred = inferForeignKeys(result.tables, seen)

  result.foreignKeys.push(...inferred)
  if (inferred.length) {
    result.warnings.push(
      `另有 ${inferred.length} 个关联是根据字段命名推断的（无外键约束），生成 JOIN 前请在关联确认面板核对`,
    )
  }
}

/**
 * 命名推断：xxx_id 字段 → xxx 表的主键。
 *
 * 这是 PRD 4.3 黄色 ⚠️ 那一类关联的来源。很多项目为了性能不建外键约束，
 * 不推断的话多表 JOIN 功能对这些库就是空的。
 */
export function inferForeignKeys(
  tables: TableInfo[],
  existingKeys: Set<string> = new Set(),
): ForeignKey[] {
  const tableByName = new Map(tables.map((t) => [t.name.toLowerCase(), t]))
  const inferred: ForeignKey[] = []

  for (const table of tables) {
    for (const col of table.columns) {
      // 主键自己不参与推断，否则 user.id 会被当成指向某个 "" 表
      if (col.isPrimaryKey) continue

      const match = /^(.+?)_?id$/i.exec(col.name)
      const stem = match?.[1]?.toLowerCase()
      if (!stem) continue

      // 依次试 user / users / user_s 去复数，命中第一个存在的表
      const candidates = [stem, `${stem}s`, stem.replace(/s$/, '')]
      const target = candidates.map((c) => tableByName.get(c)).find(Boolean)
      if (!target || target.name === table.name) continue

      const targetPk = target.columns.find((c) => c.isPrimaryKey)
      if (!targetPk) continue

      const key = `${table.name}.${col.name}->${target.name}.${targetPk.name}`.toLowerCase()
      if (existingKeys.has(key)) continue
      existingKeys.add(key)

      inferred.push({
        fromTable: table.name,
        fromColumn: col.name,
        toTable: target.name,
        toColumn: targetPk.name,
        confidence: 'naming',
      })
    }
  }

  return inferred
}
