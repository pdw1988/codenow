/**
 * 批量 UPDATE。原型 `mockup/batch-update.html`。
 *
 * 跟批量 INSERT 拆开：造新行的条数 / 起始ID 跟「改哪些行」不是同一件事。
 * SELECT转UPDATE 仍是独立页，这里只留入口——粘贴查询结果那一套已经完整，
 * 合并时把那块面板搬过来就是第四种定位，纯函数层不用动。
 */
import { useMemo, useState } from 'react'
import type { Dialect } from '../../types/schema'
import {
  generateBatchUpdate,
  parsePkList,
  ruleVaries,
  type BatchResult,
  type RuleMap,
} from '../../lib/sqlgen/batchGen'
import { useSchemaStore } from '../../store/useSchemaStore'
import { useUiStore } from '../../store/useUiStore'
import { Page } from '../../components/shell/Page'
import { pageInNav } from '../../components/shell/pages'
import {
  Auto,
  Band,
  Btn,
  Card,
  Cb,
  Col,
  EmptyBox,
  Fld,
  Hint,
  Lbl,
  Mono,
  Row,
  Seg,
  Spacer,
  Split,
  Stack,
  TextArea,
} from '../../components/ui'
import { BatchResultCol, RuleRow, TableAndDialect } from './batchBits'
import { ruleOf } from './batchUtil'
import { sortColumnsForUi } from '../../lib/columnOrder'
import { NoTablesEmpty } from '../schema/NoTablesEmpty'

export function BatchUpdatePage() {
  const tables = useSchemaStore((s) => s.tables)
  const setActiveTab = useUiStore((s) => s.setActiveTab)

  const [tableName, setTableName] = useState('')
  const [dialect, setDialect] = useState<Dialect>('oracle')
  const [loc, setLoc] = useState<'pk' | 'cond' | 'fixed' | 'src'>('pk')
  const [pkRaw, setPkRaw] = useState('')
  const [upFmt, setUpFmt] = useState<'each' | 'case'>('each')
  const [upBatchRaw, setUpBatchRaw] = useState('20')
  const [condOn, setCondOn] = useState<Record<string, boolean>>({})
  const [cvals, setCvals] = useState<Record<string, string>>({})
  const [fixedOk, setFixedOk] = useState(false)
  const [setOn, setSetOn] = useState<Record<string, boolean>>({})
  const [rules, setRules] = useState<RuleMap>({})
  /** 默认折起：右栏先看 UPDATE；要改 SET 规则再展开 */
  const [rulesOpen, setRulesOpen] = useState(false)

  const table = tables.find((t) => t.name === tableName) ?? tables[0] ?? null
  const upBatch = Math.min(500, Math.max(1, Number.parseInt(upBatchRaw, 10) || 20))

  const resetFieldState = () => {
    setRules({})
    setSetOn({})
    setCondOn({})
    setCvals({})
    setPkRaw('')
    setFixedOk(false)
  }

  const pickKind = (colName: string, k: Parameters<typeof ruleOf>[0]) =>
    setRules((s) => ({ ...s, [colName]: ruleOf(k) }))
  const editParam = (colName: string, slot: 'a' | 'b', v: string) => {
    setRules((s) => ({
      ...s,
      [colName]: { k: s[colName]?.k ?? 'fixed', p: { ...s[colName]?.p, [slot]: v } },
    }))
  }

  const conditions = useMemo(() => {
    if (!table) return {}
    const out: Record<string, string> = {}
    for (const c of table.columns) if (condOn[c.name]) out[c.name] = cvals[c.name] ?? ''
    return out
  }, [table, condOn, cvals])

  const result = useMemo(() => {
    if (!table) return null
    // 从 SELECT 导入已经单独成页：走 generateBatchUpdate 会误落到「固定条件」分支
    if (loc === 'src') {
      const skip: BatchResult = {
        sql: '-- 从 SELECT 结果导入请打开「SELECT转UPDATE」页：粘贴查询结果即可生成 UPDATE。',
        stat: '',
        refused: true,
        warnings: [],
        preview: null,
        previewLabel: '请打开 SELECT转UPDATE',
      }
      return skip
    }
    const locator =
      loc === 'pk'
        ? ({ mode: 'pk', raw: pkRaw, outputFormat: upFmt, batchSize: upBatch } as const)
        : loc === 'cond'
          ? ({ mode: 'cond', conditions } as const)
          : ({ mode: 'fixed', confirmed: fixedOk } as const)
    return generateBatchUpdate(table, { dialect, setOn, rules, locator })
  }, [table, dialect, loc, pkRaw, upFmt, upBatch, conditions, fixedOk, setOn, rules])

  const sets = useMemo(
    () => (table ? table.columns.filter((c) => !c.isPrimaryKey && setOn[c.name]) : []),
    [table, setOn],
  )
  const pkParsed = useMemo(() => parsePkList(pkRaw), [pkRaw])
  /** cond/fixed 定位一条语句影响多行、没有行号：随行变化的规则只取第 1 行的值，得明说 */
  const varyHint = loc !== 'pk' && loc !== 'src' && sets.some((c) => ruleVaries(rules[c.name]))
  const fileName = table ? `${table.name}_batch_update_${loc}_${dialect}.sql` : 'batch.sql'

  return (
    <Page tab="batch-update" actions={<Auto>配置即时生成</Auto>}>
      {!table ? (
        <NoTablesEmpty />
      ) : (
        <Split>
          <Col>
            <TableAndDialect
              tables={tables}
              table={table}
              dialect={dialect}
              who="造新行请用「批量 INSERT」"
              onTableChange={(v) => {
                setTableName(v)
                resetFieldState()
              }}
              onDialectChange={setDialect}
              extra={
                <Row tight>
                  <Lbl>定位方式</Lbl>
                  <Seg
                    value={loc}
                    onChange={(v) => setLoc(v as typeof loc)}
                    options={[
                      { value: 'pk', label: '按主键列表' },
                      { value: 'cond', label: '按条件字段' },
                      {
                        value: 'fixed',
                        label: '按固定条件',
                        title: 'WHERE 1=1，全表更新（慎用）',
                      },
                      // 只是跳去 SELECT转UPDATE 的入口：那页不在导航里就不给这一项
                      ...(pageInNav('s2u')
                        ? [
                            {
                              value: 'src',
                              label: '从SELECT导入',
                              title: '已有正式页（SELECT转UPDATE），这里只留入口',
                            },
                          ]
                        : []),
                    ]}
                  />
                </Row>
              }
            />

            {loc === 'pk' && (
              <Card title="② 主键列表" who="范围 / 列表混着来" className="form-card">
                <Stack>
                  <TextArea
                    value={pkRaw}
                    rows={5}
                    aria-label="主键列表"
                    placeholder={'1-100\n1001, 1005，1009;1013'}
                    onChange={(e) => setPkRaw(e.target.value)}
                  />
                  {/* 贴主键列表是这条路径的主入口，走 onChange 边贴边算个数，不用失焦才看到 */}
                  <Hint>
                    范围写法 <b>1-100</b> 直接展开；逗号/空格/分号/换行分隔都行，保序去重 ·{' '}
                    <b>{pkParsed.list.length}</b> 个主键待更新
                  </Hint>
                  <Row tight>
                    <Lbl>输出格式</Lbl>
                    <Seg
                      value={upFmt}
                      onChange={(v) => setUpFmt(v as 'each' | 'case')}
                      options={[
                        {
                          value: 'each',
                          label: '逐条 UPDATE',
                          title: '每个主键一条 UPDATE，逐条可核对',
                        },
                        {
                          value: 'case',
                          label: 'CASE WHEN',
                          title: 'CASE id WHEN … THEN … 一条语句更新一批，效率最高',
                        },
                      ]}
                    />
                  </Row>
                  <Row tight>
                    <Lbl>批量大小</Lbl>
                    <Fld
                      value={upBatchRaw}
                      type="number"
                      min={1}
                      max={500}
                      style={{ width: 80 }}
                      aria-label="逐条格式的分组大小"
                      onChange={(e) => setUpBatchRaw(e.target.value)}
                    />
                    <Hint>
                      {upFmt === 'case'
                        ? 'CASE WHEN 固定每 100 条一组'
                        : `逐条每 ${upBatch} 条一组注释分隔；刻意不包 BEGIN/COMMIT——事务语法方言差异大`}
                    </Hint>
                  </Row>
                </Stack>
              </Card>
            )}

            {loc === 'cond' && (
              <Card
                title="② WHERE 条件字段"
                who="至少勾一个，否则不生成"
                extra={
                  <Row tight>
                    <Btn
                      variant="mini"
                      onClick={() =>
                        setCondOn(Object.fromEntries(table.columns.map((c) => [c.name, true])))
                      }
                    >
                      全选
                    </Btn>
                    <Btn variant="mini" onClick={() => setCondOn({})}>
                      全不选
                    </Btn>
                  </Row>
                }
              >
                <Stack gap={6}>
                  {sortColumnsForUi(table.columns).map((c) => (
                    <Row key={c.name} style={{ flexWrap: 'wrap', gap: 9 }}>
                      <Cb
                        checked={!!condOn[c.name]}
                        title={c.comment || c.name}
                        onChange={(v) => setCondOn((s) => ({ ...s, [c.name]: v }))}
                      >
                        <Mono>{c.name}</Mono>
                      </Cb>
                      <Hint>{c.comment}</Hint>
                      <Spacer />
                      <Fld
                        value={cvals[c.name] ?? ''}
                        placeholder="留空 = IS NULL"
                        style={{ width: 220 }}
                        aria-label={`${c.name} 的条件值`}
                        onChange={(e) => setCvals((s) => ({ ...s, [c.name]: e.target.value }))}
                      />
                    </Row>
                  ))}
                  <Hint>条件之间 AND 连接；值的形状按字段类型转字面量。</Hint>
                </Stack>
              </Card>
            )}

            {loc === 'fixed' && (
              <Card title="② 按固定条件 = WHERE 1=1" who="全表更新 · 慎用">
                <Stack>
                  <Band tone="err">
                    <b>这个定位不带任何过滤：</b>语句会长成 UPDATE … SET … WHERE 1=1，
                    这张表的<b>每一行</b>都会被改成同一批值。规格里标了「慎用」，所以有一道确认。
                  </Band>
                  <Cb checked={fixedOk} onChange={setFixedOk}>
                    我确认要更新这张表的全部行
                  </Cb>
                </Stack>
              </Card>
            )}

            {loc === 'src' && (
              <Card title="② 从SELECT结果导入">
                <Stack>
                  <Band tone="info">
                    <b>这个定位方式已经上线了：</b>粘贴查询结果 → 自动认主键 → 值相同走 IN、不同走
                    CASE WHEN，只把值有变化的行放进 WHERE。
                  </Band>
                  <Btn onClick={() => setActiveTab('s2u')}>打开 SELECT转UPDATE →</Btn>
                </Stack>
              </Card>
            )}

            {loc !== 'src' && (
              <Card
                title="③ SET 字段与新值规则"
                who="勾选要改的列；缺省 = 自动值"
                open={rulesOpen}
                onToggle={setRulesOpen}
                extra={
                  <Row tight>
                    <Btn
                      variant="mini"
                      onClick={() =>
                        setSetOn(
                          Object.fromEntries(
                            table.columns.filter((c) => !c.isPrimaryKey).map((c) => [c.name, true]),
                          ),
                        )
                      }
                    >
                      全选
                    </Btn>
                    <Btn variant="mini" onClick={() => setSetOn({})}>
                      全不选
                    </Btn>
                  </Row>
                }
              >
                <Stack gap={6}>
                  {sortColumnsForUi(table.columns.filter((c) => !c.isPrimaryKey)).map((c) => (
                    <RuleRow
                      key={c.name}
                      c={c}
                      forInsert={false}
                      rules={rules}
                      setOn={setOn}
                      sid={null}
                      table={table}
                      dialect={dialect}
                      onPickKind={pickKind}
                      onEditParam={editParam}
                      onToggleSet={(col, v) => setSetOn((s) => ({ ...s, [col]: v }))}
                    />
                  ))}
                  {!sets.length && !table.columns.some((c) => c.isPrimaryKey) && (
                    <EmptyBox>这张表除主键外没有可用的字段</EmptyBox>
                  )}
                  {varyHint && (
                    <Band tone="warn">
                      <b>提示：</b>模板/随机类规则是<b>按行号</b>出值的——「条件字段」「固定条件」两种定位
                      一条语句影响多行、没有行号概念，只会取第 1 行的值统一套用；要每行不同，请用主键列表定位。
                    </Band>
                  )}
                </Stack>
              </Card>
            )}
          </Col>

          <Col>
            <BatchResultCol result={result} fileName={fileName} dialect={dialect} />
          </Col>
        </Split>
      )}
    </Page>
  )
}
