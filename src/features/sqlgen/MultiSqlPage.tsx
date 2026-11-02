/**
 * 多表关联 SQL 页，PRD 4.10（原型 mockup/sqlgen.html 的多表部分）。
 *
 * 从原 SqlGenerator 拆出来的第二页。配置：主表、手工关联、按表勾选查询列、方言。
 * 关联是**手工挑的**，不是从缓存外键推断的（见 JoinEditor 文件头的理由）。
 *
 * 列表 WHERE：SQL 输出跟单表可执行一样（默认值 + 比较符）；切到 MyBatis 仍用 `#{}`。
 * 查询列在关联下面单独一张可折卡，按表分段；右栏第一张仍是生成结果。
 */
import { useMemo, useState, type ReactNode } from 'react'
import type { Dialect, TableInfo } from '../../types/schema'
import type { SqlTemplate, TemplateConfig } from '../../types/template'
import { useSchemaStore } from '../../store/useSchemaStore'
import { useUiStore } from '../../store/useUiStore'
import { useTemplateStore } from '../../store/useTemplateStore'
import { Page } from '../../components/shell/Page'
import { NoTablesEmpty } from '../schema/NoTablesEmpty'
import { fkKey, generateMultiTable, tableColKey, defaultMultiConditions, type JoinLink } from '../../lib/sqlgen/multiTable'
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_PK_VALUE,
  GROUP_COUNT_ALIAS,
  ORDER_DIR_OPTIONS,
  PAGE_SIZES,
  defaultConditionValue,
  type CmpOp,
  type OrderDir,
} from '../../lib/sqlgen/executable'
import { planValues, type ValueMap } from '../../lib/sqlgen/mockValue'
import { DEFAULT_MYBATIS_OPTIONS, generateMultiTableXml } from '../../lib/sqlgen/mybatis'
import { sortColumnsForUi } from '../../lib/columnOrder'
import { defaultPickNames } from '../../lib/columnPick'
import { ColumnPickGrid } from './ColumnPickGrid'
import {
  Auto,
  Band,
  Btn,
  Card,
  Code,
  Col,
  EmptyBox,
  Hint,
  Lbl,
  Row,
  Seg,
  Sel,
  Split,
  Stack,
  Tag,
} from '../../components/ui'
import { TablePick } from '../../components/TablePick'
import { DialectBar } from './DialectBar'
import { JoinEditor, type JoinRow } from './JoinEditor'
import { newJoinId } from './joinId'
import { TemplatePanel } from './TemplatePanel'
import { AUDIT, CondGrid } from './ValuePanel'
import { OUT_OPTIONS, type Output } from './result'
import { FavSqlBtn } from '../sqlfav/FavSqlBtn'

/** 多表勾列：null = 所有表未动（只勾默认露出列）；按表 null=未动 / []=清空 / 名单=勾选 */
type MultiColPick = Record<string, string[] | null> | null

function tablePickOf(pick: MultiColPick, table: TableInfo): string[] {
  if (pick == null || !(table.name in pick) || pick[table.name] === null) {
    // 跟单表 SELECT 一样：没展开的「更多」列默认不勾
    return defaultPickNames(table.columns)
  }
  return pick[table.name] ?? []
}

function setTablePick(
  pick: MultiColPick,
  table: TableInfo,
  next: string[] | null,
  joinedNames: string[],
): MultiColPick {
  const base: Record<string, string[] | null> = {}
  for (const name of joinedNames) {
    base[name] = pick != null && name in pick ? pick[name]! : null
  }
  base[table.name] = next
  // 全部仍是「未动」就收成顶层 null
  if (joinedNames.every((n) => base[n] === null)) return null
  return base
}
/**
 * 从 fkKey 反推出一条关联，套用模板时用。
 *
 * 模板里存的是 `fromTable.fromColumn->toTable.toColumn` 这个字符串（types/template.ts
 * 只存 key，不存完整的 fk），要恢复成可编辑的行就得拆回来。
 * 用 lastIndexOf('.') 而不是 indexOf：表名可能是 `schema.table` 这种带点的，
 * 字段名带点的极少——按最后一个点切，两边都对。
 */
function parseFkKey(key: string): Omit<JoinRow, 'id' | 'joinType'> | null {
  const [left, right] = key.split('->')
  if (!left || !right) return null
  const li = left.lastIndexOf('.')
  const ri = right.lastIndexOf('.')
  if (li <= 0 || ri <= 0) return null
  return {
    fromTable: left.slice(0, li),
    fromColumn: left.slice(li + 1),
    toTable: right.slice(0, ri),
    toColumn: right.slice(ri + 1),
  }
}

export function MultiSqlPage() {
  const context = useUiStore((s) => s.sqlGenContext)
  const tables = useSchemaStore((s) => s.tables)

  const [mainName, setMainName] = useState<string | undefined>(context?.tableName)
  const [output, setOutput] = useState<Output>('sql')
  const [dialect, setDialect] = useState<Dialect>('oracle')
  const [withHeader, setWithHeader] = useState(true)
  const [rows, setRows] = useState<JoinRow[]>([])
  const [selectedCols, setSelectedCols] = useState<MultiColPick>(null)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  /** 排序列，存 `表.列`；空 = 还没手选，生成器按主表主键 */
  const [orderCol, setOrderCol] = useState('')
  const [orderDir, setOrderDir] = useState<OrderDir>('desc')
  /** 分组列，存 `表.列`；空 = 不分组 */
  const [groupCol, setGroupCol] = useState('')
  /**
   * 条件字段：null = 主表主键；[] = 明确无条件；`表.列`[] = 勾选。
   */
  const [selectConds, setSelectConds] = useState<string[] | null>(null)
  /** 条件手改值 / 比较符，键 `表.列`（跟单表一样，自动值不进 state） */
  const [cvals, setCvals] = useState<ValueMap>({})
  const [cmpOps, setCmpOps] = useState<Record<string, CmpOp>>({})
  const [seed] = useState(1)
  const [colsOpen, setColsOpen] = useState(true)
  const [condsOpen, setCondsOpen] = useState(true)
  const [tplOpen, setTplOpen] = useState(false)
  /** 没有模板时「点套用」这颗角标没有可点的东西，纯误导 */
  const tplCount = useTemplateStore((s) => s.templates.length)

  /**
   * 换主表时：关联行里左表还是旧主表的，一起改成新主表。
   * 只动左表 = 旧主表的行——用户手改过左表的不动。字段名能对上就保留，对不上取新表第一列。
   */
  const switchMainTable = (name: string | undefined) => {
    const prev = mainName
    setMainName(name)
    setSelectedCols(null)
    setOrderCol('')
    setOrderDir('desc')
    setGroupCol('')
    setSelectConds(null)
    setCvals({})
    setCmpOps({})
    if (!prev || !name || prev === name) return
    const cols =
      tables.find((t) => t.name === name)?.columns ??
      []
    const colNames = sortColumnsForUi(cols).map((c) => c.name)
    const fallback = colNames[0] ?? ''
    setRows((rs) =>
      rs.map((r) => {
        if (r.fromTable !== prev) return r
        return {
          ...r,
          fromTable: name,
          fromColumn: colNames.includes(r.fromColumn) ? r.fromColumn : fallback,
        }
      }),
    )
  }

  // 从速查跳转过来（那边会带上 relatedTables）时切主表。渲染期校正而不是
  // useEffect：effect 会先用旧主表渲染一帧再跳，视觉上是一次闪烁。
  const [seenContext, setSeenContext] = useState(context)
  if (context !== seenContext) {
    setSeenContext(context)
    if (context?.tableName) switchMainTable(context.tableName)
  }

  const mainTable = tables.find((t) => t.name === mainName)
  const tableMap = useMemo(() => new Map(tables.map((t) => [t.name, t])), [tables])

  /**
   * 只有选全了的表/字段才参与生成：半填的行留在界面上让用户接着填，
   * 但不能拿去生成 SQL——`fromTable: ''` 会拼出 `JOIN  ON . = .` 这种废语句。
   */
  const links = useMemo<JoinLink[]>(
    () =>
      rows
        .filter((r) => r.fromTable && r.fromColumn && r.toTable && r.toColumn)
        .map((r) => ({
          fk: {
            fromTable: r.fromTable,
            fromColumn: r.fromColumn,
            toTable: r.toTable,
            toColumn: r.toColumn,
            confidence: 'manual',
          },
          joinType: r.joinType,
          enabled: true,
        })),
    [rows],
  )

  const result = useMemo(() => {
    if (!mainTable) return null
    const common = {
      dialect,
      mainTable,
      tables: tableMap,
      links,
      withHeader,
      selectedColumns: selectedCols,
      pageSize,
      orderBy: { column: orderCol, dir: orderDir },
      groupBy: groupCol || null,
      selectConditions: selectConds,
      seed,
    } as const
    // SQL 输出写字面量（跟单表可执行）；MyBatis 仍要 #{}，各算一份
    const forSql = generateMultiTable({
      ...common,
      conditionStyle: 'literal',
      selectValues: cvals,
      cmpOps,
    })
    const forXml = generateMultiTable({
      ...common,
      conditionStyle: 'placeholder',
    })
    const xml = generateMultiTableXml(mainTable, tableMap, forXml, {
      ...DEFAULT_MYBATIS_OPTIONS,
      dialect,
    })
    return {
      sql: forSql.sql,
      xml,
      dropped: forSql.droppedLinks.map((l) => fkKey(l.fk)),
      joined: forSql.joined,
      aliases: forSql.aliases,
    }
  }, [
    mainTable,
    tableMap,
    dialect,
    links,
    withHeader,
    selectedCols,
    pageSize,
    orderCol,
    orderDir,
    groupCol,
    selectConds,
    cvals,
    cmpOps,
    seed,
  ])

  const joinedTables = useMemo(
    () =>
      (result?.joined ?? [])
        .map((n) => tableMap.get(n))
        .filter((t): t is TableInfo => Boolean(t)),
    [result?.joined, tableMap],
  )
  const joinedNames = useMemo(() => joinedTables.map((t) => t.name), [joinedTables])
  const pickedTotal = joinedTables.reduce((n, t) => n + tablePickOf(selectedCols, t).length, 0)
  const colTotal = joinedTables.reduce((n, t) => n + t.columns.length, 0)
  const condKeys =
    selectConds === null
      ? mainTable
        ? defaultMultiConditions(mainTable)
        : []
      : selectConds
  const condTotal = joinedTables.reduce((n, t) => n + t.columns.length, 0)

  /** 可保存为模板的当前配置。没选主表就没什么可存的 */
  const templateConfig = useMemo<TemplateConfig | null>(
    () =>
      mainName
        ? {
            mainTable: mainName,
            mode: 'multi',
            dialect,
            // 多表只有 SELECT，CRUD 勾选是单表页的事
            kinds: [],
            outputKind: 'prepared',
            columns: null,
            tableColumns: selectedCols,
            links: links.map((l) => ({
              key: fkKey(l.fk),
              joinType: l.joinType,
              enabled: l.enabled,
            })),
            withHeader,
          }
        : null,
    [mainName, dialect, links, withHeader, selectedCols],
  )

  const applyTemplate = (t: SqlTemplate) => {
    setMainName(t.mainTable)
    setDialect(t.dialect)
    setWithHeader(t.withHeader)
    setSelectedCols(t.tableColumns ?? null)
    // 整行替换而不是合并：模板存的是「保存时那套关联」，跟当前行一条条对
    // 反而会留下用户已经删掉的。反推不出来的 key（格式对不上）直接丢掉。
    setRows(
      t.links.flatMap((l) => {
        const parsed = parseFkKey(l.key)
        return parsed ? [{ id: newJoinId(), ...parsed, joinType: l.joinType }] : []
      }),
    )
  }

  // 空状态也要套 Page：这一页的顶栏和 .pane 滚动壳都在它里面
  if (!tables.length) {
    return (
      <Page tab="sqlgen-multi" actions={<Auto>配置即时生成</Auto>}>
        <NoTablesEmpty />
      </Page>
    )
  }

  const dropped = result?.dropped ?? []
  const code = output === 'sql' ? result?.sql : result?.xml
  const filename =
    output === 'sql'
      ? `${mainName ?? 'table'}_join_${dialect}.sql`
      : `${mainTable?.javaClass ?? 'Table'}Mapper.xml`

  const aliases = result?.aliases
  const colOptions = joinedTables.flatMap((t) => {
    const a = aliases?.get(t.name) ?? t.name
    return sortColumnsForUi(t.columns).map((c) => ({
      value: tableColKey(t.name, c.name),
      label: `${a}.${c.name}`,
    }))
  })
  const defaultOrder =
    mainTable &&
    (mainTable.columns.find((c) => c.isPrimaryKey)
      ? tableColKey(mainTable.name, mainTable.columns.find((c) => c.isPrimaryKey)!.name)
      : colOptions[0]?.value ?? '')
  const orderValue = !mainTable
    ? ''
    : groupCol
      ? orderCol === groupCol || orderCol === GROUP_COUNT_ALIAS
        ? orderCol
        : GROUP_COUNT_ALIAS
      : orderCol || defaultOrder || ''
  const orderOptions = !mainTable
    ? [{ value: '', label: '请选择' }]
    : groupCol
      ? [
          { value: groupCol, label: colOptions.find((o) => o.value === groupCol)?.label ?? groupCol },
          { value: GROUP_COUNT_ALIAS, label: `${GROUP_COUNT_ALIAS}（条数）` },
        ]
      : colOptions.length
        ? colOptions
        : [{ value: '', label: '请选择' }]

  /* 结果卡顶部提示带，三种情形各说一句话。它永远在场——没有需要提醒的事时
     也要告诉用户「现在这种组合是什么行为」。
     注意 `#{}` 在 JSX 里必须写成字符串字面量：裸写的话 {} 是空表达式，会渲染成 #。 */
  let notice: { tone: 'info' | 'warn'; text: ReactNode }
  if (output === 'mybatis') {
    notice = {
      tone: 'info',
      text: (
        <>
          输出完整 Mapper，预编译 <b>{'#{}'} 占位符</b>。namespace{' '}
          {DEFAULT_MYBATIS_OPTIONS.mapperPackage}
        </>
      ),
    }
  } else if (dropped.length) {
    notice = {
      tone: 'warn',
      text: (
        <>
          {dropped.length} 条关联与主表不连通，已从结果中排除：{dropped.join('、')}
          。JOIN 链须自主表连续可达。
        </>
      ),
    }
  } else {
    notice = {
      tone: 'info',
      text: (
        <>
          预编译语句，保留 <b>{'#{}'} 占位符</b>。输出列带表前缀，避免 ResultSet 列名冲突。可在「③ 查询列」收窄 SELECT。
        </>
      ),
    }
  }

  return (
    <Page tab="sqlgen-multi" actions={<Auto>配置即时生成</Auto>}>
      <Split>
        {/* 左：配置 */}
        <Col>
          <Card hero title="① 选主表" who={links.length ? `${links.length} 条关联` : '未配置关联'}>
            <Stack>
              <div>
                <Lbl>主表</Lbl>
                <TablePick
                  tables={tables}
                  value={mainName ?? ''}
                  onChange={(v) => switchMainTable(v || undefined)}
                  allowEmpty
                  aria-label="主表"
                />
              </div>

              <DialectBar
                dialect={dialect}
                onDialectChange={setDialect}
                withHeader={withHeader}
                onWithHeaderChange={setWithHeader}
              />

              <Row tight>
                <Lbl>条数</Lbl>
                <Sel
                  className="pagesz"
                  aria-label="查询条数"
                  value={String(pageSize)}
                  options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} 条` }))}
                  onChange={(v) => setPageSize(Number(v))}
                />
                <Lbl className="ord-gap">排序</Lbl>
                <Sel
                  className="grow"
                  aria-label="排序字段"
                  value={orderValue}
                  options={orderOptions}
                  onChange={(v) => setOrderCol(v)}
                />
                <Seg className="dir-gap" value={orderDir} onChange={setOrderDir} options={ORDER_DIR_OPTIONS} />
              </Row>
              <Row tight>
                <Lbl>分组</Lbl>
                <Sel
                  className="grow"
                  aria-label="分组字段"
                  value={groupCol}
                  options={[
                    { value: '', label: '不分组' },
                    ...colOptions,
                  ]}
                  onChange={(v) => {
                    setGroupCol(v)
                    setOrderCol('')
                  }}
                />
              </Row>
              {groupCol ? (
                <Hint>列表查询变为该列 + COUNT(*)；「③ 查询列」对列表暂不生效（详情仍按勾选）</Hint>
              ) : null}
            </Stack>
          </Card>

          <Card title="② 关联表" who="手工指定连接字段">
            <JoinEditor rows={rows} onChange={setRows} tables={tables} mainName={mainName} />
          </Card>

          {links.length > 0 && joinedTables.length > 0 && (
            <Card
              title="③ 查询列"
              who={`${pickedTotal}/${colTotal}`}
              open={colsOpen}
              onToggle={setColsOpen}
            >
              <Stack>
                <Hint>
                  {groupCol
                    ? '当前在分组：列表查询不看这里的勾选；详情语句仍按勾选出列。'
                    : '按表勾选进 SELECT。默认只勾关键列（跟单表一样）；全不选时仍会留下主键和 JOIN 键。'}
                </Hint>
                <Row tight className="pick-acts">
                  <Btn
                    variant="mini"
                    onClick={() => {
                      // null 已是「默认关键列」，全选必须显式写出全部列名
                      const next: Record<string, string[] | null> = {}
                      for (const t of joinedTables) next[t.name] = t.columns.map((c) => c.name)
                      setSelectedCols(next)
                    }}
                  >
                    全部全选
                  </Btn>
                  <Btn
                    variant="mini"
                    onClick={() => {
                      const next: Record<string, string[] | null> = {}
                      for (const n of joinedNames) next[n] = []
                      setSelectedCols(next)
                    }}
                  >
                    全部全不选
                  </Btn>
                </Row>
                {joinedTables.map((table) => {
                  const pickDefault = defaultPickNames(table.columns)
                  const picked = tablePickOf(selectedCols, table)
                  const tableSel =
                    selectedCols == null || !(table.name in selectedCols)
                      ? null
                      : selectedCols[table.name]
                  return (
                    <div key={table.name} className="multi-col-block">
                      <Row tight className="pick-acts">
                        <Lbl>{table.name}</Lbl>
                        <Tag>
                          {picked.length}/{table.columns.length}
                        </Tag>
                        <Btn
                          variant="mini"
                          onClick={() =>
                            setSelectedCols(
                              setTablePick(
                                selectedCols,
                                table,
                                table.columns.map((c) => c.name),
                                joinedNames,
                              ),
                            )
                          }
                        >
                          全选
                        </Btn>
                        <Btn
                          variant="mini"
                          onClick={() =>
                            setSelectedCols(setTablePick(selectedCols, table, [], joinedNames))
                          }
                        >
                          全不选
                        </Btn>
                        <Btn
                          variant="mini"
                          onClick={() =>
                            setSelectedCols(
                              setTablePick(
                                selectedCols,
                                table,
                                table.columns
                                  .filter((c) => c.isPrimaryKey || !AUDIT.test(c.name))
                                  .map((c) => c.name),
                                joinedNames,
                              ),
                            )
                          }
                        >
                          排除审计
                        </Btn>
                      </Row>
                      <ColumnPickGrid
                        columns={table.columns}
                        selected={tableSel}
                        defaultNames={pickDefault}
                        onChange={(next) =>
                          setSelectedCols(setTablePick(selectedCols, table, next, joinedNames))
                        }
                      />
                    </div>
                  )
                })}
              </Stack>
            </Card>
          )}

          {links.length > 0 && joinedTables.length > 0 && (
            <Card
              title="④ 条件字段"
              who={`${condKeys.length}/${condTotal}`}
              open={condsOpen}
              onToggle={setCondsOpen}
            >
              <Stack>
                <Hint>
                  勾进列表 WHERE：默认只主表主键，带默认值与比较符（跟单表一样）。全不选则只有 WHERE
                  1=1。切到 MyBatis 输出时仍用 <b>{'#{}'}</b>。
                </Hint>
                <Row tight className="pick-acts">
                  <Btn
                    variant="mini"
                    onClick={() =>
                      setSelectConds(mainTable ? defaultMultiConditions(mainTable) : [])
                    }
                  >
                    只主表主键
                  </Btn>
                  <Btn
                    variant="mini"
                    onClick={() => {
                      const all: string[] = []
                      for (const t of joinedTables) {
                        for (const c of t.columns) all.push(tableColKey(t.name, c.name))
                      }
                      setSelectConds(all)
                    }}
                  >
                    全选
                  </Btn>
                  <Btn variant="mini" onClick={() => setSelectConds([])}>
                    全不选
                  </Btn>
                </Row>
                {joinedTables.map((table) => {
                  const a = aliases?.get(table.name) ?? table.name
                  const uiCols = sortColumnsForUi(table.columns)
                  const tableKeys = uiCols.map((c) => tableColKey(table.name, c.name))
                  const pickedHere = tableKeys.filter((k) => condKeys.includes(k))
                  const insertPlans = planValues(table, dialect, seed, 'insert')
                  const pkValues: ValueMap = Object.fromEntries(
                    table.columns
                      .filter((c) => c.isPrimaryKey)
                      .map((c) => [c.name, DEFAULT_PK_VALUE]),
                  )
                  const fallback: ValueMap = Object.fromEntries(
                    table.columns.map((c) => [
                      tableColKey(table.name, c.name),
                      defaultConditionValue(c, insertPlans, pkValues, {}),
                    ]),
                  )
                  return (
                    <div key={table.name} className="multi-col-block">
                      <Row tight className="pick-acts">
                        <Lbl>{table.name}</Lbl>
                        <Tag>
                          {pickedHere.length}/{table.columns.length}
                        </Tag>
                        <Btn
                          variant="mini"
                          onClick={() => {
                            const rest = condKeys.filter((k) => {
                              const p = k.lastIndexOf('.')
                              return !(p > 0 && k.slice(0, p) === table.name)
                            })
                            setSelectConds([...rest, ...tableKeys])
                          }}
                        >
                          全选
                        </Btn>
                        <Btn
                          variant="mini"
                          onClick={() => {
                            setSelectConds(
                              condKeys.filter((k) => {
                                const p = k.lastIndexOf('.')
                                return !(p > 0 && k.slice(0, p) === table.name)
                              }),
                            )
                          }}
                        >
                          全不选
                        </Btn>
                      </Row>
                      <CondGrid
                        columns={table.columns}
                        checked={(id) => condKeys.includes(id)}
                        toggle={(id, on) => {
                          const base = selectConds === null ? condKeys : selectConds
                          setSelectConds(on ? [...base, id] : base.filter((x) => x !== id))
                        }}
                        overrides={cvals}
                        fallback={fallback}
                        onOverrides={setCvals}
                        ops={cmpOps}
                        onOps={setCmpOps}
                        placeholder="留空 = IS NULL"
                        foldMore
                        idOf={(c) => tableColKey(table.name, c.name)}
                        labelOf={(c) => `${a}.${c.name}`}
                      />
                    </div>
                  )
                })}
              </Stack>
            </Card>
          )}

          <Card
            title="模板"
            extra={tplCount > 0 ? <Auto>点「套用」</Auto> : undefined}
            open={tplOpen}
            onToggle={setTplOpen}
          >
            <TemplatePanel config={templateConfig} onApply={applyTemplate} />
          </Card>
        </Col>

        {/* 右：结果在最上面 */}
        <Col>
          <Card
            title="生成结果"
            extra={<Seg options={OUT_OPTIONS} value={output} onChange={setOutput} />}
          >
            <Stack>
              {notice.tone === 'warn' ? (
                <Band tone="warn">{notice.text}</Band>
              ) : (
                <Hint>{notice.text}</Hint>
              )}

              {!mainTable ? (
                <EmptyBox>请选择主表</EmptyBox>
              ) : !links.length ? (
                <Band tone="warn" title="尚未配置关联">
                  请在「② 关联表」添加 JOIN。单表 CRUD 请使用「单表 SQL」。
                </Band>
              ) : (
                <Code
                  code={code ?? ''}
                  name={filename}
                  size="lg"
                  lang={output === 'mybatis' ? 'xml' : 'sql'}
                  download={filename}
                  tools={<FavSqlBtn sql={code ?? ''} />}
                />
              )}
            </Stack>
          </Card>
        </Col>
      </Split>
    </Page>
  )
}
