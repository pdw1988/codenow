/**
 * 只读保险：页面测试只点「查询」，但页面脚本自己也可能发请求（打开即同步、自动保存）。
 * 接口名里有写动词的 XHR 在浏览器层拦掉并记录。读动词打头的放行：
 * getAuditList 是查审核列表，拦了页面就坏了，保险反而制造假失败。
 */
const WRITE_WORDS = new Set([
  'save', 'add', 'insert', 'update', 'edit', 'modify', 'delete', 'del', 'remove', 'commit', 'submit',
  'approve', 'audit', 'sync', 'import', 'upload', 'cancel', 'revoke', 'push', 'send', 'reset', 'create',
  // mall / purchase 的审批、签收、确认、改派、生成条码类接口；sumbit 是常见的拼写错误
  'approval', 'sign', 'confirm', 'verify', 'reject', 'agree', 'withdraw', 'sumbit', 'change', 'gen',
])
const READ_FIRST = new Set([
  'get', 'query', 'list', 'find', 'search', 'select', 'load', 'count', 'check', 'export', 'show', 'view',
  'page', 'to', 'init', 'open', 'detail', 'download', 'print', 'preview',
])
const STATIC_EXT = /\.(js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|map|html?|ftl)$/i

/** 路径里的 id 段（纯数字、长十六进制 / uuid、接口库里的 {id}）：DELETE /order/123 要看前一段 */
const ID_SEG = /^(\d+|[0-9a-f-]{16,}|\{[^}]*\})$/i

/** URL 最后一段路径（跳过末尾的 id）拆成小写词：syncAllOrderHistoryData → sync all order history data */
export function wordsOf(url: string): string[] {
  const path = url.split(/[?#]/)[0]?.split(';')[0] ?? ''
  const last = path.split('/').filter((s) => s && !ID_SEG.test(s)).pop() ?? ''
  return last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
}

/** 不管地址叫什么都算写的请求方法 */
const WRITE_METHODS = new Set(['PUT', 'DELETE', 'PATCH'])

export function isSuspectWrite(url: string, method = 'GET'): boolean {
  const path = url.split(/[?#]/)[0]?.split(';')[0] ?? ''
  if (WRITE_METHODS.has(method.toUpperCase())) return true
  if (STATIC_EXT.test(path)) return false
  // UEditor 初始化读配置：serverUrl 常是页面自己或 ueditor/upload，靠 action 区分读写
  if (/[?&]action=config(&|$)/.test(url)) return false
  const words = wordsOf(url)
  if (!words.length || READ_FIRST.has(words[0] ?? '')) return false
  return words.some((w) => WRITE_WORDS.has(w))
}

/** 接口名以读动词打头（getAuditList、listByPage）。接口分类（cases/apiAction）与只读判定共用这张表 */
export function startsWithReadWord(url: string): boolean {
  return READ_FIRST.has(wordsOf(url)[0] ?? '')
}

/**
 * 确定只读的接口（比 !isSuspectWrite 严）：GET 且不带写动词，或读动词打头。
 * POST /process 这种认不出的不算：拿它跳过查库，认错了就漏看一次写库。
 */
export function isClearlyRead(url: string, method = 'GET'): boolean {
  if (isSuspectWrite(url, method)) return false
  if (method.toUpperCase() === 'GET') return true
  return READ_FIRST.has(wordsOf(url)[0] ?? '')
}
