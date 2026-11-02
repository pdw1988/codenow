/**
 * logback pattern → 行解析器（码上追的第一步）。
 *
 * 思路：把 pattern 编译成一个锚定整行的正则 + 捕获组字段表；每一行试一次匹配，
 * 匹配上是记录头，匹配不上是堆栈 / 多行续行（records.ts 负责归组）。Rust 只回原始
 * 字节，解码与解析全在前端——纯函数，TDD。
 *
 * 已知取舍：线程名按「不含空格和方括号」处理（`[%thread]` 和裸排都成立，线程名带
 * 空格极罕见）；月名（MMM）/ 星期 / 十二小时制（hh）等格式直接报人话 error，不硬
 * 猜——日期列猜错的代价是整列乱，宁可让用户改格式。
 */

export type LogFieldKind =
  | 'ts'
  | 'level'
  | 'thread'
  | 'logger'
  | 'msg'
  | 'mdc'
  /** 捕获但不上屏：%line / %method / %class——pattern 里有它们才能对上行，行号本身不单独成列 */
  | 'lineNo'
  | 'method'
  | 'cls'

export interface CompiledPattern {
  regex: RegExp
  /** 捕获组顺序对应的字段种类 */
  fields: LogFieldKind[]
  /** fields 里每个 mdc 捕获组对应的 %X{名字}（无名按出现顺序编号） */
  mdcNames: string[]
  /** fields 里有 ts 时的原始格式，给 parseStamp 用；没有 ts 字段为 null */
  tsFormat: string | null
}

export interface ParsedHead {
  ts?: string
  level?: string
  thread?: string
  logger?: string
  msg: string
  mdc: Record<string, string>
}

type Compiled = CompiledPattern | { error: string }

const FMT_RE: Record<string, string> = {
  yyyy: '\\d{4}',
  yy: '\\d{2}',
  MM: '\\d{2}',
  dd: '\\d{2}',
  HH: '\\d{2}',
  mm: '\\d{2}',
  ss: '\\d{2}',
  SSS: '\\d{3}',
}

type FmtSeg = { f: string; len: number } | { lit: string } | { zone: true }

const ZONE_RE = '(?:Z|[+-]\\d{2}(?::?\\d{2})?)'

/** logback 的具名日期格式：%d{ISO8601} 是 Spring / 老工程里常见写法 */
const NAMED_FMT: Record<string, string> = {
  ISO8601: 'yyyy-MM-dd HH:mm:ss,SSS',
}

/**
 * %d{} 的参数 → 日期格式。`%d{HH:mm:ss, Asia/Shanghai}` 逗号后是时区选项要剥掉；
 * 但 `HH:mm:ss,SSS` 的逗号是毫秒分隔——只认「逗号后跟空白」或带斜杠的时区名
 */
function dateFormatOf(arg: string | null): string {
  let fmt = arg ?? 'yyyy-MM-dd HH:mm:ss,SSS'
  const tz = /,(\s+\S.*|\s*[A-Za-z_]+\/[A-Za-z_/]+\s*)$/.exec(fmt)
  if (tz) fmt = fmt.slice(0, tz.index)
  fmt = fmt.trim()
  return NAMED_FMT[fmt] ?? fmt
}

/** 日期格式 → 定长段序列；不认识的记号（月名 / 星期 / 十二小时 / 不补零）报人话 */
function scanFormat(fmt: string): FmtSeg[] | { error: string } {
  const out: FmtSeg[] = []
  let i = 0
  let lit = ''
  const flush = () => {
    if (lit) {
      out.push({ lit })
      lit = ''
    }
  }
  while (i < fmt.length) {
    // 单引号包的是字面量（Spring Boot 的 yyyy-MM-dd'T'HH:mm:ss）；'' 是一个单引号
    if (fmt[i] === "'") {
      const close = fmt.indexOf("'", i + 1)
      if (close < 0) return { error: '日期格式里的单引号没闭合' }
      lit += close === i + 1 ? "'" : fmt.slice(i + 1, close)
      i = close + 1
      continue
    }
    // 时区偏移（X / XX / XXX / Z）：只吞掉不参与换算——日志按本机时区读，同一份里偏移恒定
    const z = /^(X{1,3}|Z)/.exec(fmt.slice(i))
    if (z?.[1]) {
      flush()
      out.push({ zone: true })
      i += z[1].length
      continue
    }
    const m = /^(yyyy|yy|MM|dd|HH|mm|ss|SSS)/.exec(fmt.slice(i))
    if (m?.[1]) {
      flush()
      const f = m[1]
      out.push({ f, len: f === 'yyyy' ? 4 : f === 'SSS' ? 3 : 2 })
      i += f.length
      continue
    }
    const ch = fmt[i] ?? ''
    if (/[A-Za-z]/.test(ch)) {
      flush()
      const bad = /^[A-Za-z]+/.exec(fmt.slice(i))?.[0] ?? ch
      return { error: `日期格式里的 ${bad} 还不支持（只支持 yyyy yy MM dd HH mm ss SSS、ISO8601）` }
    }
    lit += ch
    i++
  }
  flush()
  return out
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const CONV_ALIAS: Record<string, LogFieldKind> = {
  d: 'ts',
  date: 'ts',
  p: 'level',
  level: 'level',
  t: 'thread',
  thread: 'thread',
  c: 'logger',
  lo: 'logger',
  logger: 'logger',
  m: 'msg',
  msg: 'msg',
  message: 'msg',
  X: 'mdc',
  mdc: 'mdc',
  L: 'lineNo',
  line: 'lineNo',
  M: 'method',
  method: 'method',
  C: 'cls',
  class: 'cls',
}

/** 异常转换器：堆栈本来就在下面几行，头行里它们输出空，编译成空串 */
const EXCEPTION_CONVS = new Set(['ex', 'exception', 'throwable', 'xEx', 'xException', 'xThrowable', 'rEx', 'rootException', 'wEx', 'wex', 'nopex', 'nopexception'])

/**
 * Spring Boot 的写法预处理：%clr(内容){颜色} 只是上色，剥成「内容」；
 * ${PID:- } 这类变量在运行时才展开，换成占位（编译时当一段非空白）
 */
function unwrapSpring(text: string): string {
  let t = text
  for (let guard = 0; guard < 20; guard++) {
    const i = t.indexOf('%clr(')
    if (i < 0) break
    let depth = 1
    let k = i + 5
    while (k < t.length && depth > 0) {
      if (t[k] === '(') depth++
      else if (t[k] === ')') depth--
      k++
    }
    const inner = t.slice(i + 5, k - 1)
    let rest = t.slice(k)
    if (rest.startsWith('{')) rest = rest.slice(rest.indexOf('}') + 1)
    t = t.slice(0, i) + inner + rest
  }
  return t.replace(/\$\{[^}]*\}/g, '\u0000VAR\u0000')
}

export function compilePattern(pattern: string): Compiled {
  const text = unwrapSpring(pattern.trim())
  if (!text) return { error: 'pattern 是空的' }

  // 切词：字面量 / 转换器（含 %-5 这类旗标和 {参数}；%% 转义成字面 %）
  type Tok = { lit: string } | { conv: string; arg: string | null }
  const toks: Tok[] = []
  let i = 0
  let lit = ''
  const flush = () => {
    if (lit) {
      toks.push({ lit })
      lit = ''
    }
  }
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (text.startsWith('\u0000VAR\u0000', i)) {
      flush()
      toks.push({ conv: '$var', arg: null })
      i += 5
      continue
    }
    if (ch === '%' && text[i + 1] === '%') {
      lit += '%'
      i += 2
      continue
    }
    if (ch === '%') {
      // 旗标/宽度在转换器名前面：%-5level、%5.10logger——先吃数字段再吃字母
      const m = /^(-?\d+(?:\.\d+)?)?([A-Za-z]+)/.exec(text.slice(i + 1))
      if (!m?.[2]) {
        // 孤立 %（比如「100%完成」）当字面量
        lit += ch
        i++
        continue
      }
      let j = i + 1 + m[0].length
      let arg: string | null = null
      if (text[j] === '{') {
        let depth = 1
        let k = j + 1
        while (k < text.length && depth > 0) {
          const c = text[k]
          if (c === '{') depth++
          else if (c === '}') depth--
          k++
        }
        arg = text.slice(j + 1, k - 1)
        j = k
      }
      flush()
      toks.push({ conv: m[2], arg })
      i = j
      continue
    }
    lit += ch
    i++
  }
  flush()

  const fields: LogFieldKind[] = []
  const mdcNames: string[] = []
  let tsFormat: string | null = null
  const parts: string[] = []
  for (let ti = 0; ti < toks.length; ti++) {
    const t = toks[ti]!
    if ('lit' in t) {
      // 字面量分隔符里的空格串放行成 \s+：%-5level 会把 INFO 补位成「INFO  」
      parts.push(escapeRegex(t.lit).replace(/ +/g, '\\s+'))
      continue
    }
    // 换行只可能出现在行尾（行早已拆好），给可选匹配
    if (t.conv === 'n') {
      parts.push('\\r?\\n?')
      continue
    }
    if (EXCEPTION_CONVS.has(t.conv)) continue
    if (t.conv === '$var') {
      parts.push('\\S*')
      continue
    }
    const kind = CONV_ALIAS[t.conv]
    if (!kind) {
      return {
        error: `转换器 %${t.conv} 还不支持（支持 d/date p/level t/thread c/logger m/msg X/mdc L/line M/method C/class n）`,
      }
    }
    if (kind === 'ts') {
      if (tsFormat !== null) return { error: '一个 pattern 里只支持一个日期字段' }
      const fmt = dateFormatOf(t.arg)
      const segs = scanFormat(fmt)
      if ('error' in segs) return segs
      tsFormat = fmt
      fields.push('ts')
      parts.push(
        '(' +
          segs.map((s) => ('f' in s ? FMT_RE[s.f] ?? '' : 'zone' in s ? ZONE_RE : escapeRegex(s.lit))).join('') +
          ')',
      )
      continue
    }
    if (kind === 'level') {
      fields.push('level')
      // %5level 是左补空格（右对齐）：「] INFO」——前面紧贴字面量时空格无处可吸，这里兜住
      parts.push('\\s*([A-Z]+)')
      continue
    }
    if (kind === 'thread') {
      fields.push('thread')
      const prev = toks[ti - 1]
      const next = toks[ti + 1]
      const bracketed = !!prev && 'lit' in prev && prev.lit.endsWith('[') && !!next && 'lit' in next && next.lit.startsWith(']')
      // [%thread] 两边是方括号时线程名可以带空格（undertow 的「XNIO-1 task-2」、
      // RMI 的「RMI TCP Connection(3)-10.0.0.1」），一直吃到右括号；裸排才按不含空格算，
      // 且裸排 %t 的输出常常自带 [main]，括号可选
      parts.push(bracketed ? '([^\\]]+)' : '(\\[?[^\\s\\[\\]]+\\]?)')
      continue
    }
    if (kind === 'logger') {
      fields.push('logger')
      parts.push('(\\S+)')
      continue
    }
    if (kind === 'msg') {
      fields.push('msg')
      parts.push('(.*)')
      continue
    }
    if (kind === 'lineNo') {
      fields.push('lineNo')
      parts.push('(\\d+)')
      continue
    }
    if (kind === 'method' || kind === 'cls') {
      fields.push(kind)
      parts.push('(\\S+)')
      continue
    }
    fields.push('mdc')
    mdcNames.push(t.arg ?? `mdc${mdcNames.length + 1}`)
    // 可以是空的：定时任务 / MQ 线程没有 traceId，打出来是「[]」——写成 \S+ 会让
    // 这些行整行认不出头，被并进上一条当堆栈
    parts.push('(\\S*)')
  }
  try {
    return { regex: new RegExp('^' + parts.join('') + '$'), fields, mdcNames, tsFormat }
  } catch (e) {
    return { error: `pattern 编译失败：${String(e)}` }
  }
}

export function parseLineWith(line: string, p: CompiledPattern): ParsedHead | null {
  const m = p.regex.exec(line)
  if (!m) return null
  const head: ParsedHead = { msg: '', mdc: {} }
  let mdcI = 0
  for (let i = 0; i < p.fields.length; i++) {
    const v = m[i + 1]
    if (v === undefined) continue
    const f = p.fields[i]
    if (f === 'ts') head.ts = v
    else if (f === 'level') head.level = v
    // 裸排 %t 的输出常自带 [main]：剥掉方括号，[%thread] 的字面量写法本来就干净
    // [%15.15t] 这种定宽写法括号里带补位空格，一并裁掉
    else if (f === 'thread') head.thread = v.charCodeAt(0) === 91 ? v.replace(/^\[(.*)\]$/, '$1').trim() : v.trim()
    else if (f === 'logger') head.logger = v
    else if (f === 'msg') head.msg = v
    // lineNo / method / cls：只占捕获组让 pattern 对得上行，不进头
    else if (f === 'lineNo' || f === 'method' || f === 'cls') {
      /* noop */
    } else head.mdc[p.mdcNames[mdcI++] ?? `mdc${mdcI + 1}`] = v
  }
  return head
}

/** 每行都要解时间：格式串只扫一遍，几十万行重复扫是大日志「最后卡一下」的大头 */
const fmtCache = new Map<string, FmtSeg[] | { error: string }>()
/** 年月日时 → 整点的本地毫秒数；null = 日期不存在 */
const hourCache = new Map<number, number | null>()

/** 日志时间是本机时间：按本地时区解析（new Date(y, m-1, …)），别用 UTC 硬套 */
export function parseStamp(text: string, fmt: string): number | null {
  let segs = fmtCache.get(fmt)
  if (!segs) {
    segs = scanFormat(fmt)
    fmtCache.set(fmt, segs)
  }
  if ('error' in segs) return null
  let ti = 0
  let y = 0
  let mo = 1
  let d = 1
  let H = 0
  let mi = 0
  let s = 0
  let ms = 0
  const take = (len: number): number | null => {
    if (ti + len > text.length) return null
    let v = 0
    for (let k = ti; k < ti + len; k++) {
      const c = text.charCodeAt(k) - 48
      if (c < 0 || c > 9) return null
      v = v * 10 + c
    }
    ti += len
    return v
  }
  for (const sg of segs) {
    if ('lit' in sg) {
      if (!text.startsWith(sg.lit, ti)) return null
      ti += sg.lit.length
      continue
    }
    if ('zone' in sg) {
      const z = /^(?:Z|[+-]\d{2}(?::?\d{2})?)/.exec(text.slice(ti))
      if (!z) return null
      ti += z[0].length
      continue
    }
    const v = take(sg.len)
    if (v === null) return null
    if (sg.f === 'yyyy') y = v
    else if (sg.f === 'yy') y = 2000 + v
    else if (sg.f === 'MM') mo = v
    else if (sg.f === 'dd') d = v
    else if (sg.f === 'HH') H = v
    else if (sg.f === 'mm') mi = v
    else if (sg.f === 'ss') s = v
    else ms = v
  }
  if (ti !== text.length) return null
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || H > 23 || mi > 59 || s > 59) return null
  // 同一小时内的行共用「整点」的毫秒数，省掉每行 new Date
  const hourKey = ((y * 100 + mo) * 100 + d) * 100 + H
  let base = hourCache.get(hourKey)
  if (base === undefined) {
    const dt = new Date(y, mo - 1, d, H)
    // Date 会把 13 月 / 32 日静默进位到下个月：回读对账挡掉
    base = dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d ? null : dt.getTime()
    if (hourCache.size > 10_000) hourCache.clear()
    hourCache.set(hourKey, base)
  }
  return base === null ? null : base + mi * 60_000 + s * 1000 + ms
}
