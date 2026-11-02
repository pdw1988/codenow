/**
 * 编辑表结构弹窗，PRD 3.3 表卡片上的「编辑表结构」。
 *
 * 用途是修缓存里的元数据：DDL 里没写注释、或者解析出来的类型不对，
 * 改完直接影响后续生成的 SQL 和 Java 字段名。保存默认只写本机缓存。
 * 连着库时可以把增量 DDL 丢给当前连接（PRD 19.8）；现成的 ALTER 脚本走连库查询的 SQL 框。
 *
 * javaField / javaType 不给用户直接编辑，始终由字段名和类型推导 ——
 * 让它们能被单独改会立刻出现「字段名叫 user_id 但 javaField 是 orderNo」这种
 * 生成器无法自洽的状态。弹窗里也不再单独占一列：类型拆出「长度」之后
 * 注释被挤成一条缝，而 Java 映射两处字段表（连库查询、速查页）都不显示
 * 了（2026-09-22 用户拍板：不关心）。改名字时悬停字段名框仍能看到派生结果。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Column, Dialect, TableInfo } from '../../types/schema'
import { toCamelCase, toJavaType } from '../../lib/javaType'
import { isCharLenType, joinDbType, peelCharUnit, splitDbType } from '../../lib/dbType'
import { buildAlterDdl, diffColumns, hasChanges } from '../../lib/sqlgen/ddlAlter'
import { liveDialect } from '../../lib/dbDialect'
import { useUiStore } from '../../store/useUiStore'
import { DialectSeg } from '../../components/DialectPick'
import { ExecAlterOnConn } from './ExecAlterOnConn'
import { FavSqlBtn } from '../sqlfav/FavSqlBtn'
import {
  Band,
  Btn,
  Cb,
  Code,
  Dlg,
  Fld,
  Hint,
  Lbl,
  Row,
  Spacer,
  Tbl,
  type TblCol,
} from '../../components/ui'

/**
 * 类型列的常用类型清单（自研下拉，见下面 TypePick）。只列**基础类型词**，
 * 长度/精度拆到旁边的「长度」列单独填（DECIMAL 的精度写 `10,2`）。
 *
 * 缓存里存的是「用户原样写的类型文本」，各方言都可能，所以清单是混排的
 * 高频基础词，不是某一种方言的完整册子——它只是省打字的快捷方式，词表外
 * 的类型照样手输。
 */
const COMMON_TYPES = [
  // 整型（tinyint(1) 的 MySQL 布尔惯例：选 TINYINT 后长度框自己填 1）
  'BIGINT',
  'INT',
  'TINYINT',
  'SMALLINT',
  // 金额 / 小数（裸 NUMBER 是浮点，但在清单里留着——精度由长度框决定）
  'DECIMAL',
  'NUMBER',
  'DOUBLE',
  'FLOAT',
  // 字符串：MySQL 系 + Oracle 系
  'VARCHAR',
  'VARCHAR2',
  'NVARCHAR',
  'NVARCHAR2',
  'CHAR',
  // 时间
  'DATE',
  'DATETIME',
  'TIMESTAMP',
  'TIME',
  // 大字段与其他
  'TEXT',
  'LONGTEXT',
  'CLOB',
  'BLOB',
  'JSON',
  'BOOLEAN',
] as const

/**
 * 类型下拉：点 ▾ 弹出常用类型清单，点选即填；输入框本体照旧自由打字。
 *
 * 不用原生 <datalist> 的原因（真机踩过）：Edge 里它的箭头只在悬停时出现、
 * 点输入框本体不弹清单——用户看到的就是「下拉没反应」，入口根本不可发现。
 *
 * 弹层 portal 到 body 再 fixed：表格和弹窗体都有 overflow，absolute / 未 portal 的
 * fixed 都会被裁掉。定位不跟滚动，所以滚动 / 缩放时直接收起（反正点一下就能再开）。
 */
function TypePick({ value, onChange }: { value: string; onChange: (t: string) => void }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number }>({
    left: 0,
    width: 0,
  })
  const wrapRef = useRef<HTMLSpanElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // 开着的时候：点外面 / 滚动 / Esc 都收起。滚动监听挂捕获阶段——
  // 表格容器和弹窗体各自滚都得算；弹层自己内部的滚动要豁免，不然清单滚不了
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!popRef.current?.contains(t) && !wrapRef.current?.contains(t)) setOpen(false)
    }
    const onScroll = (e: Event) => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    const r = wrapRef.current?.getBoundingClientRect()
    if (!r) return
    // 视口下方放不下（清单最高 264px + 边距）就朝上弹
    setPos(
      window.innerHeight - r.bottom > 280
        ? { left: r.left, top: r.bottom + 3, width: r.width }
        : { left: r.left, bottom: window.innerHeight - r.top + 3, width: r.width },
    )
    setOpen(true)
  }

  return (
    <span className="typepick" ref={wrapRef}>
      <Fld
        className="mono"
        value={value}
        bad={!value.trim()}
        onChange={(e) => onChange(e.target.value)}
        aria-label="类型"
      />
      <button type="button" title="常用类型" onClick={toggle}>
        ▾
      </button>
      {open &&
        createPortal(
          <div
            className="typepick-pop"
            ref={popRef}
            style={{ left: pos.left, top: pos.top, bottom: pos.bottom, minWidth: pos.width }}
          >
            {COMMON_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  onChange(t)
                  setOpen(false)
                }}
              >
                {t}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  )
}

/** 行内维持一个稳定 id：字段名是可编辑的，不能拿它当 React key */
interface EditRow extends Column {
  rowId: number
  /** 类型两列编辑的中间态；type 始终由这几位 joinDbType 装回完整原文 */
  typeBase: string
  typeArgs: string
  /** Oracle VARCHAR2(100 CHAR) 的 CHAR/BYTE，长度框不显示 */
  typeUnit: '' | 'CHAR' | 'BYTE'
}

interface TableEditModalProps {
  table: TableInfo
  open: boolean
  onClose: () => void
  onSave: (table: TableInfo) => Promise<void> | void
}

const toRows = (columns: Column[]): EditRow[] =>
  columns.map((c, i) => {
    // splitDbType 返回 { base, args }，行上叫 typeBase / typeArgs：
    // 直接 ...spread 会把名字带错，TypePick 拿到 undefined 后 value.trim() 当场炸
    const { base, args, unit } = splitDbType(c.type)
    return { ...c, rowId: i, typeBase: base, typeArgs: args, typeUnit: unit }
  })

export function TableEditModal({ table, open, onClose, onSave }: TableEditModalProps) {
  const session = useUiStore((s) => s.dbSession)
  const [comment, setComment] = useState(table.comment ?? '')
  const [rows, setRows] = useState<EditRow[]>(() => toRows(table.columns))
  const [nextId, setNextId] = useState(table.columns.length)
  const [saving, setSaving] = useState(false)
  // 增量 DDL 的方言。打开时若已连库，跟当前连接对齐，免得人再改一次才执行
  const [alterDialect, setAlterDialect] = useState<Dialect>('oracle')
  const listRef = useRef<HTMLDivElement>(null)
  /** 点了「添加字段」才滚；打开弹窗重置 rows 不能跟着滚 */
  const pinNew = useRef(false)

  /**
   * 增量变更 = 当前编辑中的字段 vs 打开弹窗时的字段。存一份原样的 columns 就够：
   * 对照基准是「这次弹窗打开时的样子」，保存成功后弹窗关闭，下次打开基准自然刷新。
   * typeBase/typeArgs 是编辑态的拆装中间值，比对前剥掉——Column 里只有完整 type。
   */
  const diff = useMemo(
    () =>
      diffColumns(
        table.columns,
        rows.map(({ rowId: _rowId, typeBase: _base, typeArgs: _args, typeUnit: _unit, ...c }) => c),
      ),
    [table, rows],
  )
  const alterSql = useMemo(
    () => (hasChanges(diff) ? buildAlterDdl(table.name, diff, alterDialect) : ''),
    [table, diff, alterDialect],
  )

  // 每次打开都从当前表结构重置：上次改了一半没保存就关掉的内容不该再出现，
  // 用户看到自己没保存的旧改动会以为「保存过了」。渲染期校正，不用 useEffect
  const [seen, setSeen] = useState({ table, open })
  if (table !== seen.table || open !== seen.open) {
    setSeen({ table, open })
    if (open) {
      setComment(table.comment ?? '')
      setRows(toRows(table.columns))
      setNextId(table.columns.length)
      setAlterDialect(session?.kind ?? 'oracle')
    }
  }

  useEffect(() => {
    if (!pinNew.current) return
    pinNew.current = false
    const tr = listRef.current?.querySelector('tbody tr:last-child')
    tr?.scrollIntoView({ block: 'end' })
    const name = tr?.querySelector('input')
    if (name instanceof HTMLInputElement) name.focus()
  }, [rows])

  /** 改一列。名字或类型变了就重新推导 javaField / javaType */
  const patch = (rowId: number, changes: Partial<EditRow>) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.rowId !== rowId) return r
        const next = { ...r, ...changes }
        if (changes.name !== undefined) next.javaField = toCamelCase(next.name)
        if (
          changes.typeBase !== undefined ||
          changes.typeArgs !== undefined ||
          changes.typeUnit !== undefined
        ) {
          if (changes.typeArgs !== undefined) {
            const peeled = peelCharUnit(changes.typeArgs)
            next.typeArgs = peeled.args
            if (peeled.unit) next.typeUnit = peeled.unit
          }
          if (changes.typeBase !== undefined && !isCharLenType(next.typeBase)) next.typeUnit = ''
          next.type = joinDbType(next.typeBase, next.typeArgs, next.typeUnit)
          next.javaType = toJavaType(next.type)
        }
        return next
      }),
    )
  }

  const errors = useMemo(() => {
    const list: string[] = []
    const names = rows.map((r) => r.name.trim())

    if (!rows.length) list.push('至少要有一个字段')
    if (names.some((n) => !n)) list.push('有字段名是空的')

    const dup = names.filter((n, i) => n && names.indexOf(n) !== i)
    if (dup.length) list.push(`字段名重复：${[...new Set(dup)].join('、')}`)

    if (rows.some((r) => !r.type.trim())) list.push('有字段没填类型')

    const autos = rows.filter((r) => r.isAutoIncrement)
    if (autos.length > 1) list.push('只能有一个自增字段')
    if (autos.some((r) => !r.isPrimaryKey)) list.push('自增字段必须同时是主键')

    return list
  }, [rows])

  const editedTable = (): TableInfo => ({
    ...table,
    comment: comment.trim() || undefined,
    // 主键隐含 NOT NULL，这里统一归一化，免得生成器又要各自判一遍
    columns: rows.map(({ rowId: _rowId, typeBase: _base, typeArgs: _args, typeUnit: _unit, ...col }) => ({
      ...col,
      name: col.name.trim(),
      type: col.type.trim(),
      nullable: col.isPrimaryKey ? false : col.nullable,
      comment: col.comment?.trim() || undefined,
      defaultValue: col.defaultValue?.trim() || undefined,
    })),
    updatedAt: new Date().toISOString(),
  })

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(editedTable())
      onClose()
    } finally {
      setSaving(false)
    }
  }

  /** 库上 ALTER 成功后：优先重拉字典，读失败则把编辑态写入缓存 */
  const applyAfterAlter = async () => {
    const edited = editedTable()
    const spec = session ? liveDialect(session.kind) : undefined
    if (spec) {
      try {
        const cols = await spec.fetchColumns(table.name)
        await onSave({ ...edited, columns: cols })
        return
      } catch {
        // 库已经改了，字典读失败仍把编辑结果写入，避免速查/生成继续用旧列
      }
    }
    await onSave(edited)
  }

  const cols: Array<TblCol<EditRow>> = [
    {
      key: 'name',
      title: '字段名',
      width: 132,
      render: (r) => (
        <Fld
          className="mono"
          value={r.name}
          bad={!r.name.trim()}
          onChange={(e) => patch(r.rowId, { name: e.target.value })}
          aria-label="字段名"
          title={
            r.javaField
              ? `${r.javaType.split('.').pop()} ${r.javaField}`
              : undefined
          }
        />
      ),
    },
    {
      key: 'type',
      title: '类型',
      // 88 连 TIMESTAMP 都放不下；132 是设计稿 schema.html 的规格，
      // 减去 ▾ 按钮和内边距后输入框还有 ~90px，常用基础类型词都能完整显示
      width: 132,
      render: (r) => <TypePick value={r.typeBase} onChange={(t) => patch(r.rowId, { typeBase: t })} />,
    },
    {
      key: 'len',
      title: '长度',
      width: 64,
      render: (r) => (
        <Fld
          className="mono"
          value={r.typeArgs}
          placeholder="—"
          title={
            r.typeUnit
              ? `按 ${r.typeUnit} 计长，保存仍是 ${joinDbType(r.typeBase, r.typeArgs || '…', r.typeUnit)}`
              : '数字或 10,2'
          }
          onChange={(e) => patch(r.rowId, { typeArgs: e.target.value })}
          aria-label="长度"
        />
      ),
    },
    {
      key: 'pk',
      title: 'PK',
      width: 40,
      render: (r) => (
        <Cb
          checked={r.isPrimaryKey}
          onChange={(v) =>
            patch(r.rowId, {
              isPrimaryKey: v,
              isUnique: v ? false : r.isUnique,
              isIndexed: v ? false : r.isIndexed,
            })
          }
          title="主键"
        />
      ),
    },
    {
      key: 'uk',
      title: 'UK',
      width: 40,
      render: (r) => (
        <Cb
          checked={!!r.isUnique && !r.isPrimaryKey}
          disabled={r.isPrimaryKey}
          onChange={(v) => patch(r.rowId, { isUnique: v, isIndexed: v ? false : r.isIndexed })}
          title={r.isPrimaryKey ? '主键已经唯一，不必再标唯一索引' : '单列唯一索引'}
        />
      ),
    },
    {
      key: 'idx',
      title: 'IDX',
      width: 44,
      render: (r) => (
        <Cb
          checked={!!r.isIndexed && !r.isPrimaryKey && !r.isUnique}
          disabled={r.isPrimaryKey || !!r.isUnique}
          onChange={(v) => patch(r.rowId, { isIndexed: v })}
          title={
            r.isPrimaryKey || r.isUnique
              ? '主键 / 唯一键已经有索引，不必再标'
              : '单列普通索引（非唯一）'
          }
        />
      ),
    },
    {
      key: 'ai',
      title: '自增',
      width: 44,
      render: (r) => (
        <Cb
          checked={r.isAutoIncrement}
          onChange={(v) => patch(r.rowId, { isAutoIncrement: v })}
          title="自增"
        />
      ),
    },
    {
      key: 'null',
      title: '可空',
      width: 44,
      render: (r) => (
        <Cb
          checked={r.nullable && !r.isPrimaryKey}
          disabled={r.isPrimaryKey}
          onChange={(v) => patch(r.rowId, { nullable: v })}
          title={r.isPrimaryKey ? '主键隐含 NOT NULL' : '允许为空'}
        />
      ),
    },
    {
      key: 'def',
      title: '默认值',
      // 150 对齐设计稿：CURRENT_TIMESTAMP 这类惯用默认值要一眼看全
      width: 150,
      render: (r) => (
        <Fld
          className="mono"
          value={r.defaultValue ?? ''}
          placeholder="—"
          onChange={(e) => patch(r.rowId, { defaultValue: e.target.value })}
          aria-label="默认值"
        />
      ),
    },
    {
      key: 'cm',
      title: '注释',
      cls: 'cm',
      // 不设 width 会吞掉表格全部富余，类型列被挤到 88 还嫌不够——封顶 260，
      // 富余按列宽比例摊回各列；更长的注释在输入框里横向滚
      width: 260,
      render: (r) => (
        <Fld
          value={r.comment ?? ''}
          placeholder="字段含义"
          onChange={(e) => patch(r.rowId, { comment: e.target.value })}
          aria-label="注释"
        />
      ),
    },
    {
      key: 'del',
      title: '',
      width: 40,
      render: (r) => (
        <Btn
          variant="mini"
          danger
          title="删除此列"
          onClick={() => setRows((prev) => prev.filter((x) => x.rowId !== r.rowId))}
        >
          ✕
        </Btn>
      ),
    },
  ]

  return (
    <Dlg
      title={`编辑表结构 — ${table.name}`}
      open={open}
      onClose={onClose}
      width={1040}
      tall
      actions={
        <>
          <Btn
            variant="mini"
            onClick={() => {
              pinNew.current = true
              setRows((prev) => [
                ...prev,
                {
                  rowId: nextId,
                  name: '',
                  type: 'NVARCHAR2(50)',
                  typeBase: 'NVARCHAR2',
                  typeArgs: '50',
                  typeUnit: '',
                  nullable: true,
                  isPrimaryKey: false,
                  isAutoIncrement: false,
                  isUnique: false,
                  isIndexed: false,
                  javaField: '',
                  javaType: toJavaType('NVARCHAR2(50)'),
                },
              ])
              setNextId((n) => n + 1)
            }}
          >
            + 添加字段
          </Btn>
          <Spacer />
          <Hint>{rows.length} 个字段</Hint>
          <Btn onClick={onClose}>取消</Btn>
          <Btn variant="primary" disabled={errors.length > 0 || saving} onClick={() => void handleSave()}>
            {saving ? '保存中…' : '保存到缓存'}
          </Btn>
        </>
      }
    >
      <Band tone="info" title="保存只写入本机缓存。">
        连着库可以把下面的增量 DDL 丢给当前连接。手里已有现成的 ALTER 脚本，贴到连库查询的 SQL 框里运行。表名作为缓存键，不可更改。
      </Band>

      <Row>
        <Lbl>表注释</Lbl>
        <Fld
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="如：用户表"
          aria-label="表注释"
          className="grow"
        />
      </Row>

      {errors.length > 0 && (
        <Band tone="err" title="无法保存：">
          {errors.join('；')}
        </Band>
      )}

      <div ref={listRef} className="tedit-cols">
        <Tbl className="cols-fit" cols={cols} rows={rows} rowKey={(r) => String(r.rowId)} scroll="lg" />
      </div>

      {/* 增量 DDL：改一个字段这边就重算。很多时候用户只加一列，
          全量 CREATE TABLE 帮不上忙——表里已经有数据，重建不现实；
          连着库可以确认后丢给当前连接，没连上就复制去客户端。全量语句走卡片上的「导出 DDL」 */}
      <Row>
        <Lbl>增量 DDL</Lbl>
        <DialectSeg value={alterDialect} onChange={setAlterDialect} />
        <Hint>
          {diff.dropped.length > 0
            ? `删 ${diff.dropped.map((c) => c.name).join('、')} 会生成 DROP。执行后库上的列和数据一起没；只「保存到缓存」则不动库。`
            : '与打开弹窗时的字段比对。保存只写入缓存。'}
        </Hint>
      </Row>
      <Code
        code={alterSql}
        name={`ALTER_${table.name}.sql`}
        download={`ALTER_${table.name}.sql`}
        size="sm"
        empty="无字段变更，不生成 ALTER。"
        extra={
          <ExecAlterOnConn
            sql={alterSql}
            dialect={alterDialect}
            invalid={errors[0]}
            onApplied={applyAfterAlter}
            onDone={onClose}
          />
        }
        tools={<FavSqlBtn sql={alterSql} />}
      />
    </Dlg>
  )
}
