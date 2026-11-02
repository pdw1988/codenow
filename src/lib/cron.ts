/**
 * Cron 表达式解析 + 「接下来几次什么时候跑」。PRD 二十。
 *
 * 规则本体放在 lib/ 做纯函数（无 React、无存储），是因为 cron 的坑**全在边界**：
 * `L` / `W` / `#`、月份星期的英文名、五段还是七段、以及「日」和「周」到底是并且
 * 还是或者。这些判断散在组件里就只能靠肉眼点，点不出来——所以这里每个判断都配了
 * 一条中文用例名（cron.test.ts），改规则先看哪几条红。
 *
 * 段数三种都收（只做五段的话，用 Spring `@Scheduled` 的人一条都验不了）：
 *   5 段 分 时 日 月 周        Linux crontab
 *   6 段 秒 分 时 日 月 周     Spring @Scheduled
 *   7 段 秒 分 时 日 月 周 年  Quartz
 *
 * 一条特别容易错的语义单独说：**「日」和「周」同时被限制时是「或」**（Vixie cron
 * 和 Quartz 都一样）。写成并且的话，`0 0 1 * 1`（每月 1 号或每周一）会被理解成
 * 「既是 1 号又是周一」，一年只剩几天——这是 cron 头号陷阱，dayMatches 里为此
 * 专门分了 domWild / dowWild 两支。
 */

/** 段在 sets 里的固定下标。dom/dow 那两格的或关系全靠它们同时有值来判断 */
const SEC = 0
const MIN = 1
const HOUR = 2
const DOM = 3
const MONTH = 4
const DOW = 5
const YEAR = 6

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

/** 星期英文名 → 0..6（0 = 周日）。大小写不敏感：crontab 里 JAN 和 jan 都认 */
const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

/** 星期中文名不带「周」字——拼接处自己加，否则「每周」+「周一」会念成「周周一」 */
const DOW_CN = ['日', '一', '二', '三', '四', '五', '六']
const MONTH_CN = ['', '1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月', '9 月', '10 月', '11 月', '12 月']

/** `@yearly` 这类宏。展开成等价的五段，不另写一套解析 */
const MACROS: Record<string, string> = {
  '@yearly': '0 0 0 1 1 *',
  '@annually': '0 0 0 1 1 *',
  '@monthly': '0 0 0 1 * *',
  '@weekly': '0 0 0 * * 0',
  '@daily': '0 0 0 * * *',
  '@midnight': '0 0 0 * * *',
  '@hourly': '0 0 * * * *',
}

/**
 * 往后算几年的 horizon。`0 0 0 29 2 ?`（2 月 29）要 4 年才等到一次，短于这个
 * 会被误判成「不触发」；10 年纯按天枚举也就 3660 次判定，毫秒级。
 */
const HORIZON_DAYS = 3660

export interface CronSchedule {
  /** 原文（去首尾空白后的小写形式不留，原文要能复制回去贴进 @Scheduled） */
  raw: string
  /** 每段展开后的取值集合，升序。年段为空数组 = 不限制 */
  sets: number[][]
  /** 日段是不是通配（`*` / `?`）——或关系的判据 */
  domWild: boolean
  /** 周段是不是通配 */
  dowWild: boolean
  /** `L` / `L-n`：相对月末的偏移，0 = 最后一天 */
  domLastOffsets: number[]
  /** `nW`：离 n 号最近的工作日 */
  domNearestWeekday: number[]
  /** `LW`：本月最后一个工作日 */
  domLastWeekday: boolean
  /** `5#3`：第几个星期几 */
  dowNth: Array<{ dow: number; nth: number }>
  /** `5L` / `FRIL`：本月最后一个星期几 */
  dowLast: number[]
  /** 是不是带秒（六段以上） */
  hasSeconds: boolean
  /** 年段有没有被限制（七段） */
  yearRestricted: boolean
}

export type CronParse =
  | { ok: true; schedule: CronSchedule }
  | { ok: false; error: string }

const daysInMonth = (y: number, m: number): number => new Date(y, m, 0).getDate()

/** 0 = 周日，跟 DOW_NAMES 同一套 */
const dowOf = (y: number, m: number, d: number): number => new Date(y, m - 1, d).getDay()

const isFull = (set: number[], lo: number, hi: number): boolean => set.length === hi - lo + 1

/**
 * 解析。失败时给「第几段 + 为什么不认」，不给一句笼统的「格式错误」——
 * 用户粘进来的表达式常常只错一个字符，指到段才算有用。
 */
export function parseCron(input: string): CronParse {
  const raw = (input ?? '').trim()
  if (!raw) return { ok: false, error: '表达式为空：请填写 cron 表达式' }

  const macro = MACROS[raw.toLowerCase()]
  const text = macro ?? raw
  const parts = text.split(/\s+/)
  if (parts.length > 7) {
    return {
      ok: false,
      error: `${parts.length} 个字段过多：cron 最多 7 段（秒 分 时 日 月 周 年）；5 段（分 时 日 月 周）为 Linux crontab，6 段（带秒）为 Spring @Scheduled`,
    }
  }

  /*
   * 段数还不够时也要把有的段先验一遍。这一页是「输入即解析」，用户打
   * `0 0/5 * * * ?` 的过程中一定经过 `0 0/` 这种两段的中间态——只回一句
   * 「2 段不认识」等于没告诉他哪儿错了，而这正是他最需要提示的时刻。
   * 中间态按 6 段的位置验（那是最全的布局，`0/` 这种语法错在任何布局里都是错）。
   */
  if (parts.length < 5) {
    const partial = validatePartial(parts)
    if (partial) return { ok: false, error: partial }
    return { ok: false, error: `字段不足：当前 ${parts.length} 段，至少 5 段（分 时 日 月 周）` }
  }

  const hasSeconds = parts.length >= 6
  // 五段时秒固定为 0；六段起第一段才是秒。年段七段才有
  const secText = hasSeconds ? parts[0] : '0'
  const minText = hasSeconds ? parts[1] : parts[0]
  const hourText = hasSeconds ? parts[2] : parts[1]
  const domText = hasSeconds ? parts[3] : parts[2]
  const monthText = hasSeconds ? parts[4] : parts[3]
  const dowText = hasSeconds ? parts[5] : parts[4]
  const yearText = parts.length === 7 ? parts[6] : ''

  /*
   * 周段要先按逗号切开：`5#3` / `FRIL` 这些 Quartz 形态不是数字，整段喂给
   * expandNumeric 会被一句「不认 "5#3"」打回来。只有纯数字的那些段才走数值展开；
   * 一个纯数字段都没有时（整段都是 `#` / `L`）取值集合必须是**空**而不是满——
   * 装满等于「每天都算」，跟 dom 的或关系一叠加就变成每天跑。
   */
  const dowParts = dowText.split(',').map((p) => p.trim()).filter(Boolean)
  const plainDows = dowParts.filter((p) => !isDowSpecialPart(p))

  const sec = expandNumeric(secText, 0, 59, '秒', 1, null)
  if ('error' in sec) return { ok: false, error: sec.error! }
  const min = expandNumeric(minText, 0, 59, '分', 1, null)
  if ('error' in min) return { ok: false, error: min.error! }
  const hour = expandNumeric(hourText, 0, 23, '时', 1, null)
  if ('error' in hour) return { ok: false, error: hour.error! }
  // 月份也允许回头：`NOV-FEB`（11 月到次年 2 月）是常见的跨年季度表达式
  const month = expandNumeric(monthText, 1, 12, '月', 4, MONTH_NAMES, true)
  if ('error' in month) return { ok: false, error: month.error! }

  // 星期要归一成 0..6：Quartz 用 1..7（1=周日），Vixie 用 0..6（0=周日），
  // 两边都认的话 7 也要能落回 0，否则 `0 0 0 * * 7`（每周日）会被判越界
  const dowRaw = plainDows.length
    ? expandNumeric(plainDows.join(','), 0, 7, '周', 5, DOW_NAMES, true)
    : { values: [] as number[], wild: false }
  if ('error' in dowRaw) return { ok: false, error: dowRaw.error! }
  const dow = { values: dowRaw.values!.map((v) => v % 7) }

  const dom = expandDayOfMonth(domText)
  if ('error' in dom) return { ok: false, error: dom.error! }
  const dowSpecial = expandDayOfWeekSpecial(dowText)
  if ('error' in dowSpecial) return { ok: false, error: dowSpecial.error! }

  let years: number[] = []
  if (yearText) {
    const y = expandNumeric(yearText, 1970, 2099, '年', 7, null)
    if ('error' in y) return { ok: false, error: y.error! }
    years = y.values!
  }

  // 「日」段的一部分语法（L/W）不是纯数字，先把数字部分择出来，剩下的按特殊形态判
  const domNumeric = dom.values ?? []
  const schedule: CronSchedule = {
    raw,
    sets: [sec.values!, min.values!, hour.values!, domNumeric, month.values!, dow.values, years],
    domWild: dom.wild,
    dowWild: dowSpecial.wild,
    domLastOffsets: dom.lastOffsets,
    domNearestWeekday: dom.nearestWeekday,
    domLastWeekday: dom.lastWeekday,
    dowNth: dowSpecial.nth,
    dowLast: dowSpecial.last,
    hasSeconds,
    yearRestricted: years.length > 0,
  }
  return { ok: true, schedule }
}

interface NumOk { values: number[]; wild: boolean }
interface NumErr { error: string; values?: never; wild?: never }

/** 周段里带 `#`（第几个星期）或以 `L` 结尾（最后一个）的片段不是数字 */
function isDowSpecialPart(p: string): boolean {
  return p.includes('#') || /l$/i.test(p)
}

/** 六段布局的段名与范围，给「还没打完」的中间态做位置校验 */
const LAYOUT6: Array<{ name: string; lo: number; hi: number; names: Record<string, number> | null }> = [
  { name: '秒', lo: 0, hi: 59, names: null },
  { name: '分', lo: 0, hi: 59, names: null },
  { name: '时', lo: 0, hi: 23, names: null },
  { name: '日', lo: 1, hi: 31, names: null },
  { name: '月', lo: 1, hi: 12, names: MONTH_NAMES },
  { name: '周', lo: 0, hi: 7, names: DOW_NAMES },
]

/** 中间态校验：按 6 段位置把已有的段各验一遍，返回第一条错误（全对则返回空串） */
function validatePartial(parts: string[]): string {
  for (let i = 0; i < parts.length; i++) {
    const spec = LAYOUT6[i]
    const r = expandNumeric(parts[i], spec.lo, spec.hi, spec.name, i + 1, spec.names, spec.name === '周' || spec.name === '月')
    if ('error' in r) return r.error!
  }
  return ''
}

/**
 * 展开一段数字字段：`*` `,` `-` `/` 四种组合 + 英文名。
 * `a/k` 是从 a 开始每 k 一个直到上界（crontab 的 `5/10` 就是这个意思，不是只出一个值）。
 */
function expandNumeric(
  text: string,
  lo: number,
  hi: number,
  name: string,
  no: number,
  names: Record<string, number> | null,
  allowWrap = false,
): NumOk | NumErr {
  const where = `第 ${no} 段（${name}）的 "${text}"`
  if (text === '*' || text === '?') return { values: range(lo, hi), wild: true }

  const out = new Set<number>()
  for (const partRaw of text.split(',')) {
    const part = partRaw.trim()
    if (!part) return { error: `${where} 存在空的逗号分段` }

    const slash = part.indexOf('/')
    const stepText = slash >= 0 ? part.slice(slash + 1) : '1'
    const base = slash >= 0 ? part.slice(0, slash) : part
    if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
      return { error: `${where} 的步长 "${stepText}" 必须为不小于 1 的整数` }
    }
    const step = Number(stepText)
    if (step > hi - lo + 1) return { error: `${where} 的步长 ${step} 超过该字段取值范围` }

    let from: number
    let to: number
    if (base === '*' || base === '?') {
      from = lo
      to = hi
    } else {
      const dash = base.indexOf('-')
      const a = parseOne(dash >= 0 ? base.slice(0, dash) : base, lo, hi, names)
      if (a === null) return { error: `${where} 无法识别 "${base}"${hint(name, lo, hi, names)}` }
      if (dash >= 0) {
        const b = parseOne(base.slice(dash + 1), lo, hi, names)
        if (b === null) return { error: `${where} 的范围终点 "${base.slice(dash + 1)}" 无法识别` }
        if (a <= b) {
          from = a
          to = b
        } else if (allowWrap) {
          // 星期和月份允许回头：`FRI-MON`（周五到周一）、`NOV-FEB`。别的段回头
          // 只会是笔误（`10-2` 点时），不给放行
          for (let v = a; v <= hi; v += step) out.add(v)
          for (let v = lo; v <= b; v += step) out.add(v)
          continue
        } else {
          return { error: `${where} 的范围 ${a}-${b} 起止颠倒（起点大于终点）` }
        }
      } else {
        // `a/k`：从 a 开始每 k 一个跑到上界
        from = a
        to = slash >= 0 ? hi : a
      }
    }
    if (from < lo || to > hi) return { error: `${where} 超出取值范围 ${lo}~${hi}` }
    for (let v = from; v <= to; v += step) out.add(v)
  }

  if (out.size === 0) return { error: `${where} 未匹配到任何取值` }
  return { values: [...out].sort((x, y) => x - y), wild: false }
}

function parseOne(
  t: string,
  lo: number,
  hi: number,
  names: Record<string, number> | null,
): number | null {
  const s = t.trim()
  if (!s) return null
  if (names && /^[A-Za-z]+$/.test(s)) {
    const v = names[s.toLowerCase()]
    return v === undefined ? null : v
  }
  if (!/^\d+$/.test(s)) return null
  const v = Number(s)
  return v >= lo && v <= hi ? v : null
}

function hint(name: string, lo: number, hi: number, names: Record<string, number> | null): string {
  if (names === MONTH_NAMES) return `（月可以是 1~12，也可以是 JAN~DEC）`
  if (names === DOW_NAMES) return `（周可以是 0~7，也可以是 SUN~SAT）`
  return `（${name}的范围是 ${lo}~${hi}）`
}

interface DomOk {
  values: number[]
  wild: boolean
  lastOffsets: number[]
  nearestWeekday: number[]
  lastWeekday: boolean
}

/**
 * 日段：数字之外还有 Quartz 的 `L`（最后一天）、`L-n`（倒数第 n 天）、
 * `nW`（离 n 号最近的工作日）、`LW`（本月最后一个工作日）。
 * 这些不是集合能表达的（取决于那个月有几天），只能按日期现场判。
 */
function expandDayOfMonth(text: string): DomOk | NumErr {
  const where = `第 3 段（日）的 "${text}"`
  const empty: DomOk = { values: [], wild: false, lastOffsets: [], nearestWeekday: [], lastWeekday: false }
  if (text === '*' || text === '?') {
    return { ...empty, values: range(1, 31), wild: true }
  }
  const values = new Set<number>()
  const lastOffsets: number[] = []
  const nearestWeekday: number[] = []
  let lastWeekday = false

  for (const partRaw of text.split(',')) {
    const part = partRaw.trim()
    if (!part) return { error: `${where} 存在空的逗号分段` }
    if (/^lw$/i.test(part)) {
      lastWeekday = true
      continue
    }
    const lm = /^l(?:-(\d+))?$/i.exec(part)
    if (lm) {
      const off = lm[1] ? Number(lm[1]) : 0
      if (off > 30) return { error: `${where} 的 L-${off} 超过单月天数` }
      lastOffsets.push(off)
      continue
    }
    const wm = /^(\d+)w$/i.exec(part)
    if (wm) {
      const d = Number(wm[1])
      if (d < 1 || d > 31) return { error: `${where} 的 ${d}W 超出取值范围 1~31` }
      nearestWeekday.push(d)
      continue
    }
    const n = expandNumeric(part, 1, 31, '日', 3, null)
    if ('error' in n) return { error: n.error! }
    for (const v of n.values!) values.add(v)
  }
  return {
    values: [...values].sort((a, b) => a - b),
    wild: false,
    lastOffsets,
    nearestWeekday,
    lastWeekday,
  }
}

interface DowSpecialOk {
  wild: boolean
  nth: Array<{ dow: number; nth: number }>
  last: number[]
}

/**
 * 周段：数字部分已经在 expandNumeric 展开过，这里只摘 Quartz 的 `#` 和 `L`。
 * `5#3` = 每月第三个星期五，`5L` / `FRIL` = 每月最后一个星期五。
 * 裸 `L` 在周段是 Quartz 的「周六」（7 的别名），顺手认了。
 */
function expandDayOfWeekSpecial(text: string): DowSpecialOk | NumErr {
  const where = `第 5 段（周）的 "${text}"`
  if (text === '*' || text === '?') return { wild: true, nth: [], last: [] }
  const nth: Array<{ dow: number; nth: number }> = []
  const last: number[] = []

  for (const partRaw of text.split(',')) {
    const part = partRaw.trim()
    if (!part) return { error: `${where} 存在空的逗号分段` }
    const hm = /^(.+)#(\d+)$/.exec(part)
    if (hm) {
      const d = parseOne(hm[1], 0, 7, DOW_NAMES)
      const nthN = Number(hm[2])
      if (d === null) return { error: `${where} 的 "${hm[1]}" 不是有效的星期（0~7 或 SUN~SAT）` }
      if (nthN < 1 || nthN > 5) return { error: `${where} 的 #${nthN} 仅支持 1~5（单月最多 5 个相同星期）` }
      nth.push({ dow: d % 7, nth: nthN })
      continue
    }
    const lm = /^(.+)l$/i.exec(part)
    if (lm) {
      if (/^l$/i.test(lm[1])) {
        last.push(6) // 裸 L = 周六
        continue
      }
      const d = parseOne(lm[1], 0, 7, DOW_NAMES)
      if (d === null) return { error: `${where} 的 "${lm[1]}L" 不是有效的星期` }
      last.push(d % 7)
      continue
    }
  }
  return { wild: false, nth, last }
}

function range(lo: number, hi: number): number[] {
  const out: number[] = []
  for (let v = lo; v <= hi; v++) out.push(v)
  return out
}

/** 这一天跑不跑。或关系的全部逻辑都在这里 */
function dayMatches(s: CronSchedule, y: number, m: number, d: number): boolean {
  if (s.yearRestricted && !s.sets[YEAR].includes(y)) return false
  if (!s.sets[MONTH].includes(m)) return false

  const domOk = domDayOk(s, y, m, d)
  const dowOk = dowDayOk(s, y, m, d)
  // 两头都是通配时是并且（其中一头恒真，结果等于另一头）；两头都限死时是**或**
  if (s.domWild || s.dowWild) return domOk && dowOk
  return domOk || dowOk
}

function domDayOk(s: CronSchemaDay, y: number, m: number, d: number): boolean {
  let ok = s.domWild || s.sets[DOM].includes(d)
  const total = daysInMonth(y, m)
  if (!ok) {
    for (const off of s.domLastOffsets) {
      if (total - off === d) ok = true
    }
  }
  if (!ok) {
    for (const n of s.domNearestWeekday) {
      const target = Math.min(n, total)
      const w = dowOf(y, m, target)
      let day = target
      if (w === 6) day = target - 1 // 周六往前找工作日；撞到上个月就不跳（Quartz 同款）
      else if (w === 0) day = target + 1 > total ? target - 2 : target + 1 // 周日往后，月末则退到周五
      if (day === d) ok = true
    }
  }
  if (!ok && s.domLastWeekday) {
    let day = total
    const w = dowOf(y, m, day)
    if (w === 6) day -= 1
    else if (w === 0) day -= 2
    if (day === d) ok = true
  }
  return ok
}

type CronSchemaDay = CronSchedule

function dowDayOk(s: CronSchedule, y: number, m: number, d: number): boolean {
  const w = dowOf(y, m, d)
  let ok = s.dowWild || s.sets[DOW].includes(w)
  const total = daysInMonth(y, m)
  if (!ok) {
    for (const { dow, nth } of s.dowNth) {
      if (w === dow && Math.floor((d - 1) / 7) + 1 === nth) ok = true
    }
  }
  if (!ok) {
    for (const dow of s.dowLast) {
      if (w === dow && d + 7 > total) ok = true
    }
  }
  return ok
}

/**
 * 接下来 count 次触发时间（严格晚于 from）。围绕「先按天筛，再按时刻枚举」写的：
 * 按时间递增硬推要处理秒/分/时的进位和 L、W 这些月级规则，写出来一定错；
 * 按天筛 + 天内按集合枚举，每个集合天然升序，顺序白送。
 */
export function nextRuns(s: CronSchedule, from: Date, count = 5): Date[] {
  const out: Date[] = []
  let y = from.getFullYear()
  let m = from.getMonth() + 1
  let d = from.getDate()

  for (let guard = 0; guard <= HORIZON_DAYS && out.length < count; guard++) {
    // 年段限死时整年整年地跳，别一天一天磨（`? 2026` 这种能省三千次判定）
    if (s.yearRestricted && !s.sets[YEAR].includes(y)) {
      const next = s.sets[YEAR].find((v) => v > y)
      if (next === undefined) break
      y = next
      m = 1
      d = 1
      continue
    }
    if (dayMatches(s, y, m, d)) {
      for (const hh of s.sets[HOUR]) {
        for (const mm of s.sets[MIN]) {
          for (const ss of s.sets[SEC]) {
            if (out.length >= count) return out
            const dt = new Date(y, m - 1, d, hh, mm, ss, 0)
            /*
             * 夏令时那个不存在的钟点：`new Date(2026, 2, 8, 2, 30)` 在跳天的
             * 时区会被 JS 悄悄推成 3:30。分量对不上就说明这个本地时间不存在，
             * 跳过它——不跳过的话我们会告诉用户一个当天不会发生的时刻。
             * （跨时区、只改偏移不改时钟的地区仍然只能按本机时区算，这是上限）
             */
            if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d
                || dt.getHours() !== hh || dt.getMinutes() !== mm || dt.getSeconds() !== ss) continue
            if (dt.getTime() > from.getTime()) out.push(dt)
          }
        }
      }
    }
    const total = daysInMonth(y, m)
    if (d < total) d++
    else if (m < 12) {
      m++
      d = 1
    } else {
      y++
      m = 1
      d = 1
    }
  }
  return out
}

/**
 * 解读：把表达式翻译成一句中文。日期在前、时刻在后，用的是术语不是口语——
 * 用户看得见的每个词都要能对回 cron 规范里的概念（工作日、第 k 个星期 n）。
 */
export function describeCron(s: CronSchedule): string {
  const date = describeDate(s)
  const time = describeTime(s)
  const both = !s.domWild && !s.dowWild ? '（日与星期为「或」，满足其一即触发）' : ''
  const years = s.yearRestricted ? `仅 ${s.sets[YEAR].join('、')} 年` : ''
  return [years, date + both, time].filter(Boolean).join(' ')
}

function describeDate(s: CronSchedule): string {
  const months = s.sets[MONTH].length === 12 ? '' : s.sets[MONTH].map((m) => MONTH_CN[m]).join('、')
  const dom = describeDom(s)
  const dow = describeDow(s)
  let dayPart: string
  if (s.domWild && s.dowWild) dayPart = '每天'
  else if (!s.domWild && s.dowWild) dayPart = dom
  else if (s.domWild && !s.dowWild) dayPart = dow
  else dayPart = `${dom}或${dow}`

  if (!months) return dayPart
  // 月份和「每月」分开写会念成「1 月每月 1 日」，月份限死时把「每月」并进去
  if (dayPart.startsWith('每月 ')) return `${months} ${dayPart.slice(3)}`
  return `${months} ${dayPart}`
}

function describeDom(s: CronSchedule): string {
  const bits: string[] = []
  if (s.sets[DOM].length) bits.push(`${s.sets[DOM].join('、')} 日`)
  if (s.domLastOffsets.includes(0)) bits.push('最后一天')
  for (const off of s.domLastOffsets) if (off > 0) bits.push(`倒数第 ${off} 天`)
  for (const n of s.domNearestWeekday) bits.push(`距 ${n} 日最近的工作日`)
  if (s.domLastWeekday) bits.push('最后一个工作日')
  return bits.length ? `每月 ${bits.join('、')}` : '每天'
}

function describeDow(s: CronSchedule): string {
  const parts: string[] = []
  /*
   * 周一至周五整段命中时说「工作日」——这是真实 crontab 里出现最多的一条
   * （"0 0 9 * * MON-FRI"）。逐个念成「每周一、周二、周三、周四、周五」会把后面的
   * 时刻挤到句子末尾，而用户要看的是「09:00」。只整段相等才塌：少一天
   * （MON-WED）不是「工作日」，照实列出来，别替用户把范围说大。
   */
  const weekdays = [1, 2, 3, 4, 5]
  if (s.sets[DOW].length === 5 && weekdays.every((d) => s.sets[DOW].includes(d))) parts.push('工作日')
  else if (s.sets[DOW].length) parts.push(s.sets[DOW].map((d) => `周${DOW_CN[d]}`).join('、'))
  for (const { dow, nth } of s.dowNth) parts.push(`每月第 ${nth} 个周${DOW_CN[dow]}`)
  for (const dow of s.dowLast) parts.push(`每月最后一个周${DOW_CN[dow]}`)
  if (!parts.length) return '每天'
  const joined = parts.join('、')
  // 「每工作日」不是中文说法，整段是工作日时把「每」摘掉
  return joined === '工作日' ? joined : `每${joined}`
}

const hhmm = (n: number) => String(n).padStart(2, '0')

function describeTime(s: CronSchedule): string {
  const [sec, min, hour] = [s.sets[SEC], s.sets[MIN], s.sets[HOUR]]
  if (isFull(sec, 0, 59) && isFull(min, 0, 59) && isFull(hour, 0, 23)) return '每秒'

  const secFull = isFull(sec, 0, 59)
  // 秒段固定成单值时最常见（第 0 秒 = 默认，不说；第 30 秒要说）
  const secFixed = sec.length === 1 ? sec[0] : null
  const secTail = !s.hasSeconds || secFixed === 0
    ? ''
    : secFull ? '每秒' : secFixed !== null ? `第 ${secFixed} 秒` : describeStep(sec, '秒', '秒', 59)

  /*
   * 分、时整段通配时别落到下面那个循环 —— 它会一段都不念，整句只剩下日期。
   * 「每分钟」在术语里就是每分钟，说成「每秒」反而是错的（秒段未必通配）。
   */
  if (isFull(min, 0, 59) && isFull(hour, 0, 23)) return '每分钟'
  // 只有分固定成单值（`0 0 * * * ?`）是「每小时」：整点触发，不是「每天第 0 分」
  if (isFull(hour, 0, 23) && min.length === 1) return '每小时'

  /*
   * 时刻能列全（小时 × 分钟 ≤ 6 个组合）时直接给墙上时间：术语里「09:00」比
   * 「第 9 点第 0 分」短，也不会跟段位名字混。列不全（`0/5` 分钟这种）退回
   * 「每 N 分钟」的说法——那种表达式本来就是按间隔描述，不靠时刻。
   */
  if (!isFull(hour, 0, 23) && !isFull(min, 0, 59) && hour.length * min.length <= 6) {
    const clock: string[] = []
    for (const h of hour) {
      for (const m of min) {
        clock.push(secFixed !== null && secFixed !== 0 ? `${hhmm(h)}:${hhmm(m)}:${hhmm(secFixed)}` : `${hhmm(h)}:${hhmm(m)}`)
      }
    }
    return [clock.join('、'), secTail].filter(Boolean).join('，')
  }

  const bits: string[] = []
  if (!isFull(hour, 0, 23)) {
    const w = describeStep(hour, '小时', '时', 23)
    bits.push(w ?? `第 ${hour.join('、')} 时`)
  }
  if (!isFull(min, 0, 59)) {
    const w = describeStep(min, '分钟', '分', 59)
    bits.push(w ?? `第 ${min.join('、')} 分`)
  }
  if (secTail) bits.push(secTail)
  return bits.join('，')
}

/**
 * 等差数列的一段说成「每 N 分钟（自第 a 分起）」；不是纯等差返回 null。
 * 括号里用单字单位（分 / 秒）——「自第 0 钟起」不是中文。
 */
function describeStep(set: number[], unit: string, short: string, hi: number): string | null {
  const st = arith(set, hi)
  return st ? `每 ${st.step} ${unit}（自第 ${st.from} ${short}起）` : null
}

/** 是不是「从 a 开始每 step 一个直到上界」的等差数列。返回 null 表示不是 */
function arith(set: number[], hi: number): { from: number; step: number } | null {
  if (set.length < 2) return null
  const step = set[1] - set[0]
  if (step < 1) return null
  for (let i = 1; i < set.length; i++) if (set[i] - set[i - 1] !== step) return null
  if (set[set.length - 1] + step <= hi) return null // 没跑到上界就不是纯等差
  return { from: set[0], step }
}
