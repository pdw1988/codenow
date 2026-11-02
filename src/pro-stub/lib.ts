/** 专业版函数的开源版占位：签名跟 pro/ 里一致，调用就报「专业版功能」 */
import type { MessageInstance } from 'antd/es/message/interface'
import type { AppModal } from '../features/apiforge/appModal'
import type { ApiMethod, ControllerInfo, EnvironmentConfig, ProjectScanResult, TestCase } from '../lib/apiforge/types'
import type { ApiDoc } from '../lib/apiforge/docs/docs'

const PRO_ONLY = '开源版不含这部分代码。下载官方安装包可免费试用 7 天。'

export const HAS_PRO = false

export type JavaSerResult = { ok: true; json: string; cls: string } | { ok: false; err: string }

export function parseJavaSer(_bytes: Uint8Array): JavaSerResult {
  return { ok: false, err: 'Java 序列化解析是专业版功能' }
}

export async function checkBrowser(message: MessageInstance, _showBrowser: boolean): Promise<void> {
  void message.warning('页面测试是专业版功能，开源版不含驱动浏览器的代码')
}

/** 压测事件接线：开源版没有压测，什么也不接 */
export function useBenchEvents(): void {}

export async function runApiCases(_api: ApiMethod, message: MessageInstance, _modal: AppModal): Promise<void> {
  void message.warning(`批量用例是专业版功能。${PRO_ONLY}`)
}

export async function runControllerCases(
  _project: ProjectScanResult,
  _controller: ControllerInfo,
  message: MessageInstance,
  _modal: AppModal,
): Promise<void> {
  void message.warning(`批量用例是专业版功能。${PRO_ONLY}`)
}

export async function runFullRegression(message: MessageInstance, _modal: AppModal): Promise<void> {
  void message.warning(`全自动回归是专业版功能。${PRO_ONLY}`)
}

export function docsToAiContext(_docs: ApiDoc[]): string {
  throw new Error(`AI 上下文导出是专业版功能。${PRO_ONLY}`)
}

/** 字段跟 pro/ 里的 JunitExport 一致，接口页按它取值 */
interface JunitExport {
  fileName: string
  className: string
  totalCases: number
  exportedCases: number
  skippedCases: number
  code: string
}

/** 返回 null 时接口页会提示「没有可导出的」，所以这里直接报专业版 */
export function junitForApi(
  _env: EnvironmentConfig,
  _api: ApiMethod,
  _cases: readonly TestCase[],
  _opts?: { packageName?: string; generatedAt?: string },
): JunitExport | null {
  throw new Error(`导出 JUnit 是专业版功能。${PRO_ONLY}`)
}
