/**
 * 把 Oracle 导出的 DDL 修成 node-sql-parser 能吃的形状。
 *
 * 为什么必须有这一层：node-sql-parser 当前版本对 `plsql` 直接报
 * **「plsql is not supported currently」**，而它的 mysql 语法又不认 Oracle 的
 * `NUMBER` / `NVARCHAR2` / `CLOB`，也不认独立的 `comment on … is '…'` 语句。
 * 所以从 PL/SQL Developer 或 Navicat 里导出的建表语句粘进来，三种方言随便选哪个，
 * 结果都是「没有解析出任何 CREATE TABLE 语句」——一个字段都出不来。
 *
 * 这里只做三件事，而且全是「先摘出来、解析完再贴回去」，用户看到的类型和注释保持原样：
 *
 * 1. `comment on table/column … is '…'` 摘成两张表。Oracle 的注释是独立语句，
 *    不像 MySQL 挂在字段后面，不单独处理就会**整批注释全丢**——而注释是这个工具的主要价值。
 * 2. Oracle 独有的类型词换成 mysql 语法认识的等价词（**只为过解析**），同时记下每个字段
 *    原样写的类型文本，解析完覆盖回去。不覆盖的话用户会看到自己没写过的 `DECIMAL(25)`，
 *    再导出一次 DDL 就把人家的 Oracle 表结构改了。
 * 3. 删掉 `tablespace` / `storage(…)` / `using index …` 这类存储子句——跟表结构无关，
 *    但会让整条语句解析失败。
 *
 * 对纯 MySQL 的 DDL，这三步都是恒等变换（没有 comment on、没有 Oracle 类型词、
 * 尾巴上的 `ENGINE=InnoDB COMMENT='…'` 不在删除名单里），所以可以无条件跑，
 * 不需要先猜用户粘的是哪种方言。
 */
import { codeMask, splitStatements } from './sqlgen/statements'

export interface OraclePrep {
  /** 修完的 SQL，可以直接交给 node-sql-parser */
  sql: string
  /** 表名（小写）→ 表注释 */
  tableComments: Map<string, string>
  /** `表名.字段名`（小写）→ 字段注释 */
  columnComments: Map<string, string>
  /** 表名（小写）→（字段名（小写）→ 用户原样写的类型文本） */
  declaredTypes: Map<string, Map<string, string>>
  /** 真的改过类型词才为 true。用来决定要不要在 warnings 里提一句 */
  typesRepaired: boolean
  /** 这段 DDL 有确凿的 Oracle 特征（见 ORACLE_ONLY / comment on），可以按 Oracle 语义解释类型 */
  oracleSyntax: boolean
}

/* ---------- 底层：只在「代码区」上做替换 ---------- */

/**
 * 在字符串字面量和注释之外做替换。
 *
 * 直接 `sql.replace(/\bNUMBER\b/gi, …)` 会把 `default 'NUMBER'` 里的也换掉——
 * 那是用户的数据，不是类型词。掩码复用 `statements.ts` 的 `codeMask`，
 * 不在这里再写一个引号扫描器（写两份必然走偏，logFill 那边已经吃过这个教训）。
 *
 * replacement 里可以写 `$1`（见 TYPE_FIXES 里带括号的那几条）。**不要**改成
 * `String.prototype.replace` 那条捷径：那样就绕过掩码了，`VARCHAR2(20 CHAR)`
 * 这种规则会连字符串字面量里的一起改。
 */
function replaceInCode(sql: string, pattern: RegExp, replacement: string): { text: string; hits: number } {
  const mask = codeMask(sql)
  let out = ''
  let last = 0
  let hits = 0

  pattern.lastIndex = 0
  for (let m = pattern.exec(sql); m; m = pattern.exec(sql)) {
    if (!mask[m.index]) continue
    out += sql.slice(last, m.index) + replacement.replace(/\$(\d)/g, (_, d: string) => m[Number(d)] ?? '')
    last = m.index + m[0].length
    hits += 1
  }
  return { text: out + sql.slice(last), hits }
}

/** 从 `open`（必须指向 `(`）开始找配对的右括号，返回它的下标；找不到返回 -1 */
function matchParen(sql: string, mask: boolean[], open: number): number {
  let depth = 0
  for (let i = open; i < sql.length; i++) {
    if (!mask[i]) continue
    if (sql[i] === '(') depth += 1
    else if (sql[i] === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** 按顶层逗号切分（括号里的逗号不算），用来拆建表语句的字段定义 */
function splitTopLevel(body: string): string[] {
  const mask = codeMask(body)
  const out: string[] = []
  let depth = 0
  let start = 0

  for (let i = 0; i < body.length; i++) {
    if (!mask[i]) continue
    const c = body[i]
    if (c === '(') depth += 1
    else if (c === ')') depth -= 1
    else if (c === ',' && depth === 0) {
      out.push(body.slice(start, i))
      start = i + 1
    }
  }
  out.push(body.slice(start))
  return out.filter((s) => s.trim() !== '')
}

/* ---------- 1. comment on ---------- */

/**
 * `comment on table T is '…'` / `comment on column T.C is '…'`。
 * 值里的 `''` 是转义的单引号（Oracle 就这么写），所以用 `(?:[^']|'')*` 而不是 `[^']*`——
 * 后者会在 `'流程''类别'` 中间断开，剩下半截 SQL 继续参与解析，报的错还指向别处。
 *
 * 标识符**开头**的引号必须收进来：表名是保留字时（`comment on table "ORDER"`）Oracle 只能
 * 这么写。少了那个 `["`[]?`，整条 comment on 匹配不上 → 这张表的注释一条都摘不到，
 * 而且那条语句还留在 SQL 里被后面当成「不认识的语句」静默跳过，界面上只是注释莫名为空。
 */
const COMMENT_ON =
  /\bcomment\s+on\s+(table|column)\s+(["`[]?[A-Za-z_$#][\w$#."`[\]]*)\s+is\s+'((?:[^']|'')*)'\s*;?/gi

/** `"SCHEMA"."T_USER".ID` → ['schema', 't_user', 'id'] */
const dotted = (name: string): string[] =>
  name
    .split('.')
    .map((p) => p.replace(/^["`[]+|["`\]]+$/g, '').trim().toLowerCase())
    .filter(Boolean)

function takeComments(sql: string): {
  sql: string
  tableComments: Map<string, string>
  columnComments: Map<string, string>
} {
  const tableComments = new Map<string, string>()
  const columnComments = new Map<string, string>()
  const mask = codeMask(sql)

  let out = ''
  let last = 0
  COMMENT_ON.lastIndex = 0
  for (let m = COMMENT_ON.exec(sql); m; m = COMMENT_ON.exec(sql)) {
    if (!mask[m.index]) continue
    const parts = dotted(m[2])
    const text = m[3].replace(/''/g, "'").trim()

    if (m[1].toLowerCase() === 'table') {
      if (parts.length && text) tableComments.set(parts[parts.length - 1], text)
    } else if (parts.length >= 2 && text) {
      columnComments.set(`${parts[parts.length - 2]}.${parts[parts.length - 1]}`, text)
    }

    // 整条语句摘掉，不留空分号：留着的话 astify 会在空语句上报错
    out += sql.slice(last, m.index)
    last = m.index + m[0].length
  }

  return { sql: out + sql.slice(last), tableComments, columnComments }
}

/* ---------- 2. 类型词 ---------- */

/**
 * Oracle 类型 → mysql 语法认识的等价词。**只为过解析**，解析完会用
 * `declaredTypes` 把用户原样写的类型盖回去，所以这里的等价性只需要
 * 「长度/精度参数的形状一致」，不需要语义完全相同。
 *
 * 顺序有讲究：NVARCHAR2 必须排在 NVARCHAR 前面，否则前者会被切成 `VARCHAR2`；
 * LONG RAW 必须排在 RAW 前面；带 `WITH TIME ZONE` 的 TIMESTAMP 必须排在
 * 「砍掉 TIMESTAMP(6) 的精度」前面，否则剩下 `TIMESTAMP WITH TIME ZONE` 照样解析不了。
 *
 * 这张表里每一条都是「少了它，整张表一个字段都出不来」——mysql 语法遇到不认识的类型词
 * 是整条语句报废，不是跳过那一列。
 */
const TYPE_FIXES: Array<[RegExp, string]> = [
  // VARCHAR2(20 CHAR) / (20 BYTE)：长度单位是 Oracle 特有的写法，PL/SQL Developer 导出时常带
  [/\b(N?VARCHAR2?|N?CHAR)\s*\(\s*(\d+)\s*(?:CHAR|BYTE)\s*\)/gi, '$1($2)'],
  // NUMBER(*,0) 的 * 是「最大精度」，也就是 38 位
  [/\bNUMBER\s*\(\s*\*\s*,\s*(-?\d+)\s*\)/gi, 'DECIMAL(38,$1)'],
  [/\bNUMBER\s*\(\s*\*\s*\)/gi, 'DECIMAL(38)'],
  [/\bTIMESTAMP\s*(?:\(\s*\d+\s*\))?\s+WITH\s+(?:LOCAL\s+)?TIME\s+ZONE\b/gi, 'TIMESTAMP'],
  // INTERVAL 没有 mysql 等价类型，换成够长的 VARCHAR 只是为了让这一列不拖垮整条语句
  [/\bINTERVAL\s+DAY\s*(?:\(\s*\d+\s*\))?\s+TO\s+SECOND\s*(?:\(\s*\d+\s*\))?/gi, 'VARCHAR(30)'],
  [/\bINTERVAL\s+YEAR\s*(?:\(\s*\d+\s*\))?\s+TO\s+MONTH\b/gi, 'VARCHAR(30)'],
  [/\bNVARCHAR2\b/gi, 'VARCHAR'],
  [/\bVARCHAR2\b/gi, 'VARCHAR'],
  [/\bNVARCHAR\b/gi, 'VARCHAR'],
  [/\bNCHAR\b/gi, 'CHAR'],
  [/\bNUMBER\b/gi, 'DECIMAL'],
  [/\bNCLOB\b/gi, 'TEXT'],
  [/\bCLOB\b/gi, 'TEXT'],
  [/\bLONG\s+RAW\b/gi, 'BLOB'],
  [/\bLONG\b/gi, 'TEXT'],
  [/\bRAW\b/gi, 'VARBINARY'],
  [/\bBINARY_DOUBLE\b/gi, 'DOUBLE'],
  [/\bBINARY_FLOAT\b/gi, 'FLOAT'],
  [/\bXMLTYPE\b/gi, 'TEXT'],
  [/\b(?:UROWID|ROWID)\b/gi, 'VARCHAR(18)'],
  [/\bBFILE\b/gi, 'BLOB'],
  // 这三个不是 Oracle 专有，是标准 SQL 的写法，mysql 语法照样不认
  [/\bDOUBLE\s+PRECISION\b/gi, 'DOUBLE'],
  [/\bCHARACTER\s+VARYING\b/gi, 'VARCHAR'],
  [/\bDEC\b/gi, 'DECIMAL'],
  // mysql 语法不认 TIMESTAMP(6) / TIME(3) 这种带精度的写法
  [/\b(TIMESTAMP|TIME)\s*\(\s*\d+\s*\)/gi, '$1'],
]

/**
 * 字段定义上的 Oracle 子句。跟 TYPE_FIXES 分开，因为这些**不是类型词**——
 * `isRepairedType` 只查 TYPE_FIXES，不该被这些规则带着去覆盖用户的类型文本。
 *
 * 这些子句一个都不影响表结构，但每一个都会让整条 create table 报废
 * （mysql 语法遇到不认识的子句是整条语句失败，不是跳过那一列）。
 */
const CLAUSE_FIXES: Array<[RegExp, string]> = [
  // Oracle 12c 的 identity 列就是自增。换成 AUTO_INCREMENT 而不是删掉，
  // 这样 isAutoIncrement 才为 true，生成的 INSERT 会自动排除这一列（PRD 4.4）
  [
    /\bGENERATED\s+(?:ALWAYS|BY\s+DEFAULT)(?:\s+ON\s+NULL)?\s+AS\s+IDENTITY(?:\s*\([^)]*\))?/gi,
    'AUTO_INCREMENT',
  ],
  [/\bDEFAULT\s+ON\s+NULL\b/gi, 'DEFAULT'],
  // 具名的行内非空约束：`CONSTRAINT nn_x NOT NULL`。要求后面紧跟 NOT NULL，
  // 否则会把表级的 `CONSTRAINT pk_x PRIMARY KEY (…)` 一起吃掉
  [/\bCONSTRAINT\s+["`]?[\w$#]+["`]?\s+(NOT\s+NULL|NULL)\b/gi, '$1'],
  // `not null enable` / `not null disable novalidate`：约束状态，跟结构无关
  [/\b(NOT\s+NULL|NULL)\s+(?:ENABLE|DISABLE)(?:\s+(?:NO)?VALIDATE)?\b/gi, '$1'],
  [/\b(?:IN)?VISIBLE\b/gi, ''],
  // 虚拟列。刻意要求写了 VIRTUAL 关键字：不要求的话 `create table t as (select …)`
  // 这种 CTAS 语句也会被改坏
  [/\bAS\s*\([^()]*\)\s*VIRTUAL\b/gi, ''],
]

/**
 * 这个类型文本是不是「被上面的替换动过的」。
 *
 * 解析完只把这一类字段的类型盖回原样，而不是「declaredTypes 里有就盖」——
 * 后者会波及纯 MySQL 的 DDL（比如 `double precision` 我这边只截到 `DOUBLE`），
 * 把本来解析对的类型改坏。直接拿 TYPE_FIXES 反查，不另抄一份词表。
 */
export function isRepairedType(type: string): boolean {
  return TYPE_FIXES.some(([pattern]) => {
    pattern.lastIndex = 0
    return pattern.test(type)
  })
}

function repairTypes(sql: string): { sql: string; hits: number } {
  let text = sql
  let hits = 0
  for (const [pattern, replacement] of [...TYPE_FIXES, ...CLAUSE_FIXES]) {
    const r = replaceInCode(text, pattern, replacement)
    text = r.text
    hits += r.hits
  }
  return { sql: text, hits }
}

/* ---------- 3. 存储子句 ---------- */

/**
 * 建表语句字段块之后的 Oracle 存储子句。**白名单**而不是「一律砍掉右括号后面的东西」：
 * MySQL 的 `ENGINE=InnoDB COMMENT='用户表'` 也在右括号后面，砍掉就把表注释弄丢了。
 */
const CREATE_TAIL =
  /^\s*(tablespace|pctfree|pctused|pctincrease|initrans|maxtrans|storage|logging|nologging|nocompress|compress|cache|nocache|noparallel|parallel|monitoring|nomonitoring|segment\s+creation|organization\s+index|lob\s*\(|partition\s+by|subpartition\s+by|enable\s+row\s+movement|disable\s+row\s+movement|result_cache|flashback\s+archive)\b/i

/** 约束语句尾巴上的东西：`using index tablespace X`、`enable novalidate`、`deferrable` */
const ALTER_TAIL = /^\s*(using\s+index|enable|disable|validate|novalidate|deferrable|not\s+deferrable|initially)\b/i

/**
 * 去掉语句开头的注释行。
 *
 * `splitStatements` 是按分号切的，注释行会留在下一条语句的**开头**，
 * PL/SQL Developer 导出的每条语句前面正好都有一行 `-- Create table`，
 * 于是 `/^\s*create\s+table/` 这类判断会全部落空——表面上没报错，
 * 只是类型和存储子句的处理静悄悄一条都没生效。
 */
function stripLeadingComments(stmt: string): string {
  let text = stmt
  for (;;) {
    const next = text.replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)/, '')
    if (next === text) return text.trimStart()
    text = next
  }
}

/** 砍掉一条语句里「定义块之后」的存储子句 */
function trimTail(stmt: string): string {
  const text = stripLeadingComments(stmt)
  const mask = codeMask(text)
  const isCreate = /^create\s+(?:global\s+temporary\s+)?table\b/i.test(text)
  const isAlter = /^alter\s+table\b/i.test(text)
  if (!isCreate && !isAlter) return stmt

  // create table 看第一个顶层括号（字段块）；alter 看最后一个（约束的列清单）
  let close = -1
  for (let i = 0; i < text.length; i++) {
    if (!mask[i] || text[i] !== '(') continue
    const end = matchParen(text, mask, i)
    if (end < 0) break
    close = end
    if (isCreate) break
    i = end
  }
  if (close < 0) return stmt

  const tail = text.slice(close + 1)
  const pattern = isCreate ? CREATE_TAIL : ALTER_TAIL
  if (!pattern.test(tail.replace(/;\s*$/, ''))) return stmt
  return `${text.slice(0, close + 1)};`
}

/* ---------- 记下用户原样写的类型 ---------- */

/**
 * `id NUMBER(25) not null` → 取出 `id` 和 `NUMBER(25)`；约束行返回 undefined。
 *
 * 类型后面允许再跟几个**类型自己的词**（白名单），因为有些类型名不止一个词：
 * `TIMESTAMP(6) WITH TIME ZONE`、`INTERVAL DAY(3) TO SECOND(6)`、`LONG RAW`、
 * `DOUBLE PRECISION`。只截第一个词的话，记下来的「原样类型」是半截的，
 * 盖回去之后界面上显示 `TIMESTAMP(6)`——时区那半截凭空消失，Java 类型也跟着错。
 * 白名单里刻意没有 `NOT` / `DEFAULT` / `PRIMARY`，免得把约束当成类型的一部分。
 */
const TYPE_TAIL_WORDS = 'WITH|LOCAL|TIME|ZONE|TO|DAY|SECOND|MINUTE|HOUR|MONTH|YEAR|RAW|PRECISION|VARYING'
const COLUMN_DECL = new RegExp(
  '^\\s*["`[]?([A-Za-z_$#][\\w$#]*)["`\\]]?\\s+' +
    '(["`[]?[A-Za-z_][\\w]*["`\\]]?(?:\\s*\\([^)]*\\))?' +
    `(?:\\s+(?:${TYPE_TAIL_WORDS})\\b(?:\\s*\\(\\s*\\d+\\s*\\))?)*)`,
  'i',
)
const CONSTRAINT_HEAD = /^\s*(constraint|primary\s+key|unique|foreign\s+key|check|key|index)\b/i

/**
 * 类型文本的展示形态：括号**外面**的词转大写并压掉多余空格，括号**里面**原样留着。
 *
 * 两边都不能一视同仁：
 *   - 全部转大写会把 `enum('a','b')` 的枚举值改成 'A','B'，那是用户的数据；
 *   - 全部原样留着，`timestamp(6) with time zone` 显示出来跟同一张表里其他大写类型不齐。
 * 纯数字的参数额外压掉空格（`NUMBER(10, 2)` → `NUMBER(10,2)`），跟生成器里的写法对齐，
 * 否则导出 DDL 时同一个类型会出现两种写法。
 */
function normalizeDeclared(raw: string): string {
  let out = ''
  let i = 0
  while (i < raw.length) {
    const open = raw.indexOf('(', i)
    if (open < 0) {
      out += raw.slice(i).toUpperCase().replace(/\s+/g, ' ')
      break
    }
    out += raw.slice(i, open).toUpperCase().replace(/\s+/g, ' ')
    const close = raw.indexOf(')', open)
    const end = close < 0 ? raw.length : close + 1
    const args = raw.slice(open, end)
    out += /^\(\s*[\d\s,+-]*\)?$/.test(args) ? args.replace(/\s+/g, '') : args
    i = end
  }
  return out.trim()
}

function readDeclaredTypes(sql: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>()

  for (const stmt of splitStatements(sql)) {
    // 注释行会挂在语句开头，先剥掉；剥完再算下标，否则下面的 indexOf 全错位
    const text = stripLeadingComments(stmt.text)
    // 表名开头的引号跟 COMMENT_ON 一样要收进来（`create table "ORDER"`），
    // 否则这张表的 declaredTypes 整份缺失，NVARCHAR2(32) 会以 VARCHAR(32) 的样子显示出去
    const head = /^create\s+(?:global\s+temporary\s+)?table\s+(?:if\s+not\s+exists\s+)?(["`[]?[A-Za-z_$#][\w$#."`[\]]*)/i.exec(text)
    if (!head) continue
    const parts = dotted(head[1])
    const table = parts[parts.length - 1]
    if (!table) continue

    const mask = codeMask(text)
    const open = text.indexOf('(', head[0].length)
    if (open < 0 || !mask[open]) continue
    const close = matchParen(text, mask, open)
    if (close < 0) continue

    const types = out.get(table) ?? new Map<string, string>()
    for (const part of splitTopLevel(text.slice(open + 1, close))) {
      if (CONSTRAINT_HEAD.test(part)) continue
      const m = COLUMN_DECL.exec(part)
      if (!m) continue
      types.set(m[1].toLowerCase(), normalizeDeclared(m[2].replace(/["`[\]]/g, '')))
    }
    out.set(table, types)
  }
  return out
}

/* ---------- 4. 双引号标识符 ---------- */

/**
 * Oracle 的双引号是**标识符**引用（`"ORDER"."ID"`），mysql 语法却只认反引号：
 * `"id" NUMBER(19)` 里的 `"id"` 会被当成字符串字面量，紧跟着的类型词当场把
 * 整条 create table 弄死。表名位置它反而认（`create table "ORDER"` 一直导得进来），
 * 所以内置示例和日常粘贴从没暴露——但导出侧（ddlExport）给每个列名都包了双引号
 * （保留字和大小写保真全靠它），SQL Developer / DataGrip 的全引号导出也是这个形状：
 * 「导出 → 再导入」这条回路之前是断的，round-trip 用例当场抓住了它。
 *
 * 只转「长得像标识符」的双引号段；内容带空格/中文的不碰——那是 MySQL 风格的
 * 双引号字符串（`default "abc"`），动了就破坏「对纯 MySQL DDL 恒等变换」的底线。
 * 掩码用 doubleQuoteAsCode 变体：默认掩码把双引号区整个掩成字符串根本匹配不上；
 * 换了变体之后，单引号字符串和注释里的 `"xxx"`（用户数据）仍然被掩掉，不会误伤。
 */
function unifyIdentQuotes(sql: string): string {
  const mask = codeMask(sql, { doubleQuoteAsCode: true })
  let out = ''
  let last = 0
  const QUOTED_IDENT = /"([A-Za-z_$#][\w$#]*)"/g
  for (let m = QUOTED_IDENT.exec(sql); m; m = QUOTED_IDENT.exec(sql)) {
    if (!mask[m.index]) continue
    out += sql.slice(last, m.index) + '`' + m[1] + '`'
    last = m.index + m[0].length
  }
  return out + sql.slice(last)
}

/* ---------- 主入口 ---------- */

/**
 * 「这段 DDL 确凿是 Oracle」的判据。
 *
 * 故意不复用 TYPE_FIXES 的词表：`NCHAR` / `NVARCHAR` / `TIMESTAMP(6)` 是标准 SQL，
 * MySQL 也能写，拿它们当 Oracle 证据会把 MySQL 的 DDL 也按 Oracle 语义解释
 * （比如把 DATE 当成带时分秒的）。这里只留 Oracle 独有的。
 */
const ORACLE_ONLY =
  /^(?:NUMBER|VARCHAR2|NVARCHAR2|NCLOB|CLOB|LONG\s+RAW|RAW|BINARY_DOUBLE|BINARY_FLOAT|XMLTYPE|UROWID|ROWID|BFILE)\b/i

export function prepareOracleDdl(sql: string): OraclePrep {
  const stripped = takeComments(unifyIdentQuotes(sql))
  // 类型要在替换**之前**记下来，记的是用户原样写的东西
  const declaredTypes = readDeclaredTypes(stripped.sql)

  const trimmed = splitStatements(stripped.sql)
    .map((s) => trimTail(s.text))
    .join('\n')
  // splitStatements 会把纯注释片段丢掉，一条语句都没有时（比如整段就是 comment on）
  // 保留原文，让后面的解析器去报错，而不是在这里静默变成空串
  const body = trimmed.trim() ? trimmed : stripped.sql

  const fixed = repairTypes(body)

  // comment on 是 Oracle 独有语法，出现即可确认
  const oracleSyntax =
    stripped.tableComments.size > 0 ||
    stripped.columnComments.size > 0 ||
    [...declaredTypes.values()].some((cols) => [...cols.values()].some((t) => ORACLE_ONLY.test(t)))

  return {
    sql: fixed.sql,
    tableComments: stripped.tableComments,
    columnComments: stripped.columnComments,
    declaredTypes,
    typesRepaired: fixed.hits > 0,
    oracleSyntax,
  }
}
