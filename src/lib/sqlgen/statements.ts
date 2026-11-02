/**
 * 把一段 SQL 拆成若干条语句，PRD 4.2 草图里【📋 复制 INSERT】/【📋 复制 UPDATE】要用。
 *
 * 为什么不能 `sql.split(';')`：生成出来的 SQL 里，分号有三个地方会出现但不是语句结束。
 *
 * 1. 字符串字面量里。可执行模式的值是用户能手填的（`ValuePanel` 的输入框），
 *    往备注里打一个 `a;b` 就会原样进 SQL。
 * 2. 行尾注释里。可执行模式给 INSERT 的每个值都缀了 `-- 字段名 字段注释`，
 *    而字段注释是从 DDL 抄来的，里头带分号完全正常。
 * 3. 块注释里。
 *
 * 裸切会把一条语句劈成两半，复制出去直接是语法错误——而「复制出去就能跑」
 * 是可执行模式存在的全部理由。所以这里老老实实扫一遍。
 */

export type StatementKind = 'insert' | 'update' | 'delete' | 'select' | 'other'

export interface SqlStatement {
  kind: StatementKind
  /**
   * 语句原文，含结尾分号，也含紧跟在它前面的注释行。
   * 带上注释是故意的：注释说明了这条语句是干什么的（表名、字段名、
   * 「执行前确认不会打乱现有数据」那句警告），单独复制一条 UPDATE 出去时
   * 那句话比语句本身更需要被看到。
   */
  text: string
}

/** 按钮上显示的名字 */
export const STATEMENT_LABELS: Record<StatementKind, string> = {
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
  select: 'SELECT',
  other: '其它',
}

/** 语句首关键字 → 类型。WITH 归到 select：CTE 打头的整体还是一条查询 */
const KEYWORDS: Record<string, StatementKind> = {
  INSERT: 'insert',
  REPLACE: 'insert',
  UPDATE: 'update',
  DELETE: 'delete',
  SELECT: 'select',
  WITH: 'select',
}

/**
 * 逐字符标记「这个位置是裸代码吗」——不在字符串字面量里、也不在注释里。
 *
 * 拆语句要找裸分号，判类型要找裸关键字，日志回填要找裸 `?`，三处都建在这一个函数上。
 * 各写一份状态机的话，早晚会出现只改了一处的情况（比如补了反引号处理
 * 却忘了另一边），然后两边对同一段 SQL 给出不一致的结论。
 */
export function codeMask(
  sql: string,
  /** oracleDdl 统一引号用：把双引号当普通代码字符，而不是标识符引用的开合 */
  opts: { doubleQuoteAsCode?: boolean } = {},
): boolean[] {
  const mask = new Array<boolean>(sql.length).fill(false)
  /** 当前所在引号的引号字符；空串 = 不在引号里 */
  let quote = ''
  let lineComment = false
  let blockComment = false

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    const next = sql[i + 1]

    if (lineComment) {
      if (c === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (c === '*' && next === '/') {
        blockComment = false
        i++
      }
      continue
    }
    if (quote) {
      if (c !== quote) continue
      // 连着两个同种引号是转义（'' 代表一个单引号），不是闭合。
      // 这里刻意不认反斜杠转义：生成器只输出 '' 翻倍，而 \ 的含义随方言变
      // （MySQL 认，Postgres 默认 standard_conforming_strings=on 不认），
      // 认了反而会在 Postgres 语义下把 'a\' 误判成没闭合，后面整段全被吞掉。
      if (next === quote) {
        i++
        continue
      }
      quote = ''
      continue
    }

    if (c === '-' && next === '-') {
      lineComment = true
      i++
      continue
    }
    if (c === '/' && next === '*') {
      blockComment = true
      i++
      continue
    }
    // 双引号和反引号是标识符引用（Postgres/Oracle 用 "，MySQL 用 `）。
    // 表名叫 order 这种保留字时生成器会加引号，里头理论上什么字符都能有。
    // doubleQuoteAsCode 变体是给 oracleDdl 统一引号用的：它要在双引号段上做匹配，
    // 默认语义下那段整个被掩成「字符串」，一个字符都摸不到
    if (c === "'" || (c === '"' && !opts.doubleQuoteAsCode) || c === '`') {
      quote = c
      continue
    }
    mask[i] = true
  }
  return mask
}

/** 片段里第一个裸关键字决定类型；一个裸字母都没有（纯注释）时返回 null */
function detectKind(sql: string, mask: boolean[], from: number, to: number): StatementKind | null {
  let word = ''
  for (let i = from; i < to; i++) {
    if (!mask[i]) continue
    const c = sql[i]
    if (/[A-Za-z_]/.test(c)) {
      word += c
      continue
    }
    // 攒到了词又遇到非字母，说明第一个词完整了
    if (word) break
  }
  if (!word) return null
  return KEYWORDS[word.toUpperCase()] ?? 'other'
}

export function splitStatements(sql: string): SqlStatement[] {
  const mask = codeMask(sql)
  const out: SqlStatement[] = []
  let start = 0

  const take = (from: number, to: number) => {
    const text = sql.slice(from, to).trim()
    if (!text) return
    const kind = detectKind(sql, mask, from, to)
    // 只有注释没有语句的片段（比如末尾单独一行「执行前确认一下」）不算一条语句：
    // 它没法单独执行，混进「复制 INSERT」的结果里只会让人以为复制错了。
    // 代价是这种尾注释在分段复制里会丢——「复制全部」用的是原文，不受影响。
    if (kind === null) return
    out.push({ kind, text })
  }

  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === ';' && mask[i]) {
      take(start, i + 1)
      start = i + 1
    }
  }
  // 最后一条可能没写分号（比如只勾了 SELECT 又手删了分号），照样算一条
  take(start, sql.length)
  return out
}

/**
 * 按类型归组，组的先后顺序沿用它们在原文里第一次出现的顺序。
 *
 * 沿用原文顺序而不是写死 INSERT→UPDATE→DELETE→SELECT：按钮排列跟
 * 上面代码块里语句的上下顺序一致，眼睛不用做映射。
 */
export function groupByKind(
  statements: SqlStatement[],
): Array<{ kind: StatementKind; text: string; count: number }> {
  const order: StatementKind[] = []
  const byKind = new Map<StatementKind, string[]>()

  for (const s of statements) {
    const list = byKind.get(s.kind)
    if (list) {
      list.push(s.text)
    } else {
      byKind.set(s.kind, [s.text])
      order.push(s.kind)
    }
  }

  return order.flatMap((kind) => {
    const texts = byKind.get(kind)
    if (!texts?.length) return []
    return [{ kind, text: texts.join('\n\n'), count: texts.length }]
  })
}
