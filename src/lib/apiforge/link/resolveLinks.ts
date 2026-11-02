/**
 * 关联表识别，PRD v0.3 模块 4.2 / 技术方案 §2.2（核心差异化）。
 *
 * 走法：接口方法 →（Controller 方法用到注入字段的类型）→ Service → Mapper 接口
 * →（namespace）→ MyBatis XML 语句 → 表名。Mapper 命中的标高可信默认启用。
 * 命名推断（UserController → user）只是兜底，标低可信**默认不启用** ——
 * 推断错了的表拿去快照，报告里出现的「数据变更」就是编的（落地约束 2）。
 *
 * 用户修正（勾选/取消/手动加表）按表名合并回新扫描结果：重扫不丢 enabled。
 */
import type {
  ApiMethod,
  ClassUse,
  LinkConfidence,
  MapperInfo,
  ProjectScanResult,
  TableRelation,
} from '../types'

const CONF_RANK: Record<LinkConfidence, number> = {
  user: 4,
  mapper: 3,
  jpa: 2,
  transactional: 1,
  naming: 0,
}

/** BFS 深度：Controller → Service → Mapper 正好两层，多留一层余量 */
const MAX_DEPTH = 3

/** Mapper 接口简名 → mapper 信息（namespace 的最后一段） */
function mapperIndex(project: ProjectScanResult): Map<string, MapperInfo> {
  const bySimple = new Map<string, MapperInfo>()
  for (const m of project.mappers) {
    const simple = m.namespace.split('.').pop() ?? m.namespace
    bySimple.set(simple, m)
    bySimple.set(m.namespace, m)
  }
  return bySimple
}

function classUseIndex(project: ProjectScanResult): Map<string, ClassUse[]> {
  const idx = new Map<string, ClassUse[]>()
  for (const cu of project.classUses) {
    // 扫描器的 usedFieldTypes 是简名（Service 字段类型不带包名），所以
    // 全名和简名都要能查到，否则 Controller → Service 这一步就断了
    for (const key of new Set([cu.className, cu.className.split('.').pop() ?? cu.className])) {
      const list = idx.get(key) ?? []
      list.push(cu)
      idx.set(key, list)
    }
  }
  return idx
}

/**
 * 从 Controller 方法出发沿字段类型走。返回命中的 mapper 表集合（不深入
 * 接口/抽象类 —— 没有语句可对齐）。
 */
function walkToMappers(
  api: ApiMethod,
  project: ProjectScanResult,
): Map<string, { source: string }> {
  const mappers = mapperIndex(project)
  const uses = classUseIndex(project)
  const tables = new Map<string, { source: string }>()
  const visited = new Set<string>()

  const visitType = (typeName: string, methodName: string, depth: number) => {
    if (depth > MAX_DEPTH || visited.has(`${typeName}#${methodName}`)) return
    visited.add(`${typeName}#${methodName}`)

    const mapper = mappers.get(typeName)
    if (mapper) {
      // 优先同名方法（Mapper 方法名通常跟 Service 方法名一致）；没有就整接口
      const stmts = mapper.statements.filter((s) => s.id === methodName)
      const pool = stmts.length ? stmts : mapper.statements
      for (const st of pool) {
        for (const t of st.tables) {
          if (!tables.has(t.toLowerCase())) {
            tables.set(t.toLowerCase(), { source: `${simpleNs(mapper.namespace)}.${st.id}` })
          }
        }
      }
      return // mapper 是叶子
    }
    const next = uses.get(typeName)
    if (!next) return
    const sameName = next.filter((u) => u.methodName === methodName)
    const pool = sameName.length ? sameName : next
    for (const u of pool) for (const t of u.usedFieldTypes) visitType(t, methodName, depth + 1)
  }

  const controllerKey = `${api.controllerClass}` // 扫描器 classUses 存的是全名，简名也兜一下
  const entry = uses.get(controllerKey) ?? uses.get([...uses.keys()].find((k) => k.endsWith(`.${api.controllerClass}`)) ?? '')
  if (entry) {
    const sameName = entry.filter((u) => u.methodName === api.methodName)
    const pool = sameName.length ? sameName : entry
    for (const u of pool) for (const t of u.usedFieldTypes) visitType(t, api.methodName, 1)
  }
  return tables
}

const simpleNs = (ns: string) => ns.split('.').pop() ?? ns

/**
 * 命名推断：UserController → user。剥 Controller 后缀再蛇形化，
 * 借用 sourceScan 的 entityNameToTable（后缀剥离 + camelToSnake 只此一份）。
 * 只给一个候选，且永远默认不启用。
 */
export function namingGuess(api: ApiMethod): TableRelation | null {
  const base = api.controllerClass.replace(/Controller$/i, '')
  if (!base) return null
  const table = camelToSnake(base)
  if (!table) return null
  return { tableName: table, confidence: 'naming', source: `${api.controllerClass} 命名推断`, enabled: false }
}

/** 出句同款 camelToSnake（sourceScan.ts 导出过，这里 re-export 会引入依赖方向问题，独立小实现） */
function camelToSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}

export function resolveLinks(
  api: ApiMethod,
  project: ProjectScanResult,
  withNaming: boolean,
): TableRelation[] {
  const out = new Map<string, TableRelation>()

  const hit = walkToMappers(api, project)
  for (const [key, meta] of hit) {
    out.set(key, {
      tableName: key,
      confidence: 'mapper',
      source: meta.source,
      enabled: true,
    })
  }

  if (withNaming && out.size === 0) {
    const guess = namingGuess(api)
    if (guess) out.set(guess.tableName, guess)
  }

  return [...out.values()].sort(
    (a, b) =>
      CONF_RANK[b.confidence] - CONF_RANK[a.confidence] || a.tableName.localeCompare(b.tableName),
  )
}

/**
 * 合并用户修正。规则（技术方案 §2.2）：
 * - 同表：新扫描给 confidence/source，enabled 用用户改过的那份；
 * - 用户手动加的表（confidence 'user'，新扫描里没有）保留；
 * - 低可信（naming）新命中且用户从未见过 → 默认不启用。
 */
export function mergeLinks(fresh: TableRelation[], previous: TableRelation[]): TableRelation[] {
  const prevByKey = new Map(previous.map((p) => [p.tableName.toLowerCase(), p]))
  const out: TableRelation[] = fresh.map((f) => {
    const old = prevByKey.get(f.tableName.toLowerCase())
    return old ? { ...f, enabled: old.enabled } : f
  })
  const freshKeys = new Set(fresh.map((f) => f.tableName.toLowerCase()))
  for (const old of previous) {
    if (!freshKeys.has(old.tableName.toLowerCase())) out.push(old)
  }
  return out.sort(
    (a, b) =>
      CONF_RANK[b.confidence] - CONF_RANK[a.confidence] || a.tableName.localeCompare(b.tableName),
  )
}

/** 实际参与快照的表（勾选的）。排序去重，给执行引擎直接用 */
export function enabledTables(links: TableRelation[]): string[] {
  const set = new Set(links.filter((l) => l.enabled).map((l) => l.tableName.toLowerCase()))
  return [...set]
}
