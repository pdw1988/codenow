/**
 * 数据表。粘头只发生在外面那层 `.scroll` 里（`_theme.css`：`.scroll .tbl th`）。
 * 不包 `.scroll` 时跟着页面滚，避免表头钉在 `.pane` 顶上盖住上一行。
 *
 * 列定义写成数组而不是 JSX children，是因为项目里的表格几乎都要
 * 「按栏目标题定位」被 e2e 断言（CLAUDE.md 里那条「表格一律按栏目标题定位，
 * 不按下标」）。列表化之后，加一栏只是数组里多一项，`title` 不会跟着漂。
 */
import type { ReactNode } from 'react'
import { cx } from './cx'

export interface TblCol<T> {
  key: string
  title: ReactNode
  render: (row: T, index: number) => ReactNode
  /** 单元格 class，`_theme.css` 里有 mono / num / muted 三个现成的 */
  cls?: string
  /** 表头单独的 class（默认跟单元格一样，比如 num 要一起居中） */
  thCls?: string
  width?: number | string
}

interface TblProps<T> {
  cols: ReadonlyArray<TblCol<T>>
  rows: ReadonlyArray<T>
  rowKey: (row: T, index: number) => string
  /** 整行标记，例如解析失败的行给 'bad' */
  rowCls?: (row: T, index: number) => string | undefined
  scroll?: boolean | 'lg'
  /** 没数据时显示这句（不给就还是画一张只有表头的空表） */
  empty?: ReactNode
  className?: string
}

export function Tbl<T>({
  cols,
  rows,
  rowKey,
  rowCls,
  scroll,
  empty,
  className,
}: TblProps<T>) {
  if (rows.length === 0 && empty !== undefined) {
    return <div className="empty">{empty}</div>
  }

  const table = (
    <table className={cx('tbl', className)}>
      <thead>
        <tr>
          {cols.map((c) => (
            <th
              key={c.key}
              className={cx(c.thCls ?? c.cls)}
              style={c.width === undefined ? undefined : { width: c.width }}
            >
              {c.title}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={rowKey(row, i)} className={rowCls?.(row, i)}>
            {cols.map((c) => (
              <td key={c.key} className={c.cls}>
                {c.render(row, i)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )

  if (!scroll) return table
  return <div className={cx('scroll', scroll === 'lg' && 'lg')}>{table}</div>
}
