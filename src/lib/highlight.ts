/**
 * 代码着色。**输出是 token 数组，不是 HTML 字符串** —— 由 React 渲染成
 * `<span class="k">` 之类。`mockup/_shell.js` 那份返回 HTML 是因为原型只能
 * `innerHTML =`，React 侧走 `dangerouslySetInnerHTML` 等于把生成的 SQL
 * （里面有用户粘进来的注释和字符串）当 HTML 执行，没有任何必要。
 *
 * 三条着色规则跟原型是同一套（`.k/.s/.n/.f/.c` 五个类名也在 `_theme.css` 里，
 * 跟着主题走），所以原型和应用里同一段 SQL 的颜色是一样的。
 *
 * SQL 只用**一条主正则一次扫完**，不是「先换注释再换字符串」那种叠加式替换：
 * 叠加会让注释里的引号把后面的规则带偏（`-- 这里有个 ' 号` 之后的正常代码
 * 会被当成字符串一路吞到下一个引号）。这条是 `highlight.test.ts` 里钉住的。
 */

/** 对应 `_theme.css` 的 `.k`(关键字) `.s`(字符串) `.n`(数字) `.f`(占位符/属性) `.c`(注释)，'' = 不着色 */
export type TokenClass = '' | 'k' | 's' | 'n' | 'f' | 'c'

export interface Token {
  text: string
  cls: TokenClass
}

export type Lang = 'sql' | 'xml' | 'json' | 'yaml' | 'props' | 'text'

const KEYWORDS = (
  'select|insert|into|values|update|set|delete|from|where|and|or|not|null|is|left|right|inner|full|outer|' +
  'join|on|as|order|group|by|having|limit|offset|create|table|primary|key|foreign|references|constraint|default|' +
  'comment|auto_increment|unique|index|alter|add|drop|rownum|fetch|first|next|rows|only|case|when|then|else|end|' +
  'in|like|between|distinct|exists|union|all|count|sum|avg|max|min|coalesce|nvl|to_date|to_char|sysdate|now|' +
  'current_timestamp|true|false|desc|asc|charset|engine|using|with|generated|identity|number|varchar2|varchar|' +
  'char|int|integer|bigint|smallint|tinyint|decimal|numeric|date|datetime|timestamp|text|clob|blob|boolean'
)

const SQL_RE = new RegExp(
  '(--[^\\n]*|/\\*[\\s\\S]*?\\*/)' + // 1 注释
    "|('(?:[^']|'')*')" + //             2 字符串（'' 是转义的单引号，不能在这里断开）
    '|(#\\{[\\w.]+\\}|\\?)' + //         3 占位符
    '|\\b(\\d+(?:\\.\\d+)?)\\b' + //     4 数字
    '|\\b(' + KEYWORDS + ')\\b', //      5 关键字
  'gi',
)

const XML_RE = /(<!--[\s\S]*?-->)|(<\/?)([\w:.-]+)|([\w:.-]+)=("[^"]*")|(#\{[\w.]+\})/g

const JSON_RE =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(true|false|null)\b/g

// 配置管理（PRD 五）的两种语言。正则跟 mockup/config.html 的 ymlHi/propsHi
// 同一套（原型返回 HTML 是因为只能 innerHTML；这里出 token 由 React 渲染）。
// 依旧是一条主正则单趟扫完——分步叠加会把前一步插进去的标记吃掉，
// 这条教训在 _shell.js 的 sqlHi 注释和下面 SQL 的注释里都记过。
const YAML_RE =
  /(#.*)$|('[^']*'|"[^"]*")|^([ \t]*[\w.-]+)(?=:)|\b(-?\d+(?:\.\d+)?)\b/gm

const PROPS_RE = /(#.*)$|^([\w.[\]-]+)(=)|\b(-?\d+(?:\.\d+)?)\b/gm

/**
 * 通用扫描：正则命中的片段交给 pick 分类，命中之间的空隙原样保留。
 *
 * 「空隙原样保留」是这里唯一重要的性质：token 拼回去必须等于原文。
 * 少一个字符在界面上就是「生成的 SQL 和复制到剪贴板的 SQL 不一样」，
 * 而复制走的是原始 code，肉眼很难发现。highlight.test.ts 对每种语言都断言了这条。
 */
function scan(src: string, re: RegExp, pick: (m: RegExpExecArray) => Token[]): Token[] {
  const out: Token[] = []
  let last = 0
  let m: RegExpExecArray | null
  re.lastIndex = 0
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ text: src.slice(last, m.index), cls: '' })
    for (const t of pick(m)) if (t.text) out.push(t)
    last = m.index + m[0].length
    // 零宽命中会让 lastIndex 卡住，死循环
    if (m[0] === '') re.lastIndex += 1
  }
  if (last < src.length) out.push({ text: src.slice(last), cls: '' })
  return out
}

const sql = (src: string): Token[] =>
  scan(src, SQL_RE, (m) => [
    {
      text: m[0],
      cls: m[1] ? 'c' : m[2] ? 's' : m[3] ? 'f' : m[4] ? 'n' : 'k',
    },
  ])

const xml = (src: string): Token[] =>
  scan(src, XML_RE, (m) => {
    if (m[1]) return [{ text: m[1], cls: 'c' }]
    // 标签名跟左尖括号分开：`<` 本身不着色，跟原型一致
    if (m[3]) return [{ text: m[2], cls: '' }, { text: m[3], cls: 'k' }]
    if (m[5]) return [{ text: m[4], cls: 'f' }, { text: '=', cls: '' }, { text: m[5], cls: 's' }]
    return [{ text: m[6], cls: 'n' }]
  })

const json = (src: string): Token[] =>
  scan(src, JSON_RE, (m) => {
    // 键和字符串值都是带引号的串，靠「后面紧跟冒号」区分
    if (m[1]) {
      return m[2]
        ? [{ text: m[1], cls: 'k' }, { text: m[2], cls: '' }]
        : [{ text: m[1], cls: 's' }]
    }
    return [{ text: m[0], cls: m[3] ? 'n' : 'f' }]
  })

const yaml = (src: string): Token[] =>
  scan(src, YAML_RE, (m) => [
    { text: m[0], cls: m[1] ? 'c' : m[2] ? 's' : m[3] ? 'k' : 'n' },
  ])

const props = (src: string): Token[] =>
  scan(src, PROPS_RE, (m) => {
    if (m[1]) return [{ text: m[1], cls: 'c' }]
    // 键命中时把 = 原样吐回去：着色只准改颜色，= 本身不算键的一部分
    if (m[2]) return [{ text: m[2], cls: 'k' }, { text: '=', cls: '' }]
    return [{ text: m[0], cls: 'n' }]
  })

export function highlight(code: string, lang: Lang = 'text'): Token[] {
  if (!code) return []
  switch (lang) {
    case 'sql':
      return sql(code)
    case 'xml':
      return xml(code)
    case 'json':
      return json(code)
    case 'yaml':
      return yaml(code)
    case 'props':
      return props(code)
    default:
      return [{ text: code, cls: '' }]
  }
}
