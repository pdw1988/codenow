/**
 * 参数「说明」给 UI 用。扫描器能抽到 @ApiParam / Javadoc 就用原文；
 * 抽不到（旧缓存、源码没写注解）再按常见名兜底 —— 否则试跑卡只有
 * keyword / pageNum，用户不知道填什么。
 *
 * 兜底只覆盖国内 Spring 列表/查询里反复出现的那些名字，认不出就空串，
 * 不要猜 `foo` 是什么。
 */

const BY_NAME: Record<string, string> = {
  keyword: '关键字：流程编码 / 名称 / 业务ID',
  q: '关键字',
  query: '查询关键字',
  search: '搜索关键字',
  flowstatus: '流程状态（空=全部）',
  status: '状态',
  createby: '发起人',
  createdby: '创建人',
  creator: '发起人',
  updateby: '更新人',
  pagenum: '页码，从 1 起',
  pagenumber: '页码，从 1 起',
  pageno: '页码，从 1 起',
  page: '页码，从 1 起',
  current: '当前页',
  currentpage: '当前页',
  pagesize: '每页条数',
  size: '每页条数',
  limit: '每页条数',
  rows: '每页条数',
  pagelimit: '每页条数',
  offset: '偏移',
  start: '起始位置',
  startrow: '起始行',
  startindex: '起始下标',
  id: '主键',
  ids: '主键列表',
  orgid: '机构 ID',
  deptid: '部门 ID',
  instid: '机构 ID',
  userid: '用户 ID',
  starttime: '开始时间',
  endtime: '结束时间',
  begintime: '开始时间',
  orderby: '排序字段',
  sort: '排序字段',
  order: '排序方向',
}

export function paramHint(p: { name: string; description?: string }): string {
  const scanned = (p.description ?? '').trim()
  if (scanned) return scanned
  return BY_NAME[p.name.replace(/_/g, '').toLowerCase()] ?? ''
}
