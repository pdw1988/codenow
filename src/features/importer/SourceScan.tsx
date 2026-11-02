/**
 * 方式三「扫描项目源码」，PRD §5.1 方式三。
 *
 * 文件遍历用 <input webkitdirectory>（FileList 自带相对路径），读内容用
 * file.text() —— 纯浏览器能力，不碰 Rust、不加 capabilities。解析和按可信度
 * 合并的正本在 lib/sourceScan.ts（*.sql > @Entity > Mapper XML），这里只编排：
 *
 * · 选完目录立刻按当前来源开关扫描；解析结果按文件缓存在 state 里，
 *   之后切换来源开关只重跑 mergeScanned，一个文件都不重读——
 *   「关掉 XML 再打开」是秒级的，用户才敢拿开关做对比；
 * · 只有 Mapper XML 来源的表默认不勾（缺多少列根本不知道），强行导入给警告；
 * · 外键两级可信度和方式二同一套：SQL 脚本里解析出的真约束直接收，
 *   命名推断在导入时对「已有缓存 ∪ 本次导入」整体跑一遍，绝不顶掉真约束。
 */
import { useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { App } from 'antd'
import { FolderOpenOutlined, WarningOutlined } from '@ant-design/icons'
import type { ForeignKey, TableInfo, Column } from '../../types/schema'
import { parseDdl, inferForeignKeys } from '../../lib/ddlParser'
import {
  entityColumnsToDomain,
  mergeScanned,
  parseEntity,
  parseMapperXml,
  pickScanFiles,
  SCAN_MAX_FILES,
  type RawScanned,
  type ScanOptions,
  SOURCE_LABELS,
} from '../../lib/sourceScan'
import { toCamelCase } from '../../lib/javaType'
import { sortColumnsForUi } from '../../lib/columnOrder'
import { fkKey } from '../../storage/memoryStore'
import { useSchemaStore } from '../../store/useSchemaStore'
import { FkLine } from '../../components/FkLine'
import {
  Band,
  Btn,
  Card,
  Cb,
  Col,
  Fold,
  Fld,
  Hint,
  Lbl,
  Mono,
  Row,
  Spacer,
  Split,
  Stack,
  Stat,
  Stats,
  Tag,
} from '../../components/ui'

/** 日志行四档语气，对应 _theme.css 的 .scanlog 子样式 */
interface LogLine {
  cls: 'fp' | 'fh' | 'fn' | 'fs'
  text: string
}

/** 单个文件的解析产物。按文件缓存，来源开关切换时零成本重组 */
interface ParsedFile {
  path: string
  kind: RawScanned['kind']
  raws: RawScanned[]
  /** SQL 脚本里解析出的真约束外键；实体/XML 不产生外键 */
  fks: ForeignKey[]
}

interface ScanStats {
  total: number
  picked: number
  skippedByDir: number
  skippedBig: number
  overflow: boolean
  tables: number
  sqlFks: number
}

/** 来源标签的可信度语气：sql=真的、ent=强调（完整但类型是猜的）、xml=要人确认 */
const SRC_TONE = { sql: 'ok', ent: 'hi', xml: 'wr' } as const

const SRC_TITLE: Record<RawScanned['kind'], string> = {
  sql: '来自建表脚本：字段、类型、注释都是真的',
  ent: '来自 @Entity 实体类：字段清单完整，但 SQL 类型是从 Java 类型猜的',
  xml: '仅来自 Mapper XML：只能看到出现过的列，缺多少不知道',
}

/** XML 命中只有列名。类型留空渲染成 ——— 宁可空着也不编一个假的出来 */
const xmlCol = (name: string): Column => ({
  name,
  type: '',
  nullable: true,
  isPrimaryKey: false,
  isAutoIncrement: false,
  defaultValue: undefined,
  comment: undefined,
  javaField: toCamelCase(name),
  javaType: '',
})

export function SourceScan() {
  const { message } = App.useApp()
  const existing = useSchemaStore((s) => s.tables)
  const cachedFks = useSchemaStore((s) => s.foreignKeys)
  const importTables = useSchemaStore((s) => s.importTables)

  const [opts, setOpts] = useState<ScanOptions>({ sql: true, ent: true, xml: true })
  const [rootName, setRootName] = useState('')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<LogLine[]>([])
  const [stats, setStats] = useState<ScanStats | null>(null)
  const [parsed, setParsed] = useState<ParsedFile[] | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [openIds, setOpenIds] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<{ added: number; covered: number; naming: number; incomplete: number } | null>(
    null,
  )

  const dirRef = useRef<HTMLInputElement | null>(null)

  /** 缓存里的已有表名：列表上的新增/覆盖标记和结果统计都靠它 */
  const existingNames = new Set(existing.map((t) => t.name.toLowerCase()))

  /**
   * 来源开关变化只在这里生效：parsed 是逐文件的解析缓存，
   * 过滤 + 重合并是纯内存操作，所以切换是即时的。
   */
  const scanned = useMemo(() => {
    const raws: RawScanned[] = []
    const fks: ForeignKey[] = []
    for (const p of parsed ?? []) {
      if (!opts[p.kind]) continue
      raws.push(...p.raws)
      fks.push(...p.fks)
    }
    return { tables: mergeScanned(raws), fks }
  }, [parsed, opts])

  const shown = scanned.tables.filter((t) => {
    const kw = filter.trim().toLowerCase()
    return (
      !kw ||
      t.name.toLowerCase().includes(kw) ||
      (t.comment ?? '').toLowerCase().includes(kw) ||
      (t.javaClass ?? '').toLowerCase().includes(kw)
    )
  })

  const toggleSel = (name: string, on: boolean) => {
    setSel((prev) => {
      const next = new Set(prev)
      if (on) next.add(name)
      else next.delete(name)
      return next
    })
  }

  const toggleOpen = (name: string, on: boolean) => {
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(name)
      else next.delete(name)
      return next
    })
  }

  const scanAllOrNew = (mode: 'all' | 'complete' | 'none') => {
    if (mode === 'none') return setSel(new Set())
    setSel(
      new Set(
        scanned.tables.filter((t) => mode === 'all' || t.complete).map((t) => t.name),
      ),
    )
  }

  const onPickDir = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0 || busy) return
    const list = Array.from(files)
    e.target.value = '' // 同一个目录选第二次也得能触发 onChange

    const metas = list.map((f) => ({ path: f.webkitRelativePath || f.name, size: f.size }))
    // pickScanFiles 输出的路径已统一成 /，这里建同规则的索引来取回 File 对象
    const byPath = new Map(metas.map((m, i) => [m.path.replace(/\\/g, '/'), list[i]]))
    const root = metas[0]?.path.split(/[\\/]/)[0] ?? '所选目录'
    setRootName(root)
    setResult(null)
    setBusy(true)

    const lines: LogLine[] = []
    const push = (cls: LogLine['cls'], text: string) => lines.push({ cls, text })
    const flush = () => setLog([...lines])
    push('fh', `扫描 ${root} …`)
    flush()

    const picked = pickScanFiles(metas, opts)
    push(
      'fn',
      `${metas.length} 个文件：命中 .sql/.java/.xml ${picked.picks.length} 个 · 排除目录跳过 ${picked.skippedByDir} 个` +
        (picked.skippedBig ? ` · 超 2MB 跳过 ${picked.skippedBig} 个` : ''),
    )
    if (picked.overflow)
      push('fs', `文件数超过上限 ${SCAN_MAX_FILES}，扫描中途停下 —— 换更具体的目录，或先关掉部分来源`)
    flush()

    const done: ParsedFile[] = []
    let nTables = 0
    let nFks = 0
    for (let i = 0; i < picked.picks.length; i++) {
      const pick = picked.picks[i]
      const file = byPath.get(pick.path)
      if (!file) continue
      try {
        const text = await file.text()
        if (pick.kind === 'sql') {
          const r = parseDdl(text)
          done.push({
            path: pick.path,
            kind: 'sql',
            raws: r.tables.map((t) => ({ name: t.name, comment: t.comment, columns: t.columns, kind: 'sql' })),
            fks: r.foreignKeys,
          })
          nTables += r.tables.length
          nFks += r.foreignKeys.length
          // 一个文件报前两条就够了：日志刷屏和没报一样难读
          for (const msg of r.errors.slice(0, 2)) push('fs', `${pick.path}：${msg}`)
        } else if (pick.kind === 'ent') {
          const ent = parseEntity(text)
          if (ent) {
            done.push({
              path: pick.path,
              kind: 'ent',
              raws: [
                {
                  name: ent.table,
                  javaClass: ent.javaClass,
                  columns: entityColumnsToDomain(ent.columns),
                  kind: 'ent',
                },
              ],
              fks: [],
            })
            nTables++
          }
        } else {
          const hits = parseMapperXml(text)
          // resultMap 和 insert 命中同一张表很常见：取列名并集（保序去重），
          // 拆成两条会让 mergeScanned 只留下第一条的列
          const groups = new Map<string, { name: string; cols: string[] }>()
          for (const h of hits) {
            const g = groups.get(h.table.toLowerCase()) ?? { name: h.table, cols: [] }
            for (const c of h.columns) {
              if (!g.cols.some((x) => x.toLowerCase() === c.toLowerCase())) g.cols.push(c)
            }
            groups.set(h.table.toLowerCase(), g)
          }
          if (groups.size) {
            done.push({
              path: pick.path,
              kind: 'xml',
              raws: [...groups.values()].map((g) => ({
                name: g.name,
                columns: g.cols.map(xmlCol),
                kind: 'xml' as const,
              })),
              fks: [],
            })
            nTables += groups.size
          }
        }
      } catch (err) {
        push('fs', `${pick.path} 读不出来：${err instanceof Error ? err.message : String(err)}`)
      }
      // 日志按批刷新：几千个文件一条一渲染会把界面拖死
      if (i % 20 === 19) {
        push('fp', `已解析 ${i + 1}/${picked.picks.length} …`)
        flush()
      }
    }

    push('fh', `完成：识别出 ${nTables} 张表 · SQL 脚本外键 ${nFks} 条`)
    flush()

    const merged = mergeScanned(done.filter((p) => opts[p.kind]).flatMap((p) => p.raws))
    setParsed(done)
    setStats({
      total: metas.length,
      picked: picked.picks.length,
      skippedByDir: picked.skippedByDir,
      skippedBig: picked.skippedBig,
      overflow: picked.overflow,
      tables: merged.length,
      sqlFks: nFks,
    })
    // 默认勾完整的：残缺表要用户想清楚再手动勾
    setSel(new Set(merged.filter((t) => t.complete).map((t) => t.name)))
    setOpenIds(new Set())
    setBusy(false)
  }

  const doImport = async () => {
    const pickedTables = scanned.tables.filter((t) => sel.has(t.name))
    if (!pickedTables.length || importing || busy) return
    setImporting(true)
    setResult(null)
    try {
      const now = new Date().toISOString()
      const imported: TableInfo[] = pickedTables.map((t) => ({
        name: t.name,
        comment: t.comment,
        javaClass: t.javaClass,
        source: 'project',
        columns: t.columns,
        createdAt: now,
        updatedAt: now,
      }))

      // SQL 脚本解析出的真约束：两端都勾才带走（跟方式二同一个口径）
      const sqlFks = scanned.fks.filter((f) => sel.has(f.fromTable) && sel.has(f.toTable))

      // 命名推断对「缓存已有 ∪ 本次导入」整体跑：新表 ↔ 老表之间也可能有关联。
      // 真约束先进 existingKeys，推断绝不顶掉它们
      const constraintKeys = new Set(
        [...cachedFks, ...sqlFks].filter((f) => f.confidence === 'constraint').map(fkKey),
      )
      const namingFks = inferForeignKeys([...existing, ...imported], constraintKeys)

      await importTables(imported, [...sqlFks, ...namingFks])

      const covered = imported.filter((t) => existingNames.has(t.name.toLowerCase())).length
      setResult({
        added: imported.length - covered,
        covered,
        naming: namingFks.length,
        incomplete: pickedTables.filter((t) => !t.complete).length,
      })
    } catch (err) {
      message.error(`导入失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setImporting(false)
    }
  }

  const relFks = scanned.fks.filter((f) => sel.has(f.fromTable) && sel.has(f.toTable))
  const incompletePicked = shown.filter((t) => sel.has(t.name) && !t.complete).length

  return (
    <Split even>
      <Col>
        <Card hero title="项目目录" who="只读扫描，不修改文件">
          <Stack>
            <Row>
              {/* webkitdirectory 不是标准属性，React 认不出，用 ref 回调直接设 */}
              <input
                ref={(el) => {
                  dirRef.current = el
                  if (el) {
                    el.setAttribute('webkitdirectory', '')
                    el.setAttribute('directory', '')
                  }
                }}
                type="file"
                hidden
                onChange={(e) => void onPickDir(e)}
                aria-label="选择项目目录"
              />
              <Btn variant="primary" disabled={busy} onClick={() => dirRef.current?.click()}>
                {busy ? '扫描中…' : (<>
                <FolderOpenOutlined aria-hidden="true" /> 选择项目目录并扫描
              </>)}
              </Btn>
              {rootName && <Mono>{rootName}</Mono>}
            </Row>
            <Hint>浏览器将请求目录读取授权，文件不会离开本机。</Hint>

            <Stack gap={4}>
              <Lbl>识别这些来源</Lbl>
              {SOURCE_LABELS.map(({ kind, label }) => (
                <Cb
                  key={kind}
                  checked={opts[kind]}
                  onChange={(on) => setOpts((prev) => ({ ...prev, [kind]: on }))}
                  title={SRC_TITLE[kind]}
                >
                  {label}
                  <Hint>　{SRC_TITLE[kind]}</Hint>
                </Cb>
              ))}
            </Stack>
            <Band tone="info" title="切换来源无需重新扫描。">
              解析结果按文件缓存，开关只控制哪些来源参与合并。
            </Band>
          </Stack>
        </Card>

        <Card title="扫描过程" who="实时日志">
          {log.length === 0 ? (
            <Hint>选择目录后显示扫描日志。</Hint>
          ) : (
            <div className="scanlog">
              {log.map((l, i) => (
                <div key={i} className={l.cls}>
                  {l.text}
                </div>
              ))}
            </div>
          )}
        </Card>

        {stats && (
          <Card title="扫描统计" who={rootName}>
            <Stats>
              <Stat t="文件总数" v={stats.total} />
              <Stat t="命中待解析" v={stats.picked} tone="acc" />
              <Stat t="排除目录跳过" v={stats.skippedByDir} />
              <Stat t="识别出表" v={stats.tables} tone="ok" />
            </Stats>
            {(stats.skippedBig > 0 || stats.overflow) && (
              <Band tone={stats.overflow ? 'warn' : 'info'}>
                {stats.overflow ? `超过 ${SCAN_MAX_FILES} 个文件上限，结果是截断的，不是全量。` : ''}
                {stats.skippedBig > 0 ? `${stats.skippedBig} 个超 2MB 的文件被跳过。` : ''}
              </Band>
            )}
          </Card>
        )}
      </Col>

      <Col>
        {parsed !== null && scanned.tables.length === 0 && (
          <Band tone="warn" title="未识别到表。">
            请确认目录含 *.sql、@Entity 或 Mapper XML。构建产物目录已排除。
          </Band>
        )}

        {scanned.tables.length > 0 && (
          <>
            <Card
              title="识别出的表"
              who={`已勾选 ${sel.size}/${scanned.tables.length}${incompletePicked ? ` · 含 ${incompletePicked} 张不完整` : ''}`}
              extra={
                <Fld value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="过滤表名 / 注释 / 类名" aria-label="过滤表" />
              }
              actions={
                <>
                  <Btn variant="mini" onClick={() => scanAllOrNew('all')}>
                    全选
                  </Btn>
                  <Btn variant="mini" onClick={() => scanAllOrNew('complete')}>
                    只选完整的
                  </Btn>
                  <Btn variant="mini" onClick={() => scanAllOrNew('none')}>
                    全不选
                  </Btn>
                  <Spacer />
                  <Btn
                    variant="primary"
                    disabled={!sel.size || importing || busy}
                    onClick={() => void doImport()}
                  >
                    {importing ? '导入中…' : `导入勾选的 ${sel.size} 张表`}
                  </Btn>
                </>
              }
            >
              <Stack gap={4}>
                {shown.map((t) => (
                  <Fold
                    key={t.name}
                    open={openIds.has(t.name)}
                    onToggle={(o) => toggleOpen(t.name, o)}
                    head={
                      <>
                        <Cb
                          checked={sel.has(t.name)}
                          onChange={(c) => toggleSel(t.name, c)}
                          title={t.complete ? undefined : SRC_TITLE.xml}
                        />
                        <Mono>{t.name}</Mono>
                        {t.srcs.map((s) => (
                          <Tag key={s} tone={SRC_TONE[s]} title={SRC_TITLE[s]}>
                            {SOURCE_LABELS.find((x) => x.kind === s)?.label}
                          </Tag>
                        ))}
                        {!t.complete && <Tag tone="wr"><WarningOutlined aria-hidden="true" /> 不完整</Tag>}
                        {existingNames.has(t.name.toLowerCase()) && <Tag tone="wr">覆盖</Tag>}
                        <Spacer />
                        <Hint>{t.columns.length} 字段</Hint>
                      </>
                    }
                  >
                    <Stack gap={2}>
                      {sortColumnsForUi(t.columns).map((c) => (
                        <div key={c.name}>
                          <Mono>{c.name}</Mono>{' '}
                          <span className="hint">
                            {c.type || '—'}
                            {c.nullable ? '' : ' · NOT NULL'}
                            {c.isPrimaryKey ? ' · 主键' : ''}
                            {c.comment ? ` · ${c.comment}` : ''}
                          </span>
                        </div>
                      ))}
                    </Stack>
                  </Fold>
                ))}
                {shown.length === 0 && <Hint>过滤条件下没有命中的表</Hint>}
              </Stack>
            </Card>

            {relFks.length > 0 && (
              <Card title="外键预览" who="来自 SQL 脚本的 FOREIGN KEY · 两端均勾选才会导入">
                {relFks.map((fk) => (
                  <FkLine key={fkKey(fk)} fk={fk} dir="out" />
                ))}
              </Card>
            )}

            {result && (
              <Stack gap={8}>
                <Band tone="ok" title={`✓ 导入完成：新增 ${result.added} 张 · 覆盖 ${result.covered} 张（整表替换）`}>
                  请到「查看表结构」确认。
                </Band>
                {result.incomplete > 0 && (
                  <Band tone="warn" title={`${result.incomplete} 张不完整的表已导入。`}>
                    仅含 XML 中出现过的列。生成 INSERT/UPDATE 前请对照真实库补全字段。
                  </Band>
                )}
                {result.naming > 0 && (
                  <Band tone="warn" title={`${result.naming} 条关系为命名推断（默认不参与 JOIN）。`}>
                    生成 SQL 时可在关联面板逐条确认。
                  </Band>
                )}
              </Stack>
            )}
          </>
        )}
      </Col>
    </Split>
  )
}
