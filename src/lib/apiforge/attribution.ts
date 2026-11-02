/**
 * 失败自动归因（PRD v0.6 模块 4.18）。
 *
 * 失败的用例只给一句「期望 200，实际 500」远远不够——使用者真正要的是
 * 「下一步看哪里」。这里按规则把每条失败分进归因桶并给出处理建议：
 * 报告（MD/HTML）、JUnit 失败正文、CLI 日志三处共用这一份。
 *
 * 规则顺序就是优先级：先排除「请求根本没发出去」，再看连接层，再看 HTTP
 * 状态码；500 里先认「插库缺必填列」，认不出才分「库已有写变更」（写一半回滚）
 * 和纯服务端异常。
 * 纯函数：不看环境、不发请求，判定依据全在结果里——包括 `responsePreview`
 * （HTTP 500 带 body 时 runCase 只把异常正文塞在那里，`error` 是空的）。
 */
import type { CaseRunResult } from './types'

export interface FailureAttribution {
  /** 归因桶名，报告里聚合展示的 key */
  bucket: string
  /** 人话处理建议：指向下一步该看哪里 */
  hint: string
}

/**
 * 「这条报错是在说某列必须有值而 SQL 没给」的四种说法（四种库各一种）。
 * 漏一种，那类失败就整批掉回 500 的通用分法——所以这里宁可比 `nullColumnOf`
 * 宽一点：认得出形状、抠不出列名，也照样归桶，只是提示里不带列名。
 * 两边的四种形状由单测钉着（Oracle/MySQL/SQL Server/PostgreSQL 各一条），
 * 只改一边会有用例红。
 */
const NULL_COLUMN_MSG =
  /ORA-01400|cannot insert NULL|Cannot insert the value NULL into column|Column\s+'[^']+'\s+cannot be null|null value in column\s+"[^"]+"\s+violates not-null/i

/**
 * 「插库时某列必须有值，而 SQL 没给」的归因。
 *
 * 为什么值得单开一桶：这是 500 里**最具体**的一种——真因在后端的 insert 上
 * （创建人/修改人这类审计字段漏填最常见），而且用户自己能验证（请求体补一个
 * 字段再发）。笼统归进「服务端异常」，提示只说「看响应体或服务端日志」，
 * 等于把已经查明的事再说成不知道。
 *
 * 认不出来给 null，调用方照旧落到 500 的通用分法。
 */
function nullColumnAttribution(text: string): FailureAttribution | null {
  // 响应体是 JSON，报错整个塞在 msg 里，引号到我们手上是 \" 转义过的
  // （runCase 存原文）。先褪掉这层壳，下面几种正则才能按「报错本来的样子」写
  const plain = text.replace(/\\+"/g, '"')
  if (!NULL_COLUMN_MSG.test(plain)) return null
  const col = nullColumnOf(plain)
  return {
    bucket: '写库缺必填列',
    hint: col
      ? `插库时 ${col} 没值，被数据库的 NOT NULL 拦住：看后端实体和 Mapper 的 insert——创建人、修改人这类审计字段最容易漏；接口要求调用方带这个字段的话，到接口调试卡补进请求体再发`
      : '插库时有必填列没值，被数据库拦住：看响应体里的列名，以及后端 insert 语句有没有带上它（创建人、修改人这类审计字段最容易漏）',
  }
}

/**
 * 从报错文本里把「表.列」或列名抠出来。抠不出来给 null——提示里少了列名也还是
 * 人话，只是要让用户自己去响应体里找那一段。
 * 覆盖四种库的报错形状，因为被测服务连什么库我们管不着。
 */
function nullColumnOf(text: string): string | null {
  // Oracle：ORA-01400: cannot insert NULL into ("SCHEMA"."T"."C")
  const ora3 = /cannot insert NULL into\s+\("[^"]+"\."([^"]+)"\."([^"]+)"\)/i.exec(text)
  if (ora3) return `${ora3[1]}.${ora3[2]}`
  // 同一条报错的两段式（有些驱动不带 schema）
  const ora2 = /cannot insert NULL into\s+\("([^"]+)"\."([^"]+)"\)/i.exec(text)
  if (ora2) return `${ora2[1]}.${ora2[2]}`
  // MySQL：Column 'creator' cannot be null
  const my = /Column\s+'([^']+)'\s+cannot be null/i.exec(text)
  if (my) return my[1]
  // SQL Server：Cannot insert the value NULL into column 'Creator', table 'T'
  const ms = /Cannot insert the value NULL into column\s+'([^']+)'/i.exec(text)
  if (ms) return ms[1]
  // PostgreSQL：null value in column "creator" violates not-null constraint
  const pg = /null value in column\s+"([^"]+)"\s+violates not-null/i.exec(text)
  if (pg) return pg[1]
  // 不带引号的兜底：只认真像个标识符的。少了这道闸，"into the target table"
  // 里的 the 会被当成列名，提示就成了一句假话
  const bare = /cannot insert NULL into\s+["'`]?([^\s"'`;,)]+)/i.exec(text)
  return bare && isIdentLike(bare[1]) ? bare[1] : null
}

/** 标识符不像才拒绝：全大写（Oracle 不引号的默认形态）或带分隔符（下划线/点）。 */
function isIdentLike(s: string): boolean {
  return (/^[A-Za-z_][\w$#]*(\.[A-Za-z_][\w$#]*)?$/.test(s) && (/[_$.]/.test(s) || /^[A-Z0-9_$#]+$/.test(s)))
}

/**
 * Base URL 填错（默认值 8080 猜错、端口换了、context-path 漏了）是「服务连不上 /
 * 404」最常见的真因，而归因层看不见环境配置——调用方（GUI 报告页 / CLI）手里有
 * baseUrl 就传进来，hint 直接带当前值，用户不用再翻环境页核对。没传就维持原话
 * （纯函数纪律：不自己去读 store）。
 */
const urlTip = (baseUrl?: string) => (baseUrl ? `（当前 ${baseUrl}）` : '')

export function attributeFailure(r: CaseRunResult, baseUrl?: string): FailureAttribution | null {
  if (r.ok || r.skipped) return null
  const err = r.error ?? ''
  const wrote = r.dbChanges.some((c) => c.rowsInserted + c.rowsUpdated + c.rowsDeleted > 0)
  let a: FailureAttribution
  if (r.assertFails?.length) {
    // judgeCase 的契约：体断言只在 HTTP 层过了才跑，所以走到这的一定是
    // 「状态码对、响应体不对」。不拦的话会掉进下面的兜底桶，对着一个
    // 完全正常的 200 说「实际 HTTP 200 不在用例期望里」——归因说谎比不归因更糟
    a = {
      bucket: '体断言未命中',
      hint: `响应体断言失败：${r.assertFails[0]}${r.assertFails.length > 1 ? `（共 ${r.assertFails.length} 条）` : ''} —— 按信封字段查参数，或到报告里改这条用例的体断言`,
    }
  } else if (err.includes('路径参数缺失')) {
    // runCase 的标志性报错：请求没发出去，谈不上服务的问题
    a = { bucket: '用例缺参数', hint: '路径参数没值，请求没发出去：到「用例」页补上该参数' }
  } else if (r.httpStatus === null) {
    a = err.includes('超时')
      ? { bucket: '服务无响应', hint: '请求超时：服务挂着没响应，或环境配置的 timeoutMs 太小' }
      : {
          bucket: '服务连不上',
          hint: `服务未启动或网络不通（${err.slice(0, 80)}）——先核对环境页 Base URL${urlTip(baseUrl)}`,
        }
  } else if (r.httpStatus === 401 || r.httpStatus === 403) {
    a = { bucket: '认证权限', hint: 'Token 未携带 / 已过期 / 权限不足：检查登录配置与「Token 请求头名称」' }
  } else if (r.httpStatus === 404) {
    a = { bucket: '路径未命中', hint: `baseUrl + 路径 404：检查环境 Base URL${urlTip(baseUrl)}与服务的实际路径` }
  } else if (r.httpStatus >= 500) {
    // 500 里先认「插库缺必填列」：它比下面两桶都具体，认出来就别再让人猜
    a =
      nullColumnAttribution(`${r.error ?? ''}\n${r.responsePreview ?? ''}`) ??
      (wrote
        ? { bucket: '疑似写一半回滚', hint: 'HTTP 500 且库已有写变更：业务异常回滚失败，数据写了一半——先看响应体与服务端日志' }
        : { bucket: '服务端异常', hint: '服务内部错误：看响应体里的异常信息或被测服务日志' })
  } else {
    a = { bucket: '期望未命中', hint: `实际 HTTP ${r.httpStatus} 不在用例期望里：改用例期望或修参数` }
  }
  // 快照失败不单独成桶（不是失败的原因），但必须提醒：这单的数据验证不可信
  if (r.snapshotErrors.length) {
    a = {
      ...a,
      hint: `${a.hint}；另：数据库快照有失败（${r.snapshotErrors.length} 张表），这单的数据验证不可信`,
    }
  }
  return a
}

export interface AttributionBucket {
  bucket: string
  count: number
  hint: string
  /** 命中该桶的接口路径（去重） */
  apis: string[]
}

/** 按桶聚合整场失败的失败：CI 日志和报告「失败归因」小节用它 */
export function attributeSummary(results: CaseRunResult[], baseUrl?: string): AttributionBucket[] {
  const m = new Map<string, AttributionBucket>()
  for (const r of results) {
    const a = attributeFailure(r, baseUrl)
    if (!a) continue
    const cur = m.get(a.bucket) ?? { bucket: a.bucket, count: 0, hint: a.hint, apis: [] }
    cur.count += 1
    if (!cur.apis.includes(r.apiPath)) cur.apis.push(r.apiPath)
    m.set(a.bucket, cur)
  }
  return [...m.values()].sort((x, y) => y.count - x.count)
}
