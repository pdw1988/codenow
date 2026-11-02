/**
 * 免费 / 专业版闸门。页面只问布尔值，不自己数表、不自己拼升级文案。
 *
 * 验签在 Rust（Ed25519 公钥），前端没有私钥。签发：`npx tsx pro/scripts/issue-license.mjs`。
 * 只有能力闸，没有容量闸：表、收藏、模板都不限量（开源基础版不留上限）。
 */

/**
 * 手拨闸门。`null` = 跟环境走（`pnpm dev` / `tauri:dev` 关，打包开）；
 * `true` 强制开（开发时要验升级卡就改这个）；`false` 强制关（安装包也不锁）。
 * 注意：release 包里 Rust 侧还有一道门（pro/src-tauri/license_guard.rs），这里改 false 拦不住那边。
 */
const LICENSE_OVERRIDE: boolean | null = null

function runningViteDev(): boolean {
  const meta = import.meta as ImportMeta & { env?: { DEV?: boolean } }
  return meta.env?.DEV === true
}

/** 闸门是否生效。false 时全部按专业版放行，升级卡不出现。 */
export const LICENSE_ENABLED = LICENSE_OVERRIDE ?? !runningViteDev()

export const PRO_PRICE = '199 元 · 终身'

export type LicensePayload = {
  v: 1
  kind: 'pro'
  forever?: boolean
  /** YYYY-MM-DD，当天结束仍有效 */
  until?: string
  /** 签发时写进码里的买家称呼（防转发：界面显示「授权给 xxx」）；老码没有 */
  to?: string | null
}

export type License = LicensePayload & { code: string }

/** 软件内试用：升级卡点「免费试用」起算，每台机器一轮（Rust license_trial） */
export type Trial = {
  started: boolean
  active: boolean
  remaining_days: number
  total_days: number
  clock_tampered: boolean
}

export const COPY = {
  statusFree: '免费版 · 专业版加拉服务器日志、SSH 终端、批量回归等',
  statusPro: (to?: string | null) => (to ? `专业版 · 授权给 ${to}` : '专业版'),
  statusTrial: (days: number) => `试用中，还剩 ${days} 天 · 到期回免费版，数据不丢`,
  payHint: '个人专业版 199 元 · 终身（当前设备）。要买：加微信 pdwcloud88，转账后把订单号发给这个号，回一行许可码，粘在下方即生效。许可只在本机校验，不上传表结构。',
} as const

/* ===== 码上测（APIForge）付费点：能力闸，不是容量闸 =====
 * 免费保留：扫描 / 浏览 / MD·HTML·OpenAPI 导出 / 单接口「▶发送」冒烟。
 * 上锁三个 GUI 入口：AI 上下文整包导出、AI 造用例、批量用例（单API全用例 /
 * 全自动回归 / Controller 回归）。
 * 「AI 造用例」**没有接大模型，也不会接**：造值走本地确定性词表
 * （`lib/sqlgen/mockValue.ts`，按字段名/注释出手机号/邮箱/金额这类合法值），
 * 造数走 `lib/apiforge/data/prepare.ts` 的外键逆序造数 + 逆序清理。
 * 理由跟 `mockup/logfill-chat.html` 那句一样——大模型是「大概率对」，而这个
 * 功能错了不报错，只会让你把假失败当成接口挂了。这句话留着是为了别让下一轮
 * 的人照着一句过时注释去接模型。
 * CI 无头回归（apiforge run）不问这个 store——CLI 是 Node 进程，验签在 pro/cli/license.ts
 * （同一枚 Ed25519 公钥，升级卡里买的码原样可用）。
 * 现在都是纯能力布尔；将来改容量闸（限接口数 / 限用例数）就改这里加参数，页面照旧只问布尔值。 */
export const canAiContextExport = (isPro: boolean): boolean => isPro
export const canBatchCases = (isPro: boolean): boolean => isPro
/** 页面测试整个是专业版（单页也算）：手册、官网、升级弹窗都这么写，开源版没有这一页 */
export const canPageTest = (isPro: boolean): boolean => isPro

/* ===== 码上追（日志查看）付费点 =====
 * 免费保留：本机日志文件查看（拉新的功能——下载 log 的痛点人人都懂）。
 * 上锁「连服务器拉日志」：会往用户的 ssh 配置体系里走真服务器，属于团队
 * 排障场景，跟码上测的批量回归同价位档。 */
export const canSshLogs = (isPro: boolean): boolean => isPro

/* ===== 码上连（SSH 终端）付费点 =====
 * 与「连服务器拉日志」同一档：往真服务器开交互会话，团队排障场景。
 * 凭据库 / 名册复用同一套，但这是独立功能页，闸门单独立一个布尔。 */
export const canSshShell = (isPro: boolean): boolean => isPro

/* ===== Redis 付费点 =====
 * 免费：单机 / 哨兵 / 集群、看键改值、命令窗口、gzip 解压、大键提示、按前缀批量删。
 * 专业：Java 序列化解析、走跳板机。哨兵/集群和单机代码缠在一起，拆不进 pro/，所以放免费。
 * Rust 不验许可（跟其它付费点一样只在前端闸） */
export const canRedisPro = (isPro: boolean): boolean => isPro
