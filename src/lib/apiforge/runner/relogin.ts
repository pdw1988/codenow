/**
 * 跑批中途 401 自救（接口改进 · 体验）：token 只在开跑前登录管一次，全量回归 /
 * 长链路场景 / 数据驱动跑到一半 token 过期，后面的用例全 401——归因（4.18）能
 * 认出「401 = token 过期」，但不会自救。这层包在发送口上：收到 401 且配了登录
 * 接口、本轮还没自救过 → 重登一次、换新 token 重发**同一条**请求。限一次：重试
 * 还 401 就照实返回让归因说话，不跟登录接口死磕。新 token 写回 holder（= 各
 * runner 的 deps 对象），后续请求 buildRequest 读 deps.token 自动带上——重登一次
 * 救的是整轮，不是一条。
 */
import type { BuiltRequest } from '../http/request'
import type { EnvironmentConfig } from '../types'

export type HttpSender = (
  req: BuiltRequest,
  timeoutMs: number,
) => Promise<{ status: number | null; bodyText: string }>

export interface ReloginOpts {
  env: EnvironmentConfig
  /** runner 的 deps 对象本身：新 token 写回 holder.token，后续请求自动用上 */
  holder: { token: string | null }
  send: HttpSender
  /** 重登一次，返回新 token；null = 登录失败，本次自救放弃、原结果照实返回 */
  relogin: () => Promise<string | null>
}

export function makeReloginSend({ env, holder, send, relogin }: ReloginOpts): HttpSender {
  let done = false
  return async (req, timeoutMs) => {
    const out = await send(req, timeoutMs)
    if (out.status !== 401 || done || !env.loginApi) return out
    done = true
    const token = await relogin()
    if (!token) return out
    holder.token = token
    const header = env.tokenHeader || 'Authorization'
    const prefix = env.tokenPrefix ? `${env.tokenPrefix} ` : ''
    const retry: BuiltRequest = { ...req, headers: { ...req.headers, [header]: `${prefix}${token}` } }
    return send(retry, timeoutMs)
  }
}
