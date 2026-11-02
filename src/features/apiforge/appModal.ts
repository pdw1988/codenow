/**
 * context 版 modal 的实例类型（AntdApp.useApp() 里的那个 modal）。
 *
 * 静态 Modal.info / Modal.confirm 渲染时拿不到 ConfigProvider 的主题：深色皮肤下
 * 它照样画白底，而码上测的说明文案用的是主题变量（--txt 近白），白底白字看不见
 * ——实测就是「接口运行和数据库是什么关系」弹窗只剩几个强调词可读。所以码上测
 * 一律用组件里解构出来的 modal 实例（跟随应用明暗），非组件代码由调用方把实例
 * 传进来（message: MessageInstance 同一条参数链）。
 */
import type { App as AntdApp } from 'antd'

export type AppModal = ReturnType<typeof AntdApp.useApp>['modal']
