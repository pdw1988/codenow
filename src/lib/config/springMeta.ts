/**
 * 内置的 Spring Boot 配置元数据和补全逻辑（PRD 五 5.4.3）。
 *
 * 数据是一条手维护的小清单（14 条常用项），不是完整元数据包——
 * 完整的 spring-configuration-metadata.json 有几千条，这个工具的场景是
 * 「想不起来某个常用配置叫什么」，几十条高频项就够了，多了反而找不到。
 * 要扩条目直接往 SPRING_META 里加，过滤和插入逻辑不用动。
 */

/** [键, 描述, 默认值]；默认值 '—' 表示没有惯例默认 */
const SPRING_META: ReadonlyArray<readonly [string, string, string]> = [
  ['spring.datasource.url', 'JDBC 连接 URL', '—'],
  ['spring.datasource.username', '数据库用户名', '—'],
  ['spring.datasource.password', '数据库密码', '—'],
  ['spring.datasource.driver-class-name', '驱动类名，通常留空让 URL 自动推断', '自动'],
  ['spring.datasource.hikari.maximum-pool-size', '最大连接数', '10'],
  ['spring.datasource.hikari.minimum-idle', '最小空闲连接', '同 maximum-pool-size'],
  ['spring.redis.host', 'Redis 主机地址', 'localhost'],
  ['spring.redis.port', 'Redis 端口', '6379'],
  ['spring.redis.password', 'Redis 密码', '—'],
  ['spring.profiles.active', '激活的环境 profile', 'default'],
  ['server.port', 'HTTP 监听端口', '8080'],
  ['server.servlet.context-path', '上下文路径', '/'],
  ['logging.level.root', '根日志级别', 'INFO'],
  ['mybatis.mapper-locations', 'Mapper XML 位置', 'classpath*:/mapper/**/*.xml'],
]

export interface MetaEntry {
  key: string
  desc: string
  def: string
}

/**
 * 提示过滤：前缀命中优先，描述包含兜底。大小写不敏感——
 * 用户打 `Spring.` 和 `spring.` 得给同一批结果。
 */
export function filterHints(query: string): MetaEntry[] {
  const q = query.trim().toLowerCase()
  if (!q)
    return SPRING_META.map(([key, desc, def]) => ({ key, desc, def }))
  return SPRING_META.filter(
    ([k, d]) =>
      k.toLowerCase().startsWith(q) || d.includes(q) || k.toLowerCase().includes(q),
  ).map(([key, desc, def]) => ({ key, desc, def }))
}

/**
 * 计算点了一条提示后的编辑器内容和光标位置：
 * 光标前正在打的半个词被整体替换成完整键 + 分隔符，光标落在分隔符之后。
 * joiner 跟当前生效格式走——YAML 补 `: `、Properties 补 `=`、JSON 补 `": `
 * 且键要带引号（JSON 的键不是裸标识符）。
 */
export function computeInsertion(
  text: string,
  cursor: number,
  key: string,
  mode: 'yaml' | 'props' | 'json',
): { text: string; cursor: number } {
  const [lit, joiner] =
    mode === 'yaml' ? [key, ': '] : mode === 'json' ? [`"${key}"`, ': '] : [key, '=']
  const wordStart = cursor - (/[\w.-]*$/.exec(text.slice(0, cursor))?.[0].length ?? 0)
  const next = text.slice(0, wordStart) + lit + joiner + text.slice(cursor)
  return { text: next, cursor: wordStart + lit.length + joiner.length }
}
