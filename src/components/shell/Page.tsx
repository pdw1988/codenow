/**
 * 一页的骨架：顶栏（标题 + 副标题 + 动作 + 缓存状态 + 主题切换）+ 可滚动的内容区。
 *
 * 六个功能页都套它，所以「顶栏长什么样」只有一处定义。标题和副标题不从 props 传，
 * 只传 `tab` ——文案在 `pages.ts` 里跟左侧导航共用一份，改名不可能只改一半。
 *
 * `.pane` 是唯一滚动的容器（`_theme.css` 里 body 是 overflow:hidden）。
 * 所以顶栏和左侧导航永远在，长表格滚的是中间那块。
 *
 * 连库查询已连接时收起顶栏（`page-max`）：工作台要吃满一屏，结果底栏才露得出。
 * 外层必须有 `.page` 壳 —— Fragment 不能挂 class，最大化样式也没依附。
 */
import type { ReactNode } from 'react'
import type { TabKey } from '../../store/useUiStore'
import { useUiStore } from '../../store/useUiStore'
import { cx, Sep } from '../ui'
import { LICENSE_ENABLED } from '../../lib/license'
import { CacheTag, LicenseTag } from '../StatusBar'
import { pageMeta } from './pages'
import { ThemePicker } from './ThemePicker'
import { UpdateButton, UpdatePill } from './UpdateButton'

interface PageProps {
  tab: TabKey
  /** 顶栏右侧：`.auto` 徽标、页面级的分段切换等 */
  actions?: ReactNode
  /**
   * 直接铺在 `.pane` 里、`.pane-in` 之前的东西。
   * 速查页的大搜索框用它 —— 那个框要贴着顶栏、通栏，不受 `.pane-in` 的边距约束。
   */
  hero?: ReactNode
  /** 贴在顶栏和内容区之间的通栏（日志转SQL 的会话条）。不随 `.pane` 滚 */
  banner?: ReactNode
  /** 贴底的输入坞（日志转SQL 的输入框）。在 `.pane` 之后，同样不滚 */
  dock?: ReactNode
  /**
   * 不套 `.pane-in` 内边距容器。对话流自己控制宽度（1020px 窄栏），
   * 套上 1360px 的通用容器再往里缩，等于两层 max-width 打架。
   */
  bare?: boolean
  /**
   * 内容铺满剩余视口、`.pane` 自己不滚。连库查询工作台用：
   * 左表右网格要占满一屏，不能再套 1360 限宽再往下滚。
   */
  fill?: boolean
  children: ReactNode
}

export function Page({ tab, actions, hero, banner, dock, bare, fill, children }: PageProps) {
  const meta = pageMeta(tab)
  const Icon = meta.icon
  const dbConnected = useUiStore((s) => s.dbConnected)
  // 只收连库工作台：未连接的表单还要顶栏辨认页面
  const max = Boolean(fill && tab === 'dbquery' && dbConnected)

  // APIForge 页锁原型皮肤（深海界面），不跟全局浅色主题走——
  // 跟原型「出句浅色壳 + 模块内整块暗色 app」同一套分界。
  const apf = tab === 'apiforge'

  return (
    <div className={cx('page', max && 'page-max', apf && 'page-apf')}>
      {!max && (
        <div className="top">
          <div>
            {/* 图标单独渲染（不再拼在标题字符串里）：跟着主题 currentColor 走，
                emoji 那套系统配色跟任何主题都不搭。文字再包一层 .title-tx：
                background-clip:text 的渐变字一旦和图标子元素同框，裁剪会失效
                渲染成深色（码上测顶栏踩过），所以渐变只准套在纯文字层上 */}
            <div className="title-row">
              <div className="title">
                <em className="title-ic" aria-hidden="true">
                  <Icon />
                </em>
                <span className="title-tx">{meta.title}</span>
              </div>
              <UpdatePill />
            </div>
            <div className="sub">{meta.sub}</div>
          </div>
          {/* 右侧整组进一个 div：直接平铺时 `.top` 的 flex-wrap 会把掉下去的那一项
              单独放到第二行行首（margin-left:auto 是上一行的事，管不到第二行），
              于是 ThemePicker 贴在标题底下、左对齐。包成一组之后，要么一行全放下，
              要么整组换行且靠右 —— 页头高度也就不再忽高忽低。 */}
          <div className="top-right">
            {actions}
            <Sep />
            <CacheTag />
            {LICENSE_ENABLED && (
              <>
                <Sep />
                <LicenseTag />
              </>
            )}
            <Sep />
            <UpdateButton />
            <Sep />
            <ThemePicker />
          </div>
        </div>
      )}

      {banner}

      <div className={cx('pane', fill && 'dbq-pane')}>
        {hero}
        {bare ? (
          children
        ) : (
          <div className={cx('pane-in', fill && 'dbq-in')}>{children}</div>
        )}
      </div>

      {dock}
    </div>
  )
}
