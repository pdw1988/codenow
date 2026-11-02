/**
 * 可执行模式的数据值 / 条件字段编辑器，PRD 4.2 / 4.6~4.9。
 *
 * 值是自动造的（lib/sqlgen/mockValue.ts），这里只做展示和收集改动；自动值不落到 state——
 * 它是 (seed, 阶段, 表, 字段) 的纯函数，存一份等于埋一个「表结构变了但值还是旧的」不一致点。
 *
 * 布局跟连库勾列同一套等宽网格：一行多个，不要一张「字段/类型/列值/注释」大表把左栏撑成一列。
 * SELECT / DELETE 是条件格子（勾选 + 操作符 + 值）；INSERT 是数据格子（名 + 值）；
 * UPDATE 两块都要——SET 用数据，WHERE 用主键条件。
 */
import type { Column, Dialect, TableInfo } from '../../types/schema'
import {
  isUpdateTime,
  planValues,
  resolveValue,
  type ValueMap,
  type ValuePlan,
} from '../../lib/sqlgen/mockValue'
import {
  CMP_OP_OPTIONS,
  DEFAULT_PK_VALUE,
  defaultConditionValue,
  type CmpOp,
} from '../../lib/sqlgen/executable'
import { sortColumnsForUi, compareColumnsForUi, isDateRelatedColumn } from '../../lib/columnOrder'
import { realNamesOf } from '../../lib/columnPick'
import { Band, Btn, Cb, EmptyBox, Fld, Hint, Row, Sel, Tag } from '../../components/ui'
import type { CrudKind } from '../../lib/sqlgen/singleTable'
import { usePickMoreColumns } from './usePickMore'
import { PickMoreBtn } from './PickMoreBtn'

/** 审计字段：INSERT/UPDATE 都不该手工填，排除审计字段按钮按这条过滤 */
export const AUDIT = /^(create|update)_(time|at|by)$/i

interface Props {
  table: TableInfo
  dialect: Dialect
  seed: number
  /** 查询字段里选中的列；null = 全选。没选的不在数据格子里出现，反正也不进 SQL */
  selectedColumns: string[] | null
  kinds: CrudKind[]
  /** INSERT / UPDATE 数据 + 主键 WHERE 共用的手改值 */
  vals: ValueMap
  /** SELECT 条件的值 */
  cvals: ValueMap
  /** SELECT 的条件字段；null = 还没动过（默认只主键）。见 PRD 4.9 */
  selectConditions: string[] | null
  /** WHERE 比较符。缺省等于 */
  cmpOps: Record<string, CmpOp>
  /** 没勾条件时查前多少条 */
  pageSize: number
  onValsChange: (values: ValueMap) => void
  onCvalsChange: (values: ValueMap) => void
  onSelectConditionsChange: (names: string[]) => void
  onCmpOpsChange: (ops: Record<string, CmpOp>) => void
}

function cellTitle(c: Column): string {
  return [c.name, c.isPrimaryKey ? 'PK' : '', c.type, c.comment].filter(Boolean).join(' · ')
}

function ValGrid({
  plans,
  map,
  onChange,
  placeholder,
}: {
  plans: ValuePlan[]
  map: ValueMap
  onChange: (next: ValueMap) => void
  placeholder: string
}) {
  return (
    <div className="val-cols">
      {plans.map((p) => {
        const dateWide = isDateRelatedColumn(p.column)
        return (
          <div
            key={p.column.name}
            className={dateWide ? 'val-cell wide' : 'val-cell'}
            title={cellTitle(p.column)}
          >
            <div className="nm">
              {p.column.name}
              {p.column.isPrimaryKey && <Tag tone="pk">PK</Tag>}
              {isUpdateTime(p.column.name) && (
                <Tag tone="wr" title="UPDATE 语句里这一列强制取当前时间，这里的值只影响 INSERT">
                  更新时取当前
                </Tag>
              )}
            </div>
            <Fld
              value={resolveValue(p, map)}
              placeholder={placeholder}
              aria-label={p.column.name}
              onChange={(e) => onChange({ ...map, [p.column.name]: e.target.value })}
            />
          </div>
        )
      })}
    </div>
  )
}

export function CondGrid({
  columns,
  checked,
  toggle,
  overrides,
  fallback,
  onOverrides,
  ops,
  onOps,
  placeholder,
  /** UPDATE / DELETE 的主键不能取消，否则 WHERE 会丢 */
  locked,
  /** SELECT 条件：默认只露关键列，其余加载更多（主键锁死清单不折） */
  foldMore,
  /** 存 ops/值/勾选用的键；多表传 `表.列`，默认列名 */
  idOf = (c) => c.name,
  /** 勾选旁显示文案；多表常写 `别名.列` */
  labelOf,
}: {
  columns: Column[]
  checked: (id: string) => boolean
  toggle?: (id: string, on: boolean) => void
  /** 只含手改过的值，跟生成器那份 map 同一份 */
  overrides: ValueMap
  fallback: ValueMap
  onOverrides: (next: ValueMap) => void
  ops: Record<string, CmpOp>
  onOps: (next: Record<string, CmpOp>) => void
  placeholder: string
  locked?: boolean
  foldMore?: boolean
  idOf?: (c: Column) => string
  labelOf?: (c: Column) => string
}) {
  const fold = !!foldMore && !locked
  const pick = usePickMoreColumns(columns)
  const list = fold ? pick.visible : columns
  const hiddenChecked =
    fold && !pick.moreOpen && pick.more.some((c) => checked(idOf(c)))

  return (
    <div className="cond-cols">
      {list.map((c) => {
        const id = idOf(c)
        const text = labelOf?.(c) ?? c.name
        const on = locked || checked(id)
        const op = ops[id] ?? 'eq'
        const dateWide = on && isDateRelatedColumn(c)
        return (
          <div
            key={id}
            className={
              on
                ? dateWide
                  ? 'cond-cell wide'
                  : 'cond-cell'
                : 'cond-cell off'
            }
            title={cellTitle(c)}
          >
            {locked ? (
              <div className="nm">
                {text}
                {c.isPrimaryKey && <Tag tone="pk">PK</Tag>}
                {c.isUnique && !c.isPrimaryKey && <Tag tone="hi">UK</Tag>}
                {c.isIndexed && !c.isPrimaryKey && !c.isUnique && <Tag tone="hi">IDX</Tag>}
              </div>
            ) : (
              <Cb checked={on} onChange={(v) => toggle?.(id, v)} title={cellTitle(c)}>
                <span className="cn">{text}</span>
                {c.isPrimaryKey && <Tag tone="pk">PK</Tag>}
                {c.isUnique && !c.isPrimaryKey && <Tag tone="hi">UK</Tag>}
                {c.isIndexed && !c.isPrimaryKey && !c.isUnique && <Tag tone="hi">IDX</Tag>}
              </Cb>
            )}
            {on && (
              <div className="cond-pair">
                <Sel
                  className="op"
                  aria-label={`${text} 比较`}
                  options={CMP_OP_OPTIONS}
                  value={op}
                  onChange={(v) => onOps({ ...ops, [id]: v })}
                />
                <Fld
                  value={id in overrides ? overrides[id] : (fallback[id] ?? '')}
                  placeholder={placeholder}
                  aria-label={`${text} 条件值`}
                  onChange={(e) => onOverrides({ ...overrides, [id]: e.target.value })}
                />
              </div>
            )}
          </div>
        )
      })}
      {fold && (
        <PickMoreBtn
          moreCount={pick.more.length}
          moreOpen={pick.moreOpen}
          hiddenChecked={hiddenChecked}
          onToggle={pick.toggleMore}
          keepHint="条件"
        />
      )}
    </div>
  )
}

export function ValuePanel({
  table,
  dialect,
  seed,
  selectedColumns,
  kinds,
  vals,
  cvals,
  selectConditions,
  cmpOps,
  pageSize,
  onValsChange,
  onCvalsChange,
  onSelectConditionsChange,
  onCmpOpsChange,
}: Props) {
  const keep = (p: ValuePlan) =>
    !selectedColumns || realNamesOf(selectedColumns).includes(p.column.name)

  const insertPlans = planValues(table, dialect, seed, 'insert').filter(keep)
  /*
   * 数据格子列的是真会进语句的字段：自增主键交给数据库，
   * 摆出来能编辑但生成器不看——那是比不显示更糟的误导。
   */
  const dataPlans = insertPlans
    .filter((p) => !(p.column.isPrimaryKey && p.column.isAutoIncrement))
    .slice()
    .sort((a, b) => compareColumnsForUi(a.column, b.column))
  const pks = sortColumnsForUi(table.columns.filter((c) => c.isPrimaryKey))

  /** 条件字段名。null = 还没动过，按默认「只主键」走；[] 是明确清空，两者必须分得开 */
  const condNames = selectConditions ?? pks.map((c) => c.name)

  const toggleCond = (name: string, on: boolean) => {
    // 存成 UI 排序口径，跟 CondGrid / 生成器 selectConditionColumns 一致
    const wanted = new Set(condNames)
    if (on) wanted.add(name)
    else wanted.delete(name)
    onSelectConditionsChange(
      sortColumnsForUi(table.columns.filter((c) => wanted.has(c.name))).map((c) => c.name),
    )
  }

  const showData = kinds.includes('insert') || kinds.includes('update')
  const showPk = kinds.includes('update') || kinds.includes('delete')
  const showCond = kinds.includes('select')

  if (!showData && !showPk && !showCond) {
    return <EmptyBox>当前语句类型无需填写条件</EmptyBox>
  }

  /* 展示用缺省值，不写进 overrides。改一格只回传那一格，避免把自动值烧进 state */
  const pkFallback: ValueMap = Object.fromEntries(pks.map((c) => [c.name, DEFAULT_PK_VALUE]))
  const condFallback: ValueMap = Object.fromEntries(
    table.columns.map((c) => [c.name, defaultConditionValue(c, insertPlans, vals, vals)]),
  )

  return (
    <>
      {showData && (
        <div className="vsec">
          {showPk || showCond ? <Hint>{dataPlans.length} 个数据字段</Hint> : null}
          <ValGrid
            plans={dataPlans}
            map={vals}
            onChange={onValsChange}
            placeholder="留空 = NULL"
          />
        </div>
      )}

      {showPk &&
        (pks.length ? (
          <div className="vsec">
            {showData ? <Hint>WHERE 主键条件</Hint> : null}
            <CondGrid
              columns={pks}
              checked={() => true}
              locked
              overrides={vals}
              fallback={pkFallback}
              onOverrides={onValsChange}
              ops={cmpOps}
              onOps={onCmpOpsChange}
              placeholder={`留空 = ${DEFAULT_PK_VALUE}`}
            />
          </div>
        ) : (
          <div className="vsec">
            <Band tone="warn" title={`${table.name} 没有主键`}>
              UPDATE / DELETE 无法按主键定位单行。生成语句的 WHERE 为占位注释，执行前需补全。
            </Band>
          </div>
        ))}

      {showCond && (
        <div className="vsec">
          <Row tight>
            <Btn variant="mini" onClick={() => onSelectConditionsChange(table.columns.map((c) => c.name))}>
              全选
            </Btn>
            <Btn variant="mini" onClick={() => onSelectConditionsChange([])}>
              全不选
            </Btn>
            <Hint>未勾选则查前 {pageSize} 条</Hint>
          </Row>
          <CondGrid
            columns={sortColumnsForUi(table.columns)}
            checked={(name) => condNames.includes(name)}
            toggle={toggleCond}
            overrides={cvals}
            fallback={condFallback}
            onOverrides={onCvalsChange}
            ops={cmpOps}
            onOps={onCmpOpsChange}
            placeholder="留空 = IS NULL"
            foldMore
          />
        </div>
      )}
    </>
  )
}
