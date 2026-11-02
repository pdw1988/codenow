/**
 * 左侧导航栏。取代了原来横在顶上的 6 个 antd Tab。
 *
 * 换成竖排的理由不是好看：6 个 Tab 横排时标题被挤成 2~3 个字，
 * 而这 6 个功能的名字（「导入表结构」/「表结构速查」）恰恰是靠字数区分的。
 * 竖排还顺手腾出了顶栏，让每页能有自己的标题和副标题。
 *
 * 底下常驻缓存状态（PRD 6.7）—— 它必须一直看得见，
 * 因为「我导的表到底进去了没有」是这个工具最常被问的问题。
 *
 * 导航是一棵树：能合成一组的是一级（表结构 / 连库 / 生成 SQL），
 * 点一级进该组第一页。结构在 pages.ts 的 NAV。
 * 一级分组**可以收起**（「码上查」12 条全展开时，下面的「码上写」「码上测」
 * 被顶到要滚动才看得见），收起状态记进 localStorage —— 用户嫌菜单吵一次，
 * 不能下次启动又全摊开。
 */
import { useEffect, useRef, useState } from 'react'
import { HAS_PRO } from '@pro'
import { useUiStore, type TabKey } from '../../store/useUiStore'
import { cx, Stack } from '../ui'
import { NAV, pageMeta } from './pages'
import { StatusBar } from '../StatusBar'

function PageBtn({
  tab,
  nested,
}: {
  tab: TabKey
  nested?: boolean
}) {
  const activeTab = useUiStore((s) => s.activeTab)
  const setActiveTab = useUiStore((s) => s.setActiveTab)
  const p = pageMeta(tab)
  return (
    <button
      type="button"
      className={cx(nested && 'navsub', tab === activeTab && 'on')}
      title={`${p.label} · ${p.sub}`}
      aria-current={tab === activeTab ? 'page' : undefined}
      onClick={() => setActiveTab(tab)}
    >
      <em aria-hidden="true">
        <p.icon />
      </em>
      <span>{p.label}</span>
    </button>
  )
}

/** 收起了哪些一级分组（存 id 不存 label：改名字不该把用户的收起状态改丢） */
const FOLD_KEY = 'devtools.nav.folded.v1'

function loadFolded(): string[] {
  try {
    const raw = localStorage.getItem(FOLD_KEY)
    const v: unknown = raw ? JSON.parse(raw) : []
    // 手改过 / 旧版本写坏的值：只认字符串数组，否则整份作废
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function Rail() {
  const activeTab = useUiStore((s) => s.activeTab)
  const setActiveTab = useUiStore((s) => s.setActiveTab)
  const midRef = useRef<HTMLDivElement>(null)
  // 菜单真的溢出才挂底缘淡出遮罩：不溢出时遮罩会把最后一项（「小工具」组）淡成
  // 半截，看起来像被 railfoot 截断（1280×800 首屏就复现）
  const [canScroll, setCanScroll] = useState(false)

  useEffect(() => {
    const mid = midRef.current
    if (!mid) return
    // 直接量菜单内容被可视区裁掉多少，scrollHeight 不可信——它把
    // .nav 的纵向内边距也算进去，1280×800 时明明只裁了 1px 它报 15px，
    // 遮罩照样把底部 APIForge 淡成半截
    const check = () => {
      const nav = mid.querySelector('.nav')
      if (!nav) return
      const hidden = nav.getBoundingClientRect().bottom - mid.getBoundingClientRect().bottom
      setCanScroll(hidden > 8)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(mid)
    if (mid.firstElementChild) ro.observe(mid.firstElementChild)
    mid.addEventListener('scroll', check, { passive: true })
    return () => {
      ro.disconnect()
      mid.removeEventListener('scroll', check)
    }
  }, [])

  // 当前页滚进视口：菜单项被 railfoot 挡住时，至少切过去还能看见
  useEffect(() => {
    const mid = midRef.current
    if (!mid) return
    mid.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeTab])

  /*
   * 收起了哪些分组。**不跟着 activeTab 自动展开**：用户嫌「码上查」12 条吵才收的，
   * 从速查卡点「生成 SQL」跳过去就又把菜单摊开，等于这个开关时灵时不灵。
   * 收起后靠分组标题自己的 .on 高亮告诉人「你在这组里」（navtop 的 on 判定是
   * keys.includes(activeTab)，收起时照样亮）。
   */
  const [folded, setFolded] = useState<string[]>(loadFolded)
  useEffect(() => {
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify(folded))
    } catch {
      // 隐私模式下 localStorage 会抛：这一趟收不起只是记不住，菜单照常能收
    }
  }, [folded])

  return (
    <aside className="rail">
      <div className="brand">
        <div className="mark">⛁</div>
        <div>
          <b>码上 CodeNow</b>
          <span className="ver">Java 开发平台 · 码到成功</span>
        </div>
      </div>

      <div className={cx('rail-mid', canScroll && 'canscroll')} ref={midRef}>
        <h4>功能页</h4>
        <nav className="nav">
          {NAV.map((node) => {
            if (node.type === 'page') {
              return <PageBtn key={node.key} tab={node.key} />
            }
            const on = node.keys.includes(activeTab)
            const open = !folded.includes(node.id)
            return (
              <div key={node.id} className="navsec">
                {/* 折叠开关跟组标题并排，但绝对定位在右侧：挤进 flex 会让图标
                    不再居中，rail-slim（连库已连接，60px 图标栏）下尤其明显 */}
                <div className="navtoprow">
                  <button
                    type="button"
                    className={cx('navtop', on && 'on')}
                    title={`${node.label} · 点这里进第一项${open ? '' : '（已收起）'}`}
                    onClick={() => setActiveTab(node.keys[0]!)}
                  >
                    <em aria-hidden="true">
                      <node.icon />
                    </em>
                    <span>{node.label}</span>
                  </button>
                  <button
                    type="button"
                    className="navfold"
                    aria-expanded={open}
                    title={`${open ? '收起' : '展开'}「${node.label}」的 ${node.keys.length} 项`}
                    onClick={() =>
                      setFolded((prev) =>
                        prev.includes(node.id)
                          ? prev.filter((x) => x !== node.id)
                          : [...prev, node.id],
                      )
                    }
                  >
                    {open ? '▾' : '▸'}
                  </button>
                </div>
                {open &&
                  node.keys.map((k) => <PageBtn key={k} tab={k} nested />)}
              </div>
            )
          })}
        </nav>
      </div>

      <div className="railfoot">
        <Stack>
          {import.meta.env.DEV && HAS_PRO && (
            <a
              className="mini"
              href="/pro/license-admin.html"
              title="只在本机开发服务器有。安装包里没有这一页，私钥也不会进二进制。"
            >
              签发许可
            </a>
          )}
          <StatusBar />
        </Stack>
      </div>
    </aside>
  )
}
