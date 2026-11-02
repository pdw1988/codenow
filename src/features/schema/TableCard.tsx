/**
 * 单张表的结果卡片，对应 PRD 3.3 的一个 📋 表块。
 *
 * 整张卡可折叠：折叠态只留表名/注释/命中原因/字段数，展开才是字段表和外键。
 * 搜出 20 张表全展开的话，用户还得自己滚回去找第一名。
 *
 * 展开状态由速查页持有（`open`/`onToggle`），不是自己 useState ——
 * 「换了关键字之后第一名自动展开」这条规则只有列表那一层看得见。
 */
import { useState } from 'react'
import { App } from 'antd'
import { TableOutlined, FileTextOutlined, DownloadOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import { dbKindOf } from '../../types/dbconn'
import type { MatchReason, SearchHit, TableInfo } from '../../types/schema'
import { describeReason } from '../../lib/search'
import { DEFAULT_DB_KIND } from '../../lib/dbDialect'
import { lastConnForKind } from '../../lib/dbLive'
import { previewSql } from '../../lib/sqlReadonly'
import { useSchemaStore, useTableForeignKeys } from '../../store/useSchemaStore'
import { useDbConnStore } from '../../store/useDbConnStore'
import { useDbPassStore } from '../../store/useDbPassStore'
import { useUiStore } from '../../store/useUiStore'
import { pageInNav } from '../../components/shell/pages'
import { Hit } from '../../components/Hit'
import { Btn, Card, Dlg, Hint, Row, Spacer, Tag } from '../../components/ui'
import { ColumnTable } from './ColumnTable'
import { ForeignKeyList } from './ForeignKeyList'
import { DdlExportModal } from './DdlExportModal'
import { TableEditModal } from './TableEditModal'

/** 来源，跟状态栏的说法保持一致。DDL 导入是当前唯一实测过的路径，标 hi */
const SOURCE: Record<string, { label: string; hi: boolean }> = {
  sql: { label: 'DDL 导入', hi: true },
  db: { label: '数据库读取', hi: false },
  project: { label: '源码扫描', hi: false },
}

/**
 * 哪些命中原因值得高亮。
 * 「表名匹配」「字段命中」这类到处都会命中，全部高亮等于没有高亮 ——
 * 只有强证据（全等、注释命中）才配那一点颜色。
 */
const STRONG: ReadonlySet<MatchReason['kind']> = new Set(['tableExact', 'tableComment', 'javaClass'])

interface TableCardProps {
  hit: SearchHit
  /** 搜索关键字，传给表名/注释/字段名做高亮 */
  kw?: string
  /** 不传 onToggle 就是常开的详情卡（左列表右详情布局用） */
  open?: boolean
  onToggle?: (open: boolean) => void
}

export function TableCard({ hit, kw, open, onToggle }: TableCardProps) {
  const { table, reasons } = hit
  const { outgoing, incoming } = useTableForeignKeys(table.name)
  const jumpToSqlGen = useUiStore((s) => s.jumpToSqlGen)
  const jumpToDbQuery = useUiStore((s) => s.jumpToDbQuery)
  const dbSession = useUiStore((s) => s.dbSession)
  const peekPass = useDbPassStore((s) => s.peek)
  const importTables = useSchemaStore((s) => s.importTables)
  const deleteTable = useSchemaStore((s) => s.deleteTable)
  const { message } = App.useApp()
  const [modal, setModal] = useState<'ddl' | 'edit' | 'del' | null>(null)
  const [deleting, setDeleting] = useState(false)

  /**
   * 跳生成器时把外键对面的表一起带过去。单表页拿它提示「这张表还有 N 条关联，
   * 要 JOIN 去多表页」，但不自动切过去——JOIN 查询是另一种产物，
   * 替用户决定反而容易迷路。
   */
  const handleGenerate = () => {
    const relatedTables = [
      ...new Set([...outgoing.map((fk) => fk.toTable), ...incoming.map((fk) => fk.fromTable)]),
    ]
    jumpToSqlGen({ tableName: table.name, relatedTables })
  }

  /**
   * 到连库查询查这张表的数据。已连库用当前方言拼 SELECT *；
   * 没连上带最近同方言连接（有密码会自动连），否则进连库页让用户填。
   * 方言优先：当前会话 → 最近一条收藏/历史连接 → 默认 Oracle。
   */
  const handleQueryData = () => {
    const recent = useDbConnStore.getState().items[0]
    const kind = dbSession?.kind ?? (recent ? dbKindOf(recent.kind) : DEFAULT_DB_KIND)
    const live = lastConnForKind(kind) ?? recent ?? null
    jumpToDbQuery({
      conn: live ?? undefined,
      password: live ? peekPass(live) || undefined : undefined,
      sql: previewSql(kind, table.name),
      table: table.name,
    })
  }

  /** 编辑后按表名覆盖回缓存；外键不在这里改，传空数组不会删掉已有的 */
  const handleSaveEdit = (edited: TableInfo) => importTables([edited], [])

  /** bug10：删除要二次确认——缓存里删了就只能重新导一份回来 */
  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteTable(table.name)
      message.success(`已删除 ${table.name}，相关外键已清除`)
    } catch (err) {
      message.error(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setDeleting(false)
      setModal(null)
    }
  }

  const source = SOURCE[table.source]

  return (
    <Card
      open={open}
      onToggle={onToggle}
      title={
        <>
          <span className="tn">
            <TableOutlined aria-hidden="true" /> <Hit text={table.name} kw={kw} />
          </span>{' '}
          {table.comment && (
            <span className="cm">
              <Hit text={table.comment} kw={kw} />
            </span>
          )}
        </>
      }
      extra={
        <Row tight>
          {reasons.map((reason) => (
            <Tag key={reason.kind} tone={STRONG.has(reason.kind) ? 'hi' : undefined}>
              {describeReason(reason)}
            </Tag>
          ))}
          <Tag>{table.columns.length} 字段</Tag>
          {table.javaClass && <Tag>{table.javaClass}.java</Tag>}
          <Tag tone={source?.hi ? 'hi' : undefined}>{source?.label ?? table.source}</Tag>
          {/* 什么时候进来的缓存：多张同名/相似表分不清新旧时靠它辨（悬停看完整时间戳） */}
          {table.createdAt && <Tag title={`导入时间：${table.createdAt}`}>导入 {table.createdAt.slice(0, 10)}</Tag>}
        </Row>
      }
      actions={
        <>
          {/* 入口按钮跟着导航走：SQL 生成拆成单表 / 多表两页后，这里统一进单表页
              （JOIN 要用户自己点菜单过去）。页不在导航里时按钮必须跟着藏——
              不藏的话点了是把主区切到空白页，比点不动更让人困惑 */}
          {pageInNav('sqlgen-single') && (
            <Btn variant="ghost" onClick={handleGenerate}>
              <FileTextOutlined aria-hidden="true" /> 生成 SQL
            </Btn>
          )}
          <Btn variant="ghost" onClick={() => setModal('ddl')}>
            <DownloadOutlined aria-hidden="true" /> 导出 DDL
          </Btn>
          <Btn variant="ghost" onClick={() => setModal('edit')}>
            <EditOutlined aria-hidden="true" /> 编辑表结构
          </Btn>
          {pageInNav('dbquery') && (
            <Btn variant="ghost" title="到连库查询查这张表的数据" onClick={handleQueryData}>
              ▦ 数据查询
            </Btn>
          )}
          <Btn variant="ghost" danger onClick={() => setModal('del')}>
            <DeleteOutlined aria-hidden="true" /> 删除
          </Btn>
          {onToggle && (
            <>
              <Spacer />
              <Hint>点击标题可折叠</Hint>
            </>
          )}
        </>
      }
    >
      <ColumnTable columns={table.columns} kw={kw} hide={new Set(['java'] as const)} />
      <ForeignKeyList outgoing={outgoing} incoming={incoming} />

      {/* 弹窗挂在卡片里：它要的 table/外键就在手边，提到页面那一层反而要多传一路 props */}
      <DdlExportModal
        table={table}
        foreignKeys={outgoing}
        open={modal === 'ddl'}
        onClose={() => setModal(null)}
      />
      <TableEditModal
        table={table}
        open={modal === 'edit'}
        onClose={() => setModal(null)}
        onSave={handleSaveEdit}
      />
      <Dlg
        title="删除表结构？"
        open={modal === 'del'}
        onClose={() => setModal(null)}
        width={480}
        actions={
          <>
            <Btn onClick={() => setModal(null)}>取消</Btn>
            <Btn variant="primary" danger disabled={deleting} onClick={() => void handleDelete()}>
              {deleting ? '删除中…' : '确认删除'}
            </Btn>
          </>
        }
      >
        <span>
          将从缓存删除 <b>{table.name}</b>（{table.comment ?? '无注释'}），共 {table.columns.length}{' '}
          个字段。
          {outgoing.length + incoming.length > 0 && (
            <> 与它相关的 {outgoing.length + incoming.length} 条外键关系会一并清掉。</>
          )}
          删除后可用同一段 DDL 重新导入。模板与收藏不受影响。
        </span>
      </Dlg>
    </Card>
  )
}
