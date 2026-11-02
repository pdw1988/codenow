/**
 * 增改删接口的库变化核对。已定（2026-10-20）：先只提示、不判失败——数据在别的库、
 * 别的服务或 MQ 异步写时立刻查库看不到变化，跑几轮看误报再定要不要判。
 * 只在「接口说成功了」时才核对：接口自己报错，库没变是应该的。
 */
import type { TableChange, TestCase } from '../types'
import { isEnvelopeFail } from './judge'

export interface DbHintInput {
  testCase: Pick<TestCase, 'type' | 'probeNotFound' | 'expectedDbChange'>
  httpStatus: number | null
  error?: string
  bodyText: string | null | undefined
  /** 发送前成功快照了几张表；0 = 连着库但关联表一张都没查成 */
  snapshotted: number
  changes: TableChange[]
}

export function dbHintOf(x: DbHintInput): string | undefined {
  const want = x.testCase.expectedDbChange
  if (x.testCase.type !== 'normal' || x.testCase.probeNotFound) return undefined
  if (want !== 'insert' && want !== 'update' && want !== 'delete') return undefined
  if (x.error || x.httpStatus === null || x.httpStatus < 200 || x.httpStatus >= 300) return undefined
  if (isEnvelopeFail(x.bodyText)) return undefined
  if (x.snapshotted === 0) return '没法核对库：接口的关联表一张都没查成'
  const sum = (k: 'rowsInserted' | 'rowsUpdated' | 'rowsDeleted') => x.changes.reduce((n, c) => n + c[k], 0)
  if (want === 'insert' && sum('rowsInserted') === 0) return '接口说成功了，但库里没有新增数据'
  if (want === 'update' && sum('rowsUpdated') === 0) return '接口说成功了，但库里没看到有字段变化'
  // SHOP 很多是逻辑删除（只把 status 改成 1），行还在：字段变了也算删了
  if (want === 'delete' && sum('rowsDeleted') === 0 && sum('rowsUpdated') === 0) {
    return '接口说成功了，但库里既没少行也没改状态'
  }
  return undefined
}
