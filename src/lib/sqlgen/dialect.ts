/**
 * SQL 方言差异集中在这里。
 *
 * 只抽了真正会影响生成结果的几件事：标识符引用、分页语法、以及可执行模式要用到的
 * 「当前时间」表达式和日期字面量写法。其余差异（函数名、类型名）在生成 CRUD 时用不到，
 * 不提前抽象。
 *
 * 历史上生成层用过 `GenDialect = Dialect | 'sqlite'`（产品一度关掉 SQLite）。
 * 现在 SQLite 已回产品方言，`GenDialect` 与 `Dialect` 同义，保留别名免得改一堆单测签名。
 */
import { isDialect, type Dialect } from '../../types/schema'

export type GenDialect = Dialect

export interface DialectSpec {
  label: string
  /** 包裹标识符，避免 order / select 这类保留字炸掉 */
  quote: (identifier: string) => string
  /**
   * 给不含分号的 SELECT 套分页。
   * MySQL / PG / SQLite 在末尾加 LIMIT；Oracle 用 ROWNUM 外包一层——
   * `OFFSET … FETCH NEXT` 是 12c 才有的，11g 直接 ORA-00933，而且看起来不像 Oracle。
   */
  paginate: (selectSql: string) => string
  /** 「当前时间」表达式。可执行模式往 create_time 这类字段填的就是它 */
  now: string
  /** 「当前日期」表达式（DATE 类型用，不带时分秒） */
  today: string
  /** 日期时间字面量。文本形如 2026-08-22 或 2026-08-22 10:30:00 */
  dateLiteral: (text: string) => string
  /**
   * 布尔字面量。MySQL/PostgreSQL 有 TRUE/FALSE，Oracle（23c 以前）与 SQLite
   * 只能写 1/0——原样输出 TRUE 在 Oracle 里是 ORA-00904「标识符无效」。
   */
  boolLiteral: (truthy: boolean) => string
}

/**
 * MySQL 用反引号，PostgreSQL/Oracle/SQLite 用双引号。
 * 只在必要时加引号会让 SQL 更好读，但判断哪些是保留字要维护一张长表，
 * 而且漏一个就是运行时报错——一律加引号更稳。
 */
const backtick = (id: string) => `\`${id}\``
const doubleQuote = (id: string) => `"${id}"`

/** 大多数方言都认裸字符串日期，只有 Oracle 必须显式 TO_DATE */
const plainDate = (text: string) => `'${text}'`

const keywordBool = (truthy: boolean) => (truthy ? 'TRUE' : 'FALSE')
const numericBool = (truthy: boolean) => (truthy ? '1' : '0')

function indent(sql: string, n: number): string {
  const pad = ' '.repeat(n)
  return sql.split('\n').map((line) => (line ? pad + line : line)).join('\n')
}

/**
 * 套分页。`fill` 把 `#{offset}` / `#{limit}` 换成数字（可执行「查前 20 条」）。
 * Oracle 且 offset=0 时只包一层 `ROWNUM <= n`，不必再套 rn 去滤 `> 0`。
 */
export function applyPage(
  dialect: GenDialect,
  selectSql: string,
  fill?: { offset: number; limit: number },
): string {
  if (fill && dialect === 'oracle' && fill.offset === 0) {
    return `SELECT * FROM (\n${indent(selectSql, 2)}\n) WHERE ROWNUM <= ${fill.limit}`
  }
  let out = DIALECTS[dialect].paginate(selectSql)
  if (!fill) return out
  if (dialect === 'oracle') {
    out = out.replace(/#\{offset\} \+ #\{limit\}/g, String(fill.offset + fill.limit))
  }
  return out.replace(/#\{offset\}/g, String(fill.offset)).replace(/#\{limit\}/g, String(fill.limit))
}

/**
 * 这里的键顺序就是界面上所有方言下拉框的顺序——DIALECT_OPTIONS 按
 * oracle → mysql → postgresql → sqlite 取出。
 * 按日常用得最多的排，别按字母序「整理」它，否则几个下拉框会一起变。
 */
export const DIALECTS: Record<GenDialect, DialectSpec> = {
  oracle: {
    label: 'Oracle',
    quote: doubleQuote,
    paginate: (sql) =>
      [
        'SELECT * FROM (',
        '  SELECT page_.*, ROWNUM AS rn FROM (',
        indent(sql, 4),
        '  ) page_ WHERE ROWNUM <= #{offset} + #{limit}',
        ') WHERE rn > #{offset}',
      ].join('\n'),
    now: 'SYSDATE',
    today: 'TRUNC(SYSDATE)',
    // Oracle 不会把 '2026-08-22' 隐式转成日期（取决于 NLS_DATE_FORMAT，靠不住），
    // 必须带格式串。有没有时分秒决定用哪个格式，写错格式串会 ORA-01861。
    dateLiteral: (text) =>
      text.includes(':')
        ? `TO_DATE('${text}', 'YYYY-MM-DD HH24:MI:SS')`
        : `TO_DATE('${text}', 'YYYY-MM-DD')`,
    boolLiteral: numericBool,
  },
  mysql: {
    label: 'MySQL',
    quote: backtick,
    paginate: (sql) => `${sql}\nLIMIT #{offset}, #{limit}`,
    now: 'NOW()',
    today: 'CURDATE()',
    dateLiteral: plainDate,
    boolLiteral: keywordBool,
  },
  postgresql: {
    label: 'PostgreSQL',
    quote: doubleQuote,
    paginate: (sql) => `${sql}\nLIMIT #{limit} OFFSET #{offset}`,
    now: 'NOW()',
    today: 'CURRENT_DATE',
    dateLiteral: plainDate,
    boolLiteral: keywordBool,
  },
  // SQLite 没有 NOW()，填 NOW() 会 no such function——用 CURRENT_TIMESTAMP。
  sqlite: {
    label: 'SQLite',
    quote: doubleQuote,
    paginate: (sql) => `${sql}\nLIMIT #{limit} OFFSET #{offset}`,
    now: 'CURRENT_TIMESTAMP',
    today: 'CURRENT_DATE',
    dateLiteral: plainDate,
    boolLiteral: numericBool,
  },
}

export const DIALECT_OPTIONS = (Object.entries(DIALECTS) as [GenDialect, DialectSpec][])
  .filter((entry): entry is [Dialect, DialectSpec] => isDialect(entry[0]))
  .map(([value, spec]) => ({
    value,
    label: spec.label,
  }))
