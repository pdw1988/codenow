/**
 * 日志参数回填，PRD 4.14。
 *
 * 排查问题时日志里打出来的是占位符形式（`INSERT INTO user ... VALUES (?, ?)`
 * 外加一行参数），想在本地库复现就得手工把参数填回 `?` 的位置，还要自己判断
 * 哪个该加引号。十几个 `?` 的时候极容易错位——**错位之后语句照样能跑，只是数据是错的**，
 * 比报错难查得多。这个模块把那步替换自动化。
 *
 * 跟 4.6~4.9 的区别：那几节是「没有数据，造一条」，这一节是「数据在日志里，还原它」。
 * 所以这里完全不依赖表结构缓存。
 *
 * 这个模块最需要守住的不是「多认识几种日志格式」，而是**认不出来就说认不出来**：
 * 占位符个数跟参数个数不匹配时必须报错，绝不默默少填多填凑出一条能跑的语句。
 */
import { DIALECTS, type GenDialect } from './dialect'
import { codeMask } from './statements'

/** 日志来源。认不出来时按 plain 处理（裸 SQL + 参数行） */
export type LogFormat = 'mybatis' | 'druid' | 'hibernate' | 'p6spy' | 'plain'

export const FORMAT_LABELS: Record<LogFormat, string> = {
  mybatis: 'MyBatis 日志',
  druid: 'Druid 日志',
  hibernate: 'Hibernate 日志',
  p6spy: 'p6spy 日志',
  plain: '占位符 SQL + 参数',
}

/** 值的大类。Java 类型名和 SQL 类型名都归到这几类，后面只按类别决定引号 */
type ValueClass = 'string' | 'number' | 'bool' | 'date' | 'null' | 'unknown'

export interface LogParam {
  /** 日志里的原样文本，含类型标注，给用户核对用 */
  raw: string
  /** 剥掉类型标注后的值。这一列在 UI 上可改（PRD 4.14） */
  value: string
  /** 日志里标的类型，没标则 undefined */
  declaredType?: string
}

export interface LogStatement {
  format: LogFormat
  /** 带 `?` 的原始 SQL */
  template: string
  /** 裸 `?` 的个数（字符串和注释里的不算） */
  placeholders: number
  params: LogParam[]
}

/** 解析结果：只做「拆出模板和参数」，拼 SQL 是另一步，因为用户可以改参数值 */
export interface LogParseResult {
  statements: LogStatement[]
  /** 一条都没解析出来时的说明，给 UI 直接显示 */
  note?: string
}

/* ---------- 类型 → 引号规则 ---------- */

/**
 * Java 类型名（MyBatis / Druid 日志里括号里那个）→ 值的大类。
 * 用 endsWith 匹配是因为日志里可能是全限定名（java.lang.String / java.sql.Timestamp）。
 */
const JAVA_CLASSES: Array<[string[], ValueClass]> = [
  [['String', 'Character', 'Char', 'Clob', 'NClob', 'UUID'], 'string'],
  [
    ['Integer', 'Int', 'Long', 'Short', 'Byte', 'Double', 'Float', 'BigDecimal', 'BigInteger', 'Number'],
    'number',
  ],
  [['Boolean', 'Bool'], 'bool'],
  [
    ['Timestamp', 'Date', 'Time', 'LocalDateTime', 'LocalDate', 'LocalTime', 'OffsetDateTime', 'ZonedDateTime', 'Instant', 'Calendar'],
    'date',
  ],
]

/** SQL 类型名（Hibernate 日志里 `as [BIGINT]` 那个）→ 值的大类 */
const SQL_CLASSES: Array<[string[], ValueClass]> = [
  [['CHAR', 'VARCHAR', 'NVARCHAR', 'VARCHAR2', 'TEXT', 'CLOB', 'STRING', 'ENUM', 'JSON', 'UUID'], 'string'],
  [
    ['INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'DECIMAL', 'NUMERIC', 'NUMBER', 'DOUBLE', 'FLOAT', 'REAL', 'BIT'],
    'number',
  ],
  [['BOOLEAN', 'BOOL'], 'bool'],
  [['DATE', 'TIME', 'TIMESTAMP', 'DATETIME'], 'date'],
]

function lookup(declared: string): ValueClass {
  // 泛型/数组的尾巴去掉：java.util.List<String> 这种在日志里出现过
  const bare = declared.replace(/<.*>$/, '').replace(/\[\]$/, '')
  const short = bare.slice(bare.lastIndexOf('.') + 1)

  for (const [names, cls] of JAVA_CLASSES) {
    if (names.some((n) => n.toLowerCase() === short.toLowerCase())) return cls
  }
  const upper = short.toUpperCase()
  for (const [names, cls] of SQL_CLASSES) {
    if (names.includes(upper)) return cls
  }
  return 'unknown'
}

function classify(declared: string | undefined, value: string): ValueClass {
  const trimmed = value.trim()
  if (/^null$/i.test(trimmed)) return 'null'

  // 没有类型标注时，空串跟 null 在日志里长得一样，分不出来，只能当 NULL
  if (!declared) return trimmed === '' ? 'null' : 'unknown'

  const cls = lookup(declared)
  /*
   * PRD 4.14 边界 6：**空串和 null 是两回事**。
   * MyBatis 给 null 参数打的是不带类型的 `null`，而空串打出来是 `(String)`——
   * 前面什么都没有但类型还在。所以「标着字符串类型 + 值是空」只能是空串，
   * 必须输出 ''。当成 NULL 的话，非空列会插入失败，或者把「查空串」查成「查 NULL」，
   * 两者在 SQL 里的语义完全不同（`= ''` 有结果，`= NULL` 永远无结果）。
   *
   * 非字符串类型的空值反过来当 NULL：标着 Integer 却没有值，写 '' 进去是类型错误。
   */
  if (trimmed === '' && cls !== 'string') return 'null'
  return cls
}

/** 单引号翻倍。跟 mockValue.quoteLiteral 同一个道理：不翻倍，O'Brien 会把语句断在半截 */
const quote = (text: string) => `'${text.replace(/'/g, "''")}'`

/**
 * 这些原样写进 SQL 不加引号，跟可执行模式（mockValue.RAW_EXPRESSIONS）保持一致。
 * 用户在对照表里把值改成 NOW() 时要的就是这个行为——那是绕过引号的唯一出口。
 *
 * TRUE / FALSE **刻意不在这张表里**：它们得按方言给（Oracle 23c 以下没有布尔字面量，
 * 原样写 TRUE 进去是 ORA-00904），交给下面的 renderBool 处理。
 */
const RAW = new Set([
  'NULL',
  'DEFAULT',
  'NOW()',
  'SYSDATE',
  'CURRENT_TIMESTAMP',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'CURDATE()',
  'CURTIME()',
  'UUID()',
])

/** 布尔字面量按方言给，规则跟可执行模式共用一处（`dialect.ts` 的 boolLiteral） */
const renderBool = (truthy: boolean, dialect: GenDialect): string =>
  DIALECTS[dialect].boolLiteral(truthy)

const DATE_SHAPE = /^\d{4}-\d{1,2}-\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?)?$/

export interface RenderedParam extends LogParam {
  /** 填进 SQL 的字面量 */
  literal: string
  /** 类型没认出来、只能保守加引号。UI 上标 ⚠️ 提醒人核对 */
  uncertain: boolean
}

/**
 * 参数值 → SQL 字面量，PRD 4.14 的规则表。
 *
 * 没有类型标注时（格式 2 / Druid）按值本身的形状判断，跟 renderValue 一个思路：
 * 纯数字不加引号、null 给 NULL、其余加引号。这里不复用 renderValue 是因为它
 * 要一个 Column（要 javaType 和声明类型），而日志里根本没有表结构。
 */
export function renderParam(param: LogParam, dialect: GenDialect): RenderedParam {
  const value = param.value.trim()
  const cls = classify(param.declaredType, param.value)

  const done = (literal: string, uncertain = false): RenderedParam => ({ ...param, literal, uncertain })

  if (cls === 'null') return done('NULL')

  const upper = value.toUpperCase()
  /*
   * TRUE / FALSE 先于类型判断：用户在对照表里手打 TRUE 时，不管日志里标的什么类型，
   * 要的都是「一个布尔真值」，而它在 Oracle 上必须写成 1。
   */
  if (upper === 'TRUE' || upper === 'FALSE') return done(renderBool(upper === 'TRUE', dialect))
  // 其余关键字优先：用户手改成 NOW() / NULL 时，不管日志里标的什么类型都按关键字处理
  if (RAW.has(upper)) return done(upper)

  switch (cls) {
    case 'number':
      // 标着 Integer 但值不是数字（日志被截断过？）——加引号至少能看出问题，
      // 裸着写进去是语法错误，而语法错误比错数据好，所以这里不标 uncertain
      return done(/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value) ? value : quote(value))
    case 'bool':
      // 日志里的布尔可能打成 1 / t / y，不只是 true
      return done(renderBool(/^(true|1|t|y|yes)$/i.test(value), dialect))
    case 'date': {
      // 日志里 Timestamp 常带毫秒或 T 分隔（2026-08-22T10:30:00.123），
      // 规整成 Oracle 的 TO_DATE 认得的形状；认不出形状就原样加引号
      const m = DATE_SHAPE.exec(value)
      if (!m) return done(quote(value))
      const normalized = value.replace('T', ' ').replace(/\.\d+$/, '')
      return done(DIALECTS[dialect].dateLiteral(normalized))
    }
    case 'string':
      return done(quote(value))
    default:
      // 没有类型标注：按形状猜，猜不出来加引号。标 uncertain 让 UI 提示核对
      if (/^-?\d+(\.\d+)?$/.test(value)) return done(value)
      if (DATE_SHAPE.test(value)) return done(DIALECTS[dialect].dateLiteral(value.replace('T', ' ')))
      return done(quote(value), param.declaredType !== undefined)
  }
}

/* ---------- 占位符替换 ---------- */

/**
 * 把 `?` 换成字面量。
 *
 * 只换**裸** `?`：`WHERE remark = 'a?b' AND id = ?` 里只有第二个是占位符，
 * 字符串和注释里的问号原样保留。codeMask 是从 statements.ts 借的同一个扫描器
 * （见那边的注释：这种状态机写两份必然会走偏）。
 *
 * 从左到右一次扫完，所以替换进去的值里如果自己带 `?`，不会被二次替换。
 */
export function fillPlaceholders(template: string, literals: string[]): string {
  const mask = codeMask(template)
  let out = ''
  let k = 0
  for (let i = 0; i < template.length; i++) {
    if (template[i] === '?' && mask[i]) {
      out += k < literals.length ? literals[k] : '?'
      k += 1
      continue
    }
    out += template[i]
  }
  return out
}

/** 裸 `?` 的个数 */
export function countPlaceholders(sql: string): number {
  const mask = codeMask(sql)
  let n = 0
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === '?' && mask[i]) n += 1
  }
  return n
}

/**
 * 日志回填从语句骨架猜字面量方言。INSERT / UPDATE / DELETE 同一套规则——
 * 看的是反引号、NVL、ILIKE 这些写法，不是动词。
 * 只覆盖 Oracle / MySQL / PostgreSQL；SQLite 不猜。看不出来默认 Oracle。
 * 字符串和注释里的反引号、TO_DATE 不算（codeMask）。
 */
export type FillDialect = 'oracle' | 'mysql' | 'postgresql'

export function inferFillDialect(sql: string): FillDialect {
  const mask = codeMask(sql)
  // 反引号在 codeMask 里是标识符引号，本身和里头都被掩掉，不能靠「代码字符含 `」判断。
  // 开引号紧跟在一段代码后面（INSERT INTO `order` 的空格），字符串里的 ` 前面是被掩的。
  for (let i = 0; i < sql.length - 1; i++) {
    if (mask[i] && sql[i + 1] === '`') return 'mysql'
  }
  let code = ''
  for (let i = 0; i < sql.length; i++) code += mask[i] ? sql[i] : ' '
  const up = code.toUpperCase()
  if (/\b(?:TO_DATE|NVL|SYSDATE|ROWNUM|VARCHAR2|NVARCHAR2)\b/.test(up) || /\bFROM\s+DUAL\b/.test(up)) {
    return 'oracle'
  }
  if (code.includes('::') || /\bILIKE\b/.test(up)) return 'postgresql'
  return 'oracle'
}

/* ---------- 参数列表的切分 ---------- */

/** `(String)` / `(java.sql.Timestamp)` 这种类型标注，是切分参数的锚点 */
const TYPE_MARK = /\(([A-Za-z][A-Za-z0-9_.$<>[\]]*)\)/g

/**
 * 挑锚点的严格程度。
 *
 * 值里带括号是常事（`Acme Store (Ningbo)(String)`、`是否发布 (0未发布 1已发布)`），
 * 一律把 `(某个词)` 当类型标注的话，一个参数会被切成三个，而且**切完个数不对也照样往下走**。
 * 所以按三档从严到宽试，取「切出来的个数正好等于占位符个数」的那一档——
 * 跟 splitUntyped 试分隔符是同一个套路，个数是这里唯一能自我验证的信号。
 */
type AnchorMode =
  /** 紧贴参数末尾（后面只有逗号或结尾）+ 是认识的类型名 */
  | 'strict'
  /** 只要求紧贴参数末尾，类型名不限（自定义 TypeHandler 会打出业务类名） */
  | 'segment'
  /** 出现在哪儿都算，最宽松 */
  | 'loose'

interface Anchor {
  /** 类型标注开始的位置 */
  index: number
  /** 类型标注结束后的位置 */
  end: number
  type: string
}

function anchorsOf(text: string, mode: AnchorMode): Anchor[] {
  const out: Anchor[] = []
  TYPE_MARK.lastIndex = 0
  for (let m = TYPE_MARK.exec(text); m; m = TYPE_MARK.exec(text)) {
    const end = m.index + m[0].length
    // 后面还跟着别的东西 → 它是值的一部分，不是类型标注
    if (mode !== 'loose' && !/^\s*(?:,|$)/.test(text.slice(end))) continue
    if (mode === 'strict' && lookup(m[1]) === 'unknown') continue
    out.push({ index: m.index, end, type: m[1] })
  }
  return out
}

/**
 * 按给定的锚点切分 MyBatis 风格的参数串：`张三(String), 18(Integer), null`。
 *
 * 不能直接 split(', ')：值自己可能带逗号（`北京市, 朝阳区(String)` 是一个参数）。
 * 所以拿 `(类型)` 当锚点——两个锚点之间的整段都是一个值。
 *
 * 剩下一个歧义没法从语法上消掉：`null, 张三(String)` 和 `北京市, 朝阳区(String)`
 * 长得一模一样。规则是**只有恰好等于 null 的前缀才当作独立参数**——MyBatis 也只在
 * 参数为 null 时才不打类型。猜错了用户能在对照表里改（PRD 4.14）。
 */
function buildTyped(text: string, anchors: Anchor[]): LogParam[] {
  const out: LogParam[] = []
  let cursor = 0

  const pushRaw = (raw: string, declaredType?: string) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    const value = declaredType
      ? trimmed.slice(0, trimmed.lastIndexOf('(')).trim()
      : trimmed
    out.push({ raw: trimmed, value, declaredType })
  }

  for (const anchor of anchors) {
    let seg = text.slice(cursor, anchor.end).replace(/^\s*,\s*/, '')
    cursor = anchor.end
    // 前缀里的裸 null 拆出来
    while (/^null\s*,/i.test(seg)) {
      out.push({ raw: 'null', value: 'null' })
      seg = seg.replace(/^null\s*,\s*/i, '')
    }
    pushRaw(seg, anchor.type)
  }

  // 最后一个锚点之后的尾巴：只可能是无类型的参数（一般是 null）
  const tail = text.slice(cursor).replace(/^\s*,\s*/, '').trim()
  if (tail) {
    for (const piece of tail.split(/\s*,\s*/)) pushRaw(piece)
  }
  return out
}

/** 三档锚点依次试，取个数对得上的那一档；都对不上退回最宽松的（让个数错误暴露到 UI） */
function splitTyped(text: string, expected: number): LogParam[] {
  let loose: LogParam[] = []
  for (const mode of ['strict', 'segment', 'loose'] as AnchorMode[]) {
    const params = buildTyped(text, anchorsOf(text, mode))
    if (params.length === expected) return params
    if (mode === 'loose') loose = params
  }
  return loose
}

/**
 * 切分没有类型标注的参数串，PRD 4.14 格式 2。
 *
 * 分隔符是什么只有天知道——用户从日志里抠出来的可能是逗号、制表符，
 * 也可能就是空格（`参数值1 参数值2`）。所以挨个试，**以「切出来的个数正好等于
 * 占位符个数」为准**：这是唯一能自我验证的信号。全都不匹配时用逗号切，
 * 让个数不匹配的错误暴露到 UI 上，而不是在这里瞎猜一个。
 */
function splitUntyped(text: string, expected: number): LogParam[] {
  const body = text.trim().replace(/^\[(.*)\]$/s, '$1')
  const candidates: RegExp[] = [/\s*,\s*/, /\t+/, /\s{2,}/, /\s+/]

  const bare = (pieces: string[]): LogParam[] =>
    pieces.map((p) => ({ raw: p.trim(), value: p.trim() }))

  for (const sep of candidates) {
    const pieces = body.split(sep).filter((p) => p.trim() !== '')
    if (pieces.length === expected) return bare(pieces)
  }
  return bare(body.split(/\s*,\s*/).filter((p) => p.trim() !== ''))
}

/** 有类型标注就走锚点切分，没有就走「试分隔符」那条路 */
function splitParams(text: string, expected: number): LogParam[] {
  TYPE_MARK.lastIndex = 0
  return TYPE_MARK.test(text) ? splitTyped(text, expected) : splitUntyped(text, expected)
}

/* ---------- 各种日志格式 ---------- */

const SQL_HEAD = /^\s*(with|select|insert|replace|update|delete|merge|call|truncate)\b/i

/** 一行里的标记，用来判断「这行是不是接着上一行的内容」 */
const MARKER = /(Preparing\s*:|Parameters\s*:|<==|==>|Hibernate\s*:|binding parameter|Total\s*:|Updates\s*:|Columns\s*:|Row\s*:)/i

/** 参数行的标记。取它后面的部分，前面的日志头一律不要 */
const PARAMS_MARK = /Parameters\s*:\s*([\s\S]*)$/i

/**
 * 行首的时间戳。`[2026-08-20 06:36:13.081]` / `2026-08-20 06:36:13,081` / `06:36:13.081` 都算。
 */
const TIME_HEAD = /^\s*[[(]?\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}:\d{2}|^\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/

/** 日志行的其余特征：级别词、`[线程]`、`[类名:行号]`、`]->` */
const LOG_MARKS = /\b(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b|\[[\w$.]+:\d+\]|\]\s*-+>?/

/**
 * 「这一行是一条**新的**日志记录」，不是上一行的续行、也不是参数。
 *
 * 判据故意要求「时间戳 **加上** 日志特征」两者都有：用户手抠出来的参数行第一个值
 * 完全可能就是 `2026-08-20 06:36:13, 张三`，只看时间戳就把整行参数当日志丢掉了。
 * 反过来，只要少了这个判断，下一条无关日志就会被当成续行接进参数里
 * ——`joinContinuation` 原来只看 MARKER，而普通业务日志（`…-> 查询完成`）一个 MARKER 都没有。
 */
const isLogRecord = (line: string): boolean => TIME_HEAD.test(line) && LOG_MARKS.test(line)

/** 从 idx 行开始，把不带标记的后续行接上去——日志里长 SQL 经常被换行折断 */
function joinContinuation(lines: string[], idx: number, first: string): { text: string; next: number } {
  let text = first
  let i = idx + 1
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || MARKER.test(line) || isLogRecord(line)) break
    text += ` ${line.trim()}`
  }
  return { text: text.trim(), next: i }
}

/**
 * 切掉一段文本**尾部**的日志头残渣：`[2026-08-20 06:36:13.081]DEBUG [pool-1][Dao.insert:159]-> ==> `。
 *
 * 用在「一行里既有 Preparing 又有 Parameters」的时候：按 `Parameters:` 切开之后，
 * SQL 那半截的尾巴上粘着的是**下一段日志的头**，不去掉就直接跟着进 SQL 了。
 * 只吃时间戳块 / 方括号块 / 级别词 / 箭头这几种东西，遇到别的（比如 `)`）立刻停，
 * 所以正常的 SQL 结尾不会被啃掉。
 */
function stripTrailingLogHead(text: string): string {
  return text.replace(
    /(?:\[[^\]\n]*\]|\b(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b|==>|<==|->|-|\s)+$/i,
    '',
  )
}

/**
 * 行**首**的日志头切掉：`[2026-08-20 …]DEBUG [pool-1][Dao.insert:159]-> ==> SELECT …`
 * 只留 `SELECT …`。
 *
 * 关键是**切完之后剩下的必须以 SQL 关键字开头才算切成功**，否则原样返回。
 * 有了这条自我验证，就不用去枚举各家框架的日志头长什么样：候选切点从左往右试，
 * 第一个能露出 SQL 的就是答案；一个都不行就说明这行本来不是 SQL，一个字都不动。
 */
function stripLeadingLogHead(line: string): string {
  if (SQL_HEAD.test(line)) return line
  for (const m of line.matchAll(/(?:==>|<==|\]\s*-+>?|:)\s*/g)) {
    const rest = line.slice((m.index ?? 0) + m[0].length)
    if (SQL_HEAD.test(rest)) return rest
  }
  return line
}

/**
 * p6spy：`|` 分成若干段，最后一段是已经填好值的 SQL。
 * 它本来就不需要回填，直接取最后一段——但仍然当作一条语句返回，
 * 好处是复制/展示/换方言那套逻辑不用为它开分支。
 */
function parseP6spy(lines: string[]): LogStatement[] {
  const out: LogStatement[] = []
  for (const line of lines) {
    const parts = line.split('|')
    if (parts.length < 5) continue
    // 从后往前找第一段像 SQL 的，优先要不带 ? 的那段（p6spy 会同时打两份）
    const sqls = parts.filter((p) => SQL_HEAD.test(p))
    if (!sqls.length) continue
    const filled = [...sqls].reverse().find((s) => countPlaceholders(s) === 0) ?? sqls[sqls.length - 1]
    out.push({
      format: 'p6spy',
      template: filled.trim(),
      placeholders: countPlaceholders(filled),
      params: [],
    })
  }
  return out
}

/**
 * MyBatis / Druid：Preparing 一行 SQL，Parameters 一行参数。
 *
 * 一条 Preparing 可以跟**多条** Parameters：批量插入（`ExecutorType.BATCH` 或
 * `foreach` 拆批）时 MyBatis 只打一次 SQL，参数一行一条。所以配上参数之后不能把
 * 模板丢掉，否则第二条往后全部静默消失——PRD 4.14 边界 5 点名要求「批量插入每组各出一条」。
 */
function parseMybatis(lines: string[]): LogStatement[] {
  const out: LogStatement[] = []
  let pending: { template: string; format: LogFormat } | null = null
  /** 当前这条 Preparing 有没有配上过参数行 */
  let matched = false

  /** 没配上参数的 Preparing：无参语句（`SELECT 1`）是正常的，照样收下 */
  const flushBare = () => {
    if (!pending || matched) return
    out.push({
      format: pending.format,
      template: pending.template,
      placeholders: countPlaceholders(pending.template),
      params: [],
    })
  }

  /** 参数配上模板，收成一条语句 */
  const emit = (template: string, format: LogFormat, paramText: string) => {
    const placeholders = countPlaceholders(template)
    // Druid 打的是 `Parameters : [张三, 18]`，方括号形式没有类型标注
    const bracketed = /^\s*\[[\s\S]*\]\s*$/.test(paramText)
    out.push({
      format: bracketed ? 'druid' : format,
      template,
      placeholders,
      params: splitParams(paramText, placeholders),
    })
  }

  for (let i = 0; i < lines.length; i++) {
    const prep = /Preparing\s*:\s*([\s\S]*)$/i.exec(lines[i])
    if (prep) {
      flushBare()

      /*
       * 有些日志收集器（或者用户自己复制的时候）会把一条日志压成一行，
       * `Preparing: … VALUES (?, ?) [时间]DEBUG […]-> ==> Parameters: …` 全在一起。
       * 不在这里切开的话，整个 Parameters 段连同中间那截日志头都会留在 SQL 模板里，
       * 而且因为再也遇不到独立的 Parameters 行，参数一个都解析不出来。
       */
      const inline = PARAMS_MARK.exec(prep[1])
      if (inline) {
        const template = stripTrailingLogHead(prep[1].slice(0, inline.index)).trim()
        emit(template, 'mybatis', inline[1].trim())
        pending = null
        matched = false
        continue
      }

      const joined = joinContinuation(lines, i, prep[1])
      pending = { template: joined.text, format: 'mybatis' }
      matched = false
      i = joined.next - 1
      continue
    }

    const par = PARAMS_MARK.exec(lines[i])
    if (par && pending) {
      const joined = joinContinuation(lines, i, par[1])
      emit(pending.template, pending.format, joined.text)
      matched = true
      i = joined.next - 1
    }
  }

  flushBare()
  return out
}

/**
 * Hibernate：SQL 一行，参数按 `binding parameter [1] as [BIGINT] - [5]` 分行打。
 * 新版（6.x）写法是 `binding parameter (1:BIGINT) <- [5]`，两种都认。
 * 按方括号里的序号定位，不依赖出现顺序——日志交错时顺序靠不住。
 */
function parseHibernate(lines: string[]): LogStatement[] {
  const out: LogStatement[] = []
  let template: string | null = null
  let binds = new Map<number, LogParam>()

  const flush = () => {
    if (template === null) return
    const placeholders = countPlaceholders(template)
    const params: LogParam[] = []
    for (let i = 1; i <= Math.max(placeholders, binds.size); i++) {
      const b = binds.get(i)
      if (b) params.push(b)
    }
    out.push({ format: 'hibernate', template, placeholders, params })
    template = null
    binds = new Map()
  }

  for (let i = 0; i < lines.length; i++) {
    const head = /Hibernate\s*:\s*([\s\S]*)$/i.exec(lines[i])
    if (head) {
      flush()
      const joined = joinContinuation(lines, i, head[1])
      template = joined.text
      i = joined.next - 1
      continue
    }
    const old = /binding parameter \[(\d+)\] as \[([^\]]*)\]\s*-\s*\[([\s\S]*)\]\s*$/i.exec(lines[i])
    const nu = /binding parameter \((\d+):([^)]*)\)\s*<-\s*\[([\s\S]*)\]\s*$/i.exec(lines[i])
    const m = old ?? nu
    if (m) {
      binds.set(Number(m[1]), {
        raw: lines[i].trim(),
        value: m[3],
        declaredType: m[2].trim() || undefined,
      })
    }
  }
  flush()
  return out
}

/**
 * 格式 2：一段裸 SQL + 一行参数，用户手工从日志里抠出来的形态。
 *
 * 核心规则不变：**SQL 是「到最后一个含 `?` 的行」为止**，剩下的行是参数——
 * `?` 自己划出了边界，不需要猜哪行是 SQL，折行的 SQL 和多行参数都能吃下。
 *
 * 但「剩下的行都是参数」这句话得先过一遍分类。用户从控制台里框选复制的时候，
 * SQL 那行的 `Preparing:` 前缀常常漏掉，而参数那行的日志头**一个字都没少**，于是整段
 * `[2026-08-20 06:36:13.081]DEBUG [pool-1][Dao.insert:159]-> ==> Parameters: ` 变成了
 * 第 1 个参数的值，跟着被拼进 SQL——这就是用户报的「把日志头也进参数了」。
 * 顺带还有两种噪声要挡掉：紧跟其后的无关日志行（会变成多出来的参数），
 * 以及 `<== Total: 5` 这类结果行。
 */
type PlainKind = 'sql' | 'params' | 'noise'

/** 结果行的标记：既不是 SQL 也不是参数 */
const RESULT_MARK = /(<==|Total\s*:|Updates\s*:|Columns\s*:|Row\s*:)/i

function classifyPlain(line: string, stripped: string): PlainKind {
  if (PARAMS_MARK.test(line)) return 'params'
  if (SQL_HEAD.test(stripped)) return 'sql'
  if (RESULT_MARK.test(line) || isLogRecord(line)) return 'noise'
  // 剩下的既可能是折行的 SQL 续行，也可能是参数行，靠它在 `?` 之前还是之后来定
  return 'sql'
}

function parsePlainBlock(block: string): LogStatement | null {
  const lines = block.split('\n')
  const stripped = lines.map(stripLeadingLogHead)
  const kinds = lines.map((line, i) => classifyPlain(line, stripped[i]))

  // 参数行和噪声行不参与「SQL 到哪结束」的判断：
  // 参数值里带 `?`（`remark = '真的吗?'`）会把整个日志头卷进模板
  let last = -1
  for (let i = 0; i < lines.length; i++) {
    if (kinds[i] === 'sql' && countPlaceholders(stripped[i]) > 0) last = i
  }
  if (last < 0) {
    // 没有 `?`：可能是已经填好的 SQL，直接当成一条零参数语句
    const text = block.trim()
    if (!SQL_HEAD.test(text)) return null
    return { format: 'plain', template: text, placeholders: 0, params: [] }
  }

  const template = stripped
    .slice(0, last + 1)
    .filter((_, i) => kinds[i] === 'sql')
    .join('\n')
    .trim()

  const rest = lines
    .slice(last + 1)
    .map((line, i) => {
      const kind = kinds[last + 1 + i]
      if (kind === 'noise') return ''
      if (kind === 'params') return (PARAMS_MARK.exec(line)?.[1] ?? '').trim()
      return line.trim()
    })
    .filter((l) => l !== '')
    .join(', ')

  const placeholders = countPlaceholders(template)
  return {
    format: 'plain',
    template,
    placeholders,
    params: rest ? splitParams(rest, placeholders) : [],
  }
}

/* ---------- 主入口 ---------- */

/**
 * 认格式、拆语句。返回的是「模板 + 参数」，不是最终 SQL——
 * 因为参数值在 UI 上可改（PRD 4.14 的对照表），拼 SQL 是 buildFilledSql 那一步。
 *
 * 识别顺序按「特征强度」排：p6spy 的 `|` 分段和 MyBatis 的 `Preparing:`
 * 都是不会误判的强特征，plain 是兜底。
 */
export function parseLog(text: string): LogParseResult {
  const raw = text.replace(/\r\n?/g, '\n')
  if (!raw.trim()) return { statements: [], note: '粘贴一段日志试试' }

  const lines = raw.split('\n')

  if (/Preparing\s*:/i.test(raw)) {
    const st = parseMybatis(lines)
    if (st.length) return { statements: st }
  }
  if (/binding parameter|Hibernate\s*:/i.test(raw)) {
    const st = parseHibernate(lines)
    if (st.length) return { statements: st }
  }
  // p6spy 的判断放在 MyBatis 后面：MyBatis 的日志行里也可能带 `|`
  if (lines.some((l) => l.split('|').length >= 5 && SQL_HEAD.test(l.split('|').at(-1) ?? ''))) {
    const st = parseP6spy(lines)
    if (st.length) return { statements: st }
  }

  // 兜底：按空行分块，每块一条语句
  const blocks = raw.split(/\n\s*\n/).filter((b) => b.trim() !== '')
  const st = blocks.map(parsePlainBlock).filter((s): s is LogStatement => s !== null)
  if (!st.length) {
    return {
      statements: [],
      note: '没认出来。支持 MyBatis 的 Preparing/Parameters、Hibernate 的 binding parameter、p6spy，或者「一行带 ? 的 SQL + 一行参数」',
    }
  }
  return { statements: st }
}

export interface FilledStatement {
  statement: LogStatement
  params: RenderedParam[]
  /** 填好的 SQL，末尾带分号 */
  sql: string
  /** 个数不匹配之类的问题。有 error 时 sql 仍然给出来，但 UI 要标红 */
  error?: string
}

/**
 * 拼出可执行 SQL。params 传进来是为了让「用户改过的值」能生效——
 * 不传就用日志里解析出来的原值。
 */
export function buildFilledSql(
  statement: LogStatement,
  dialect: GenDialect,
  overrides?: LogParam[],
): FilledStatement {
  const params = (overrides ?? statement.params).map((p) => renderParam(p, dialect))
  const body = fillPlaceholders(statement.template, params.map((p) => p.literal))
  const sql = `${body.trim().replace(/;+\s*$/, '')};`

  let error: string | undefined
  if (params.length !== statement.placeholders) {
    // 这里绝不悄悄补齐或截断：少填会留下裸 `?`（语法错误，一眼能看见），
    // 多填则说明切分错了，两种都必须让人当场知道
    error = `占位符 ${statement.placeholders} 个，参数 ${params.length} 个，对不上——检查一下参数是怎么切分的`
  }
  return { statement, params, sql, error }
}

/** 拼成给 CodeBlock 展示的整段，带来源和个数核对的注释头 */
export function renderFilled(filled: FilledStatement[]): string {
  if (!filled.length) return '-- 还没有识别到语句'
  return filled
    .map((f, i) => {
      const head = [
        `-- 第 ${i + 1} 条  ${FORMAT_LABELS[f.statement.format]}`,
        `-- 占位符 ${f.statement.placeholders} 个 / 参数 ${f.params.length} 个  ${f.error ? '❌' : '✅'}`,
        f.error ? `-- ⚠️ ${f.error}` : '',
        f.params.some((p) => p.uncertain)
          ? '-- ⚠️ 有参数的类型没认出来，按字符串加了引号，核对一下'
          : '',
      ]
        .filter(Boolean)
        .join('\n')
      return `${head}\n${f.sql}`
    })
    .join('\n\n')
}
