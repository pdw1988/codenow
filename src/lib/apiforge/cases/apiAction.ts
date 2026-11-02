/**
 * 接口分「查 / 增 / 改 / 删」。SHOP 几乎全是 POST，只看请求方法的话改、删都被当成新增；
 * POST 再看接口名最后一段的词（读动词表与页面测试的写拦截共用）。认不出的算 unknown，
 * 调用方按老办法（只看请求方法）走，不瞎猜。
 */
import type { ApiAction, ApiMethod, TestCase, WorkspaceScanResult } from '../types'
import { isSuspectWrite, startsWithReadWord, wordsOf } from '../page/writeGuard'

const DELETE_WORDS = new Set(['delete', 'del', 'remove'])
// 改状态的审批类动词也算修改：它们改的是已有的一行
const UPDATE_WORDS = new Set([
  'update', 'edit', 'modify', 'change', 'approve', 'approval', 'audit', 'submit', 'sumbit', 'commit',
  'cancel', 'revoke', 'confirm', 'reject', 'agree', 'withdraw', 'sign', 'verify', 'reset',
])
const INSERT_WORDS = new Set(['save', 'add', 'insert', 'create'])

/** 自动认（不看手改）。saveOrUpdate 两头占：body 字段里有 id 算修改 */
export function guessApiAction(api: Pick<ApiMethod, 'httpMethod' | 'path' | 'requestBodyFields'>): ApiAction {
  switch (api.httpMethod) {
    case 'PUT':
    case 'PATCH': return 'update'
    case 'DELETE': return 'delete'
    case 'GET': return isSuspectWrite(api.path, 'GET') ? actionByWords(api) : 'query'
    default: return startsWithReadWord(api.path) ? 'query' : actionByWords(api)
  }
}

function actionByWords(api: Pick<ApiMethod, 'path' | 'requestBodyFields'>): ApiAction {
  const words = wordsOf(api.path)
  if (words.some((w) => DELETE_WORDS.has(w))) return 'delete'
  const upd = words.some((w) => UPDATE_WORDS.has(w))
  const ins = words.some((w) => INSERT_WORDS.has(w))
  if (upd && ins) return api.requestBodyFields.some((f) => /^id$/i.test(f.name)) ? 'update' : 'insert'
  if (upd) return 'update'
  if (ins) return 'insert'
  return 'unknown'
}

/** 手改优先，没改过就自动认 */
export function apiActionOf(api: Pick<ApiMethod, 'httpMethod' | 'path' | 'requestBodyFields' | 'action'>): ApiAction {
  return api.action ?? guessApiAction(api)
}

export const API_ACTION_LABEL: Record<ApiAction, string> = {
  query: '查',
  insert: '增',
  update: '改',
  delete: '删',
  unknown: '?',
}

/** 预计库变化。认不出的接口按请求方法给（老行为） */
export function dbChangeOfAction(action: ApiAction, httpMethod: string): TestCase['expectedDbChange'] {
  if (action === 'query') return 'none'
  if (action !== 'unknown') return action
  switch (httpMethod) {
    case 'POST': return 'insert'
    case 'PUT':
    case 'PATCH': return 'update'
    case 'DELETE': return 'delete'
    default: return 'none'
  }
}

/**
 * 把手改的分类落到扫描结果上（重扫后重新套一遍，手改不丢）。map 里没有的接口去掉 action；
 * 一处都没变就原样返回，调用方靠引用相等判断要不要 set
 */
export function applyActionOverrides(ws: WorkspaceScanResult, map: Record<string, ApiAction>): WorkspaceScanResult {
  let changed = false
  const projects = ws.projects.map((p) => {
    let pc = false
    const controllers = p.controllers.map((c) => {
      let cc = false
      const methods = c.methods.map((m) => {
        const want = map[m.id]
        if (m.action === want) return m
        cc = true
        if (want === undefined) {
          const { action: _drop, ...rest } = m
          return rest
        }
        return { ...m, action: want }
      })
      if (!cc) return c
      pc = true
      return { ...c, methods }
    })
    if (!pc) return p
    changed = true
    return { ...p, controllers }
  })
  return changed ? { ...ws, projects } : ws
}

/** 回调接口（支付渠道 orderPush、支付 notify 之类，别人推给我们的）：不借数造数、不查库对比，免得发一次等好几秒 */
export function isCallbackApi(api: Pick<ApiMethod, 'path'>): boolean {
  const last = api.path.split('/').filter(Boolean).pop() ?? ''
  return /(push|notify|callback)$/i.test(last)
}

/** 只读跑里能发的接口：确定是查询的才发，认不出的也不发 */
export function isReadAction(api: Pick<ApiMethod, 'httpMethod' | 'path' | 'requestBodyFields' | 'action'>): boolean {
  return apiActionOf(api) === 'query'
}
