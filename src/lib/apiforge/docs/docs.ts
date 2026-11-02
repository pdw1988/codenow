/**
 * 接口文档自动生成，PRD v0.4 模块 4.7。
 *
 * 数据来源是已有的扫描结果（PRD：无需额外扫描）：工程 → Controller → 接口
 * 直接铺平成文档模型，关联表用 resolveLinks 现算 + 用户修正合并（与接口库页
 * openApi 同一套口径，勾选状态就是文档里的关联表清单）。
 *
 * 三个格式都是纯函数拼字符串，UI 下载即可（report.ts 同哲学）：
 * - Markdown：贴 Wiki/飞书/钉钉
 * - HTML：直接打开、可打印
 * - OpenAPI 3.0：导入 Postman/Apifox
 *
 * 诚实原则跟 buildBody 一致：扫描器解析不到的字段清单不编造 —— 请求体没字段
 * 就给 {}，返回值只标类型不给假字段。
 */
import type { ApiMethod, ProjectScanResult, RawParameter, TableRelation, WorkspaceScanResult } from '../types'
import { buildBody, bodyValueOf } from '../cases/generate'
import { dictOfScan } from '../scan/bodyFields'
import { prettyJson } from '../http/prettyJson'
import { mergeLinks, resolveLinks } from '../link/resolveLinks'

/** 单个接口的文档模型。渲染器只认它，不再碰扫描结构 */
export interface ApiDoc {
  id: string
  projectId: string
  projectName: string
  /** Controller 类简名 */
  controller: string
  methodName: string
  description: string
  httpMethod: ApiMethod['httpMethod']
  path: string
  parameters: RawParameter[]
  requestBodyType: string | null
  /** @RequestBody 的 DTO 字段清单（扫描器解析到的）。OpenAPI schema 用它，没有就不编 */
  bodyFields: { name: string; javaType: string; required: boolean; description?: string }[]
  /** 请求体 JSON 示例（自动生成）。无 @RequestBody 时为 null */
  bodyExample: string | null
  /** 返回类型声明（如 Result<UserVO>） */
  responseType: string
  /** 返回值示例：简单类型给样例值，复杂类型 null（不编字段） */
  responseExample: string | null
  /** 关联表（勾选启用的，含用户手动加的） */
  tables: TableRelation[]
}

/**
 * 单接口 → 文档模型。同步版与分帧版共用这一份塑形——bodyExample / tables 的
 * 口径必须一致，别在分帧版里把这段字面量再抄一遍，两份迟早只修好一份。
 */
function docOf(
  api: ApiMethod,
  project: ProjectScanResult,
  controller: ProjectScanResult['controllers'][number],
  typeDict: ReturnType<typeof dictOfScan>,
  userLinks: Record<string, TableRelation[]>,
): ApiDoc {
  const links = mergeLinks(resolveLinks(api, project, false), userLinks[api.id] ?? [])
  return {
    id: api.id,
    projectId: project.projectId,
    projectName: project.projectName,
    controller: controller.className,
    methodName: api.methodName,
    description: api.description,
    httpMethod: api.httpMethod,
    path: api.path,
    parameters: api.parameters,
    requestBodyType: api.requestBodyType,
    bodyFields: api.requestBodyFields,
    // 单行 JSON.stringify 贴进文档没人读；pretty 后进 ```json 块 / <pre>，
    // OpenAPI 那路 JSON.parse 照样过
    bodyExample: api.requestBodyType ? prettyJson(buildBody(api, {}, typeDict)) : null,
    responseType: api.responseType,
    responseExample: responseSampleOf(api.responseType),
    tables: links.filter((l) => l.enabled),
  }
}

/**
 * 由扫描结果铺平文档。userLinks 是 store 里持久化的用户修正
 * （勾选 / 手动加表），合并口径与接口库页完全一致：重扫不丢。
 */
export function assembleDocs(
  scan: WorkspaceScanResult,
  userLinks: Record<string, TableRelation[]>,
): ApiDoc[] {
  const typeDict = dictOfScan(scan)
  const docs: ApiDoc[] = []
  for (const project of scan.projects) {
    for (const controller of project.controllers) {
      for (const api of controller.methods) {
        docs.push(docOf(api, project, controller, typeDict, userLinks))
      }
    }
  }
  return docs
}

/** 让出主线程一帧：浏览器走 rAF（跟显示节拍对齐，setTimeout 有 4ms 钳制），
 *  node 测试环境没有 rAF，退回 setTimeout。 */
const nextFrame = (): Promise<void> =>
  typeof requestAnimationFrame === 'function'
    ? new Promise((resolve) => requestAnimationFrame(() => resolve()))
    : new Promise((resolve) => setTimeout(resolve, 0))

/**
 * assembleDocs 的分帧版：几千接口时 buildBody 造嵌套骨架是大头，整包同步跑
 * 主线程卡死一秒以上，点了导出按钮毫无反馈——四道闸门照不到这种「卡但不报错」
 * （用户原话「点了后一下子没反应，太突兀」）。按耗时切片：干满 ~12ms 让出一帧
 * 并汇报进度，小工程几乎不让帧、大工程贴着显示节拍走；按「固定个数控帧」会让
 * 小工程白等几百帧、大工程一帧干太久。结果与同步版逐字节一致。
 */
export async function assembleDocsChunked(
  scan: WorkspaceScanResult,
  userLinks: Record<string, TableRelation[]>,
  onProgress?: (done: number, total: number) => void,
): Promise<ApiDoc[]> {
  const typeDict = dictOfScan(scan)
  const total = scan.projects.reduce(
    (n, p) => n + p.controllers.reduce((m, c) => m + c.methods.length, 0),
    0,
  )
  const docs: ApiDoc[] = []
  let done = 0
  let sliceStart = performance.now()
  for (const project of scan.projects) {
    for (const controller of project.controllers) {
      for (const api of controller.methods) {
        docs.push(docOf(api, project, controller, typeDict, userLinks))
        done++
        if (performance.now() - sliceStart > 12) {
          onProgress?.(done, total)
          await nextFrame()
          sliceStart = performance.now()
        }
      }
    }
  }
  onProgress?.(done, total)
  return docs
}

/**
 * 返回值示例：扫描器只留返回类型名。标量类型按 bodyValueOf 给样例值；
 * 复杂类型（VO/DTO/包装类）解析不到字段清单，返回 null 只标类型 —— 不编字段。
 */
export function responseSampleOf(responseType: string): string | null {
  const t = responseType.trim()
  if (!t || t === 'void') return null
  const scalar =
    /^(string|integer|int|long|double|float|boolean|bigdecimal|biginteger|short|localdate|localdatetime|date|byte|char)$/i
  if (scalar.test(t) || t.endsWith('[]')) return JSON.stringify(bodyValueOf(t.replace(/\[\]$/, '')))
  return null
}

/* ================= Markdown ================= */

/** 表格单元里的竖线会断列，转义掉（描述文本是自由输入） */
const mdCell = (s: string) => s.replace(/\|/g, '\\|')

export function docsToMarkdown(docs: ApiDoc[]): string {
  const b: string[] = []
  b.push(`# 码上测 接口文档`)
  b.push('')
  b.push(`- 生成时间：${new Date().toISOString()}`)
  b.push(`- 接口数：${docs.length}（${new Set(docs.map((d) => d.projectName)).size} 个工程）`)
  b.push('')
  let lastProj = ''
  let lastCtrl = ''
  for (const d of docs) {
    if (d.projectName !== lastProj) {
      lastProj = d.projectName
      lastCtrl = ''
      b.push(`## ${d.projectName}`)
      b.push('')
    }
    if (d.controller !== lastCtrl) {
      lastCtrl = d.controller
      b.push(`### ${d.controller}`)
      b.push('')
    }
    b.push(`#### \`${d.httpMethod} ${d.path}\``)
    b.push('')
    if (d.description) {
      b.push(d.description)
      b.push('')
    }
    if (d.tables.length) {
      b.push(`- 关联表：${d.tables.map((t) => `${t.tableName}（${confidenceLabel(t.confidence)}）`).join('、')}`)
      b.push('')
    }
    if (d.parameters.length) {
      b.push(`| 参数 | 位置 | 类型 | 必填 | 说明 |`)
      b.push(`|---|---|---|---|---|`)
      for (const p of d.parameters) {
        const note = [p.description, p.defaultValue != null ? `默认 ${p.defaultValue}` : '']
          .filter(Boolean)
          .join(' · ')
        b.push(`| ${mdCell(p.name)} | ${p.position} | ${mdCell(p.javaType)} | ${p.required ? '是' : '否'} | ${mdCell(note) || '—'} |`)
      }
      b.push('')
    }
    if (d.bodyExample) {
      b.push(`请求体示例（${d.requestBodyType}）：`)
      b.push('')
      b.push('```json')
      b.push(d.bodyExample)
      b.push('```')
      b.push('')
    }
    if (d.responseType) {
      b.push(`- 返回类型：\`${d.responseType}\``)
      if (d.responseExample) b.push(`- 返回值示例：\`${d.responseExample}\``)
      b.push('')
    }
  }
  return b.join('\n')
}

const confidenceLabel = (c: TableRelation['confidence']): string =>
  c === 'mapper' ? 'MAPPER' : c === 'user' ? '手动' : c === 'jpa' ? 'JPA' : c === 'transactional' ? '事务' : '推断'

/* ================= HTML ================= */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function docsToHtml(docs: ApiDoc[]): string {
  const sections: string[] = []
  let lastProj = ''
  let lastCtrl = ''
  for (const d of docs) {
    if (d.projectName !== lastProj) {
      lastProj = d.projectName
      lastCtrl = ''
      sections.push(`<h2>${esc(d.projectName)}</h2>`)
    }
    if (d.controller !== lastCtrl) {
      lastCtrl = d.controller
      sections.push(`<h3>${esc(d.controller)}</h3>`)
    }
    const rows = d.parameters
      .map((p) => {
        const note = [p.description, p.defaultValue != null ? `默认 ${p.defaultValue}` : '']
          .filter(Boolean)
          .join(' · ')
        return `<tr><td>${esc(p.name)}</td><td>${p.position}</td><td>${esc(p.javaType)}</td><td>${p.required ? '是' : '否'}</td><td>${esc(note) || '—'}</td></tr>`
      })
      .join('\n')
    const tables = d.tables.length
      ? `<p class="tbls">关联表 ${d.tables
          .map(
            (t) =>
              `<span class="conf">${esc(t.tableName)} <i>${confidenceLabel(t.confidence)}</i></span>`,
          )
          .join(' ')}</p>`
      : ''
    const body = d.bodyExample
      ? `<div class="cap">请求体示例（${esc(d.requestBodyType ?? '')}）</div><pre class="code">${esc(d.bodyExample)}</pre>`
      : ''
    const resp = d.responseType
      ? `<p class="ret">返回类型 <code>${esc(d.responseType)}</code>${
          d.responseExample ? ` · 示例 <code>${esc(d.responseExample)}</code>` : ''
        }</p>`
      : ''
    sections.push(`<div class="api">
<h4><span class="verb ${d.httpMethod.toLowerCase()}">${d.httpMethod}</span><code>${esc(d.path)}</code></h4>
${d.description ? `<p class="desc">${esc(d.description)}</p>` : ''}
${tables}
${d.parameters.length ? `<table><tr><th>参数</th><th>位置</th><th>类型</th><th>必填</th><th>说明</th></tr>${rows}</table>` : ''}
${body}
${resp}
</div>`)
  }

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>码上测 接口文档</title>
<style>
body{font-family:system-ui,'Segoe UI',sans-serif;margin:24px auto;color:#1f2328;max-width:960px}
h1{font-size:20px}h2{font-size:17px;margin-top:28px;border-bottom:1px solid #d0d7de;padding-bottom:6px}
h3{font-size:15px;margin:20px 0 8px}.muted{color:#8b949e;font-size:12px}
.api{border:1px solid #d0d7de;border-radius:6px;padding:12px 14px;margin:10px 0;break-inside:avoid}
.api h4{margin:0 0 6px;font-size:14px;display:flex;align-items:center;gap:8px}
.api h4 code{font-size:13px}.desc{margin:4px 0;color:#57606a;font-size:13px}
.verb{font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;color:#fff}
.verb.get{background:#0969da}.verb.post{background:#1a7f37}.verb.put,.verb.patch{background:#9a6700}.verb.delete{background:#cf222e}
table{border-collapse:collapse;width:100%;font-size:12px;margin:8px 0}
th,td{border:1px solid #d0d7de;padding:4px 8px;text-align:left;vertical-align:top}
th{background:#f6f8fa}
.cap{font-size:12px;color:#8b949e;margin-top:8px}
pre.code{background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:8px 10px;font-size:12px;overflow:auto;margin:4px 0}
.ret{font-size:12px;color:#57606a;margin:6px 0 0}
.tbls{font-size:12px;margin:6px 0}.conf{display:inline-block;border:1px solid #d0d7de;border-radius:4px;padding:1px 6px;margin:0 6px 2px 0}
.conf i{font-style:normal;color:#8b949e;font-size:11px}
@media print{.api{break-inside:avoid}body{margin:0}}
</style></head><body>
<h1>码上测 接口文档</h1>
<p class="muted">生成于 ${esc(new Date().toISOString())} · ${docs.length} 接口 · ${new Set(docs.map((d) => d.projectName)).size} 个工程</p>
${sections.join('\n')}
</body></html>`
}

/* ================= OpenAPI 3.0 ================= */

export interface OpenApiOptions {
  /** servers 里的基地址（环境配置的 baseUrl） */
  baseUrl?: string
  title?: string
}

/** Java 类型 → OpenAPI schema。认得的给精确类型，不认得的一律 string（不编） */
export function oasSchemaOf(javaType: string): Record<string, unknown> {
  const t = javaType.toLowerCase().replace(/\[\]$/, '')
  if (t === 'integer' || t === 'int' || t === 'short') return { type: 'integer', format: 'int32' }
  if (t === 'long' || t === 'biginteger') return { type: 'integer', format: 'int64' }
  if (t === 'double' || t === 'float' || t === 'bigdecimal') return { type: 'number' }
  if (t === 'boolean') return { type: 'boolean' }
  if (t === 'localdate') return { type: 'string', format: 'date' }
  if (t === 'localdatetime' || t === 'date') return { type: 'string', format: 'date-time' }
  if (t === 'byte') return { type: 'string', format: 'byte' }
  if (javaType.endsWith('[]') || /^(list|set|collection)</i.test(javaType)) {
    // 泛型参数是简单类型就带上，否则 items 给空 schema（Apifox 能导入后再改）
    const inner = javaType.match(/^[\w.]*<(?:[\w.]+\.)?(.+)>$/)?.[1] ?? ''
    return { type: 'array', items: inner && !/[<>]/.test(inner) ? oasSchemaOf(inner) : {} }
  }
  return { type: 'string' }
}

/**
 * OpenAPI 3.0 文档：paths 按 Controller 打 tag，@RequestBody 字段进
 * requestBody schema，路径参数补齐声明（OpenAPI 要求 {x} 必须有对应 param）。
 * 登录态不在文档里 —— Token 是运行时注入的，文档只描述接口本身。
 */
export function docsToOpenApi(docs: ApiDoc[], opts: OpenApiOptions = {}): string {
  const paths: Record<string, Record<string, unknown>> = {}
  const opIdCount = new Map<string, number>()

  for (const d of docs) {
    const params: Record<string, unknown>[] = []
    for (const p of d.parameters) {
      if (p.position === 'body') continue // body 走 requestBody
      const where = p.position === 'unknown' ? 'query' : p.position
      params.push({
        name: p.name,
        in: where,
        required: where === 'path' ? true : p.required,
        description: p.position === 'unknown' ? `位置未知，请核对：${p.description ?? ''}`.trim() : (p.description ?? ''),
        schema: oasSchemaOf(p.javaType),
      })
    }
    // Spring 的 {id} 与 OpenAPI 模板同语法；扫描器没报的路径参数补上，保证 spec 合法
    for (const name of d.path.match(/\{([^}]+)\}/g) ?? []) {
      const key = name.slice(1, -1)
      if (!params.some((p) => p.name === key && p.in === 'path')) {
        params.push({ name: key, in: 'path', required: true, description: '', schema: { type: 'string' } })
      }
    }

    const operation: Record<string, unknown> = {
      tags: [d.controller],
      summary: d.description || d.methodName,
      operationId: (() => {
        const n = (opIdCount.get(d.methodName) ?? 0) + 1
        opIdCount.set(d.methodName, n)
        return n > 1 ? `${d.methodName}_${n}` : d.methodName
      })(),
      parameters: params,
      responses: {
        '200': {
          description: d.description || 'OK',
          ...(d.responseExample
            ? { content: { '*/*': { example: JSON.parse(d.responseExample) } } }
            : {}),
        },
      },
    }
    if (d.requestBodyType) {
      const fields = d.bodyFields
      const properties: Record<string, unknown> = {}
      for (const f of fields) properties[f.name] = oasSchemaOf(f.javaType)
      operation.requestBody = {
        required: fields.some((f) => f.required) || undefined,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              ...(fields.length
                ? { properties, required: fields.filter((f) => f.required).map((f) => f.name) }
                : {}),
            },
            example: d.bodyExample ? JSON.parse(d.bodyExample) : undefined,
          },
        },
      }
    }

    const pathItem = (paths[d.path] ??= {})
    pathItem[d.httpMethod.toLowerCase()] = operation
  }

  return JSON.stringify(
    {
      openapi: '3.0.3',
      info: {
        title: opts.title ?? '码上测 接口文档',
        description: '由码上 CodeNow 从 Spring Boot 源码扫描自动生成',
        version: new Date().toISOString().slice(0, 10),
      },
      servers: opts.baseUrl ? [{ url: opts.baseUrl }] : [],
      paths,
    },
    null,
    2,
  )
}
