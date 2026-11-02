/**
 * 日志转 SQL 的展示层格式化 —— bug.txt 优化条：「解析后需要对 SQL 自动格式化，
 * 参数值太长，后面的列全部看不到了」。
 *
 * 分层位置：`logFill.ts` 产出的 `filled.sql` 是「可执行文本」的事实来源，
 * 有 47 条单测钉着它的形状，不能为了好看去动它。格式化只发生在最后一层
 * （渲染进卡片 / 复制进剪贴板之前），而且**只加空白和换行**，一个字符都不改——
 * 有测试用「归一化空白后必须与原文一致」钉住这一点。
 *
 * 规则刻意只有这几条，刚好盖住回填产物的四种形状：
 *   1. 顶层子句各起一行（INSERT INTO / VALUES / UPDATE / SET / WHERE / FROM…）
 *   2. WHERE 的每个 AND/OR 条件一行
 *   3. SET 的每个赋值一行，与第一个赋值对齐
 *   4. VALUES 的参数元组放不进一行（> LINE_MAX）就逐参数一行 —— 本条 bug 的正主
 *
 * 关键字、逗号、括号一律在 `codeMask` 掩码上找（引号扫描器只准有一份，
 * 见 statements.ts）：`'北京市, 朝阳区'` 这种值里的逗号、
 * `remark = 'please SET x'` 这种值里的关键字都骗不到它。
 * 没匹配到任何子句头的输入（比如 p6spy 里夹带的 DDL）原样返回——
 * 宁可不格式化，也不能把不认识的语句改坏。
 *
 * 输入约定是**单条**语句：对话流里一张卡一条，「复制全部」是逐条格式化后再拼。
 * 幂等：对已经格式化过的输出再跑一遍，结果不变（有测试钉住）。
 */

import { codeMask } from './statements'

/** 一行的宽度上限。对话卡片的代码区大约 80 列等宽字符，留一点余量 */
const LINE_MAX = 88

/** 续行缩进 */
const CONT = '  '

/**
 * 子句头。**长词必须排在短词前面**——正则在同一位置按备选顺序先到先得，
 * `insert\s+into` 排在裸 `insert` 前面才不会把 INTO 甩给子句体；
 * 裸 `join` 必须垫底，否则会抢在 `left join` 的 left 和 join 中间下刀。
 */
const HEAD_RE =
  /\b(insert\s+into|delete\s+from|group\s+by|order\s+by|fetch\s+(first|next)|inner\s+join|(left|right|full)(\s+outer)?\s+join|cross\s+join|select|insert|update|delete|values|set|where|from|having|limit|offset)\b/gi

/** WHERE 体里的条件连接词。between 也得进来——它的 AND 靠「上一个是不是 between」
 * 在扫描时记账排除，词表里没有它就永远看不见 */
const CONJ_RE = /\b(between|and|or)\b/gi

/** FROM 体里的 JOIN，只有它们值得从 FROM 那一行里拆出来 */
const JOIN_RE = /\b(inner\s+join|(left|right|full)(\s+outer)?\s+join|cross\s+join|join)\b/gi

/**
 * 每个字符所在的括号深度：顶层是 0，一层括号里是 1……只数掩码认过的裸括号。
 * 括号字符本身记的是「进入前」的深度，所以 `(a, b)` 里的逗号深度是 1。
 */
function depths(sql: string): number[] {
  const mask = codeMask(sql)
  const out = new Array<number>(sql.length)
  let cur = 0
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    if (!mask[i]) {
      out[i] = cur
      continue
    }
    if (c === '(') {
      out[i] = cur
      cur++
    } else if (c === ')') {
      cur--
      out[i] = cur
    } else out[i] = cur
  }
  return out
}

/** 按顶层逗号切分（引号里、括号里的逗号不算），空段丢弃 */
function splitTopLevel(text: string): string[] {
  const mask = codeMask(text)
  const depth = depths(text)
  const out: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ',' && mask[i] && depth[i] === 0) {
      const seg = text.slice(start, i).trim()
      if (seg) out.push(seg)
      start = i + 1
    }
  }
  const rest = text.slice(start).trim()
  if (rest) out.push(rest)
  return out
}

/** 在 body 里找所有「裸代码 + 顶层」的正则命中下标。
 * 两道保险缺一不可：掩码挡住字符串里的假关键字（`'please SET x'` 里的 SET
 * 深度也是 0——depths() 对掩掉的位置填的就是当前深度，它自己挡不住这个），
 * 深度挡住括号里没被引号保护的关键字（函数参数、IN 列表）。 */
function topMatches(re: RegExp, body: string): number[] {
  const mask = codeMask(body)
  const depth = depths(body)
  const at: number[] = []
  for (const m of body.matchAll(re)) {
    const i = m.index ?? -1
    if (i >= 0 && mask[i] && depth[i] === 0) at.push(i)
  }
  return at
}

export function formatSql(src: string): string {
  const text = src.trim()
  if (!text) return ''

  // 尾分号不属于任何子句，先摘下来最后接回——不然它会黏在最后一个参数后面
  let core = text
  let tail = ''
  if (core.endsWith(';')) {
    tail = ';'
    core = core.slice(0, -1).trimEnd()
  }

  // 子句头同样要过双保险：只查深度的话，字符串里的 'please WHERE y' 会把
  // 一条 UPDATE 从中间劈开，而四道闸门和大多数用例都照不出来这种形状
  const coreDepth = depths(core)
  const coreMask = codeMask(core)
  const heads = [...core.matchAll(HEAD_RE)].filter(
    (m) => coreMask[m.index ?? 0] && coreDepth[m.index ?? 0] === 0,
  )
  // 一个子句头都没有（DDL / 未知形状）：原样返回，宁可不格式化也不瞎动
  if (!heads.length) return core + tail

  const lines: string[] = []
  const prefix = core.slice(0, heads[0].index).trim()
  if (prefix) lines.push(prefix)

  heads.forEach((h, i) => {
    const from = (h.index ?? 0) + h[0].length
    const to = i + 1 < heads.length ? heads[i + 1].index ?? core.length : core.length
    layout(h[0].trim(), core.slice(from, to).trim(), lines)
  })

  const out = lines.map((l) => l.replace(/[ \t]+$/, '')).join('\n')
  return tail ? `${out}${tail}` : out
}

/** 按子句头分派排版方式。into/by/outer 这些词已经被头整体吃掉，不会落到这里 */
function layout(head: string, body: string, lines: string[]) {
  switch (head.toLowerCase().split(/\s+/)[0]) {
    case 'values':
      return layoutValues(head, body, lines)
    case 'set':
      return layoutSet(head, body, lines)
    case 'where':
      return layoutWhere(head, body, lines)
    case 'from':
      return layoutFrom(head, body, lines)
    case 'select':
      return layoutSelect(head, body, lines)
    default:
      // INSERT INTO 的列清单、UPDATE 表名、GROUP BY / ORDER BY 这些本来就短
      lines.push(body ? `${head} ${body}` : head)
  }
}

function layoutValues(head: string, body: string, lines: string[]) {
  const groups = splitTopLevel(body)
  if (!groups.length) {
    lines.push(head)
    return
  }

  const flat = `${head} ${groups.join(', ')}`
  if (flat.length <= LINE_MAX) {
    lines.push(flat)
    return
  }

  if (groups.length > 1) {
    // 批量插入：一组一行，行尾逗号把组串起来
    lines.push(head)
    groups.forEach((g, i) => lines.push(`${CONT}${g}${i < groups.length - 1 ? ',' : ''}`))
    return
  }

  // 单组还超宽 = 参数多或值长，就是这条优化抱怨的场景：逐参数一行
  const tuple = groups[0]
  const items = tuple.startsWith('(') && tuple.endsWith(')') ? splitTopLevel(tuple.slice(1, -1)) : []
  if (items.length <= 1) {
    lines.push(flat) // 一个超长的裸值，拆无可拆，保持原样
    return
  }
  lines.push(`${head} (`)
  items.forEach((it, i) => lines.push(`${CONT}${it}${i < items.length - 1 ? ',' : ''}`))
  lines.push(')')
}

function layoutSet(head: string, body: string, lines: string[]) {
  const parts = splitTopLevel(body)
  if (!parts.length) {
    lines.push(head)
    return
  }
  const pad = ' '.repeat(head.length + 1) // 与第一个赋值对齐
  parts.forEach((p, i) => {
    const sep = i < parts.length - 1 ? ',' : ''
    lines.push(i === 0 ? `${head} ${p}${sep}` : `${pad}${p}${sep}`)
  })
}

function layoutWhere(head: string, body: string, lines: string[]) {
  // BETWEEN 的 AND 是它自己语法的另一半，不能当新条件折行。没法靠「看前一个词」
  // 判定——紧挨着 AND 的是下界字面量（between 1 **and** 9），不是 BETWEEN；
  // 只能正向扫：见过裸 between 之后，下一个顶层 AND 就记在它账上
  const mask = codeMask(body)
  const depth = depths(body)
  const cuts: number[] = []
  let expectBetweenAnd = false
  for (const m of body.matchAll(CONJ_RE)) {
    const i = m.index ?? -1
    if (i < 0 || !mask[i] || depth[i] !== 0) continue
    if (/^between$/i.test(m[0])) {
      expectBetweenAnd = true
      continue
    }
    if (expectBetweenAnd) {
      expectBetweenAnd = false // 这就是 BETWEEN 的另一半，吞掉不切
      continue
    }
    cuts.push(i)
  }
  if (!cuts.length) {
    lines.push(`${head} ${body}`)
    return
  }
  const chunks: string[] = []
  cuts.forEach((at, i) => {
    const end = i + 1 < cuts.length ? cuts[i + 1] : body.length
    const t = body.slice(at, end).trim()
    if (t) chunks.push(t)
  })
  // 首段跟在 WHERE 后面；之后每段以 AND/OR 开头、缩进续行。
  // 拼行时绝不能对整行做空白折叠——那会把字符串字面量里的空格也压掉，等于改了数据
  const lead = body.slice(0, cuts[0]).trim()
  if (lead) {
    lines.push(`${head} ${lead}`)
    chunks.forEach((c) => lines.push(`${CONT}${c}`))
  } else {
    // WHERE 后直接跟 AND 的罕见形状：让第一个块顶在头那一行上，别把 WHERE 落单
    lines.push(`${head} ${chunks.shift() ?? ''}`)
    chunks.forEach((c) => lines.push(`${CONT}${c}`))
  }
}

function layoutFrom(head: string, body: string, lines: string[]) {
  const cuts = topMatches(JOIN_RE, body)
  if (!cuts.length) {
    lines.push(`${head} ${body}`)
    return
  }
  lines.push(`${head} ${body.slice(0, cuts[0]).trim()}`)
  cuts.forEach((at, i) => {
    const end = i + 1 < cuts.length ? cuts[i + 1] : body.length
    const seg = body.slice(at, end).trim()
    if (seg) lines.push(seg)
  })
}

/** SELECT 清单：能一行放下就一行；放不下按顶层逗号贪心打包折行 */
function layoutSelect(head: string, body: string, lines: string[]) {
  const items = splitTopLevel(body)
  if (!items.length) {
    lines.push(head)
    return
  }
  const flat = `${head} ${items.join(', ')}`
  if (flat.length <= LINE_MAX) {
    lines.push(flat)
    return
  }

  const groups: string[][] = [[]]
  for (const it of items) {
    const g = groups[groups.length - 1]
    const joined = [...g, it].join(', ')
    if (g.length && joined.length > LINE_MAX) groups.push([it])
    else g.push(it)
  }
  groups.forEach((g, gi) => {
    const text = g.join(', ') + (gi < groups.length - 1 ? ',' : '')
    lines.push(gi === 0 ? `${head} ${text}` : `${CONT}${text}`)
  })
}
