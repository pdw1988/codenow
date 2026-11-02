/**
 * 连库查询的结果网格：钉表头、钉行号、单行省略、点列头排序、勾选行。
 * 列宽可拖。table-layout:fixed + colgroup，免得 200 列时浏览器把行号列挤成 0。
 * 只画视口附近的行：一万行全进 DOM 会把窗口卡死。
 * 内容估宽为底；视口变宽时把余量均分铺满。列多仍横滚，不挤缝。
 */
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent, type UIEvent } from 'react'
import { Cb, cx } from '../../components/ui'
import {
  GRID_CK_W,
  GRID_COL_MAX,
  GRID_COL_MIN,
  GRID_GUTTER,
  GRID_RN_W,
  GRID_ROW_H,
  defaultColWidth,
  defaultColWidths,
  expandColWidths,
  gridWindow,
  type GridSort,
} from '../../lib/queryGrid'

interface Props {
  columns: string[]
  rows: string[][]
  view: number[]
  selected: Set<number>
  sort: GridSort | null
  onSort: (col: number) => void
  onToggle: (index: number, on: boolean) => void
  onToggleView: (on: boolean) => void
  onCell: (row: number, col: number, name: string, value: string) => void
  active?: { row: number; col: number } | null
  /** 双击直接改格子。edit 为 null 表示没有格子处于编辑态 */
  edit?: { row: number; col: number } | null
  editVal?: string
  onEditStart?: (row: number, col: number, name: string, value: string) => void
  onEditChange?: (v: string) => void
  onEditCommit?: () => void
  onEditCancel?: () => void
}

const NUM = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/

function looksNum(rows: string[][], col: number): boolean {
  let n = 0
  let seen = 0
  for (const r of rows) {
    const v = (r[col] ?? '').trim()
    if (!v) continue
    seen++
    if (NUM.test(v)) n++
    if (seen >= 8) break
  }
  return seen > 0 && n === seen
}

export function QueryResultGrid({
  columns,
  rows,
  view,
  selected,
  sort,
  onSort,
  onToggle,
  onToggleView,
  onCell,
  active,
  edit = null,
  editVal = '',
  onEditStart,
  onEditChange,
  onEditCommit,
  onEditCancel,
}: Props) {
  const colKey = columns.join('\0')
  const [seen, setSeen] = useState(colKey)
  const [widths, setWidths] = useState(() => defaultColWidths(columns, rows))
  const lastFitW = useRef(0)
  if (seen !== colKey) {
    setSeen(colKey)
    setWidths(defaultColWidths(columns, rows))
  }
  // 换了列集就当没量过视口：渲染期不能写 ref（React Compiler 会跳过这个组件），
  // 挪到 effect 里赶在下一帧 sync 之前清零，语义不变
  useEffect(() => {
    lastFitW.current = 0
  }, [colKey])

  const wrapRef = useRef<HTMLDivElement>(null)
  const raf = useRef(0)
  const dragRef = useRef(false)
  const [win, setWin] = useState({ top: 0, h: 400, w: 0 })
  const [drag, setDrag] = useState(false)
  useEffect(() => {
    dragRef.current = drag
  }, [drag])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const sync = () => {
      const w = el.clientWidth
      setWin({ top: el.scrollTop, h: el.clientHeight, w })
      if (dragRef.current) return
      // 只在初次或视口变宽时补余量；拖窄后不要再摊回去
      if (lastFitW.current > 0 && w <= lastFitW.current) return
      setWidths((prev) => {
        const next = expandColWidths(prev, w)
        lastFitW.current = w
        return next.every((x, i) => x === prev[i]) ? prev : next
      })
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [view.length, columns.length, colKey])

  function onScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      setWin({ top: el.scrollTop, h: el.clientHeight, w: el.clientWidth })
    })
  }

  const slice = gridWindow({ scrollTop: win.top, viewH: win.h, n: view.length, rowH: GRID_ROW_H })
  const shown = view.slice(slice.start, slice.end)
  const span = columns.length + 2

  const allOn = view.length > 0 && view.every((i) => selected.has(i))
  const someOn = view.some((i) => selected.has(i))
  const numCols = columns.map((_, c) => looksNum(rows, c))
  const tableW = Math.max(GRID_GUTTER + widths.reduce((a, w) => a + w, 0), win.w)

  function startResize(col: number, e: ReactPointerEvent<HTMLElement>) {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = widths[col] ?? GRID_COL_MIN
    const move = (ev: globalThis.PointerEvent) => {
      const w = Math.min(GRID_COL_MAX, Math.max(GRID_COL_MIN, startW + ev.clientX - startX))
      setWidths((prev) => {
        if (prev[col] === w) return prev
        const next = prev.slice()
        next[col] = w
        return next
      })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(false)
    }
    setDrag(true)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function autoFit(col: number, e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    const sample = rows.slice(0, 80).map((r) => r[col] ?? '')
    const w = defaultColWidth(columns[col] ?? '', sample)
    setWidths((prev) => {
      if (prev[col] === w) return prev
      const next = prev.slice()
      next[col] = w
      return next
    })
  }

  return (
    <div ref={wrapRef} className={cx('qgrid-wrap', drag && 'dragging')} onScroll={onScroll}>
      <table className="qgrid" style={{ width: tableW }}>
        <colgroup>
          <col style={{ width: GRID_RN_W }} />
          <col style={{ width: GRID_CK_W }} />
          {widths.map((w, i) => (
            <col key={i} style={{ width: w }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="rn">#</th>
            <th className="ck">
              <Cb
                checked={allOn}
                indeterminate={someOn && !allOn}
                onChange={onToggleView}
                title="勾选可见行"
              />
            </th>
            {columns.map((name, c) => (
              <th
                key={c}
                className={`sorter${sort?.col === c ? ' on' : ''}${numCols[c] ? ' num' : ''}`}
                title={`${name} · 点列头排序 · 拖右边改宽度`}
                onClick={() => onSort(c)}
              >
                {name}
                {sort?.col === c ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                <i
                  className="col-resizer"
                  title="拖动改变列宽，双击按内容"
                  onPointerDown={(e) => startResize(c, e)}
                  onDoubleClick={(e) => autoFit(c, e)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {slice.padTop > 0 && (
            <tr className="qgrid-pad" aria-hidden>
              <td colSpan={span} style={{ height: slice.padTop }} />
            </tr>
          )}
          {shown.map((ri, j) => {
            const vis = slice.start + j
            const row = rows[ri]
            const on = selected.has(ri)
            return (
              <tr key={ri} className={cx(on && 'on', vis % 2 === 1 && 'alt')}>
                <td className="rn">{vis + 1}</td>
                <td className="ck">
                  <Cb checked={on} onChange={(v) => onToggle(ri, v)} title={`勾选第 ${vis + 1} 行`} />
                </td>
                {columns.map((name, c) => {
                  const raw = row[c] ?? ''
                  const empty = raw.trim() === ''
                  const editing = edit !== null && edit.row === ri && edit.col === c
                  const cls = [
                    numCols[c] ? 'num' : '',
                    empty ? 'null' : '',
                    active?.row === ri && active.col === c ? 'oncell' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')
                  return (
                    <td
                      key={c}
                      className={cx(cls || undefined, editing && 'editing')}
                      title={editing ? undefined : empty ? 'NULL' : raw}
                      onClick={() => {
                        if (editing) return
                        onCell(ri, c, name, raw)
                      }}
                      onDoubleClick={() => {
                        if (editing) return
                        onEditStart?.(ri, c, name, raw)
                      }}
                    >
                      {editing ? (
                        <input
                          className="cell-edit"
                          value={editVal}
                          autoFocus
                          onChange={(e) => onEditChange?.(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onDoubleClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              onEditCommit?.()
                            } else if (e.key === 'Escape') {
                              e.preventDefault()
                              onEditCancel?.()
                            }
                          }}
                          onBlur={() => onEditCancel?.()}
                        />
                      ) : (
                        (empty ? 'NULL' : raw)
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
          {slice.padBot > 0 && (
            <tr className="qgrid-pad" aria-hidden>
              <td colSpan={span} style={{ height: slice.padBot }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
