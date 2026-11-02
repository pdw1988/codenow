/**
 * 多表关联的编辑面板：关联由用户自己挑，不靠外键推断。
 *
 * 原来的 RelationPanel 是「系统按外键/命名猜出候选，用户勾选确认」，
 * 换成本面板的原因有两个：
 *   1. 候选来自缓存里的外键——没导过外键、或外键没导进来，多表就整个不可用
 *      （旧页为此还写了「没关联就退回单表」的兜底）。自己挑表就没这个前提。
 *   2. 用户心里想的是「把 order 和 user 用 user_id 连起来」，不是
 *      「在这堆猜测里选一个」——让他直接说出来，比让他猜我们要他确认什么短。
 *
 * JOIN 类型只给 LEFT / INNER（原型同款）：从表可能没有匹配记录时用 LEFT，
 * 否则主表记录会被过滤掉；RIGHT JOIN 在「主表 LEFT 从表」的世界里没有正着用
 * 的场景，摆出来只是多一个能选错的选项。
 *
 * 选表走 TablePick（打开就能打字筛）。字段仍用 PopSel：Windows 上原生 select
 * 跟控件等宽，长名字裁成半截；卡片 overflow + backdrop-filter 还会切清单。
 */
import type { JoinType, TableInfo } from '../../types/schema'
import { TablePick } from '../../components/TablePick'
import { Btn, EmptyBox, Hint, Lbl, PopSel, Seg, Stack } from '../../components/ui'
import { sortColumnsForUi } from '../../lib/columnOrder'
import { newJoinId } from './joinId'

export interface JoinRow {
  id: string
  fromTable: string
  fromColumn: string
  toTable: string
  toColumn: string
  joinType: JoinType
}

const JOIN_OPTIONS = [
  { value: 'LEFT', label: 'LEFT' },
  { value: 'INNER', label: 'INNER' },
] as const

interface Props {
  rows: JoinRow[]
  onChange: (rows: JoinRow[]) => void
  tables: TableInfo[]
  /** 主表名。新增一行时左表默认选它——多数 JOIN 都是从主表连出去 */
  mainName?: string
}

export function JoinEditor({ rows, onChange, tables, mainName }: Props) {
  const columnsOf = (name: string) => {
    const t = tables.find((x) => x.name === name)
    return t ? sortColumnsForUi(t.columns).map((c) => c.name) : []
  }

  const colOptions = (name: string) =>
    columnsOf(name).map((c) => ({ value: c, label: c }))

  const patch = (id: string, next: Partial<JoinRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...next } : r)))

  /** 换表要顺带换字段：两张表的字段不一样，留着上一个表的字段名是错的 */
  const pickTable = (id: string, side: 'from' | 'to', table: string) =>
    patch(
      id,
      side === 'from'
        ? { fromTable: table, fromColumn: columnsOf(table)[0] ?? '' }
        : { toTable: table, toColumn: columnsOf(table)[0] ?? '' },
    )

  const add = () =>
    onChange([
      ...rows,
      {
        id: newJoinId(),
        fromTable: mainName ?? '',
        fromColumn: columnsOf(mainName ?? '')[0] ?? '',
        toTable: '',
        toColumn: '',
        joinType: 'LEFT',
      },
    ])

  return (
    <Stack>
      {rows.length === 0 ? (
        <EmptyBox>尚未添加关联。使用下方「添加关联」指定连接表与字段。</EmptyBox>
      ) : (
        rows.map((r) => {
          const incomplete = !r.fromTable || !r.fromColumn || !r.toTable || !r.toColumn
          return (
            <div className="rel joinrow" key={r.id}>
              <div className="joinpair">
                <Lbl>左表</Lbl>
                <TablePick
                  tables={tables}
                  value={r.fromTable}
                  onChange={(v) => pickTable(r.id, 'from', v)}
                  allowEmpty
                  placeholder="请选择"
                  aria-label="左表"
                />
                <span className="fk">.</span>
                <PopSel
                  value={r.fromColumn}
                  onChange={(v) => patch(r.id, { fromColumn: v })}
                  options={colOptions(r.fromTable)}
                  placeholder={r.fromTable ? '请选择字段' : '请先选表'}
                  disabled={!r.fromTable}
                  searchAt={8}
                  aria-label="左表字段"
                />
              </div>
              <div className="joinpair">
                <Lbl>右表</Lbl>
                <TablePick
                  tables={tables}
                  value={r.toTable}
                  onChange={(v) => pickTable(r.id, 'to', v)}
                  allowEmpty
                  placeholder="请选择"
                  aria-label="右表"
                />
                <span className="fk">.</span>
                <PopSel
                  value={r.toColumn}
                  onChange={(v) => patch(r.id, { toColumn: v })}
                  options={colOptions(r.toTable)}
                  placeholder={r.toTable ? '请选择字段' : '请先选表'}
                  disabled={!r.toTable}
                  aria-label="右表字段"
                />
              </div>
              <div className="joinacts">
                <Lbl>JOIN</Lbl>
                <Seg<JoinType>
                  options={JOIN_OPTIONS}
                  value={r.joinType}
                  onChange={(joinType) => patch(r.id, { joinType })}
                />
                <Btn
                  variant="mini"
                  danger
                  title="删除此关联"
                  onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
                >
                  删
                </Btn>
              </div>
              {incomplete && <Hint>表与字段均选定后，该条才参与生成</Hint>}
            </div>
          )
        })
      )}

      <Btn variant="mini" onClick={add}>
        + 添加关联
      </Btn>

      <Hint>
        每条指定一对等值连接。JOIN 顺序由生成器排列；与主表不连通的关联将排除并在结果区提示。
      </Hint>
    </Stack>
  )
}
