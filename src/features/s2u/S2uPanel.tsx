/**
 * SELECT转UPDATE，PRD v6.4 §4.16（原型 `mockup/select2update.html`，2026-08-26 评审拍板）。
 *
 * 做成独立页而不是挂在「SQL 生成」的批量模式下，理由和日志转SQL 同款：
 * 临时改数的场景是「临时贴一把就走」，埋两层菜单等于给高频入口上锁。
 * 必须先选表再粘贴：没列头时只能按这张表的字段顺序对齐，默默拿第一张表会悄悄对错列。
 * 有列头按列名对，没列头按列序对。等 PRD 的批量 INSERT/UPDATE（按主键列表/条件字段）
 * 落地时，这里的粘贴面板整体搬过去就是第三种定位方式，纯函数层不用动。
 *
 * 三条拍板语义在 lib/sqlgen/selectToUpdate.ts 的文件头，界面上的对应物：
 * 预览只列值有变化的行 + 跳过数明示；目标值输入框 placeholder 写明「留空 = 按粘贴值」；
 * 手动 IN 撞上逐行不同值时出黄色警告带。没有「生成」按钮——useMemo 实时重算，
 * 和 SQL 生成页同一个约定。
 *
 * 布局：没贴时先选表再粘贴；贴完右栏第一张永远是 UPDATE，预览默认折起。
 * 贴完后顶栏 /「已贴入的结果」都有「返回选表」——清粘贴与勾选，回到选表贴列空态。
 */
import { useMemo, useState, type ClipboardEvent } from 'react'
import { App } from 'antd'
import { CheckCircleOutlined, WarningOutlined } from '@ant-design/icons'
import { NoTablesEmpty } from '../schema/NoTablesEmpty'
import type { Column, Dialect, TableInfo } from '../../types/schema'
import { DIALECT_OPTIONS } from '../../lib/sqlgen/dialect'
import {
  buildSelectToUpdate,
  cellOf,
  effectiveValue,
  fieldUsable,
  includedIndices,
  parsePastedTable,
  resolvePk,
  targetOf,
  type CheckedMap,
  type PastedTable,
  type S2uFormat,
  type TargetMap,
} from '../../lib/sqlgen/selectToUpdate'
import { compareColumnsForUi } from '../../lib/columnOrder'
import { useSchemaStore } from '../../store/useSchemaStore'
import { useUiStore } from '../../store/useUiStore'
import { Page } from '../../components/shell/Page'
import {
  Auto,
  Band,
  Btn,
  Card,
  Cb,
  Code,
  Col,
  EmptyBox,
  Fld,
  Hint,
  Lbl,
  Mono,
  Row,
  Seg,
  Sel,
  Spacer,
  Split,
  Stack,
  Tag,
  TextArea,
  Tbl,
  type TblCol,
} from '../../components/ui'
import { TablePick } from '../../components/TablePick'
import { ExecOnConn } from '../sqlgen/ExecOnConn'
import { FavSqlBtn } from '../sqlfav/FavSqlBtn'

/**
 * 「填示例」按**当前选中的表**现造一份：status 类列给 0/1 混合（演示统一改 1 走 IN），
 * 小数列每行不同（演示 CASE WHEN）。写死一份 order 示例的话，用户切到别的表
 * 示例就和表结构对不上，演示效果直接归零。日期固定在 8 月 20~25 日——合法日期，
 * 别造出 8 月 32 日让第一次体验的人先撞上一个解析错误。
 *
 * **status 类列必须挤进样本**：贴上来就自动勾 status 并填 1 的用户旅程联动靠它触发，
 * 示例里没有它，页面就停在「还不能生成」的占位注释上——此时切方言、切格式全都
 * 看不到变化（真事：user 表前 3 个业务列是 username/password/email，status 排第 4
 * 被切掉，「切方言没反应」就是这么来的）。所以按 status 类 > 小数 > 其他排优先级。
 */
function demoPaste(table: TableInfo): string {
  const pk = table.columns.find((c) => c.isPrimaryKey) ?? table.columns[0]
  // 时间戳列垫底：示例里它们只是装饰；同档内保持表定义序（sort 自 ES2019 起稳定）
  const biz = table.columns.filter((c) => c !== pk && !/^(create|update)_/i.test(c.name))
  const rank = (c: Column) =>
    /status|state|flag$/i.test(c.name) ? 0 : /decimal|numeric/i.test(c.type) ? 1 : 2
  const others = [...biz].sort((a, b) => rank(a) - rank(b)).slice(0, 3)
  const cols = [pk, ...others]

  const cell = (c: Column, i: number): string => {
    if (/status|state|flag$/i.test(c.name)) return ['0', '1', '0', '0', '1', '0'][i % 6]
    if (/int|decimal|numeric|double|float/i.test(c.type) || /Integer|Long|BigDecimal|Double/.test(c.javaType))
      return /decimal|numeric/i.test(c.type) ? `${(i + 1) * 11}.50` : String(100 + i * 7 + c.name.length)
    if (/date|time/i.test(c.type)) return `2026-08-2${i} 10:30:00`
    return `${c.name}_${100 + i}`
  }

  const lines = [cols.map((c) => c.name).join(' | ')]
  for (let i = 0; i < 6; i++) lines.push(cols.map((c) => cell(c, i)).join(' | '))
  return lines.join('\n')
}

/** 主键来源的展示。「猜出来的」必须挂 ⚠️：认错主键 = 改错行，而且这种错不报错 */
function pkTag(source: 'cache' | 'idName' | 'first' | 'manual') {
  switch (source) {
    case 'cache':
      return (<Tag tone="ok"><CheckCircleOutlined aria-hidden="true" /> 来自表结构缓存</Tag>)
    case 'manual':
      return <Tag tone="hi">手动指定</Tag>
    case 'idName':
      return (<Tag tone="wr"><WarningOutlined aria-hidden="true" /> 缓存主键不在结果里，按字段名猜的</Tag>)
    default:
      return (<Tag tone="wr"><WarningOutlined aria-hidden="true" /> 兜底取了第一列，请确认</Tag>)
  }
}

interface PreviewRow {
  i: number
}

export function S2uPanel() {
  const { message } = App.useApp()
  const tables = useSchemaStore((s) => s.tables)
  const s2uSeed = useUiStore((s) => s.s2uSeed)

  /* 留空 = 还没选表。没列头的粘贴只能按表字段顺序对齐，默默拿第一张表等于悄悄对错列 */
  const [tableName, setTableName] = useState('')
  const [dialect, setDialect] = useState<Dialect>('oracle')
  const [raw, setRaw] = useState('')
  const [seenSeed, setSeenSeed] = useState(0)
  const [manualPk, setManualPk] = useState<string | null>(null)
  const [checked, setChecked] = useState<CheckedMap>({})
  const [targets, setTargets] = useState<TargetMap>({})
  /** 用户手动动过勾选/目标值之后，「自动勾 status」就永久退场——之后完全听用户的 */
  const [touched, setTouched] = useState(false)
  const [autoDone, setAutoDone] = useState(false)
  const [format, setFormat] = useState<S2uFormat>('auto')
  /** 预览默认折起：贴完眼睛先落到 UPDATE，要核对行再展开 */
  const [previewOpen, setPreviewOpen] = useState(false)
  if (s2uSeed && s2uSeed.rev !== seenSeed) {
    setSeenSeed(s2uSeed.rev)
    setRaw(s2uSeed.paste)
    setDialect(s2uSeed.dialect)
    const hit =
      tables.find((t) => t.name === s2uSeed.tableName) ??
      tables.find((t) => t.name.toLowerCase() === s2uSeed.tableName.toLowerCase())
    if (hit) setTableName(hit.name)
    setTouched(false)
    setAutoDone(false)
    setChecked({})
    setTargets({})
    setManualPk(null)
    setPreviewOpen(false)
  }

  const table = tables.find((t) => t.name === tableName) ?? null

  const parsed = useMemo<PastedTable | null>(
    () => (table && raw.trim() ? parsePastedTable(raw, table) : null),
    [table, raw],
  )

  /** resolvePk 要调两次（name 给生成器、source 给标签），借 useMemo 只算一遍 */
  const pkInfo = useMemo(
    () => (parsed && table ? resolvePk(parsed, table, manualPk) : null),
    [parsed, table, manualPk],
  )
  const pkName = pkInfo?.name ?? ''
  const pkSource = pkInfo?.source ?? 'cache'

  /**
   * 可勾选的字段：主键（若在结果里）在前，其余按字段名排，跟其它勾选清单同一套。
   * 粘贴里没有、表结构里有的列仍收进来——单列模式全靠这后半段。
   */
  const candidates = useMemo<Array<{ name: string; column: Column | null }>>(() => {
    if (!parsed || !table || !pkInfo) return []
    const listed = new Set([pkInfo.name.toLowerCase()])
    const out: Array<{ name: string; column: Column | null }> = []
    for (const c of parsed.cols) {
      const key = c.name.toLowerCase()
      if (!listed.has(key)) {
        listed.add(key)
        out.push({ name: c.name, column: c.column })
      }
    }
    for (const c of table.columns) {
      const key = c.name.toLowerCase()
      if (!listed.has(key)) {
        listed.add(key)
        out.push({ name: c.name, column: c })
      }
    }
    return out.sort((a, b) =>
      compareColumnsForUi(
        {
          name: a.name,
          isPrimaryKey: !!a.column?.isPrimaryKey,
          isUnique: a.column?.isUnique,
          isIndexed: a.column?.isIndexed,
          type: a.column?.type,
          javaType: a.column?.javaType,
        },
        {
          name: b.name,
          isPrimaryKey: !!b.column?.isPrimaryKey,
          isUnique: b.column?.isUnique,
          isIndexed: b.column?.isIndexed,
          type: b.column?.type,
          javaType: b.column?.javaType,
        },
      ),
    )
  }, [parsed, table, pkInfo])

  const usableFields = useMemo(
    () =>
      parsed
        ? candidates.map((c) => c.name).filter((n) => checked[n] && fieldUsable(parsed, targets, n))
        : [],
    [parsed, candidates, checked, targets],
  )

  const result = useMemo(() => {
    if (!parsed || !table || !pkInfo) return null
    return buildSelectToUpdate(table, parsed, pkInfo.name, { dialect, format, targets, checked })
  }, [parsed, table, pkInfo, dialect, format, targets, checked])

  const includedRows = useMemo(
    () => (parsed ? includedIndices(parsed, usableFields, targets) : []),
    [parsed, usableFields, targets],
  )

  /**
   * 解析成功后的联动（PRD 用户旅程：「系统识别…自动勾选 status，目标值填 1」）。
   * 放在 onChange/onPaste 里同步做而不是 useEffect 里盯 parsed——事件驱动只跑一次，
   * effect 版本会在用户取消勾选后再粘一次文本时又把勾选改回去。
   */
  const applyRaw = (text: string) => {
    if (!table) return
    setRaw(text)
    if (!touched && !autoDone && table) {
      const p = parsePastedTable(text, table)
      const st = p?.cols.find((c) => c.name.toLowerCase() === 'status')
      if (st) {
        setChecked((s) => ({ ...s, [st.name]: true }))
        setTargets((s) => ({ ...s, [st.name]: '1' }))
        setAutoDone(true)
      }
    }
  }

  /** 回到选表贴列空态。表名保留，方便换一份结果再贴；要换表用顶栏/空态的选表。 */
  const backToPick = () => {
    setRaw('')
    setManualPk(null)
    setChecked({})
    setTargets({})
    setTouched(false)
    setAutoDone(false)
    setPreviewOpen(false)
  }

  const fillDemo = () => {
    if (!table) return
    applyRaw(demoPaste(table))
    message.info(`示例按 ${table.name} 的表结构现造，直接改值就能用`)
  }

  /** 粘贴整段接管：onPaste 触发时 textarea.value 还是旧的，得从 clipboardData 拿（CLAUDE.md 有记） */
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const txt = e.clipboardData.getData('text')
    if (!txt.trim()) return
    e.preventDefault()
    applyRaw(txt)
  }

  /* ---------- 渲染 ---------- */

  const shapeLabel = !parsed
    ? null
    : parsed.single
      ? `单列 · 当作主键列表（${parsed.rows.length} 行）`
      : `${parsed.rows.length} 行 × ${parsed.cols.length} 列 · ${parsed.header ? '识别到表头 ✓' : '没有表头，按位置对齐当前表字段'}`

  const colOrderHint = table
    ? table.columns
        .slice(0, 6)
        .map((c) => c.name)
        .join(' · ') + (table.columns.length > 6 ? ' · …' : '')
    : ''

  const pickTable = (v: string) => {
    setTableName(v)
    // 换表后上一张表的字段名/主键/目标值全部失效，跟 SQL 生成页同一处理
    setRaw('')
    setManualPk(null)
    setChecked({})
    setTargets({})
    setTouched(false)
    setAutoDone(false)
  }

  const fieldCardBody = (
    <Stack gap={6}>
      {candidates.length === 0 && <EmptyBox>结果里除了主键没有别的列，没有可更新的字段</EmptyBox>}
      {candidates.map(({ name, column }) => {
        const usable = fieldUsable(parsed!, targets, name)
        return (
          <Row key={name}>
            <Cb
              checked={!!checked[name]}
              dim={checked[name] === true && !usable}
              title={column ? column.comment || name : `${name}：表结构缓存里没有这列`}
              onChange={(v) => {
                setChecked((s) => ({ ...s, [name]: v }))
                setTouched(true)
              }}
            >
              <Mono>{name}</Mono>
            </Cb>
            {usable ? (
              column?.comment && <Hint>{column.comment}</Hint>
            ) : (
              <Tag tone="no">没粘值也没填目标值，不会生效</Tag>
            )}
            <Spacer />
            <Fld
              value={targets[name] ?? ''}
              placeholder="留空 = 按粘贴值"
              style={{ width: 150 }}
              aria-label={`${name} 的目标值`}
              onChange={(e) => {
                setTargets((s) => ({ ...s, [name]: e.target.value }))
                setTouched(true)
              }}
            />
          </Row>
        )
      })}
      <Hint>目标值留空的字段会把粘贴数据当作要改成的值（适合业务发来一份已改好的清单）。</Hint>
    </Stack>
  )

  const previewCols: Array<TblCol<PreviewRow>> = [
    ...(pkName
      ? [
          {
            key: 'pk',
            title: pkName,
            cls: 'mono',
            render: (r: PreviewRow) => cellOf(parsed!, pkName, r.i),
          },
        ]
      : []),
    ...usableFields.map((f) => ({
      key: f,
      title: f,
      render: (r: PreviewRow) => {
        const t = targetOf(targets, f)
        const ov = cellOf(parsed!, f, r.i)
        const nv = effectiveValue(parsed!, targets, f, r.i)
        if (t === '')
          return (
            <>
              <span className="muted">—</span> → <b>{nv}</b>
            </>
          )
        if (ov === t)
          return (
            <>
              <span className="muted">{ov} = 不变</span>
            </>
          )
        return (
          <>
            <span className="muted">
              <s>{ov}</s>
            </span>{' '}
            → <b>{nv}</b>
          </>
        )
      },
    })),
  ]

  /**
   * 结果卡只留真警告（字段无效 / 格式被降级 / 主键是猜的）。
   * 格式说明改成一行 Hint，避免结果上方堆 Band。
   */
  const resultLead = (() => {
    if (!parsed || !result) return null
    if (!parsed.header && !parsed.single && table && parsed.cols.length !== table.columns.length)
      return (
        <Band tone="warn" title="列数对不上：">
          粘贴了 {parsed.cols.length} 列，{table.name} 有 {table.columns.length}{' '}
          个字段。没列头只能按顺序对，对不上就改错列。请带列头再贴，或按字段顺序贴齐。
        </Band>
      )
    if (result.invalidFields.length)
      return (
        <Band tone="warn" title={`跳过了 ${result.invalidFields.join('、')}：`}>
          既不在粘贴数据里也没填目标值——填上目标值才会生效。
        </Band>
      )
    if (result.resolved.warning)
      return (
        <Band tone="warn" title="格式已切换：">
          {result.resolved.warning}
        </Band>
      )
    if (pkSource === 'idName' || pkSource === 'first')
      return (
        <Band tone="warn" title="主键是猜出来的：">
          表结构缓存里的真主键不在粘贴结果中。认错主键 = 改错行，执行前到主键下拉里人工确认。
        </Band>
      )
    if (!usableFields.length) return <Hint>左边勾选要更新的字段并填目标值，右边实时出 SQL。</Hint>
    if (result.includedCount === 0) return null
    return result.resolved.kind === 'in' ? (
      <Hint>目标值一致，走 IN 列表。已是目标值的行不在 WHERE 里。</Hint>
    ) : (
      <Hint>各行新值不同，走 CASE WHEN，按主键赋各自的值。</Hint>
    )
  })()

  const pasteBox = (
    <TextArea
      value={raw}
      rows={parsed ? 5 : 10}
      disabled={!table}
      title={!table ? '先选表。没列头时按字段顺序对齐，没有表就对不上' : undefined}
      placeholder={
        table
          ? '从 Navicat / DataGrip / Excel 复制后贴在这里。有列头按列名对齐，没列头按这张表的字段顺序对齐。'
          : '先选上面的表，再粘贴'
      }
      onChange={(e) => applyRaw(e.target.value)}
      onPaste={onPaste}
      aria-label="查询结果粘贴区"
    />
  )

  const previewBody = !usableFields.length ? (
    <EmptyBox>勾选要更新的字段后，这里显示每一行的旧值 → 新值对比</EmptyBox>
  ) : includedRows.length === 0 ? (
    <Band tone="ok" title="所有记录都已是目标值：">
      不需要 UPDATE，也就没有预览可显示。
    </Band>
  ) : (
    <Stack gap={8}>
      <Tbl
        scroll
        cols={[
          ...previewCols,
          {
            key: 'note',
            title: '说明',
            width: 130,
            render: () =>
              usableFields.some((f) => targetOf(targets, f) === '') ? (
                <Tag tone="hi">以粘贴值为准</Tag>
              ) : (
                <Tag tone="ok">值变化</Tag>
              ),
          },
        ]}
        rows={includedRows.map((i) => ({ i }))}
        rowKey={(r) => String(r.i)}
      />
      {(result?.skippedCount ?? 0) > 0 && (
        <Band tone="info" title={`另有 ${result?.skippedCount} 行旧值已等于目标值：`}>
          不放进 WHERE——它们本来就不需要改，塞进去只是白锁几行。
        </Band>
      )}
    </Stack>
  )

  return (
    <Page
      tab="s2u"
      actions={
        parsed && table ? (
          <Row tight>
            <TablePick
              tables={tables}
              value={table.name}
              onChange={pickTable}
              style={{ maxWidth: 240 }}
              aria-label="当前表"
            />
            <Seg options={DIALECT_OPTIONS} value={dialect} onChange={setDialect} />
            <Btn variant="ghost" onClick={backToPick} title="清掉粘贴内容，回到选表贴列">
              ← 返回选表
            </Btn>
          </Row>
        ) : undefined
      }
    >
      {tables.length === 0 ? (
        <NoTablesEmpty />
      ) : !parsed ? (
        <div className="s2u-empty">
          <div className="hero">
            <div className="eye">从表格到 UPDATE</div>
            <h1>先选表，再贴查询结果</h1>
            <p>有列头按列名对齐，没列头按这张表的字段顺序对齐。两种都能转。没选表就贴，没列头的对不上。</p>
          </div>
          <Card hero title="要改哪张表" who={table ? `${table.columns.length} 个字段` : '必选'}>
            <Stack>
              <TablePick
                tables={tables}
                value={tableName}
                onChange={setTableName}
                allowEmpty
                emptyLabel="请选择要改的表"
                aria-label="当前表"
              />
              {table ? (
                <Hint>
                  没列头时按这个顺序对：<Mono>{colOrderHint}</Mono>
                </Hint>
              ) : (
                <Hint>先选定表。列头可有可无——有就按名字对，没有就按字段顺序对。</Hint>
              )}
            </Stack>
          </Card>
          <Card
            title="查询结果"
            who={table ? '有列头或没列头都可以贴' : '先选表'}
            extra={
              <Btn
                variant="mini"
                disabled={!table}
                title={!table ? '先选表，示例按表结构现造' : undefined}
                onClick={fillDemo}
              >
                填示例
              </Btn>
            }
          >
            {pasteBox}
          </Card>
        </div>
      ) : (
        <div className="s2u-work">
          <Split>
            <Col>
              <Card
                title="已贴入的结果"
                who={shapeLabel ?? undefined}
                extra={
                  <Row tight>
                    <Btn variant="mini" onClick={backToPick} title="清掉粘贴内容，回到选表贴列">
                      ← 返回选表
                    </Btn>
                    <Btn variant="mini" onClick={fillDemo}>
                      填示例
                    </Btn>
                  </Row>
                }
              >
                <Stack>
                  {pasteBox}
                  <Row tight>
                    <Hint>{shapeLabel}</Hint>
                    <Spacer />
                    <Lbl>主键列</Lbl>
                    <Sel
                      value={pkName}
                      onChange={(v) => setManualPk(v)}
                      options={(parsed?.cols ?? []).map((c) => ({ value: c.name, label: c.name }))}
                      style={{ maxWidth: 140 }}
                    />
                    {pkTag(pkSource)}
                  </Row>
                </Stack>
              </Card>

              <Card title="要改哪些字段" who="勾上，目标值可改；留空就用粘贴里的值" extra={
                <Row tight>
                  <Btn
                    variant="mini"
                    disabled={!candidates.length}
                    onClick={() => {
                      setChecked(Object.fromEntries(candidates.map((c) => [c.name, true])))
                      setTouched(true)
                    }}
                  >
                    全选
                  </Btn>
                  <Btn
                    variant="mini"
                    onClick={() => {
                      setChecked({})
                      setTouched(true)
                    }}
                  >
                    全不选
                  </Btn>
                </Row>
              }>
                {fieldCardBody}
              </Card>
            </Col>

            <Col>
              <Card
                title="UPDATE"
                who={result ? `${result.pastedCount} 行粘贴 · ${includedRows.length} 行会改` : undefined}
                extra={
                  <Row tight>
                    <Seg
                      value={format}
                      onChange={setFormat}
                      options={[
                        { value: 'auto', label: '自动', title: '各行新值相同 → IN 列表；有不同 → CASE WHEN' },
                        { value: 'each', label: '逐条', title: '每个主键一条 UPDATE。行数多时又长又慢，一般不用' },
                        { value: 'in', label: 'IN 列表', title: '一条 UPDATE … WHERE id IN (…)。要求每个字段的目标值全表一致' },
                        { value: 'case', label: 'CASE WHEN', title: '一条 UPDATE，SET 里用 CASE id WHEN … THEN … 按行赋值' },
                      ]}
                    />
                    {result?.resolved.auto && (
                      <Auto>自动 → {result.resolved.kind === 'in' ? 'IN 列表' : 'CASE WHEN'}</Auto>
                    )}
                  </Row>
                }
              >
                <Stack gap={8}>
                  {resultLead}
                  <Code
                    code={result?.sql ?? ''}
                    name={`${table?.name ?? 'table'}_select2update_${dialect}.sql`}
                    download={`${table?.name ?? 'table'}_select2update_${dialect}.sql`}
                    size="lg"
                    empty="还没有可生成的语句——先勾选要更新的字段。"
                    extra={<ExecOnConn sql={result?.sql ?? ''} dialect={dialect} />}
                    tools={<FavSqlBtn sql={result?.sql ?? ''} />}
                  />
                </Stack>
              </Card>

              <Card
                title="哪些行会改"
                who={result ? `${includedRows.length} 行进入 UPDATE` : undefined}
                tight
                open={previewOpen}
                onToggle={setPreviewOpen}
              >
                {previewBody}
              </Card>
            </Col>
          </Split>
        </div>
      )}
    </Page>
  )
}
