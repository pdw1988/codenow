/**
 * 表结构搜索。实现 PRD 3.4 的 7 条匹配规则，纯内存计算，目标 < 50ms。
 *
 * 设计取舍：这里不做 FTS5，只做 Map + 线性扫描。50~100 张表规模下线性
 * 扫描本身就是微秒级，FTS5 的价值在于 1000+ 表，留给后续按需引入。
 */
import PinyinMatch from 'pinyin-match'
import type { MatchReason, SearchHit, TableInfo } from '../types/schema'

/**
 * 各匹配方式的权重，决定结果排序。
 *
 * 大致照 PRD 3.4 的规则表顺序递减：表名 > 字段/注释 > 拼音。
 * `javaClassExact` 单独一档的原因见下面规则 7 处的注释。
 */
const WEIGHTS = {
  tableExact: 1000,
  javaClassExact: 700,
  tablePrefix: 300,
  javaClass: 250,
  tableFuzzy: 200,
  tableComment: 150,
  tablePinyin: 120,
  column: 60,
  columnComment: 40,
} as const

/** 只有含中文时才走拼音匹配，纯英文关键字走拼音纯属浪费 */
const HAS_CJK = /[一-龥]/

function pinyinHit(text: string | undefined, query: string): boolean {
  if (!text || !HAS_CJK.test(text)) return false
  return PinyinMatch.match(text, query) !== false
}

/** 字面包含或拼音命中。选表下拉的筛选跟速查共用这一条，避免两套规则各漂一次。 */
export function textMatchesQuery(text: string | undefined, query: string): boolean {
  if (!text) return false
  const q = query.trim()
  if (!q) return true
  if (text.toLowerCase().includes(q.toLowerCase())) return true
  return pinyinHit(text, q)
}

/**
 * 搜索表结构。
 *
 * @param tables 全量表列表（来自内存缓存）
 * @param rawQuery 用户输入，空字符串返回全部（按表名排序）
 * @param limit 最多返回条数，防止空查询时渲染爆炸
 */
export function searchTables(
  tables: TableInfo[],
  rawQuery: string,
  limit = 50,
): SearchHit[] {
  const query = rawQuery.trim()

  if (!query) {
    return [...tables]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((table) => ({ table, reasons: [], score: 0 }))
  }

  const q = query.toLowerCase()
  const hits: SearchHit[] = []

  for (const table of tables) {
    const reasons: MatchReason[] = []
    let score = 0

    const name = table.name.toLowerCase()

    // 规则 1/2：表名精确 → 前缀 → 包含，三档递减，只记一条 reason
    if (name === q) {
      reasons.push({ kind: 'tableExact' })
      score += WEIGHTS.tableExact
    } else if (name.startsWith(q)) {
      reasons.push({ kind: 'tableFuzzy' })
      score += WEIGHTS.tablePrefix
    } else if (name.includes(q)) {
      reasons.push({ kind: 'tableFuzzy' })
      score += WEIGHTS.tableFuzzy
    }

    // 规则 7：Java 类名匹配。分「全等」和「包含」两档，不能都给高分——
    // 项目里的类名普遍带 Entity/DO/DTO 后缀，搜 "entity" 会一次命中所有表；
    // 「包含」要是压过表名前缀匹配，搜 "user" 时 javaClass 叫 UserAudit 的 audit 表
    // 就排在真的叫 user_role 的表前面，噪音排到信号前头去了。
    const java = table.javaClass?.toLowerCase()
    if (java === q) {
      reasons.push({ kind: 'javaClass' })
      score += WEIGHTS.javaClassExact
    } else if (java?.includes(q)) {
      reasons.push({ kind: 'javaClass' })
      score += WEIGHTS.javaClass
    }

    // 规则 4/5：表注释匹配（中文语义走的也是这条）
    const commentHit = table.comment?.toLowerCase().includes(q) ?? false
    if (commentHit) {
      reasons.push({ kind: 'tableComment' })
      score += WEIGHTS.tableComment
    }

    // 规则 6：拼音 / 首字母，命中表名注释即可。
    // 已经字面命中过的不再算一次：PinyinMatch 对原文也返回 true，所以中文查询
    // 每次都会多挂一个「拼音匹配」Tag——用户搜的明明是汉字，标签却说是拼音命中。
    if (
      !commentHit &&
      !name.includes(q) &&
      (pinyinHit(table.comment, query) || pinyinHit(table.name, query))
    ) {
      reasons.push({ kind: 'tablePinyin' })
      score += WEIGHTS.tablePinyin
    }

    // 规则 3：字段名匹配，收集所有命中字段一起展示
    const columnMatches = table.columns
      .filter((c) => c.name.toLowerCase().includes(q))
      .map((c) => c.name)
    if (columnMatches.length) {
      reasons.push({ kind: 'column', columns: columnMatches })
      score += WEIGHTS.column + columnMatches.length
    }

    // 规则 4：字段注释匹配
    const commentMatches = table.columns
      .filter((c) => c.comment?.toLowerCase().includes(q) || pinyinHit(c.comment, query))
      .map((c) => c.name)
    if (commentMatches.length) {
      reasons.push({ kind: 'columnComment', columns: commentMatches })
      score += WEIGHTS.columnComment + commentMatches.length
    }

    if (reasons.length) hits.push({ table, reasons, score })
  }

  return hits
    .sort((a, b) => b.score - a.score || a.table.name.localeCompare(b.table.name))
    .slice(0, limit)
}

/** 命中原因 → 中文说明，用于结果卡片上的 Tag */
export function describeReason(reason: MatchReason): string {
  switch (reason.kind) {
    case 'tableExact':
      return '表名精确匹配'
    case 'tableFuzzy':
      return '表名匹配'
    case 'tablePinyin':
      return '拼音匹配'
    case 'tableComment':
      return '表注释匹配'
    case 'javaClass':
      return 'Java 类名匹配'
    case 'column':
      return `字段：${reason.columns.join(', ')}`
    case 'columnComment':
      return `字段注释：${reason.columns.join(', ')}`
  }
}
