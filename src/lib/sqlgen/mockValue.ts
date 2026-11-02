/**
 * 可执行模式的测试数据生成，PRD 4.4。
 *
 * 分成两步，中间夹着用户手改（PRD 4.2 的「双击编辑」）：
 *   planValues()  按 PRD 4.4 的规则表给每个字段算一个**显示值**（人看的，'张三'）
 *   renderValue() 把显示值变成**SQL 字面量**（能跑的，'张三' 带引号、NOW() 不带）
 * 引号怎么加、单引号怎么转义不该让用户操心，所以两步必须分开。
 *
 * 为什么不用 Math.random()：
 *   - 配置一改就 useMemo 重算，随机的话勾一下无关的复选框所有值都重新抽一遍，
 *     用户手改过的值会被冲掉；
 *   - 同一份配置每次生成的 SQL 都不一样，没法 diff，也没法写「非空字段一定非空」这类断言。
 * 改成 (seed, 阶段, 表名, 字段名) 的散列：同一个 seed 结果完全稳定，
 * 想要一整套新值就把 seed +1（UI 上的「重新生成」按钮）。
 */
import type { Column, TableInfo } from '../../types/schema'
import { baseType } from '../javaType'
import { DIALECTS, type GenDialect } from './dialect'

/** 列名 → 显示值。用户手改的覆盖值也是这个形状 */
export type ValueMap = Record<string, string>

/**
 * 值的用途。PRD 4.2 布局里【INSERT 数据】和【UPDATE 数据】画的是两张独立表格。
 *
 * 这不是排版偏好。PRD 4.6 的 INSERT 示例是 '张三'，4.7 的 UPDATE 示例是 '李四'；
 * 4.4 的 UPDATE 规则表写的也是「同 INSERT 规则自动生成**新值**」。
 * 两个阶段共用一套值的话，先跑 INSERT 再跑 UPDATE，那行数据看不出任何变化，
 * 于是根本验证不了 UPDATE 生效没有 —— 而十二、验收标准对「可执行 UPDATE」的要求
 * 正是「自动生成新值，复制后可直接执行更新」。
 */
export type ValuePhase = 'insert' | 'update'

/** 两个阶段各一套手改值。用 Partial 是为了让「一个都没改过」直接写 {} */
export type PhaseValues = Partial<Record<ValuePhase, ValueMap>>

export interface ValuePlan {
  column: Column
  /** 自增主键自动排除，不参与 INSERT（PRD 4.4） */
  excluded: boolean
  /** 自动算出来的显示值 */
  auto: string
}

/* ---------- 确定性随机 ---------- */

/** FNV-1a。要的只是「同样输入给同样结果、不同字段散得开」，不需要密码学强度 */
function hash32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * salt 用来在同一个字段上取多个互不相关的随机数（比如手机号的后 8 位和序号）。
 *
 * phase 直接参与散列，而不是搞「UPDATE 用 seed + 1」这种偏移：偏移会撞车——
 * 用户点一次「重新生成」把 seed 从 1 加到 2，UPDATE@seed1 就跟 INSERT@seed2
 * 成了同一套值。参与散列则两个阶段在任何 seed 下都互不相关。
 */
const derive = (seed: number, phase: ValuePhase, table: string, column: string, salt = '') =>
  hash32(`${seed}|${phase}|${table}|${column}|${salt}`)

const pick = <T>(items: readonly T[], n: number): T => items[n % items.length]

/** 闭区间 [min, max] */
const range = (n: number, min: number, max: number) => min + (n % (max - min + 1))

/** 中文名和拼音成对：email 要用拼音，PRD 4.4 的例子是 zhangsan@test.com */
const PEOPLE = [
  { cn: '张三', py: 'zhangsan' },
  { cn: '李四', py: 'lisi' },
  { cn: '王五', py: 'wangwu' },
  { cn: '赵六', py: 'zhaoliu' },
  { cn: '孙七', py: 'sunqi' },
  { cn: '周八', py: 'zhouba' },
] as const

const CITIES = ['北京市朝阳区', '上海市浦东新区', '广州市天河区', '杭州市西湖区'] as const

/**
 * 密码给几个候选而不是写死 '123456'：UPDATE 阶段得能生成一个跟 INSERT 不同的新值。
 * 全是弱口令，因为这是造给本地测试库的假数据，写成强密码只会让人读不出来它是假的。
 */
const PASSWORDS = ['123456', '654321', 'abc123', 'test1234'] as const

/* ---------- 语义规则的公共上下文 ---------- */

/**
 * 规则的上下文。刻意**不放 Column**：规则只该关心「这个字段叫什么、什么类型、
 * 多长」，不该知道它长在哪张表上。这样同一批规则既服务出句的列（Column），
 * 也服务 APIForge 的 DTO 字段（FieldLike，见 mockValueOfField）。
 */
interface Ctx {
  /** 字段原名，只用于调试；规则一律匹配 normName */
  name: string
  /**
   * 归一后的字段名（camelCase → snake_case）。出句的列名本来就长这样，
   * 对它是恒等变换；APIForge 的 DTO 字段名是 camelCase（brandOwnerId /
   * isDeleted），不归一的话 `/_id$/`、`/^(is|has)_/` 这些规则一条都命不中
   * ——同一套规则会在两条路上给出不同的值，那正是这个模块最怕的事。
   */
  normName: string
  /** Java 侧类型。两条路都认它：出句由 Column.javaType 推导，APIForge 由扫描器给 */
  javaType: string
  /**
   * 原始类型文本。出句是 SQL 类型 `VARCHAR(50)` / `DECIMAL(10,2)`；
   * APIForge 没有 SQL 类型，把 Java 类型名当它传。byType 里按类型取精度那几条
   * （intCeiling / decimalScale / enumOptions）对 Java 类型名是恒等兜底——
   * `Integer` 不含括号、不叫 decimal，不会被误判成"有精度限制"。
   */
  type: string
  dialect: GenDialect
  /** 本字段的随机基数 */
  n: number
  person: (typeof PEOPLE)[number]
  /** 声明长度，VARCHAR(50) → 50；没有长度则 undefined */
  length?: number
}

/**
 * camelCase → snake_case，缩略词也要对：`userPWD` → `user_pwd`，
 * 不能切成 `user_p_w_d`（那会让 `/pwd$/` 失配，密码字段拿到一个名字）。
 */
export function toSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}

/* ---------- 值生成器：名字规则和注释规则共用一份实现 ---------- */

const genPassword = (c: Ctx) => pick(PASSWORDS, c.n)
const genEmail = (c: Ctx) => `${c.person.py}@test.com`
const genPhone = (c: Ctx) => `138${String(range(c.n, 0, 99999999)).padStart(8, '0')}`
const genIdCard = (c: Ctx) =>
  `1101011990${String(range(c.n, 1, 1231)).padStart(4, '0')}${String(range(c.n, 1000, 9999))}`
const genIp = (c: Ctx) => `192.168.${range(c.n, 0, 255)}.${range(c.n, 1, 254)}`
const genAvatar = (c: Ctx) => `https://test.com/${c.person.py}.png`
const genUrl = () => 'https://test.com/demo'
const genAddress = (c: Ctx) => `${pick(CITIES, c.n)}测试路${range(c.n, 1, 99)}号`
const genSex = (c: Ctx) => String(range(c.n, 0, 1))
const genAge = (c: Ctx) => String(range(c.n, 18, 60))
// 金额类给两位小数，整数金额在对账场景里一眼就假
const genAmount = (c: Ctx) =>
  `${range(c.n, 1, 9999)}.${String(range(c.n, 0, 99)).padStart(2, '0')}`
const genPercent = (c: Ctx) => String(range(c.n, 0, 100))
const genLngLat = (c: Ctx) => `${range(c.n, 100, 130)}.${range(c.n, 100000, 999999)}`
const genPersonName = (c: Ctx) => c.person.cn
const genText = () => '测试数据'
const genJson = () => '{}'
// 单号/编码类：带前缀的定长串，肉眼能看出是造的
const genCode = (c: Ctx) => `T${String(range(c.n, 1, 99999999)).padStart(8, '0')}`
const genBankCard = (c: Ctx) => `6222${String(range(c.n, 0, 999999999999)).padStart(12, '0')}`
const genFlag = (c: Ctx) => String(range(c.n, 0, 1))
const genStatus = (c: Ctx) => String(range(c.n, 0, 9))
/** 注释只说「日期/时间」时按 Java 类型给：LocalDate 给纯日期，其余给时间戳 */
const genDateText = (c: Ctx) =>
  /localdate$/i.test(c.javaType) ? '2026-01-01' : '2026-01-01 00:00:00'

/* ---------- 按字段名的语义规则 ---------- */

/**
 * PRD 4.4「根据字段名语义生成合理值」。
 *
 * 顺序有讲究，命中即返回：
 *   - password 必须排在 name 前面，否则 `password` 里的 `pass` 不冲突但
 *     `user_password` 会被后面更宽的规则抢走；
 *   - 具体的（email/phone）一律排在笼统的（code/status）前面；
 *   - `_id` 结尾排在数字规则前面：它是外键值，必须是小数字（见下面的注释）。
 */
const NAME_RULES: Array<[RegExp, (c: Ctx) => string]> = [
  [/pass(word|wd)?$|^pwd$|_pwd$/i, genPassword],
  [/e?mail/i, genEmail],
  [/(phone|mobile|tel)/i, genPhone],
  [/id_?card|card_?no/i, genIdCard],
  [/(^|_)(ip|ip_addr(ess)?)$/i, genIp],
  [/(avatar|photo|picture|^pic$|_pic$|image|^img$|_img$|icon|thumb)/i, genAvatar],
  [/(url|link|website|homepage|domain)/i, genUrl],
  [/(address|addr)/i, genAddress],
  [/(^|_)(sex|gender)$/i, genSex],
  [/(^|_)age$/i, genAge],
  [/(amount|price|money|fee|balance|salary|cost|total|discount)/i, genAmount],
  [/(longitude|latitude|^lng$|^lat$)/i, genLngLat],
  [/(name|nick|title)/i, genPersonName],
  [/(remark|memo|desc(ription)?|note|comment|content|reason)/i, genText],
  [/(json|config|extra|params|attrs?)$/i, genJson],
  [/(^|_)(no|code|sn|serial|number|batch)$/i, genCode],
  [/^(is|has|enable|disable)_|_(flag|deleted)$|^deleted$/i, genFlag],
  /*
   * xxx_id 是外键值，只能给小数字。
   * PRD 4.4 写的是「INT/BIGINT → 随机数字」，但真按随机给，生成的 INSERT
   * 一碰到外键约束就 1452 报错——而「可执行」是这个模式存在的全部理由。
   * 所以这条压在类型规则前面，给 1~5，指向种子数据里大概率存在的行。
   *
   * 裸 `id` 不走这条：它几乎一定是主键。压到 1~5 的话，点一次「重新生成」
   * 就很容易跟刚插进去的那行撞 UNIQUE——用户要的是换一套新主键，不是再抽一次 1~5。
   * 主键 id 在 autoValue 里按类型精度取宽区间，散列本身按 seed 稳定且互不重复。
   */
  [/_id$/i, (c) => String(range(c.n, 1, 5))],
  [/(status|state|type|kind|level|grade|sort|seq|version|score|rate|num|count|qty|quantity|stock|weight|priority)/i, genStatus],
]

/**
 * 注释里的业务词 → 值。**只有 APIForge 这条路走它**（见 mockValueOfField）。
 *
 * 为什么需要：字段名经常是中性的（`contact` / `attr` / `field1`），而作者一定
 * 会在注释里写清「手机号」。实测这类国内工程把约束写在注释里、字段名反倒看不出
 * 语义，出句的 Column 干脆没有 description 这个字段，所以这层只加在新路上。
 *
 * 只认「值长什么样」的词，不认业务规则——「必填」「不超过 50 字」那些归
 * cases/generate 的 bizRulesOf 管（造异常用例），两边刻意不重叠：一个决定
 * 正常用例发什么值，一个决定异常用例怎么违例。
 *
 * 顺序：具体的（身份证 / 银行卡 / 手机号）必须排在笼统的（编码 / 状态）前面。
 * 中文里「号」是共用后缀，反过来会把「手机号码」判成普通编码。
 */
const DESC_RULES: Array<[RegExp, (c: Ctx) => string]> = [
  [/身份证|证件号/, genIdCard],
  [/银行卡|卡号/, genBankCard],
  [/手机|电话/, genPhone],
  [/邮箱|邮件|e-?mail/i, genEmail],
  [/密码/, genPassword],
  [/ip\s*地址|IP地址/i, genIp],
  [/姓名|联系人|用户名|昵称|操作人/, genPersonName],
  [/地址|住址/, genAddress],
  [/金额|价格|单价|总价|总额|余额|费用|薪资|工资/, genAmount],
  [/百分比|比例|折扣|费率/, genPercent],
  [/数量|条数|个数|件数|次数/, genStatus], // 小整数：数量类给 0~9 比给 4711 更像真的
  [/日期|时间/, genDateText],
  [/编码|编号|单号|流水/, genCode],
  [/状态|类型|级别/, genStatus],
  [/网址|链接|域名|\burl\b/i, genUrl],
  [/备注|说明|描述|原因|内容|标题/, genText],
  [/年龄/, genAge],
  [/性别/, genSex],
  [/头像|照片|图片/, genAvatar],
]

/* ---------- 按类型的兜底规则 ---------- */

/**
 * DECIMAL / NUMERIC / NUMBER 的括号里是**精度**，是真的值域限制。
 * `INT(11)` 的括号只是显示宽度，跟能装多大无关，所以只认这三个类型。
 */
const PRECISION_TYPES = new Set(['decimal', 'numeric', 'number', 'dec'])

/** TINYINT 装不下 200。按类型收上界，否则 MySQL 直接 Out of range */
function intCeiling(type: string): number {
  const t = baseType(type)
  if (t === 'tinyint') return 127
  if (t === 'smallint' || t === 'int2') return 32767

  // Oracle 的 NUMBER(1) 只能装一位数，给 99999 会 ORA-01438（超出精度），
  // 而且是插入时才炸——生成的语句看着挺正常
  if (PRECISION_TYPES.has(t)) {
    const m = /\(\s*(\d+)\s*(?:,\s*(-?\d+)\s*)?\)/.exec(type)
    if (m) {
      const digits = Number(m[1]) - Math.max(0, Number(m[2] ?? 0))
      if (digits >= 1) return Math.min(10 ** digits - 1, 99999)
    }
  }
  return 99999
}

/**
 * DECIMAL(10,2) → 2。
 *
 * 没写 scale 的按 **0** 算：`DECIMAL(10)` 和 `NUMBER(25)` 在 MySQL / Oracle 里
 * scale 都默认是 0，也就是整数列。按 2 造出 `123.45` 塞进去，数据库会**静默四舍五入**成 123，
 * 不报错，回头对不上账还以为是自己算错了。
 * 完全没写括号的（裸 `DECIMAL` / 裸 `NUMBER`）才是浮点，按 2 位给。
 */
function decimalScale(type: string): number {
  const m = /\(\s*\d+\s*(?:,\s*(\d+)\s*)?\)/.exec(type)
  if (!m) return 2
  return m[1] === undefined ? 0 : Number(m[1])
}

/** ENUM('a','b') → ['a','b']；SET 同理 */
function enumOptions(type: string): string[] {
  const m = /^\s*(enum|set)\s*\((.*)\)\s*$/is.exec(type)
  if (!m) return []
  return [...m[2].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"))
}

function byType(c: Ctx): string {
  const { n, dialect } = c
  const t = baseType(c.type)
  const spec = DIALECTS[dialect]

  // tinyint(1) 在 MySQL 惯例里是布尔，javaType 已经识别过了，这里直接复用
  if (c.javaType === 'Boolean') return String(range(n, 0, 1))

  switch (c.javaType) {
    case 'Integer':
    case 'Long':
      return String(range(n, 1, intCeiling(c.type)))
    case 'Double':
    case 'java.math.BigDecimal': {
      const scale = decimalScale(c.type)
      const frac = String(range(n, 0, 10 ** scale - 1)).padStart(scale, '0')
      return scale > 0 ? `${range(n, 1, 999)}.${frac}` : String(range(n, 1, 999))
    }
    case 'java.time.LocalDateTime':
      return spec.now
    case 'java.time.LocalDate':
      return spec.today
    case 'java.time.LocalTime':
      return `${String(range(n, 0, 23)).padStart(2, '0')}:${String(range(n, 0, 59)).padStart(2, '0')}:00`
    case 'byte[]':
      // 二进制没有「合理的测试值」，硬造一个只会让人误以为有意义
      return 'NULL'
    case 'String': {
      const options = enumOptions(c.type)
      if (options.length) return pick(options, n)
      return `测试${t.startsWith('char') || t.startsWith('varchar') ? range(n, 1, 999) : '文本'}`
    }
    default:
      return 'NULL'
  }
}

/* ---------- 主流程 ---------- */

/** VARCHAR(4) 塞不进 6 个字的串，MySQL 会 1406 Data too long */
function clamp(text: string, length?: number): string {
  if (!length || text.length <= length) return text
  return text.slice(0, length)
}

const isAuditTime = (name: string) => isCreateTime(name) || isUpdateTime(name)

/**
 * 创建时间 / 更新时间要分得开：PRD 4.4 规定 UPDATE 时 create_time 保留原值不进 SET，
 * update_time 则要填 NOW()。放在这里是因为判断依据（字段名约定）跟取值规则是一套东西。
 * 覆盖 create_time / created_at / gmt_create 三种常见命名风格。
 */
export const isCreateTime = (name: string) =>
  /^(gmt_)?(create|created)_?(time|at|date)?$/i.test(name)

export const isUpdateTime = (name: string) =>
  /^(gmt_)?(update|updated|modify|modified|edit|edited)_?(time|at|date)?$/i.test(name)

/**
 * 算一列的自动值。规则优先级按 PRD 4.4 的表格从上到下：
 * 自增主键 → 审计时间 → 有 DEFAULT（仅 INSERT） → 可空抽 NULL → 字段名语义 → 类型兜底。
 *
 * 「有 DEFAULT 就用 DEFAULT」排在语义规则前面是照 PRD 写的。值得留个注意：
 * 这会让 `status TINYINT DEFAULT 0` 在 INSERT 里永远生成 0——但那确实是这行数据入库后的
 * 真实样子，比编一个 7 更符合「构造一条真实测试数据」的目的。
 */
function autoValue(
  tableName: string,
  column: Column,
  dialect: GenDialect,
  seed: number,
  phase: ValuePhase,
): string {
  const spec = DIALECTS[dialect]
  const n = derive(seed, phase, tableName, column.name)
  // 归一后才匹配：出句的列名是 snake_case（恒等变换），但用户导进来的表也可能
  // 用 camelCase 列名（userName / isDeleted），不归一会走错分支
  const normName = toSnake(column.name)

  if (isAuditTime(normName)) return spec.now

  // DEFAULT 只在 INSERT 阶段照抄。UPDATE 阶段跳过，因为 PRD 4.4 的 UPDATE 规则表要求
  // 「同 INSERT 规则自动生成新值」：`status TINYINT DEFAULT 0` 两个阶段都给 0 的话，
  // UPDATE 就成了把 0 改成 0 的空操作，跑完看不出任何变化。
  if (phase === 'insert' && column.defaultValue !== undefined) {
    const d = column.defaultValue.trim()
    // 存的是 SQL 字面量（见 ddlParser.readDefault），显示时把外层引号剥掉：
    // 显示值走 renderValue 会再加一遍引号，不剥就变成 ''pending''
    const quoted = /^'(.*)'$/s.exec(d)
    const text = quoted ? quoted[1].replace(/''/g, "'") : d
    // 两种默认值不能照抄，照抄了生成的语句插不进去：
    // DEFAULT '' 会让 NOT NULL 字段拿到空串（renderValue 把空串当 NULL），
    // DEFAULT NULL + NOT NULL 本身就是矛盾的 DDL。这两种都往下走语义规则。
    const contradictory = text === '' || (d.toUpperCase() === 'NULL' && !column.nullable)
    if (!contradictory) return text
  }

  // PRD 4.4：可为空字段 20% 概率生成 NULL。主键不参与——主键为空没有测试价值
  if (
    column.nullable &&
    !column.isPrimaryKey &&
    derive(seed, phase, tableName, column.name, 'null') % 5 === 0
  ) {
    return 'NULL'
  }

  const ctx: Ctx = {
    name: column.name,
    normName,
    javaType: column.javaType,
    type: column.type,
    dialect,
    n,
    person: pick(PEOPLE, derive(seed, phase, tableName, column.name, 'person')),
    length: (() => {
      const m = /\(\s*(\d+)/.exec(column.type)
      return m && /^(var)?char/i.test(baseType(column.type)) ? Number(m[1]) : undefined
    })(),
  }

  // 裸 id：主键取值走类型精度，不和外键 xxx_id 共用 1~5（见 NAME_RULES 注释）
  if (/^id$/i.test(normName)) return String(range(n, 1, intCeiling(column.type)))

  for (const [pattern, make] of NAME_RULES) {
    if (pattern.test(normName)) return clamp(make(ctx), ctx.length)
  }
  return clamp(byType(ctx), ctx.length)
}

/**
 * 给整张表算一遍自动值。UI 拿它渲染值编辑器，生成器拿它填 SQL。
 *
 * phase 默认 'insert'：绝大多数调用问的就是「这行数据插进去长什么样」。
 */
export function planValues(
  table: TableInfo,
  dialect: GenDialect,
  seed: number,
  phase: ValuePhase = 'insert',
): ValuePlan[] {
  return planColumns(table.name, table.columns, dialect, seed, phase)
}

/**
 * 同上，但直接吃「表名 + 列清单」。
 *
 * 给 APIForge 的前置数据用：那边只有库元数据（fetchColumns / 出句缓存里的 columns），
 * 构造不出 TableInfo 的 source / createdAt —— 那两个是缓存层的记账字段，
 * 跟取值规则一点关系都没有，不该为了取值去编一个。
 */
export function planColumns(
  tableName: string,
  columns: Column[],
  dialect: GenDialect,
  seed: number,
  phase: ValuePhase = 'insert',
): ValuePlan[] {
  return columns.map((column) => ({
    column,
    excluded: column.isAutoIncrement,
    auto: autoValue(tableName, column, dialect, seed, phase),
  }))
}

/* ---------- APIForge 的字段取值入口 ---------- */

/** APIForge 的字段形状：扫描器给的 Java 类型 + 注释。没有 SQL 类型，也没有表 */
export interface FieldLike {
  name: string
  javaType: string
  /** 声明长度上界。扫描器目前拿不到 @Size/列长度，留个口子，不传就不截 */
  length?: number
  /** Javadoc / @ApiModelProperty / @ApiParam 原文 */
  description?: string
}

/**
 * 这个 Java 类型该不该走语义字典。
 *
 * **只放 String**：数字、布尔、日期的既有兜底值（1 / true / 2026-01-01 00:00:00）
 * 本身就是合法参数，换成字典里的值反而会出事——`Integer` 字段拿到字符串
 * `T00000001` 直接 400，`Boolean` 拿到 `0/1`（Spring 不认，只认 true/false）
 * 也是 400。字典救的是**字符串字段的格式校验**（手机号 / 邮箱 / 订单号 /
 * 身份证），不是所有字段。
 *
 * 空类型名当 String 处理：扫描器认不出的类型基本都是字符串（枚举、泛型擦除
 * 后的裸 List 元素在别处兜底）。
 */
export function usesFieldDictionary(javaType: string): boolean {
  const t = javaType.trim()
  return t === '' || /^(string|char|character|text)$/i.test(t)
}

/**
 * 字段 → 显示值（塞进 URL / JSON body 的那种值）。
 *
 * 出句那条路走 planValues（列 + 表 + 方言的散列，值要能变成 SQL 字面量），
 * 这条路走字段自己的名字与注释。**共用同一批生成器和同一张规则表**，
 * 不另写一份——这个模块踩过「同一条规则有两份、然后只修好一份」的坑。
 *
 * 与出句的两处刻意差别：
 *   1. 日期 / 时间给**字面量**。出句要的是 SQL 表达式（Oracle 的 SYSDATE、
 *      MySQL 的 NOW()），照抄过来发进 HTTP 就是一个非法参数值。
 *   2. 认注释（DESC_RULES）。出句的 Column 没有 description；注释在 comment 里，
 *      而它的取值规则已经被 200+ 条单测钉死，不动。
 *
 * seed 默认 0：同一份源码每次生成同一套值。用例可复现、导出 diff 稳定，
 * 也让「这条用例上次发的什么值」有唯一答案。
 */
export function mockValueOfField(f: FieldLike, seed = 0): string {
  const normName = toSnake(f.name)
  const jt = f.javaType.trim().toLowerCase()

  // 注释只说「日期/时间」时按类型给，先于规则表拦一道（见上面差别 1）
  if (/localdatetime|timestamp|datetime|^date$/.test(jt)) return '2026-01-01 00:00:00'
  if (/localdate/.test(jt)) return '2026-01-01'
  if (/localtime/.test(jt)) return '00:00:00'

  const ctx: Ctx = {
    name: f.name,
    normName,
    javaType: f.javaType,
    type: f.javaType,
    // 这里用不到方言：能走到 byType 的类型分支只剩字符串与 byte[]，
    // 而日期分支已被上面拦掉。传 mysql 只是填满形状，不参与取值
    dialect: 'mysql',
    n: derive(seed, 'insert', '', f.name),
    person: pick(PEOPLE, derive(seed, 'insert', '', f.name, 'person')),
    length: f.length,
  }

  // 注释优先于字段名：注释是作者手写的业务语义（`contact` + 「手机号」），
  // 字段名只是它的一个可能是中性的缩写
  const desc = f.description ?? ''
  if (desc) {
    for (const [pattern, make] of DESC_RULES) {
      if (pattern.test(desc)) return clamp(make(ctx), ctx.length)
    }
  }

  if (/^id$/i.test(normName)) return String(range(ctx.n, 1, intCeiling(f.javaType)))
  for (const [pattern, make] of NAME_RULES) {
    if (pattern.test(normName)) return clamp(make(ctx), ctx.length)
  }
  return clamp(byType(ctx), ctx.length)
}

/* ---------- 显示值 → SQL 字面量 ---------- */

/**
 * 这些原样写进 SQL，不加引号。全大写比较，用户敲 now() 也认。
 *
 * TRUE / FALSE **故意不在这里**：Oracle 23c 以前没有布尔字面量，
 * 原样输出在 Oracle 里是 ORA-00904。它们交给下面按方言取值的 boolLiteral 处理。
 */
const RAW_EXPRESSIONS = new Set([
  'NULL',
  'DEFAULT',
  'NOW()',
  'SYSDATE',
  'CURRENT_TIMESTAMP',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'CURDATE()',
  'CURTIME()',
  'UUID()',
  'TRUNC(SYSDATE)',
])

const NUMERIC_JAVA_TYPES = new Set([
  'Integer',
  'Long',
  'Double',
  'java.math.BigDecimal',
  'Boolean',
])

/** 单引号必须翻倍，否则 O'Brien 会把语句断在半截——注入的形状也一样 */
const quoteLiteral = (text: string) => `'${text.replace(/'/g, "''")}'`

/**
 * 显示值 → 能直接执行的 SQL 片段。
 *
 * 空字符串一律当 NULL：用户把值清空就是想插 NULL。悄悄替换成 '' 的话，
 * NOT NULL 字段会「插进去了但值是空串」，比让数据库当场报错难查得多。
 */
export function renderValue(column: Column, text: string, dialect: GenDialect): string {
  const v = text.trim()
  if (v === '') return 'NULL'

  const upper = v.toUpperCase()
  // 布尔按方言给：Oracle 只认 1/0，照抄用户敲的 TRUE 会 ORA-00904。
  // 自动值本来就给 0/1（走下面的数字分支），这条只在用户手输 TRUE/FALSE 时命中。
  if (upper === 'TRUE' || upper === 'FALSE') {
    return DIALECTS[dialect].boolLiteral(upper === 'TRUE')
  }
  if (RAW_EXPRESSIONS.has(upper)) return upper

  if (NUMERIC_JAVA_TYPES.has(column.javaType) && /^-?\d+(\.\d+)?$/.test(v)) return v

  // 日期字面量交给方言：Oracle 必须 TO_DATE，其余方言裸字符串就行
  if (
    column.javaType.startsWith('java.time.Local') &&
    /^\d{4}-\d{1,2}-\d{1,2}( \d{1,2}:\d{2}(:\d{2})?)?$/.test(v)
  ) {
    return DIALECTS[dialect].dateLiteral(v)
  }

  return quoteLiteral(v)
}

/** 显示值的最终来源：用户改过就用改的，否则用自动算的 */
export const resolveValue = (plan: ValuePlan, overrides: ValueMap): string =>
  overrides[plan.column.name] ?? plan.auto

/* ---------- 唯一列掺批号（APIForge 造数会话用） ---------- */

/**
 * 唯一列的值掺进「批号」。固定 seed 复现的是「值长什么样」，批号保证的是「不跟
 * 库里已有的行撞键」——带唯一约束的列撞了键，整条 INSERT 当场报错，用例只能打空，
 * 这是造数路径上唯一会让「重复跑一轮」翻车的坑。
 *
 * 原位替换、不改变值的形状与长度：数字段把尾巴换成批号（手机号还是 138 开头、
 * 编码还是 T 前缀定长），邮箱插在 @ 前，没有数字也没有 @ 的就在尾部接（超过声明
 * 长度时截头保尾——尾巴才是会变的部分）。SQL 表达式（NOW() 等）与空值原样不动。
 */
export function uniqueize(column: Column, text: string, nonce: number): string {
  const v = text.trim()
  if (!v || RAW_EXPRESSIONS.has(v.toUpperCase())) return text
  const digits = String(nonce % 1000000).padStart(6, '0')
  const m = /\((\d+)/.exec(column.type)
  const length = m && /^(var)?char/i.test(baseType(column.type)) ? Number(m[1]) : undefined

  const at = v.indexOf('@')
  if (at > 0) {
    const k = Math.min(digits.length, Math.max(1, at))
    return v.slice(0, at - k) + digits.slice(-k) + v.slice(at)
  }
  const run = /(\d+)(\D*)$/.exec(v)
  if (run) {
    const old = run[1]!
    const rep =
      old.length <= digits.length
        ? digits.slice(-old.length)
        : old.slice(0, old.length - digits.length) + digits
    return v.slice(0, run.index) + rep + (run[2] ?? '')
  }
  const out = v + digits
  return length && out.length > length ? out.slice(out.length - length) : out
}
