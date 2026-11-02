/**
 * 扫描页上半部：扫描入口 +「之前扫描过的工程」历史卡片。
 * 扫描中 / 失败 / 结果接在同一页下半部（ApiforgePage 的 ScanTab）。
 */
import { useEffect, useState } from 'react'
import { App as AntdApp } from 'antd'
import { Btn, Fld, Hint, Lbl, Row } from '../../components/ui'
import { useApiforgeStore } from '../../store/useApiforgeStore'
import { historyCardName, type ScanHistoryEntry } from '../../lib/apiforge/scan/history'
import { pickDirectory, pickJarFile } from '../../lib/apiforge/scan/pickDirectory'
import { cachedWorkspaceRoots, deleteScannedWorkspace, loadCachedWorkspace } from '../../lib/apiforge/scan/scanIpc'
import { normalizeRoot } from '../../lib/apiforge/scan/workspaceCache'
import { fmtLocal } from '../../lib/apiforge/localTime'
import { isTauri } from '../../storage'
import { blockedByRunning, useScan } from './apiforgeRun'
import { HowDbWorks } from './apiforgeBits'
import type { AppModal } from './appModal'
import { SCAN_ROOT_INPUT_ID } from './scanFocus'

/** 桌面版缓存实路径（%APPDATA%\com.pdw.devtools\cache.db）；浏览器预览走 localStorage */
async function resolveCachePath(): Promise<string> {
  if (!isTauri()) return '浏览器预览模式：浏览器 localStorage（devtools.apiforge.meta）'
  try {
    const { appDataDir, join } = await import('@tauri-apps/api/path')
    return `${await join(await appDataDir(), 'cache.db')}`
  } catch {
    return '%APPDATA%\\com.pdw.devtools\\cache.db'
  }
}

/** 「黑盒」信任感（用户反馈）：把数据存哪、碰不碰网一次说清，可复查 */
function showLocalTrail(modal: AppModal, cachePath: string): void {
  modal.info({
    title: '数据都在本机，网络只去你配的地方',
    width: 560,
    okText: '知道了',
    content: (
      <div className="apf-trail">
        <div>
          <b>缓存位置（可自己打开核对）：</b>
          <code className="apf-trail-path">{cachePath}</code>
          <div>扫描结果、用例、关联表修正、环境配置都存在这一个库里，删掉即清空。</div>
        </div>
        <div>
          <b>扫描：</b>纯本地源码文本解析，源码不出本机、不上传。
        </div>
        <div>
          <b>跑用例：</b>只向你配置的「服务地址 baseUrl」发 HTTP 请求；没有遥测。
        </div>
        <div>
          <b>数据库验证：</b>只连「环境 / 连库」里你配置的库；快照走只读查询，写操作另需确认。
        </div>
      </div>
    ),
  })
}

/** 「接口怎么验证」的一分钟原理：与环境页顶部的折叠说明同一份内容 */
function showHowItWorks(modal: AppModal): void {
  modal.info({
    title: '接口运行和数据库是什么关系？',
    width: 620,
    okText: '明白了',
    content: <HowDbWorks />,
  })
}

export function ApiforgeHomeTab() {
  const { message, modal } = AntdApp.useApp()
  const { root, setRoot, doScan } = useScan(message)
  const scan = useApiforgeStore((s) => s.scan)
  const scanning = useApiforgeStore((s) => s.scanning)
  const history = useApiforgeStore((s) => s.history)
  const setHistory = useApiforgeStore((s) => s.setHistory)
  const setView = useApiforgeStore((s) => s.setView)
  const setScan = useApiforgeStore((s) => s.setScan)
  const [picking, setPicking] = useState(false)
  const [pickingJar, setPickingJar] = useState(false)

  /**
   * 当下能秒开的根目录（LRU 索引，不用把几百 KB 的全量结果读进来）。
   * scan 变了就重拉：刚扫完会新增一份，还可能把最久没用的那份挤下去，
   * 角标不跟着变就会说谎。
   */
  const [cachedRoots, setCachedRoots] = useState<string[]>([])
  useEffect(() => {
    void cachedWorkspaceRoots().then(setCachedRoots)
  }, [scan])
  const cachedSet = new Set(cachedRoots.map(normalizeRoot))

  /**
   * 历史卡片：缓存里有这个根目录就直接打开，不重扫。
   *
   * 以前只跟**内存里**的 scan 比，而应用刚起来内存是空的（把缓存读进内存的
   * 只有 ApiforgePage 那个一次会话弹一回、点「进入首页」就错过的弹窗），
   * 所以刚扫过的目录点下去照样重扫一遍。现在全量结果按目录分键存（最近 3 份），
   * 所以 A ⇄ B 来回切也都是秒开。
   */
  const openEntry = async (h: ScanHistoryEntry) => {
    // 点已扫过的工程 = 要用接口：缓存秒开直接进接口库，不停在扫描页
    if (scan?.root === h.root) return setView('apis')
    // 扫描或跑用例时不换工程：正在用的扫描结果会被换掉
    if (blockedByRunning(message)) return
    const cached = await loadCachedWorkspace(h.root)
    if (cached) {
      setRoot(h.root) // 路径回填输入框：要重扫不用再找一遍目录
      setScan(cached)
      return setView('apis')
    }
    // 这个目录不在 LRU 里（没扫过，或已被挤出去）：历史里只有摘要，只能重扫，
    // 进度在「扫描」页看（runScan 自己会切过去）
    void doScan(h.root)
  }

  /** 删除扫描工程：破坏性操作先确认（跑批写操作的确认同款哲学） */
  const removeEntry = (h: ScanHistoryEntry) => {
    const isCurrent = scan?.root === h.root
    modal.confirm({
      title: `删除「${historyCardName(h)}」？`,
      content: `会删掉这条扫描历史和它的秒开缓存（${h.root}）。接口的用例和关联表修正会保留，重扫同一目录会接回来。${
        isCurrent ? '这是当前打开的工程，接口库里的结果也会关掉。' : ''
      }`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setHistory(await deleteScannedWorkspace(h.root))
        // 删的是正在用的：内存里的结果一起关掉，否则重启前后表现不一致
        if (isCurrent && useApiforgeStore.getState().scan?.root === h.root) setScan(null)
        setCachedRoots(await cachedWorkspaceRoots())
        void message.success('已删除')
      },
    })
  }

  const browseDir = async () => {
    if (!isTauri()) {
      void message.warning('选择本地目录请用桌面版')
      return
    }
    setPicking(true)
    try {
      const dir = await pickDirectory('选择 Spring Boot 工程目录或多工程父目录')
      if (dir) setRoot(dir)
    } catch (e) {
      void message.error(String(e))
    } finally {
      setPicking(false)
    }
  }

  /** jar 扫描入口：没有源码、只有构建产物时，直接选 .jar 扫 class 注解 */
  const browseJar = async () => {
    if (!isTauri()) {
      void message.warning('选择本地文件请用桌面版')
      return
    }
    setPickingJar(true)
    try {
      const jar = await pickJarFile('选择 Spring Boot Jar 包')
      // 和「选择目录」一样只回填，由「开始扫描」触发
      if (jar) setRoot(jar)
    } catch (e) {
      void message.error(String(e))
    } finally {
      setPickingJar(false)
    }
  }

  return (
    <div className="apf-hero">
      <h1>扫出全部 Spring Boot 接口</h1>
      <p className="apf-lead">可以选单个工程，也可以选放着多个工程的父目录，一次扫完。</p>
      <div className="apf-hero-form">
        <Lbl>工程目录或 Jar 包</Lbl>
        <div className="apf-hero-pathrow">
          <Fld
            big
            id={SCAN_ROOT_INPUT_ID}
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            placeholder="手填路径，或点右侧选择本地目录"
            onKeyDown={(e) => e.key === 'Enter' && void doScan()}
          />
          <Btn
            onClick={() => void browseDir()}
            disabled={scanning || picking || !isTauri()}
            title={
              !isTauri()
                ? '选择本地目录请用桌面版'
                : '打开系统目录对话框'
            }
          >
            {picking ? '选择中…' : '选择目录'}
          </Btn>
          <Btn
            onClick={() => void browseJar()}
            disabled={scanning || pickingJar || !isTauri()}
            title={
              !isTauri()
                ? '选择本地文件请用桌面版'
                : '没有源码时选打好的 Jar 包，选好后点「开始扫描」（会连同包里的依赖一起解析）'
            }
          >
            {pickingJar ? '选择中…' : '选择 Jar 包'}
          </Btn>
        </div>
        <Row>
          <Btn variant="primary" onClick={() => void doScan()} disabled={scanning}>
            {scanning ? '扫描中…' : '开始扫描'}
          </Btn>
        </Row>
      </div>
      <Hint>需要本机装有 Java 8 及以上。只在本机解析源码，不上传；结果存本地，下次秒开。没有源码时可点「选择 Jar 包」。</Hint>
      <Row>
        <Btn
          onClick={() => void resolveCachePath().then((p) => showLocalTrail(modal, p))}
          title="看数据存在哪、会不会碰网"
        >
          数据去向 / 缓存位置
        </Btn>
        <Btn onClick={() => showHowItWorks(modal)} title="一分钟看懂：接口测试怎么用数据库判定「真的成功」">
          接口怎么验证？
        </Btn>
      </Row>
      {history.length > 0 && (
        <>
          <p className="apf-hero-label">之前扫描过的工程</p>
          <div className="apf-project-grid">
            {history.map((h) => {
              // 旧历史条目里可能有 0 接口的空工程，渲染时滤掉（normalize 侧已挡新数据）
              const shownProjects = h.projects.filter((p) => p.apis > 0)
              const apis = shownProjects.reduce((n, p) => n + p.apis, 0)
              const cached = scan?.root === h.root || cachedSet.has(normalizeRoot(h.root))
              return (
                <div key={h.root} className="apf-pc-wrap">
                  <button className="apf-project-card" onClick={() => void openEntry(h)}>
                    <div className="apf-pc-name">{historyCardName(h)}</div>
                    <div className="apf-pc-root">{h.root}</div>
                    <div className="apf-pc-meta">
                      <span>{shownProjects.length} 个 Spring Boot 工程</span>
                      <span>
                        {apis} 个接口 · {fmtLocal(h.scannedAt)}
                      </span>
                    </div>
                    <div className="apf-pc-projects">
                      {shownProjects.map((p) => (
                        <span key={p.name}>{p.name}</span>
                      ))}
                    </div>
                    <div className="apf-pc-cta">{cached ? '打开接口库 →' : '一键扫描 →'}</div>
                  </button>
                  {/* 卡片本身是 button，删除只能做兄弟节点叠在角上，别嵌套 button */}
                  <button
                    className="apf-pc-del"
                    title="删除这条扫描记录"
                    aria-label={`删除 ${historyCardName(h)}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      removeEntry(h)
                    }}
                  >
                    ×
                  </button>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
