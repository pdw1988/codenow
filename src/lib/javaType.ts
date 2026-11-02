/**
 * SQL 类型 → Java 类型映射，以及字段名 → Java 驼峰属性名。
 * PRD 3.2 Step 4 要求展示 Java 类映射。
 */

/**
 * 匹配顺序有讲究：长的前缀先匹配，否则 'int' 会先吃掉 'integer'，
 * 'timestamp' 会被 'time' 截走。
 */
const TYPE_RULES: Array<[RegExp, string]> = [
  [/^(tinyint)\s*\(\s*1\s*\)/i, 'Boolean'], // MySQL 惯例：tinyint(1) 当布尔用
  /*
   * Oracle 的 INTERVAL 是一段**时长**，不是某个时刻。这两条必须排在整型规则前面：
   * `^int` 会先把 INTERVAL 吃掉，于是 `INTERVAL DAY(3) TO SECOND(6)` 映射成 Integer——
   * 编译得过、字段名也对，只是类型完全不是那个意思。
   */
  [/^interval\s+day/i, 'java.time.Duration'],
  [/^interval\s+year/i, 'java.time.Period'],
  // PG 的裸 INTERVAL（format_type 就给这个词）按时长，不要落到后面的 ^int
  [/^(interval)\b/i, 'java.time.Duration'],
  [/^(bigint|serial8|bigserial)/i, 'Long'],
  [/^(smallint|tinyint|mediumint|int2|int4|integer|int)/i, 'Integer'],
  [/^(decimal|numeric|money|dec)/i, 'java.math.BigDecimal'],
  [/^(double|float|real|binary_double|binary_float)/i, 'Double'],
  [/^(bit|bool|boolean)/i, 'Boolean'],
  /*
   * 带时区的 TIMESTAMP 必须排在裸 timestamp 前面。落到 LocalDateTime 上不会报错，
   * 只是把偏移量悄悄丢掉——同一个瞬间在不同时区读出来差几个小时，属于最难查的那类错。
   * Oracle 的 WITH LOCAL TIME ZONE 也按 OffsetDateTime 给：它存的是绝对时间，
   * 只是读的时候转成会话时区，用 LocalDateTime 表达同样会丢掉「这是哪个瞬间」。
   */
  [/^timestamp\s*(?:\(\s*\d+\s*\))?\s+with\s+(?:local\s+)?time\s+zone/i, 'java.time.OffsetDateTime'],
  [/^(datetime|timestamp)/i, 'java.time.LocalDateTime'],
  [/^(date)/i, 'java.time.LocalDate'],
  [/^(time)/i, 'java.time.LocalTime'],
  [/^(year)/i, 'Integer'],
  // 裸 LONG 是 Oracle 的老式大文本；`LONG RAW` 是二进制，必须排除掉交给下面那条
  [/^(char|varchar|varchar2|nvarchar|nchar|text|tinytext|mediumtext|longtext|clob|nclob|json|uuid|enum|set|rowid|urowid|xmltype|long(?!\s+raw))/i, 'String'],
  [/^(blob|tinyblob|mediumblob|longblob|binary|varbinary|bytea|long\s+raw|raw|bfile)/i, 'byte[]'],
]

/**
 * Oracle 的 NUMBER：精度和小数位决定 Java 类型，一条正则表达不了，所以单独处理。
 *
 * **NUMBER(1) 故意不当布尔**。MySQL 的 `tinyint(1)` 有「就是布尔」的社区惯例，Oracle 没有——
 * 比如流程定义表里 `is_publish NUMBER(1)` 的取值是 0未发布/1已发布/9失效，
 * 猜成 Boolean 会让 9 这种值在生成的实体里根本表达不出来，而且错得很安静。
 *
 * 精度超过 18 位给 BigDecimal 而不是 Long：Long 最大 19 位，`NUMBER(25)` 装不下，
 * 溢出的时候不报错、只是数字变了。
 */
function oracleNumberType(type: string): string | undefined {
  const m = /^number\s*(?:\(\s*(\d+|\*)\s*(?:,\s*(-?\d+)\s*)?\))?\s*$/i.exec(type)
  if (!m) return undefined

  // 不带精度的 NUMBER 是浮点数，只有 BigDecimal 装得住
  if (m[1] === undefined || m[1] === '*') return 'java.math.BigDecimal'
  if (m[2] !== undefined && Number(m[2]) > 0) return 'java.math.BigDecimal'

  const precision = Number(m[1])
  if (precision <= 9) return 'Integer'
  return precision <= 18 ? 'Long' : 'java.math.BigDecimal'
}

/** VARCHAR(50) → String；未知类型退化为 Object，不抛错 */
export function toJavaType(sqlType: string): string {
  const t = sqlType.trim()
  const number = oracleNumberType(t)
  if (number) return number
  for (const [pattern, javaType] of TYPE_RULES) {
    if (pattern.test(t)) return javaType
  }
  return 'Object'
}

/** user_name → userName；已是驼峰的原样返回 */
export function toCamelCase(columnName: string): string {
  if (!columnName.includes('_')) return columnName
  return columnName
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((part, i) => (i === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join('')
}

/** user_role → UserRole，用于推导默认 Java 类名 */
export function toPascalCase(tableName: string): string {
  const camel = toCamelCase(tableName)
  return camel ? camel[0].toUpperCase() + camel.slice(1) : camel
}

/** 剥掉长度/精度：VARCHAR(50) → varchar，DECIMAL(10,2) → decimal */
export function baseType(sqlType: string): string {
  return sqlType.replace(/\(.*\)/, '').trim().toLowerCase()
}
