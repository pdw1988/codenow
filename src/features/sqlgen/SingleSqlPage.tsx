/**
 * 单表 SQL 生成页，PRD 第四章（原型 mockup/sqlgen.html 的单表部分）。
 *
 * 左栏配置、右栏只放生成结果并铺满：选完表不滚就能复制语句。
 * 查询字段 / 条件字段都是连库勾列那种等宽网格，一行多个。
 * 条件、模板都在左边，不再把值表压在 SQL 上面。
 *
 * 语句类型是互斥的：一次只看一种。SELECT 排最前——打开页面就是查。
 * 配置一改结果立刻重算（纯函数 + useMemo，没有「生成」按钮）。
 */
import { useMemo, useState } from 'react'
import type { Dialect, OutputKind } from '../../types/schema'
import type { SqlTemplate, TemplateConfig } from '../../types/template'
import { useSchemaStore } from '../../store/useSchemaStore'
import { useUiStore } from '../../store/useUiStore'
import { useTemplateStore } from '../../store/useTemplateStore'
import { Page } from '../../components/shell/Page'
import { NoTablesEmpty } from '../schema/NoTablesEmpty'
import { CRUD_LABELS, generateSingleTable, type CrudKind } from '../../lib/sqlgen/singleTable'
import { generateExecutable, PAGE_SIZES, DEFAULT_PAGE_SIZE, ORDER_DIR_OPTIONS, GROUP_COUNT_ALIAS, type CmpOp, type OrderDir } from '../../lib/sqlgen/executable'
import type { ValueMap } from '../../lib/sqlgen/mockValue'
import { DEFAULT_MYBATIS_OPTIONS, generateSingleTableXml } from '../../lib/sqlgen/mybatis'
import { ExecOnConn } from './ExecOnConn'
import { FavSqlBtn } from '../sqlfav/FavSqlBtn'
import {
  Auto,
  Btn,
  Card,
  Code,
  EmptyBox,
  Hint,
  Lbl,
  Row,
  Seg,
  Sel,
  Stack,
} from '../../components/ui'
import { TablePick } from '../../components/TablePick'
import { DialectBar } from './DialectBar'
import { TemplatePanel } from './TemplatePanel'
import { AUDIT, ValuePanel } from './ValuePanel'
import { ColumnPickGrid } from './ColumnPickGrid'
import { OUT_OPTIONS, type Output } from './result'
import { sortColumnsForUi } from '../../lib/columnOrder'
import { defaultPickNames, pickAggFlags, realNamesOf } from '../../lib/columnPick'

const ALL_CRUD: CrudKind[] = ['select', 'insert', 'update', 'delete']
const CRUD_OPTIONS = ALL_CRUD.map((k) => ({
  value: k,
  label: CRUD_LABELS[k],
  title: `仅生成 ${CRUD_LABELS[k]}`,
}))

function valueCardTitle(kind: CrudKind): string {
  if (kind === 'insert') return '数据值'
  if (kind === 'update') return '数据与条件'
  return '条件字段'
}

export function SingleSqlPage() {
  const context = useUiStore((s) => s.sqlGenContext)
  const tables = useSchemaStore((s) => s.tables)
  const foreignKeys = useSchemaStore((s) => s.foreignKeys)

  const [mainName, setMainName] = useState<string | undefined>(context?.tableName)
  const [output, setOutput] = useState<Output>('sql')
  const [dialect, setDialect] = useState<Dialect>('oracle')
  const [kind, setKind] = useState<CrudKind>('select')
  const kinds = useMemo(() => [kind], [kind])
  const [withHeader, setWithHeader] = useState(true)
  const [selectedCols, setSelectedCols] = useState<string[] | null>(null)
  const [outputKind, setOutputKind] = useState<OutputKind>('executable')
  /** 换一个 seed 就是一整套新的测试数据，见 mockValue.ts 为什么不用 Math.random() */
  const [seed, setSeed] = useState(1)
  /** 手改过的值：数据值和主键 WHERE 共用一份，SELECT 条件单独一份 */
  const [vals, setVals] = useState<ValueMap>({})
  const [cvals, setCvals] = useState<ValueMap>({})
  /**
   * SELECT 的条件字段（PRD 4.9）。null = 还没动过，按默认「只主键」走；
   * 空数组是用户明确取消了全部条件，那时 SELECT 退化成查前 20 条。两者必须分得开。
   */
  const [selectConds, setSelectConds] = useState<string[] | null>(null)
  const [cmpOps, setCmpOps] = useState<Record<string, CmpOp>>({})
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  /** 排序列。空串 = 还没手选，生成器按主键 DESC（分组时按 cnt DESC） */
  const [orderCol, setOrderCol] = useState('')
  const [orderDir, setOrderDir] = useState<OrderDir>('desc')
  /** 分组列。空串 = 不分组 */
  const [groupCol, setGroupCol] = useState('')
  const [tplOpen, setTplOpen] = useState(true)
  /** 没有模板时「点套用」这颗角标没有可点的东西，纯误导 */
  const tplCount = useTemplateStore((s) => s.templates.length)

  /** 换主表要连带清掉字段选择和手填的值：上一张表的 username 填在这张表上没有意义 */
  const switchMainTable = (name: string | undefined) => {
    setMainName(name)
    setSelectedCols(null)
    setVals({})
    setCvals({})
    setSelectConds(null)
    setCmpOps({})
    setOrderCol('')
    setOrderDir('desc')
    setGroupCol('')
  }

  // 从速查跳转过来时切主表。这里用「渲染期校正 state」而不是 useEffect：
  // effect 会先用旧主表渲染一帧再跳，视觉上是一次闪烁。
  // 比的是 context 对象本身而不是表名，这样重复点同一张表也能重置配置。
  const [seenContext, setSeenContext] = useState(context)
  if (context !== seenContext) {
    setSeenContext(context)
    if (context?.tableName) switchMainTable(context.tableName)
  }

  const mainTable = tables.find((t) => t.name === mainName)

  /**
   * 查询字段「未动」时勾哪些：只勾默认露出来的列，「加载更多」里没展开的不勾——
   * 看不见的列不该悄悄进 SELECT。
   * INSERT/UPDATE 的字段仍是未动＝全选（null）：只填看得见的那几列的 INSERT 没意义。
   * 界面和生成 SQL 用的是同一份 pickDefault，别在两处各算一遍。
   */
  const pickDefault = useMemo(
    () => (mainTable && kind === 'select' ? defaultPickNames(mainTable.columns) : null),
    [mainTable, kind],
  )
  /** 实际生效的勾选。仍然 null = 全选 */
  const effCols = selectedCols ?? pickDefault

  /**
   * 这张表能 JOIN 出去多少条关联。只用来提示，不自动切到多表页——
   * JOIN 查询是另一种产物，替用户决定反而容易迷路。
   */
  const relatedCount = useMemo(
    () =>
      mainName
        ? foreignKeys.filter((fk) => fk.fromTable === mainName || fk.toTable === mainName).length
        : 0,
    [foreignKeys, mainName],
  )

  const executable = outputKind === 'executable'

  const result = useMemo(() => {
    if (!mainTable) return null
    const sql = executable
      ? generateExecutable(mainTable, {
          dialect,
          kinds,
          selectedColumns: effCols ?? undefined,
          withHeader,
          values: { insert: vals, update: vals },
          pkValues: vals,
          selectConditions: selectConds,
          selectValues: cvals,
          cmpOps,
          pageSize,
          // 列空串 = 还没手选，renderOrderBy 按主键（无主键用选出的第一列）；分组时按 cnt
          orderBy: { column: orderCol, dir: orderDir },
          groupBy: groupCol ? [groupCol] : undefined,
          seed,
        })
      : generateSingleTable(mainTable, {
          dialect,
          kinds,
          selectedColumns: effCols ?? undefined,
          withHeader,
        })
    const xml = generateSingleTableXml(mainTable, { ...DEFAULT_MYBATIS_OPTIONS, dialect })
    return { sql, xml }
  }, [
    mainTable,
    executable,
    dialect,
    kinds,
    effCols,
    withHeader,
    vals,
    cvals,
    selectConds,
    cmpOps,
    pageSize,
    orderCol,
    orderDir,
    groupCol,
    seed,
  ])

  /** 可保存为模板的当前配置。没选主表就没什么可存的 */
  const templateConfig = useMemo<TemplateConfig | null>(
    () =>
      mainName
        ? {
            mainTable: mainName,
            mode: 'single',
            dialect,
            kinds,
            outputKind,
            columns: selectedCols,
            links: [],
            withHeader,
          }
        : null,
    [mainName, dialect, kinds, outputKind, selectedCols, withHeader],
  )

  const applyTemplate = (t: SqlTemplate) => {
    switchMainTable(t.mainTable)
    setDialect(t.dialect)
    // 老模板可能存了一组勾选；拆开之后一次只显示一种，取当时的第一种
    setKind(t.kinds[0] ?? 'select')
    setSelectedCols(t.columns)
    setWithHeader(t.withHeader)
    // 老模板没存 outputKind，缺省当预编译——那是它保存时的实际行为
    setOutputKind(t.outputKind ?? 'prepared')
  }

  // 空状态也要套 Page：这一页的顶栏和 .pane 滚动壳都在它里面，
  // 裸返回的话整页没有滚动容器，下面的内容直接被 body 的 overflow:hidden 裁掉
  if (!tables.length) {
    return (
      <Page tab="sqlgen-single" actions={<Auto>配置即时生成</Auto>}>
        <NoTablesEmpty />
      </Page>
    )
  }

  const code = output === 'sql' ? result?.sql : result?.xml
  const filename =
    output === 'sql'
      ? `${mainName ?? 'table'}_${kind}_${executable ? 'exec' : 'prepared'}_${dialect}.sql`
      : `${mainTable?.javaClass ?? 'Table'}Mapper.xml`

  const pickedReal =
    effCols == null ? (mainTable?.columns.length ?? 0) : realNamesOf(effCols).length
  const pickedAgg = pickAggFlags(effCols)
  const showColPick = Boolean(mainTable && kind !== 'delete')
  const colsTitle = kind === 'select' ? '查询字段' : '字段'

  return (
    <Page tab="sqlgen-single" fill actions={<Auto>配置即时生成</Auto>}>
      <div className="sgen-bench">
        <div className="sgen-cfg">
          <Card hero title="选表和语句" who={relatedCount ? `${relatedCount} 条关联` : '单表'}>
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

              {relatedCount > 0 && (
                <Hint>JOIN 查询请用「多表关联」指定连接字段。</Hint>
              )}

              <Seg<CrudKind>
                style={{ width: '100%' }}
                value={kind}
                onChange={setKind}
                options={CRUD_OPTIONS}
              />

              <Seg<OutputKind>
                style={{ width: '100%' }}
                value={outputKind}
                onChange={setOutputKind}
                options={[
                  { value: 'executable', label: '可执行', title: '将字面量写入语句，可在客户端直接执行' },
                  { value: 'prepared', label: '预编译 #{}', title: '保留 MyBatis 占位符' },
                ]}
              />

              <DialectBar
                dialect={dialect}
                onDialectChange={setDialect}
                withHeader={withHeader}
                onWithHeaderChange={setWithHeader}
              />

              {kind === 'select' && executable && (
                <>
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
                      value={
                        !mainTable
                          ? ''
                          : groupCol
                            ? orderCol === groupCol || orderCol === GROUP_COUNT_ALIAS
                              ? orderCol
                              : GROUP_COUNT_ALIAS
                            : orderCol ||
                              mainTable.columns.find((c) => c.isPrimaryKey)?.name ||
                              sortColumnsForUi(mainTable.columns)[0]?.name ||
                              ''
                      }
                      options={
                        !mainTable
                          ? [{ value: '', label: '请选择' }]
                          : groupCol
                            ? [
                                { value: groupCol, label: groupCol },
                                { value: GROUP_COUNT_ALIAS, label: `${GROUP_COUNT_ALIAS}（条数）` },
                              ]
                            : sortColumnsForUi(mainTable.columns).map((c) => ({
                                value: c.name,
                                label: c.name,
                              }))
                      }
                      onChange={(v) => setOrderCol(v)}
                    />
                    <Seg
                      className="dir-gap"
                      value={orderDir}
                      onChange={setOrderDir}
                      options={ORDER_DIR_OPTIONS}
                    />
                  </Row>
                  <Row tight>
                    <Lbl>分组</Lbl>
                    <Sel
                      className="pagesz"
                      aria-label="分组字段"
                      value={groupCol}
                      options={[
                        { value: '', label: '不分组' },
                        ...(mainTable ? sortColumnsForUi(mainTable.columns) : []).map((c) => ({
                          value: c.name,
                          label: c.name,
                        })),
                      ]}
                      onChange={(v) => {
                        setGroupCol(v)
                        // 换分组后旧排序列可能不在 SELECT 里，清掉让默认走 cnt
                        setOrderCol('')
                      }}
                    />
                  </Row>
                  {groupCol ? <Hint>SELECT 变为该列 + COUNT(*)，查询字段勾选暂不生效</Hint> : null}
                </>
              )}
            </Stack>
          </Card>

          {showColPick && mainTable && (
            <Card
              title={colsTitle}
              who={`${pickedReal}/${mainTable.columns.length}${pickedAgg.star || pickedAgg.pk ? ' +聚合' : ''}`}
            >
              <Row tight className="pick-acts">
                <Btn
                  variant="mini"
                  onClick={() => setSelectedCols(mainTable.columns.map((c) => c.name))}
                >
                  全选
                </Btn>
                <Btn variant="mini" onClick={() => setSelectedCols([])}>
                  全不选
                </Btn>
                <Btn
                  variant="mini"
                  onClick={() =>
                    setSelectedCols(
                      mainTable.columns
                        .filter((c) => c.isPrimaryKey || !AUDIT.test(c.name))
                        .map((c) => c.name),
                    )
                  }
                >
                  排除审计字段
                </Btn>
              </Row>
              <ColumnPickGrid
                columns={mainTable.columns}
                selected={selectedCols}
                onChange={setSelectedCols}
                showAgg={kind === 'select'}
                defaultNames={pickDefault ?? undefined}
              />
            </Card>
          )}

          {executable && mainTable && output === 'sql' && (
            <Card
              title={valueCardTitle(kind)}
              who={kind === 'select' ? `默认主键 · 前 ${pageSize} 条` : undefined}
              extra={
                <Btn
                  variant="mini"
                  title="按当前表与方言重新生成列值"
                  onClick={() => {
                    setSeed((s) => s + 1)
                    setVals({})
                    setCvals({})
                  }}
                >
                  重新生成
                </Btn>
              }
            >
              <ValuePanel
                table={mainTable}
                dialect={dialect}
                seed={seed}
                selectedColumns={selectedCols}
                kinds={kinds}
                vals={vals}
                cvals={cvals}
                selectConditions={selectConds}
                cmpOps={cmpOps}
                pageSize={pageSize}
                onValsChange={setVals}
                onCvalsChange={setCvals}
                onSelectConditionsChange={setSelectConds}
                onCmpOpsChange={setCmpOps}
              />
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
        </div>

        <div className="sgen-out">
          <Card
            className="fill"
            title={`生成结果 · ${output === 'sql' ? CRUD_LABELS[kind] : 'Mapper'}`}
            extra={<Seg options={OUT_OPTIONS} value={output} onChange={setOutput} />}
          >
            {output === 'mybatis' ? (
              <Hint>
                输出完整 Mapper。语句类型仅切换 SQL 预览，XML 仍含全部方法。namespace{' '}
                {DEFAULT_MYBATIS_OPTIONS.mapperPackage}
              </Hint>
            ) : executable ? (
              <Hint>字面量已写入语句，可直接执行。改条件在左侧。</Hint>
            ) : (
              <Hint>预编译语句，保留 {'#{}'} 占位符。</Hint>
            )}

            {!mainTable ? (
              <EmptyBox>请选择主表</EmptyBox>
            ) : (
              <Code
                className="fill"
                code={code ?? ''}
                name={filename}
                lang={output === 'mybatis' ? 'xml' : 'sql'}
                download={filename}
                extra={
                  <ExecOnConn
                    sql={code ?? ''}
                    dialect={dialect}
                    executable={executable}
                    output={output}
                    table={mainTable.name}
                  />
                }
                tools={<FavSqlBtn sql={code ?? ''} />}
              />
            )}
          </Card>
        </div>
      </div>
    </Page>
  )
}
