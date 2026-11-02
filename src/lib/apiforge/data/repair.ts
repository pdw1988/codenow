/**
 * 异常学习（2026-09-19）：接口自己最清楚它要什么前置数据。
 *
 * 背景：写接口引用的父数据（代理商新增要 brandId → 品牌商）多数项目在库里
 * **没有外键约束**、实体上也没有关系注解，造数的外键链（prepare.ts 只认
 * confidence === 'constraint'）看不见它。请求带着语义字典的假 id 发出去，
 * 接口的业务校验回一句「品牌商不存在」——这句话就是唯一的线索。
 *
 * 所以不猜：从响应文本里抽出「缺了什么」（实体名 / 坏值），认出对应哪张表，
 * 借一条真实 id（表空就造一行，跑完随 fixture 清理），回填重发一次。
 * 全程只动 id 形字段，记进数据日志；认不准就明说，绝不静默乱填。
 *
 * 本文件只放**纯函数**：报错解析、字段候选排序、实体→认表。借/造/重发的
 * IO 编排在 prepare.ts 的 FixtureSession.repairMissing 和 runner/runCase。
 */
import { isIdLikeName } from '../cases/generate'

/** 一条「缺数据」线索：entity 是抽出来的实体名（品牌商 / brand），raw 是原文片段 */
export interface MissingHint {
  entity?: string
  /** 报错原文片段（前后各放宽 30 字）。字段候选拿它对「当前值被点名」 */
  raw: string
}

/**
 * 中文黑名单：这些词出现在「不存在/无效」前面是泛指不是实体（「参数不合法」）。
 * 拿不准的宁可不学——认错表回填错值比不修更糟。
 */
const ZH_STOP = new Set([
  '参数', '字段', '数据', '请求', '操作', '记录', '内容', '信息', '验证码', '用户名',
  '密码', '账号', '结果', '文件', '格式', '状态', '权限', '网络', '系统', '服务',
  '配置', '对象', '值', '用户', '访问', '令牌', '凭证', '会话',
])

/** 英文同款：通用词不是实体（"user" 不进黑名单——它经常真是实体） */
const EN_STOP = new Set([
  'the', 'this', 'that', 'request', 'parameter', 'param', 'params', 'field', 'value',
  'please', 'it', 'error', 'resource', 'record', 'data', 'object', 'input', 'token',
  'session', 'credentials', 'header', 'body', 'response', 'server', 'client',
])

/** 「该/此/对应」这类修饰词剥掉再认表 */
const ZH_STRIP = /^(该|此|这个|那个|对应|相关|指定|所|的)+/

/* 中文：实体名（可选 [值]）+ 抱怨词。抱怨词表覆盖业务校验的常见说法 */
const ZH_MISSING: RegExp = new RegExp(
  '([\\u4e00-\\u9fa5A-Za-z][\\u4e00-\\u9fa5A-Za-z0-9_]{1,15})\\s*(?:\\[([^\\]]{1,64})\\])?' +
    '\\s*(?:不存在|不存在或已被删除|不存在或已失效|已失效|已删除|无效|不合法|不正确|有误|不能为空|为空|未找到|查不到)',
  'g',
)
/* 中文：请（先）选择/填写/输入 XX —— 必填校验的说法 */
const ZH_REQUIRED: RegExp = /请(?:先)?(?:选择|填写|输入|指定)([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_]{1,15})/g
/* 英文：brand does not exist / Brand[3] not found / invalid brand */
const EN_MISSING: RegExp =
  /([A-Za-z][A-Za-z0-9_]{1,30})\s*(?:\[([^\]]{1,64})\])?\s*(?:does\s+not\s+exist|not\s+exist|not\s+exists|not\s+found|is\s+invalid|was\s+not\s+found|is\s+required)/gi
const EN_INVALID: RegExp = /(?:invalid|unknown|missing)\s+([A-Za-z][A-Za-z0-9_]{1,30})/gi

/** 响应文本 → 缺数据线索（去重，最多 4 条）。没抽出来 = 空数组，调用方按「不归我管」跳过 */
export function missingHintsFromResponse(text: string): MissingHint[] {
  if (!text) return []
  const out: MissingHint[] = []
  const seen = new Set<string>()
  const push = (entity: string | undefined, start: number, end: number) => {
    const name = entity?.replace(ZH_STRIP, '')
    if (!name) return
    const stop = /[\u4e00-\u9fa5]/.test(name) ? ZH_STOP : EN_STOP
    if (stop.has(name.toLowerCase())) return
    const key = `${name}|${start}`
    if (seen.has(key)) return
    seen.add(key)
    // raw 放宽到匹配前后 30 字：把「[128]」这类被点名的值收进来给字段候选对账
    out.push({ entity: name, raw: text.slice(Math.max(0, start - 30), end + 30) })
  }
  for (const re of [ZH_MISSING, ZH_REQUIRED]) {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) push(m[1], m.index, m.index + m[0].length)
  }
  for (const re of [EN_MISSING, EN_INVALID]) {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) push(m[1], m.index, m.index + m[0].length)
  }
  return out.slice(0, 4)
}

/* ================= 字段候选：报错 → 该修请求里哪个字段 ================= */

export interface RefCandidate {
  field: string
  kind: 'param' | 'body'
  /** 字段名剥掉 id 后缀的词干（brandId → brand），认表的原料 */
  stem: string
  why: 'value' | 'desc' | 'idname'
}

/** 接口字段的最小形状（结构化类型，ApiMethod/DTO 不必依赖本模块） */
export interface RepairableApi {
  parameters: { name: string; position: string; description?: string }[]
  requestBodyFields: { name: string; javaType: string; description?: string }[]
}

/**
 * 字段名 → 词干：brandId/brand_id/userID → brand/user；裸 id 给空串（认不了表）。
 * 剥后缀跟 isIdLikeName 同一条边界纪律：必须有 camel 边界或下划线——`liquid`
 * 恰好以 id 收尾的英文词不剥（isIdLikeName 的同一口供）。
 */
export function stemOfFieldName(name: string): string {
  const m = /^(.+?)_id$/i.exec(name) ?? /^(.+[a-z])Id$/.exec(name) ?? /^(.+[a-z])ID$/.exec(name)
  return m ? m[1]!.toLowerCase() : ''
}

/**
 * 候选字段按可信度排序：
 * ① 当前值被报错点名（raw 里出现了这个字段的现值）——最硬的证据；
 * ② 字段说明里写着实体名（brandId 的说明是「品牌商ID」）；
 * ③ 兜底：全部 id 形字段交给认表（唯一命中才算数，见 pickRefTable）。
 */
export function refCandidates(
  api: RepairableApi,
  values: Record<string, unknown> | undefined,
  hint: MissingHint,
): RefCandidate[] {
  const out: RefCandidate[] = []
  const seen = new Set<string>()
  const push = (field: string, kind: 'param' | 'body', why: RefCandidate['why']) => {
    const key = `${kind}:${field}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ field, kind, stem: stemOfFieldName(field), why })
  }
  const params = api.parameters.filter(
    (p) => (p.position === 'path' || p.position === 'query') && isIdLikeName(p.name),
  )
  const bodies = api.requestBodyFields.filter((f) => isIdLikeName(f.name))
  // body 字段的现值在 __body 的 JSON 里（applyReadBackfill 同一约定），不在 values 顶层
  let body: Record<string, unknown> = {}
  if (typeof values?.__body === 'string') {
    try {
      const parsed: unknown = JSON.parse(values.__body)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch {
      body = {}
    }
  }
  for (const p of params) {
    const v = values?.[p.name]
    if (v !== undefined && v !== null && v !== '' && hint.raw.includes(String(v))) push(p.name, 'param', 'value')
  }
  for (const f of bodies) {
    const v = body[f.name]
    if (v !== undefined && v !== null && v !== '' && hint.raw.includes(String(v))) push(f.name, 'body', 'value')
  }
  if (hint.entity) {
    for (const p of params) {
      if (p.description?.includes(hint.entity)) push(p.name, 'param', 'desc')
    }
    for (const f of bodies) {
      if (f.description?.includes(hint.entity)) push(f.name, 'body', 'desc')
    }
  }
  for (const p of params) push(p.name, 'param', 'idname')
  for (const f of bodies) push(f.name, 'body', 'idname')
  return out
}

/* ================= 认表：实体/词干 → 哪张表 ================= */

export interface TableRef {
  name: string
  comment?: string
  /** 映射的 Java 类名（TableInfo.javaClass），brandId → Brand 这条路靠它 */
  javaClass?: string
}

/**
 * 实体/词干 → 表。信号强弱：表注释含中文实体名 > Java 类名相等 > 表名相等 >
 * 表名/类名包含词干。**唯一**最高分才认——并列就返回 undefined，让调用方
 * 明说「认不准」，不赌。词干 < 3 字符不参与表名匹配（id/ord 这种噪音太多）。
 */
export function pickRefTable(
  stem: string,
  entity: string | undefined,
  tables: TableRef[],
): { name: string; via: '表注释' | 'Java类' | '表名' } | undefined {
  const scored: { name: string; via: '表注释' | 'Java类' | '表名'; score: number }[] = []
  const add = (name: string, via: '表注释' | 'Java类' | '表名', score: number) => {
    if (!scored.some((x) => x.name === name && x.via === via)) scored.push({ name, via, score })
  }
  const s = stem.toLowerCase()
  for (const t of tables) {
    const nm = t.name.toLowerCase()
    const jc = (t.javaClass ?? '').toLowerCase()
    if (entity && t.comment && t.comment.includes(entity)) add(t.name, '表注释', 4)
    if (entity && jc && jc === entity.toLowerCase()) add(t.name, 'Java类', 4)
    if (entity && jc && jc.startsWith(entity.toLowerCase())) add(t.name, 'Java类', 3)
    if (s.length >= 3) {
      if (nm === s) add(t.name, '表名', 3)
      else if (nm.includes(s)) add(t.name, '表名', 2)
      else if (jc === s || jc.startsWith(s)) add(t.name, 'Java类', 2)
    }
  }
  if (!scored.length) return undefined
  const top = Math.max(...scored.map((x) => x.score))
  const best = scored.filter((x) => x.score === top)
  if (new Set(best.map((x) => x.name)).size !== 1) return undefined
  return { name: best[0]!.name, via: best[0]!.via }
}
