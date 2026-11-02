/**
 * 数据库类型的「基础类型 + 长度」拆装（编辑表结构弹窗两列编辑用）。
 *
 * 缓存里 type 始终存完整原文（VARCHAR(50)、DECIMAL(10,2)、VARCHAR2(100 CHAR)），下游
 * （javaType 推导 / DDL 导出 / 增量 ALTER）只认这一份；拆开只发生在
 * 弹窗的编辑态，所以这里的函数必须保证**拆了再装回去等于原文**——
 * 装不回去，用户开一次弹窗什么都不改也会在增量 DDL 里多出一条 ALTER。
 *
 * Oracle 的 `VARCHAR2(100 CHAR)` / `(100 BYTE)`：CHAR/BYTE 是长度单位，不是类型词。
 * 拆到 `unit` 里，长度框只显示 `100`，装回去再拼上。
 */

export interface DbTypeParts {
  /** 去掉括号部分的基础类型，如 VARCHAR、NUMBER；带后缀的多词类型原样 */
  base: string
  /** 括号里的长度/精度，如 50、10,2；没有括号就是空串。不含 CHAR/BYTE */
  args: string
  /** Oracle 字符串长度单位。空串表示括号里没有单位 */
  unit: '' | 'CHAR' | 'BYTE'
}

/** 只有这些类型括号里的 CHAR/BYTE 才是长度单位。DECIMAL(10,2) 不要误伤。 */
const CHAR_LEN = /^(N?(VAR)?CHAR2?)$/i

export function isCharLenType(base: string): boolean {
  return CHAR_LEN.test(base.trim())
}

/**
 * 从长度框原文里剥 CHAR/BYTE。用户若把 `100 CHAR` 贴进长度框，数字进 args，单位进 unit。
 */
export function peelCharUnit(raw: string): { args: string; unit: '' | 'CHAR' | 'BYTE' } {
  const t = raw.trim()
  const m = /^(.+?)\s+(CHAR|BYTE)$/i.exec(t)
  if (!m) return { args: t, unit: '' }
  const head = m[1].trim()
  // `10, 2 CHAR` 不是合法精度单位，原样当长度
  if (head.includes(',')) return { args: t, unit: '' }
  return { args: head, unit: m[2].toUpperCase() as 'CHAR' | 'BYTE' }
}

/**
 * 拆一条类型。只认「词 + (无嵌套括号的内容) 收尾」的简单形状：
 * - `TIMESTAMP(6) WITH TIME ZONE` 的括号不在收尾，整体当 base —— 装回去才不会
 *   变成 `TIMESTAMP WITH TIME ZONE(6)` 这种用户没写过的顺序；
 * - `ENUM('a','b')` 括号里有嵌套括号，同样整体当 base，别去碰引号里的东西。
 */
export function splitDbType(type: string): DbTypeParts {
  const t = type.trim()
  const m = /^([A-Za-z0-9_ ]+?)\s*\(([^()]*)\)$/.exec(t)
  if (!m) return { base: t, args: '', unit: '' }
  const base = m[1]
  const inner = m[2].trim()
  if (isCharLenType(base)) {
    const peeled = peelCharUnit(inner)
    return { base, args: peeled.args, unit: peeled.unit }
  }
  return { base, args: inner, unit: '' }
}

/**
 * 装回完整类型。base 里已经带了括号（用户在类型框手打了完整写法）时以
 * base 为准、忽略长度框 —— 否则手打的 VARCHAR(50) 会被装成 VARCHAR(50)(50)。
 */
export function joinDbType(base: string, args: string, unit: string = ''): string {
  const b = base.trim()
  if (!b) return '' // 没填类型：长度框留着也无意义，交给「没填类型」的校验去拦
  if (b.includes('(')) return b
  const a = args.trim()
  if (!a) return b
  const u = unit.trim().toUpperCase()
  if (u && isCharLenType(b) && (u === 'CHAR' || u === 'BYTE')) return `${b}(${a} ${u})`
  return `${b}(${a})`
}

/** 查看表结构用：长度单位不占格子，全文放 title。 */
export function displayDbType(type: string): string {
  return type.replace(/\(\s*(\d+(?:\s*,\s*\d+)?)\s+(CHAR|BYTE)\s*\)/gi, '($1)')
}
