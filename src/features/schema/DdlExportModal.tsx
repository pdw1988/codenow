/**
 * 导出 DDL 弹窗，PRD 3.3 表卡片上的「导出 DDL」。
 *
 * 方言可切：从 MySQL 库导出的表结构常常要在测试库上重建，
 * 类型翻译交给 lib/sqlgen/ddlExport。
 */
import { useMemo, useState } from 'react'
import type { Dialect, ForeignKey, TableInfo } from '../../types/schema'
import { exportDdl } from '../../lib/sqlgen/ddlExport'
import { DialectSeg } from '../../components/DialectPick'
import { Cb, Code, Dlg, Hint, Lbl, Row } from '../../components/ui'
import { FavSqlBtn } from '../sqlfav/FavSqlBtn'

interface DdlExportModalProps {
  table: TableInfo
  foreignKeys: ForeignKey[]
  open: boolean
  onClose: () => void
}

export function DdlExportModal({ table, foreignKeys, open, onClose }: DdlExportModalProps) {
  const [dialect, setDialect] = useState<Dialect>('oracle')
  const [withDrop, setWithDrop] = useState(false)

  const ddl = useMemo(
    () => exportDdl(table, { dialect, foreignKeys, withDrop }),
    [table, dialect, foreignKeys, withDrop],
  )

  return (
    <Dlg title={`导出 DDL — ${table.name}`} open={open} onClose={onClose} width={900}>
      <Row>
        <Lbl>方言</Lbl>
        <DialectSeg value={dialect} onChange={setDialect} />
        <Cb checked={withDrop} onChange={setWithDrop}>
          带 DROP TABLE
        </Cb>
      </Row>

      <Hint>仅输出 FOREIGN KEY 约束。命名推断不写入 DDL。</Hint>

      <Code
        code={ddl}
        name={`${table.name}.sql`}
        download={`${table.name}.sql`}
        size="lg"
        tools={<FavSqlBtn sql={ddl} />}
      />
    </Dlg>
  )
}
