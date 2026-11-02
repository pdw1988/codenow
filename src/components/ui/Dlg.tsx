/**
 * 弹窗。**整个项目里唯一直接用 antd Modal 的地方**。
 *
 * 浮层留给 antd 不是偷懒：焦点陷阱、Esc 关闭、滚动锁、portal 层级
 * 这几件事自己实现一次就是一堆边角 bug，而它们跟主题没关系。
 * 但里面的内容一律用我们自己的组件，所以外观还是跟着 `_theme.css` 走。
 *
 * 按钮排在 `.acts` 里而不是用 antd 的 footer：卡片脚和弹窗脚长得一样，
 * 用户不用在两种「这排按钮在哪」之间切换。
 */
import type { ReactNode } from 'react'
import { Modal } from 'antd'
import { Stack } from './bits'

interface DlgProps {
  title: ReactNode
  open: boolean
  onClose: () => void
  /** 底部那排按钮。主操作放最右边 */
  actions?: ReactNode
  width?: number
  /**
   * 贴顶并限制在视口内。编辑表结构这种长内容走这条：
   * antd 默认 top:100px，字段表 + 增量 DDL 会把底下裁出窗口。
   */
  tall?: boolean
  /**
   * 叠在已经打开的弹窗上面。编辑表结构里再确认执行走这条：
   * 内层 Modal 默认挂在外层里，外层 `.dlg-tall` 又 overflow:hidden，确认框直接被裁掉——点了像没点。
   */
  layer?: boolean
  children: ReactNode
}

export function Dlg({ title, open, onClose, actions, width = 880, tall, layer, children }: DlgProps) {
  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      footer={null}
      width={width}
      centered={tall ? false : undefined}
      className={tall ? 'dlg-tall' : undefined}
      classNames={tall ? { body: 'dlg-tall-body', container: 'dlg-tall-box' } : undefined}
      style={tall ? { top: 12, paddingBottom: 12 } : undefined}
      // 一律 portal 到 body。嵌在 `.code` / `.dlg-tall` 这种 overflow:hidden 里会把确认框裁没。
      getContainer={() => document.body}
      zIndex={layer ? 2000 : undefined}
      // antd 6 是 destroyOnHidden（v5 的 destroyOnClose 已改名）。
      // 关掉就卸载：六个页面同时挂着，再留一堆隐藏的大表格没必要
      destroyOnHidden
    >
      <Stack>{children}</Stack>
      {actions !== undefined && <div className="acts">{actions}</div>}
    </Modal>
  )
}
