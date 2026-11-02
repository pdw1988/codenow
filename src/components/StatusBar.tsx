/**
 * 缓存状态，PRD 6.7。两个形态：
 *
 * - `StatusBar`：竖排完整版，常驻左侧导航底部。
 * - `CacheTag`：一枚标签，挂在顶栏。窄窗口下 `_theme.css` 会把整条 rail
 *   压成 60px 并隐掉 railfoot，那时它是唯一还看得见的缓存状态 ——
 *   「我导的表到底进去了没有」不能因为窗口窄就没法回答。
 *
 * 运行环境（memory / local / sqlite）不在侧栏露字——用户只关心有几张表；
 * 细节挂在 CacheTag 的 title 里，悬停还能看见。
 */
import { Popconfirm } from 'antd'
import { COPY, LICENSE_ENABLED } from '../lib/license'
import { useSchemaStore } from '../store/useSchemaStore'
import { trialDaysLeft, useLicenseStore } from '../store/useLicenseStore'
import { isTauri } from '../storage'
import { Btn, Lbl, Row, Stack, Tag } from './ui'

const storeHint = (kind: string) =>
  kind === 'sqlite'
    ? '表结构持久化到 %AppData%\\com.pdw.devtools\\cache.db'
    : kind === 'local'
      ? '表结构存在浏览器的 localStorage 里，刷新不丢；换浏览器或清浏览器站点数据会丢'
      : isTauri()
        ? 'SQLite 初始化失败已降级：数据仅存内存，关闭即丢'
        : '数据仅存内存：localStorage 不可用（隐私模式？），关闭即丢'

/** 持久化的两种实现给绿标；纯内存才是黄色警告 */
const storeTone = (kind: string) => (kind === 'sqlite' || kind === 'local' ? 'ok' : 'wr')

export function CacheTag() {
  const status = useSchemaStore((s) => s.status)
  const storeKind = useSchemaStore((s) => s.storeKind)

  return (
    <Tag tone={storeTone(storeKind)} title={storeHint(storeKind)}>
      ⛁ {status?.tableCount ?? 0} 张表
    </Tag>
  )
}

/** 窄窗口 railfoot 会藏，顶栏靠这一枚还能点开升级卡 */
export function LicenseTag() {
  const isPro = useLicenseStore((s) => s.isPro)
  const openUpgrade = useLicenseStore((s) => s.openUpgrade)
  const left = useLicenseStore(trialDaysLeft)
  const to = useLicenseStore((s) => s.license?.to)
  if (!LICENSE_ENABLED) return null
  if (isPro) {
    return (
      <Tag tone="ok" onClick={openUpgrade} title={left === null ? COPY.statusPro(to) : COPY.statusTrial(left)}>
        {left === null ? '专业版' : `试用 ${left} 天`}
      </Tag>
    )
  }
  return (
    <Tag tone="hi" onClick={openUpgrade} title={COPY.statusFree}>
      免费版
    </Tag>
  )
}

export function StatusBar() {
  const status = useSchemaStore((s) => s.status)
  const reload = useSchemaStore((s) => s.reload)
  const clearCache = useSchemaStore((s) => s.clearCache)
  const isPro = useLicenseStore((s) => s.isPro)
  const openUpgrade = useLicenseStore((s) => s.openUpgrade)
  const left = useLicenseStore(trialDaysLeft)
  const to = useLicenseStore((s) => s.license?.to)
  const proText = left === null ? '专业版' : `试用 ${left} 天`
  const proTitle = left === null ? COPY.statusPro(to) : COPY.statusTrial(left)

  return (
    <Stack gap={5}>
      <Lbl>缓存状态</Lbl>

      <Row tight>
        <Tag tone="hi">{status?.tableCount ?? 0} 张表</Tag>
        {LICENSE_ENABLED && (
          <Tag tone={isPro ? 'ok' : 'hi'} onClick={openUpgrade} title={isPro ? proTitle : COPY.statusFree}>
            {isPro ? proText : '免费版'}
          </Tag>
        )}
      </Row>

      <Row tight>
        <Btn variant="mini" onClick={() => void reload()} title="重新从缓存库读一遍">
          ↻ 刷新
        </Btn>
        <Popconfirm
          title="清空全部表结构缓存？"
          description="导入的表和外键关系都会被删除，此操作不可撤销。"
          okText="确认清空"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => void clearCache()}
        >
          <Btn variant="mini" danger>
            ✕ 清空
          </Btn>
        </Popconfirm>
      </Row>
    </Stack>
  )
}
