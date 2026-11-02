/**
 * 应用外壳：`.app` 两列网格 = 左侧导航 + 主区。
 *
 * 所有功能页**同时挂着**，切走的用 `hidden` 藏起来而不是卸载：
 * 用户经常是「粘一半 DDL → 去速查确认表名 → 回来接着粘」，
 * 卸载等于把他填的东西删了。代价是 DOM 里有导航中每页各一份内容
 * （写 e2e 时找元素必须限定在当前 `.pagehost` 里，CLAUDE.md 有记）。
 * 注意挂载清单就是 PAGES——暂退的页连 pagehost 都不在 DOM 里，页面组件本身没删。
 */
import { useEffect } from 'react'
import { useThemeStore } from '../store/useThemeStore'
import { useUiStore, type TabKey } from '../store/useUiStore'
import { SchemaExplorer } from '../features/schema/SchemaExplorer'
import { SingleSqlPage } from '../features/sqlgen/SingleSqlPage'
import { MultiSqlPage } from '../features/sqlgen/MultiSqlPage'
import { S2uPanel } from '../features/s2u/S2uPanel'
import { BatchInsertPage } from '../features/batch/BatchInsertPage'
import { BatchUpdatePage } from '../features/batch/BatchUpdatePage'
import { FavPanel } from '../features/sqlfav/FavPanel'
import { LogFillPanel } from '../features/logfill/LogFillPanel'
import { ConfigPanel } from '../features/config/ConfigPanel'
import { ImportPanel } from '../features/importer/ImportPanel'
import { DbQueryPage } from '../features/importer/DbQueryPage'
import { AdviceLogPage } from '../features/importer/AdviceLogPage'
import { RedisPage } from '../features/redis/RedisPage'
import { DbConnsPage } from '../features/dbconns/DbConnsPage'
import { ApiforgePage } from '../features/apiforge/ApiforgePage'
import { LogViewPage } from '../features/logview/LogViewPage'
import { TermPage } from '@pro'
import { RegexTester } from '../features/tools/RegexTester'
import { JsonPathQuery } from '../features/tools/JsonPathQuery'
import { CronTool } from '../features/tools/CronTool'
import { VaultPage } from '../features/vault/VaultPage'
import { UpgradeDlg } from './license/UpgradeDlg'
import { UpdateDialogs } from './shell/UpdateButton'
import { cx } from './ui'
import { Hud } from './shell/Hud'
import { Page } from './shell/Page'
import { Rail } from './shell/Rail'
import { TitleBar } from './shell/TitleBar'
import { PAGES } from './shell/pages'

/**
 * 多表关联不跟其它页一起 keep-alive。
 * 切菜单再进来要是还留着上次的主表和 JOIN，看起来就是「点了菜单没刷新」。
 * 导入页仍然挂着不卸：粘一半 DDL 去速查对一下表名，回来还得在。
 */
function MultiSqlGate() {
  const n = useUiStore((s) => s.multiVisit)
  return <MultiSqlPage key={n} />
}

const VIEWS: Record<TabKey, React.ReactNode> = {
  import: <ImportPanel />,
  dbquery: <DbQueryPage />,
  redis: <RedisPage />,
  dbadvice: <AdviceLogPage />,
  dbconns: <DbConnsPage />,
  logfill: <LogFillPanel />,
  config: <ConfigPanel />,
  schema: <SchemaExplorer />,
  'sqlgen-single': <SingleSqlPage />,
  'sqlgen-multi': <MultiSqlGate />,
  s2u: <S2uPanel />,
  'batch-insert': <BatchInsertPage />,
  'batch-update': <BatchUpdatePage />,
  sqlfav: <FavPanel />,
  apiforge: <ApiforgePage />,
  // 这两页自己不套 Page，顶栏在这里补上；bare + fill 让工作区铺满剩余高度
  logview: (
    <Page tab="logview" bare fill>
      <LogViewPage />
    </Page>
  ),
  term: (
    <Page tab="term" bare fill>
      <TermPage />
    </Page>
  ),
  regex: <RegexTester />,
  jsonpath: <JsonPathQuery />,
  cron: <CronTool />,
  vault: <VaultPage />,
}

export function AppShell() {
  const activeTab = useUiStore((s) => s.activeTab)
  const dbConnected = useUiStore((s) => s.dbConnected)
  const termConnected = useUiStore((s) => s.termConnected)
  const dbqMax = activeTab === 'dbquery' && dbConnected
  const slim = dbqMax || (activeTab === 'term' && termConnected)
  const pickByIndex = useThemeStore((s) => s.pickByIndex)

  // 数字键换主题。输入框里打字时不能抢 —— 否则在字段长度里填个 1 就换皮了
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return
      if (pickByIndex(Number(e.key))) e.preventDefault()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [pickByIndex])

  return (
    <>
      <Hud />
      <TitleBar />
      <div className={cx('app', slim && 'rail-slim', dbqMax && 'dbq-max')}>
        <Rail />
        <main className="main">
          {PAGES.map((p) => (
            <div className="pagehost" key={p.key} hidden={p.key !== activeTab}>
              {VIEWS[p.key]}
            </div>
          ))}
        </main>
      </div>
      <UpgradeDlg />
      <UpdateDialogs />
    </>
  )
}
