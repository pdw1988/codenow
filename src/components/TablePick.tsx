/**
 * 选表。表一多原生 select 只能靠系统滚动条翻，这里用 PopSel：
 * 一打开就能打字筛，认表名 / 注释 / 拼音 / Java 类名 / 字段名，
 * 最近用过的排在前面。
 */
import { useMemo, type CSSProperties } from 'react'
import type { TableInfo } from '../types/schema'
import { tableOptions } from '../lib/tablePick'
import { useSchemaStore } from '../store/useSchemaStore'
import { PopSel } from './ui'

interface Props {
  tables: TableInfo[]
  value: string
  onChange: (name: string) => void
  placeholder?: string
  /** 允许空选（「请选择」那一项） */
  allowEmpty?: boolean
  emptyLabel?: string
  className?: string
  style?: CSSProperties
  'aria-label'?: string
  title?: string
}

export function TablePick({
  tables,
  value,
  onChange,
  placeholder = '请选择',
  allowEmpty,
  emptyLabel,
  className,
  style,
  title,
  'aria-label': ariaLabel,
}: Props) {
  const recent = useSchemaStore((s) => s.recent)
  const touchTable = useSchemaStore((s) => s.touchTable)
  const options = useMemo(
    () =>
      tableOptions(tables, {
        empty: allowEmpty ? (emptyLabel ?? placeholder) : undefined,
        recent,
      }),
    [tables, allowEmpty, emptyLabel, placeholder, recent],
  )

  return (
    <PopSel
      options={options}
      value={value}
      onChange={(v) => {
        onChange(v)
        if (v) void touchTable(v)
      }}
      placeholder={placeholder}
      searchAt={1}
      searchPlaceholder="表名 / 注释 / 拼音"
      className={className}
      style={style}
      title={title}
      aria-label={ariaLabel}
    />
  )
}
