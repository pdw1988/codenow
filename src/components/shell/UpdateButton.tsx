/**
 * 顶栏的「检查更新」按钮（PRD 之外、用户点名的功能）。
 *
 * 为什么放顶栏：更新是全局动作，不属于任何一个功能页；跟缓存状态、主题切换
 * 坐一排正好——都是「整个应用的事」。流程是手动的「检查 → 确认 → 下载 → 重启」，
 * 不做静默更新：这是离线工具，用户对「它自己动了什么」应该有数。
 *
 * 弹窗正文必须是这次改了什么（latest.json 的 notes）。以前发版常把升版本号
 * 那句「发版 vX」写进去，用户只看见版本号、看不见内容。说明太空时再去拉
 * 产物仓 CHANGELOG.md 对应版本那一节。
 *
 * 端点和签名公钥在 src-tauri/tauri.conf.json 的 plugins.updater；清单和安装包
 * 挂在公开的 devtools-releases 仓库（源码仓保持私有），发布流程见 scripts/publish-update.mjs。
 *
 * 插件包走动态 import：跟 sqliteStore 同一个理由，浏览器调试模式不该为
 * Tauri 专属的绑定付加载成本，import 本身虽然无害，invoke 一口就炸了。
 *
 * 每个功能页都挂一份按钮（Page 顶栏）。弹窗只在 AppShell 挂一份：
 * 所有页同时在 DOM 里，跟着按钮走会叠 N 个 Modal。状态是模块级的，
 * 点哪一页的按钮都动同一份。
 */
import { useEffect, useSyncExternalStore } from 'react'
import { App } from 'antd'
import { isTauri } from '../../storage'
import { Btn, Dlg, Hint } from '../ui'
import type { Update } from '@tauri-apps/plugin-updater'
import {
  changelogSection,
  notesLookThin,
  RELEASES_CHANGELOG_URL,
} from '../../lib/updateNotes'

export function UpdateButton() {
  // 浏览器调试模式没有安装包可更。禁用而不是藏起来：按钮在，用户才知道有这个能力
  if (!isTauri())
    return (
      <Btn variant="mini" disabled title="自动更新只在桌面版 exe 里可用——浏览器调试模式没有安装包">
        检查更新
      </Btn>
    )
  return <UpdateButtonInner />
}

/**
 * 弹窗只挂一份（AppShell），不要跟按钮一起塞进每个 Page：
 * 所有页同时挂在 DOM 里，N 个 Modal 会叠在一起；开发 Strict Mode 还会把
 * 「第一份当宿主」卸掉，结果谁都不弹。
 */
export function UpdateDialogs() {
  if (!isTauri()) return null
  return <UpdateDialogsInner />
}

type Phase = 'idle' | 'checking' | 'downloading'

interface UpdateUi {
  phase: Phase
  update: Update | null
  notes: string
  currentVersion: string
  confirmOpen: boolean
  readyVersion: string | null
}

const SKIP_KEY = 'chuju.update.skip'

function skippedVersion(): string | null {
  try {
    return localStorage.getItem(SKIP_KEY)
  } catch {
    return null
  }
}

function rememberSkip(version: string) {
  try {
    localStorage.setItem(SKIP_KEY, version)
  } catch {
    /* 隐私模式写不了就下次再弹，不算故障 */
  }
}

let ui: UpdateUi = {
  phase: 'idle',
  update: null,
  notes: '',
  currentVersion: '',
  confirmOpen: false,
  readyVersion: null,
}
const listeners = new Set<() => void>()
function emit(patch: Partial<UpdateUi>) {
  ui = { ...ui, ...patch }
  for (const l of listeners) l()
}
function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange)
  return () => {
    listeners.delete(onStoreChange)
  }
}

/** 查更新不能并行：每页一份按钮，点两下或启动静默查叠上会弹两回 */
let inflight = false

async function resolveNotes(update: Update): Promise<string> {
  const raw = update.body?.trim() ?? ''
  if (!notesLookThin(raw)) return raw
  try {
    const r = await fetch(RELEASES_CHANGELOG_URL)
    if (!r.ok) return raw || '本次更新没有写说明。'
    const section = changelogSection(await r.text(), update.version)
    if (section && !notesLookThin(section)) return section
  } catch {
    /* 连不上 GitHub 时 updater 自己也会失败；走到这里说明清单已经拉到了，用清单那句 */
  }
  return raw || '本次更新没有写说明。'
}

type MessageApi = ReturnType<typeof App.useApp>['message']

async function runCheck(opts: { silent?: boolean; message: MessageApi }) {
  if (inflight || ui.phase !== 'idle') return
  inflight = true
  emit({ phase: 'checking' })
  try {
    const [{ check }, { getVersion }] = await Promise.all([
      import('@tauri-apps/plugin-updater'),
      import('@tauri-apps/api/app'),
    ])
    const currentVersion = await getVersion()
    const found = await check()
    if (!found) {
      if (!opts.silent) opts.message.success(`已是最新版本（v${currentVersion}）`)
      return
    }
    if (opts.silent && skippedVersion() === found.version) return
    const notes = await resolveNotes(found)
    emit({
      update: found,
      notes,
      currentVersion,
      confirmOpen: true,
    })
  } catch (err) {
    if (opts.silent) return
    opts.message.error(
      `检查更新失败：${err instanceof Error ? err.message : String(err)} —— 多半是网络问题（GitHub、Gitee 都试过了），稍后再试`,
    )
  } finally {
    inflight = false
    emit({ phase: 'idle' })
  }
}

function UpdateButtonInner() {
  const s = useSyncExternalStore(subscribe, () => ui, () => ui)
  const { message } = App.useApp()

  return (
    <Btn
      variant="mini"
      onClick={() => void runCheck({ message })}
      disabled={s.phase !== 'idle'}
    >
      {s.phase === 'checking' ? '检查中…' : s.phase === 'downloading' ? '下载安装中…' : '检查更新'}
    </Btn>
  )
}

/**
 * 标题旁的「新版本」胶囊：发现新版本、用户却点了「暂不更新」时留一个入口，
 * 点它重新弹更新说明。没有待装的版本就不渲染。
 */
export function UpdatePill() {
  const s = useSyncExternalStore(subscribe, () => ui, () => ui)
  if (!s.update || s.confirmOpen || s.readyVersion || s.phase !== 'idle') return null
  return (
    <button type="button" className="top-alert" onClick={() => emit({ confirmOpen: true })}>
      ⚠ 新版本 v{s.update.version} 可更新
    </button>
  )
}

function UpdateDialogsInner() {
  const s = useSyncExternalStore(subscribe, () => ui, () => ui)
  const { message } = App.useApp()

  // 启动后静默查一次。失败不打扰（连不上 GitHub 是常态）；有新版本才弹，正文是更新内容。
  useEffect(() => {
    const t = window.setTimeout(() => {
      void runCheck({ silent: true, message })
    }, 1600)
    return () => window.clearTimeout(t)
  }, [message])

  const doInstall = async () => {
    const u = s.update
    if (!u) return
    emit({ confirmOpen: false, phase: 'downloading' })
    try {
      await u.downloadAndInstall()
      emit({ readyVersion: u.version, phase: 'idle' })
    } catch (err) {
      message.error(`下载安装失败：${err instanceof Error ? err.message : String(err)}`)
      emit({ phase: 'idle' })
    }
  }

  const restart = async () => {
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  }

  const dismiss = () => {
    if (s.update) rememberSkip(s.update.version)
    emit({ confirmOpen: false })
  }

  return (
    <>
      <Dlg
        title={`发现新版本 v${s.update?.version ?? ''}`}
        open={s.confirmOpen}
        onClose={dismiss}
        width={620}
        tall
        actions={
          <>
            <Btn onClick={dismiss}>暂不更新</Btn>
            <Btn variant="primary" onClick={() => void doInstall()}>
              下载并安装
            </Btn>
          </>
        }
      >
        <Hint>当前 v{s.currentVersion || '…'}，安装后需重启。下面是这次改了什么：</Hint>
        <div className="upd-notes">{s.notes || '本次更新没有写说明。'}</div>
      </Dlg>

      <Dlg
        title={`v${s.readyVersion ?? ''} 已就绪`}
        open={s.readyVersion !== null}
        onClose={() => emit({ readyVersion: null })}
        width={480}
        actions={
          <>
            {/* 稍后重启也安全：新版本已经装好，下次启动自然生效 */}
            <Btn onClick={() => emit({ readyVersion: null })}>稍后重启</Btn>
            <Btn variant="primary" onClick={() => void restart()}>
              立即重启
            </Btn>
          </>
        }
      >
        <div className="hint">新版本已安装完成，重启应用后生效。</div>
      </Dlg>
    </>
  )
}
