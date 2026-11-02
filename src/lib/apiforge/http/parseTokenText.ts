/**
 * 从剪贴板 / 粘贴文本里抠出 token，并尽量认出该用哪一个请求头。
 *
 * 用户从 Chrome Network → Headers 两列表复制时，常见是制表符：
 * `Token\t<uuid>`，不是文档里写的 `token: xx`。整段请求头、curl、门户
 * `?token=`、Cookie 里的 shiroCookie、裸 UUID 都要能用——不要强迫手工改格式。
 */

/** 像 JWT 的三段 base64url（宽松：只认形状，不验签） */
const JWT_LIKE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

/** Shiro sessionId 常见形态：UUID */
const UUID_LIKE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 认证相关头名。Chrome 两列表会把 Token 显示成首字母大写。 */
const AUTH_HEADER = /^(token|authorization|x-auth-token|x-access-token|x-token|access-token)$/i

export type ParsedAuth = {
  token: string
  /** 从粘贴里认出的头名；认不出则 undefined，调用方保持现有配置 */
  header?: string
  /** Bearer 或空串；认不出则 undefined */
  prefix?: string
}

function stripQuotes(v: string): string {
  return v.trim().replace(/^['"]|['"]$/g, '').trim()
}

/**
 * 校对用的脱敏展示：首 8 尾 6 + 长度。
 *
 * 粘完之后输入框就被清掉了（而且它是 password 框），原来只提示头名和前缀，
 * 用户根本无法校对「抠出来的到底是哪一段」——抠成 Cookie、抠半截、抠到头名那一格
 * 表面上都一样「已注入」。首尾加长度足够跟 Chrome 里的值过一眼，又不把整个凭证摊在屏幕上。
 *
 * 短值（≤ 16）不拆首尾：拆了等于全显，还不如直接全糊掉只给长度。
 */
export function maskToken(token: string): string {
  if (token === '') return ''
  if (token.length <= 16) return `${'•'.repeat(token.length)}（共 ${token.length} 字）`
  return `${token.slice(0, 8)}…${token.slice(-6)}（共 ${token.length} 字）`
}

/** `Token: uuid` / `Token\tuuid` / `token = uuid` */
function splitHeaderLine(line: string): { name: string; value: string } | null {
  const t = line.trim()
  if (!t) return null
  const m = t.match(/^([A-Za-z][\w-]*)\s*[:=\t]\s*(.*)$/)
  if (!m) return null
  return { name: m[1], value: m[2].trim() }
}

function fromAuthHeader(name: string, rawValue: string): ParsedAuth | null {
  const value = stripQuotes(rawValue)
  if (!value) return null
  if (/^authorization$/i.test(name)) {
    const bearer = value.match(/^Bearer\s+(\S+)/i)
    if (bearer) return { token: bearer[1], header: 'Authorization', prefix: 'Bearer' }
    return { token: value.split(/\s/)[0] ?? value, header: 'Authorization', prefix: '' }
  }
  const header = name.toLowerCase() === 'token' ? 'token' : name
  return { token: value.split(/\s/)[0] ?? value, header, prefix: '' }
}

function fromCookie(cookie: string): ParsedAuth | null {
  const m = cookie.match(/(?:^|[;,\s])shiroCookie=([^;,\s]+)/i)
  if (!m?.[1]) return null
  return { token: m[1], header: 'token', prefix: '' }
}

function inferBare(token: string): ParsedAuth {
  if (UUID_LIKE.test(token)) return { token, header: 'token', prefix: '' }
  if (JWT_LIKE.test(token)) return { token, header: 'Authorization', prefix: 'Bearer' }
  return { token }
}

/**
 * 从一段文本抽出应注入的 token，以及（若能认出）头名/前缀。
 * 失败返回 null（调用方 toast「剪贴板里没找到」）。
 */
export function parseAuthPaste(raw: string): ParsedAuth | null {
  const text = raw.trim()
  if (!text) return null

  // 1) curl -H "token: xxx" / -H "Authorization: Bearer xxx"
  const curlTok = text.match(/-H\s+['"]token\s*:\s*([^'"]+)['"]/i)
  if (curlTok?.[1]) return { token: stripQuotes(curlTok[1]), header: 'token', prefix: '' }
  const curlAuth = text.match(/-H\s+['"]Authorization\s*:\s*(?:Bearer\s+)?([^'"]+)['"]/i)
  if (curlAuth?.[1]) {
    const hasBearer = /Authorization\s*:\s*Bearer/i.test(text)
    return {
      token: stripQuotes(curlAuth[1]),
      header: 'Authorization',
      prefix: hasBearer ? 'Bearer' : '',
    }
  }

  // 2) HAR / fetch：{"name":"token","value":"…"} 或 headers: { "token": "…" }
  const harNameFirst = text.match(
    /"name"\s*:\s*"(token|authorization)"\s*,\s*"value"\s*:\s*"([^"]+)"/i,
  )
  if (harNameFirst?.[1] && harNameFirst[2]) {
    const parsed = fromAuthHeader(harNameFirst[1], harNameFirst[2])
    if (parsed) return parsed
  }
  const harValueFirst = text.match(
    /"value"\s*:\s*"([^"]+)"\s*,\s*"name"\s*:\s*"(token|authorization)"/i,
  )
  if (harValueFirst?.[1] && harValueFirst[2]) {
    const parsed = fromAuthHeader(harValueFirst[2], harValueFirst[1])
    if (parsed) return parsed
  }
  const fetchTok = text.match(/['"]token['"]\s*[:=]\s*['"]([^'"]+)['"]/i)
  if (fetchTok?.[1] && !/^https?:\/\//i.test(fetchTok[1])) {
    return { token: fetchTok[1], header: 'token', prefix: '' }
  }

  // 3) 请求头表：Chrome 两列复制是 Tab，Copy request headers 是冒号。
  //    Cookie 行常排在 Token 前面，shiroCookie 只作后备，不要抢先返回。
  let cookieFallback: ParsedAuth | null = null
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const split = splitHeaderLine(line)
    if (split && AUTH_HEADER.test(split.name)) {
      const parsed = fromAuthHeader(split.name, split.value)
      if (parsed) return parsed
    }
    if (split && /^cookie$/i.test(split.name)) {
      cookieFallback = fromCookie(split.value) ?? cookieFallback
    }
    // 偶发：左列 Token、右列值被拆成两行
    const nameOnly = line.trim()
    if (AUTH_HEADER.test(nameOnly) && !split) {
      const next = (lines[i + 1] ?? '').trim()
      if (next && (JWT_LIKE.test(next) || UUID_LIKE.test(next) || next.length >= 16)) {
        const parsed = fromAuthHeader(nameOnly, next)
        if (parsed) return parsed
      }
    }
  }

  // 4) 门户跳转 URL：?token=<sessionId>
  const fromQuery =
    text.match(/[?&#]token=([^&\s#"']+)/i) ?? text.match(/(?:^|[?\s])token=([^&\s#"']+)/i)
  if (fromQuery?.[1]) {
    let v = fromQuery[1].trim()
    try {
      v = decodeURIComponent(v).trim()
    } catch {
      // 原样用
    }
    if (v) return { token: v, header: 'token', prefix: '' }
  }

  if (cookieFallback) return cookieFallback

  // 5) 「Bearer xxx」单独一行
  const bearer = text.match(/^Bearer\s+(\S+)$/i)
  if (bearer?.[1]) return { token: bearer[1].trim(), header: 'Authorization', prefix: 'Bearer' }

  // 6) 整段就是裸值（无空白 / 单行）
  if (!/[\s]/.test(text) && (JWT_LIKE.test(text) || UUID_LIKE.test(text) || text.length >= 16)) {
    return inferBare(text)
  }

  // 7) 多行里找第一个像 token 的词
  for (const line of lines) {
    const w = line.trim()
    if (!w || w.startsWith('#')) continue
    if (JWT_LIKE.test(w) || UUID_LIKE.test(w)) return inferBare(w)
  }

  return null
}

/** 只要 token 字符串；头名由 parseAuthPaste 提供。 */
export function parseTokenText(raw: string): string | null {
  return parseAuthPaste(raw)?.token ?? null
}
