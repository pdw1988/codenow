/**
 * APIForge 的执行入口（试跑 / 单 API / 全自动回归）。
 *
 * 独立成文件是因为 fast-refresh：组件文件里导出非组件函数会刷出
 * react(only-export-components) 警告，执行编排本来也不该和 UI 混居。
 */
import { useApiforgeStore } from '../../store/useApiforgeStore'
import { useSchemaStore } from '../../store/useSchemaStore'
import { useUiStore } from '../../store/useUiStore'
import { useDbConnStore } from '../../store/useDbConnStore'
import { liveDialect } from '../../lib/dbDialect'
import { buildRequest } from '../../lib/apiforge/http/request'
import { fullBodyOf } from '../../lib/apiforge/http/prettyJson'
import { sessionForConn } from '../../lib/apiforge/dbSession'
import { generateCases } from '../../lib/apiforge/cases/generate'
import { pickSendCase } from '../../lib/apiforge/cases/pickSendCase'
import { mergeLinks, resolveLinks } from '../../lib/apiforge/link/resolveLinks'
import { dictOfScan } from '../../lib/apiforge/scan/bodyFields'
import { dialectOfKind, runCase, type RunCaseDeps } from '../../lib/apiforge/runner/runCase'
import { login } from '../../lib/apiforge/runner/login'
import { skippedOf } from '../../lib/apiforge/runner/resultState'
import { makeFixtureSession, applySampleValues } from '../../lib/apiforge/data/prepare'
import type { Column } from '../../types/schema'
import { judgeCase } from '../../lib/apiforge/runner/judge'
import { schemaCheck } from '../../lib/apiforge/scan/schemaAssert'
import { diffScans } from '../../lib/apiforge/scan/apidiff'
import { scanWorkspace, stopScan as stopScanIpc, loadCachedWorkspace, SCAN_STOPPED_MSG } from '../../lib/apiforge/scan/scanIpc'
import { recordScan } from '../../lib/apiforge/scan/history'
import type {
  ApiMethod,
  CaseRunResult,
  ProjectScanResult,
  ResidueConn,
  TableRelation,
  WorkspaceScanResult,
} from '../../lib/apiforge/types'
import { runEnvOf } from '../../lib/apiforge/views'
import { prepareCaseData } from '../../lib/apiforge/runner/prepareCase'
import { queryByCheckOf } from '../../lib/apiforge/runner/queryBy'
import type { MessageInstance } from 'antd/es/message/interface'

/** 当前在跑别的就拦下并说清在跑什么；返回 true = 被拦 */
export function blockedByRunning(message: MessageInstance): boolean {
  const busy = useApiforgeStore.getState().anyRunning()
  if (busy) void message.warning(`${busy}，等它结束（或先停止）再来`)
  return !!busy
}

/** 关联表：自动识别 + 用户存过的勾选合并，跟接口页 / 关联表页同一口径 */
export function relationsOf(api: ApiMethod, project?: ProjectScanResult): TableRelation[] {
  const s = useApiforgeStore.getState()
  const stored = s.links[api.id] ?? []
  const p = project ?? s.scan?.projects.find((x) => x.projectId === api.projectId)
  return p ? mergeLinks(resolveLinks(api, p, false), stored) : stored
}

/** 当前连着的库（残留检测记下、清理前比对）。以地址认库：同一个库从哪页连的都算同一个 */
export function currentDbConn(): ResidueConn | null {
  const session = useUiStore.getState().dbSession
  if (!session) return null
  const c = session.connId ? useDbConnStore.getState().items.find((x) => x.id === session.connId) : undefined
  const id = session.addr ?? session.connId
  if (c) return { id, label: `${c.name || c.host} · ${c.host}:${c.port}/${c.db}` }
  return { id, label: session.addr ?? `${session.kind}（未记录是哪条连接）` }
}

export function apiTotal(ws: WorkspaceScanResult): number {
  return ws.projects.reduce((n, p) => n + p.controllers.reduce((m, c) => m + c.methods.length, 0), 0)
}

/** 扫描动作：顶栏「开始扫描」和扫描页共用。root 留空回退上次扫描的根目录 */
export function useScan(message: MessageInstance) {
  // 路径放 store：HUD 和扫描页两个 useScan 实例必须看到同一个输入框
  const root = useApiforgeStore((s) => s.scanRoot)
  const setRoot = useApiforgeStore((s) => s.setScanRoot)

  const doScan = async (overrideRoot?: string) => {
    const store = useApiforgeStore.getState()
    const dir = (overrideRoot ?? root).trim() || store.scan?.root || ''
    if (!dir) {
      store.setView('scan')
      store.setScanError('先在「扫描」页填一个 Spring Boot 工程目录（或多工程父目录）')
      return
    }
    await runScan(dir, message)
  }

  /** 停止扫描：选错目录点一下就停，不用等 180 秒超时 */
  const stopScan = async () => {
    try {
      await stopScanIpc()
    } catch (e) {
      void message.warning(String(e))
    }
  }

  return { root, setRoot, doScan, stopScan }
}

/** 扫描主体，目录已定：useScan 的 doScan（顶栏/扫描页/历史卡片）共用 */
async function runScan(dir: string, message: MessageInstance): Promise<void> {
  // 扫描中再扫会起第二个进程（停止只停后一个）；跑用例时换扫描结果会把用例缓存换掉
  if (blockedByRunning(message)) return
  const store = useApiforgeStore.getState()
  store.resetScanLog()
  store.setScanning(true)
  // 扫描进行中要看到 HUD / 工程队列 / 流水：从首页发起的扫描也切到「扫描」页
  store.setView('scan')
  store.setScanError(null)
  try {
    // 扫描前的缓存就是「上一次」：扫描会覆盖缓存，先读出来留给 API Diff（4.13）。
    // 必须把 dir 传进去：全量结果按目录分键存了，不传拿到的是「最近用过的那份」，
    // 可能是另一个工程——下面那道 root 相等的门会把它挡掉，diff 就白丢了
    const prev = await loadCachedWorkspace(dir)
    const ws = await scanWorkspace(dir, (line) => {
      // Java stderr 的 PROG 行实时进 store：解析流水和接口数 KPI 都从这里来
      useApiforgeStore.getState().pushScanLog(line)
    })
    useApiforgeStore.getState().setScan(ws)
    // 同一工程根目录才可比：换了工程 diff 出来的是两拨接口的噪音
    if (prev && prev.root === ws.root && prev.fingerprint !== ws.fingerprint) {
      const d = diffScans(prev, ws)
      useApiforgeStore.getState().setApiDiff(d)
      if (d.entries.length) {
        const st = useApiforgeStore.getState()
        st.pushScanLog(
          `API Diff 对比上次扫描：破坏性 ${d.breakingCount} · 新增 ${d.addedCount} · 删除 ${d.removedCount} · 修改 ${d.changedCount}`,
        )
        for (const e of d.entries.slice(0, 8)) {
          st.pushScanLog(`  ${e.breaking ? '⚠ 破坏性' : '·'} ${e.signature}（${e.controller}）：${e.details.join('；')}`)
        }
        if (d.entries.length > 8) st.pushScanLog(`  …其余 ${d.entries.length - 8} 条省略`)
        void (d.breakingCount
          ? message.warning(`与上次扫描相比有 ${d.entries.length} 处接口变更，其中破坏性 ${d.breakingCount} 处，明细在扫描流水`)
          : message.info(`与上次扫描相比有 ${d.entries.length} 处接口变更（无破坏性）`))
      }
    }
    // 首页「之前扫描过的工程」卡片记一笔（同根覆盖最新在前，写失败不阻断）
    useApiforgeStore.getState().setHistory(await recordScan(ws))
    useApiforgeStore.getState().setView('scan')
    void message.success(`扫描完成：${ws.projects.length} 个工程 / ${apiTotal(ws)} 个接口`)
  } catch (e) {
    const msg = String(e)
    const stopped = msg.includes(SCAN_STOPPED_MSG)
    // 手动停止是用户自己点的，不是失败：清掉报错，流水里记一笔
    useApiforgeStore.getState().setScanError(stopped ? null : msg)
    if (stopped) {
      useApiforgeStore.getState().pushScanLog('已手动停止扫描')
      void message.info('已停止扫描')
    }
  } finally {
    useApiforgeStore.getState().setScanning(false)
  }
}

/**
 * 表 → 列清单：先用出句的表结构缓存，缓存没有再问库。
 * 快照要主键、造数要全部列，两处都从这一份拿 —— 两级查找只留一份。
 */
export function makeTableLookup(): (table: string) => Promise<Column[]> {
  return async (table) => {
    const cached = useSchemaStore.getState().tables.find((t) => t.name === table)
    if (cached) return cached.columns
    const session = apfSession()
    const live = session ? liveDialect(session.kind) : undefined
    if (!live) return []
    try {
      return await live.fetchColumns(table)
    } catch {
      return []
    }
  }
}

/** 主键列查询：造数会话与快照共用上面那份列清单 */
function makePkLookup(): RunCaseDeps['pkLookup'] {
  const lookup = makeTableLookup()
  // 发送前、发送后两轮快照都要主键：本轮记住，不让没导入过的表反复问库
  const memo = new Map<string, Promise<string[]>>()
  return (table) => {
    let hit = memo.get(table)
    if (!hit) {
      hit = pkOf(table)
      memo.set(table, hit)
    }
    return hit
  }
  async function pkOf(table: string): Promise<string[]> {
    const cached = useSchemaStore.getState().tables.find((t) => t.name === table)
    // 缓存里有就直接用（它是权威的本地副本），省掉「有没有主键」这一次 fetchColumns
    if (cached) {
      const pks = cached.columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
      if (pks.length) return pks
    }
    const cols = await lookup(table)
    return cols.filter((c) => c.isPrimaryKey).map((c) => c.name)
  }
}

/** 当前库会话；连的不是环境页选的那条就当没连，免得比对到别的库 */
export function apfSession() {
  return sessionForConn(useUiStore.getState().dbSession, useApiforgeStore.getState().env.connId)
}

/** 组装执行依赖。没连库 live=null：HTTP 照跑，数据库验证记「未连库」 */
export function makeDeps(): RunCaseDeps {
  const s = useApiforgeStore.getState()
  const session = apfSession()
  const live = session ? (liveDialect(session.kind) ?? null) : null
  const dialect = dialectOfKind(session?.kind)
  const env = runEnvOf(s.env, s.showAdvanced)
  // 数据准备默认开（env.autoPrepare，2026-09-19 拍板）。没连库时没有写库通道，开着也不生效；
  // 只跑查询时 runEnvOf 已把它关掉
  const fixture =
    env.autoPrepare && live
      ? makeFixtureSession({
          lookupColumns: makeTableLookup(),
          foreignKeys: useSchemaStore.getState().foreignKeys,
          execSql: (statements) => live.execSql(statements),
          query: (sql) => live.query(sql),
          // 异常学习认表用：连库导入的表清单（名字 + 注释 + Java 类名）
          listTables: async () =>
            useSchemaStore.getState().tables.map((t) => ({
              name: t.name,
              comment: t.comment,
              javaClass: t.javaClass,
            })),
          dialect,
        })
      : undefined
  return {
    env,
    live,
    dialect,
    pkLookup: makePkLookup(),
    token: s.token,
    // 跑批中途 401 自救（runner/relogin）：开跑前登录拿的 token 跑到一半过期时，
    // 收到 401 自动重登一次重试；新 token 写回 deps.token 救整轮
    relogin: () => login({ env: s.env }).then((o) => o.token),
    // 响应结构断言（schemaAssert）的字典：观察模式只记录差异，严格模式判失败
    dict: dictOfScan(s.scan),
    fixture,
    // 库里不存在的表整轮跳过快照（runCase 发现一次就记进来）：一张 mapper 认出来
    // 但不在这个 schema 的表，不该让后面几十个用例每人复读一遍 ORA-00942
    skipTables: new Set(),
  }
}

/** 单接口调试：发指定的用例（缺省取第一条启用的正常用例）一次，结果进右栏首卡 */
export async function runSingleCase(api: ApiMethod, message: MessageInstance, caseId?: string): Promise<void> {
  const s = useApiforgeStore.getState()
  if (blockedByRunning(message)) return
  const list = s.cases[api.id] ?? generateCases(api, dictOfScan(s.scan), s.scan)
  const testCase = (caseId ? list.find((c) => c.id === caseId) : undefined) ?? pickSendCase(list)
  if (!testCase) {
    void message.warning('这个接口没有可用用例')
    return
  }
  const deps = makeDeps()
  // 单发不清报告：结果按 caseId 覆盖进去，上一轮回归的其它结果和流水都留着
  s.beginPartialRun(1)
  s.setSendingApiId(api.id)
  const label = `${api.httpMethod} ${api.path}`
  const log: string[] = []
  try {
    const relations = relationsOf(api)
    let sending = testCase
    // 手工补值最先落：后面的借/造/回填都以「最终要发的值」为基准——补了 id=5，
    // 造出来的行就得是 id=5，而不是先造一行对不上的。只落正常用例——异常/边界
    // 用例的 0/-1 与缺字段语义不能被盖掉
    const samples = deps.env.sampleValues
    if (testCase.type === 'normal' && samples && Object.keys(samples).length) {
      const applied = applySampleValues(api, sending.parameters, samples)
      log.push(...applied.filled)
      if (applied.filled.length) sending = { ...sending, parameters: applied.values }
    }
    const tPrep = Date.now()
    // 借 / 造 / 对准 / 取条件值：与全量回归同一份（runner/prepareCase）
    const prepared = await prepareCaseData(api, sending, relations, deps.fixture)
    log.push(...prepared.log)
    sending = prepared.testCase
    if (deps.fixture) log.push(`耗时：借数 / 造数 ${Date.now() - tPrep}ms`)
    if (prepared.skip) {
      useApiforgeStore.getState().upsertResults([{ ...skippedOf(api, testCase), error: prepared.skip, dataLog: log }])
      useApiforgeStore.getState().finishRun()
      useApiforgeStore.getState().setSendingApiId(null)
      void message.info(`${label}：${prepared.skip}`)
      return
    }
    const out = await runCase(api, sending, relations, deps)
    log.push(...out.log)
    // 判定走 judgeCase：HTTP + 响应体断言 + 结构断言，与全量回归同一层
    const judged = judgeCase(
      testCase.expectedHttpStatus,
      testCase.expectBody,
      out.httpStatus,
      out.error,
      out.responseBodyText,
      schemaCheck(api.responseType, testCase, deps.dict, deps.env.assertMode === 'strict'),
      queryByCheckOf(sending),
    )
    const full = fullBodyOf(out.responseBodyText)
    const result: CaseRunResult = {
      caseId: testCase.id,
      apiId: api.id,
      apiPath: api.path,
      httpMethod: api.httpMethod,
      caseName: testCase.name,
      caseType: testCase.type,
      ok: judged.ok,
      httpStatus: out.httpStatus,
      durationMs: out.durationMs,
      responsePreview: out.responsePreview,
      ...(full ? { responseFull: full } : {}),
      requestBodyPreview: out.requestBodyPreview,
      ...(out.requestBodyFull ? { requestBodyFull: out.requestBodyFull } : {}),
      ...(judged.assertFails.length ? { assertFails: judged.assertFails } : {}),
      ...(judged.schemaIssues.length ? { schemaIssues: judged.schemaIssues } : {}),
      ...(out.dbHint ? { dbHint: out.dbHint } : {}),
      error: out.error,
      dbChanges: out.dbChanges.changes,
      snapshotErrors: out.dbChanges.snapshotErrors,
      dataLog: log,
      // 实际会发的地址（含回填/手工补值之后的参数），跟报告页口径一致
      requestUrl: buildRequest(deps.env, api, sending, deps.token)?.url ?? api.path,
    }
    useApiforgeStore.getState().upsertResults([result])
    useApiforgeStore.getState().finishRun()
    useApiforgeStore.getState().setSendingApiId(null)
    // 人还在这个接口上：调试卡已经显示结果，不再弹；切走了才弹，并带上是哪个接口
    const st = useApiforgeStore.getState()
    if (st.view === 'apis' && st.selectedApiId === api.id) return
    if (result.ok) void message.success(`${label} · HTTP ${result.httpStatus}`)
    else void message.warning(`${label} · HTTP ${result.httpStatus ?? '请求出错'}，详情在该接口的调试卡`)
  } catch (e) {
    useApiforgeStore.getState().finishRun()
    useApiforgeStore.getState().setSendingApiId(null)
    void message.error(`${label}：${String(e)}`)
  } finally {
    // 造出来的行不能留在用户库里：跑挂/被停也要清
    if (deps.fixture) {
      const lines = await deps.fixture.finishAll()
      if (lines.length) useApiforgeStore.getState().pushRunLog(lines.join('\n'))
    }
  }
}
