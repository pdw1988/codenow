/**
 * 字段勾选网格：默认只露 PK/UK/IDX/日期；其余「加载更多」／「收起」。
 * SELECT 时可再露 COUNT(*) / COUNT(主键)，默认不勾。
 * 收起只藏界面，已勾的「更多」列仍进 SQL——别把勾选状态跟着折掉。
 */
import type { Column } from '../../types/schema'
import {
  COUNT_PK,
  COUNT_STAR,
  countPkLabel,
  primaryKeyForCount,
  withAggToggle,
} from '../../lib/columnPick'
import { Cb, Tag } from '../../components/ui'
import { usePickMoreColumns } from './usePickMore'
import { PickMoreBtn } from './PickMoreBtn'

export interface ColumnPickGridProps {
  columns: Column[]
  /** null = 未动 = 真列全选；不含聚合记号时聚合视为未勾 */
  selected: string[] | null
  onChange: (next: string[] | null) => void
  /** 仅查询字段勾选需要；INSERT/UPDATE 不要 */
  showAgg?: boolean
  /**
   * 未动（selected = null）时视作勾了哪些列。不传 = 全部真列。
   * 传这个的页面要拿同一份名单去生成 SQL，别各算一遍。
   */
  defaultNames?: string[]
  className?: string
}

function ColCb({
  c,
  checked,
  onToggle,
  label,
}: {
  c: Column
  checked: boolean
  onToggle: (on: boolean) => void
  label?: string
}) {
  const text = label ?? c.name
  return (
    <Cb
      title={c.comment ? `${text} ${c.comment}` : text}
      checked={checked}
      onChange={onToggle}
    >
      <span className="cn">{text}</span>
      {c.isPrimaryKey && <Tag tone="pk">PK</Tag>}
      {c.isUnique && !c.isPrimaryKey && <Tag tone="hi">UK</Tag>}
      {c.isIndexed && !c.isPrimaryKey && !c.isUnique && <Tag tone="hi">IDX</Tag>}
    </Cb>
  )
}

export function ColumnPickGrid({
  columns,
  selected,
  onChange,
  showAgg = false,
  defaultNames,
  className = 'pick-cols',
}: ColumnPickGridProps) {
  const { shown, more, moreOpen, toggleMore } = usePickMoreColumns(columns)
  const allNames = columns.map((c) => c.name)
  /** 未动算勾了哪些：默认全选，查询字段那边会传一份「只露出来的」 */
  const untouched = defaultNames ?? allNames
  const checkedNames = selected ?? untouched
  const pk = showAgg ? primaryKeyForCount(columns) : null
  const hiddenChecked = !moreOpen && more.some((c) => checkedNames.includes(c.name))

  const toggleCol = (name: string, on: boolean) => {
    const cur = selected ?? untouched
    onChange(on ? [...cur, name] : cur.filter((n) => n !== name))
  }

  const toggleAgg = (token: typeof COUNT_STAR | typeof COUNT_PK, on: boolean) => {
    onChange(withAggToggle(selected, untouched, token, on))
  }

  return (
    <div className={className}>
      {shown.map((c) => (
        <ColCb
          key={c.name}
          c={c}
          checked={checkedNames.includes(c.name)}
          onToggle={(on) => toggleCol(c.name, on)}
        />
      ))}
      {showAgg && (
        <div className="pick-aggs">
          <Cb
            className="pick-agg"
            title="行数 COUNT(*)"
            checked={selected != null && selected.includes(COUNT_STAR)}
            onChange={(on) => toggleAgg(COUNT_STAR, on)}
          >
            <span className="cn">COUNT(*)</span>
          </Cb>
          {pk && (
            <Cb
              className="pick-agg"
              title={`${countPkLabel(pk.name)}（非空主键条数）`}
              checked={selected != null && selected.includes(COUNT_PK)}
              onChange={(on) => toggleAgg(COUNT_PK, on)}
            >
              <span className="cn">{countPkLabel(pk.name)}</span>
            </Cb>
          )}
        </div>
      )}
      {moreOpen &&
        more.map((c) => (
          <ColCb
            key={c.name}
            c={c}
            checked={checkedNames.includes(c.name)}
            onToggle={(on) => toggleCol(c.name, on)}
          />
        ))}
      <PickMoreBtn
        moreCount={more.length}
        moreOpen={moreOpen}
        hiddenChecked={hiddenChecked}
        onToggle={toggleMore}
      />
    </div>
  )
}

/** 条件勾选（多表 `别名.列`）：同一套加载更多，无 COUNT */
export function CondPickGrid({
  columns,
  checked,
  onToggle,
  labelOf,
  className = 'pick-cols',
}: {
  columns: Column[]
  checked: (c: Column) => boolean
  onToggle: (c: Column, on: boolean) => void
  labelOf?: (c: Column) => string
  className?: string
}) {
  const { more, moreOpen, visible, toggleMore } = usePickMoreColumns(columns)
  const hiddenChecked = !moreOpen && more.some((c) => checked(c))

  return (
    <div className={className}>
      {visible.map((c) => (
        <ColCb
          key={c.name}
          c={c}
          checked={checked(c)}
          onToggle={(on) => onToggle(c, on)}
          label={labelOf?.(c)}
        />
      ))}
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
