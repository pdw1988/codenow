/** shell 单引号里的单引号要写成 '\'' */
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * 拼一条能贴进终端重放的 curl。不带认证头（令牌不进剪贴板，按环境自己加）。
 * 多行 JSON 直接放进引号，服务端解析不受空白影响。
 */
export function toCurl(method: string, url: string, body?: string | null): string {
  const data = body ? ` \\\n  -d ${q(body)}` : ''
  return `curl -X ${method.toUpperCase()} ${q(url)} \\\n  -H 'Content-Type: application/json'${data}`
}
