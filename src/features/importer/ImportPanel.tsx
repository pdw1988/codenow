/**
 * 表结构导入，PRD 第五章。粘贴建表语句 / 扫描项目源码。
 *
 * 连接数据库已拆成左侧独立菜单「连库查询」，不再做本页 Seg——
 * 埋在顶栏里点不到工作台，连上还得跟导入表抢同一屏。
 *
 * 来源切换在顶栏（`Page` 的 actions）而不是页面里嵌一层卡片 Tab。
 */
import { useState } from 'react'
import { Page } from '../../components/shell/Page'
import { Auto, Row, Seg } from '../../components/ui'
import { DdlImport } from './DdlImport'
import { SourceScan } from './SourceScan'

type Source = 'ddl' | 'project'

const SOURCES = [
  { value: 'ddl' as const, label: '粘贴建表语句' },
  { value: 'project' as const, label: '扫描项目源码', title: '只读本机目录' },
]

export function ImportPanel() {
  const [source, setSource] = useState<Source>('ddl')

  return (
    <Page
      tab="import"
      actions={
        <Row tight>
          {source === 'ddl' && <Auto>粘贴即预览</Auto>}
          <Seg options={SOURCES} value={source} onChange={setSource} />
        </Row>
      }
    >
      {source === 'ddl' && <DdlImport />}
      {source === 'project' && <SourceScan />}
    </Page>
  )
}
