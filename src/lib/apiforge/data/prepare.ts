/**
 * 库前置数据（造数）与逆序清理 —— PRD 4.4「测试数据自动生成」在回归管线里的落地。
 *
 * 为什么需要：带路径参数的接口（`PUT /apply/{id}`、`DELETE /user/{id}`）在空库或
 * 数据对不上的库里必然查不到行，回归跑出来一片假红，用户以为是接口坏了。
 * 先造一行让这条请求有的放矢，跑完再把它删掉。
 *
 * 三条硬约束，错了比不做还糟：
 *
 *   1. **清理必须发生在所有快照之后**（`runner/regression.ts` 的收尾点）。放在前面
 *      的话，我们删自己造的行会被 diff 记成「接口删了数据」，报告全是噪音。
 *   2. **只删自己造的行**。做法是插入时记下定位列的值；自增主键的值由库给，
 *      插完用只读 query 回查一次。定位不到就老实写「未自动清理」，绝不按范围删。
 *   3. **外键顺序只认 `confidence === 'constraint'`**（项目铁律：命名推断不许悄悄
 *      参与）。没有 FK 元数据就不假装有拓扑序，按原序造、原序逆着清。
 *
 * 默认开（`EnvironmentConfig.autoPrepare`，2026-09-19 拍板：连库的目的就是数据验证，
 * 不该再让人找开关）；写库风险由跑批前的一次总确认兜住。
 */
import type { ApiMethod, TableRelation } from '../types'
import type { Column, ForeignKey } from '../../../types/schema'
import { parsePreservingBig, stringifyPreservingBig } from '../../bigIntJson'
import type { QueryGrid } from '../../sqlReadonly'
import { applyPage, DIALECTS, type GenDialect } from '../../sqlgen/dialect'
import { planColumns, renderValue, toSnake, uniqueize, type ValueMap } from '../../sqlgen/mockValue'
import { defaultParamValue } from '../http/request'
import { isIdLikeName } from '../cases/generate'
import { missingHintsFromResponse, pickRefTable, refCandidates, type TableRef } from './repair'

/* ================= 纯函数：造数计划 ================= */

export interface FixturePlan {
  table: string
  /** 可执行单行 INSERT；null = 没有可插入的列（全是自增列之类） */
  insertSql: string | null
  /** 真插进去的每一列的**显示值**（列名 → 值）。清理定位与报告都要用 */
  values: ValueMap
  /** 定位列（主键）。空 = 无主键，插了也找不回来 */
  pkCols: string[]
  /** 主键是自增的：值由库给，要回查才知道 */
  autoPk: boolean
  /** 自增主键的只读回查 SQL；null = 不需要（非自增，或已被点名显式插了值） */
  pkQuerySql: string | null
  note?: string
}

/**
 * 自增主键的回查：写动词全局串行（`runner/regression.ts` 的并发红线）、
 * 且每次只往一张表插一行，所以「最大的那个主键」就是刚插的那行。
 */
export function pkQueryOf(table: string, pkCol: string, dialect: GenDialect): string {
  const spec = DIALECTS[dialect]
  const col = spec.quote(pkCol)
  return applyPage(dialect, `SELECT ${col} FROM ${spec.quote(table)} ORDER BY ${col} DESC`, {
    offset: 0,
    limit: 1,
  })
}

/** 按主键定位的删除。pkLiterals 必须是**SQL 字面量**（字符串要带引号） */
export function cleanupSqlOf(
  table: string,
  pkCols: string[],
  pkLiterals: string[],
  dialect: GenDialect,
): string | null {
  if (!pkCols.length || pkLiterals.length !== pkCols.length) return null
  const spec = DIALECTS[dialect]
  const where = pkCols.map((c, i) => `${spec.quote(c)} = ${pkLiterals[i]}`).join(' AND ')
  return `DELETE FROM ${spec.quote(table)} WHERE ${where}`
}

/**
 * 一行前置数据的 INSERT。
 *
 * overrides 是**必须对齐**的列值（见 columnOverridesOf），其余列走 PRD 4.4 的
 * 语义规则（planColumns 和出句可执行模式同一份规则表）。
 *
 * nonce 是本次造数的「批号」（会话里每发一条 INSERT 递增一次）：唯一列（isUnique、
 * 非主键、没被点名对齐）的值掺进批号——固定 seed 保证值的样子可复现，但手机号/
 * 编码/邮箱这类唯一列两次造出同一个值，第二次跑整条 INSERT 撞唯一键当场翻车，
 * 撞键的风险全由批号吸收。不传（出句面板的老路）值保持完全可复现。
 */
export function planFixture(
  table: string,
  columns: Column[],
  dialect: GenDialect,
  seed: number,
  overrides: ValueMap = {},
  nonce?: number,
): FixturePlan {
  const spec = DIALECTS[dialect]
  const plans = planColumns(table, columns, dialect, seed, 'insert')
  const pkCols = columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
  const pkCol = pkCols.length === 1 ? pkCols[0] : undefined
  const autoPk = !!pkCol && !!columns.find((c) => c.name === pkCol)?.isAutoIncrement

  const names: string[] = []
  const literals: string[] = []
  const kept: ValueMap = {}
  for (const p of plans) {
    const override = overrides[p.column.name]
    /*
     * 自增列默认不显式插（PRD 4.4 的口径）。但**这一列被点名了就必须插**：
     * 自增出来的值跟请求里那个 id 对不上，行造了也白造（请求照样 404）。
     * 被点名时值的来源是确定的，不存在「不知道填什么」的问题。
     * Oracle 的 identity always 会拒显式值 —— 那种库这条 INSERT 会报错，
     * 报错如实进日志，不静默吞掉（见 FixtureSession 的插入失败分支）。
     */
    if (p.excluded && override === undefined) continue
    let text = override ?? p.auto
    // 批号只掺给「没被点名」的唯一列：主键与对齐列是请求要找的键，动了等于没造
    if (override === undefined && nonce !== undefined && p.column.isUnique && !p.column.isPrimaryKey) {
      text = uniqueize(p.column, text, nonce)
    }
    names.push(spec.quote(p.column.name))
    literals.push(renderValue(p.column, text, dialect))
    kept[p.column.name] = text
  }

  if (!names.length) {
    return { table, insertSql: null, values: kept, pkCols, autoPk, pkQuerySql: null, note: '没有可插入的列' }
  }
  const needReadBack = !!pkCol && kept[pkCol] === undefined
  return {
    table,
    insertSql: `INSERT INTO ${spec.quote(table)} (${names.join(', ')}) VALUES (${literals.join(', ')})`,
    values: kept,
    pkCols,
    autoPk,
    pkQuerySql: needReadBack ? pkQueryOf(table, pkCol!, dialect) : null,
  }
}

/**
 * 造数顺序：主表（被引用方）先插，子表后插。
 *
 * 只认 `confidence === 'constraint'` 的真实外键约束。有环（互引）或元数据缺失时
 * 剩下的按传入顺序跟在后面 —— **不假装有拓扑序**，也别把它们丢了。
 * 排序本身用稳定扫描：同一层的表保持传入顺序，结果可复现。
 */
export function orderFixtures(tables: string[], fks: ForeignKey[]): string[] {
  const set = new Set(tables)
  const need = new Map<string, Set<string>>()
  for (const t of tables) need.set(t, new Set())
  for (const fk of fks) {
    if (fk.confidence !== 'constraint') continue
    if (fk.fromTable === fk.toTable) continue
    if (!set.has(fk.fromTable) || !set.has(fk.toTable)) continue
    need.get(fk.fromTable)!.add(fk.toTable)
  }
  const out: string[] = []
  const done = new Set<string>()
  for (let progress = true; progress && out.length < tables.length; ) {
    progress = false
    for (const t of tables) {
      if (done.has(t) || ![...need.get(t)!].every((d) => done.has(d))) continue
      out.push(t)
      done.add(t)
      progress = true
    }
  }
  for (const t of tables) if (!done.has(t)) out.push(t)
  return out
}

/* ================= 造哪张表、对齐哪些列 ================= */

/**
 * 路径参数 → 显示值。用例里有就用用例的（那正是请求要发的值），
 * 缺了按 cases 同一套优先级补：参数上的 defaultValue > 按类型/名字的默认值。
 */
export function pathValuesOf(api: ApiMethod, values?: Record<string, unknown>): ValueMap {
  const out: ValueMap = {}
  for (const p of api.parameters) {
    if (p.position !== 'path') continue
    const v = values?.[p.name]
    out[p.name] =
      v === undefined || v === null || v === ''
        ? (p.defaultValue ?? defaultParamValue(p))
        : String(v)
  }
  return out
}

/** 能对齐成主键的类型。字符串主键（业务编码当主键）不猜 */
const NUMERIC_JAVA = /^(int|integer|long|short|byte|biginteger|java\.math\.biginteger|number|decimal|numeric)$/i

/**
 * 这一行要**对齐**的列（列名 → 显示值）。三条规则，顺序有讲究：
 *
 * 1. 路径参数 → 同名列：`{id}` 对齐 `id`、`{orderNo}` 对齐 `order_no`。
 *    这行的键必须正好是请求要找的那个值 —— 对不上就等于没造（请求还是 404）。
 * 2. 一个路径参数都没对上时，退一步把**主键**对齐成第一个数字型路径参数的值：
 *    国内接口常见 `{applyId}` 配表主键 `id`。只认「单列数字主键 + 纯数字的值」，
 *    字符串主键不猜。这也让整簇表的主键都是同一个值，父子表的外键自然对得上。
 * 3. 外键列 → 父表刚插进去的主键值。不指向真实存在的父行，INSERT 当场 1452。
 */
export function columnOverridesOf(
  table: string,
  columns: Column[],
  pathValues: ValueMap,
  parentPk: Map<string, string>,
  fks: ForeignKey[],
): ValueMap {
  const out: ValueMap = {}
  const bySnake = new Map(columns.map((c) => [toSnake(c.name), c.name]))
  let matched = false
  for (const [param, value] of Object.entries(pathValues)) {
    const col = bySnake.get(toSnake(param))
    if (col && out[col] === undefined) {
      out[col] = value
      matched = true
    }
  }
  if (!matched) {
    const pks = columns.filter((c) => c.isPrimaryKey)
    const first = Object.values(pathValues)[0]
    if (pks.length === 1 && NUMERIC_JAVA.test(pks[0]!.javaType) && /^\d+$/.test(first ?? '')) {
      out[pks[0]!.name] = first!
    }
  }
  for (const fk of fks) {
    if (fk.confidence !== 'constraint' || fk.fromTable !== table) continue
    const parent = parentPk.get(fk.toTable)
    if (parent !== undefined && columns.some((c) => c.name === fk.fromColumn)) {
      out[fk.fromColumn] = parent
    }
  }
  return out
}

/* ================= 读接口借真数据（请求配合库） ================= */

/**
 * 读接口的前置数据走「借」不走「造」：详情/查询接口要的只是一条**真实存在**的行，
 * 从关联表里 SELECT 一条真数据，把它的 id 形列值回填进请求——零写入、绝不弄脏共享库；
 * 真实行自带完整外键链（它的父数据本来就存在），天然绕开外键造数这个坑。
 * 表空 / 没连库 / 对不上列时由调用方降级回造行（prepareFor），行为与从前一致。
 *
 * 只认 id 形字段（isIdLikeName）：借真数据改变的是「请求打到哪一行」，业务字段的
 * 值仍由语义字典造——把整行真实数据灌进请求，等于把「测接口」变成「复刻某条业务数据」。
 */

/** 一条回填：哪个字段、填什么值、从哪张表哪一列借来的（日志要能对上账） */
export interface ReadFill {
  field: string
  value: string | number
  table: string
  col: string
  kind: 'param' | 'body'
}

/**
 * 从查回来的真实行里挑出可回填的 id 形字段值。rows 按关联表顺序进，同一字段
 * 先到先得；body 数值型字段（Long/Integer）把数字串转成 JSON 数字——后端 Long
 * 收不下 "42" 这种字符串（test_demo 实测 400 假失败），回填不能造出新的假失败。
 */
export function readBackfillOf(api: ApiMethod, rows: { table: string; record: Record<string, string | null> }[]): ReadFill[] {
  const bodyType = new Map(api.requestBodyFields.map((f) => [f.name, f.javaType] as const))
  const paramNames = new Set(
    api.parameters.filter((p) => (p.position === 'path' || p.position === 'query') && isIdLikeName(p.name)).map((p) => p.name),
  )
  const bodyNames = new Set(api.requestBodyFields.filter((f) => isIdLikeName(f.name)).map((f) => f.name))
  const out = new Map<string, ReadFill>()
  for (const { table, record } of rows) {
    const bySnake = new Map(Object.keys(record).map((c) => [toSnake(c), c] as const))
    for (const f of paramNames) {
      if (out.has(`p:${f}`)) continue
      const col = bySnake.get(toSnake(f))
      const v = col ? record[col] : null
      if (col && v !== null && v !== '') out.set(`p:${f}`, { field: f, value: v, table, col, kind: 'param' })
    }
    for (const f of bodyNames) {
      if (out.has(`b:${f}`)) continue
      const col = bySnake.get(toSnake(f))
      const v = col ? record[col] : null
      if (col && v !== null && v !== '') {
        const jt = bodyType.get(f) ?? ''
        out.set(`b:${f}`, {
          field: f,
          value: NUMERIC_JAVA.test(jt) && /^-?\d+$/.test(v) ? Number(v) : v,
          table,
          col,
          kind: 'body',
        })
      }
    }
  }
  return [...out.values()]
}

/**
 * 把借来/造出的值落进**这一条用例**的参数。默认（读接口）只动用例里已有的键：
 * 正常用例没填的可选 query 参数不许被补上（列表查询平白多个筛选条件，结果可能
 * 被筛空）；异常/边界用例根本不该调这个——缺字段的语义和 0/-1 的「不存在 id」
 * 不能被真数据盖掉。inject（写接口的删改回填）才允许补缺的键：冒烟 body 是
 * 空对象是既定口径，删改要打中造出的行就得把主键写进去；fills 本身是
 * readBackfillOf 按接口字段表筛过的，不会冒出接口没声明的字段。
 * __body 只在能解析成对象时回填，解析失败原样不动。
 */
export function applyReadBackfill(
  values: Record<string, unknown>,
  fills: ReadFill[],
  inject = false,
): { values: Record<string, unknown>; filled: string[] } {
  if (!fills.length) return { values, filled: [] }
  const out = { ...values }
  const filled: string[] = []
  let body: Record<string, unknown> | null = null
  let bodyDirty = false
  if (typeof out.__body === 'string') {
    try {
      const parsed: unknown = parsePreservingBig(out.__body)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch {
      body = null
    }
  }
  for (const f of fills) {
    if (f.kind === 'param') {
      if (out[f.field] === undefined && !inject) continue
      out[f.field] = f.value
      filled.push(`回填 ${f.field}=${f.value}（借自 ${f.table}.${f.col}）`)
    } else if (body) {
      if (!(f.field in body) && !inject) continue
      body[f.field] = f.value
      filled.push(`回填 body.${f.field}=${f.value}（借自 ${f.table}.${f.col}）`)
      bodyDirty = true
    }
  }
  if (bodyDirty) out.__body = stringifyPreservingBig(body)
  return { values: out, filled }
}

/**
 * 借真数据的只读单行查询。只 SELECT 能对齐到请求 id 形字段的那些列（不多查）；
 * 单列主键按主键倒序取最新一行——最新的行外键链最可能完整；没主键/复合主键就
 * 不排序随便取一行。null = 请求里没有能对齐这张表的 id 形字段，不用查。
 */
export function planReadBackfill(api: ApiMethod, table: string, columns: Column[], dialect: GenDialect): string | null {
  const spec = DIALECTS[dialect]
  const bySnake = new Map(columns.map((c) => [toSnake(c.name), c.name] as const))
  const cands = new Set<string>([
    ...api.parameters.filter((p) => (p.position === 'path' || p.position === 'query') && isIdLikeName(p.name)).map((p) => p.name),
    ...api.requestBodyFields.filter((f) => isIdLikeName(f.name)).map((f) => f.name),
  ])
  const cols = [...cands].map((f) => bySnake.get(toSnake(f))).filter((c): c is string => !!c)
  if (!cols.length) return null
  const pks = columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
  const order = pks.length === 1 ? ` ORDER BY ${spec.quote(pks[0])} DESC` : ''
  return applyPage(dialect, `SELECT ${cols.map((c) => spec.quote(c)).join(', ')} FROM ${spec.quote(table)}${order}`, {
    offset: 0,
    limit: 1,
  })
}

/* ================= 手工补值（用户补的已知好值，环境面板入口，原「样本值」） ================= */

/**
 * 把用户在环境面板补的值落进正常用例。只认**接口声明过的字段**：同名参数
 * （path/query）填参数，同名 body 顶层字段进 body（{} 冒烟骨架也注入——不然补了
 * 等于没补）；接口没有的字段不乱塞（拼错字段名要看得出来：发了跟没发一样就是
 * 提醒用户改）。数值型 body 字段给 JSON 数字（后端 Long 收不下字符串，同回填纪律）。
 * 只给正常用例调：异常/边界的 0/-1、缺字段语义不能被补的值盖掉。
 */
export function applySampleValues(
  api: ApiMethod,
  values: Record<string, unknown>,
  samples: Record<string, string>,
): { values: Record<string, unknown>; filled: string[] } {
  if (!Object.keys(samples).length) return { values, filled: [] }
  const declaredParams = new Set(api.parameters.filter((p) => p.position === 'path' || p.position === 'query').map((p) => p.name))
  const bodyType = new Map(api.requestBodyFields.map((f) => [f.name, f.javaType] as const))
  const out = { ...values }
  const filled: string[] = []
  let body: Record<string, unknown> | null = null
  let bodyDirty = false
  if (typeof out.__body === 'string') {
    try {
      const parsed: unknown = parsePreservingBig(out.__body)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch {
      body = null
    }
  }
  for (const [field, raw] of Object.entries(samples)) {
    if (raw === '' || raw === undefined) continue
    if (declaredParams.has(field)) {
      out[field] = raw
      filled.push(`手工补值：${field}=${raw}`)
    }
    const jt = bodyType.get(field)
    if (jt !== undefined && body) {
      // Number 只在安全整数范围内转：雪花 id（19 位）转 Number 就圆整了，
      // 留字符串——Jackson 服务端会把 "123" 宽松地并进 Long 字段
      body[field] =
        NUMERIC_JAVA.test(jt) && /^-?\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : raw
      filled.push(`手工补值：body.${field}=${raw}`)
      bodyDirty = true
    }
    if (!declaredParams.has(field) && jt === undefined) {
      filled.push(`手工补值：${field} 在这个接口上没有对应参数 / body 字段，没发——检查拼写`)
    }
  }
  if (bodyDirty) out.__body = stringifyPreservingBig(body)
  return { values: out, filled }
}

/* ================= 会话：真去插、真去清 ================= */

/**
 * 外键链递归造父行的深度封顶。链一深就是无底洞（租户 → 集团 → 商户 → …），
 * 造满一条 5 层链往真库写 5 行不如如实报告「造不满」让人工补一条值。
 * 借真实父行不受此限（只读没有深度代价）。
 */
const MAX_FK_DEPTH = 3

export interface FixtureDeps {
  /** 表 → 列清单。实现方先查出句的表结构缓存，缓存没有再问库 */
  lookupColumns: (table: string) => Promise<Column[]>
  /** 外键清单。只有 'constraint' 的参与排序，见 orderFixtures */
  foreignKeys: ForeignKey[]
  /** 写库（闸门在 sqlExec.ts / Rust sql_write.rs）。只发 INSERT 和带 WHERE 的 DELETE */
  execSql: (statements: string[]) => Promise<{ affected: number; ran: number }>
  /** 只读查询，只用来回查自增主键 */
  query: (sql: string) => Promise<QueryGrid>
  /**
   * 库里有哪些表（名字 + 注释 + Java 类名）。异常学习（repairMissing）认表用：
   * 接口报「品牌商不存在」时靠注释/类名/表名认出品牌商表。不提供就跳过认表。
   */
  listTables?: () => Promise<TableRef[]>
  dialect: GenDialect
  /** 散列种子。固定值 = 每次造出同样的行，SQL 可 diff */
  seed?: number
  /**
   * 造数批号的底座（唯一列掺批号，见 planFixture）。缺省用当前时间——每跑一批
   * 就是新值，重复跑不再撞唯一键；测试传固定值求可复现。
   */
  runNonce?: number
}

export interface FixtureSession {
  /** 幂等：同一个接口备一次。返回要记进「数据日志」的日志行 */
  prepareFor: (
    api: ApiMethod,
    relations: TableRelation[],
    values?: Record<string, unknown>,
  ) => Promise<string[]>
  /**
   * 读接口借真数据：对关联表做**只读**单行 SELECT（绝不 INSERT/DELETE），把可回填的
   * id 形字段值交给调用方。返回的 backfill 为空（没连表 / 全表空 / 对不上列）时，
   * 调用方降级回 prepareFor 造行。幂等同 prepareFor：GET 组并发只查一次库。
   */
  borrowFor: (
    api: ApiMethod,
    relations: TableRelation[],
  ) => Promise<{ log: string[]; backfill?: ReadFill[] }>
  /**
   * 最近一次 prepareFor 造出来的行能回填哪些 id 形字段（第②步：删改打在自己造的
   * 行上）。只收定位到单一主键的行；没造过 / 全造失败 / 定位不到就是空数组。
   * 调用方拿它配 applyReadBackfill(…, true) 落进 PUT/PATCH/DELETE 的正常用例。
   */
  fillsFor: (apiId: string) => ReadFill[]
  /** 清掉这个接口造的行（逆序）。返回日志行 */
  finishFor: (apiId: string) => Promise<string[]>
  /**
   * 异常学习（2026-09-19）：接口回话说缺数据（「品牌商不存在」）时，从报错抽出
   * 实体名，认出对应哪张表，借一条真实 id（表空就造一行，进本接口的清理清单），
   * 把可回填字段交给调用方重发一次。认不出（没表清单 / 字段对不上）fills 为空
   * 数组、原因进 log——认不准绝不乱填。报错里抽不出线索返回 null（调用方零成本跳过）。
   */
  repairMissing: (
    apiId: string,
    api: ApiMethod,
    responseText: string,
    values?: Record<string, unknown>,
  ) => Promise<{ log: string[]; fills: ReadFill[] } | null>
  /**
   * 把还挂着的全清掉。用户点停止、或者中途抛异常时走这条 —— 造出来的行
   * 不能留在用户库里。正常跑完时它是空操作。
   */
  finishAll: () => Promise<string[]>
  /** 累计真插进去的行数（确认框文案与报告用） */
  insertedCount: () => number
  /**
   * 「正常·按 xxx 查」取真实值：在关联表里找同名列（brandName ↔ BRAND_NAME），
   * 只读取最新一行非空值。对不上列 / 表空 value 为 undefined，调用方跳过这条用例
   */
  queryValueFor: (
    relations: TableRelation[],
    field: string,
  ) => Promise<{ log: string[]; value?: string; table?: string; col?: string }>
}

/** 取某列最新一行的非空值（只读）。单主键按主键倒序，没主键随便取一行 */
export function planColumnSample(table: string, col: string, columns: Column[], dialect: GenDialect): string {
  const spec = DIALECTS[dialect]
  const pks = columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
  const order = pks.length === 1 ? ` ORDER BY ${spec.quote(pks[0])} DESC` : ''
  return applyPage(
    dialect,
    `SELECT ${spec.quote(col)} FROM ${spec.quote(table)} WHERE ${spec.quote(col)} IS NOT NULL${order}`,
    { offset: 0, limit: 1 },
  )
}

export function makeFixtureSession(deps: FixtureDeps): FixtureSession {
  /** 造好、还等着清理的一行。pkValues 是**真正**定位到的主键显示值（子表的外键要拿它对齐） */
  type FixtureRow = { table: string; pkCols: string[]; cleanupSql: string | null; note: string; pkValues: string[] }
  /** apiId → 准备中的 Promise。GET 组并发时两条用例会同时进来，靠它只备一次 */
  const inflight = new Map<string, Promise<string[]>>()
  /** apiId → 借真数据中的 Promise。与 prepareFor 的 inflight 分开记：两条路互为降级，不是同一件事 */
  const borrowInflight = new Map<string, Promise<{ log: string[]; backfill?: ReadFill[] }>>()
  /** apiId → 刚造出来的行能回填哪些字段（第②步：删改打在自己造的行上）。finish 时一起清 */
  const fillsByApi = new Map<string, ReadFill[]>()
  const rowsByApi = new Map<string, FixtureRow[]>()
  let inserted = 0

  /**
   * 批号：每发一条 INSERT 递增一次。底座默认当前毫秒——同一次会话内的多条
   * INSERT 靠序号错开，跨会话靠时间错开；测试传 runNonce 固定底座。
   */
  let attempts = 0
  const nextNonce = () => (deps.runNonce ?? Date.now()) + ++attempts

  /**
   * 定位刚插进去的那一行。没有定位手段就老实说清，绝不按范围删。
   * 返回的 pkValues 有第二个用处：**父表**靠它把真实主键给子表的外键列对齐 ——
   * 自增主键的值不回查就不知道，那是子表 INSERT 报 1452 的根源。
   */
  const locate = async (
    table: string,
    plan: FixturePlan,
    columns: Column[],
    pk: string | undefined,
  ): Promise<FixtureRow> => {
    if (!pk) return { table, pkCols: plan.pkCols, cleanupSql: null, note: '表没有主键，定位不到刚插的行，未自动清理', pkValues: [] }
    if (plan.pkCols.length > 1 && plan.pkCols.some((c) => plan.values[c] === undefined)) {
      return { table, pkCols: plan.pkCols, cleanupSql: null, note: '复合主键值未知，未自动清理', pkValues: [] }
    }
    let values = plan.pkCols.map((c) => plan.values[c])
    if (values.some((v) => v === undefined)) {
      if (!plan.pkQuerySql) {
        return { table, pkCols: plan.pkCols, cleanupSql: null, note: '主键值未知，未自动清理', pkValues: [] }
      }
      try {
        const grid = await deps.query(plan.pkQuerySql)
        const cell = grid.rows[0]?.[0]
        if (cell === undefined || cell === null || cell === '') {
          return { table, pkCols: plan.pkCols, cleanupSql: null, note: '回查不到刚插的主键，未自动清理', pkValues: [] }
        }
        values = [String(cell)]
      } catch (e) {
        return { table, pkCols: plan.pkCols, cleanupSql: null, note: `回查主键失败：${String(e)}，未自动清理`, pkValues: [] }
      }
    }
    const literals = plan.pkCols.map((c, i) => {
      const col = columns.find((x) => x.name === c)
      return col ? renderValue(col, values[i]!, deps.dialect) : values[i]!
    })
    return {
      table,
      pkCols: plan.pkCols,
      cleanupSql: cleanupSqlOf(table, plan.pkCols, literals, deps.dialect),
      note: '',
      // 走到这里每个主键值都是确定的（上面的分支把 undefined 全挡掉了）
      pkValues: values.map((v) => v!),
    }
  }

  const prepare = async (
    api: ApiMethod,
    relations: TableRelation[],
    values?: Record<string, unknown>,
  ): Promise<string[]> => {
    const log: string[] = []
    const tables = relations.filter((r) => r.enabled).map((r) => r.tableName)
    if (!tables.length) return log

    // 拿不到列清单的表诚实跳过：表名拼错、库里没这张、权限不够都算
    const colsOf = new Map<string, Column[]>()
    for (const t of tables) {
      try {
        const cols = await deps.lookupColumns(t)
        if (cols.length) colsOf.set(t, cols)
        else log.push(`造行：${t} 取不到列清单，跳过`)
      } catch (e) {
        log.push(`造行：${t} 取不到列清单：${String(e)}`)
      }
    }
    if (!colsOf.size) return log

    const pathValues = pathValuesOf(api, values)
    const parentPk = new Map<string, string>()
    const rows: FixtureRow[] = []
    /** 借过的真实父行（toTable.toColumn → 主键值；null = 表空/表不在，别反复查） */
    const borrowCache = new Map<string, string | null>()

    /** 借真实父行：会话级的 borrowPkOf 在下面（造数主链与异常学习共用一份） */
    const borrowParentPk = borrowPkOf

    /**
     * FK 列的值从哪来（第③步 外键混合策略，按序）：
     * ① 本轮刚造出来的父行（parentPk，含递归造出来的链上父行）；
     * ② 库里现成的真实父行——只读借，不写、不进清理清单（链上九成的父表都有数据，
     *    这一档就够）；③ 父表真的空 → 造父行，父行自己的外键同法解析（递归），
     *    深度封顶 MAX_FK_DEPTH 层，封顶就如实说「造不满」，列值交回语义字典——
     *    INSERT 真被外键约束拦了也照旧如实记日志。借是只读的，任何深度都先试。
     */
    const resolveFk = async (fk: ForeignKey, depth: number): Promise<string | undefined> => {
      const made = parentPk.get(fk.toTable)
      if (made !== undefined) return made
      const cacheKey = `${fk.toTable}.${fk.toColumn}`
      if (!borrowCache.has(cacheKey)) borrowCache.set(cacheKey, await borrowParentPk(fk.toTable, fk.toColumn))
      const borrowed = borrowCache.get(cacheKey)
      if (borrowed !== null) {
        log.push(`外键 ${fk.fromTable}.${fk.fromColumn} ← 借真实父行 ${fk.toTable}.${fk.toColumn}=${borrowed}`)
        return borrowed!
      }
      if (depth > MAX_FK_DEPTH) {
        log.push(
          `外键链超过 ${MAX_FK_DEPTH} 层：${fk.fromTable}.${fk.fromColumn} → ${fk.toTable} 不再向上造父行，` +
            '列值交回语义字典（可能被外键约束拦下）',
        )
        return undefined
      }
      return createParentRow(fk.toTable, depth)
    }

    /** 造链上的父行（表空才走到这）：自己的外键先递归解析，插完进清理清单，主键交给 parentPk */
    const createParentRow = async (table: string, depth: number): Promise<string | undefined> => {
      let columns: Column[]
      try {
        columns = await deps.lookupColumns(table)
      } catch (e) {
        log.push(`外键链：${table} 取不到列清单：${String(e)}`)
        return undefined
      }
      if (!columns.length) {
        log.push(`外键链：${table} 取不到列清单，跳过`)
        return undefined
      }
      const overrides: ValueMap = {}
      for (const fk of deps.foreignKeys) {
        if (fk.confidence !== 'constraint' || fk.fromTable !== table) continue
        if (!columns.some((c) => c.name === fk.fromColumn)) continue
        const v = await resolveFk(fk, depth + 1)
        if (v !== undefined) overrides[fk.fromColumn] = v
        else if (columns.find((c) => c.name === fk.fromColumn)?.nullable) {
          // 同主循环：链上造不满的可空 FK 列置 NULL，别让语义字典的值打断整条链
          overrides[fk.fromColumn] = ''
          log.push(`外键 ${fk.fromTable}.${fk.fromColumn} 置 NULL（可空列，${fk.toTable} 处造不满）`)
        }
      }
      const plan = planFixture(table, columns, deps.dialect, deps.seed ?? 0, overrides, nextNonce())
      if (!plan.insertSql) {
        log.push(`外键链：${table} ${plan.note ?? '没有可插入的列'}，跳过`)
        return undefined
      }
      try {
        await deps.execSql([plan.insertSql])
      } catch (e) {
        log.push(`外键链插入失败：${plan.insertSql} —— ${String(e)}`)
        return undefined
      }
      log.push(`造行（补父行）：${plan.insertSql}`)
      inserted += 1
      const pk = plan.pkCols.length === 1 ? plan.pkCols[0] : undefined
      const row = await locate(table, plan, columns, pk)
      if (row.pkValues.length === 1) parentPk.set(table, row.pkValues[0]!)
      rows.push(row)
      return row.pkValues.length === 1 ? row.pkValues[0]! : undefined
    }

    // 父表先插：子表的外键列要指向刚插进去的父行
    for (const table of orderFixtures([...colsOf.keys()], deps.foreignKeys)) {
      const columns = colsOf.get(table)!
      const overrides = columnOverridesOf(table, columns, pathValues, parentPk, deps.foreignKeys)
      // 第③步：columnOverridesOf 只对齐「本轮造过的父行」；剩下的 FK 列不再交给
      // 语义字典瞎造（真外键约束当场 1452）——先借真实父行，借不到才递归造（封顶 3 层）
      for (const fk of deps.foreignKeys) {
        if (fk.confidence !== 'constraint' || fk.fromTable !== table) continue
        if (overrides[fk.fromColumn] !== undefined) continue
        if (!columns.some((c) => c.name === fk.fromColumn)) continue
        const v = await resolveFk(fk, 1)
        if (v !== undefined) overrides[fk.fromColumn] = v
        else if (columns.find((c) => c.name === fk.fromColumn)?.nullable) {
          // 造不满（封顶/父行造失败）：可空 FK 列显式置 NULL（renderValue 的空串就是
          // NULL），链到造不满处仍成立；留着语义字典的值只会被外键约束整条打断
          overrides[fk.fromColumn] = ''
          log.push(`外键 ${fk.fromTable}.${fk.fromColumn} 置 NULL（可空列，${fk.toTable} 处造不满）`)
        }
      }
      const plan = planFixture(table, columns, deps.dialect, deps.seed ?? 0, overrides, nextNonce())
      if (!plan.insertSql) {
        log.push(`造行：${table} ${plan.note ?? '没有可插入的列'}，跳过`)
        continue
      }
      try {
        await deps.execSql([plan.insertSql])
      } catch (e) {
        // 撞唯一键（这行本来就在）不该算失败：请求要找的那行存在，用例照样有效。
        // 也不能记进 rows —— 那不是我们造的行，清理时删掉等于删用户的数据
        log.push(`造行失败（可能已存在，用例仍作用于既有行）：${plan.insertSql} —— ${String(e)}`)
        continue
      }
      log.push(`造行：${plan.insertSql}`)
      inserted += 1
      const pk = plan.pkCols.length === 1 ? plan.pkCols[0] : undefined
      const row = await locate(table, plan, columns, pk)
      /*
       * 子表的外键列要对齐父表**真正**的主键，而自增主键的值在 plan.values 里是没有的
       * （planFixture 刻意不显式插自增列），只有回查完才知道 —— 所以这一步必须在
       * locate **之后**。曾经写在插入之后、回查之前，于是子表的 FK 列拿到的是语义
       * 默认值不是刚插那行的主键，INSERT 当场被外键约束拒绝，日志里只留一句
       * 「插入失败」，看着像数据脏，其实是顺序错了。
       */
      if (row.pkValues.length === 1) parentPk.set(table, row.pkValues[0]!)
      rows.push(row)
    }
    rowsByApi.set(api.id, rows)
    // 造出的行 → 可回填清单。只收定位到单一主键的行，主键值经由 readBackfillOf
    // 的同名对齐纪律（请求字段 ↔ 列名 snake 匹配、Long 转 JSON 数字）变成 fills——
    // 调用方在 PUT/PATCH/DELETE 的正常用例上把它落进请求，删改就打在自己造的行上。
    // 关联表（请求要打的目标）排前面先到先得：链上递归造的父行也有主键，但那不是
    // 请求要打的那行
    fillsByApi.set(
      api.id,
      readBackfillOf(
        api,
        [...rows.filter((r) => colsOf.has(r.table)), ...rows.filter((r) => !colsOf.has(r.table))]
          .filter((r) => r.pkCols.length === 1 && r.pkValues.length === 1)
          .map((r) => ({ table: r.table, record: { [r.pkCols[0]!]: r.pkValues[0]! } })),
      ),
    )
    return log
  }

  /**
   * 借真数据：只读查询一路 SELECT，**不碰 execSql**——这条路上没有清理问题可言。
   * 查回来的行按查询列名压成 record；回填交给调用方按用例落（applyReadBackfill）。
   */
  const borrow = async (
    api: ApiMethod,
    relations: TableRelation[],
  ): Promise<{ log: string[]; backfill?: ReadFill[] }> => {
    const log: string[] = []
    const tables = relations.filter((r) => r.enabled).map((r) => r.tableName)
    if (!tables.length) return { log }
    const rows: { table: string; record: Record<string, string | null> }[] = []
    for (const table of tables) {
      let columns: Column[]
      try {
        columns = await deps.lookupColumns(table)
      } catch (e) {
        log.push(`借真实行：${table} 取不到列清单：${String(e)}`)
        continue
      }
      if (!columns.length) {
        log.push(`借真实行：${table} 取不到列清单，跳过`)
        continue
      }
      const sql = planReadBackfill(api, table, columns, deps.dialect)
      if (!sql) continue
      try {
        const grid: QueryGrid = await deps.query(sql)
        const row = grid.rows[0]
        if (!row) {
          log.push(`借真实行：${table} 表里没有存量行`)
          continue
        }
        const record: Record<string, string | null> = {}
        grid.columns.forEach((c, i) => (record[c] = row[i] ?? null))
        rows.push({ table, record })
      } catch (e) {
        log.push(`借真实行：${table} 查询失败：${String(e)}`)
      }
    }
    const backfill = readBackfillOf(api, rows)
    return backfill.length ? { log, backfill } : { log }
  }

  const finish = async (apiId: string): Promise<string[]> => {
    const rows = rowsByApi.get(apiId)
    rowsByApi.delete(apiId)
    inflight.delete(apiId)
    borrowInflight.delete(apiId)
    fillsByApi.delete(apiId)
    if (!rows?.length) return []
    const log: string[] = []
    // 与造数逆序：先删子表再删父表，否则外键约束拦着删不掉
    for (const r of [...rows].reverse()) {
      if (!r.cleanupSql) {
        log.push(`清理：${r.table} —— ${r.note}`)
        continue
      }
      try {
        const res = await deps.execSql([r.cleanupSql])
        log.push(
          `清理：${r.cleanupSql}` +
            (res.affected === 0 ? '（影响 0 行：这行已经被接口自己删掉了）' : ''),
        )
      } catch (e) {
        log.push(`清理失败：${r.cleanupSql} —— ${String(e)}`)
      }
    }
    return log
  }

  /* ================= 异常学习：接口报缺数据 → 认表 → 借/造 → 回填 ================= */

  /**
   * 借真实父行：只读 SELECT 一条现成的行拿主键。表空 / 表或列不在 → null。
   * 造数主链（FK 列对齐）与异常学习（引用数据回填）共用这一份。
   */
  const borrowPkOf = async (toTable: string, toColumn: string): Promise<string | null> => {
    try {
      const cols = await deps.lookupColumns(toTable)
      if (!cols.some((c) => c.name === toColumn)) return null
      const grid = await deps.query(pkQueryOf(toTable, toColumn, deps.dialect))
      const cell = grid.rows[0]?.[0]
      return cell === undefined || cell === null || cell === '' ? null : String(cell)
    } catch {
      return null
    }
  }

  /** 表清单一次拉全并缓存；null = 拿不到（没配 listTables 或查询失败） */
  let tablesCache: TableRef[] | null | undefined
  const tablesOf = async (): Promise<TableRef[]> => {
    if (tablesCache === undefined) {
      try {
        tablesCache = (await deps.listTables?.()) ?? null
      } catch {
        tablesCache = null
      }
    }
    return tablesCache ?? []
  }

  /** 学到的认表结果（字段 → 表）：同一跑批里后面的接口直接命中，不再重新认 */
  const learned = new Map<string, { table: string; via: string }>()
  let warnedNoTables = false

  /**
   * 借（表空就造）一条引用行的主键值。造的行进本接口的清理清单，跑完照删；
   * 它自己的外键列借真实父行（借不到且可空就置 NULL），不递归造——引用数据
   * 顶多两级（代理商要品牌商，品牌商自己一般不再依赖谁），递归是无底洞。
   */
  const ensureRefRow = async (
    apiId: string,
    table: string,
  ): Promise<
    | { ok: true; value: string; col: string; created: boolean; log: string[] }
    | { ok: false; log: string[] }
  > => {
    const rlog: string[] = []
    let columns: Column[]
    try {
      columns = await deps.lookupColumns(table)
    } catch (e) {
      return { ok: false, log: [`认到的表 ${table} 取不到列清单：${String(e)}`] }
    }
    if (!columns.length) return { ok: false, log: [`认到的表 ${table} 取不到列清单，跳过`] }
    const pks = columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
    if (pks.length !== 1) return { ok: false, log: [`表 ${table} 主键不是单列，借不出一个值，跳过`] }
    const pk = pks[0]!
    const borrowed = await borrowPkOf(table, pk)
    if (borrowed !== null) return { ok: true, value: borrowed, col: pk, created: false, log: rlog }
    const overrides: ValueMap = {}
    for (const fk of deps.foreignKeys) {
      if (fk.confidence !== 'constraint' || fk.fromTable !== table) continue
      if (!columns.some((c) => c.name === fk.fromColumn)) continue
      const v = await borrowPkOf(fk.toTable, fk.toColumn)
      if (v !== null) overrides[fk.fromColumn] = v
      else if (columns.find((c) => c.name === fk.fromColumn)?.nullable) overrides[fk.fromColumn] = ''
    }
    const plan = planFixture(table, columns, deps.dialect, deps.seed ?? 0, overrides)
    if (!plan.insertSql) {
      return { ok: false, log: [...rlog, `造行：${table} ${plan.note ?? '没有可插入的列'}，跳过`] }
    }
    try {
      await deps.execSql([plan.insertSql])
    } catch (e) {
      return { ok: false, log: [...rlog, `造行失败：${plan.insertSql} —— ${String(e)}`] }
    }
    inserted += 1
    rlog.push(`造行（补引用数据）：${plan.insertSql}`)
    const row = await locate(table, plan, columns, pk)
    if (!rowsByApi.has(apiId)) rowsByApi.set(apiId, [])
    rowsByApi.get(apiId)!.push(row)
    if (row.pkValues.length !== 1) {
      return { ok: false, log: [...rlog, `表 ${table} 的主键值没定位到，没法回填（清理时仍会删掉这行）`] }
    }
    return { ok: true, value: row.pkValues[0]!, col: pk, created: true, log: rlog }
  }

  const repairMissing = async (
    apiId: string,
    api: ApiMethod,
    responseText: string,
    values?: Record<string, unknown>,
  ): Promise<{ log: string[]; fills: ReadFill[] } | null> => {
    if (!responseText) return null
    const hints = missingHintsFromResponse(responseText)
    if (!hints.length) return null
    const log: string[] = []
    const tables = await tablesOf()
    if (!tables.length) {
      // 没表清单时每条失败用例都会走到这，理由只说一次，别刷屏
      if (!warnedNoTables) {
        warnedNoTables = true
        log.push(
          `接口报「${hints[0]!.raw.trim().slice(0, 60)}」——缺的前置数据本可以自动补，` +
            '但认不出库里有哪些表（连库后先导入表清单），跳过',
        )
      }
      return { log, fills: [] }
    }
    for (const hint of hints) {
      for (const c of refCandidates(api, values, hint)) {
        const key = `${c.kind}:${c.field}`
        const known = learned.get(key)
        let table = known?.table
        let via = known?.via ?? ''
        if (!table) {
          const pick = pickRefTable(c.stem, hint.entity, tables)
          if (!pick) continue
          table = pick.name
          via = pick.via
        }
        const ref = await ensureRefRow(apiId, table)
        log.push(...ref.log)
        if (!ref.ok) {
          learned.delete(key)
          continue
        }
        learned.set(key, { table, via })
        // 数值型 body 字段转 JSON 数字（后端 Long 收不下 "5"，同 readBackfillOf 的纪律）
        const jt = api.requestBodyFields.find((f) => f.name === c.field)?.javaType ?? ''
        const value =
          c.kind === 'body' && NUMERIC_JAVA.test(jt) && /^-?\d+$/.test(ref.value) ? Number(ref.value) : ref.value
        log.push(
          `接口报「${hint.raw.trim().slice(0, 60)}」→ ${c.field} 要真实数据（按${via}认到 ${table}）→ ` +
            `${ref.created ? '造' : '借'}了 ${table}.${ref.col}=${ref.value}，回填重发`,
        )
        return { log, fills: [{ field: c.field, value, table, col: ref.col, kind: c.kind }] }
      }
    }
    log.push(
      `接口报「${hints[0]!.raw.trim().slice(0, 60)}」，没认出对应哪张表哪个字段——知道真实值的话在环境页「数据准备 · 手工补值」里补一个`,
    )
    return { log, fills: [] }
  }

  return {
    insertedCount: () => inserted,
    async queryValueFor(relations, field) {
      const log: string[] = []
      for (const table of relations.filter((r) => r.enabled).map((r) => r.tableName)) {
        let columns: Column[]
        try {
          columns = await deps.lookupColumns(table)
        } catch {
          continue
        }
        const col = columns.find((c) => toSnake(c.name) === toSnake(field))?.name
        if (!col) continue
        try {
          const grid = await deps.query(planColumnSample(table, col, columns, deps.dialect))
          const v = grid.rows[0]?.[0]
          if (v !== null && v !== undefined && String(v).trim() !== '') return { log, value: String(v), table, col }
          log.push(`按条件查：${table}.${col} 没有非空的值`)
        } catch (e) {
          log.push(`按条件查：${table}.${col} 查询失败：${String(e)}`)
        }
      }
      return { log }
    },
    prepareFor(api, relations, values) {
      const existing = inflight.get(api.id)
      // 已经备过：等它落地但不重复记日志（另一条用例的 dataLog 里不该出现它没做的事）
      if (existing) return existing.then(() => [])
      const p = prepare(api, relations, values).catch((e) => [
        `前置数据准备失败：${String(e)}`,
      ])
      inflight.set(api.id, p)
      return p
    },
    borrowFor(api, relations) {
      const existing = borrowInflight.get(api.id)
      // 已经借过：等它落地但不重复记日志（回填值照给——每条用例都要用）
      if (existing) return existing.then((r) => ({ log: [], backfill: r.backfill }))
      const p = borrow(api, relations).catch((e) => ({ log: [`借真实行失败：${String(e)}`] }))
      borrowInflight.set(api.id, p)
      return p
    },
    fillsFor: (apiId) => fillsByApi.get(apiId) ?? [],
    repairMissing,
    finishFor: finish,
    async finishAll() {
      const log: string[] = []
      // rowsByApi 的键在 finish 里被删，先拷一份再迭代
      for (const id of [...rowsByApi.keys()]) log.push(...(await finish(id)))
      return log
    },
  }
}
