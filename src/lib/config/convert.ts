/**
 * 三种格式之间的桥：树的展开 / 折叠 + 格式嗅探（PRD 五 5.4.1 与「自动识别」）。
 *
 * YAML → Properties 是「层级展开」（嵌套树 → a.b.c 点分键），
 * Properties → YAML 是「层级折叠」，两个方向共用这里的中间形态
 * Record<path, scalar>，互转规则因此只有一份。JSON（2026-09-22 补）
 * 直接吃这棵树，parse/dump 在 json.ts，所以它跟另两种也共用同一份中间形态。
 */
import type { YamlNode, YamlScalar } from './common'

/**
 * 展开嵌套树为点分路径。列表子键出 `servers.0` 这种路径 ——
 * Spring Boot 的绑定写法本来就认 `a.b[0]` / `a.b.0`，这里用点分保持简单，
 * nest() 折叠时两种都接。
 */
export function flatten(
  node: YamlNode,
  prefix = '',
  out: Record<string, YamlScalar> = {},
): Record<string, YamlScalar> {
  for (const [k, v] of Object.entries(node)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object') {
      const sub = v as YamlNode
      // 空分支没有叶子可展开：落成空值而不是把对象塞进标量表
      // （原型在这里会把 "[object Object]" 写进输出，正式版修掉）
      if (Object.keys(sub).length === 0) out[p] = ''
      else flatten(sub, p, out)
    } else {
      out[p] = v
    }
  }
  return out
}

/**
 * 把点分路径折回嵌套树。`a.b[0]` 的下标记法拆开还原成列表形状的数字键；
 * 一长一短的两个键互相覆盖时（`a` 是叶子、`a.b` 又要进来）报冲突——
 * 静默覆盖的话用户拿到的 YAML 少一块还不知道为什么。
 */
export function nest(flat: Record<string, YamlScalar>): YamlNode {
  const root: YamlNode = {}
  for (const [path, val] of Object.entries(flat)) {
    const parts: string[] = []
    path.split('.').forEach((seg) => {
      const m = /^(\w+)\[(\d+)\]$/.exec(seg)
      if (m) parts.push(m[1], m[2])
      else parts.push(seg)
    })

    let cur: YamlNode = root
    parts.forEach((k, i) => {
      const existing = cur[k]
      if (i === parts.length - 1) {
        if (existing !== undefined && typeof existing === 'object')
          throw new Error(`'${path}' 和已有的键冲突：一个既是叶子又是分支`)
        cur[k] = val
        return
      }
      if (existing !== undefined && typeof existing !== 'object')
        throw new Error(`'${path}' 和已有的键冲突：一个既是叶子又是分支`)
      cur[k] = existing ?? {}
      cur = cur[k] as YamlNode
    })
  }
  return root
}

export type ConfigFormat = 'yaml' | 'props' | 'json'

/**
 * 按内容特征猜格式：找到第一行非注释非空行 —— 以 `{` / `[` 开头的是 JSON，
 * 长得像 `key=` 成片且全文没有 `key: value` 的算 Properties；其余一律 YAML。
 * 猜不中的默认 YAML——它是页面的默认模式，猜错时用户的直觉也是「这是 yaml」。
 */
export function sniff(src: string): ConfigFormat {
  const firstLine =
    src.split('\n').find((l) => l.trim() && !l.trim().startsWith('#')) ?? ''
  const head = firstLine.trim()
  // JSON 的顶层只可能是对象或数组，行首一个花括号/方括号就够了 ——
  // 反过来 YAML 的 flow 写法也长这样，但本项目不写 flow YAML，用户更不会
  if (head.startsWith('{') || head.startsWith('[')) return 'json'
  if (!/^[ \t]*[\w.[\]-]+\s*[=:][ \t]*\S/.test(firstLine)) return 'yaml'
  const looksLikeProps = /^\s*[\w.[\]-]+\s*=\s*\S/m.test(src)
  const hasYamlPair = /: \S/.test(src)
  return looksLikeProps && !hasYamlPair ? 'props' : 'yaml'
}
