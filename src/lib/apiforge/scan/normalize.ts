/**
 * 扫描器 stdout JSON → 领域类型，技术方案 §2.1。
 *
 * 扫描器是独立 Java 进程，输出什么 TS 管不着：字段缺失、类型不对都要防，
 * 坏数据跳过那一条而不是整次扫描报废 —— 单文件失败已经在 Java 侧进 errors[]，
 * 这里是第二道防线。判定标准照 PRD 落地约束：HTTP 方法不认识的不收，
 * 路径拼不出完整 URL 的不收。
 */
import type {
  ApiMethod,
  BizThrowDetail,
  BizThrowInfo,
  ClassUse,
  ControllerInfo,
  DtoField,
  EntityFieldInfo,
  EntityInfo,
  MapperInfo,
  MapperStatement,
  PageInfo,
  PageProfile,
  ProjectScanResult,
  RawParameter,
  ScannedType,
  VueProjectMeta,
  WorkspaceScanResult,
  WriteDraft,
} from '../types'
import { normAuthor, normDocDate } from '../docmeta'
import { pageHooks, type FrameFtl } from './pageHooks'
import { PAGE_LOGIC_VERSION } from '../page/pageLogic'
import { fillBodyFields } from './bodyFields'

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])

export const SCAN_JAR_ARGS_HINT = 'java -jar spring-scanner.jar --root <path>'

/** FNV-1a：给扫描结果算指纹（文件清单变化 → 指纹变化 → 缓存失效） */
export function fingerprintOf(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '')
const asBool = (v: unknown, dflt: boolean): boolean =>
  typeof v === 'boolean' ? v : dflt
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const asRec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

function normalizeDtoField(raw: unknown): DtoField | null {
  const r = asRec(raw)
  const name = asStr(r.name)
  if (!name) return null
  const description = asStr(r.description) || undefined
  return {
    name,
    javaType: asStr(r.javaType) || 'String',
    required: asBool(r.required, true),
    ...(description ? { description } : {}),
  }
}

function normalizeScannedType(raw: unknown): ScannedType | null {
  const r = asRec(raw)
  const name = asStr(r.name)
  if (!name) return null
  const fields = asArr(r.fields)
    .map(normalizeDtoField)
    .filter((f): f is DtoField => f !== null)
  if (fields.length === 0) return null
  return { name, fields }
}

/** 实体（PRD v0.6 模块 4.15）。老扫描器 / 旧缓存没有 entities 键，上层当空数组 */
function normalizeEntity(raw: unknown): EntityInfo | null {
  const r = asRec(raw)
  const className = asStr(r.className)
  const table = asStr(r.table)
  if (!className || !table) return null
  const fields = asArr(r.fields)
    .map((f): EntityFieldInfo | null => {
      const fr = asRec(f)
      const name = asStr(fr.name)
      const column = asStr(fr.column)
      const javaType = asStr(fr.javaType)
      if (!name || !column || !javaType) return null
      return { name, column, javaType, pk: fr.pk === true }
    })
    .filter((f): f is EntityFieldInfo => f !== null)
  return { className, table, fields }
}

function normalizeParam(raw: unknown): RawParameter | null {
  const r = asRec(raw)
  const name = asStr(r.name)
  if (!name) return null
  const pos = asStr(r.position)
  return {
    name,
    javaType: asStr(r.javaType) || 'String',
    position:
      pos === 'query' || pos === 'path' || pos === 'body' || pos === 'header' ? pos : 'unknown',
    required: asBool(r.required, true),
    defaultValue: asStr(r.defaultValue) || undefined,
    description: asStr(r.description) || undefined,
  }
}

/** 类级 + 方法级路径拼接。两边都以 / 开头、合并处不重复斜杠 */
export function joinPath(base: string, methodPath: string): string {
  const b = base.startsWith('/') ? base : `/${base}`
  const m = methodPath.startsWith('/') ? methodPath : `/${methodPath}`
  const joined = (b === '/' ? '' : b) + (m === '/' ? '' : m)
  return joined.replace(/\/+$/, '') || '/'
}

let methodSeq = 0

function normalizeMethod(raw: unknown, filePath: string, projectId: string): ApiMethod | null {
  const r = asRec(raw)
  const httpMethod = asStr(r.httpMethod).toUpperCase()
  if (!HTTP_METHODS.has(httpMethod)) return null
  const methodName = asStr(r.methodName)
  if (!methodName) return null

  // body 两种形状都通吃（跟下面 path 同一个道理）：原始扫描器把 body 包在
  // requestBody: {type, fields} 里；缓存 blob / 扫描存档是已归一形状，平铺在
  // 顶层（requestBodyType / requestBodyFields）。只认包裹形状的话，开机载缓存
  // 会把全工作区的 body 类型与字段剥成 null——试跑 BODY 只剩 {}，连
  // fillBodyFields 的兜底都因为拿不到类型名一起失灵（saveApply 实测）。
  const bodyRec = asRec(r.requestBody)
  const requestBodyType = asStr(bodyRec.type) || asStr(r.requestBodyType) || null
  const requestBodyFields = (bodyRec.type ? asArr(bodyRec.fields) : asArr(r.requestBodyFields))
    .map(normalizeDtoField)
    .filter((f): f is DtoField => f !== null)

  // 重载方法（同文件同名）靠序号区分 id；seq 在文件级重置
  methodSeq += 1
  const id = `${filePath}#${methodName}#${methodSeq}`

  return {
    id,
    methodName,
    httpMethod: httpMethod as ApiMethod['httpMethod'],
    // 已归一化的 JSON（缓存 blob / 扫描存档）只有拼好的 path；原始扫描器给
    // classBasePath + methodPath 两段。两条路都通吃，否则缓存二次归一化路径退化成 /
    path: asStr(r.path) || joinPath(asStr(r.classBasePath), asStr(r.methodPath)),
    parameters: asArr(r.parameters)
      .map(normalizeParam)
      .filter((p): p is RawParameter => p !== null),
    requestBodyType,
    requestBodyFields,
    responseType: asStr(r.responseType),
    description: asStr(r.description),
    controllerClass: asStr(r.controllerClass),
    filePath,
    projectId,
  }
}

function normalizeController(raw: unknown, projectId: string): ControllerInfo | null {
  const r = asRec(raw)
  const filePath = asStr(r.filePath)
  if (!filePath) return null
  methodSeq = 0
  const methods = asArr(r.methods)
    .map((m) => normalizeMethod(m, filePath, projectId))
    .filter((m): m is ApiMethod => m !== null)
  const className = asStr(r.className)
  if (!className && methods.length === 0) return null
  return {
    className,
    packageName: asStr(r.packageName),
    basePath: asStr(r.basePath),
    filePath,
    description: asStr(r.description),
    // 旧缓存的扫描结果没这两个字段，asStr(undefined) 给空串，UI 显 `—`；
    // 重扫一次就有了。归一在这里做，扫描器只负责原样吐
    author: normAuthor(asStr(r.author)),
    date: normDocDate(asStr(r.date)),
    methods,
  }
}

const OPS = new Set(['insert', 'update', 'delete', 'select'])

function normalizeMapper(raw: unknown): MapperInfo | null {
  const r = asRec(raw)
  const namespace = asStr(r.namespace)
  const filePath = asStr(r.filePath)
  if (!namespace || !filePath) return null
  const statements = asArr(r.statements)
    .map((s): MapperStatement | null => {
      const sr = asRec(s)
      const op = asStr(sr.op)
      if (!OPS.has(op)) return null
      const tables = asArr(sr.tables)
        .map((t) => asStr(t).trim())
        .filter(Boolean)
      if (tables.length === 0) return null
      return { id: asStr(sr.id), op: op as MapperStatement['op'], tables }
    })
    .filter((s): s is MapperStatement => s !== null)
  return { namespace, filePath, statements }
}

function normalizeClassUse(raw: unknown): ClassUse | null {
  const r = asRec(raw)
  const className = asStr(r.className)
  if (!className) return null
  return {
    className,
    methodName: asStr(r.methodName),
    usedFieldTypes: asArr(r.usedFieldTypes).map(asStr).filter(Boolean),
  }
}

function normalizeBizThrowDetail(raw: unknown): BizThrowDetail | null {
  const r = asRec(raw)
  const type = asStr(r.type)
  if (!type) return null
  return {
    type,
    message: asStr(r.message),
    fields: asArr(r.fields).map(asStr).filter(Boolean),
  }
}

function normalizeBizThrowInfo(raw: unknown): BizThrowInfo | null {
  const r = asRec(raw)
  const className = asStr(r.className)
  if (!className) return null
  return {
    className,
    methodName: asStr(r.methodName),
    throws: asArr(r.throws)
      .map(normalizeBizThrowDetail)
      .filter((t): t is BizThrowDetail => t !== null),
  }
}

/**
 * 页面（页面测试用）。扫描器带的是 ftl 原文，在这里算成画像后丢掉原文——
 * 几百个模板的原文进缓存会把存档撑大；缓存里已经是画像的原样保留（幂等）。
 */
function normalizePage(raw: unknown, projectId: string, frameOf?: (from: string, url: string) => ReturnType<FrameFtl>): PageInfo | null {
  const r = asRec(raw)
  const viewName = asStr(r.viewName)
  const path = asStr(r.path) || joinPath(asStr(r.classBasePath), asStr(r.methodPath))
  if (!viewName) return null
  const ftlText = asStr(r.ftlText)
  const cached = asRec(r.profile)
  // 开源版没挂页面测试钩子：有原文也不出画像和草稿
  const hooks = pageHooks()
  const profile: PageProfile | null = ftlText
    ? (hooks?.profileFtl(ftlText) ?? null)
    : cached.kind === 'list' || cached.kind === 'plain'
      ? (cached as unknown as PageProfile)
      : null
  // 写操作草稿和画像同一时机算：原文不进缓存，缓存里已经是草稿的原样保留
  const cachedDraft = asRec(r.writeDraft)
  const writeDraft: WriteDraft | null = ftlText
    ? (hooks?.draftWrite(ftlText, profile, frameOf && ((u) => frameOf(path, u))) ?? null)
    : typeof cachedDraft.fingerprint === 'string'
      ? (cachedDraft as unknown as WriteDraft)
      : null
  return {
    id: `${projectId}#${path}`,
    projectId,
    controllerClass: asStr(r.controllerClass),
    methodName: asStr(r.methodName),
    path,
    viewName,
    ftlFile: asStr(r.ftlFile),
    needsParams: r.needsParams === true,
    profile,
    writeDraft,
    // Vue 页面；老缓存和 ftl 页面不带这个键
    ...(r.source === 'vue' ? { source: 'vue' as const } : {}),
  }
}

function normalizeVueMeta(raw: unknown): VueProjectMeta {
  const r = asRec(raw)
  return { defaultUser: asStr(r.defaultUser), ...(r.uni === true ? { uni: true } : {}) }
}

function normalizeProject(raw: unknown): ProjectScanResult | null {
  const r = asRec(raw)
  const projectPath = asStr(r.projectPath)
  if (!projectPath) return null
  const projectId = asStr(r.projectId) || projectPath
  // iframe 弹窗的表单在另一个页面的 ftl 里：原文只在这次归一里有，边归一边查
  const rawPages = asArr(r.pages)
  const texts = rawPages.flatMap((p) => {
    const pr = asRec(p)
    const text = asStr(pr.ftlText)
    return text ? [{ path: asStr(pr.path) || joinPath(asStr(pr.classBasePath), asStr(pr.methodPath)), text }] : []
  })
  const hooks = pageHooks()
  const frameOf = (from: string, url: string) => {
    if (!hooks) return null
    const abs = hooks.resolveLinkUrl(from, url)
    const hit = texts.find((t) => hooks.linkHitsPage(abs, t.path))
    return hit ? { url: abs, text: hit.text } : null
  }
  return {
    projectId,
    projectPath,
    projectName: asStr(r.projectName) || projectPath.split(/[\\/]/).pop() || projectPath,
    controllers: asArr(r.controllers)
      .map((c) => normalizeController(c, projectId))
      .filter((c): c is ControllerInfo => c !== null)
      // 扫描器 JSON 里的顺序是 HashMap 桶序，看着是乱的。入库就按类名排定，
      // 接口库树 / 文档导出 / 跑批从此同一个顺序；重名类再用包名兜底
      .sort(
        (a, b) =>
          a.className.localeCompare(b.className) || a.packageName.localeCompare(b.packageName),
      ),
    mappers: asArr(r.mappers).map(normalizeMapper).filter((m): m is MapperInfo => m !== null),
    classUses: asArr(r.classUses).map(normalizeClassUse).filter((c): c is ClassUse => c !== null),
    bizThrows: asArr(r.bizThrows)
      .map(normalizeBizThrowInfo)
      .filter((t): t is BizThrowInfo => t !== null),
    types: asArr(r.types).map(normalizeScannedType).filter((t): t is ScannedType => t !== null),
    entities: asArr(r.entities).map(normalizeEntity).filter((t): t is EntityInfo => t !== null),
    pages: rawPages
      .map((p) => normalizePage(p, projectId, frameOf))
      .filter((p): p is PageInfo => p !== null)
      .sort((a, b) => a.path.localeCompare(b.path)),
    // 有原文 = 这次刚扫，按当前算法算的；缓存再归一保留存的版本
    ...(texts.length ? { pageLogic: PAGE_LOGIC_VERSION } : typeof r.pageLogic === 'number' ? { pageLogic: r.pageLogic } : {}),
    ...(r.vue && typeof r.vue === 'object' ? { vue: normalizeVueMeta(r.vue) } : {}),
    errors: asArr(r.errors)
      .map((e) => {
        const er = asRec(e)
        return { file: asStr(er.file), message: asStr(er.message) }
      })
      .filter((e) => e.file),
  }
}

/**
 * 扫描器 JSON 文本 → WorkspaceScanResult。整份 JSON 坏掉返回 null（调用方
 * 当成扫描失败给中文报错）；单工程/单文件坏只丢那一条。
 */
export function normalizeScanJson(text: string): WorkspaceScanResult | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const root = asRec(parsed)
  const rootPath = asStr(root.root)
  if (!rootPath) return null
  const ws: WorkspaceScanResult = {
    root: rootPath,
    scannedAt: asStr(root.scannedAt) || new Date().toISOString(),
    fingerprint: asStr(root.fingerprint),
    projects: asArr(root.projects).map(normalizeProject).filter((p): p is ProjectScanResult => p !== null),
    errors: asArr(root.errors)
      .map((e) => {
        const er = asRec(e)
        return { file: asStr(er.file), message: asStr(er.message) }
      })
      .filter((e) => e.file),
  }
  // 最后这一遍要等所有工程都归一完：补 body 字段靠的是跨工程的 DTO 字典（见 bodyFields.ts）。
  // 对已经归一化过的 JSON（缓存 blob / 扫描存档）再跑一遍是幂等的：只补空的。
  const filled = fillBodyFields(ws)
  // 纯 DTO/jar 模块（ruoyi-api 这类只有依赖类没有 Controller 的）没有可跑的
  // 接口，整棵树挂着只是空壳——不展示。**必须放在补字段之后**：这些模块的 types
  // 正是跨工程 DTO 字典的主要来源，先滤会把别的工程的 body 字段一起带走。
  // Vue 前端工程没有接口，只有页面，照样保留。
  return {
    ...filled,
    projects: filled.projects.filter((p) => p.controllers.some((c) => c.methods.length > 0) || !!p.vue),
  }
}

/** 全部工程的接口平铺（接口树第二层往后用） */
export function allApiMethods(ws: WorkspaceScanResult): ApiMethod[] {
  const out: ApiMethod[] = []
  for (const p of ws.projects) for (const c of p.controllers) out.push(...c.methods)
  return out
}
