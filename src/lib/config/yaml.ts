/**
 * YAML 的迷你解析 / 生成（PRD 五）。
 *
 * 只做够用的子集：缩进层级 map、标量、单行注释、`- ` 列表项。
 * 不支持 flow 语法 `{a: 1}`、块标量 `|`、锚点、多文档 —— 这个工具面向的是
 * Spring Boot 配置文件，那些语法在 application.yml 里几乎不出现。
 * 解析不是目标，校验和互转才是，所以**错误必须带行号抛出来**
 * （PRD 验收标准：缩进错误能定位到行号）。
 *
 * 缩进以偶数空格为准，混用直接报错 —— 那正是用户最常犯的错，
 * 报「期望偶数空格」比宽容地猜一个层级更能帮到人。
 */
import type { ParsedConfig, YamlNode, YamlScalar } from './common'
import { dissect, unquote } from './common'

/** 标量：去引号；纯数字转数字；true/false/null/~ 转字面量 */
function scalarOf(text: string): YamlScalar {
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  return unquote(text)
}

/**
 * 解析 YAML。缩进栈顶是当前父级；叶子注释按完整点分路径记进 notes。
 */
export function parseYaml(src: string): ParsedConfig {
  const tree: YamlNode = {}
  const notes: Record<string, string> = {}
  const stack: Array<{ indent: number; node: YamlNode; path: string }> = [
    { indent: -2, node: tree, path: '' },
  ]
  // 最近一个叶子的路径：`- item` 挂在它名下（YAML 里列表属于最近的键）
  let lastListOwner = ''

  src.split('\n').forEach((raw, idx) => {
    const ln = idx + 1
    const { code, comment } = dissect(raw)
    if (!code.trim()) return // 空行 / 纯注释行不参与结构
    if (/^\t/.test(raw)) throw new Error(`第 ${ln} 行：非法字符——制表符，缩进必须用空格`)
    const indent = code.match(/^ */)![0].length
    const body = code.trim()

    if (indent % 2 !== 0 && !body.startsWith('- '))
      throw new Error(`第 ${ln} 行：缩进错误——期望偶数空格，实际 ${indent} 个`)
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const top = stack[stack.length - 1]

    if (body.startsWith('- ')) {
      // 列表项：挂在最近一个键名下，键是下标。map 形状的列表项不解析（见头部注释的子集说明）
      const owner = lastListOwner || top.path
      const n = Object.keys(top.node).filter((k) => /^\d+$/.test(k)).length
      top.node[n] = scalarOf(body.slice(2))
      if (comment) notes[`${owner}[${n}]`] = comment
      return
    }

    const m = /^([^:]+):(?:\s+(.*))?$/.exec(body)
    if (!m) throw new Error(`第 ${ln} 行：看不懂的行——既不是 a: b 也不是 - item`)
    const key = unquote(m[1].trim())
    if (key in top.node) throw new Error(`第 ${ln} 行：重复键 '${key}'`)
    const path = top.path ? `${top.path}.${key}` : key

    if (m[2]) {
      top.node[key] = scalarOf(m[2])
      if (comment) notes[path] = comment
      lastListOwner = path
    } else {
      top.node[key] = {}
      stack.push({ indent, node: top.node[key] as YamlNode, path })
    }
  })
  return { tree, notes }
}

/** 全部键都是连续数字的对象是解析器表示列表的方式（见 common.ts 的类型注释） */
export function isListLike(node: YamlNode): boolean {
  const keys = Object.keys(node)
  return keys.length > 0 && keys.every((k) => /^\d+$/.test(k))
}

/**
 * 生成 YAML。notes 按**完整点分路径**回填行尾注释——嵌套键只看本层键名的话
 * `url` 和 `redis.url` 会串。分隔符固定三个空格，跟原型一致。
 *
 * 列表还原成 `- item`：解析时存成了数字键对象，直接走通用分支会 dump 成
 * `0: xxx`，格式化一次就把用户的列表改坏了。
 */
export function dumpYaml(node: YamlNode, indentUnit: number, notes: Record<string, string> = {}): string {
  const out: string[] = []
  const walk = (node: YamlNode, depth: number, base: string) => {
    for (const [k, v] of Object.entries(node)) {
      const pad = ' '.repeat(indentUnit * depth)
      const path = base ? `${base}.${k}` : k

      if (v !== null && typeof v === 'object' && isListLike(v as YamlNode)) {
        out.push(`${pad}${k}:`)
        const list = v as YamlNode
        Object.keys(list)
          .sort((a, b) => Number(a) - Number(b))
          .forEach((n) => {
            const item = list[n]
            const text =
              item === null
                ? '~'
                : typeof item === 'string' && /[#:]/.test(item)
                  ? `'${item}'`
                  : String(item)
            const note = notes[`${path}[${n}]`]
            out.push(`${pad}${' '.repeat(indentUnit)}- ${text}${note ? `   ${note}` : ''}`)
          })
        continue
      }

      if (v !== null && typeof v === 'object') {
        out.push(`${pad}${k}:`)
        walk(v as YamlNode, depth + 1, path)
      } else {
        const text =
          v === null ? '~' : typeof v === 'string' && /[#:]/.test(v) ? `'${v}'` : String(v)
        out.push(`${pad}${k}: ${text}${notes[path] ? `   ${notes[path]}` : ''}`)
      }
    }
  }
  walk(node, 0, '')
  return out.join('\n')
}
