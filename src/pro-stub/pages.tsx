/** 专业页面的开源版占位：一张介绍卡 */
import { Band, Stack } from '../components/ui'
import type { LogFilter } from '../lib/log/filter'
import type { LogSource } from '../store/useLogStore'

function ProOnly({ what }: { what: string }) {
  return (
    <Stack gap={12}>
      <Band tone="warn" title={`${what}是专业版功能`}>
        开源版不含这部分代码。下载官方安装包可免费试用 7 天。
      </Band>
    </Stack>
  )
}

/** 开源版里日志页的「连服务器」按钮会先被许可闸拦下，这张卡只是兜底 */
export function SshPanel(_props: { onPulled: () => void }) {
  return <ProOnly what="连服务器拉日志" />
}

/** 多份按时间交错：开源版里切换按钮先被许可闸拦下，这张卡只是兜底 */
export function TimelineView(_props: { sources: LogSource[]; filter: LogFilter; onFilterText: (t: string) => void }) {
  return <ProOnly what="多份日志按时间交错" />
}

export function TermPage() {
  return <ProOnly what="SSH 终端" />
}

export function ApiforgePagesTab() {
  return <ProOnly what="页面测试" />
}

export function ApiforgeBenchTab() {
  return <ProOnly what="压测" />
}

export function ApiforgeScenarioTab() {
  return <ProOnly what="场景串联" />
}

export function ApiforgeDataTab() {
  return <ProOnly what="数据驱动" />
}
