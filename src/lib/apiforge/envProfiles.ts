/**
 * 环境组（接口改进 · 体验）：整套环境配置的命名快照，开发 / 测试 / 预发一键切换。
 * 纯函数，落盘在 store（apiforge.envProfiles blob）。**密码不进快照**——调用方
 * 存之前必须先用 envWithoutSecret 剥掉（铁律：密码只活在内存，切环境也不破例）。
 */
import type { EnvProfile, EnvironmentConfig } from './types'

/** 最多留几组：一组就是一份完整 env，不设上限的话 blob 会无声变肥 */
export const ENV_PROFILES_MAX = 10

/**
 * 存一份快照：新的排最前；同名 = 覆盖（旧条目丢掉，不留两份「测试」）；
 * 超出上限从队尾裁。id 现场生成——同名覆盖后 id 会变，以名字为业务身份。
 */
export function upsertProfile(
  old: readonly EnvProfile[],
  name: string,
  env: EnvironmentConfig,
): { list: EnvProfile[]; profile: EnvProfile } {
  const profile: EnvProfile = {
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    savedAt: Date.now(),
    env,
  }
  const list = [profile, ...old.filter((x) => x.name !== name)].slice(0, ENV_PROFILES_MAX)
  return { list, profile }
}

/** 存这个名字会挤掉哪组：同名是覆盖不挤；未满上限不挤；满了挤队尾最旧的一组 */
export function evictedBy(old: readonly EnvProfile[], name: string): string | null {
  if (old.some((x) => x.name === name)) return null
  if (old.length < ENV_PROFILES_MAX) return null
  return old[old.length - 1]?.name ?? null
}

/** 宽容解析：没有 / 坏 JSON / 不是数组 / 条目残缺都当空，不挡页面 */
export function parseProfiles(raw: string | null): EnvProfile[] {
  if (!raw) return []
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(v)) return []
  const out: EnvProfile[] = []
  for (const x of v) {
    if (!x || typeof x !== 'object') continue
    const e = x as Partial<EnvProfile>
    if (typeof e.id !== 'string' || !e.id) continue
    if (typeof e.name !== 'string' || !e.name) continue
    if (!e.env || typeof e.env !== 'object' || Array.isArray(e.env)) continue
    out.push({
      id: e.id,
      name: e.name,
      savedAt: typeof e.savedAt === 'number' ? e.savedAt : 0,
      env: e.env as EnvironmentConfig,
    })
  }
  return out
}
