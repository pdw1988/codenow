/**
 * 更新说明：发版时从 CHANGES.md 抽出给用户看的条目，装进 latest.json 的 notes；
 * 应用里弹窗读 Update.body（即 notes）。清单里只剩「发版 v1.1.0」这种空话时，
 * 再去拉产物仓 CHANGELOG.md 对应版本那一节当兜底。
 *
 * 用户来更新是为了知道「装完会多什么」，不是为了看一句发版口号。
 */

export const RELEASES_CHANGELOG_URL =
  'https://raw.githubusercontent.com/pdw1988/devtools-releases/main/CHANGELOG.md'

/** 清单 / 标签里这种不算说明，弹窗不能拿它糊弄过去 */
export function notesLookThin(raw: string): boolean {
  const t = raw.trim()
  if (t.length < 8) return true
  if (/^本次更新没有写说明/.test(t)) return true
  // 「发版 v1.1.0」是升版本号那个提交的标题，曾经原样进了 latest.json
  if (/^发版\s*v?\d[\d.]*\s*$/.test(t)) return true
  return false
}

/**
 * 从未发版的 CHANGES.md 抽出用户能看懂的条目。
 * 「建议版本：不升」是流程/文档，不进安装包，弹窗里也不该出现。
 */
export function notesFromChanges(md: string): string {
  const bullets: string[] = []
  for (const block of md.split(/\n(?=## )/)) {
    if (!block.startsWith('## ')) continue
    if (/建议版本[\s\S]{0,120}不升/.test(block)) continue
    const title = block.match(/^##\s+(?:[^\n·]*·\s*)?(.+)/)?.[1]?.trim()
    if (!title) continue
    // 标题末尾写「（不升）」也算：1.13.3 就是这样把内部条目漏进了更新弹窗
    if (/[（(]不升[）)]$/.test(title)) continue
    // 提交信息代码块：第一行是 commit subject，空行后第一句是「为什么」
    const why = block.match(/```[^\n]*\n[^\n]+\n\n([^\n`]+)/)?.[1]?.trim()
    bullets.push(why ? `· ${title}\n  ${why}` : `· ${title}`)
  }
  return bullets.join('\n\n')
}

/** 命令行说明 + CHANGES.md。口号式「发版 vX」丢掉，改用条目列表。 */
export function composeReleaseNotes(cliNotes: string, changesMd: string): string {
  const fromChanges = notesFromChanges(changesMd)
  const cli = cliNotes.trim()
  if (notesLookThin(cli)) return fromChanges
  if (!fromChanges) return cli
  // tag 里已经是拼好的说明时，CI 再跑一遍不要把条目叠两份
  if (cli.includes(fromChanges) || fromChanges.includes(cli)) {
    return cli.length >= fromChanges.length ? cli : fromChanges
  }
  return `${cli}\n\n${fromChanges}`
}

/**
 * 产物仓 CHANGELOG.md 里某一个版本的正文（去掉标题和下载路径那几行 > ）。
 * 弹窗标题已经有版本号，再留 `## v1.2.0` 是重复。
 */
export function changelogSection(md: string, version: string): string {
  const ver = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const head = new RegExp(`^## v${ver}\\b[^\\n]*\\n+`, 'm')
  const m = md.match(head)
  if (!m || m.index === undefined) return ''
  const rest = md.slice(m.index + m[0].length)
  const next = rest.search(/^## v/m)
  const body = (next < 0 ? rest : rest.slice(0, next)).trim()
  return body
    .split('\n')
    .filter((line) => !/^>\s/.test(line))
    .join('\n')
    .trim()
}
