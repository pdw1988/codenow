import { useEffect, useMemo } from 'react'
import { App as AntdApp, ConfigProvider, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { AppShell } from './components/AppShell'
import { useSchemaStore } from './store/useSchemaStore'
import { useTemplateStore } from './store/useTemplateStore'
import { useFavoriteStore } from './store/useFavoriteStore'
import { useDbConnStore } from './store/useDbConnStore'
import { useSqlAdviseStore } from './store/useSqlAdviseStore'
import { useLicenseStore } from './store/useLicenseStore'
import { useThemeDef } from './store/useThemeStore'

export default function App() {
  const init = useSchemaStore((s) => s.init)
  const loadTemplates = useTemplateStore((s) => s.reload)
  const loadFavorites = useFavoriteStore((s) => s.reload)
  const loadDbConns = useDbConnStore((s) => s.reload)
  const loadAdviceLog = useSqlAdviseStore((s) => s.reload)
  const hydrateLicense = useLicenseStore((s) => s.hydrate)
  const skin = useThemeDef()

  useEffect(() => {
    void init()
    // 模板 / 收藏跟表结构缓存互不依赖，并发加载；失败也不该拖住主流程
    void loadTemplates()
    void loadFavorites()
    void loadDbConns()
    void loadAdviceLog()
    void hydrateLicense()
  }, [init, loadTemplates, loadFavorites, loadDbConns, loadAdviceLog, hydrateLicense])

  /**
   * antd 只剩下浮层类组件在用（Modal / message / Tooltip / Popconfirm / 标签输入）。
   * 那些东西画在 body 上、不读我们的 CSS 变量，所以主题一换要把强调色喂给它一次
   * —— `colorPrimary` 必须是**真色值**，antd 拿它去推导一整条色阶，
   * 塞 `var(--acc)` 进去算出来的是一堆 NaN。
   */
  const config = useMemo(
    () => ({
      algorithm: skin.scheme === 'light' ? antdTheme.defaultAlgorithm : antdTheme.darkAlgorithm,
      token: { colorPrimary: skin.accent, borderRadius: 6, fontSize: 13 },
    }),
    [skin.accent, skin.scheme],
  )

  return (
    <ConfigProvider locale={zhCN} theme={config}>
      {/* AntdApp 提供 message/modal 的 context，避免静态方法拿不到主题。
          toast 挂到 body：Modal 也在 body 上 z-index 1000，留在 #root 里会被弹窗挡住。 */}
      <AntdApp message={{ getContainer: () => document.body }}>
        <AppShell />
      </AntdApp>
    </ConfigProvider>
  )
}
