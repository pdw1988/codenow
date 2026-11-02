/**
 * 手写 SQL 的输入提示（连库查询页）。只解决高频场景，不当补全器：
 * ① `别名.` / `表名.` —— 把那张表的列全列出来（`select a. from t a where a.`）；
 * ② `FROM ` / `JOIN ` 空格后 —— 列出库里的表名。
 *
 * （曾经还有 ③：SELECT / WHERE / 逗号 / 括号后面把已出现表的列合并弹出来。
 *  用户 2026-09-20 拍板砍掉：敲个 where 就糊一脸列名，比不出还难操作。
 *  现在列**只**在点号限定符后面出——`t.abc` 才是当初要的样子。）
 *
 * 解析前把字符串字面量和注释抹成**等长**空白：`where a.name = 'x.y'` 里的点号
 * 不能当限定符，而抹成等长才保得住光标下标。别名解析读全文——
 * `select a. from t a` 的别名定义在点号之后。
 */

export interface SqlHint {
  /** table = 建议表名；column = 建议列名 */
  kind: 'table' | 'column'
  /** 前缀替换起点。点号场景只替换点号后面的部分，`别名.` 原样保留 */
  from: number
  items: string[]
}

/** 一次最多给多少条；列表靠继续打字过滤 */
const CAP = 50

/** `a.col` / `a.`：限定符 + 点号 +（可能空）前缀，锚在串尾 */
const DOT_RE = /([A-Za-z_][\w$#]*)\.([\w$#]*)$/
/** 光标处的半截词 */
const WORD_RE = /[A-Za-z_][\w$#]*$/

/** 别名候选撞上这些词时不算别名（`from t where …` 的 where） */
const NOT_ALIAS = new Set([
  'where', 'on', 'inner', 'left', 'right', 'full', 'cross', 'outer', 'join',
  'group', 'order', 'limit', 'having', 'union', 'minus', 'intersect', 'set',
])

/** FROM/JOIN 表名（可带引号包裹），后随可选别名。别名候选先用负向先行挡掉关键字，
 *  必须挡在匹配阶段而不是事后过滤——`from brand join sku` 的 join 若被当别名候选
 *  消费掉，正则推进过去，sku 就再也算表了 */
const FROM_RE = new RegExp(
  '\\b(?:from|join)\\s+([A-Za-z_][\\w$#]*|"[^"]+"|`[^`]+`|\\[[^\\]]+\\])' +
    '(?:\\s+(?!(?:as\\s+)?(?:' + [...NOT_ALIAS].join('|') + ')\\b)(?:as\\s+)?([A-Za-z_][\\w$#]*))?',
  'gi',
)

/**
 * 字符串、`--` 行注释、`/* *` 块注释抹成等长空白（换行保留，好排）。
 * 没闭合的串抹到串尾/文尾，正好让光标落进去时量不出词 → 不出提示。
 */
export function maskLiterals(sql: string): string {
  const out: string[] = []
  const n = sql.length
  let i = 0
  while (i < n) {
    const ch = sql[i]!
    if (ch === "'") {
      out.push(' ')
      i++
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out.push(' ', ' ')
          i += 2
          continue
        }
        out.push(sql[i] === '\n' ? '\n' : ' ')
        const end = sql[i] === "'"
        i++
        if (end) break
      }
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') {
        out.push(' ')
        i++
      }
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      out.push(' ', ' ')
      i += 2
      while (i < n) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          out.push(' ', ' ')
          i += 2
          break
        }
        out.push(sql[i] === '\n' ? '\n' : ' ')
        i++
      }
      continue
    }
    out.push(ch)
    i++
  }
  return out.join('')
}

export interface SqlNames {
  /** FROM / JOIN 出现过的表名，按出现顺序去重，保留原大小写 */
  tables: string[]
  /** 别名 → 表名（键小写）。表名本身也放一份：`from t where t.` 直接命中 */
  aliasToTable: Map<string, string>
}

/** 抠出 SQL 里 FROM / JOIN 的表和别名。引号包裹的标识符去壳 */
export function sqlNames(sql: string): SqlNames {
  const masked = maskLiterals(sql)
  const tables: string[] = []
  const seen = new Set<string>()
  const aliasToTable = new Map<string, string>()
  FROM_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FROM_RE.exec(masked))) {
    const table = m[1]!.replace(/^["`[]|["`\]]$/g, '')
    const key = table.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      tables.push(table)
    }
    aliasToTable.set(key, table)
    const alias = m[2]
    if (alias && !NOT_ALIAS.has(alias.toLowerCase())) {
      aliasToTable.set(alias.toLowerCase(), table)
    }
  }
  return { tables, aliasToTable }
}

function filterItems(items: readonly string[], prefix: string): string[] {
  const p = prefix.toLowerCase()
  const hit = items.filter((x) => x.toLowerCase().startsWith(p))
  if (hit.length > 0) return hit.slice(0, CAP)
  return items.filter((x) => x.toLowerCase().includes(p)).slice(0, CAP)
}

/**
 * 光标在 caret 时该不该出提示、出什么。不匹配任何场景返回 null。
 * `colsOf` 拿不到列（表还没拉过字段）时列场景自然为空 → null，调用方懒拉后再打一个字就有。
 */
export function sqlHintAt(
  text: string,
  caret: number,
  opts: { tableNames: readonly string[]; colsOf: (table: string) => string[] },
): SqlHint | null {
  if (caret < 0 || caret > text.length) return null
  const pre = maskLiterals(text.slice(0, caret))
  const names = sqlNames(text)

  // ① 限定符点号。from: 只替换点号后面的前缀，`a.` 留着
  const dot = DOT_RE.exec(pre)
  if (dot) {
    const table = names.aliasToTable.get(dot[1]!.toLowerCase())
    if (!table) return null
    const prefix = dot[2]!
    const items = filterItems(opts.colsOf(table), prefix)
    return items.length > 0 ? { kind: 'column', from: caret - prefix.length, items } : null
  }

  const word = WORD_RE.exec(pre)?.[0] ?? ''
  const before = pre.slice(0, pre.length - word.length).trimEnd()
  const lastCh = before.slice(-1)
  const prevWord = WORD_RE.exec(before)?.[0]?.toLowerCase() ?? ''

  // ② FROM / JOIN 空格后出表名。`from (` 是子查询开头，不出
  if ((prevWord === 'from' || prevWord === 'join') && lastCh !== '(') {
    const items = filterItems(opts.tableNames, word)
    return items.length > 0 ? { kind: 'table', from: caret - word.length, items } : null
  }

  // ③ 已砍（用户 2026-09-20）：WHERE / ORDER BY / 逗号 / 括号后不再弹列，
  //    列只在 ① 的点号限定符后面出。敲到哪都不糊脸。
  return null
}
