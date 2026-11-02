/**
 * 写操作的规则（纯函数）：哪些地址算外部动作、哪些环境能写、造什么值、放行哪些请求。
 * 白名单和 leftover 的增删也在这里，store 只管存取。
 */
import type { PageInfo, PageWriteState, WriteDraft, WriteField, WriteLeftover, WriteSpec } from '../../types'
import { wordsOf } from '../writeGuard'

export const MARKER_PREFIX = 'ZZ自动测-'
/** 编码类字段：造值不带中文，编辑时也尽量不改它（别的数据可能按编码引用） */
export const CODE_RE = /code|编码|编号/i

const pad = (n: number): string => String(n).padStart(2, '0')

export const stampOf = (d: Date): string =>
  `${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

export const markerOf = (stamp: string): string => `${MARKER_PREFIX}${stamp}`

/** 放不下标记就换短标记 ZZ+时间戳，再放不下截断 */
function fit(v: string, max: number | null, stamp: string): string {
  if (!max || v.length <= max) return v
  const short = `ZZ${stamp}`
  return (v.startsWith(MARKER_PREFIX) ? short : v).slice(0, max)
}

/** 新增时给文本字段造的值；下拉（运行时选第一项）和填不了的控件给 null */
export function valueFor(f: WriteField, now: Date): string | null {
  if (f.kind !== 'text') return null
  const stamp = stampOf(now)
  const key = `${f.name} ${f.label}`
  let v: string
  if (CODE_RE.test(key)) v = `ZZ${stamp}`
  else if (/tel|phone|mobile|电话|手机/i.test(key)) v = '13800000000'
  else if (/mail|邮箱/i.test(key)) v = 'zz@test.com'
  else if (/date|日期/i.test(key)) v = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  else if (/num|qty|amount|price|rate|sort|数量|金额|单价|税率|排序/i.test(key)) v = '1'
  else v = markerOf(stamp)
  return fit(v, f.maxlength, stamp)
}

/** 编辑时的新值：原值 + ZZ（放不下截原值），原值为空填标记 */
export function editedValue(original: string, max: number | null, stamp: string): string {
  if (!original) return fit(markerOf(stamp), max, stamp)
  const v = `${original}ZZ`
  return !max || v.length <= max ? v : `${original.slice(0, Math.max(0, max - 2))}ZZ`
}

/** 弹窗字段要填的值：用户填的优先；文本按规则造；下拉没填就不收（运行时选第一项） */
export function popupValues(fields: WriteField[], overrides: Record<string, string>, now: Date): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) {
    const v = overrides[f.name]?.trim() || valueFor(f, now)
    if (v && f.kind !== 'other') out[f.name] = v
  }
  return out
}

const EXTERNAL = new Set(['commit', 'submit', 'approve', 'audit', 'sync', 'import', 'status', 'revise', 'revoke', 'nc', 'push', 'send', 'cancel', 'upload'])

/** 地址像会触发外部动作：提交 / 审批 / 同步 ERP / 启停 / 导入 / 开票。只看最后一段 */
export function isExternalAction(url: string): boolean {
  const w = wordsOf(url)
  if (w.some((x) => EXTERNAL.has(x))) return true
  return w.includes('invoice') && w.some((x) => x === 'blue' || x === 'red' || x === 'apply')
}

/** 只允许对 dev / sit / 本机做写操作：主机名按 . - 切开后有一段是 dev、sit（可带数字） */
export function writeEnvAllowed(root: string): boolean {
  let host = ''
  try {
    host = new URL(root).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host === 'localhost' || host === '127.0.0.1') return true
  return host.split(/[.-]/).some((p) => /^(dev|sit)\d*$/.test(p))
}

/** 写用例期间只读保险要放行的地址 */
export function writeUrls(d: WriteDraft): string[] {
  const u = d.uni
  const uni =
    !u ? []
    : u.type === 'collect' ? [u.add, u.update, u.remove]
    : u.type === 'formEdit' ? [u.action, u.toggle?.url]
    : u.type === 'vueFormEdit' ? u.actions
    : [...u.actions, ...u.delUrls]
  return [...new Set([d.add?.action, d.edit?.action, d.del?.url, d.disable?.url, d.enable?.url, ...uni].filter((x): x is string => !!x))]
}

/** 请求路径（带上下文路径）是不是放行名单里的地址：去掉上下文路径后全等 */
export function allowsWrite(path: string, allow: string[]): boolean {
  return allow.some((u) => {
    const p = (u.split('?')[0] ?? '').replace(/^(?!\/)/, '/')
    return p.length > 1 && (path === p || path.endsWith(p))
  })
}

/** 草稿为什么不能加白名单；停用地址不查（只对自己造的行用） */
export function draftBlockers(d: WriteDraft): string[] {
  const out = [...d.problems]
  const urls: [string, string | undefined][] = [
    ['新增保存', d.add?.action],
    ['编辑保存', d.edit?.action],
    ['删除', d.del?.url],
  ]
  for (const [what, url] of urls) {
    if (url && isExternalAction(url)) out.push(`${what}地址 ${url} 像是会触发外部动作（提交 / 审批 / 同步 / 开票 / 启停），不让加白名单`)
  }
  return out
}

/** 确认后页面改过（指纹变了 / 重扫后没草稿了）：不再跑，等重新确认 */
export function isStale(spec: WriteSpec, page: PageInfo): boolean {
  return !page.writeDraft || page.writeDraft.fingerprint !== spec.draft.fingerprint
}

/** 加 enable 之前确认的白名单没有这个键：指纹没变就从当前草稿补上（启用和停用是同一段处理，没有新代码要确认） */
export function withFreshOps(spec: WriteSpec, page: PageInfo): WriteSpec {
  if (spec.draft.enable !== undefined || isStale(spec, page)) return spec
  return { ...spec, draft: { ...spec.draft, enable: page.writeDraft!.enable ?? null } }
}

export const leftoverKey = (l: WriteLeftover): string => `${l.pageId}|${l.kind}|${l.marker ?? l.rowId ?? ''}`

export function upsertLeftover(list: WriteLeftover[], l: WriteLeftover): WriteLeftover[] {
  return [...list.filter((x) => leftoverKey(x) !== leftoverKey(l)), l]
}

export function dropLeftover(list: WriteLeftover[], l: WriteLeftover): WriteLeftover[] {
  return list.filter((x) => leftoverKey(x) !== leftoverKey(l))
}

export function upsertSpec(list: WriteSpec[], s: WriteSpec): WriteSpec[] {
  return [...list.filter((x) => x.pageId !== s.pageId), s]
}

/** blob → 状态；坏数据丢掉那一条，整份坏了当空 */
export function parsePageWrite(raw: string | null): PageWriteState {
  try {
    const v = JSON.parse(raw ?? '') as { specs?: unknown; leftovers?: unknown }
    const specs = (Array.isArray(v.specs) ? v.specs : []).filter(
      (s): s is WriteSpec => !!s && typeof (s as WriteSpec).pageId === 'string' && !!(s as WriteSpec).draft,
    )
    const leftovers = (Array.isArray(v.leftovers) ? v.leftovers : []).filter(
      (l): l is WriteLeftover =>
        !!l && typeof (l as WriteLeftover).pageId === 'string' && ((l as WriteLeftover).kind === 'created' || (l as WriteLeftover).kind === 'edited'),
    )
    return { specs, leftovers }
  } catch {
    return { specs: [], leftovers: [] }
  }
}
