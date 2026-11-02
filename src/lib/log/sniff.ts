/**
 * pattern 自动识别（码上追的体验底座）：用户不该需要知道「我的 pattern 长什么
 * 样」——打开文件就该能用。拿一批常见 logback 格式对着文件头试匹配，命中率最高
 * 的胜出；识别不出来再回落到让用户贴 logback.xml 的 <pattern>。
 */
import { compilePattern, parseLineWith } from './pattern'

export interface PatternCandidate {
  label: string
  pattern: string
}

/** 按特异性从高到低排：越具体的放前面，避免被宽松格式抢先（满命中即提前收工） */
export const PATTERN_CANDIDATES: readonly PatternCandidate[] = [
  // ruoyi 工程的 logback.xml 常见格式：%level 无宽度补位、`]->` 紧贴——
  // 与下面第一版的差异只在空格，差一个字符整个文件就会塌成无头记录，单独成候选
  { label: '方括号全包带行号（->紧贴）', pattern: '[%d{yyyy-MM-dd HH:mm:ss.SSS}]%level [%thread][%logger{50}:%line]-> %msg%n' },
  { label: '方括号全包带行号', pattern: '[%d{yyyy-MM-dd HH:mm:ss.SSS}]%-5level [%thread][%logger:%line] -> %msg%n' },
  { label: '方括号全包', pattern: '[%d{yyyy-MM-dd HH:mm:ss.SSS}]%-5level [%thread][%logger] -> %msg%n' },
  { label: '方括号短横线', pattern: '[%d{yyyy-MM-dd HH:mm:ss.SSS}][%thread][%-5level][%logger] - %msg%n' },
  { label: '标准 logback', pattern: '%d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] %-5level %logger{36} - %msg%n' },
  { label: '逗号毫秒', pattern: '%d{yyyy-MM-dd HH:mm:ss,SSS} [%thread] %-5level %logger - %msg%n' },
  { label: '线程在前', pattern: '%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level [%thread] %logger - %msg%n' },
]

export function sniffPattern(
  lines: readonly string[],
  sampleN = 4000,
): { label: string; pattern: string; rate: number } | null {
  const sample = lines.slice(0, sampleN).filter((l) => l.trim() !== '')
  if (!sample.length) return null
  let best: { label: string; pattern: string; rate: number } | null = null
  for (const c of PATTERN_CANDIDATES) {
    const p = compilePattern(c.pattern)
    if ('error' in p) continue
    let hit = 0
    for (const l of sample) if (parseLineWith(l, p)) hit++
    const rate = hit / sample.length
    if (rate >= 0.999) return { label: c.label, pattern: c.pattern, rate }
    if (!best || rate > best.rate) best = { label: c.label, pattern: c.pattern, rate }
  }
  // 门槛不能是「一半行是头行」：debug 直接打 SQL 的工程，日志 96% 是堆栈/续行，
  // 正确的 pattern 也只拆出 3% 上下的头行（真机 ruoyi 日志实测）。只要 ≥1% 的行
  // 拆得出头行就算认出——纯垃圾文本连 1% 都凑不出来
  return best && best.rate >= 0.01 ? best : null
}

/** 命中率：界面亮「pattern 对不对」的数字，也是「要不要自动换」的判据 */
export function matchRate(lines: readonly string[], patternSrc: string, sampleN = 2000): number {
  const p = compilePattern(patternSrc)
  if ('error' in p) return 0
  const sample = lines.slice(0, sampleN).filter((l) => l.trim() !== '')
  if (!sample.length) return 0
  let hit = 0
  for (const l of sample) if (parseLineWith(l, p)) hit++
  return hit / sample.length
}

/**
 * 要不要自动换 pattern：当前 pattern 命中过半说明用户配对了（或默认就合适），不动；
 * 没对上就试识别，认出来了且「明显比当前更能拆出头行」才换——堆栈重的日志里正确
 * pattern 的头行占比也就几个百分点，绝对门槛会把正确格式永远拒之门外；同分不动，
 * 已经换上的不会被别的候选来回翻。返回要应用的 pattern 文本，不用换给 null。
 */
export function betterPattern(lines: readonly string[], current: string): string | null {
  const cur = matchRate(lines, current)
  if (cur >= 0.5) return null
  const sniffed = sniffPattern(lines)
  if (!sniffed) return null
  return sniffed.rate >= cur + 0.01 ? sniffed.pattern : null
}
