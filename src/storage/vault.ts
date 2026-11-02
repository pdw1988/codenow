/**
 * 常用信息：VPN、堡垒机、生产库这些账号地址收在一处，省得每次翻文本。
 *
 * 条目存 SQLite blob；标了「敏感」的字段值不进 blob，整条一次写进本机凭据库
 * （`vaultCredTarget`，Windows 是 DPAPI）。字段是自由的「名称 + 值」，分类只管预填哪几行。
 */

/** SQLite cache_metadata 的键。清空缓存的白名单里要有它（sqliteStore.clear） */
export const VAULT_KEY = 'vault'

export const VAULT_LIMIT = 300
export const VAULT_FIELD_LIMIT = 30

export type VaultCat = 'vpn' | 'bastion' | 'db' | 'server' | 'other'

export const VAULT_CATS: ReadonlyArray<{ value: VaultCat; label: string }> = [
  { value: 'vpn', label: 'VPN' },
  { value: 'bastion', label: '堡垒机' },
  { value: 'db', label: '数据库' },
  { value: 'server', label: '服务器' },
  { value: 'other', label: '其它' },
]

export const catLabel = (c: VaultCat) => VAULT_CATS.find((x) => x.value === c)?.label ?? '其它'

export interface VaultField {
  id: string
  label: string
  /** 敏感字段这里永远是空串，真值在凭据库 */
  value: string
  secret: boolean
}

export interface VaultItem {
  id: string
  name: string
  cat: VaultCat
  fields: VaultField[]
  note: string
  updatedAt: number
}

export const newVaultId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

const SECRET_RE = /密码|口令|密钥|pass|pwd|secret|token/i

/** 字段名像密码就默认勾敏感 */
export const looksSecret = (label: string) => SECRET_RE.test(label)

const f = (label: string, secret = false): Omit<VaultField, 'id'> => ({ label, value: '', secret })

const PRESET: Record<VaultCat, Array<Omit<VaultField, 'id'>>> = {
  vpn: [f('地址'), f('账号'), f('密码', true), f('客户端')],
  bastion: [f('地址'), f('账号'), f('密码', true)],
  db: [f('类型'), f('地址'), f('端口'), f('库名 / 服务名'), f('账号'), f('密码', true)],
  server: [f('地址'), f('端口'), f('账号'), f('密码', true)],
  other: [f('')],
}

export const presetFields = (cat: VaultCat): VaultField[] => PRESET[cat].map((x) => ({ ...x, id: newVaultId() }))

function isField(v: unknown): v is VaultField {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r.id === 'string' && r.id !== '' && typeof r.label === 'string' && typeof r.value === 'string'
}

function isItem(v: unknown): v is VaultItem {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    r.id.trim() !== '' &&
    typeof r.name === 'string' &&
    r.name.trim() !== '' &&
    Array.isArray(r.fields)
  )
}

/** 坏条目跳过；敏感字段误存进来的值读的时候就洗掉 */
export function parseVault(raw: string | null): VaultItem[] {
  if (!raw) return []
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  return arr.filter(isItem).map((it) => ({
    id: it.id.trim(),
    name: it.name.trim(),
    cat: VAULT_CATS.some((c) => c.value === it.cat) ? it.cat : 'other',
    fields: (it.fields as unknown[]).filter(isField).map((x) => ({
      id: x.id,
      label: x.label,
      value: x.secret === true ? '' : x.value,
      secret: x.secret === true,
    })),
    note: typeof it.note === 'string' ? it.note : '',
    updatedAt: typeof it.updatedAt === 'number' ? it.updatedAt : 0,
  }))
}

/**
 * 存之前整理：去掉名和值都空的行；敏感值拆出来单给凭据库。
 * 返回的 item 里敏感字段 value 一律空。
 */
export function splitSecrets(item: VaultItem): { item: VaultItem; secrets: Record<string, string> } {
  const secrets: Record<string, string> = {}
  const fields = item.fields
    .map((x) => ({ ...x, label: x.label.trim(), value: x.secret ? x.value : x.value.trim() }))
    .filter((x) => x.label !== '' || x.value.trim() !== '')
    .map((x) => {
      if (!x.secret) return x
      if (x.value !== '') secrets[x.id] = x.value
      return { ...x, value: '' }
    })
  return { item: { ...item, name: item.name.trim(), note: item.note.trim(), fields }, secrets }
}

/** 改过的留在原位（列表不跳），新的放最前 */
export function upsertVault(list: VaultItem[], item: VaultItem): VaultItem[] {
  const at = list.findIndex((x) => x.id === item.id)
  if (at < 0) return [item, ...list].slice(0, VAULT_LIMIT)
  const next = list.slice()
  next[at] = item
  return next
}

export const removeVault = (list: VaultItem[], id: string) => list.filter((x) => x.id !== id)

/** 搜名称、分类、字段名、非敏感的值、备注 */
export function matchVault(it: VaultItem, kw: string): boolean {
  const k = kw.trim().toLowerCase()
  if (!k) return true
  const hay = [it.name, catLabel(it.cat), it.note, ...it.fields.flatMap((x) => [x.label, x.value])]
  return hay.join('\n').toLowerCase().includes(k)
}

/** 卡片上第二行显示什么：第一个有值的非敏感字段，一般就是地址 */
export const vaultSummary = (it: VaultItem) => it.fields.find((x) => !x.secret && x.value)?.value ?? ''

/** 整行就是一个地址：别把 `https://…` 里的冒号当成「名: 值」的分隔 */
const URL_RE = /^(jdbc:|[a-z][a-z0-9+.-]*:\/\/)/i
const KV_RE = /^([^:：=]{1,24}?)\s*[:：=]\s*(.*)$/

/**
 * 粘贴一段随手记的文本，拆成字段。
 * 「名：值」「名: 值」「名=值」每行一个字段；整行是地址的记成「地址」；其余的行进备注。
 */
export function parseVaultText(text: string): { fields: VaultField[]; note: string } {
  const fields: VaultField[] = []
  const rest: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    if (URL_RE.test(t)) {
      fields.push({ id: newVaultId(), label: '地址', value: t, secret: false })
      continue
    }
    const m = KV_RE.exec(t)
    // 10.0.0.8:22 这种不是「名: 值」
    if (m && /^[\d.]+$/.test(m[1].trim())) {
      fields.push({ id: newVaultId(), label: '地址', value: t, secret: false })
      continue
    }
    if (m && m[2].trim() !== '') {
      const label = m[1].trim()
      fields.push({ id: newVaultId(), label, value: m[2].trim(), secret: looksSecret(label) })
      continue
    }
    rest.push(t)
  }
  return { fields: fields.slice(0, VAULT_FIELD_LIMIT), note: rest.join('\n') }
}

/** 凭据库的键：一条一个，里面是 { 字段id: 值 } 的 JSON */
export const vaultCredTarget = (id: string) => `vault|${id}`
