/**
 * HTTP 请求构造与 Token 抽取，技术方案 §2.5/2.7。
 *
 * 纯函数：请求长什么样全部在这里算出来，fetch 只负责发。
 * 这样超时、路径替换、query 拼接、JSON body 的坑都能用 node:test 钉死，
 * 不用真起一个服务才能测。
 */
import type { ApiMethod, EnvironmentConfig, RawParameter, TestCase } from '../types'
import { JSONPath } from 'jsonpath-plus'
import { tauriInvoke } from '../../tauriInvoke'
// 值字典只有 sqlgen/mockValue.ts 一份（CLAUDE.md：同一条规则两份、只修好一份的坑）
import { mockValueOfField, usesFieldDictionary } from '../../sqlgen/mockValue'

function inTauriShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export interface BuiltRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
}

/** 数字/布尔/日期类型名集合，给 query/path 参数挑「不带引号」的默认值 */
const NUMERIC_TYPES = /^(int|integer|long|short|double|float|bigdecimal|number)$/i
const BOOL_TYPES = /^(boolean|bool)$/i

/**
 * 参数造默认值（PRD 模块 4.4：按 Java 类型给合理值）。
 * 独立成函数：用例生成（cases）和试跑填充（UI）都要用，不能各写一套。
 *
 * 字符串走语义字典（mockValueOfField）：一律给 `test_demo` 过不了
 * `@Pattern(手机号)` / 邮箱 / 订单号这类校验，那条「正常用例」必然 400，
 * 用户读成「接口挂了」——这是假失败，不是接口的问题。
 * 数字 / 布尔 / 日期**刻意不换**：1 / true / 2026-01-01 本身就是合法参数，
 * 换成字典里的值是另一类 400（Boolean 只认 true/false，不认 1/0）。
 */
export function defaultParamValue(p: {
  name: string
  javaType: string
  position: string
  description?: string
}): string {
  const t = p.javaType.trim().toLowerCase()
  if (NUMERIC_TYPES.test(t)) return '1'
  if (BOOL_TYPES.test(t)) return 'true'
  if (t === 'localdatetime' || t === 'date') return '2026-01-01 00:00:00'
  if (t === 'localdate') return '2026-01-01'
  if (t === 'localtime') return '00:00:00'
  if (usesFieldDictionary(p.javaType)) {
    return mockValueOfField({ name: p.name, javaType: p.javaType, description: p.description })
  }
  if (p.position === 'path') return '1'
  // 既不是标量也不是字符串（MultipartFile / 认不出的类型）：没有任何语义可依据，
  // 给一个一眼看出是假的占位，不编一个像真的业务值
  return 'test_demo'
}

/**
 * 拼完整 URL：baseUrl + api.path，{placeholder} 用参数值替换，
 * 其余 query 参数挂到 ? 后面。body 参数不参与 URL。
 *
 * 返回 null = path 参数没给全（异常用例故意缺参数时会这样），
 * 调用方跳过该用例并记日志，不要把一半路径发出去。
 */
export function buildUrl(
  baseUrl: string,
  path: string,
  params: RawParameter[],
  values: Record<string, unknown>,
): string | null {
  let tail = path
  const query: string[] = []
  for (const p of params) {
    const v = values[p.name]
    if (p.position === 'path') {
      if (v === undefined || v === null || v === '') return null
      tail = tail.replace(new RegExp(`\\{${p.name}}`, 'g'), encodeURIComponent(String(v)))
    } else if (p.position === 'query') {
      if (v === undefined || v === null || v === '') continue
      query.push(`${encodeURIComponent(p.name)}=${encodeURIComponent(String(v))}`)
    }
  }
  // path 里没被任何参数认领的 {xxx} 占位符也算没给全
  if (/\{[^}]+\}/.test(tail)) return null
  const base = baseUrl.replace(/\/+$/, '')
  const qs = query.length ? `?${query.join('&')}` : ''
  return `${base}${tail}${qs}`
}

/**
 * 解析某工程最终用的服务根地址：工程覆盖优先，空/未配回退全局 baseUrl。
 * 试跑 / 回归 / 压测 / 详情展示必须同一份，别各写一套。
 */
export function resolveBaseUrl(env: EnvironmentConfig, projectId: string): string {
  const over = (env.projectBaseUrls?.[projectId] ?? '').trim()
  return over || env.baseUrl
}

/**
 * 这个接口声明了 `@RequestBody` 吗。
 *
 * 两路都算：扫描器给的 `requestBodyType`，或参数表里的 `position: 'body'`。
 * 只看一路会漏：有些接口的 DTO 在另一个 jar 里（如 ruoyi-biz-app-api），
 * 字段表扫不出来，两个字段能对上的就不一定是同一个。
 */
function declaresBody(api: ApiMethod): boolean {
  return api.requestBodyType !== null || api.parameters.some((p) => p.position === 'body')
}

/**
 * 集合 body（`List<UserReq>` 这种）：JSON 契约是**数组**，字段表是元素类型的。
 * 造值（cases/generate）和兜底（buildRequest）两处都按这个分流，判定只此一份。
 * 扫描器旧数据只有剥掉泛型的 `List`，没有 `<` 就当对象 body 处理。
 */
export function isCollectionBodyType(t: string | null): boolean {
  return (
    t !== null &&
    /^(List|Set|Collection|Iterable|ArrayList|LinkedList|HashSet|LinkedHashSet|Queue|Deque|Stack|Vector)</.test(t)
  )
}

/**
 * 用例 → 请求。body 用例的 parameters.__body 放整个 JSON 串（生成器写入时
 * 已 JSON.stringify 过）。
 *
 * **声明了 @RequestBody 却没给 __body 时补一个 `{}`**，不能空手发。否则
 * Spring 这边 `RequestResponseBodyMethodProcessor` 直接抛，SHOP 的全局异常处理
 * 又把它翻成 **500** + 一大坨堆栈（实测 `/api/shop/productCategory/list`：不带 body
 * 是 500、带 `{}` 是 200）——报出来像接口坏了，实际上是我们没发。
 * 又一条路径：缓存里的老用例是扫描器还没认出 body 时生成的，存着的用例优先级
 * 高于现场生成，不在这里兼容就得让用户手动重建用例。
 * `{}` 不是造假数据：字段该不该必填让服务端校验自己说（同 buildBody 的哲学）。
 *
 * 没声明 body 的接口仍然不带：给 `@RequestParam` 或上传接口硬塞一堆 JSON 反而能把
 * 本来能跑的接口弄坏（form-urlencoded / multipart 会因 Content-Type 直接 415）。
 *
 * **GET 不带 body 这条只挡「没声明 body」的接口**。声明了 @RequestBody 还按动词丢 body，
 * 是拿扫描器的试探当事实：`@RequestMapping` 不写 method 时扫描器按 GET 试探（Spring 的
 * 语义其实是响应所有动词，见 JavaSourceParser 末尾的复核），而带 @RequestBody 的方法
 * 实际是 POST 带 JSON。丢掉之后 Spring 抛 `Required request body is missing`、全局异常
 * 翻成 500——现象是「接口 500」而不是「我们没发 body」，排查方向整个被带偏。
 * 实测 SHOP `/api/shop/payorderpush/orderPush`（biz-order-service 那份
 * `@RequestMapping(value = "/orderPush")` 没写 method，同名 mobile 那份是 @PostMapping）。
 * 老 workspace 缓存里存的动词还是 GET，不在这里兼容就得让用户重扫一遍工程。
 *
 * expectedHttpStatus 为空数组视作「不校验状态码」——只在调试时出现。
 */
export function buildRequest(
  env: EnvironmentConfig,
  api: ApiMethod,
  testCase: TestCase,
  token: string | null,
): BuiltRequest | null {
  const url = buildUrl(resolveBaseUrl(env, api.projectId), api.path, api.parameters, testCase.parameters)
  if (!url) return null

  const headers: Record<string, string> = {}
  const bodyValue = testCase.parameters.__body
  const given = typeof bodyValue === 'string' && bodyValue !== '' ? bodyValue : null
  const needsBody = declaresBody(api)
  // GET 不带 body 只挡「没声明 body」的接口（规矩与理由见上面 doc）
  let body: string | null = null
  if (needsBody) {
    body = given ?? (isCollectionBodyType(api.requestBodyType) ? '[]' : '{}')
  } else if (api.httpMethod !== 'GET') {
    body = given
  }
  if (body !== null) {
    headers['Content-Type'] = 'application/json'
  }
  if (token) {
    const prefix = env.tokenPrefix ? `${env.tokenPrefix} ` : ''
    headers[env.tokenHeader || 'Authorization'] = `${prefix}${token}`
  }
  return { url, method: api.httpMethod, headers, body }
}

/**
 * 登录响应 → Token。tokenJsonPath 显式配置优先（jsonpath-plus），
 * 没配按常见嵌套依次试：$.data.token / $.token / $.accessToken / $.data.accessToken。
 * 找不到返回 null —— 登录成功但抽不到 token 是配置问题，UI 要提示改 tokenJsonPath，
 * 不能静默拿空 token 打一堆 401。
 */
export function extractToken(responseJson: string, tokenJsonPath?: string): string | null {
  const parse = (): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(responseJson)
      return v && typeof v === 'object' && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  const root = parse()
  if (!root) return null

  if (tokenJsonPath && tokenJsonPath.trim()) {
    try {
      const hits = JSONPath({ path: tokenJsonPath.trim(), json: root }) as unknown[]
      const first = Array.isArray(hits) ? hits[0] : hits
      return typeof first === 'string' && first ? first : null
    } catch {
      return null
    }
  }

  const candidates = ['token', 'accessToken', 'access_token']
  for (const wrap of ['data', 'result', '']) {
    const container: unknown = wrap === '' ? root : root[wrap]
    if (!container || typeof container !== 'object' || Array.isArray(container)) continue
    const rec = container as Record<string, unknown>
    for (const key of candidates) {
      const v = rec[key]
      if (typeof v === 'string' && v) return v
    }
  }
  return null
}

/** fetch / 桌面 IPC 一发。超时用 AbortController（浏览器）或 reqwest timeout（桌面）。
 * 桌面必须走 Rust：WebView fetch 打内网服务常被 CORS 拦成 TypeError: Failed to fetch，
 * 跟接口/ token 无关；压测已经在用 reqwest，回归不能两套命运。 */
export async function sendRequest(req: BuiltRequest, timeoutMs: number): Promise<{
  status: number | null
  bodyText: string
}> {
  if (inTauriShell()) {
    try {
      const out = await tauriInvoke<{ status: number | null; bodyText: string }>('apiforge_http', {
        req: {
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: req.body,
        },
        timeoutMs: Math.max(1000, timeoutMs),
      })
      return { status: out.status ?? null, bodyText: out.bodyText ?? '' }
    } catch (e) {
      throw new Error(String(e).replace(/^Error:\s*/, ''))
    }
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs))
  try {
    const resp = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: ctrl.signal,
    })
    const bodyText = await resp.text()
    return { status: resp.status, bodyText: bodyText.slice(0, 2_000_000) }
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    if (aborted) throw new Error(`请求超时（${timeoutMs}ms）`)
    const msg = String(e)
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
      throw new Error(
        '请求失败：浏览器跨域被拦（CORS）。请用桌面版（pnpm tauri:dev）发请求，或让目标服务放行当前源。',
      )
    }
    throw new Error(`请求失败：${msg}`)
  } finally {
    clearTimeout(timer)
  }
}
