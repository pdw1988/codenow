/**
 * 连库后的查询。现在这页**专做手写 SQL**：SQL 框在上、结果网格在下，各吃一半高度。
 * 查询字段 / 查询条件 / 排序·分组·分页三块按需求暂时藏起（SHOW_PICK_BARS 改回 true 即还原，
 * 底下的勾列、拼条件、重建 SQL 的逻辑都还在）。
 *
 * 查询框什么都收（DBeaver 口径，2026-09-24）：整段都是只读查询（SELECT / WITH / SHOW）
 * 直接跑；混进写语句 / DDL 就整份交给确认链——ALTER / COMMENT ON / CREATE INDEX /
 * ANALYZE / 带 WHERE 的 UPDATE / DELETE / INSERT / CREATE TABLE AS SELECT 都行，
 * 没连库先弹选连接，生产 / 删列 / 改删行要点名确认。原来的「执行 DDL」独立弹窗撤了，
 * 它的字典刷新逻辑搬进了 onApplied。点左表立刻查；FROM 后出表名提示、`别名.` 出列名提示
 * （lib/sqlhint + SqlArea）。写操作（复制/插入/更新/删除）收在结果底栏。
 * 「索引落地」清单自己带一个「在当前连接执行」，建索引不必再开别的客户端。
 * 勾选行可按主键删除（PRD 19.3）或更新（PRD 19.4），可插入一行（PRD 19.7）。
 * 方言差异只通过 spec.query / spec.deleteRows / spec.updateRows / spec.insertRows / spec.id，这里不写 if (kind === mysql)。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { App } from 'antd'
import { BulbOutlined, StarOutlined } from '@ant-design/icons'
import type { LiveDbDialect } from '../../lib/dbDialect'
import type { DbEnv } from '../../types/dbconn'
import type { FavoriteConn } from '../../types/favorite'
import { defaultFavName, extractTables, favNow, splitFavList } from '../../lib/sqlfav'
import {
  ADVICE_ITEMS_MAX,
  ADVICE_SQL_MAX,
  newAdviceLogId,
} from '../../lib/sqladviseLog'
import type { Column } from '../../types/schema'
import {
  assertReadonlySelect,
  previewSqlWithWhere,
  QUERY_ROW_CAP,
  QUERY_ROW_CAP_ALL,
  type QueryGrid,
} from '../../lib/sqlReadonly'
import {
  buildInsertFromGrid,
  filterRows,
  gridToTsv,
  guessTableFromSql,
  nextSort,
  sortRows,
  type GridSort,
} from '../../lib/queryGrid'
import {
  assertPkDelete,
  buildDeleteFromGrid,
  buildPkWhereFromGrid,
  pkColumnNames,
  type DeletePlan,
} from '../../lib/queryDelete'
import {
  assertPkUpdate,
  buildCellUpdate,
  buildUpdateFromGrid,
  gridCellSample,
  settableColumns,
  type UpdatePlan,
} from '../../lib/queryUpdate'
import {
  assertRowInsert,
  buildInsertRow,
  defaultInsertOn,
  defaultInsertValue,
  insertColumnNote,
  isInsertDateColumn,
  type InsertPlan,
} from '../../lib/queryInsert'
import {
  CMP_OP_OPTIONS,
  GROUP_COUNT_ALIAS,
  ORDER_DIR_OPTIONS,
  PAGE_SIZES,
  type CmpOp,
  type OrderDir,
} from '../../lib/sqlgen/executable'
import {
  DEFAULT_QUERY_SHAPE,
  defaultOrderColumn,
  groupOrderAllow,
  groupSelectExprs,
  resolveOrder,
  shapeSummary,
  type QueryShape,
} from '../../lib/queryShape'
import { formatSql } from '../../lib/sqlgen/sqlFormat'
import { sortColumnsForUi, isDateRelatedColumn } from '../../lib/columnOrder'
import {
  isAggPickToken,
  pickAggFlags,
  primaryKeyForCount,
  realNamesOf,
  selectExprsFromPick,
} from '../../lib/columnPick'
import { AUDIT } from '../sqlgen/ValuePanel'
import { ColumnPickGrid } from '../sqlgen/ColumnPickGrid'
import { usePickMoreColumns } from '../sqlgen/usePickMore'
import { PickMoreBtn } from '../sqlgen/PickMoreBtn'
import { sqlNames } from '../../lib/sqlhint'
import { sqlAdvise, advise, applyAdvice, type AdvSeverity, type IndexDef, type IndexNeed, type SqlAdvice } from '../../lib/sqladvise'
import { useFavoriteStore } from '../../store/useFavoriteStore'
import { useSqlAdviseStore } from '../../store/useSqlAdviseStore'
import { useSchemaStore } from '../../store/useSchemaStore'
import { useApiforgeStore } from '../../store/useApiforgeStore'
import { useUiStore } from '../../store/useUiStore'
import { pageInNav } from '../../components/shell/pages'
import { apisForTables } from '../../lib/apiforge/apilookup'
import { QueryResultGrid } from './QueryResultGrid'
import { AdviceItems } from './AdviceItems'
import { IndexPlan } from './IndexPlan'
import { ExecAlterOnConn } from '../schema/ExecAlterOnConn'
import { alterTableTargets, splitRunInput } from '../../lib/sqlAlter'
import { SqlArea } from './SqlArea'
import { ColumnTable } from '../schema/ColumnTable'
import {
  Band,
  Btn,
  Card,
  Cb,
  Code,
  CopyBtn,
  Dlg,
  Fld,
  Hint,
  Lbl,
  Row,
  Seg,
  Sel,
  Tag,
  Tbl,
  WaitMask,
} from '../../components/ui'

interface Props {
  spec: LiveDbDialect
  seedSql: string
  seedTable: string
  /** 同一张表再点一次也要回填：只比 SQL 文本会当成没变 */
  seedRev: number
  /**
   * 灌进来的 SQL 要不要立刻跑。点左侧表清单 / 旧跳转入口都是 true（灌的是 previewSql）；
   * 收藏详情跳过来是 false——收藏里可能是 DELETE/UPDATE，不能替用户按执行。
   */
  seedRun: boolean
  /** 当前连的库。收藏时一起存，以后从收藏详情能一点回到这个库。密码不存 */
  conn: FavoriteConn
  /** 我的连接上的环境标签。生产要再确认一次 */
  env?: DbEnv
  /** 库里所有表名。SQL 提示（FROM 空格后出表名）用 */
  tableNames: readonly string[]
}

/** 需求拍板（2026-09）：这页先只做手写 SQL，查询字段/查询条件/排序·分组·分页暂时藏起。
 *  想还原改回 true——三块卡和它们背后的勾列/条件/排序逻辑都原样保留着。 */
const SHOW_PICK_BARS = false

/**
 * 把 SQL 里这些表的索引补进 cache：拉过的、已知没有的不再碰库。
 *
 * 体检面板的 effect 和「跑完查询记一笔历史」共用这一份——两处各写一遍的结果
 * 就是以后只改好一处（同项目里 TRUE/FALSE、造数规则踩过的坑）。
 * 返回新拉到几张表，调用方按需 bump metaRev 让体检重算。
 *
 * 并发下同一个表可能被拉两遍（effect 和记录钩子同时跑）：重复的那份会覆盖
 * cache 里同一份索引，没有别的影响——为了这个再加一把锁不值得。
 */
async function ensureIndexes(
  tables: readonly string[],
  spec: LiveDbDialect,
  cache: Map<string, IndexDef[]>,
  miss: Set<string>,
  known: readonly string[] = [],
): Promise<number> {
  const fetch = spec.fetchIndexes
  if (!fetch) return 0
  let fresh = 0
  await Promise.all(
    tables.map(async (t) => {
      const key = t.toLowerCase()
      if (cache.has(key) || miss.has(key)) return
      // 表清单在手而这张不在里面：多半是打了一半的词或子查询别名，别去打库
      if (known.length > 0 && !known.some((n) => n.toLowerCase() === key)) return
      try {
        cache.set(key, await fetch(t))
        fresh++
      } catch {
        miss.add(key)
      }
    }),
  )
  return fresh
}

/** null = 全选 → *；列出字段名；空数组由调用方挡住不跑。聚合记号走 exprs。 */
function sqlFromPick(
  kind: LiveDbDialect['id'],
  table: string,
  selected: string[] | null,
  all: Column[],
  condOn: string[] | null,
  condVals: Record<string, string>,
  cmpOps: Record<string, CmpOp>,
  shape: QueryShape,
): string | null {
  const names = selected ?? all.map((c) => c.name)
  const agg = pickAggFlags(selected)
  const real = realNamesOf(names)
  if (real.length === 0 && !agg.star && !agg.pk && !shape.groupCol) return null

  const wanted = new Set(condOn ?? [])
  const conditions = all
    .filter((c) => wanted.has(c.name))
    .map((c) => ({
      column: c,
      value: condVals[c.name] ?? '',
      op: cmpOps[c.name] ?? ('eq' as CmpOp),
    }))

  const page = { size: shape.pageSize, index: shape.pageIndex }
  const fallbackOrder = defaultOrderColumn(all)

  /*
   * 选了分组：SELECT 就是「分组列 + COUNT(*)」，勾列不参与——
   * 跟单表生成页同一套语义（那边 Hint 也是这么写的），不另搞一套。
   */
  if (shape.groupCol) {
    return previewSqlWithWhere(kind, table, undefined, conditions, {
      exprs: groupSelectExprs(kind, shape.groupCol),
      groupBy: [shape.groupCol],
      orderBy: resolveOrder(shape, groupOrderAllow(shape.groupCol), shape.groupCol),
      page,
    })
  }

  if (agg.star || agg.pk) {
    // 从 null 勾上聚合时 selected 已是显式列表；解析表达式 + 可选 GROUP BY
    const resolved = selectExprsFromPick(kind, selected ?? names, all)
    if (!resolved.exprs.length) return null
    // 聚合下 SELECT 里只有维度列和 COUNT 别名，排序只能在这些名字里挑
    const pk = primaryKeyForCount(all)
    const allow = [
      ...resolved.groupBy,
      ...(agg.star ? [GROUP_COUNT_ALIAS] : []),
      ...(agg.pk && pk ? [`${pk.name}_cnt`] : []),
    ]
    return previewSqlWithWhere(kind, table, undefined, conditions, {
      exprs: resolved.exprs.map((e) => e.text),
      groupBy: resolved.groupBy,
      orderBy: resolveOrder(shape, allow, fallbackOrder),
      page,
    })
  }

  const cols =
    selected === null || real.length === all.length ? undefined : real
  return previewSqlWithWhere(kind, table, cols, conditions, {
    orderBy: resolveOrder(shape, cols ?? all.map((c) => c.name), fallbackOrder),
    page,
  })
}

/** 连库条件格子：关键列默认露，其余加载更多／收起 */
function QueryCondCols({
  columns,
  condNames,
  condVals,
  cmpOps,
  onToggle,
  onOp,
  onValChange,
  onValCommit,
}: {
  columns: Column[]
  condNames: string[]
  condVals: Record<string, string>
  cmpOps: Record<string, CmpOp>
  onToggle: (name: string, on: boolean) => void
  onOp: (name: string, op: CmpOp) => void
  onValChange: (name: string, value: string) => void
  onValCommit: (name: string, value: string) => void
}) {
  const { visible, more, moreOpen, toggleMore } = usePickMoreColumns(columns)
  const hiddenChecked = !moreOpen && more.some((c) => condNames.includes(c.name))

  return (
    <div className="cond-cols">
      {visible.map((c) => {
        const on = condNames.includes(c.name)
        const op = cmpOps[c.name] ?? 'eq'
        const dateWide = on && isDateRelatedColumn(c)
        return (
          <div
            key={c.name}
            className={
              on
                ? dateWide
                  ? 'cond-cell wide'
                  : 'cond-cell'
                : 'cond-cell off'
            }
            title={c.comment ? `${c.name} ${c.comment}` : c.name}
          >
            <Cb checked={on} onChange={(v) => onToggle(c.name, v)}>
              <span className="cn">{c.name}</span>
              {c.isPrimaryKey && <Tag tone="pk">PK</Tag>}
              {c.isUnique && !c.isPrimaryKey && <Tag tone="hi">UK</Tag>}
              {c.isIndexed && !c.isPrimaryKey && !c.isUnique && <Tag tone="hi">IDX</Tag>}
            </Cb>
            {on && (
              <div className="cond-pair">
                <Sel
                  className="op"
                  aria-label={`${c.name} 比较`}
                  options={CMP_OP_OPTIONS}
                  value={op}
                  onChange={(v) => onOp(c.name, v)}
                />
                <Fld
                  value={condVals[c.name] ?? ''}
                  placeholder="值 · 空=IS NULL"
                  aria-label={`${c.name} 条件值`}
                  onChange={(e) => onValChange(c.name, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    onValCommit(c.name, (e.target as HTMLInputElement).value)
                  }}
                />
              </div>
            )}
          </div>
        )
      })}
      <PickMoreBtn
        moreCount={more.length}
        moreOpen={moreOpen}
        hiddenChecked={hiddenChecked}
        onToggle={toggleMore}
        keepHint="条件"
      />
    </div>
  )
}

export function DbQuery({ spec, seedSql, seedTable, seedRev, seedRun, conn, env, tableNames }: Props) {
  const { message } = App.useApp()
  const jumpToS2u = useUiStore((s) => s.jumpToS2u)
  // 建议卡的「🩺 看记录」：优化记录是新一级页，不进导入页 Seg
  const setActiveTab = useUiStore((s) => s.setActiveTab)
  /** 从码上测接口跳过来时有值；别的入口再跳进来就没了 */
  const back = useUiStore((s) => s.dbQuerySeed?.back)
  const cachedTables = useSchemaStore((s) => s.tables)
  const importTables = useSchemaStore((s) => s.importTables)
  const [sql, setSql] = useState('')
  const [table, setTable] = useState('')
  const [seenRev, setSeenRev] = useState(0)
  /** 点表后的字段清单。手写 SQL、认不出表时为空 */
  const [pickCols, setPickCols] = useState<Column[]>([])
  /**
   * 点表后字段拉不到的原因（0 列 / 查询报错）。null = 正常。
   * 之前两种情况都静默：表结构页签变灰、`别名.` 列提示哑掉，用户只看到「没反应」。
   */
  const [colsErr, setColsErr] = useState<string | null>(null)
  /** null = 还没动过，视作全选（跟单表生成页同一套） */
  const [selectedCols, setSelectedCols] = useState<string[] | null>(null)
  /**
   * 条件字段。null = 未动，不加 WHERE（点表保持 SELECT *）；
   * [] = 明确全不选；有名字才拼 WHERE。空值 → IS NULL。
   */
  const [condOn, setCondOn] = useState<string[] | null>(null)
  const [condVals, setCondVals] = useState<Record<string, string>>({})
  const [cmpOps, setCmpOps] = useState<Record<string, CmpOp>>({})
  /** 结果区：数据 ↔ 表结构（DBeaver 那种切页，不另开窗口） */
  const [sheetTab, setSheetTab] = useState<'data' | 'meta'>('data')
  /** 收藏弹框。null = 没开；开的时候拍一份当时的 SQL 快照，边填边改 SQL 框也不会错位 */
  const [favDlg, setFavDlg] = useState<{ sql: string; name: string; remark: string; tags: string } | null>(null)
  const [favBusy, setFavBusy] = useState(false)
  if (seedRev !== seenRev) {
    setSeenRev(seedRev)
    if (seedSql) setSql(seedSql)
    if (seedTable) setTable(seedTable)
    setSelectedCols(null)
    setPickCols([])
    setColsErr(null)
    setCondOn(null)
    setCondVals({})
    setCmpOps({})
    setSheetTab('data')
  }

  const [busy, setBusy] = useState(false)
  const [wait, setWait] = useState<'query' | 'all' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [grid, setGrid] = useState<QueryGrid | null>(null)
  const [ranSql, setRanSql] = useState('')
  const [sort, setSort] = useState<GridSort | null>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [cellv, setCellv] = useState<{ col: string; value: string } | null>(null)
  const [active, setActive] = useState<{ row: number; col: number } | null>(null)
  /** 双击编辑中的格子：row/col 是 grid 原始下标，val 是编辑框当前值 */
  const [cellEdit, setCellEdit] = useState<{ row: number; col: number; name: string; val: string } | null>(null)
  /** 生产连接下双击保存的待确认语句 */
  const [cellPlan, setCellPlan] = useState<{ sql: string } | null>(null)
  const [dlg, setDlg] = useState<'prod' | 'sql' | 'upd-prod' | 'upd' | 'ins-prod' | 'ins' | null>(null)
  const [plan, setPlan] = useState<DeletePlan | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [inserting, setInserting] = useState(false)
  const [updPk, setUpdPk] = useState<string[]>([])
  const [updCols, setUpdCols] = useState<Column[]>([])
  const [updOn, setUpdOn] = useState<Set<string>>(new Set())
  const [updVal, setUpdVal] = useState<Record<string, string>>({})
  const [insCols, setInsCols] = useState<Column[]>([])
  const [insOn, setInsOn] = useState<Set<string>>(new Set())
  const [insVal, setInsVal] = useState<Record<string, string>>({})
  const [colsOpen, setColsOpen] = useState(false)
  const [condsOpen, setCondsOpen] = useState(false)
  const colCache = useRef(new Map<string, Column[]>())

  /**
   * SQL 体检（lib/sqladvise）：开关打开才懒拉索引、防抖分析。
   * metaRev 给列/索引懒加载当版本号——目录到手后重算一次，不等下一次键击。
   */
  const [advOpen, setAdvOpen] = useState(false)
  const [advice, setAdvice] = useState<SqlAdvice[]>([])
  /** 「索引落地」清单：跟 advice 同一次分析出来的，DDL 已经按方言生成好 */
  const [idxNeed, setIdxNeed] = useState<IndexNeed[]>([])
  /** 建议卡自己那张：开着体检就是为了看建议，默认展开 */
  const [advCardOpen, setAdvCardOpen] = useState(true)
  /** 卡内筛选。只两档：三档会跟卡头「· 有重要项」那句混义（那句指的是 high） */
  const [sev, setSev] = useState<'all' | 'high'>('all')
  const idxCache = useRef(new Map<string, IndexDef[]>())
  const idxMiss = useRef(new Set<string>())
  const [metaRev, setMetaRev] = useState(0)
  /** 优化记录里有多少种「语句 + 结论」，只为了卡头那个「🩺 看记录 N」——给历史页一个入口 */
  const logCount = useSqlAdviseStore((s) => s.items.length)
  /** 点建议定位用的 textarea。SqlArea 内部还有一个 ref，两边在同一个回调里并排挂 */
  const locateTaRef = useRef<HTMLTextAreaElement | null>(null)

  /**
   * 跑查询。`record` 表示这次要不要往优化记录里累一次——**只有用户明确要求跑的才算**：
   * 写操作回查、勾列/条件变更自动重查、「加载全部」都是同一条语句的重放，
   * 记进去等于把用户没主动跑的次数算进「优化次数」。默认 false：漏记一次无害，
   * 虚高很难看。
   */
  const runText = async (text: string, loadAll = false, record = false) => {
    setErr(null)
    let q: string
    try {
      q = assertReadonlySelect(text)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      return
    }
    setBusy(true)
    // 一万行先把遮罩画出来再打库。数据回来后 JSON 解析也会停一下，遮罩得已经在。
    let tid = 0
    if (loadAll) {
      setWait('all')
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
    } else {
      tid = window.setTimeout(() => setWait('query'), 280)
    }
    try {
      setGrid(await spec.query(q, loadAll))
      // 别自动折起字段/条件卡——勾条件会重查，折掉了根本看不了刚勾的那一项
      setRanSql(q)
      setSort(null)
      setFilter('')
      setSelected(new Set())
      setCellv(null)
      setActive(null)
      const guessed = guessTableFromSql(q)
      if (guessed) setTable(guessed)
      // 记 q 不记 sql：Ctrl+Enter 框选时两者不是同一句。不 await——网格已经画出来了，
      // 记历史这件事去后台慢慢做（要打库补元数据），别让用户等它
      if (record) void recordAdvice(q)
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    } catch (e) {
      setGrid(null)
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      if (tid) window.clearTimeout(tid)
      setBusy(false)
      setWait(null)
    }
  }

  useEffect(() => {
    if (seedRev === 0 || !seedSql) return
    // seedRun=false 时只灌不跑（收藏详情跳过来那条路）。不能替用户按执行：
    // 收藏里存的未必是 SELECT，可能是一条 DELETE
    if (!seedRun) return
    // 别页点「在当前连接查询」跳过来的，那也是用户明确要跑的这条语句。
    // runText 每次渲染都是新函数，跟着它会把种子 SQL 反复重跑
    void runText(seedSql, false, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只跟 seed* 走
  }, [seedRev, seedSql, seedRun, spec])

  /** 非空 = 查询框里有写语句 / DDL 要执行，正在走确认链（ExecAlterOnConn autoStart） */
  const [writeSql, setWriteSql] = useState<string | null>(null)
  /** 写语句执行完后要自动回查的 SELECT（UPDATE 完接一句 SELECT 是最常见写法） */
  const pendingSel = useRef<string | null>(null)

  /**
   * 运行入口（按钮和 Ctrl+Enter 都走这里）。整段输入全是只读查询 → 走查询路；
   * 写语句 / DDL → 确认链执行。**写和查混排**（UPDATE …; SELECT … 回查）不算
   * 「混进不能跑的」：写语句整份过确认链，末尾的 SELECT 执行完自动回查——
   * 这正是改/删/插弹窗「执行完重跑 ranSql」的同一件事。真正的烂语句
   * （SELCT、没 WHERE 的 UPDATE）仍会被确认链点名，不会悄悄跳过。
   * 框里有选中文本时只执行选中的那段。
   */
  const runFrom = (raw: string) => {
    const text = raw.trim()
    if (!text) return
    const { writes, lastSelect } = splitRunInput(text)
    if (writes === null) {
      void runText(text, false, true)
      return
    }
    pendingSel.current = lastSelect
    setWriteSql(writes)
  }

  const run = () => runFrom(sql)

  /**
   * 收藏弹框。名字预填「首表名 · 月-日 时:分」，回车即存；表名先用看得见的 `table`，
   * 手写 SQL 认不出表时退回从 SQL 正则抽（精度有限但进库后可手改）。
   */
  const openFav = () => {
    const text = sql.trim()
    if (!text) return
    const tables = table ? [table.toLowerCase()] : extractTables(text)
    setFavDlg({ sql: text, name: defaultFavName(tables), remark: '', tags: '' })
  }

  const saveFav = async () => {
    if (!favDlg) return
    setFavBusy(true)
    try {
      const deduped = await useFavoriteStore.getState().addFavorite({
        sql: favDlg.sql,
        name: favDlg.name,
        remark: favDlg.remark.trim(),
        tags: splitFavList(favDlg.tags),
        tables: table ? [table.toLowerCase()] : undefined,
        conn,
      })
      setFavDlg(null)
      void message.success(
        deduped ? '同内容已在库里，已置顶（原条目的名字/标签不动）' : '已收藏到我的SQL库',
      )
    } catch (e) {
      void message.error(`收藏失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setFavBusy(false)
    }
  }

  const view = useMemo(() => {
    if (!grid) return []
    return filterRows(grid.rows, sortRows(grid.rows, sort), filter)
  }, [grid, sort, filter])

  const picked = view.filter((i) => selected.has(i))
  const copyIdx = picked.length > 0 ? picked : view
  const tsv = grid ? gridToTsv(grid.columns, grid.rows, copyIdx) : ''

  let insertSql = ''
  let insertErr = ''
  if (grid && copyIdx.length > 0) {
    try {
      insertSql = buildInsertFromGrid({
        dialect: spec.id,
        table,
        columns: grid.columns,
        rows: grid.rows,
        indices: copyIdx,
      })
    } catch (e) {
      insertErr = e instanceof Error ? e.message : String(e)
    }
  }

  const cap = grid?.cap ?? QUERY_ROW_CAP
  const writeLock = busy || deleting || updating || inserting
  const deleteDisabled = writeLock || picked.length === 0 || !table.trim()
  const updateDisabled = deleteDisabled
  const insertDisabled = writeLock || !table.trim()
  const deleteTitle = picked.length === 0
    ? '先勾选要删的行。不会用可见行当默认——漏勾就全删太危险'
    : !table.trim()
      ? '认不出表名。请点左边一张表，或 SQL 里写清 FROM 表'
      : env === 'prod'
        ? '生产连接：按主键删勾选行，会再确认一次'
        : '按主键删除勾选行。散删也可以直接在 SQL 框写 DELETE（要带 WHERE，确认后执行）'
  const updateTitle = picked.length === 0
    ? '先勾选要改的行。不会用可见行当默认'
    : !table.trim()
      ? '认不出表名。请点左边一张表，或 SQL 里写清 FROM 表'
      : env === 'prod'
        ? '生产连接：按主键改勾选行，会再确认一次'
        : '按主键更新勾选行，各行同一套新值。散改直接在 SQL 框写 UPDATE（要带 WHERE，确认后执行）'
  const insertTitle = !table.trim()
    ? '认不出表名。请点左边一张表，或 SQL 里写清 FROM 表'
    : env === 'prod'
      ? '生产连接：插入一行，会再确认一次'
      : '插入一行。自增列默认不写。INSERT 写进 SQL 框也行（要带 INTO，确认后执行）；复制按钮拿到的 INSERT 不会在本表执行'

  const loadColumns = async (name: string): Promise<Column[]> => {
    const key = name.toLowerCase()
    const hit = colCache.current.get(key)
    // 一律 UI 排序再交出去：主键 → 唯一键 → 索引 → 日期 → 其余（跟单表勾选清单同一套）
    if (hit) return sortColumnsForUi(hit)
    try {
      const cols = await spec.fetchColumns(name)
      colCache.current.set(key, cols)
      return sortColumnsForUi(cols)
    } catch (e) {
      const tail = name.split('.').pop()?.toLowerCase()
      const cached = cachedTables.find(
        (t) => t.name.toLowerCase() === key || t.name.toLowerCase() === tail,
      )
      if (cached) {
        colCache.current.set(key, cached.columns)
        return sortColumnsForUi(cached.columns)
      }
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  const loadPkNames = async (name: string): Promise<string[]> => pkColumnNames(await loadColumns(name))

  /**
   * 列字典 0 行时的真话，跟「点表拉不到字段」同一口径（不静默）。
   * Rust 侧已经会为同义词表兜底 all_* 字典；还能走到 0 行，说明大小写
   * 不对、或当前连接账号真没被授权。附核对 SQL 让用户自己在 DBeaver 里查。
   */
  const noColsError = (name: string) =>
    new Error(
      `字典里查不到「${name}」的列定义（all_tab_columns 0 行）。` +
        `可能是表名大小写不对，或当前连接账号没有被授权访问这张表。核对：` +
        `SELECT owner, table_name FROM all_tab_columns WHERE table_name = '${name.replace(/'/g, "''").toUpperCase()}'`,
    )

  /**
   * SQL 提示用的列名来源：colCache 里有就用（点表、表结构都走它）。
   * SQL 里出现了还没拉过字段的表就在这懒拉一把；拉不到（打了一半的词、
   * 子查询别名）记进 miss 集合，不再反复打库。
   */
  const hintMiss = useRef(new Set<string>())
  const colsOf = (t: string): string[] =>
    colCache.current.get(t.toLowerCase())?.map((c) => c.name) ?? []

  useEffect(() => {
    for (const t of sqlNames(sql).tables) {
      const key = t.toLowerCase()
      if (colCache.current.has(key) || hintMiss.current.has(key)) continue
      if (tableNames.length > 0 && !tableNames.some((n) => n.toLowerCase() === key)) continue
      void loadColumns(t)
        .then(() => setMetaRev((v) => v + 1)) // 目录到手通知体检重算
        .catch(() => {
          hintMiss.current.add(key)
        })
    }
    // loadColumns 每次渲染都是新引用，依赖它没意义；spec 换方言时必须重挂
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 同上
  }, [sql, tableNames, spec, cachedTables])

  /** 体检开着才拉索引：索引元数据比字段贵，平时别碰库 */
  useEffect(() => {
    if (!advOpen) return
    void ensureIndexes(sqlNames(sql).tables, spec, idxCache.current, idxMiss.current, tableNames).then(
      (n) => {
        if (n > 0) setMetaRev((v) => v + 1)
      },
    )
    // metaRev 也在依赖里：建索引跑完要作废索引缓存再拉一遍（见 onExecuted / PasteAlter 的
    // onRan）。少了它，缓存是空的而没人去拉，体检会「什么都不报」——那不是在说索引没问题，
    // 是在说我们不知道，两个意思。重复拉不会转圈：第二遍缓存已经填上，ensureIndexes 返回 0。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- spec 换方言重挂
  }, [advOpen, sql, tableNames, spec, metaRev])

  /** 防抖 500ms 跑静态分析：键击过程中不出建议，停手才看 */
  useEffect(() => {
    if (!advOpen) {
      setAdvice([])
      setIdxNeed([])
      return
    }
    const tid = window.setTimeout(() => {
      const r = advise(sql, {
        dialect: spec.id,
        colsOf: (t) => colCache.current.get(t.toLowerCase()),
        indexesOf: (t) => idxCache.current.get(t.toLowerCase()),
      })
      setAdvice(r.advice)
      setIdxNeed(r.indexes)
    }, 500)
    return () => window.clearTimeout(tid)
  }, [advOpen, sql, spec, metaRev])

  /**
   * 查接口 ↗（接口调试卡「查库 ↗」的反向）：SQL 里的表是哪些接口在用，
   * 到「码上测 → 接口库」定位过去。识别口径与「关联表」页同一条链路
   * （apilookup → resolveLinks），匹配不到就把原因说清楚，不假装跳了。
   */
  const goApis = () => {
    const tables = sqlNames(sql).tables.length > 0 ? sqlNames(sql).tables : table ? [table] : []
    if (tables.length === 0) {
      void message.info('SQL 里没有认出表名：先写一条带表名的语句，或从左侧点一张表')
      return
    }
    const st = useApiforgeStore.getState()
    if (!st.scan || st.scan.projects.length === 0) {
      void message.info('码上测还没有扫描结果：先到「码上测 → 扫描」扫一次工程目录')
      return
    }
    const hits = apisForTables({ scan: st.scan, links: st.links, tables })
    if (hits.length === 0) {
      void message.info(
        `接口库里没有识别到用「${tables.join('、')}」的接口（Mapper 语句关联或手动加过才算）`,
      )
      return
    }
    // 刚调过的接口也用这些表就回它，不跳到「第一个」别的接口上
    const mine = hits.find((h) => h.apiId === (back?.apiId ?? st.selectedApiId))
    st.setApisFocus({ apiId: (mine ?? hits[0]).apiId })
    st.setView('apis')
    setActiveTab('apiforge')
    if (mine) {
      void message.success('已回到刚才调试的接口')
      return
    }
    void message.success(
      hits.length === 1
        ? `已定位到用到「${tables.join('、')}」的接口`
        : `已定位到第 1 个接口（共 ${hits.length} 个用到这些表，启用的排前面）`,
    )
  }

  /** 点建议：把触发片段在 SQL 框里选中——跳到出错的地方，不用自己在一屏 SQL 里找 */
  const locateAdvice = (a: SqlAdvice) => {
    const ta = locateTaRef.current
    if (!ta || !a.at) return
    ta.focus()
    ta.setSelectionRange(a.at.start, a.at.end)
  }

  /**
   * 一键改写（目前只有 SELECT * 展开）：替换进输入框，**不自动运行**——
   * 跑不跑、展开后还要不要再裁列，让用户自己决定。SQL 已经改过、token
   * 找不到时不动框，只说清原因：重新看一眼优化检查就是新的建议。
   */
  const applyOne = (a: SqlAdvice) => {
    const next = applyAdvice(sql, a)
    if (next == null) {
      void message.info('SQL 跟体检时对不上了，这条改写应用不了：重新看一眼优化检查')
      return
    }
    setSql(next)
  }

  /**
   * 跑一次查询就往优化历史里记一笔（有建议才记）。
   * 「记一笔」是加一行还是只把次数 +1，由 `appendAdviceLog` 按「语句 + 结论」判：
   * 同一条 SQL、同一套结论重复跑不刷屏。
   *
   * 为什么要单独补元数据：体检面板关着时 `idxCache` 是空的（见上面那个 effect 的
   * `if (!advOpen) return`），而历史里看到的建议必须和面板当时显示的**是同一套输入**，
   * 不然同一条 SQL 面板说有索引问题、历史里说没有，用户只会以为记录在骗人。
   *
   * 全程 try/catch，失败最多 console.warn：记录是附属功能，
   * **绝不能把一次已经成功的查询染红**。
   */
  const recordAdvice = async (q: string) => {
    try {
      const tables = sqlNames(q).tables
      for (const t of tables) {
        const key = t.toLowerCase()
        if (colCache.current.has(key)) continue
        if (tableNames.length > 0 && !tableNames.some((n) => n.toLowerCase() === key)) continue
        // 拉不到（打了一半的词、子查询别名）就跳过：不给这条记录硬造元数据
        await loadColumns(t).catch(() => {})
      }
      const fresh = await ensureIndexes(tables, spec, idxCache.current, idxMiss.current, tableNames)
      if (fresh > 0) setMetaRev((v) => v + 1)
      const list = sqlAdvise(q, {
        dialect: spec.id,
        // 直接给 Column[]（sqlAdvise 要的是字段对象，提示用的 colsOf 给的是名字数组）
        colsOf: (t) => colCache.current.get(t.toLowerCase()),
        indexesOf: (t) => idxCache.current.get(t.toLowerCase()),
      })
      // 没建议不占历史：正常 SQL 才是大多数，全记下来历史就没法看了
      if (list.length === 0) return
      // firstAt 跟 at 取同一个值：第一次见的时候两者就是同一时刻，
      // 之后重跑只挪 at（appendAdviceLog 那边做），这里只负责新起一行。
      // runs 恒为 1：计数由 appendAdviceLog 累，调用方自己加会算出 2 来。
      const at = favNow()
      await useSqlAdviseStore.getState().append({
        id: newAdviceLogId(),
        at,
        firstAt: at,
        runs: 1,
        dialect: spec.id,
        conn,
        table: guessTableFromSql(q) ?? undefined,
        sql: q.slice(0, ADVICE_SQL_MAX),
        advice: list.slice(0, ADVICE_ITEMS_MAX),
      })
    } catch (e) {
      console.warn('优化记录写入失败', e)
    }
  }

  useEffect(() => {
    if (!seedTable) return
    let cancelled = false
    void (async () => {
      try {
        const cols = await loadColumns(seedTable)
        if (cancelled) return
        if (cols.length === 0) {
          // 查询成功但 0 列 = 这张表不在 user_tab_columns 里：多半属于别的 schema
          // （同义词 / 授权可见），或它本身就是同义词 / 视图。不能静默——
          // 表结构页签会变灰、`别名.` 列提示也会哑掉，用户只会觉得「坏了」。
          const probe =
            spec.id === 'oracle'
              ? `可在上面查询框跑 SELECT owner, table_name FROM all_tab_columns WHERE table_name = '${seedTable.toUpperCase()}' 核对归属。`
              : '可在查询框用 information_schema 核对这张表的归属。'
          setColsErr(
            `${seedTable}：查得到表名但查不到字段（0 列）。它多半不在当前连接用户的 schema（` +
              `别的用户的表靠同义词 / 授权才看得见），或它本身是同义词 / 视图。${probe}`,
          )
          setPickCols([])
          void message.warning(`${seedTable} 的字段拉不到，详情见「表结构」页签`)
          return
        }
        setColsErr(null)
        setPickCols(sortColumnsForUi(cols))
      } catch (e) {
        if (cancelled) return
        // 之前这里是静默吞：点表没反应、表结构变灰、t. 提示哑掉，全是这一个坑
        const msg = e instanceof Error ? e.message : String(e)
        setColsErr(`${seedTable}：字段拉取失败——${msg}`)
        setPickCols([])
        void message.warning(`${seedTable} 的字段拉不到，详情见「表结构」页签`)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadColumns 每次渲染都是新函数，跟着它会反复重拉字段
  }, [seedRev, seedTable, spec])

  /** 排序 / 分组 / 分页。默认不分组、按主键（id）降序、一页 20 条 */
  const [shape, setShape] = useState<QueryShape>(DEFAULT_QUERY_SHAPE)
  const [shapeOpen, setShapeOpen] = useState(false)

  const applyRebuild = (
    nextCols: string[] | null,
    nextCond: string[] | null,
    nextVals: Record<string, string>,
    nextOps: Record<string, CmpOp>,
    run: boolean,
    nextShape: QueryShape = shape,
  ) => {
    setSelectedCols(nextCols)
    setCondOn(nextCond)
    setCondVals(nextVals)
    setCmpOps(nextOps)
    setShape(nextShape)
    if (!table || pickCols.length === 0) return
    const q = sqlFromPick(spec.id, table, nextCols, pickCols, nextCond, nextVals, nextOps, nextShape)
    if (q === null) {
      setSql('')
      setGrid(null)
      setErr('没有选中任何字段')
      return
    }
    setSql(q)
    setErr(null)
    if (run) void runText(q)
  }

  const applyPick = (next: string[] | null) => {
    // 勾选名单按 UI 档位排（点选顺序不进 SQL）；聚合记号仍挂在真列后面
    let ordered = next
    if (next != null && next.length > 0) {
      const want = new Set(realNamesOf(next))
      const aggs = next.filter(isAggPickToken)
      ordered = [
        ...sortColumnsForUi(pickCols.filter((c) => want.has(c.name))).map((c) => c.name),
        ...aggs,
      ]
    }
    applyRebuild(ordered, condOn, condVals, cmpOps, true)
  }

  const applyCond = (next: string[] | null) => {
    // 条件勾选同样按 UI 档位排，跟单表 CondGrid / ValuePanel 一致
    const ordered =
      next == null
        ? null
        : sortColumnsForUi(pickCols.filter((c) => next.includes(c.name))).map((c) => c.name)
    applyRebuild(selectedCols, ordered, condVals, cmpOps, true)
  }

  const pickNames = selectedCols ?? pickCols.map((c) => c.name)
  const pickReal = realNamesOf(pickNames)
  const pickAgg = pickAggFlags(selectedCols)
  const condNames = condOn ?? []
  const condWho = condNames.length > 0 ? ` · 查询条件 ${condNames.length}` : ''

  /** 改排序/分组/分页：勾选不动，重写 SQL 再查（跟勾列、改条件同一条路） */
  const applyShape = (patch: Partial<QueryShape>) => {
    const next = { ...shape, ...patch }
    // 换了分组列，旧排序列多半已不在 SELECT 里；清掉让 resolveOrder 走默认
    if (patch.groupCol !== undefined && patch.groupCol !== shape.groupCol) next.orderCol = ''
    // 改排序/分组/每页条数后「第几页」就没意义了，回第一页
    if (patch.pageIndex === undefined) next.pageIndex = 0
    applyRebuild(selectedCols, condOn, condVals, cmpOps, true, next)
  }

  const orderAllow = shape.groupCol
    ? groupOrderAllow(shape.groupCol)
    : pickReal.length > 0
      ? pickReal
      : pickCols.map((c) => c.name)
  const orderColumn =
    resolveOrder(shape, orderAllow, defaultOrderColumn(pickCols))?.column ?? ''
  /* 拿满一页就当后面还有。真算总页数要再发一条 COUNT，不值得为了一个页码多跑一轮 */
  const hasNextPage = !!grid && grid.rows.length >= shape.pageSize

  /**
   * 双击格子进不进得了编辑，当场能给的理由都当场说。字典还没拉到不挡——
   * 提交时 loadColumns 会再验一遍。多表 JOIN 的结果不认：格子属于哪张表
   * 都说不清，UPDATE 打到哪张表就是赌。
   */
  const editBlockReason = (name: string): string | null => {
    if (!grid) return '先跑一次查询'
    if (!table.trim()) return '认不出表名。SQL 里写清 FROM 表，或点左边一张表'
    if (sqlNames(ranSql ?? '').tables.length !== 1) {
      return '多表 JOIN / 子查询的结果不支持直接编辑——定位不了格子属于哪张表'
    }
    const cols = colCache.current.get(table.toLowerCase())
    if (!cols || cols.length === 0) return null
    const pk = pkColumnNames(cols)
    if (pk.length === 0) return '这张表没有主键，定位不了单行。请用「改」按钮按勾选行生成 UPDATE'
    const missing = pk.filter((p) => !grid.columns.some((g) => g.toLowerCase() === p.toLowerCase()))
    if (missing.length > 0) {
      return `查询结果里没有主键列（${missing.join(', ')}）。SELECT * 或把主键查出来再编辑`
    }
    const col = cols.find((c) => c.name.toLowerCase() === name.toLowerCase())
    if (!col) return `列 ${name} 不在表字典里（可能是表达式别名），改不了`
    if (col.isPrimaryKey) return '主键列不支持直接编辑——那是在改行的身份'
    return null
  }

  const onEditStart = (row: number, col: number, name: string, value: string) => {
    const why = editBlockReason(name)
    if (why) {
      message.warning(why)
      return
    }
    setCellv({ col: name, value })
    setActive({ row, col })
    setCellEdit({ row, col, name, val: value })
  }

  /** 双击保存：PK 钉死这一行的一列。生产连接先确认，其余直接执行并回查。 */
  const commitCellEdit = async () => {
    const ce = cellEdit
    if (!ce || !grid) return
    setCellEdit(null)
    const original = grid.rows[ce.row]?.[ce.col] ?? ''
    if (ce.val === original) return
    setErr(null)
    try {
      const cols = await loadColumns(table)
      if (cols.length === 0) throw noColsError(table)
      const plan = buildCellUpdate({
        dialect: spec.id,
        table,
        dictColumns: cols,
        pkNames: pkColumnNames(cols),
        gridColumns: grid.columns,
        rows: grid.rows,
        row: ce.row,
        colName: ce.name,
        value: ce.val,
      })
      if (env === 'prod') {
        setCellPlan({ sql: plan.sql })
        return
      }
      const sqlText = assertPkUpdate(plan.sql)
      const { affected } = await spec.updateRows(sqlText)
      message.success(`已保存（${affected} 行）`)
      if (ranSql) await runText(ranSql)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const runCellUpdate = async () => {
    if (!cellPlan) return
    setErr(null)
    try {
      const sqlText = assertPkUpdate(cellPlan.sql)
      const { affected } = await spec.updateRows(sqlText)
      setCellPlan(null)
      message.success(`已保存（${affected} 行）`)
      if (ranSql) await runText(ranSql)
    } catch (e) {
      setCellPlan(null)
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const openDelete = async () => {
    if (!grid || deleteDisabled) return
    setErr(null)
    try {
      const pkNames = await loadPkNames(table)
      const next = buildDeleteFromGrid({
        dialect: spec.id,
        table,
        pkNames,
        columns: grid.columns,
        rows: grid.rows,
        indices: picked,
      })
      assertPkDelete(next.sql)
      setPlan(next)
      setDlg(env === 'prod' ? 'prod' : 'sql')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const runDelete = async () => {
    if (!plan) return
    setDeleting(true)
    setErr(null)
    try {
      const sqlText = assertPkDelete(plan.sql)
      const { affected } = await spec.deleteRows(sqlText)
      setDlg(null)
      setPlan(null)
      message.success(`已删除 ${affected} 行`)
      if (ranSql) await runText(ranSql)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setDlg('sql')
    } finally {
      setDeleting(false)
    }
  }

  const openUpdate = async () => {
    if (!grid || updateDisabled) return
    setErr(null)
    try {
      const cols = await loadColumns(table)
      if (cols.length === 0) throw noColsError(table)
      const pkNames = pkColumnNames(cols)
      const settable = settableColumns(cols)
      if (settable.length === 0) throw new Error('除主键外没有可改的字段')
      buildPkWhereFromGrid({
        dialect: spec.id,
        pkNames,
        columns: grid.columns,
        rows: grid.rows,
        indices: picked,
      })
      const first = grid.rows[picked[0]]
      const vals: Record<string, string> = {}
      for (const c of settable) {
        const i = grid.columns.findIndex((g) => g.toLowerCase() === c.name.toLowerCase())
        vals[c.name] = i >= 0 ? (first?.[i] ?? '') : ''
      }
      setUpdPk(pkNames)
      setUpdCols(sortColumnsForUi(settable))
      setUpdVal(vals)
      setUpdOn(new Set())
      setDlg(env === 'prod' ? 'upd-prod' : 'upd')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const updatePlan = useMemo((): UpdatePlan | null => {
    if ((dlg !== 'upd' && dlg !== 'upd-prod') || !grid || updOn.size === 0) return null
    try {
      return buildUpdateFromGrid({
        dialect: spec.id,
        table,
        pkNames: updPk,
        columns: grid.columns,
        rows: grid.rows,
        indices: picked,
        sets: updCols
          .filter((c) => updOn.has(c.name))
          .map((c) => ({ column: c, value: updVal[c.name] ?? '' })),
      })
    } catch {
      return null
    }
  }, [dlg, grid, updOn, updVal, updCols, updPk, table, spec.id, picked])

  const runUpdate = async () => {
    if (!updatePlan) return
    setUpdating(true)
    setErr(null)
    try {
      const sqlText = assertPkUpdate(updatePlan.sql)
      const { affected } = await spec.updateRows(sqlText)
      setDlg(null)
      message.success(`已更新 ${affected} 行`)
      if (ranSql) await runText(ranSql)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setDlg('upd')
    } finally {
      setUpdating(false)
    }
  }

  const openInsert = async () => {
    if (!grid || insertDisabled) return
    setErr(null)
    try {
      const cols = await loadColumns(table)
      if (cols.length === 0) throw noColsError(table)
      const src = picked.length > 0 ? grid.rows[picked[0]] : undefined
      const vals: Record<string, string> = {}
      const on = new Set<string>()
      for (const c of cols) {
        const i = grid.columns.findIndex((g) => g.toLowerCase() === c.name.toLowerCase())
        vals[c.name] = isInsertDateColumn(c)
          ? defaultInsertValue(c, spec.id)
          : src && i >= 0
            ? (src[i] ?? '')
            : ''
        if (defaultInsertOn(c)) on.add(c.name)
      }
      setInsCols(sortColumnsForUi(cols))
      setInsVal(vals)
      setInsOn(on)
      setDlg(env === 'prod' ? 'ins-prod' : 'ins')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const insertPlan = useMemo((): InsertPlan | null => {
    if ((dlg !== 'ins' && dlg !== 'ins-prod') || insOn.size === 0) return null
    try {
      return buildInsertRow({
        dialect: spec.id,
        table,
        sets: insCols
          .filter((c) => insOn.has(c.name))
          .map((c) => ({ column: c, value: insVal[c.name] ?? '' })),
      })
    } catch {
      return null
    }
  }, [dlg, insOn, insVal, insCols, table, spec.id])

  const runInsert = async () => {
    if (!insertPlan) return
    setInserting(true)
    setErr(null)
    try {
      const sqlText = assertRowInsert(insertPlan.sql)
      const { affected } = await spec.insertRows(sqlText)
      setDlg(null)
      message.success(`已插入 ${affected} 行`)
      if (ranSql) await runText(ranSql)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setDlg('ins')
    } finally {
      setInserting(false)
    }
  }

  const sampleOf = (name: string): string => {
    if (!grid) return '—'
    const s = gridCellSample(grid.columns, grid.rows, picked, name)
    if (s.kind === 'missing') return '—'
    if (s.kind === 'mixed') return '各行不同'
    return s.text.trim() === '' ? 'NULL' : s.text
  }

  /** 卡头那行小字。跟原来嵌在 SQL 卡里时同一套口径：「有重要项」指有 high */
  const advWho =
    advice.length === 0
      ? sql.trim()
        ? '没发现明显问题'
        : '写点 SQL 再看'
      : `${advice.length} 条${advice.some((a) => a.severity === 'high') ? ' · 有重要项' : ''}`
  const shownAdvice = sev === 'high' ? advice.filter((a) => a.severity === 'high') : advice
  /*
   * 索引清单跟着筛选走，别自成一套：「只看高危」时低危的索引建议还摆在上面，
   * 用户会以为那几个也急。判据就是建议的唯一键（`id·scene`，AdviceItems 同款），
   * 命中不到的规则连同它的理由一起从这一条索引上摘掉——不然清单写着
   * 「等值条件没有索引」，附近却找不到那句话，像在骗人。
   * 清单顶天十几条，不值得为它加一层 memo。
   */
  /** 「只看高危」时，索引清单也只留高危理由；全部时不设这个闸 */
  const shownKeys =
    sev === 'all' ? null : new Set(shownAdvice.map((a) => `${a.id}·${a.scene ?? ''}`))
  const shownIdx: IndexNeed[] = shownKeys
    ? idxNeed.flatMap((n) => {
        const reasons = n.reasons.filter((r) => shownKeys.has(`${r.id}·${r.scene ?? ''}`))
        return reasons.length > 0 ? [{ ...n, reasons }] : []
      })
    : idxNeed

  /*
   * 整份体检报告的纯文本，贴给同事 / 工单用。不带界面上的筛选——
   * 「只看高危」是看的方式，报告要给全量，不然转出去的人不知道漏了什么。
   */
  const reportText = useMemo(() => {
    const SEV: Record<AdvSeverity, string> = { high: '高危', mid: '中等', low: '低', info: '提示' }
    const lines: string[] = [`SQL 体检报告 · ${spec.label}`]
    if (advice.length === 0) lines.push(sql.trim() ? '没发现明显问题。' : '（SQL 为空）')
    for (const a of advice) {
      lines.push('', `【${SEV[a.severity]}】${a.title}`)
      if (a.scene) lines.push(`位置：${a.scene}`)
      lines.push(`说明：${a.why}`)
      if (a.fix) lines.push(`建议：${a.fix}`)
    }
    if (idxNeed.length > 0) {
      lines.push('', '—— 建议新增的索引 ——')
      for (const n of idxNeed) lines.push(`${n.table}(${n.cols.join(', ')}）：${n.ddl}`)
    }
    return lines.join('\n')
  }, [advice, idxNeed, spec.label, sql])

  return (
    <>
      <Card
        className="sqlcard"
        title="SQL"
        who={
          SHOW_PICK_BARS && pickCols.length > 0
            ? `${spec.label} · ${pickNames.length}/${pickCols.length}${condWho}`
            : spec.label
        }
        extra={
          <Row tight>
            {/* SQL 体检：静态规则 + 库里的索引/字段类型，给可执行的优化建议。
                ALTER 后清索引缓存——表结构刚改过，旧索引信息不能再信。 */}
            <Btn
              variant="mini"
              onClick={() => setAdvOpen((v) => !v)}
              title="SQL 体检：结合索引、字段类型等给优化建议（静态分析，上库前以执行计划为准）"
            >
              ✓ 优化检查
            </Btn>
            {/* 手写 SQL 多行粘贴进来常常一团糟，先排个版再读。sqlFormat 只加空白
                不动内容，认不出的原样返回——失败也不该动到用户的 SQL */}
            <Btn
              variant="mini"
              disabled={!sql.trim()}
              title="排版 SQL：只加换行缩进，不改内容"
              onClick={() => {
                try {
                  setSql(formatSql(sql))
                } catch {
                  /* 排版失败就不动 SQL */
                }
              }}
            >
              格式化
            </Btn>
            {/* 全项目 6 个有 SQL 产物的页都能收藏，这里原来是唯一的缺口——而它恰好是手写 SQL 最多的地方。
                不用 FavSqlBtn（一点就存、自动起名）：这里要把当时的库一起存，还要给名字/标签。 */}
            <Btn
              variant="mini"
              disabled={!sql.trim()}
              title="收藏到我的SQL库（连同当前连接一起存）"
              onClick={openFav}
            >
              <StarOutlined aria-hidden="true" /> 收藏
            </Btn>
            <Btn
              variant="mini"
              disabled={!sql.trim()}
              title="到「码上测 → 接口库」定位用这些表的接口（按 Mapper 语句 / 手动关联识别）"
              onClick={goApis}
            >
              查接口 ↗
            </Btn>
            {back && (
              <Btn
                variant="mini"
                title={`回到码上测接口库：${back.label}（参数和响应都还在）`}
                onClick={() => {
                  const st = useApiforgeStore.getState()
                  st.setApisFocus({ apiId: back.apiId })
                  st.setView('apis')
                  setActiveTab('apiforge')
                }}
              >
                ↩ 回到接口
              </Btn>
            )}
            <Btn
              variant="primary"
              disabled={busy || !sql.trim()}
              title="只读查询直接跑；写语句 / DDL 确认后执行（Ctrl+Enter 同）。生产连接会再确认一次"
              onClick={() => void run()}
            >
              {busy ? '查询中…' : '运行'}
            </Btn>
          </Row>
        }
        tight
      >
        <SqlArea
          value={sql}
          onChange={setSql}
          // 框里有选中文本时只执行选中的那段（Ctrl+Enter），没有才整个框
          onRun={(t) => runFrom(t || sql)}
          placeholder="SELECT * FROM …"
          ariaLabel="查询 SQL"
          tableNames={tableNames}
          colsOf={colsOf}
          textareaRef={(el) => {
            locateTaRef.current = el
          }}
        />
      </Card>

      {/*
        优化建议：原来是 SQL 卡里的一个内嵌面板，只分得到一百来像素，一条建议
        70px，一屏看得到一两条，SQL 输入框同时还被压成两行。搬出来单独一张卡，
        左右两栏摆建议（AdviceItems），高度由 flex 跟 SQL 卡、结果卡分。
      */}
      {advOpen && (
        <Card
          className="advcard"
          title="优化建议"
          who={advWho}
          extra={
            <Row tight>
              <Seg
                options={[
                  { value: 'all', label: `全部 ${advice.length}` },
                  {
                    value: 'high',
                    label: `只看高危 ${advice.filter((a) => a.severity === 'high').length}`,
                    title: '只看会明显拖慢或查错的那几条',
                  },
                ]}
                value={sev}
                onChange={setSev}
              />
              <Btn
                variant="mini"
                onClick={() => setActiveTab('dbadvice')}
                title="看这些年每次优化都查出了什么"
              >
                <BulbOutlined aria-hidden="true" /> 看记录 {logCount > 0 ? logCount : ''}
              </Btn>
              {advice.length > 0 && (
                <CopyBtn text={reportText} title="复制整份体检报告：结论 + 原因 + 修复 + 建议索引">
                  复制报告
                </CopyBtn>
              )}
            </Row>
          }
          open={advCardOpen}
          onToggle={setAdvCardOpen}
        >
          <div className="adv-head">
            <Hint>静态检查 + 库内索引/字段类型。它管日常巡检，执行计划才是最终裁判。</Hint>
          </div>
          {shownAdvice.length > 0 ? (
            <AdviceItems
              items={shownAdvice}
              onLocate={locateAdvice}
              onApply={applyOne}
              lead={
                <IndexPlan
                  items={shownIdx}
                  dialect={spec.id}
                  onExecuted={() => {
                    colCache.current.clear()
                    idxCache.current.clear()
                    idxMiss.current.clear()
                    setMetaRev((v) => v + 1)
                  }}
                />
              }
            />
          ) : (
            <div className="adv-empty">
              <Hint>
                {advice.length === 0
                  ? sql.trim()
                    ? '没发现明显问题'
                    : '写点 SQL 再看'
                  : '没有高危项，剩下的都是可以缓一缓的'}
              </Hint>
            </div>
          )}
        </Card>
      )}

      {SHOW_PICK_BARS && pickCols.length > 0 && (
        <>
          <Card
            className="qblock qblock-cols"
            title="查询字段"
            who={`${pickReal.length}/${pickCols.length}${pickAgg.star || pickAgg.pk ? ' +聚合' : ''}`}
            open={colsOpen}
            onToggle={setColsOpen}
            tight
          >
            <div className="qcols">
              <Row tight>
                <Btn variant="mini" onClick={() => applyPick(null)}>
                  全选
                </Btn>
                <Btn variant="mini" onClick={() => applyPick([])}>
                  全不选
                </Btn>
                <Btn
                  variant="mini"
                  onClick={() =>
                    applyPick(
                      pickCols
                        .filter((c) => c.isPrimaryKey || !AUDIT.test(c.name))
                        .map((c) => c.name),
                    )
                  }
                >
                  排除审计字段
                </Btn>
              </Row>
              <ColumnPickGrid
                columns={pickCols}
                selected={selectedCols}
                onChange={(next) => applyPick(next)}
                showAgg
                className="cols"
              />
            </div>
          </Card>

          <Card
            className="qblock qblock-conds"
            title="查询条件"
            who={condOn === null ? '未动' : `${condNames.length}/${pickCols.length}`}
            open={condsOpen}
            onToggle={setCondsOpen}
            tight
          >
            <div className="qconds">
              <Row tight>
                <Hint>默认不勾 · 勾了才拼 WHERE · 空值 = IS NULL · 改条件会重写 SQL</Hint>
                <Btn variant="mini" onClick={() => applyCond(pickCols.map((c) => c.name))}>
                  全选
                </Btn>
                <Btn variant="mini" onClick={() => applyCond([])}>
                  全不选
                </Btn>
              </Row>
              <QueryCondCols
                columns={pickCols}
                condNames={condNames}
                condVals={condVals}
                cmpOps={cmpOps}
                onToggle={(name, on) => {
                  const wanted = new Set(condNames)
                  if (on) wanted.add(name)
                  else wanted.delete(name)
                  applyCond([...wanted])
                }}
                onOp={(name, op) => {
                  const nextOps = { ...cmpOps, [name]: op }
                  applyRebuild(selectedCols, condOn, condVals, nextOps, true)
                }}
                onValChange={(name, value) => {
                  const nextVals = { ...condVals, [name]: value }
                  setCondVals(nextVals)
                  const q = sqlFromPick(
                    spec.id,
                    table,
                    selectedCols,
                    pickCols,
                    condOn,
                    nextVals,
                    cmpOps,
                    shape,
                  )
                  if (q) setSql(q)
                }}
                onValCommit={(name, value) => {
                  const nextVals = { ...condVals, [name]: value }
                  applyRebuild(selectedCols, condOn, nextVals, cmpOps, true)
                }}
              />
            </div>
          </Card>

          {/* 第三块，跟字段/条件同一套可折叠 Card。默认折起：展开要吃结果网格 66px，
              而这三个值改完就不怎么动了。摘要直接写在标题栏，不展开也能看见当前怎么排。 */}
          <Card
            className="qblock qblock-shape"
            title="排序 / 分组 / 分页"
            who={shapeSummary(shape, orderColumn, hasNextPage)}
            open={shapeOpen}
            onToggle={setShapeOpen}
            tight
          >
            <div className="qshape">
              <Row tight>
                <Lbl>排序</Lbl>
                <Sel
                  className="grow"
                  aria-label="排序字段"
                  value={orderColumn}
                  options={orderAllow.map((n) => ({
                    value: n,
                    label: n === GROUP_COUNT_ALIAS ? `${GROUP_COUNT_ALIAS}（条数）` : n,
                  }))}
                  onChange={(v) => applyShape({ orderCol: v })}
                />
                <Seg<OrderDir>
                  value={shape.orderDir}
                  onChange={(v) => applyShape({ orderDir: v })}
                  options={ORDER_DIR_OPTIONS}
                />
                <Lbl className="ord-gap">分组</Lbl>
                <Sel
                  className="grow"
                  aria-label="分组字段"
                  value={shape.groupCol}
                  options={[
                    { value: '', label: '不分组' },
                    ...pickCols.map((c) => ({ value: c.name, label: c.name })),
                  ]}
                  onChange={(v) => applyShape({ groupCol: v })}
                />
                <Lbl className="ord-gap">每页</Lbl>
                <Sel
                  className="pagesz"
                  aria-label="每页条数"
                  value={String(shape.pageSize)}
                  /* 超过 QUERY_ROW_CAP 的档不给：查询命令就只拉这么多行，
                     给了 500 会变成「第一页就被截」，翻页就不准了 */
                  options={PAGE_SIZES.filter((n) => n <= QUERY_ROW_CAP).map((n) => ({
                    value: String(n),
                    label: `${n} 条`,
                  }))}
                  onChange={(v) => applyShape({ pageSize: Number(v) })}
                />
                {/* 挤在一行了，翻页只给箭头 + title，把宽度留给两个字段下拉 */}
                <Btn
                  variant="mini"
                  title="上一页"
                  disabled={busy || shape.pageIndex === 0}
                  onClick={() => applyShape({ pageIndex: shape.pageIndex - 1 })}
                >
                  ←
                </Btn>
                <Tag>第 {shape.pageIndex + 1} 页</Tag>
                <Btn
                  variant="mini"
                  title="下一页"
                  disabled={busy || !hasNextPage}
                  onClick={() => applyShape({ pageIndex: shape.pageIndex + 1 })}
                >
                  →
                </Btn>
              </Row>
            </div>
          </Card>
        </>
      )}

      <Card
        className="sheet"
        title={
          <Seg
            className="sheet-tabs"
            value={sheetTab}
            onChange={setSheetTab}
            options={[
              { value: 'data', label: '数据' },
              {
                value: 'meta',
                label: '表结构',
                disabled: pickCols.length === 0 && !colsErr,
                title: pickCols.length === 0 && !colsErr ? '先点左边一张表' : undefined,
              },
            ]}
          />
        }
        who={
          sheetTab === 'meta'
            ? colsErr
              ? `${table} · 字段拉不到`
              : table
                ? `${table} · ${pickCols.length} 列`
                : '先点左边一张表'
            : grid
              ? `${view.length} 行${grid.truncated ? ` · 已截到 ${cap}` : ''}${picked.length ? ` · 勾选 ${picked.length}` : ''}`
              : '点表立刻查'
        }
        extra={
          sheetTab === 'data' && grid ? (
            <Fld
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="结果内筛选"
              aria-label="结果内筛选"
            />
          ) : undefined
        }
      >
        {sheetTab === 'meta' ? (
          pickCols.length > 0 ? (
            <div className="qmeta-wrap">
              {/* 连库场景不显示 Java 映射列（用户 2026-09-21）：宽度让给字段名/注释。
                  默认值列照旧显示——当天先砍后被要求加回 */}
              <ColumnTable columns={pickCols} hide={new Set(['java'] as const)} />
            </div>
          ) : colsErr ? (
            <Band tone="err" title="表结构拉不到">
              {colsErr}
            </Band>
          ) : (
            <Hint>先点左边一张表，再看表结构。</Hint>
          )
        ) : (
          <>
            {err && (
              <Band tone="err" title="出错">
                {err}
              </Band>
            )}
            {!err && !grid && (
              <Hint>
                点左边表名立刻查这张表；或在上面的框里手写 SELECT，Ctrl+Enter 运行——
                选中了片段就只执行选中的那段。先拉{' '}
                {QUERY_ROW_CAP} 行，截断后再加载全部（最多 {QUERY_ROW_CAP_ALL}）。FROM 后打一个
                空格出表名提示；`别名.`、`表名.` 后出该表的列名提示。上方可切「表结构」。
              </Hint>
            )}
            {grid && grid.columns.length === 0 && <Hint>语句已执行，没有返回列。</Hint>}
            {grid && grid.columns.length > 0 && grid.rows.length === 0 && (
              <Hint>这张表没有行。列头在下面。可以点「插入一行」，或改 WHERE 再查。</Hint>
            )}
            {grid && grid.rows.length > 0 && view.length === 0 && (
              <Hint>筛选条件下没有行。</Hint>
            )}
            {grid && grid.columns.length > 0 && (
              <>
                <QueryResultGrid
                  columns={grid.columns}
                  rows={grid.rows}
                  view={view}
                  selected={selected}
                  sort={sort}
                  onSort={(c) => setSort((s) => nextSort(s, c))}
                  onToggle={(i, on) =>
                    setSelected((prev) => {
                      const next = new Set(prev)
                      if (on) next.add(i)
                      else next.delete(i)
                      return next
                    })
                  }
                  onToggleView={(on) =>
                    setSelected((prev) => {
                      const next = new Set(prev)
                      for (const i of view) {
                        if (on) next.add(i)
                        else next.delete(i)
                      }
                      return next
                    })
                  }
                  onCell={(row, col, name, value) => {
                    setCellv({ col: name, value })
                    setActive({ row, col })
                  }}
                  active={active}
                  edit={cellEdit ? { row: cellEdit.row, col: cellEdit.col } : null}
                  editVal={cellEdit?.val ?? ''}
                  onEditStart={onEditStart}
                  onEditChange={(v) => setCellEdit((c) => (c ? { ...c, val: v } : c))}
                  onEditCommit={() => void commitCellEdit()}
                  onEditCancel={() => setCellEdit(null)}
                />
                <div className="qgrid-foot">
                  <div className="cellv">
                    {cellv ? (
                      <>
                        <em>{cellv.col}</em>
                        {cellv.value.trim() === '' ? 'NULL' : cellv.value}
                      </>
                    ) : (
                      <>
                        <em>点格子看全文</em>
                        列头排序 · 框里筛已拉回的行 · 双击格子直接改（主键列除外）
                      </>
                    )}
                  </div>
                  <div className="qgrid-acts">
                    {grid.rows.length > 0 && (
                      <>
                        <CopyBtn text={tsv} title="复制勾选行，没勾就复制可见行">
                          复制 TSV
                        </CopyBtn>
                        <CopyBtn
                          text={insertSql}
                          disabled={!insertSql}
                          title={insertErr || '复制成 INSERT'}
                        >
                          复制 INSERT
                        </CopyBtn>
                      </>
                    )}
                    <Btn
                      variant="mini"
                      disabled={insertDisabled}
                      title={insertTitle}
                      onClick={() => void openInsert()}
                    >
                      插入一行
                    </Btn>
                    {grid.rows.length > 0 && (
                      <>
                        {/* SELECT转UPDATE 不在导航里时藏起来：点了是切到一片空白 */}
                        {pageInNav('s2u') && (
                          <Btn
                            variant="mini"
                            disabled={copyIdx.length === 0}
                            title="把勾选行送到 SELECT转UPDATE（没勾就送可见行）"
                            onClick={() =>
                              jumpToS2u({
                                tableName: table,
                                dialect: spec.id,
                                paste: tsv,
                              })
                            }
                          >
                            转 UPDATE
                          </Btn>
                        )}
                        <Btn
                          variant="mini"
                          disabled={updateDisabled}
                          title={updateTitle}
                          onClick={() => void openUpdate()}
                        >
                          更新勾选行
                        </Btn>
                        <Btn
                          variant="mini"
                          danger
                          disabled={deleteDisabled}
                          title={deleteTitle}
                          onClick={() => void openDelete()}
                        >
                          删除勾选行
                        </Btn>
                      </>
                    )}
                    {grid.truncated && cap < QUERY_ROW_CAP_ALL && (
                      <Btn
                        variant="mini"
                        disabled={busy}
                        title={`当前 ${cap} 行，最多 ${QUERY_ROW_CAP_ALL}`}
                        onClick={() => void runText(ranSql || sql, true)}
                      >
                        {busy ? '加载中…' : `加载全部（最多 ${QUERY_ROW_CAP_ALL}）`}
                      </Btn>
                    )}
                    {grid.truncated && cap >= QUERY_ROW_CAP_ALL && (
                      <span className="hint" title="要看后面的行请加 WHERE / ROWNUM / LIMIT">
                        已到 {QUERY_ROW_CAP_ALL} 行上限
                      </span>
                    )}
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </Card>

      {/* 查询框跑出来的写语句 / DDL 在这里走确认链（没连库先选连接，生产 / 删列 /
          改删行要点名）。执行完连库页自己的字段 / 索引缓存全部作废，导入缓存里
          被 ALTER 的表重拉字典；CTAS 建的新表不在缓存里，没有可刷的。 */}
      {writeSql !== null && (
        <ExecAlterOnConn
          sql={writeSql}
          dialect={spec.id}
          autoStart
          onApplied={async () => {
            colCache.current.clear()
            idxCache.current.clear()
            idxMiss.current.clear()
            setMetaRev((v) => v + 1)
            if (table) {
              void loadColumns(table)
                .then((cols) => setPickCols(sortColumnsForUi(cols)))
                .catch(() => setPickCols([]))
            }
            const updated = []
            for (const raw of alterTableTargets(writeSql)) {
              const tail = raw.split('.').pop() ?? raw
              const hit = cachedTables.find((t) => {
                const n = t.name.toLowerCase()
                const r = raw.toLowerCase()
                const p = tail.toLowerCase()
                return n === r || n === p || r.endsWith(`.${n}`)
              })
              if (!hit) continue
              try {
                let cols
                try {
                  cols = await spec.fetchColumns(hit.name)
                } catch {
                  cols = await spec.fetchColumns(raw)
                }
                updated.push({ ...hit, columns: cols })
              } catch {
                /* 库已改，这张表字典读失败就跳过 */
              }
            }
            if (updated.length > 0) await importTables(updated, [])
            const sel = pendingSel.current
            pendingSel.current = null
            if (sel) {
              // 混排输入末尾的 SELECT：执行完自动回查，网格直接是新数据
              await runText(sel, false, false)
              return true
            }
            void message.info('库上已改完。结果网格还是刚才那次查询，要重新查请再点运行', 4)
            return true
          }}
          onDone={() => setWriteSql(null)}
        />
      )}

      <Dlg
        title="这是生产连接"
        open={cellPlan !== null}
        onClose={() => setCellPlan(null)}
        width={560}
        actions={
          <>
            <Btn onClick={() => setCellPlan(null)}>取消</Btn>
            <Btn variant="primary" danger onClick={() => void runCellUpdate()}>
              继续
            </Btn>
          </>
        }
      >
        <span>
          当前连接标了<strong>生产</strong>。双击改格子的保存也再确认一次——
          按主键更新这一行的一列，影响面就这一格：
        </span>
        <Code code={formatSql(cellPlan?.sql ?? '')} lang="sql" name="将执行" size="sm" />
      </Dlg>

      <Dlg
        title="这是生产连接"
        open={dlg === 'prod'}
        onClose={() => { setDlg(null); setPlan(null) }}
        width={520}
        actions={
          <>
            <Btn onClick={() => { setDlg(null); setPlan(null) }}>取消</Btn>
            <Btn variant="primary" danger onClick={() => setDlg('sql')}>
              继续
            </Btn>
          </>
        }
      >
        <span>
          当前连接标了<strong>生产</strong>。账号没写权限会失败，失败会把库的报错原文甩出来。
          仍要按主键删这 {plan?.rowCount ?? 0} 行？
        </span>
      </Dlg>

      <Dlg
        title="收藏这段 SQL"
        open={favDlg !== null}
        onClose={() => { if (!favBusy) setFavDlg(null) }}
        width={560}
        actions={
          <>
            <Btn disabled={favBusy} onClick={() => setFavDlg(null)}>取消</Btn>
            <Btn variant="primary" disabled={favBusy} onClick={() => void saveFav()}>
              {favBusy ? '收藏中…' : '收藏'}
            </Btn>
          </>
        }
      >
        <Lbl>名称</Lbl>
        <Fld
          value={favDlg?.name ?? ''}
          onChange={(e) => setFavDlg((d) => (d ? { ...d, name: e.target.value } : d))}
          placeholder="留空就用自动起的名字"
          aria-label="收藏名称"
          onKeyDown={(e) => {
            // 预填了名字，回车就能存——不强迫你每条都想个名字
            if (e.key === 'Enter' && !favBusy) void saveFav()
          }}
        />
        <Lbl>备注</Lbl>
        <Fld
          value={favDlg?.remark ?? ''}
          onChange={(e) => setFavDlg((d) => (d ? { ...d, remark: e.target.value } : d))}
          placeholder="可选。这段 SQL 是干什么的"
          aria-label="备注"
        />
        <Lbl>标签</Lbl>
        <Fld
          value={favDlg?.tags ?? ''}
          onChange={(e) => setFavDlg((d) => (d ? { ...d, tags: e.target.value } : d))}
          placeholder="可选，逗号分隔"
          aria-label="标签"
        />
        <Hint>
          当时连接：{spec.label} {conn.host}:{conn.port}/{conn.db}（会一起存，密码不存）。
          以后在「我的SQL库」的详情里一点就能回到这个库。
        </Hint>
        {favDlg && <Code code={formatSql(favDlg.sql)} lang="sql" name="将收藏" size="sm" />}
      </Dlg>

      <Dlg
        title={plan ? `删除 ${plan.table} · ${plan.rowCount} 行` : '删除勾选行'}
        open={dlg === 'sql'}
        onClose={() => { if (!deleting) { setDlg(null); setPlan(null) } }}
        width={720}
        actions={
          <>
            <Btn disabled={deleting} onClick={() => { setDlg(null); setPlan(null) }}>取消</Btn>
            <Btn variant="primary" danger disabled={deleting || !plan} onClick={() => void runDelete()}>
              {deleting ? '删除中…' : env === 'prod' ? '仍要删除' : '确定删除'}
            </Btn>
          </>
        }
      >
        {env === 'prod' && (
          <Band tone="warn" title="生产">
            再确认一次将要执行的 SQL。
          </Band>
        )}
        {err && dlg === 'sql' && (
          <Band tone="err" title="删除失败">
            {err}
          </Band>
        )}
        <Hint>
          按主键定位这 {plan?.rowCount ?? 0} 行。
        </Hint>
        {plan && <Code code={formatSql(plan.sql)} lang="sql" name="将执行" size="sm" />}
      </Dlg>

      <Dlg
        title="这是生产连接"
        open={dlg === 'upd-prod'}
        onClose={() => { if (!updating) setDlg(null) }}
        width={520}
        actions={
          <>
            <Btn disabled={updating} onClick={() => setDlg(null)}>取消</Btn>
            <Btn variant="primary" onClick={() => setDlg('upd')}>
              继续
            </Btn>
          </>
        }
      >
        <span>
          当前连接标了<strong>生产</strong>。账号没写权限会失败，失败会把库的报错原文甩出来。
          仍要按主键改这 {picked.length} 行？下一步勾要改的字段。
        </span>
      </Dlg>

      <Dlg
        title={`更新 ${table || '表'} · ${picked.length} 行`}
        open={dlg === 'upd'}
        onClose={() => { if (!updating) setDlg(null) }}
        width={780}
        actions={
          <>
            <Btn disabled={updating} onClick={() => setDlg(null)}>取消</Btn>
            <Btn
              variant="primary"
              disabled={updating || !updatePlan}
              title={!updatePlan ? '先勾要改的字段' : undefined}
              onClick={() => void runUpdate()}
            >
              {updating ? '更新中…' : env === 'prod' ? '仍要更新' : '确定更新'}
            </Btn>
          </>
        }
      >
        {env === 'prod' && (
          <Band tone="warn" title="生产">
            再确认一次将要执行的 SQL。
          </Band>
        )}
        {err && dlg === 'upd' && (
          <Band tone="err" title="更新失败">
            {err}
          </Band>
        )}
        {updatePlan ? (
          <Code code={formatSql(updatePlan.sql)} lang="sql" name="将执行" size="sm" />
        ) : (
          <Hint>勾下面要改的字段，将要执行的 UPDATE 会出现在这里。</Hint>
        )}
        <Hint>
          勾上的字段进 SET，各行同一套新值。留空 = NULL。主键只出现在 WHERE。
        </Hint>
        <Row tight>
          <Btn
            variant="mini"
            onClick={() => setUpdOn(new Set(updCols.map((c) => c.name)))}
          >
            全选
          </Btn>
          <Btn variant="mini" onClick={() => setUpdOn(new Set())}>
            全不选
          </Btn>
        </Row>
        <Tbl
          scroll="lg"
          rowKey={(c) => c.name}
          rows={updCols}
          cols={[
            {
              key: 'on',
              title: '改',
              width: 44,
              render: (c) => (
                <Cb
                  checked={updOn.has(c.name)}
                  onChange={(on) =>
                    setUpdOn((prev) => {
                      const next = new Set(prev)
                      if (on) next.add(c.name)
                      else next.delete(c.name)
                      return next
                    })
                  }
                  title={`把 ${c.name} 写进 SET`}
                />
              ),
            },
            { key: 'name', title: '字段', cls: 'mono', render: (c) => c.name },
            {
              key: 'cur',
              title: '当前',
              render: (c) => <span className="muted">{sampleOf(c.name)}</span>,
            },
            {
              key: 'val',
              title: '新值',
              render: (c) => (
                <Fld
                  className={isDateRelatedColumn(c) ? 'mono fld-date' : 'mono'}
                  value={updVal[c.name] ?? ''}
                  placeholder="留空 = NULL"
                  aria-label={`${c.name} 新值`}
                  onChange={(e) => {
                    const v = e.target.value
                    setUpdVal((prev) => ({ ...prev, [c.name]: v }))
                    setUpdOn((prev) => new Set(prev).add(c.name))
                  }}
                />
              ),
            },
          ]}
        />
      </Dlg>

      <Dlg
        title="这是生产连接"
        open={dlg === 'ins-prod'}
        onClose={() => { if (!inserting) setDlg(null) }}
        width={520}
        actions={
          <>
            <Btn disabled={inserting} onClick={() => setDlg(null)}>取消</Btn>
            <Btn variant="primary" onClick={() => setDlg('ins')}>
              继续
            </Btn>
          </>
        }
      >
        <span>
          当前连接标了<strong>生产</strong>。账号没写权限会失败，失败会把库的报错原文甩出来。
          仍要往 {table || '这张表'} 插入一行？下一步勾要写入的字段。
        </span>
      </Dlg>

      <Dlg
        title={`插入一行 · ${table || '表'}`}
        open={dlg === 'ins'}
        onClose={() => { if (!inserting) setDlg(null) }}
        width={780}
        actions={
          <>
            <Btn disabled={inserting} onClick={() => setDlg(null)}>取消</Btn>
            <Btn
              variant="primary"
              disabled={inserting || !insertPlan}
              title={!insertPlan ? '先勾要写入的字段' : undefined}
              onClick={() => void runInsert()}
            >
              {inserting ? '插入中…' : env === 'prod' ? '仍要插入' : '确定插入'}
            </Btn>
          </>
        }
      >
        {env === 'prod' && (
          <Band tone="warn" title="生产">
            再确认一次将要执行的 SQL。
          </Band>
        )}
        {err && dlg === 'ins' && (
          <Band tone="err" title="插入失败">
            {err}
          </Band>
        )}
        {insertPlan ? (
          <Code code={formatSql(insertPlan.sql)} lang="sql" name="将执行" size="sm" />
        ) : (
          <Hint>勾下面要写入的字段，将要执行的 INSERT 会出现在这里。</Hint>
        )}
        <Hint>
          勾上的字段会写入。不勾 = 省略（库默认或自增）。勾了留空 = NULL。自增列默认不勾。
          {picked.length > 0 ? ' 已用勾选的第一行预填。' : ''}
        </Hint>
        <Row tight>
          <Btn
            variant="mini"
            onClick={() => setInsOn(new Set(insCols.map((c) => c.name)))}
          >
            全选
          </Btn>
          <Btn variant="mini" onClick={() => setInsOn(new Set())}>
            全不选
          </Btn>
        </Row>
        <Tbl
          scroll="lg"
          rowKey={(c) => c.name}
          rows={insCols}
          cols={[
            {
              key: 'on',
              title: '写',
              width: 44,
              render: (c) => (
                <Cb
                  checked={insOn.has(c.name)}
                  onChange={(on) =>
                    setInsOn((prev) => {
                      const next = new Set(prev)
                      if (on) next.add(c.name)
                      else next.delete(c.name)
                      return next
                    })
                  }
                  title={`把 ${c.name} 写进 INSERT`}
                />
              ),
            },
            { key: 'name', title: '字段', cls: 'mono', render: (c) => c.name },
            {
              key: 'note',
              title: '说明',
              render: (c) => <span className="muted">{insertColumnNote(c) || '—'}</span>,
            },
            {
              key: 'val',
              title: '值',
              render: (c) => (
                <Fld
                  className={isDateRelatedColumn(c) ? 'mono fld-date' : 'mono'}
                  value={insVal[c.name] ?? ''}
                  placeholder="留空 = NULL"
                  aria-label={`${c.name} 值`}
                  onChange={(e) => {
                    const v = e.target.value
                    setInsVal((prev) => ({ ...prev, [c.name]: v }))
                    setInsOn((prev) => new Set(prev).add(c.name))
                  }}
                />
              ),
            },
          ]}
        />
      </Dlg>
      <WaitMask
        open={wait !== null}
        title={wait === 'all' ? '正在加载最多 1 万行' : '正在查询'}
        text={
          wait === 'all'
            ? '列多时可能要十几秒。拉数和解析期间窗口会停一下，请等遮罩自己关掉。'
            : '正在向数据库查询，请稍候。'
        }
      />
    </>
  )
}
