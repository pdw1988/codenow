/**
 * 响应 JSON 字段「含义」给 UI 用。扫描器抽到的 VO/DTO 说明优先；
 * 抽不到（旧缓存、返回 Map、源码没写注释）再按常见名兜底。
 *
 * 信封字段（code/msg/data）和分页（rows/total）几乎每个国内 Spring 接口都有，
 * 不扫也能看懂。认不出的名字给空串，不瞎猜。
 */
import { paramHint } from './paramHint'
import type { DtoField, ScannedType } from './types'

const BY_NAME: Record<string, string> = {
  code: '状态码',
  msg: '提示信息',
  message: '提示信息',
  data: '业务数据',
  success: '是否成功',
  error: '错误信息',
  timeout: '超时标记',
  rows: '列表',
  records: '列表',
  list: '列表',
  items: '列表',
  content: '列表',
  result: '结果',
  total: '总条数',
  totalcount: '总条数',
  count: '条数',
  pages: '总页数',
  hasnext: '是否有下一页',
  hasmore: '是否有下一页',
  definitionid: '流程定义 ID',
  flowcode: '流程编码',
  flowname: '流程名称',
  version: '版本',
  businessid: '业务 ID',
  flowstatus: '流程状态',
  flowstatusname: '流程状态中文名',
  activitystatus: '活动状态（0 挂起 / 1 活跃）',
  activitystatusname: '活动状态中文名',
  nodecode: '当前节点编码',
  nodename: '当前节点',
  todohandlers: '当前待办人',
  todohandlernames: '当前待办人姓名',
  createtime: '创建时间',
  updatetime: '更新时间',
  createdate: '创建日期',
  updatedate: '更新日期',
}

export function normFieldKey(name: string): string {
  return name.replace(/_/g, '').toLowerCase()
}

/**
 * 扫描到的字段说明做成查表。同一个名字在多个类型里说明不一致就丢掉，
 * 宁可靠常见名兜底，也不把「状态码」写成别的类型的「编码」。
 */
export function fieldDocsOf(
  types: readonly ScannedType[] | undefined,
  extra?: readonly DtoField[],
): Map<string, string> {
  const bags = new Map<string, Set<string>>()
  const add = (name: string, desc?: string) => {
    const d = (desc ?? '').trim()
    if (!d) return
    const k = normFieldKey(name)
    let set = bags.get(k)
    if (!set) {
      set = new Set()
      bags.set(k, set)
    }
    set.add(d)
  }
  for (const t of types ?? []) for (const f of t.fields) add(f.name, f.description)
  for (const f of extra ?? []) add(f.name, f.description)
  const out = new Map<string, string>()
  for (const [k, set] of bags) {
    if (set.size === 1) out.set(k, [...set][0]!)
  }
  return out
}

export function fieldHint(name: string, docs?: Map<string, string>): string {
  const k = normFieldKey(name)
  const scanned = docs?.get(k)?.trim()
  if (scanned) return scanned
  if (BY_NAME[k]) return BY_NAME[k]
  return paramHint({ name })
}
