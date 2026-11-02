/**
 * APIForge 的领域类型，PRD v0.3 + 技术方案 §2.1~2.8。
 *
 * 这里只放跨层共享的形状。纯函数的入参出参都用这里的类型，
 * store 和 UI 不另造形状 —— 否则 scanner JSON → store → UI 三处各写一份，
 * 字段改一处漏两处。
 */

/* ================= 一、扫描（技术方案 2.1） ================= */

/** 扫描器（Java 侧）报出来的每个参数 */
export interface RawParameter {
  name: string
  javaType: string
  /** query / path / body / header；header MVP 只透传不改 */
  position: 'query' | 'path' | 'body' | 'header' | 'unknown'
  required: boolean
  defaultValue?: string
  description?: string
}

/** 归一化后的接口方法。扫描 JSON 进 normalize 后的稳定形状 */
export interface ApiMethod {
  /** 工程内唯一：文件路径 + 方法名 + 重载序号 */
  id: string
  methodName: string
  httpMethod: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  /** 类 + 方法拼接后的完整路径，永远以 / 开头 */
  path: string
  parameters: RawParameter[]
  /** @RequestBody 的类型。MVP 只留类型名，造值按类型兜底 */
  requestBodyType: string | null
  /** @RequestBody 里的字段（扫描器能解析到的普通字段），造值用 */
  requestBodyFields: DtoField[]
  responseType: string
  /** Swagger @ApiOperation / @Operation 摘要 */
  description: string
  /** 所在 Controller 的类简名（不含包名） */
  controllerClass: string
  filePath: string
  projectId: string
  /** 用户手改的「查/增/改/删」。缺省 = 按方法+接口名自动认（cases/apiAction） */
  action?: ApiAction
}

/** 接口在业务上干什么：SHOP 几乎全是 POST，光看请求方法分不出改、删 */
export type ApiAction = 'query' | 'insert' | 'update' | 'delete' | 'unknown'

export interface ControllerInfo {
  className: string
  packageName: string
  basePath: string
  filePath: string
  /**
   * 业务名：@Api(tags) / @Api("简写") / @Tag(name) / 类 Javadoc 首行。
   * 空串 = 扫描器没抽到；UI 仍显示 className。
   */
  description: string
  /**
   * 类 Javadoc 的 `@author`，已去邮箱、多作者取首个（见 lib/apiforge/docmeta.ts）。
   * 空串 = 没写。跟 description 同一口径：必填 + 空串，UI 不用判 undefined。
   */
  author: string
  /**
   * 类 Javadoc 的 `@date` / `@since` 系 tag，已归一成 `YYYY-MM-DD`；
   * 认不出来的原样保留。空串 = 没写。
   */
  date: string
  methods: ApiMethod[]
}

export interface MapperStatement {
  id: string
  op: 'insert' | 'update' | 'delete' | 'select'
  tables: string[]
}

export interface MapperInfo {
  /** Mapper 接口全名（XML 的 namespace） */
  namespace: string
  filePath: string
  statements: MapperStatement[]
}

/**
 * 调用边：类里每个方法用到的注入字段类型（Controller → Service → Mapper 的链路
 * 靠它走）。扫描器把「字段名 → 类型」在类内解析好，TS 只做图遍历。
 */
export interface ClassUse {
  className: string
  methodName: string
  usedFieldTypes: string[]
}

/**
 * 业务异常收集：扫描器在方法体里找到的 throw new XxxException(...)。
 * 消息是后端自己的文案（用例名直接带上，用户读报告就知道后端拦的是哪句），
 * fields 是外层 if 条件里认领的违例字段（getXxx → xxx）。className 同 ClassUse
 * 语义：实现类全名 + 接口简名别名各登记一份。
 */
export interface BizThrowDetail {
  type: string
  message: string
  fields: string[]
}

export interface BizThrowInfo {
  className: string
  methodName: string
  throws: BizThrowDetail[]
}

/** DTO / VO / 请求体字段。required 给造值用，description 给含义展示用 */
export interface DtoField {
  name: string
  javaType: string
  required: boolean
  /** @ApiModelProperty / @Schema / 字段 Javadoc；没有则省略 */
  description?: string
}

/** 工程里扫到的类型（VO/DTO）。试跑 JSON 的 key 靠字段名对上这里的说明 */
export interface ScannedType {
  name: string
  fields: DtoField[]
}

/** 实体字段（MyBatis-Plus / JPA 注解口径，PRD v0.6 模块 4.15） */
export interface EntityFieldInfo {
  /** Java 字段名，如 buyerName */
  name: string
  /** 注解指明或 camelCase→snake_case 推断的列名 */
  column: string
  javaType: string
  /** @TableId */
  pk: boolean
}

/** 扫到的实体类：@TableName("t_order")（MP）或 @Entity + @Table(name=…)（JPA） */
export interface EntityInfo {
  className: string
  table: string
  fields: EntityFieldInfo[]
}

/** Vue 移动端工程（页面测试用）。登录不分工程，见 vueRunner */
export interface VueProjectMeta {
  /** 源码 env 文件里的测试工号，读不到为空串 */
  defaultUser: string
  /** uni-app 工程：页面来自 pages.json，浏览器里每页整页加载 */
  uni?: boolean
}

export interface ProjectScanResult {
  projectId: string
  projectPath: string
  projectName: string
  controllers: ControllerInfo[]
  mappers: MapperInfo[]
  classUses: ClassUse[]
  /**
   * 业务异常收集（throw new XxxException）。旧缓存没有这个键，当空数组；
   * 没有就用例生成退回字段注释推断。
   */
  bizThrows?: BizThrowInfo[]
  /**
   * VO/DTO 字段表。旧缓存没有这个键，当空数组。
   * 返回类型是 Map 时方法上没有字段清单，响应 JSON 仍能按 key 来这里查含义。
   */
  types?: ScannedType[]
  /**
   * 实体清单（@TableName / @Table 注解口径，PRD v0.6 模块 4.15 实体对账）。
   * 旧缓存 / 老扫描器没有这个键，当空数组。
   */
  entities?: EntityInfo[]
  /** 页面（页面测试用）。老缓存 / 老扫描器 / jar 模式没有这个键，当空数组 */
  pages?: PageInfo[]
  /** 算画像 / 写操作草稿用的算法版本（page/pageLogic.ts）；老缓存没有 */
  pageLogic?: number
  /** Vue 前端工程才有：登录方式和源码里的默认测试工号 */
  vue?: VueProjectMeta
  /** 单文件解析失败不阻断扫描，聚合在这里给报告用 */
  errors: { file: string; message: string }[]
}

export interface WorkspaceScanResult {
  root: string
  scannedAt: string
  fingerprint: string
  projects: ProjectScanResult[]
  errors: { file: string; message: string }[]
}

/* ================= 二、关联表（技术方案 2.2） ================= */

/**
 * 可信度沿用外键两级可信度的哲学：推断不许悄悄混进结果。
 * mapper/jpa 高可信默认启用；naming 低可信默认关闭（PRD 落地约束 2）。
 * user 是用户手动添加的表，最高优先级且重扫保留。
 */
export type LinkConfidence = 'user' | 'mapper' | 'jpa' | 'transactional' | 'naming'

export interface TableRelation {
  tableName: string
  confidence: LinkConfidence
  /** 证据：mapper 语句位点 / 命名推断的类名 */
  source: string
  /** naming 默认 false；用户勾选状态存这里，重扫不丢（mergeLinks 的职责） */
  enabled: boolean
}

/* ================= 三、用例（技术方案 2.4） ================= */

export type CaseType = 'normal' | 'boundary' | 'exception'

/** 响应体断言的判定符 */
export type BodyExpectOp = '==' | '!=' | 'contains' | 'notContains' | 'exists' | 'notExists'

/** 一条响应体断言：按 JSONPath 取值后判定 */
export interface BodyExpect {
  /** JSONPath，如 $.level、$.data.list[0].id；空白 = 根对象本身 */
  path: string
  op: BodyExpectOp
  /** ==/!=/contains/notContains 的期望值；exists/notExists 用不到（UI 里禁用输入） */
  value: string
}

export interface TestCase {
  id: string
  name: string
  type: CaseType
  /** 参数名 → 值。body 用例的值是整个 JSON 串 */
  parameters: Record<string, unknown>
  expectedHttpStatus: number[]
  /** 仅提示；observe 模式不参与判定（落地约束 3） */
  expectedDbChange: 'insert' | 'update' | 'delete' | 'none' | 'unknown'
  /**
   * 响应体断言。BizException 类业务失败回的是 HTTP 200 + 错误信封
   * （{msg, code, level:"error"}），状态码校验不住 —— 只判 HTTP 的判定是假绿的根因。
   * 空 / 缺省 = 不断言响应体（老用例行为不变，老 blob 无需迁移）。
   */
  expectBody?: BodyExpect[]
  /**
   * 「未找到」配对用例的标记：id 形字段全部给冻结大数（保证打空），期望
   * [200,400,404] —— 钉的是「数据不存在时后端优雅处理」这个分支。runner 见到
   * 这个标记必须跳过前置数据（borrow/造行都不做）：fixture 把目标行造出来，
   * 未找到就成找到了。可选：老用例没有此字段，行为不变。
   */
  probeNotFound?: boolean
  /**
   * 「正常·按 xxx 查」：跑前从借来的真实行取这个条件的值填进请求，跑完核对列表非空、
   * 每条这个字段对得上。position 说条件在 query 还是 body 里；取不到真实值就跳过。
   */
  queryBy?: { field: string; position: 'query' | 'body'; mode: 'eq' | 'contains' }
  enabled: boolean
  /** auto：生成器出的（缺省）；edited：生成后手改过；user：手动新增 / 复制。重新生成只替换 auto */
  origin?: 'auto' | 'edited' | 'user'
}

/* ================= 四、数据库验证（技术方案 2.3） ================= */

export interface TableSnapshot {
  tableName: string
  /** 行数；表不存在或查询失败为 null（报告里写「无法快照」而不是当成 0） */
  rowCount: number | null
  /** 主键 → 行。行是列名 → 字符串值（IPC 返回的就是 string[][]） */
  rows: Record<string, Record<string, string>> | null
  /** 抽样的主键值（INSERT/DELETE 集合差用） */
  pkValues: string[]
  /** 无主键或未配置主键时快照退化为只数行数 */
  hasPk: boolean
  error?: string
}

export interface FieldDiff {
  pk: string
  field: string
  before: string
  after: string
}

export interface TableChange {
  tableName: string
  op: 'insert' | 'update' | 'delete' | 'none'
  rowsInserted: number
  rowsUpdated: number
  rowsDeleted: number
  insertedIds: string[]
  deletedIds: string[]
  updatedIds: string[]
  fieldDiffs: FieldDiff[]
  note?: string
}

export interface DbChangeSummary {
  changes: TableChange[]
  /** 快照阶段就失败的表（连不上 / 无主键大表警告） */
  snapshotErrors: { tableName: string; message: string }[]
}

/* ================= 六点五、测试残留检测（PRD v0.6 模块 4.16） ================= */

/** apiInserted：新增接口自己插的行。工具不自动删业务数据，列出来等用户确认 */
export type ResidueKind = 'unclaimed' | 'orphanFk' | 'testPrefix' | 'apiInserted'

export interface ResidueFinding {
  kind: ResidueKind
  table: string
  /** 单主键列名。复合主键 / 无主键为空串——定位手段不完整，不生成清理 SQL */
  pkCol: string
  /** 匹配到的行总数（COUNT 全量）；快照差分这路只有样本没有全量，为 null */
  count: number | null
  /** 样本主键值（清理 SQL 的 IN 列表，上限 60） */
  pks: string[]
  /** 人话说明：哪列、什么条件、为什么算残留候选 */
  detail: string
}

export interface ResidueReport {
  findings: ResidueFinding[]
  /** 参与检测的表（勾选启用的关联表） */
  tables: string[]
  /** 没查成的说明（没列缓存 / 行数超上限 / 查询失败），用户要知道漏了什么 */
  skipped: { table: string; reason: string }[]
  /** 清理 DELETE，子表在前、父表在后（检测时就按方言生成好，报告直接引用）。
   *  空数组 = 没有能定位到主键的候选；执行前仍要人工确认 */
  cleanupSql: string[]
  ranAt: number
  /** 检测时连着的库；清理前比对，换过连接就不让删 */
  conn?: ResidueConn
}

export interface ResidueConn {
  /** 「我的连接」的 id；连的是未命名连接时为空，按 label 比 */
  id?: string
  /** 给人看的：名字 · 主机:端口/库 */
  label: string
}

/* ================= 五、环境与执行（技术方案 2.5 / 2.7） ================= */

export type AssertMode = 'observe' | 'strict'

export interface EnvironmentConfig {
  baseUrl: string
  loginApi: string
  username: string
  /** 只活在内存（store 不持久化这一字段）；持久化 blob 里永远没有它 */
  password?: string
  /** 抽 token 的 JSONPath。空 = 按 $.data.token / $.token / $.accessToken 依次试 */
  tokenJsonPath?: string
  /** 注入的请求头名，默认 Authorization */
  tokenHeader: string
  /** 值前缀，默认 Bearer；留空表示裸 token */
  tokenPrefix: string
  timeoutMs: number
  /** 出句「我的连接」的 id；空 = 未绑定 */
  connId: string
  assertMode: AssertMode
  /**
   * 按工程覆盖服务根地址（projectId → baseUrl）。
   * 空串 / 未登记 = 用上面的全局 baseUrl。大目录多工程端口不同时只填差异项。
   * 可选：老 blob / CI 构造可缺省，resolveBaseUrl 当空表处理。
   */
  projectBaseUrls?: Record<string, string>
  /**
   * 回归执行顺序编排（PRD v0.6 模块 4.20）：HTTP 方法先后，如 ['DELETE','GET']。
   * 缺省 / 空 = 默认 POST → GET → PUT → PATCH → DELETE（新增先跑建出数据）；
   * 没列出的方法按默认顺序跟在后面。写动词全局串行、GET 并发 3 不受编排影响。
   */
  methodOrder?: string[]
  /**
   * 数据准备：跑前把接口依赖的数据备好（查询接口借真实行 / 改删接口造自己的行），
   * 跑完按插入逆序清理，只清自己造的行（清理 SQL 进报告的「数据日志」）。
   * 默认开（2026-09-19 拍板：连库的目的就是数据验证，不该再让人找开关）；
   * 只在连库后生效；跑批前的写库总确认不变，不新增弹窗。
   */
  autoPrepare?: boolean
  /** 迁移标记：数据准备默认改为自动的一次性标记（loadEnv 写回），防止重复覆盖用户关闭的选择 */
  prepV2?: boolean
  /**
   * 只跑查询接口（高级功能）：跑批只发 isClearlyRead 认得出的读接口，写接口整个跳过，
   * 数据准备也关掉——sit / uat 上跑回归不往库里写一行。单接口「▶ 发送」照常发（也不造数）。
   */
  readOnlyRun?: boolean
  /**
   * 手工补值（字段名 → 值，原「样本值」）：SQL 造不出来的数据（别的服务写的、缓存里的、
   * MQ 触发的）由用户在环境面板补一个已知好 id。正常用例**最先**补入——借真实行 / 造数 /
   * 回填都以「最终要发的值」为基准对齐（补了 id=5，造出来的行就是 id=5）；异常/边界
   * 用例不补（0/-1 与缺字段的分支语义不能被盖掉）。
   */
  sampleValues?: Record<string, string>
  /**
   * 环境级变量（接口改进 · 变量体系）：{{名}} 在场景步骤与数据驱动行里引用。
   * 取值优先级：场景链上提取的 > 这里 > 内置动态（timestamp/uuid/date/time，
   * 一次跑批共用同一组值，见 vars/builtinVars）。随 env blob 落盘——这是测试
   * 数据不是保险箱，别放密码（密码只活在内存的铁律不变）。
   */
  vars?: Record<string, string>
  /** 页面测试：登录页工号（和接口登录账号分开：admin-ui 走的是工号登录页） */
  pageUsername?: string
  /** 页面测试登录密码：同 password，只活在内存，envWithoutSecret 会去掉 */
  pagePassword?: string
  /** 页面测试：密码记在本机凭据（cred_*，按工号），重开应用自动填回 */
  pageRememberPass?: boolean
  /** 页面测试：登录部门名，空 = 取第一个 */
  pageDept?: string
  /** 页面测试时显示浏览器窗口（默认不显示） */
  pageShowBrowser?: boolean
  /** 页面测试：Vue 工程的登录工号（projectId → 工号），空 = 用源码里的默认测试工号 */
  pageUsers?: Record<string, string>
}

/** 环境组：整套环境配置的命名快照（apiforge.envProfiles blob）。
 *  **密码不进快照**——存之前调用方必须先用 envWithoutSecret 剥掉（密码只活在内存） */
export interface EnvProfile {
  id: string
  name: string
  savedAt: number
  env: EnvironmentConfig
}

/* ================= 六、执行结果与报告（技术方案 2.6） ================= */

export interface CaseRunResult {
  caseId: string
  apiId: string
  apiPath: string
  httpMethod: string
  caseName: string
  caseType: CaseType
  ok: boolean
  /** 用例被禁用：不算通过也不算失败（ok 恒为 false），判断一律走 resultState */
  skipped?: true
  /** 跑完之后用例又改过（参数 / 期望）：这条结果可能不代表现在的用例，重跑后消失 */
  stale?: true
  httpStatus: number | null
  durationMs: number
  /** 响应体截断后的文本（报告里不用整个塞） */
  responsePreview: string
  /** 完整响应（pretty 后）。只在 preview 被截断时才带，只存内存，导出报告时剥掉 */
  responseFull?: string
  /** 实际发出的请求体（pretty 后截断，同响应规则）。可选：老结果 / CI 构造可缺省 */
  requestBodyPreview?: string | null
  /** 完整请求体，口径同 responseFull */
  requestBodyFull?: string
  /**
   * 响应体断言失败明细（judgeCase 产出）。只在非空时写入 —— 空/缺省 = 体断言全过
   * 或没配断言。展示口径：说明列取第一条，title 带全量。
   */
  assertFails?: string[]
  /**
   * 响应结构断言差异（judgeCase 产出，对扫描字典里响应类型字段清单的比对，见
   * scan/schemaAssert）。只在非空时写入。观察模式（env.assertMode='observe'，默认）
   * 只记录不算失败，严格模式折进 ok；只在正常用例上生成。
   */
  schemaIssues?: string[]
  /** 库变化核对的提示（「接口说成功了，但库里没有新增数据」）。只提示不算失败 */
  dbHint?: string
  error?: string
  dbChanges: TableChange[]
  snapshotErrors: { tableName: string; message: string }[]
  /** 造数 / 清理日志（落地约束 4：清理 SQL 进报告） */
  dataLog: string[]
  requestUrl: string
}

export interface RegressionReport {
  generatedAt: string
  projectRoot: string
  /** 本次范围的人话（「user-service · UserController」）。缺省 = 全量回归 */
  scope?: string
  /** skipped：禁用的用例；老报告缺省按 0 */
  summary: { total: number; passed: number; failed: number; skipped?: number; durationMs: number }
  results: CaseRunResult[]
  dbChangeSummary: {
    tableName: string
    totalInserted: number
    totalUpdated: number
    totalDeleted: number
  }[]
  /** 测试残留候选（PRD v0.6 模块 4.16）。只在连库跑批时检测；缺省 = 没查过 */
  residue?: ResidueReport
}

/* ================= 七、压力/性能测试（PRD v0.4 模块 4.8） ================= */

export type BenchMode = 'single' | 'regression' | 'mixed' | 'step'

/** 一个被压的请求：接口 + 用例经 buildRequest 算出的最终形态，Rust 引擎只认这个 */
export interface BenchRequestSpec {
  /** 即 apiId：报告分项按接口聚合 */
  id: string
  /** `GET /api/users` 的人话标签 */
  label: string
  method: string
  url: string
  headers: Record<string, string>
  body: string | null
  /** mixed 模式的占比权重，其他模式忽略 */
  weight: number
}

export interface BenchConfig {
  mode: BenchMode
  /** single 恰好 1 个；mixed / step 是勾选集合；regression 忽略（全量） */
  apiIds: string[]
  /** mixed 模式 apiId → 权重，没配的按 1 算 */
  weights: Record<string, number>
  /** 并发数，默认 10 */
  concurrency: number
  /** 持续时间（秒），默认 30 */
  durationSec: number
  /** 爬坡时间（秒），默认 5；step 模式忽略（阶梯本身就是爬坡） */
  rampupSec: number
  /** 单请求超时，默认 5000ms */
  timeoutMs: number
  /** 思考时间（ms），默认 0 */
  thinkTimeMs: number
  /**
   * 按数据表参数化（复盘短板 ④）：绑了数据表的接口按启用行展开成多条请求
   * （每条 weight = 接口权重 / 行数，接口间的占比不变），压测流量摊到每组
   * 参数上。缺省 / false = 不参数化，行为与老版本一致。
   */
  parametrize?: boolean
}

/** Rust 每秒推一个累计快照；TPS 曲线由相邻快照的差值算出 */
export interface BenchSample {
  /** 第几秒（从 1 起） */
  t: number
  conc: number
  total: number
  err: number
}

/** 实时/最终共用的指标快照。Rust 侧 serde camelCase 序列化，两边形状必须对齐 */
export interface BenchMetrics {
  elapsedSec: number
  conc: number
  total: number
  ok: number
  err: number
  /** 百分数 0~100，两位小数 */
  errRate: number
  tpsNow: number
  tpsAvg: number
  tpsMax: number
  avgMs: number
  p50Ms: number
  p90Ms: number
  p95Ms: number
  p99Ms: number
}

export interface BenchApiStat {
  id: string
  label: string
  total: number
  ok: number
  err: number
  avgMs: number
  minMs: number
  maxMs: number
  p50Ms: number
  p90Ms: number
  p95Ms: number
  p99Ms: number
  rps: number
  statusCounts: Record<string, number>
  topErrors: { message: string; count: number }[]
}

export interface BenchReport {
  generatedAt: string
  mode: BenchMode
  config: BenchConfig
  metrics: BenchMetrics
  perApi: BenchApiStat[]
  samples: BenchSample[]
  /** 用户点了「停止」：数据有效但时间没跑满 */
  stopped: boolean
}

/* ================= 八、多步场景编排（接口改进 #1） ================= */

/** 一步里从响应提取一个变量；后面的步骤用 {{名}} 引用 */
export interface ScenarioExtract {
  /** 变量名，起一眼看懂的（id / orderId） */
  name: string
  /** JSONPath，如 $.data.id */
  path: string
}

/** 场景的一步：接口库里挑一个接口，参数覆盖后发请求，再从响应里提取变量 */
export interface ScenarioStep {
  /** 步内唯一：重排 / 删除靠它当 key */
  id: string
  apiId: string
  /**
   * 参数覆盖：键 = 参数名（路径 / query 参数直接覆盖；body 接口用 __body 覆盖
   * 整个 JSON 串）。值里可以写 {{变量}}——值**整个**是一个 {{变量}} 且落在 body
   * JSON 的字段值位置时，变量值是数字/布尔就按裸字面量发（同 idValueOf 的纪律：
   * id 该是数字，字符串 "3" 会被服务端强转是运气不是契约）。缺省参数取该接口
   * 第一条启用的正常用例（▶ 发送同款）。
   */
  overrides?: Record<string, string>
  /** 跑完这一步从响应提取变量，供后面的步骤引用 */
  extracts?: ScenarioExtract[]
  /** 期望状态码。缺省按动词给默认（写动词 200+201，读/删 200），同正常用例口径 */
  expectedHttpStatus?: number[]
  enabled: boolean
}

export interface Scenario {
  id: string
  name: string
  steps: ScenarioStep[]
  updatedAt: number
  /**
   * 绑定的数据表（Scenario Outline，复盘短板 ④）：每启用一行，整条链跑一遍，
   * 行数据按列名当 {{变量}} 用（列 username → 步骤里 {{username}}）。缺省 = 不
   * 挂数据，单链跑一次。表被删了跑时给可读原因，不静默回落单链。
   */
  dataSetId?: string
}

/** 一步的执行结果。ok 的口径同 judgeCase（HTTP + 体断言 + 结构断言 + 提取成功） */
export interface ScenarioStepResult {
  stepId: string
  apiId: string
  apiPath: string
  httpMethod: string
  ok: boolean
  httpStatus: number | null
  durationMs: number
  requestUrl: string
  responsePreview: string
  error?: string
  /** 这一步提取到的变量（展示 + 下一步注入都靠它） */
  extracted?: Record<string, string>
  assertFails?: string[]
  schemaIssues?: string[]
}

export interface ScenarioRunResult {
  scenarioId: string
  scenarioName: string
  ranAt: number
  /** fail-fast：第一个失败步骤之后的步骤不再执行，结果里就到失败那步为止 */
  results: ScenarioStepResult[]
}

/** Outline 的一轮（= 数据表一行）：链内 fail-fast，行与行互相独立 */
export interface ScenarioOutlineRowResult {
  /** 数据表里的原始行号（0 起），跳过禁用行后仍对得上表 */
  rowIndex: number
  /** 行的人话：前两个非空列 k=v（outlineRowLabel），结果矩阵里认行全靠它 */
  label: string
  results: ScenarioStepResult[]
  ok: boolean
}

export interface ScenarioOutlineRunResult {
  scenarioId: string
  scenarioName: string
  ranAt: number
  dataSetId: string
  dataSetName: string
  rows: ScenarioOutlineRowResult[]
}

/* ================= 九、数据驱动用例（接口改进 #2） ================= */

/**
 * 数据表的一行。一格 = 一个参数值（列名 = 参数名，body 接口用 __body 整个 JSON），
 * 期望状态码单独记——Karate 的 Examples / Postman Runner 的 CSV 是同一个思路。
 */
export interface DataDrivenRow {
  /**
   * 参数名 → 单元格文本。**空串 = 不覆盖**：跑时这一格回落该接口第一条启用的
   * 正常用例的默认参数——喂表的人只填要变的列，其余交给用例基准。
   */
  params: Record<string, string>
  /** 期望状态码，逗号分隔（'200,201'）。空 = 按动词默认（写 200+201，读/删 200） */
  expected: string
  /**
   * 期望体断言（列「期望体」），单元格语法见 datadriven/parseExpectedBody：
   * `$.code=0` 等于、`!=` 不等于、`*=` 包含、`!*=` 不包含、光写路径 = 存在，
   * 分号分隔多条。空 = 不做体断言——行级期望自成一体，不回落正常用例的断言
   * （异常行要是继承了正常行的 `$.code=0`，只会假红）。
   */
  expectedBody?: string
  enabled: boolean
}

/** 一个数据驱动表：绑定一个接口，N 行数据批量发、逐行判定（一行失败不影响后面行） */
export interface DataDriven {
  id: string
  name: string
  apiId: string
  /** 列序 = 表头顺序；行 params 里缺的列当空单元格 */
  columns: string[]
  rows: DataDrivenRow[]
  updatedAt: number
}

/** 一行的执行结果。ok 口径同 judgeCase（HTTP + 体断言 + 结构断言），与回归一把尺子 */
export interface DataDrivenRowResult {
  rowIndex: number
  ok: boolean
  httpStatus: number | null
  durationMs: number
  requestUrl: string
  responsePreview: string
  /** 完整响应，只有失败行且被截断时才带，供「展开全部」 */
  responseFull?: string
  error?: string
  assertFails?: string[]
  schemaIssues?: string[]
}

export interface DataDrivenRunResult {
  setId: string
  setName: string
  apiId: string
  ranAt: number
  results: DataDrivenRowResult[]
  /** 用户点了停止才为 true；跑完前看行数不够不能当成停止 */
  stopped?: boolean
}

/* ================= 十、页面测试（浏览器层巡检 + 查询） ================= */

/** 查询字段的控件类型：决定怎么填、怎么核对结果 */
export type PageFieldKind = 'text' | 'select' | 'date' | 'tree'

/** 查询表单里的一个字段。name 就是表格数据接口请求里的参数名（$(scope).sovals() 按 name 序列化） */
export interface PageField {
  name: string
  /** 紧挨着的 <label> 文字，去掉冒号空白；日期区间的结束框继承起始框的 */
  label: string
  kind: PageFieldKind
}

/** 表格的一列（newGrid 的 frozenColumns + columns；hidden 与勾选列不收） */
export interface PageColumn {
  field: string
  title: string
  /** 带 formatter 的列显示的是算出来的值，结构差异检查跳过它 */
  formatter: boolean
}

export interface PageGrid {
  /** newGrid 的第一个参数，如 #gridBox */
  selector: string
  /** 数据接口，已去掉 ${base} */
  url: string
  columns: PageColumn[]
}

/** 从 ftl 抠出的页面画像。list = 查询按钮 + 表单 + 表格都认出来了；plain = 只做巡检 */
export interface PageProfile {
  kind: 'list' | 'plain'
  /** <title> 第一段（「采购申请单 - 采购管理 - …」取「采购申请单」），没有为空串 */
  title: string
  /** 查询按钮是页面上第几个 .so-search（从 0 起），plain 为 null */
  searchIndex: number | null
  /** 查询表单选择器（data-opt.scope），plain 为 null */
  formSelector: string | null
  fields: PageField[]
  grid: PageGrid | null
  /** 认不全的地方，一句人话一条；空 = 认全了，或者本来就是普通页 */
  problems: string[]
  /** 页面上「打开详情 / 编辑」的弹窗链接；老缓存里没有，重扫才有 */
  links?: PageLink[]
  /** Vue 页面才有：有没有标签页 / 搜索框、列表数据接口；pull 能下拉刷新，filter 有筛选入口（旧缓存没有） */
  vue?: { tabs: boolean; search: boolean; dataUrl: string | null; pull?: boolean; filter?: boolean }
}

/**
 * 列表页里打开详情的链接（$pop.iframePop 的 content）。表达式部分换成 {行字段}：
 * '${base}/ui/x/detail?id=' + row.id → /ui/x/detail?id={id}；相对地址原样留着（edit/{id}）
 */
export interface PageLink {
  /** 弹窗标题，没有为空串 */
  title: string
  url: string
  /** url 里用到的行字段，按出现顺序 */
  fields: string[]
  /** 行数据从哪张表格来；页面上没有字面量 url 的表格为 null */
  grid: { selector: string; url: string } | null
}

/** 详情用例：从哪个列表页的第一行取值、按哪条链接打开 */
export interface PageDetailRef {
  sourcePageId: string
  sourcePath: string
  sourceTitle: string
  /** 已按列表页地址解析成绝对路径（不含根地址） */
  link: PageLink
}

/** 扫描出的一个页面（Controller 里返回视图的方法） */
export interface PageInfo {
  /** projectId + '#' + path */
  id: string
  projectId: string
  controllerClass: string
  methodName: string
  /** 页面地址，如 /ui/shop/purchaseapply/getPurchaseApplyListPage */
  path: string
  viewName: string
  /** 模板文件路径；空 = 没找到模板 */
  ftlFile: string
  /** 要带参数才能打开（@PathVariable / 必填 @RequestParam / @RequestBody） */
  needsParams: boolean
  /** 没找到模板为 null（仍做巡检：能打开、不报错） */
  profile: PageProfile | null
  /** 写操作草稿；null = 不是能写的列表页。老缓存没有这个键，重扫才有 */
  writeDraft?: WriteDraft | null
  /** 页面来源；老缓存没有 = ftl。vue 页面的 path 是 # 后面的路由，ftlFile 是 .vue 相对路径 */
  source?: 'ftl' | 'vue'
}

export type PageCaseType = 'patrol' | 'query' | 'detail' | 'write' | 'dialog' | 'abnormal'

export interface PageCase {
  id: string
  pageId: string
  type: PageCaseType
  name: string
  /** 查询用例的字段；巡检为 null */
  field: PageField | null
  /** 字段配上的结果列；配不上或巡检为 null */
  column: PageColumn | null
  /** 详情用例才有 */
  detail?: PageDetailRef
}

export type PageCaseStatus = 'pass' | 'fail' | 'skip'

/** 跟上次比：new = 上次通过或没跑过、这次失败；still = 上次也失败；fixed = 上次失败、这次通过 */
export type PageTrend = 'new' | 'still' | 'fixed'

export interface PageRunResult {
  caseId: string
  pageId: string
  pagePath: string
  pageTitle: string
  caseName: string
  caseType: PageCaseType
  status: PageCaseStatus
  /** 失败 / 跳过的原因，一句人话；通过时是简短结论 */
  reason: string
  durationMs: number
  jsErrors: string[]
  failedRequests: string[]
  /** 只读保险拦下的疑似写请求（只记录，不算失败） */
  blockedRequests: string[]
  /** 查询用例：填了什么、请求里实际带了什么（sent 为 null = 没抓到请求） */
  query?: { field: string; value: string; sent: string | null }
  /** 详情用例：从哪个列表页打开、实际打开的地址（打不开时 url 为空） */
  detail?: { from: string; url: string }
  /** 写操作用例：每一步的结果（✓ / ✗ 开头的一句话） */
  write?: { steps: string[] }
  /** 行核对不符的明细，最多 5 条 */
  rowChecks: string[]
  schemaIssues: string[]
  /** 失败截图（data:image/jpeg;base64,…）。只留在本次报告里，不持久化 */
  screenshot?: string
  /** 跟上次比的结论，跑出结果时定下；老报告没有 */
  trend?: PageTrend
}

export interface PageRunReport {
  ranAt: number
  /** 这次运行了哪些页面的人话（「全部页面」「采购申请单」） */
  scope: string
  summary: { total: number; passed: number; failed: number; skipped: number; durationMs: number }
  results: PageRunResult[]
}

/* ---- 页面测试 · 写操作（第二版）---- */

/** 写操作弹窗里的一个字段。other = 第一版填不了（下拉表格、树、日期控件） */
export interface WriteField {
  name: string
  label: string
  kind: 'text' | 'select' | 'other'
  required: boolean
  maxlength: number | null
  /** ftl 里写死的下拉选项值（去掉空值）；远程加载的为空，运行时取第一个 */
  options: string[]
}

/** 一个 create.pop 弹窗：谁打开它、用哪个模板、保存到哪 */
export interface WritePopup {
  /** 新增：表格工具栏按钮文字；编辑：行内 .s-op 的 title */
  trigger: string
  /** create.pop 的模板 id；iframe 弹窗为空串 */
  templateId: string
  /** iframe 弹窗（$pop.iframePop / $pop.open type:2）打开的页面地址；create.pop 没有这个键 */
  frame?: string
  /** 保存地址，已去掉 ${base} */
  action: string
  fields: WriteField[]
}

/** 行内按钮（删除 / 停用）：title + 它的点击处理里 $ajax.post 的地址 */
export interface WriteRowOp {
  title: string
  url: string
}

/** 新增前要先在列表页选的下拉（combogrid / combobox）：跑的时候选第一项 */
export interface WritePick {
  selector: string
  label: string
}

/** crud = 新增 → 编辑 → 删除；editOnly = 编辑第一行再改回 */
export type WriteKind = 'crud' | 'editOnly'

/** ftl 读出的写操作草稿。problems 不空就不能加白名单，notes 只是给人看的说明 */
export interface WriteDraft {
  kind: WriteKind
  add: WritePopup | null
  edit: WritePopup | null
  /** 编辑时改的字段：编辑弹窗里的文本框，也是表格列 */
  editField: string
  del: WriteRowOp | null
  /** 删除按钮只在停用的行上显示时先点它；只对自己造的行 */
  disable: WriteRowOp | null
  /** 修改按钮只在启用的行上、新增出来又是停用时先点它；只对自己造的行。老白名单没有这个键 */
  enable?: WriteRowOp | null
  /** 点新增前要先选的列表页条件；只闭环页有。老白名单没有这个键 */
  addPick?: WritePick | null
  /** 闭环页查回用的查询表单字段；只编辑为 null */
  findField: string | null
  /** 草稿用到的 ftl 片段的指纹：重扫后变了要重新确认 */
  fingerprint: string
  problems: string[]
  notes: string[]
  /** uni-app 页面：不是弹窗，是从源码认出的整套点击路径；ftl 页面没有这个键 */
  uni?: UniWrite
}

/** 列表行上点「编辑」进表单页，改一个文本框保存，再改回 */
export interface UniFormEdit {
  type: 'formEdit'
  trigger: string
  /** 表单页路由 */
  form: string
  /** v-model 的字段名，也是列表接口行里的字段 */
  field: string
  /** 表单上这个框前面的字，运行时靠它找框 */
  label: string
  maxlength: number | null
  save: string
  action: string
  /** 查回用的列表接口 */
  listUrl: string
  /** 行内要确认的切换（设为默认）：在另一行上做、再在原来那行做回。on = 已是这个状态的行显示的字 */
  toggle: { trigger: string; on: string; url: string } | null
}

/** 一组同前缀的「列表 / 加 / 改 / 删」接口（购物车）：从详情页加进来，在本页加一个数量、再删掉 */
export interface UniCollect {
  type: 'collect'
  listUrl: string
  add: string
  update: string
  remove: string
  /** 详情页路由和它上面的按钮字（点一次弹规格框，框里同样的字再点一次） */
  addPage: string
  addTrigger: string
  /** 数量加一按钮里的图标名（uview 的 u-icon name） */
  plusIcon: string
  removeTrigger: string
}

/** Vue 表单页：打开列表里的一张单据，改一个文字框点「保存」（存草稿，不点「提交」），重开查回再改回 */
export interface VueFormEdit {
  type: 'vueFormEdit'
  /** 文字框所在格子的标题，运行时靠它找框 */
  label: string
  field: string
  maxlength: number | null
  save: string
  /** 「保存」可能调的地址（有 id 走 update、没有走 save） */
  actions: string[]
}

/** Vue 新建页：填文字框点「保存」存草稿，跳到详情页点「删除」 */
export interface VueDraftDelete {
  type: 'vueDraftDelete'
  label: string
  field: string
  maxlength: number | null
  save: string
  actions: string[]
  /** 保存后跳去的详情页路由 */
  detail: string
  delTrigger: string
  delUrls: string[]
}

export type UniWrite = UniFormEdit | UniCollect | VueFormEdit | VueDraftDelete

/** 白名单里的一页：用户确认时的草稿 + 他改过的字段值 */
export interface WriteSpec {
  pageId: string
  draft: WriteDraft
  /** name → 值；没填的按 valueFor 造 */
  values: Record<string, string>
  confirmedAt: number
}

/** 没收拾干净的数据：先落盘再保存，收尾成功才去掉 */
export interface WriteLeftover {
  pageId: string
  pagePath: string
  kind: 'created' | 'edited'
  /** created：查回字段里写的标记值 */
  marker?: string
  /** edited：行 id、字段、原值 */
  rowId?: string
  field?: string
  original?: string
  /** edited：工具写进去的值。现在的值不是它就是别人改过，收尾不动 */
  written?: string
  at: number
}

export interface PageWriteState {
  specs: WriteSpec[]
  leftovers: WriteLeftover[]
}
