/**
 * CI/CD 配置（apiforge.yml）解析，PRD v0.5 模块 4.10.4。
 *
 * 不引 YAML 依赖：配置 schema 是文档里定死的形状，这里实现一个够用的子集
 * 解析器（嵌套 map / 标量数组 / 注释 / 引号），坏配置给中文报错让 CI 日志
 * 直接可读 —— 跟 normalizeScanJson 防御扫描器 JSON 是同一个思路。
 *
 * ${VAR} 环境变量注入（落地约束 9）：解析后统一替换，缺失的变量直接报错
 * 终止 —— CI 里密码悄悄变成空串比失败更危险。
 */
import { normalizeMethodOrder } from '../runner/order'

export interface CiDatabaseConfig {
  driver: 'mysql' | 'postgresql'
  host: string
  port: number
  database: string
  username: string
  password: string
}

export interface CiLoginConfig {
  path: string
  username: string
  password: string
}

export interface CiScopeConfig {
  /** 只跑这些 Controller（空 = 全部） */
  controllers: string[]
  /** 跳过的 Controller（如 HealthController） */
  exclude: string[]
  /** 手写关联表覆盖（PRD 4.2 CLI 模式）：Controller 类名 → 表清单，按「手动」可信启用 */
  tables: Record<string, string[]>
}

export interface CiValidationConfig {
  mode: 'observe' | 'strict'
  /** 严格模式期望：表名 → `+1` / `-2` / `0`（新增/删除/不变） */
  expectations: Record<string, string>
}

export type CiReportFormat = 'junit' | 'html' | 'json' | 'markdown'

export interface CiReportConfig {
  formats: CiReportFormat[]
  output_dir: string
}

/** 执行顺序编排（PRD v0.6 模块 4.20）：HTTP 方法先后，缺省 = POST→GET→PUT→PATCH→DELETE */
export interface CiExecutionConfig {
  method_order: string[]
}

export interface ApiforgeCiConfig {
  project: string
  baseUrl: string
  database: CiDatabaseConfig | null
  login: CiLoginConfig | null
  scope: CiScopeConfig
  validation: CiValidationConfig
  report: CiReportConfig
  execution: CiExecutionConfig
  /** 专业版许可码（CI 回归闸门用）。一般留空走 APIFORGE_LICENSE 环境变量，env 优先于这个字段 */
  license: string
}

export const DEFAULT_REPORT_DIR = './apiforge-reports'
export const DEFAULT_REPORT_FORMATS: CiReportFormat[] = ['junit', 'html', 'json']

/* ================= YAML 子集解析 ================= */

interface YmlLine {
  indent: number
  text: string
}

/** 去掉注释（引号外的 ` #` 起）。URL 里的 `#` 前没有空格，不受影响 */
function stripComment(text: string): string {
  let quote: string | null = null
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trim()
    }
  }
  return text.trim()
}

function splitLines(yml: string): YmlLine[] {
  const out: YmlLine[] = []
  for (const raw of yml.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (raw.includes('\t')) throw new Error('apiforge.yml 不能用 Tab 缩进，请改用空格')
    out.push({ indent: raw.length - raw.trimStart().length, text: stripComment(trimmed) })
  }
  return out
}

function parseScalar(text: string): unknown {
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1)
  }
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  return text
}

/**
 * 解析一个缩进块。数组只支持标量项（`- 值`）—— 配置 schema 里没有嵌套数组，
 * 出现了就报错而不是猜。
 */
function parseBlock(lines: YmlLine[], start: number, indent: number): [unknown, number] {
  let i = start
  if (lines[i].text.startsWith('- ')) {
    const arr: unknown[] = []
    while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
      const rest = lines[i].text.slice(2).trim()
      if (!rest) throw new Error('apiforge.yml 的数组暂只支持标量项（- 值），不支持嵌套')
      arr.push(parseScalar(rest))
      i += 1
    }
    return [arr, i]
  }

  const map: Record<string, unknown> = {}
  while (i < lines.length && lines[i].indent === indent) {
    const m = lines[i].text.match(/^([^:]+):\s*(.*)$/)
    if (!m) throw new Error(`apiforge.yml 有行看不懂（应为 key: value）：${lines[i].text}`)
    const key = m[1].trim()
    const rest = m[2].trim()
    i += 1
    if (rest) {
      map[key] = parseScalar(rest)
    } else if (i < lines.length && lines[i].indent > indent) {
      const [v, next] = parseBlock(lines, i, lines[i].indent)
      map[key] = v
      i = next
    } else if (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
      // 数组项和 key 同缩进的写法也认（YAML 常见格式）
      const [v, next] = parseBlock(lines, i, indent)
      map[key] = v
      i = next
    } else {
      map[key] = null
    }
  }
  return [map, i]
}

/** YAML 子集文本 → 对象树。整份配置坏掉直接抛中文错误 */
export function parseYamlSubset(yml: string): Record<string, unknown> {
  const lines = splitLines(yml)
  if (lines.length === 0) throw new Error('apiforge.yml 是空的')
  const [value] = parseBlock(lines, 0, lines[0].indent)
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : (() => {
        throw new Error('apiforge.yml 顶层应是配置映射，不是数组或标量')
      })()
}

/** ${VAR} → 环境变量值。缺失的变量收集起来一次性报全，省得 CI 逐个补跑 */
export function resolveEnvVars(
  node: unknown,
  env: Record<string, string | undefined>,
): Record<string, unknown> {
  const missing = new Set<string>()
  const walk = (n: unknown): unknown => {
    if (typeof n === 'string') {
      return n.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
        const v = env[name]
        if (v === undefined) {
          missing.add(name)
          return ''
        }
        return v
      })
    }
    if (Array.isArray(n)) return n.map(walk)
    if (n && typeof n === 'object') {
      return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, walk(v)]))
    }
    return n
  }
  const out = walk(node)
  if (missing.size) {
    throw new Error(
      `环境变量未设置：${[...missing].join('、')}。apiforge.yml 的 \${VAR} 从环境变量读敏感信息，请先 export 再运行`,
    )
  }
  return out as Record<string, unknown>
}

/* ================= 归一化到配置类型 ================= */

const asStr = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
const asRec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const asStrArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => asStr(x)).filter(Boolean) : []

function parseDatabase(raw: unknown): CiDatabaseConfig | null {
  if (!raw) return null
  const r = asRec(raw)
  const driver = asStr(r.driver)
  if (driver !== 'mysql' && driver !== 'postgresql') {
    throw new Error(`apiforge.yml database.driver 只支持 mysql / postgresql，现在是「${driver || '空'}」`)
  }
  const host = asStr(r.host)
  const database = asStr(r.database)
  if (!host || !database) throw new Error('apiforge.yml database 需要 host 和 database')
  return {
    driver,
    host,
    port: Number(r.port) || (driver === 'mysql' ? 3306 : 5432),
    database,
    username: asStr(r.username),
    password: asStr(r.password),
  }
}

function parseScope(raw: unknown): CiScopeConfig {
  const r = asRec(raw)
  const tables: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(asRec(r.tables))) {
    const list = asStrArr(v)
    if (list.length) tables[k] = list
  }
  return { controllers: asStrArr(r.controllers), exclude: asStrArr(r.exclude), tables }
}

function parseValidation(raw: unknown): CiValidationConfig {
  const r = asRec(raw)
  const mode = asStr(r.mode) === 'strict' ? 'strict' : 'observe'
  const expectations: Record<string, string> = {}
  for (const [k, v] of Object.entries(asRec(r.expectations))) {
    const s = asStr(v).trim()
    if (s) expectations[k] = s
  }
  return { mode, expectations }
}

function parseReport(raw: unknown): CiReportConfig {
  const r = asRec(raw)
  const known = new Set<CiReportFormat>(['junit', 'html', 'json', 'markdown'])
  const formats = asStrArr(r.formats).filter((f): f is CiReportFormat => {
    if (known.has(f as CiReportFormat)) return true
    throw new Error(`apiforge.yml report.formats 有不认识的格式「${f}」（支持 junit/html/json/markdown）`)
  })
  return {
    formats: formats.length ? formats : DEFAULT_REPORT_FORMATS,
    output_dir: asStr(r.output_dir) || DEFAULT_REPORT_DIR,
  }
}

/**
 * execution.method_order（PRD v0.6 模块 4.20）：`- POST` 数组或 `POST,GET` 逗号串都认。
 * normalizeMethodOrder 洗成大写去重的合法动词；全不认识/没配 = 空 = 默认顺序，
 * 不炸配置——顺序编排是优化不是闸门，坏了不该卡 CI。
 */
function parseExecution(raw: unknown): CiExecutionConfig {
  const r = asRec(raw)
  return { method_order: normalizeMethodOrder(r.method_order ?? r.methodOrder) }
}

/** 配置文本 → 强类型配置。project/baseUrl 等必填缺失直接抛中文错误。
 *  env 必传（CLI 传 process.env，浏览器侧不用这个函数）—— lib 层不偷引 node 全局 */
export function parseApiforgeConfig(
  text: string,
  env: Record<string, string | undefined>,
): ApiforgeCiConfig {
  const raw = resolveEnvVars(parseYamlSubset(text), env)
  const baseUrl = asStr(raw.base_url)
  if (!baseUrl) throw new Error('apiforge.yml 缺 base_url（被测服务的根地址）')
  if (!/^https?:\/\//.test(baseUrl)) throw new Error(`base_url 要以 http(s):// 开头，现在是「${baseUrl}」`)
  return {
    project: asStr(raw.project),
    baseUrl: baseUrl.replace(/\/+$/, ''),
    database: parseDatabase(raw.database),
    login: raw.login
      ? (() => {
          const l = asRec(raw.login)
          const path = asStr(l.path)
          if (!path) throw new Error('apiforge.yml 配了 login 就必须给 path')
          return { path, username: asStr(l.username), password: asStr(l.password) }
        })()
      : null,
    scope: parseScope(raw.scope),
    validation: parseValidation(raw.validation),
    report: parseReport(raw.report),
    execution: parseExecution(raw.execution),
    license: asStr(raw.license).trim(),
  }
}

/* ================= GUI 配置 → yml（导出用） ================= */

/**
 * 把当前 GUI 环境配置导出成 apiforge.yml 文本（PRD v0.5 §五「导出 apiforge.yml」）。
 * 密码永远输出 ${VAR} 占位 —— 配置文件里不落任何密码（落地约束 8/9）。
 */
export function configToYml(config: {
  project: string
  baseUrl: string
  loginApi?: string
  username?: string
  assertMode?: 'observe' | 'strict'
  /** 学来的期望（PRD v0.6 模块 4.14）：strict 模式下写实值，缺省给占位示例 */
  expectations?: Record<string, string>
  formats?: CiReportFormat[]
  outputDir?: string
  /** 执行顺序（PRD v0.6 模块 4.20）：非默认时才写出，默认导出保持原样 */
  methodOrder?: string[]
}): string {
  const b: string[] = []
  b.push('# apiforge.yml —— 由码上测（码上 CodeNow）环境配置导出，供 CI 无头运行（apiforge run --config）')
  b.push(`project: ${config.project || './'}`)
  b.push(`base_url: ${config.baseUrl || 'http://localhost:8080'}`)
  b.push('')
  b.push('# 专业版闸门：apiforge run 需要许可码 —— 在 CI 里 export APIFORGE_LICENSE=<许可码>')
  b.push('# （推荐，不落盘），或在本文件加 license: <许可码>。桌面版「升级」里购买。')
  b.push('')
  b.push('# 登录配置：密码从环境变量读，不进配置文件')
  if (config.loginApi) {
    b.push('login:')
    b.push(`  path: ${config.loginApi}`)
    b.push(`  username: ${config.username || ''}`)
    b.push('  password: ${APIFORGE_LOGIN_PASSWORD}')
  } else {
    b.push('# 未配置登录接口；需要认证时补 login: { path, username, password }')
  }
  b.push('')
  b.push('# 数据库验证连接（CLI 直连数据库做快照对比；driver 支持 mysql / postgresql）')
  b.push('# database:')
  b.push('#   driver: mysql')
  b.push('#   host: localhost')
  b.push('#   port: 3306')
  b.push('#   database: test_db')
  b.push('#   username: root')
  b.push('#   password: ${DB_PASSWORD}')
  b.push('')
  b.push('# 测试范围：controllers 留空跑全部；exclude 跳过健康检查这类接口')
  b.push('scope:')
  b.push('  controllers: []')
  b.push('  exclude:')
  b.push('    - HealthController')
  b.push('')
  b.push(`# 数据库验证模式：${config.assertMode === 'strict' ? 'strict（可配期望，如 user: +1）' : 'observe（默认，只展示变化不判失败）'}`)
  b.push('validation:')
  b.push(`  mode: ${config.assertMode === 'strict' ? 'strict' : 'observe'}`)
  if (config.assertMode === 'strict') {
    const learned = Object.entries(config.expectations ?? {})
    if (learned.length) {
      b.push('  expectations:')
      for (const [table, spec] of learned) b.push(`    ${table}: ${spec}`)
    } else {
      b.push('  expectations:')
      b.push('    user: +1')
    }
  }
  b.push('')
  b.push('# 报告：junit 给 CI 解析，html 归档构建产物')
  b.push('report:')
  b.push('  formats:')
  for (const f of config.formats ?? DEFAULT_REPORT_FORMATS) b.push(`    - ${f}`)
  b.push(`  output_dir: ${config.outputDir || DEFAULT_REPORT_DIR}`)
  const customOrder = normalizeMethodOrder(config.methodOrder)
  if (customOrder.length) {
    b.push('')
    b.push('# 执行顺序（PRD v0.6 模块 4.20）：按 HTTP 方法分组先后；没列的方法按默认顺序跟在后面')
    b.push('execution:')
    b.push('  method_order:')
    for (const m of customOrder) b.push(`    - ${m}`)
  }
  return b.join('\n')
}
