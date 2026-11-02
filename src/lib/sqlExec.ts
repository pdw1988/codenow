/**
 * 生成页把已拼好的语句丢给当前连接执行（PRD 19.5）。
 *
 * 只拆 INSERT / UPDATE / DELETE。UPDATE、DELETE 必须带 WHERE。
 * SELECT 送到连库查询跑，不走这条写命令。
 */
import type { DbEnv, DbKind } from '../types/dbconn'
import type { Dialect } from '../types/schema'
import { DIALECTS } from './sqlgen/dialect'
import { extractRunnableSelect } from './sqlReadonly'
import { codeMask, splitStatements, type StatementKind } from './sqlgen/statements'

export const EXEC_STMT_CAP = 2000

/** 没会话时按钮仍能点，弹出选连接。其它原因才发灰。 */
export const NEED_SESSION = '还没连库'

export function isNeedSession(reason: string | null): boolean {
  return Boolean(reason?.startsWith(NEED_SESSION))
}

const WRITE: StatementKind[] = ['insert', 'update', 'delete']

export interface DbSession {
  kind: DbKind
  env?: DbEnv
}

export interface ExecPlan {
  statements: string[]
  kinds: StatementKind[]
}

function hasWherePredicate(sql: string): boolean {
  const mask = codeMask(sql)
  let word = ''
  let after = false
  const flush = () => {
    if (!word) return
    if (word.toUpperCase() === 'WHERE') after = true
    word = ''
  }
  for (let i = 0; i < sql.length; i++) {
    if (!mask[i]) {
      flush()
      continue
    }
    const c = sql[i]
    if (/[A-Za-z_]/.test(c)) {
      word += c
      continue
    }
    flush()
    if (after && !/\s/.test(c) && c !== ';') return true
  }
  flush()
  return false
}

export function assertGenWrite(sql: string): string {
  const text = sql.trim()
  if (!text) throw new Error('没有要执行的语句')
  const stmts = splitStatements(text).filter((s) => s.kind)
  if (stmts.length === 0) throw new Error('没有要执行的语句')
  if (stmts.length > 1) throw new Error('一次只跑一条语句，不要带第二段')
  const kind = stmts[0].kind
  if (kind !== 'insert' && kind !== 'update' && kind !== 'delete') {
    throw new Error(`生成页只执行 INSERT / UPDATE / DELETE，不跑 ${kind.toUpperCase()}`)
  }
  if ((kind === 'update' || kind === 'delete') && !hasWherePredicate(stmts[0].text)) {
    throw new Error(`拒绝没有 WHERE 的 ${kind.toUpperCase()}`)
  }
  return text.replace(/;\s*$/, '')
}

export function planExec(sql: string): ExecPlan {
  const all = splitStatements(sql).filter((s) => s.kind)
  if (all.length === 0) throw new Error('没有要执行的语句')
  const other = all.find((s) => !WRITE.includes(s.kind))
  if (other) {
    throw new Error(
      other.kind === 'select'
        ? '查询请到「连库查询」运行。这里只执行 INSERT / UPDATE / DELETE'
        : `生成页只执行 INSERT / UPDATE / DELETE，不跑 ${other.kind.toUpperCase()}`,
    )
  }
  if (all.length > EXEC_STMT_CAP) {
    throw new Error(`一次最多 ${EXEC_STMT_CAP} 条，请缩小批量`)
  }
  const statements = all.map((s) => assertGenWrite(s.text))
  return { statements, kinds: all.map((s) => s.kind) }
}

export function execDisabledReason(args: {
  sql: string
  pageDialect: Dialect
  session: DbSession | null
  isTauri: boolean
  output?: 'sql' | 'mybatis'
  executable?: boolean
}): string | null {
  if (!args.isTauri) return '浏览器模式没有驱动，请用桌面版'
  if (args.output === 'mybatis') return 'Mapper XML 不能直接执行，请切回 SQL'
  if (args.executable === false) return '预编译占位符不能执行，请切到「可执行」'
  if (!args.sql.trim()) return '还没有可执行的语句'
  if (/#\{/.test(args.sql)) return '语句里还有 #{占位符}，请切到「可执行」'
  if (!args.session) return `${NEED_SESSION}。选一个连接，或到「连库查询」连上`
  if (args.session.kind !== args.pageDialect) {
    const want = DIALECTS[args.pageDialect].label
    const live = DIALECTS[args.session.kind].label
    return `当前连的是 ${live}，这条语句是 ${want}。把上面的方言改成 ${live}，或到连库页换连接`
  }
  // SELECT 不走写命令：按钮改成送到连库查询跑。预编译 / 夹着 DML 仍走下面的 planExec。
  if (extractRunnableSelect(args.sql)) return null
  try {
    planExec(args.sql)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  return null
}
