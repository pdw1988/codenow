/** 登录拿 token：单发重发、报告页、批量回归都用，所以不跟回归编排放一起 */
import { extractToken, sendRequest } from '../http/request'
import type { RunCaseDeps } from './runCase'

export interface LoginOutcome {
  ok: boolean
  token: string | null
  message: string
}

/** 跑登录拿 token。loginApi 是相对 baseUrl 的路径；抽不到 token 也算失败 */
export async function login(deps: Pick<RunCaseDeps, 'env'>): Promise<LoginOutcome> {
  const env = deps.env
  if (!env.loginApi) return { ok: false, token: null, message: '没配登录接口' }
  if (!env.username || !env.password) {
    return { ok: false, token: null, message: '用户名或密码还是空的' }
  }
  const url = `${env.baseUrl.replace(/\/+$/, '')}${env.loginApi.startsWith('/') ? '' : '/'}${env.loginApi}`
  try {
    const resp = await sendRequest(
      {
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: env.username, password: env.password }),
      },
      env.timeoutMs,
    )
    if (!resp.status || resp.status >= 400) {
      return { ok: false, token: null, message: `登录接口返回 ${resp.status ?? '?'}` }
    }
    const token = extractToken(resp.bodyText, env.tokenJsonPath)
    if (!token) {
      return {
        ok: false,
        token: null,
        message: '登录成功但没取到 Token，检查「Token 取值路径」配置',
      }
    }
    return { ok: true, token, message: '登录成功' }
  } catch (e) {
    return { ok: false, token: null, message: String(e) }
  }
}
