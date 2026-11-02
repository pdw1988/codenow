/**
 * 配置管理（PRD 五）三种格式共用的解剖工具和类型。
 *
 * notes 按「完整点分路径」记每个叶子的行尾注释 —— 转换成另一种格式后
 * 注释还能找到自己的键，靠的就是这份完整路径。只记本层键名的话，
 * `url` 和 `redis.url` 的注释会串（原型踩过，见 mockup/config.html）。
 * JSON 没有注释，所以它的 notes 恒是空对象。
 */

/** 标量：字符串 | 数字 | 布尔 | null */
export type YamlScalar = string | number | boolean | null

/**
 * 节点的值。列表不用真的 JS 数组：`- item` 解析成父对象上的数字字符串键
 * （`{"0": …}`），这样「列表也是树的一种形状」，flatten / nest / dump
 * 三处都不用写数组分支 —— 分支少一份，「两边规则不一致」的可能性就少一份。
 */
export type YamlNode = { [key: string]: YamlScalar | YamlNode }

/**
 * 解析结果：树 + 按完整路径记的行尾注释。
 *
 * 泛型参数是为了让 parseProps 能如实声明「我的 tree 是扁平的字符串表」——
 * 它的键本来就是完整点分路径、值全是字符串，硬套 YamlNode 类型的话，
 * 调用方每处都得加一层谎称转换的断言。默认 YamlNode 是 YAML 侧的形状。
 */
export interface ParsedConfig<T = YamlNode> {
  tree: T
  notes: Record<string, string>
}

/**
 * 把一行劈成「代码 + 注释」。从左往右扫，找不在引号里的 `#`——
 * `#` 只有在行首或前面是空白时才算注释开头，`a#b` 是值的一部分。
 * 不能用 indexOf('#')：URL 片段、颜色值里都有 #。
 */
export function dissect(line: string): { code: string; comment: string } {
  let q: string | null = null
  let cut = -1
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (q) {
      if (ch === q) q = null
      continue
    }
    if (ch === "'" || ch === '"') {
      q = ch
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      cut = i
      break
    }
  }
  const code = (cut >= 0 ? line.slice(0, cut) : line).trimEnd()
  return { code, comment: cut >= 0 ? line.slice(cut).trim() : '' }
}

/** 剥掉一层配对的引号。只处理首尾成对的，中间的引号是内容 */
export function unquote(v: string): string {
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))
    return v.slice(1, -1)
  return v
}
