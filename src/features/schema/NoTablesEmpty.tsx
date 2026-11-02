/**
 * 表结构缓存是空的。查看表结构、批量 INSERT/UPDATE、SQL 生成都靠这份缓存干活，
 * 空了统一引去「导入表结构」。
 */
import { TableOutlined } from '@ant-design/icons'
import { GuideEmpty } from '../../components/ui'
import { useUiStore } from '../../store/useUiStore'

export function NoTablesEmpty() {
  const setActiveTab = useUiStore((s) => s.setActiveTab)
  return (
    <GuideEmpty
      icon={<TableOutlined aria-hidden />}
      title="还没有表结构"
      desc="这一页按本机缓存的表结构干活，导入一次各页共用，不用连库。"
      steps={[
        '到「导入表结构」粘贴 Navicat / DataGrip 等导出的建表语句',
        '粘完会弹框问是否导入，点「导入」就写进本机缓存',
        '也可以在那页切到「扫描项目源码」，从实体类读出表结构',
      ]}
      action={{ label: '去导入表结构', onClick: () => setActiveTab('import') }}
    />
  )
}
