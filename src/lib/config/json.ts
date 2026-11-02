/**
 * JSON 侧的解析与输出（PRD 五的第三种格式 —— 原文档只写 YAML + Properties，
 * 2026-09-22 用户要求「json / yml / 属性文件都加上」才补的）。
 *
 * 链路上的形状跟另两种对齐：parseJson 出 tree + notes、dumpJson 吃 tree，
 * 所以 ConfigPanel 里三种格式两两互转只差一次 parse + 一次 dump。
 *
 * **解析用 JSON.parse，不自己写扫描器**：JSON 的语法由 ECMA 定死，写第二份只会
 * 得到「跟标准不一致」的那一份 —— 本项目「同一规则两份」的坑踩过不止一次
 * （布尔字面量、方言分页）。代价是错误信息里拿不到可靠的行号，见 locate()。
 *
 * JSON 没有注释，所以 notes 恒是空对象：转去 YAML / Properties 时不会凭空
 * 多出注释（反向另说 —— JSON 存不下注释，转过去就是丢）。
 */
import type { ParsedConfig, YamlNode, YamlScalar } from './common'
import { isListLike } from './yaml'
import { parsePreservingBig, stringifyPreservingBig } from '../bigIntJson'

/**
 * 把 JSON 的值搬进树。数组变成数字字符串键的对象 —— 跟 YAML 侧「列表也是树的
 * 一种形状」同一套表示（common.ts 的 YamlNode 注释），flatten / nest / dumpYaml
 * 于是都不用为 JSON 单开分支。
 */
function toValue(v: unknown): YamlScalar | YamlNode {
  if (Array.isArray(v)) {
    const o: YamlNode = {}
    v.forEach((item, i) => {
      o[String(i)] = toValue(item)
    })
    return o
  }
  if (v !== null && typeof v === 'object') {
    const o: YamlNode = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = toValue(val)
    return o
  }
  // 五种 JSON 标量里 null 在 YamlScalar 里就是 null，其余 string/number/boolean 直接是
  return v as YamlScalar
}

/**
 * 树的相反方向：数字键对象还原成真数组。判「是不是列表」复用 yaml.ts 那一份。
 *
 * 已知的角：**空数组和空对象在 YamlNode 里都是 `{}`**，转出去统一变成空对象。
 * YAML 侧本来就这样（`a: []` 存成 `{}`，dumpYaml 出 `a:`），所以这里不为第三种
 * 格式单开一套「这是空数组」的标记 —— 真要补就得改 YamlNode 本身，那是两份形状
 * 换来一个配置文件里极少出现的空数组。
 */
function fromValue(v: YamlScalar | YamlNode): unknown {
  if (v !== null && typeof v === 'object') {
    const node = v as YamlNode
    if (isListLike(node)) {
      return Object.keys(node)
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => fromValue(node[k]))
    }
    const o: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(node)) o[k] = fromValue(val)
    return o
  }
  return v
}

/**
 * 错误定位。页面上的错误条按 `第 N 行` 取行号、把编辑器那一行标红
 * （ConfigPanel 的 badLine），所以这里必须给出「第 N 行」。
 *
 * V8 两个版本的说法不一样，两条都接：老的给 `position N`（字符下标），折回行号；
 * 新的把出错处的原文引在消息里（`…, "  "b": ," is not valid JSON`），
 * 拿这段原文回源码里找那一行。两样都拿不到就只报原文，**不编行号** ——
 * 报错指着一行没问题的代码比不报行号更糟。
 *
 * 片段要按「引号里的内容」逐段试，而且**先试最长的那段**：V8 有时只截一个
 * 横跨几行的窗口，整段塞不进单独一行；片段里还常带着 JSON 自己的引号
 * （`"b"`），所以第一个引号对往往不是有用那段。
 */
function locate(src: string, e: Error): string {
  const pos = Number(/position (\d+)/.exec(e.message)?.[1] ?? NaN)
  if (Number.isFinite(pos)) return `第 ${src.slice(0, pos).split('\n').length} 行`

  const lines = src.split('\n')
  const segs = [...e.message.matchAll(/"([^"\n]*)"/g)]
    .map((m) => m[1].trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  for (const seg of segs) {
    const ln = lines.findIndex((l) => l.includes(seg))
    if (ln >= 0) return `第 ${ln + 1} 行`
  }
  return ''
}

export function parseJson(src: string): ParsedConfig {
  let data: unknown
  try {
    data = JSON.parse(src)
  } catch (e) {
    const where = locate(src, e as Error)
    throw new Error(`${where}不是合法 JSON：${(e as Error).message}`)
  }

  // 大整数安全：合法已成定局，重 parse 一遍拿保真树——雪花 id 当 Number 圆整
  // 后再 dump，格式化一次就永久丢了精度。哨兵字符串在 dumpJson 还原成裸数字
  try {
    data = parsePreservingBig(src)
  } catch {
    // 包裹扫描理论上不会让合法 JSON 变非法；真发生了就退回裸 parse 的树
  }

  const value = toValue(data)
  // 顶层必须是键的集合。散落的标量（`42`、`"x"`、`null`）转不成配置文件，
  // 它的 dump 是全篇一个值，用户拿到的是另一种格式的同一个值，白转一趟
  if (value === null || typeof value !== 'object')
    throw new Error('第 1 行：JSON 顶层必须是对象或数组 —— 配置文件是一堆键，不是一个值')

  return { tree: value as YamlNode, notes: {} }
}

/**
 * 输出 JSON。indentUnit 给 2 / 4 都行 —— 页面上的缩进开关本来是为 YAML 做的，
 * JSON 这里顺手共用一个开关，不为第三种格式再加一个 Seg。
 */
export function dumpJson(node: YamlNode, indentUnit: number): string {
  return stringifyPreservingBig(fromValue(node), indentUnit)
}
