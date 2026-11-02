/**
 * 批量 INSERT。原型 `mockup/batch-insert.html`。
 *
 * 跟批量 UPDATE 拆开：原先一页用段切换藏半屏卡片，造测试数据还得先看见
 * 「定位方式 / 主键列表」。这一页只负责造新行。
 */
import { useMemo, useState } from 'react'
import type { Dialect } from '../../types/schema'
import { generateBatchInsert, type InsertFormat, type RuleMap } from '../../lib/sqlgen/batchGen'
import { useSchemaStore } from '../../store/useSchemaStore'
import { Page } from '../../components/shell/Page'
import { pageInNav } from '../../components/shell/pages'
import {
  Auto,
  Card,
  Cb,
  Col,
  Fld,
  Hint,
  Lbl,
  Row,
  Seg,
  Split,
  Stack,
} from '../../components/ui'
import { BatchResultCol, RuleRow, TableAndDialect } from './batchBits'
import { isDigits, ruleOf } from './batchUtil'
import { usePickMoreColumns } from '../sqlgen/usePickMore'
import { PickMoreBtn } from '../sqlgen/PickMoreBtn'
import { NoTablesEmpty } from '../schema/NoTablesEmpty'

export function BatchInsertPage() {
  const tables = useSchemaStore((s) => s.tables)

  /* tableName 留空 = 跟着第一张表走，表异步加载完成前后都不用 effect 补救（同 s2u） */
  const [tableName, setTableName] = useState('')
  const [dialect, setDialect] = useState<Dialect>('oracle')
  const [cntRaw, setCntRaw] = useState('20')
  const [startIdRaw, setStartIdRaw] = useState('')
  const [insFmt, setInsFmt] = useState<InsertFormat>('each')
  const [perStmt, setPerStmt] = useState(10)
  const [hdr, setHdr] = useState(true)
  const [rules, setRules] = useState<RuleMap>({})
  /** 默认展开：关键列（主键/唯一/索引/日期）直接可见，其余点「加载更多」 */
  const [rulesOpen, setRulesOpen] = useState(true)

  const table = tables.find((t) => t.name === tableName) ?? tables[0] ?? null
  const n = Math.min(500, Math.max(1, Number.parseInt(cntRaw, 10) || 1))
  const sid = isDigits(startIdRaw) ? Number.parseInt(startIdRaw.trim(), 10) : null
  const colPick = usePickMoreColumns(table?.columns ?? [])
  // 收起后已改过规则的「更多」列仍进 SQL，按钮要提示一下
  const moreHasCustomRule =
    !colPick.moreOpen &&
    colPick.more.some((c) => {
      const r = rules[c.name]
      return !!r && r.k !== 'auto'
    })

  const pickKind = (colName: string, k: Parameters<typeof ruleOf>[0]) =>
    setRules((s) => ({ ...s, [colName]: ruleOf(k) }))
  const editParam = (colName: string, slot: 'a' | 'b', v: string) => {
    setRules((s) => ({
      ...s,
      [colName]: { k: s[colName]?.k ?? 'fixed', p: { ...s[colName]?.p, [slot]: v } },
    }))
  }

  const result = useMemo(() => {
    if (!table) return null
    return generateBatchInsert(table, {
      dialect,
      count: n,
      format: insFmt,
      perStmt,
      startId: sid,
      headerComment: hdr,
      rules,
    })
  }, [table, dialect, n, insFmt, perStmt, sid, hdr, rules])

  const fileName = table ? `${table.name}_batch_insert_${dialect}.sql` : 'batch.sql'

  return (
    <Page tab="batch-insert" actions={<Auto>配置即时生成</Auto>}>
      {!table ? (
        <NoTablesEmpty />
      ) : (
        <Split>
          <Col>
            <TableAndDialect
              tables={tables}
              table={table}
              dialect={dialect}
              who={pageInNav('batch-update') ? '改已有行请用「批量 UPDATE」' : undefined}
              onTableChange={(v) => {
                setTableName(v)
                setRules({})
              }}
              onDialectChange={setDialect}
            />

            <Card title="② 生成参数" className="form-card">
              <Stack>
                <Row tight>
                  <Lbl>条数</Lbl>
                  <Fld
                    value={cntRaw}
                    type="number"
                    min={1}
                    max={500}
                    style={{ width: 90 }}
                    aria-label="生成条数"
                    onChange={(e) => setCntRaw(e.target.value)}
                  />
                  <Hint>1 ~ 500；更多请分批——一次塞几万条进界面谁也审不动</Hint>
                </Row>
                <Row tight>
                  <Lbl>起始ID</Lbl>
                  <Fld
                    value={startIdRaw}
                    placeholder="留空 = 排除自增列"
                    style={{ width: 130 }}
                    aria-label="起始ID"
                    onChange={(e) => setStartIdRaw(e.target.value)}
                  />
                  <Hint>主键/唯一列从该值连号，避免撞库里已有的行；自增列留空则整列排除</Hint>
                </Row>
                <Row tight>
                  <Lbl>形态</Lbl>
                  <Seg
                    value={insFmt}
                    onChange={(v) => setInsFmt(v as InsertFormat)}
                    options={[
                      {
                        value: 'each',
                        label: '逐条',
                        title: '每行一条 INSERT。各方言都能直接跑，最通用',
                      },
                      {
                        value: 'multi',
                        label: '一条多VALUES',
                        disabled: dialect !== 'mysql' && dialect !== 'sqlite',
                        title:
                          dialect !== 'mysql' && dialect !== 'sqlite'
                            ? '多 VALUES 只有 MySQL / SQLite 支持（Oracle 要 INSERT ALL）；先切方言再选'
                            : '拼成一条 INSERT … VALUES (…),(…)…',
                      },
                      {
                        value: 'chunk',
                        label: '分批',
                        disabled: dialect !== 'mysql' && dialect !== 'sqlite',
                        title:
                          dialect !== 'mysql' && dialect !== 'sqlite'
                            ? '多 VALUES 只有 MySQL / SQLite 支持（Oracle 要 INSERT ALL）；先切方言再选'
                            : '每 N 条一组 INSERT，组内是多 VALUES；超 1MB 的组自动再切',
                      },
                    ]}
                  />
                </Row>
                {insFmt === 'chunk' && (
                  <Row tight>
                    <Lbl>每组条数</Lbl>
                    <Seg
                      value={String(perStmt)}
                      onChange={(v) => setPerStmt(Number(v))}
                      options={[1, 10, 50, 100].map((x) => ({ value: String(x), label: String(x) }))}
                    />
                    <Hint>单组超 1MB 还会自动再切</Hint>
                  </Row>
                )}
                <Cb checked={hdr} onChange={setHdr}>
                  注释头（表名、条数、起始ID/自增列说明）
                </Cb>
                <Hint>
                  每个字段默认沿用可执行模式的自动值，种子是行号——同配置两次生成逐字符一致；要精确控制就逐列换下面的规则。
                </Hint>
              </Stack>
            </Card>

            <Card
              title="③ 字段生成规则"
              who="默认露主键/唯一/索引/日期；其余加载更多"
              open={rulesOpen}
              onToggle={setRulesOpen}
            >
              <Stack gap={6}>
                {colPick.visible.map((c) => (
                  <RuleRow
                    key={c.name}
                    c={c}
                    forInsert
                    rules={rules}
                    sid={sid}
                    table={table}
                    dialect={dialect}
                    onPickKind={pickKind}
                    onEditParam={editParam}
                  />
                ))}
                <PickMoreBtn
                  moreCount={colPick.more.length}
                  moreOpen={colPick.moreOpen}
                  hiddenChecked={moreHasCustomRule}
                  onToggle={colPick.toggleMore}
                  keepHint="SQL"
                />
              </Stack>
            </Card>
          </Col>

          <Col>
            <BatchResultCol result={result} fileName={fileName} dialect={dialect} />
          </Col>
        </Split>
      )}
    </Page>
  )
}
