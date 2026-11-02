/**
 * 用例自动生成，PRD v0.3 模块 4.5 / 技术方案 §2.4。
 *
 * 三类：正常（smoke 最小请求：query 只带必填+分页；body 只带分页——不是分页
 * 接口就是空对象/空数组）、边界（空串/0/负数/超长；id 形字段只发 0/-1 数字——
 * 发空串/超长串只会在后端 Long 反序列化处 400，是假失败不是边界）、异常（缺必填 + 业务异常：
 * 字段注释里写明的必填/至少N条/长度上限/数值范围，见 bizRulesOf，期望
 * 200/400——这批后端的「必填」校验就是 BizException，实测 saveApply 缺
 * brandOwnerId 回 HTTP 200 错误信封，Spring 注解校验拦的才是 400）。
 * 防爆炸：单接口上限 30 条（PRD 落地约束之外的评审口径：全量回归一跑几百条
 * 用例没人看，写操作还要逐条过库）。
 *
 * 值规则和 http/request.ts 的 defaultParamValue 共用 —— 那边是试跑兜底值，
 * 这里是用例矩阵，两边必须长得一样，改一处另一处跟着改。
 * 字符串字段的具体值由 sqlgen/mockValue.ts 的语义字典给（见 bodyValueOfField）：
 * 一律发 `test_demo` 的话，带 @Pattern/@Email/单号校验的接口那条「正常用例」
 * 必然 400，用户读成「接口挂了」——那是假失败。
 */
import type {
  ApiMethod,
  BizThrowInfo,
  CaseType,
  ClassUse,
  DtoField,
  ProjectScanResult,
  TestCase,
  WorkspaceScanResult,
} from '../types'
import { defaultParamValue, isCollectionBodyType } from '../http/request'
// 值字典只有 sqlgen/mockValue.ts 一份，不在这里另写一套
import { mockValueOfField, usesFieldDictionary } from '../../sqlgen/mockValue'
import type { TypeDict } from '../scan/bodyFields'
import { parsePreservingBig, stringifyPreservingBig } from '../../bigIntJson'
import { apiActionOf, dbChangeOfAction } from './apiAction'
import { DEFAULT_ENVELOPE_EXPECTS } from '../runner/judge'

const MAX_CASES_PER_API = 30
/** 「正常·按 xxx 查」每个接口最多几条：按扫描到的参数顺序取前 10 个 */
const MAX_QUERY_BY = 10

/** HTTP 动词 → 预期库变化提示（只看请求方法的老口径；生成用例走 apiAction） */
export function expectedDbChangeOf(httpMethod: string): TestCase['expectedDbChange'] {
  return dbChangeOfAction('unknown', httpMethod)
}

/** 边界用例只对「能造边界的类型」生成，别给每个字段都堆一堆无意义用例 */
const BOUNDARY_BY_TYPE: Record<string, string[]> = {
  String: ['', 'a'.repeat(256)],
  Integer: ['0', '-1'],
  Long: ['0', '-1'],
  int: ['0', '-1'],
  long: ['0', '-1'],
}

let seq = 0

function makeCase(
  api: ApiMethod,
  type: CaseType,
  name: string,
  parameters: Record<string, unknown>,
  expected?: number[],
): TestCase {
  seq += 1
  return {
    id: `${api.id}#${type}#${seq}`,
    name,
    type,
    parameters,
    // 边界值（空串 / 0 / -1 / 超长）仍然是**合法请求**：参数在、类型对，
    // 断言是「塞边界值不该把接口打挂」，所以跟正常用例同期望 2xx。
    // 例：`/flow/def/list` 的 keyword 是 `required=false`，keyword= 空串合法，服务端 200。
    // 异常用例（缺必填）留空 = 不校验：SHOP 全局异常处理器把 Spring 的 400 包成了什么
    // 还没实测（productCategory 那个包成了 500），没测出来之前不能瞎填一个期望。
    // 业务异常用例例外：期望 [200,400] —— 业务拦截怎么回都行，回 500 就是崩了。
    expectedHttpStatus: expected ?? (type === 'exception' ? [] : [200, 201]),
    expectedDbChange: dbChangeOfAction(apiActionOf(api), api.httpMethod),
    // 正常用例默认查信封：后端业务报错回 HTTP 200 + level:error，只看状态码是假绿。
    // 边界/异常本来就是去踩失败分支，不加
    ...(type === 'normal' ? { expectBody: DEFAULT_ENVELOPE_EXPECTS.map((e) => ({ ...e })) } : {}),
    enabled: true,
  }
}

/**
 * 分页 query / body 字段名（国内列表接口常见写法）。
 * 分页不是「筛选条件」：不带可能一次拉全表超时；带上页码 1 / 每页 10 才是安全连通。
 */
const PAGE_INDEX = /^(pageNum|pageNumber|pageNo|page|current|currentPage)$/i
const PAGE_SIZE = /^(pageSize|size|limit|rows|pageLimit)$/i
const PAGE_OFFSET = /^(offset|start|startRow|startIndex)$/i

export function isPagingParam(name: string): boolean {
  return PAGE_INDEX.test(name) || PAGE_SIZE.test(name) || PAGE_OFFSET.test(name)
}

function pagingDefault(name: string, javaType: string, declared?: string): string {
  if (declared) return declared
  if (PAGE_SIZE.test(name)) return '10'
  if (PAGE_OFFSET.test(name)) return '0'
  if (PAGE_INDEX.test(name)) return '1'
  return defaultParamValue({ name, javaType, position: 'query' })
}

/** 正常/冒烟：发这个值服务才认得出这条请求。可选筛选一律不算。 */
function isSmokeParam(p: { name: string; position: string; required: boolean }): boolean {
  if (p.position === 'body') return false
  if (p.position === 'path' || p.required) return true
  return isPagingParam(p.name)
}

function smokeValue(p: {
  name: string
  javaType: string
  defaultValue?: string
  position: string
  description?: string
}): string {
  return isPagingParam(p.name)
    ? pagingDefault(p.name, p.javaType, p.defaultValue)
    : (p.defaultValue ?? defaultParamValue(p))
}

/**
 * 正常用例：query/path = 业界 smoke / 最小合法请求（必填 + 分页），
 * 可选筛选不填 —— keyword 填个值会把列表筛空，选填枚举填错会 400。
 * body 交给 buildSmokeBody：分页接口只带分页参数，其余一律空对象——
 * 字段全填的大请求只会把业务校验（BizException）的路径全跳过去，
 * 真实字段覆盖交给异常/边界用例（那边走 buildBody 全量造）。
 */
function normalParams(api: ApiMethod): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const p of api.parameters) {
    if (!isSmokeParam(p)) continue
    values[p.name] = smokeValue(p)
  }
  if (api.requestBodyType) values.__body = buildSmokeBody(api)
  return values
}

/**
 * 正常用例的 body 按「查/增/改/删」给：空 body 发给写接口只会被业务校验拦下，
 * 「全绿但什么都没测到」。新增填满但不给主键 id（后端生成）；修改填满，id 跑前对准造的行；
 * 删除只带 id 形字段。查询、认不出的照旧发最小 body。
 */
function normalBodyOf(api: ApiMethod, dict: TypeDict | undefined): string | undefined {
  if (!api.requestBodyType || api.requestBodyFields.length === 0) return undefined
  const action = apiActionOf(api)
  if (action === 'insert') return bodyWithout(api, dict, 'id')
  // 主键先给冻结大数：跑前对准自己造的行才换成真 id；没对准（没连库 / 造行失败）时
  // 打空，不会拿字典的 id=1 去改、删库里的真数据
  const pk: Record<string, unknown> = {}
  for (const f of api.requestBodyFields) {
    if (/^id$/i.test(f.name)) pk[f.name] = NOT_FOUND_ID
    else if (/^ids$/i.test(f.name)) pk[f.name] = [NOT_FOUND_ID]
  }
  if (action === 'update') return buildBody(api, pk, dict)
  if (action === 'delete') {
    const keep = new Set(api.requestBodyFields.filter((f) => isIdLikeName(f.name) || /ids$/i.test(f.name)).map((f) => f.name))
    if (keep.size === 0) return undefined
    const parsed: unknown = parsePreservingBig(buildBody(api, pk, dict))
    for (const el of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!el || typeof el !== 'object') continue
      for (const k of Object.keys(el)) if (!keep.has(k)) delete (el as Record<string, unknown>)[k]
    }
    return stringifyPreservingBig(parsed)
  }
  return undefined
}

/** 日期区间的一半（startDate/endTime/beginTime/xxxFrom）和日期类型：第一版不做按条件查 */
const DATE_LIKE_NAME = /^(start|end|begin|from|to)[A-Z_]|(Start|End|Begin|From|To)$|(Date|Time)$/
const DATE_TYPES = /^(date|localdate|localdatetime|localtime|timestamp)$/i
/** 名字、关键字类按「包含」比（后端多半 like），id、状态、类型这类按相等 */
const CONTAINS_NAME = /(name|keyword|key|title|remark|desc|address|addr|content|text|memo)$/i

/** 查询接口的可选筛选条件：query 里非必填非分页的参数 + body 里非分页的标量字段 */
function queryConditionsOf(api: ApiMethod): NonNullable<TestCase['queryBy']>[] {
  const out: NonNullable<TestCase['queryBy']>[] = []
  const ok = (name: string, javaType: string) =>
    !isPagingParam(name) && !DATE_LIKE_NAME.test(name) && !DATE_TYPES.test(javaType.trim()) &&
    SCALAR_TYPES.has(javaType.trim().toLowerCase())
  const modeOf = (name: string): 'eq' | 'contains' => (CONTAINS_NAME.test(name) && !isIdLikeName(name) ? 'contains' : 'eq')
  for (const p of api.parameters) {
    if (p.position !== 'query' || p.required || !ok(p.name, p.javaType)) continue
    out.push({ field: p.name, position: 'query', mode: modeOf(p.name) })
  }
  if (api.requestBodyType && !isCollectionBodyType(api.requestBodyType)) {
    for (const f of api.requestBodyFields) {
      if (!ok(f.name, f.javaType)) continue
      out.push({ field: f.name, position: 'body', mode: modeOf(f.name) })
    }
  }
  return out.slice(0, MAX_QUERY_BY)
}

/**
 * body 冒烟：**只带分页**（页码 1 / 每页 10，防一次拉全表超时）——分页不是
 * 筛选条件，是列表接口的「默认参数」；筛选字段发个值反而把列表筛空。
 * 没有分页字段的接口就是空对象（集合 body 空数组），不编造字段名。
 */
function buildSmokeBody(api: ApiMethod): string {
  const fields = api.requestBodyFields
  if (!fields || fields.length === 0) return isCollectionBodyType(api.requestBodyType) ? '[]' : '{}'
  const paging: Record<string, unknown> = {}
  for (const f of fields) {
    if (!isPagingParam(f.name)) continue
    const n = Number(pagingDefault(f.name, f.javaType))
    paging[f.name] = Number.isFinite(n) ? n : pagingDefault(f.name, f.javaType)
  }
  if (Object.keys(paging).length > 0) return wrapBody(api, paging)
  return isCollectionBodyType(api.requestBodyType) ? '[]' : '{}'
}

/** List<UserReq> 这类集合 body 的 JSON 是数组：字段表是元素类型的，包一层才对上契约 */
function wrapBody(api: ApiMethod, obj: Record<string, unknown>): string {
  return isCollectionBodyType(api.requestBodyType) ? JSON.stringify([obj]) : JSON.stringify(obj)
}

/**
 * body 骨架但去掉指定字段（业务「必填缺失」用例）：buildBody 永远全量填，事后摘掉。
 * drop 可以一次给多个（扫描路径一次认领一组守卫字段，缺哪个先拦哪个）；
 * 集合 body 是元素列表，每个元素都要摘。
 */
function bodyWithout(api: ApiMethod, dict: TypeDict | undefined, drop: string | string[]): string {
  const drops = Array.isArray(drop) ? drop : [drop]
  const parsed: unknown = parsePreservingBig(buildBody(api, {}, dict))
  const elems = Array.isArray(parsed) ? parsed : [parsed]
  for (const el of elems) {
    if (el && typeof el === 'object') {
      for (const d of drops) delete (el as Record<string, unknown>)[d]
    }
  }
  return stringifyPreservingBig(parsed)
}

/* ================= 业务异常的扫描正源（throw new XxxException） =================
   字段注释推断（bizRulesOf）是「猜」；扫描器在 Service 方法体里捡到的 throw 是
   后端自己写的校验，连文案都是代码里那句。链路走法：Controller 方法用到的注入字段
   类型（classUses 一跳）→ Service 类里的 bizThrows，同名方法优先。throw 索引按
   **工作区全工程**合并——UI 壳工程的 Service 常是声明接口（Feign 风格，实现隔着
   HTTP 边界在 *-service 工程里），实测 admin-ui 的 saveApply 注入本工程声明的
   AdminOrderService，真实 throw 在 system-service 的实现类里，只认领本工程的
   bizThrows 永远够不着。className 是「实现类全名 + 接口简名别名」双登记，同一个
   throw 可能经多条路走到，按 方法名+throw 内容 去重，不然用例成对地重；两个工程
   各有同名 Service 时两边的 throw 都进候选，靠认领纪律（守卫字段不在 body 上就
   不生成）和 [200,400] 的宽容期望兜底。 */

/** bizThrows 按类名索引：全名 / 简名双键（classUseIndex 同款，扫描器两侧都有人用） */
function bizThrowIndex(project: ProjectScanResult): Map<string, BizThrowInfo[]> {
  const idx = new Map<string, BizThrowInfo[]>()
  for (const bt of project.bizThrows ?? []) {
    for (const key of new Set([bt.className, bt.className.split('.').pop() ?? bt.className])) {
      const list = idx.get(key) ?? []
      list.push(bt)
      idx.set(key, list)
    }
  }
  return idx
}

/**
 * 接口 → 它会踩到的业务异常清单。旧缓存没有 bizThrows / 链路走不通就返回空，
 * generateCases 自然落回注释推断——两层正源，谁有数据听谁的。
 */
export function bizThrowsForApi(api: ApiMethod, ws?: WorkspaceScanResult | null): BizThrowInfo[] {
  if (!ws) return []
  const project = ws.projects.find((p) => p.projectId === api.projectId)
  if (!project) return []
  const throwsIdx = new Map<string, BizThrowInfo[]>()
  for (const p of ws.projects) {
    for (const [key, list] of bizThrowIndex(p)) {
      const merged = throwsIdx.get(key)
      if (merged) merged.push(...list)
      else throwsIdx.set(key, list)
    }
  }
  if (throwsIdx.size === 0) return []

  // classUses 同款双键索引：类里每个方法用到的注入字段类型
  const usesIdx = new Map<string, ClassUse[]>()
  for (const cu of project.classUses) {
    for (const key of new Set([cu.className, cu.className.split('.').pop() ?? cu.className])) {
      const list = usesIdx.get(key) ?? []
      list.push(cu)
      usesIdx.set(key, list)
    }
  }
  const ctrlKey = usesIdx.has(api.controllerClass)
    ? api.controllerClass
    : [...usesIdx.keys()].find((k) => k.endsWith(`.${api.controllerClass}`))
  if (!ctrlKey) return []
  const ctrlUses = usesIdx.get(ctrlKey)!
  // 只认这个 Controller 方法自己用到的 Service；不再退到整个 Controller
  const ctrlPool = ctrlUses.filter((u) => u.methodName === api.methodName)

  // 一跳到 Service。只收名字对得上的方法（save → saveApply 算对上）；
  // 以前对不上就收整类，查询接口会捡到「不是待提交不能提交」这种别的方法的 throw
  const out = new Map<string, BizThrowInfo>()
  for (const u of ctrlPool) {
    for (const svcType of u.usedFieldTypes) {
      const list = throwsIdx.get(svcType)
      if (!list) continue
      for (const bt of list.filter((bt) => methodNamesMatch(api.methodName, bt.methodName))) {
        out.set(`${bt.methodName}|${JSON.stringify(bt.throws)}`, bt)
      }
    }
  }
  return [...out.values()]
}

/** Controller 与 Service 方法名对得上：同名，或一方包含另一方（忽略大小写） */
function methodNamesMatch(ctrl: string, svc: string): boolean {
  const a = ctrl.toLowerCase()
  const b = svc.toLowerCase()
  return a === b || a.includes(b) || b.includes(a)
}

/** 后端文案进用例名：报告里一眼对上代码里那句 throw。太长截断，空白压成单空格 */
function bizMsgName(msg: string): string {
  const t = msg.trim().replace(/\s+/g, ' ')
  return t.length > 40 ? `${t.slice(0, 40)}…` : t
}

/* ================= 业务异常规则（从字段 Javadoc 描述里读） =================
   国内工程的业务约束主要写在字段注释里而不是注解上（实测 ruoyi-shop：
   "品牌商id,必填。" 但 @NotNull 压根没有，扫描器 required 提取不到），
   所以业务异常用例的正源是 description 文本。 */

interface BizRule {
  /** 用例名后缀，如「必填缺失」「越界(101)」 */
  label: string
  /** 违例值（给这个值触发业务异常） */
  value?: unknown
  /** 缺失型违例：整个字段不发 */
  omit?: boolean
}

const DOC_OPTIONAL = /选填|非必[填传]|可以不[填传]|可不[填传]|允许为空|可为空/
const DOC_REQUIRED = /必[填传]|不能为空|不可为空|不得为空|非空/
const STRING_TYPES = /^(string|char|character)$/i
const NUMERIC_TYPES = /^(int|integer|long|short|byte|double|float|bigdecimal|biginteger)$/i
/** 裸集合名（老缓存里扫描器剥过泛型，List<OrderItem> 只剩 List） */
const BARE_COLLECTION = /^(list|set|collection|iterable|arraylist|linkedlist|hashset|linkedhashset|queue|deque|stack|vector)$/i

/** 注释里的中文数字 → 阿拉伯（"至少一条" → 至少1条，用例名给人看） */
const CN_NUM: Record<string, string> = {
  一: '1', 二: '2', 两: '2', 三: '3', 四: '4', 五: '5',
  六: '6', 七: '7', 八: '8', 九: '9', 十: '10',
}

/**
 * 字段描述 → 业务异常规则。认四种：
 * 必填（"必填/不能为空"，且没说选填）→ 摘字段；
 * 至少 N 条（集合）→ 空数组；长度上限（"不超过50/最长50"）→ 超长串；
 * 数值范围（"0-100"）/正整数 → 越界值。一行描述多条规则就各生成一条用例。
 */
export function bizRulesOf(f: {
  javaType: string
  description?: string
}): BizRule[] {
  const d = f.description ?? ''
  if (!d) return []
  const rules: BizRule[] = []
  if (!DOC_OPTIONAL.test(d) && DOC_REQUIRED.test(d)) {
    rules.push({ label: '必填缺失', omit: true })
  }
  const isCollection = collectionElementOf(f.javaType) !== null || BARE_COLLECTION.test(f.javaType.trim())
  // 注释里写中文数字（"至少一条"）：认 一~十/两 和阿拉伯数字，量词原样带上
  const minCount = /至少\s*(\d+|[一二两三四五六七八九十]+)\s*([条个笔项])?/.exec(d)
  if (minCount && isCollection) {
    const n = CN_NUM[minCount[1]] ?? minCount[1]
    rules.push({ label: `至少${n}${minCount[2] ?? ''}却给空`, value: [] })
  }
  if (STRING_TYPES.test(f.javaType.trim())) {
    let maxLen: number | null = null
    for (const m of d.matchAll(/(?:最长|最大长度|长度不超过|不超过|最多)[^\d]{0,3}(\d+)/g)) {
      const n = Number(m[1])
      if (Number.isFinite(n) && n > 0 && (maxLen === null || n < maxLen)) maxLen = n
    }
    if (maxLen !== null) rules.push({ label: `超长(${maxLen + 1}字)`, value: 'a'.repeat(maxLen + 1) })
  }
  if (NUMERIC_TYPES.test(f.javaType.trim())) {
    // 日期区间（2026-01-01）会命中 "2026-01"，但 lo>hi 直接淘汰，不会造出假规则
    const range = /(-?\d+(?:\.\d+)?)\s*(?:[-~]|到|至)\s*(-?\d+(?:\.\d+)?)/.exec(d)
    if (range) {
      const lo = Number(range[1])
      const hi = Number(range[2])
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi) {
        rules.push({ label: `越界(${hi + 1})`, value: hi + 1 })
      }
    } else if (/正整数/.test(d)) {
      rules.push({ label: '非正整数(给0)', value: 0 })
    }
  }
  return rules
}

/**
 * @RequestBody 的 JSON：字段清单来自扫描器（DTO 反查）。required 字段全给，
 * 可选字段也给 —— 异常用例才有「缺失」可言。扫描不到字段清单就给 {}，
 * 让服务端校验去说话，不编造字段名。
 * dict 给了就按字段类型往深里造骨架：List<Xxx> 给 [元素骨架]、对象字段给
 * 嵌套骨架——试跑面板是手编面板，看得见字段才有的填（detailList 实测）。
 */
export function buildBody(
  api: ApiMethod,
  overrides: Record<string, unknown>,
  dict?: TypeDict,
): string {
  const fields = api.requestBodyFields
  if (!fields || fields.length === 0) {
    // 集合 body 反查不到元素字段（List<String> 之类）：最小合法就是空数组
    return isCollectionBodyType(api.requestBodyType) ? '[]' : JSON.stringify(overrides)
  }
  const obj: Record<string, unknown> = {}
  for (const f of fields) {
    obj[f.name] = f.name in overrides ? overrides[f.name] : scaffoldValueOf(f, dict, 0, new Set())
  }
  return wrapBody(api, obj)
}

/**
 * 一眼看出是假的占位值。**只在「类型认不出、没有任何语义可依据」时才允许给**
 * （bodyValueOf 的兜底）。
 *
 * 取个名字是因为它还有第二个用处：`refreshStaleBodies` 靠它认出「这条固化 body
 * 是上一版生成器写的」。本轮之前任何 String 字段一律发它，老用例存下来的
 * `{"id":"test_demo"}` 就是这么来的——而 `IdCondition.id` 只该是个数字串。
 */
const PLACEHOLDER = 'test_demo'

/**
 * 「未找到」配对用例的冻结大数：Long 范围内、JS 安全整数内、离任何真实业务 id
 * 都足够远。查询串/路径里发字符串，body 里走 JSON 数字（同 idValueOf 纪律）。
 */
export const NOT_FOUND_ID = 987654321000
const NOT_FOUND_ID_TEXT = String(NOT_FOUND_ID)

/**
 * 只按 Java 类型给值 —— **不知道字段叫什么**时的兜底。
 *
 * 它已经不该再服务带名字的字段了（那些走 bodyValueOfField）。剩下两个正当用处：
 *   1. docs.ts 的 responseSampleOf：返回值只有类型名，没有字段名可依据；
 *   2. 字典里查不到的复杂类型（扫描器认不出的 VO），诚实给一个一眼看出是假的
 *      `test_demo`，而不是编一个像真的业务值。
 * 数字/布尔/日期那几支仍然是**契约要求**的类型：body 里 Integer 给 1 不能给 "1"。
 */
export function bodyValueOf(javaType: string): unknown {
  const t = javaType.toLowerCase()
  if (t === 'integer' || t === 'int' || t === 'long') return 1
  if (t === 'double' || t === 'float' || t === 'bigdecimal') return 1.5
  if (t === 'boolean') return true
  if (t === 'localdatetime' || t === 'date') return '2026-01-01 00:00:00'
  if (t === 'localdate') return '2026-01-01'
  // 裸集合名（老缓存里扫描器剥过泛型，List<OrderItem> 只剩 List）
  if (/^(list|set|collection|iterable|arraylist|linkedlist|hashset|linkedhashset|queue|deque|stack|vector)$/.test(t)) return []
  if (t.endsWith('[]') || t.startsWith('list<') || t.startsWith('set<')) return []
  if (t === 'biginteger') return 1
  return PLACEHOLDER
}

/** id 形字段名：id / userId / brandOwnerId / userID / user_id。`isValid`、`liquid` 这种恰好以 id 收尾的英文词不算（camel 边界前必须有字母）。 */
export function isIdLikeName(name: string): boolean {
  return /^id$/i.test(name) || /Id$/.test(name) || /[a-z]ID$/.test(name) || /_id$/i.test(name)
}

/**
 * id 形字段 → 一个数字。SHOP 的条件 DTO 把 id 声明成 String（IdCondition.id
 * 实测），字典按 `_id$`/裸 id 规则给的是数字**串**——发 JSON 就该是数字
 * （saveApply 的 brandOwnerId 是 Long；发 "3" 虽然会被强转，契约上不该赌）。
 * 剥掉注释再查字典：注释说「手机号/编号」不该盖过 id 的数字语义。
 * 只对走字典的 String 生效——Long/Integer 本来就给数字（bodyValueOf），不动。
 * 给不出数字（名字撞上别的规则）返回 null，调用方退回原路径。
 */
function idValueOf(f: { name: string; javaType: string; description?: string }): number | null {
  if (!isIdLikeName(f.name) || !usesFieldDictionary(f.javaType)) return null
  const n = Number(mockValueOfField({ ...f, description: undefined }))
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

/**
 * body 字段 → 值。带名字的字段都走这里：字符串交给语义字典按**字段名 + 注释**
 * 出值（`contact` + 注释「手机号」→ 138…，能过 @Pattern 校验），id 形字段一律
 * 数字（idValueOf），其余类型仍走 bodyValueOf 的按类型约定。
 *
 * 判别只此一份（usesFieldDictionary）：不能让 `Integer` 字段落进字典拿到
 * 字符串 `T00000001` —— 那是 400，而且是这次改动的反面。
 */
export function bodyValueOfField(f: DtoField): unknown {
  const id = idValueOf(f)
  return id ?? (usesFieldDictionary(f.javaType) ? mockValueOfField(f) : bodyValueOf(f.javaType))
}

/** 集合泛型实参：List<Xxx> / Set<Xxx> / Xxx[] → Xxx；裸 List（老缓存剥过泛型）认不出，返回 null。 */
function collectionElementOf(javaType: string): string | null {
  const m = /^(?:list|set|collection|iterable|arraylist|linkedlist|hashset|linkedhashset|queue|deque|stack|vector)<(.+)>$/i
    .exec(javaType.trim())
  if (m) return m[1].trim()
  if (javaType.trim().endsWith('[]')) return javaType.trim().slice(0, -2).trim()
  return null
}

/** 元素/字段是不是标量（集合元素是标量就给一个值，不去字典里硬查） */
const SCALAR_TYPES = new Set([
  'string', 'char', 'character', 'int', 'integer', 'long', 'short', 'byte',
  'double', 'float', 'bigdecimal', 'biginteger', 'boolean',
  'date', 'localdate', 'localdatetime', 'localtime',
])

/** 嵌套深度上限：DTO 互引成环、自引用树都真实存在，骨架到第 3 层止步 */
const MAX_NEST_DEPTH = 3

/**
 * 字段值骨架：集合带对象泛型给 `[元素骨架]`，对象字段给嵌套骨架；
 * 元素是标量给一个值，字典里没有的类型诚实退回 bodyValueOf / []——
 * 不编造字段名。depth/seen 防环：A→B→A、TreeNode.children 这类自引用
 * 到深度或已见类型为止。
 *
 * 收**字段**而不是裸类型名：标量元素（`List<String> phones`）没有自己的名字，
 * 用它所在字段的名字去查字典才有语义——`phones` 该给手机号，
 * 而裸 `List<String>` 里的 `String` 什么也说明不了。
 */
function scaffoldValueOf(
  f: DtoField,
  dict: TypeDict | undefined,
  depth: number,
  seen: Set<string>,
): unknown {
  const elem = collectionElementOf(f.javaType)
  if (elem !== null) {
    if (SCALAR_TYPES.has(elem.toLowerCase())) {
      // 集合元素是标量时元素没有自己的名字，借字段名查字典；id 形的集合字段
      // （List<String> userIds）同理给数字，跟单个 id 字段一个口径
      return [bodyValueOfField({ name: f.name, javaType: elem, required: f.required, description: f.description })]
    }
    const inner = objectScaffold(elem, dict, depth + 1, seen)
    return inner === null ? [] : [inner]
  }
  const nested = objectScaffold(f.javaType, dict, depth + 1, seen)
  return nested === null ? bodyValueOfField(f) : nested
}

/** 类型简名 → 字段骨架对象；字典里没有 / 超深度 / 成环返回 null（调用方决定退什么） */
function objectScaffold(
  typeName: string,
  dict: TypeDict | undefined,
  depth: number,
  seen: Set<string>,
): Record<string, unknown> | null {
  if (!dict || depth > MAX_NEST_DEPTH || seen.has(typeName)) return null
  const fields = dict.get(typeName)
  if (!fields || fields.length === 0) return null
  const nextSeen = new Set(seen)
  nextSeen.add(typeName)
  const obj: Record<string, unknown> = {}
  for (const f of fields) {
    if (isPagingParam(f.name)) {
      const n = Number(pagingDefault(f.name, f.javaType))
      obj[f.name] = Number.isFinite(n) ? n : pagingDefault(f.name, f.javaType)
    } else {
      obj[f.name] = scaffoldValueOf(f, dict, depth, nextSeen)
    }
  }
  return obj
}

/**
 * 给一个接口生成三类用例。数量超上限时按 正常 > 异常 > 边界 截断 ——
 * 正常路径是回归的主干，先保它。
 * dict（类简名 → 字段，来自 buildTypeDict）给了，body 骨架就往深里造。
 * scan（工作区扫描结果）给了，业务异常用例优先用扫描器捡到的真实 throw
 * （bizThrowsForApi），注释推断降级成兜底——没有 scan 的调用方（跑批 bench、
 * 旧缓存）行为和从前完全一样。
 */
export function generateCases(api: ApiMethod, dict?: TypeDict, scan?: WorkspaceScanResult | null): TestCase[] {
  const cases: TestCase[] = []
  const scanThrows = bizThrowsForApi(api, scan)
  const required = api.parameters.filter((p) => p.required && p.position !== 'body')
  const action = apiActionOf(api)
  // 查询接口的正常用例本来就只带分页，「缺某字段」和它自相矛盾，不造
  const readOnly = action === 'query'

  // 正常：查询 = smoke 最小合法请求；增改删发真数据（normalBodyOf）
  const normalBody = normalBodyOf(api, dict)
  cases.push(makeCase(api, 'normal', `正常·${api.methodName}`, {
    ...normalParams(api),
    ...(normalBody !== undefined ? { __body: normalBody } : {}),
  }))

  // 查询条件逐个覆盖：值跑前从借来的真实行取（runner/queryBy），取不到就跳过。
  // 不做多条件组合（会爆成几百条），要测组合用数据驱动表格
  if (readOnly) {
    for (const q of queryConditionsOf(api)) {
      cases.push({ ...makeCase(api, 'normal', `正常·按 ${q.field} 查`, normalParams(api)), queryBy: q })
    }
  }

  // 异常：逐个缺必填参数（缺一个发一次，服务端的 400 才能对上号）
  for (const p of required) {
    const values: Record<string, unknown> = { ...normalParams(api) }
    delete values[p.name]
    cases.push(makeCase(api, 'exception', `异常·缺 ${p.name}`, values))
  }
  if (api.requestBodyType && api.requestBodyFields.some((f) => f.required)) {
    // body 异常：全部必填字段给空串（@NotNull/@NotBlank 校验会拦）
    const missing: Record<string, unknown> = {}
    for (const f of api.requestBodyFields) {
      if (f.required) missing[f.name] = ''
    }
    cases.push(makeCase(api, 'exception', `异常·body 必填字段为空`, {
      ...normalParams(api),
      __body: buildBody(api, missing, dict),
    }))
  }

  // 业务异常，两层正源：
  // ① 扫描正源——Service 方法体里真实的 throw new XxxException（bizThrowsForApi），
  //    用例名直接带后端文案，守卫字段整组摘掉（缺哪个先拦哪个）。认领字段一个都
  //    不在这个 body 里就不生成：同一个 Service 方法常被多个接口复用，别的接口
  //    的守卫不该算到这个接口头上。
  // ② 注释推断兜底——字段 Javadoc 写明的业务约束（必填/至少N条/长度上限/数值范围）。
  //    期望 [200,400]：业务异常被全局处理器优雅接住怎么回都行，回 500 就是没兜住。
  //    requestBodyFields 里说明字段常被扫描器丢掉（多数都丢了），
  //    而 types 字典同一字段的说明保留了 79%——字典里回查一份，业务规则才读得全。
  //    扫描已发「缺失」用例的字段不再重复发注释的必填缺失；值型规则照出——
  //    扫描只认领字段，给不出超长/越界那种违例值。
  if (api.requestBodyType) {
    const elemType = collectionElementOf(api.requestBodyType) ?? api.requestBodyType
    const dictFields = dict?.get(elemType)
    const descOf = (f: DtoField) => f.description ?? dictFields?.find((d) => d.name === f.name)?.description
    const bodyNames = new Set(api.requestBodyFields.map((f) => f.name))
    const scanCovered = new Set<string>()
    for (const info of scanThrows) {
      for (const d of info.throws) {
        const hit = d.fields.filter((f) => bodyNames.has(f))
        if (hit.length === 0) continue
        for (const f of hit) scanCovered.add(f)
        const label = d.message ? bizMsgName(d.message) : `${hit.join('/')} 未过校验`
        cases.push(
          makeCase(
            api,
            'exception',
            `异常·业务·${label}`,
            { ...normalParams(api), __body: bodyWithout(api, dict, hit) },
            [200, 400],
          ),
        )
      }
    }
    let hasCommentRule = false
    for (const f of api.requestBodyFields) {
      const rules = bizRulesOf({ javaType: f.javaType, description: descOf(f) })
      if (rules.length > 0) hasCommentRule = true
      for (const r of rules) {
        if (r.omit && (readOnly || scanCovered.has(f.name))) continue
        const body = r.omit
          ? bodyWithout(api, dict, f.name)
          : buildBody(api, { [f.name]: r.value }, dict)
        cases.push(
          makeCase(
            api,
            'exception',
            `异常·业务·${f.name} ${r.label}`,
            { ...normalParams(api), __body: body },
            [200, 400],
          ),
        )
      }
    }
    // 探查兜底：写接口一条规则都没挖到（扫描没捡到 throw、注释也没写约束）时，
    // 满员 body 逐字段「缺一探查」——后端拦了（400/错误信封）就说明那个字段有
    // 校验，只是两条正源都没把它露出来。期望 [200,400]：没校验 200 也是结论。
    // 整个接口零规则才补（挖到一半不补，矩阵要爆炸）；封顶 8 条；分页字段不探
    // （摘 pageNum 不是校验是分页）。
    if (
      scanCovered.size === 0 &&
      !hasCommentRule &&
      !readOnly &&
      (api.httpMethod === 'POST' || api.httpMethod === 'PUT') &&
      api.requestBodyFields.length > 0
    ) {
      let probes = 0
      for (const f of api.requestBodyFields) {
        if (probes >= 8) break
        if (isPagingParam(f.name)) continue
        cases.push(
          makeCase(
            api,
            'exception',
            `异常·探查·缺 ${f.name}`,
            { ...normalParams(api), __body: bodyWithout(api, dict, f.name) },
            [200, 400],
          ),
        )
        probes += 1
      }
    }
  }

  pushNotFound(cases, api, required, dict)

  // 边界：空串/0/负数/超长。只造 query/body 里认识类型的字段，每字段一条。
  // id 形字段例外：语义是主键不是自由文本，边界发 0/-1（「不存在的 id」）——
  // query 里反正都是字符串所以发 '0'；body 走 JSON 数字（后端 Long 收不下
  // 数字字符串，见 idValueOf），发 ''/'aaa…' 只会在反序列化处 400，是假失败
  for (const p of api.parameters) {
    const options = isIdLikeName(p.name) ? ['0', '-1'] : BOUNDARY_BY_TYPE[p.javaType]
    if (!options) continue
    for (const v of options) {
      const values: Record<string, unknown> = { ...normalParams(api) }
      if (p.position === 'body') continue
      values[p.name] = v
      cases.push(makeCase(api, 'boundary', `边界·${p.name}=${v === '' ? '空串' : String(v).slice(0, 8)}`, values))
    }
  }
  if (api.requestBodyType) {
    // IdCondition.id 这种 String 类型的主键也要进来：发 ''/'aaa…' 会被
    // 后端 Long 反序列化直接 400（test_demo 实测过），不是有意义的边界
    const fields = api.requestBodyFields.filter((f) => isIdLikeName(f.name) || BOUNDARY_BY_TYPE[f.javaType])
    for (const f of fields) {
      const options: (string | number)[] = isIdLikeName(f.name) ? [0, -1] : BOUNDARY_BY_TYPE[f.javaType]
      for (const v of options) {
        cases.push(makeCase(api, 'boundary', `边界·body.${f.name}=${v === '' ? '空串' : String(v).slice(0, 8)}`, {
          ...normalParams(api),
          __body: buildBody(api, { [f.name]: v }, dict),
        }))
      }
    }
  }

  return cases.slice(0, MAX_CASES_PER_API)
}

/** 「未找到」配对用例；排在边界前面，超 30 条时先截边界 */
function pushNotFound(
  cases: TestCase[],
  api: ApiMethod,
  required: ApiMethod['parameters'],
  dict: TypeDict | undefined,
): void {
  const action = apiActionOf(api)
  // 「未找到」配对用例（数据依赖收口）：成功路径由运行时借真实行/造行对准真数据，
  // 这里配一条保证打空的——id 形字段全给冻结大数，期望 [200,400,404]：数据不存在
  // 时后端优雅处理（200 错误信封 / 400 拦截 / 404 都算过），回 500 就是没兜住。
  // runner 见 probeNotFound 会跳过前置数据——fixture 把目标行造出来，未找到就成
  // 找到了，这条用例就白配了。只认必填的 id 形参数（getById 形态）和写动词的 body
  // id 字段：列表接口的可选 id 筛选填大数只会把结果筛空，测的不是「未找到」。
  {
    let nfValues: Record<string, unknown> | null = null
    for (const p of required) {
      if (!isIdLikeName(p.name)) continue
      nfValues ??= { ...normalParams(api) }
      nfValues[p.name] = NOT_FOUND_ID_TEXT
    }
    // 改、删接口都配：SHOP 的改删几乎全是 POST，只看请求方法配不上
    if (api.requestBodyType && (action === 'update' || action === 'delete' ||
      api.httpMethod === 'PUT' || api.httpMethod === 'PATCH' || api.httpMethod === 'DELETE')) {
      const idFields = api.requestBodyFields.filter((f) => isIdLikeName(f.name))
      if (idFields.length) {
        const bodyOverrides: Record<string, unknown> = {}
        for (const f of idFields) bodyOverrides[f.name] = NOT_FOUND_ID
        nfValues = { ...(nfValues ?? normalParams(api)), __body: buildBody(api, bodyOverrides, dict) }
      }
    }
    if (nfValues) {
      cases.push({
        ...makeCase(api, 'exception', '异常·未找到', nfValues, [200, 400, 404]),
        // 未找到不改库：期望变更对齐事实，快照 diff 别被这条用例的「预期 insert/delete」误导
        expectedDbChange: 'none',
        probeNotFound: true,
      })
    }
  }
}

/**
 * 重扫后刷新老用例里固化的 body。缓存用例优先于现场生成（buildRequest 的既有
 * 约定），扫描器后来才把 DTO 字段认出来的话（依赖 jar 兜底是后加上去的），老用例
 * 存着的 `__body` 会一直按老形状发。冒烟 body 现在是最小形状（分页 / {}），
 * 老版本生成器写下的两种陈旧形态靠 isStaleBody 认出来重写成当前形状：
 *
 * - 存着 `'{}'`：曾经是「字段表还没解析到」的空壳；
 * - 还带着老占位值 test_demo：曾经「字段全量填入 + 不认识的 String 一律发它」
 *   （实测 IdCondition 固化下来就是 `{"id":"test_demo"}`——现在它该是
 *   空对象，id 数字化这件事也一起对齐）。
 *
 * **用户填过内容的 body 一个字不碰**（isStaleBody 认不出的都不算陈旧）。
 * 重写一遍还是同一个值（比如双方都是 `'{}'`）就不算刷新，调用方省掉无谓的持久化。
 */
export function refreshStaleBodies(api: ApiMethod, cases: TestCase[]): TestCase[] | null {
  if (!api.requestBodyType || api.requestBodyFields.length === 0) return null
  const fresh = buildSmokeBody(api)
  // 增改删的正常用例现在是填满的 body，认不出的复杂类型里可能带 test_demo：
  // 那不是「陈旧」，刷成冒烟形状就又变回空 body 了
  const action = apiActionOf(api)
  const fullNormal = action === 'insert' || action === 'update' || action === 'delete'
  let changed = false
  const out = cases.map((c) => {
    const b = c.parameters.__body
    if (typeof b !== 'string') return c
    if (fullNormal && c.type === 'normal') return c
    if (!isStaleBody(b, fresh) || b === fresh) return c
    changed = true
    return { ...c, parameters: { ...c.parameters, __body: fresh } }
  })
  return changed ? out : null
}

/**
 * 这条固化 body 是不是上一版生成器留下的。
 *
 * 除了空对象，还有第二种陈旧形态：**上一版对任何 String 字段一律发 `test_demo`**，
 * 于是「重扫 → 老用例照样发 test_demo」这件事会永远修不好（实测
 * `IdCondition`：整个 DTO 只有一个 `id: String`，body 固化下来就是
 * `{"id":"test_demo"}`，而它现在该是个空对象）。字段表没变，光靠「字段表
 * 变了才刷」这条判据永远轮不到它，只能认值本身。
 *
 * 但要配一个前提：**现在的生成器不再产出 test_demo**（冒烟 body 只有分页/{}）。
 * 认不出的复杂类型在 buildBody（手编面板）里仍然诚实地给 test_demo，
 * 但那不走冒烟路径——fresh 里不会有它。
 */
function isStaleBody(stored: string, fresh: string): boolean {
  if (stored.trim() === '{}') return true
  return stored.includes(PLACEHOLDER) && !fresh.includes(PLACEHOLDER)
}
