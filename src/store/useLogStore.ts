/**
 * 码上追的状态：打开过的日志来源 + 各自的 pattern / 过滤。
 *
 * 行数据全在内存、不持久化——重开应用重扫一遍就是，索引只花几秒，换来的是
 * 「pattern 改了不用重读文件」。pattern 每份来源各留一份（两份日志格式不同
 * 不打架），另存一份「上次用的」到 localStorage 当新开文件的缺省值。
 * records 由页面层按来源的 pattern 现算（lib/log 是纯函数）。
 *
 * 来源两种：本机文件（fileId 是 Rust 发的正号）和 SSH 拉取（fileId 是前端
 * 发的负号）。SSH 来源没有 Rust 侧索引——拉下来的字节整段在手，攒行后跟
 * 本机文件完全同构，后面的 pattern / 过滤 / 列表一路复用。
 */
import { create } from 'zustand'
import { capLongLines, logClose, logScan, logSlice, pickLogFile, sliceToLines } from '../lib/log/logIpc'
import { EMPTY_FILTER, type LogFilter } from '../lib/log/filter'
import { betterPattern } from '../lib/log/sniff'
import { sshCollect } from '../lib/log/sshIpc'
import { sshCredGet } from '../lib/log/sshCred'
import { buildPullCmd, cmdWcLines, dropPartialHead, parentDir, parseWcInt, sshTarget } from '../lib/log/ssh'
import {
  loadSshServers,
  removeSshServer,
  renameSshServer,
  sortSshServers,
  upsertSshServer,
  type SshServer,
} from '../lib/log/sshServers'

/** 每批拉多少行：bytes 走 JSON 数字数组，一批太大会把 IPC 撑爆 */
const SLICE_LINES = 8000
/** 行数上限：超过就停（几百万条记录对象会把 UI 拖死），明确提示截断 */
const MAX_LINES = 800_000
/** 同时开着的来源上限（每个都是一份全量行数组在内存里） */
const MAX_SOURCES = 8
/** SSH 单次拉取的字节上限：拉太大会把浏览器进程的内存顶爆，截断并明说 */
const MAX_SSH_BYTES = 100 * 1024 * 1024
/** SSH 拉取缺省行数：日常排障「看最近的错」够用，大拉取走自定义区间 */
export const DEFAULT_TAIL_LINES = 200_000

export interface LogSource {
  fileId: number
  /** file = 本机文件；ssh = 从服务器拉的（path 是 user@host:远程路径 的展示串） */
  kind: 'file' | 'ssh'
  path: string
  name: string
  sizeBytes: number
  /** 本机文件=文件真实总行数（截断了也不改）；SSH=实际拉到的行数（服务器上的总数在 sshTotalLines） */
  totalLines: number
  /** lines[0] 在原文件里是第几行（0 起）：只读尾巴时详情卡的「第 N 行」要加上它 */
  lineOffset: number
  /** 服务器上 wc -l 数出来的总行数；数不出来（或没数）给 null */
  sshTotalLines: number | null
  /**
   * SSH 这次按什么口径拉的：tail（拉最近 N 行）还是 range（按行号拉一段）。
   * 「服务器上还有更早的」横幅只对 tail 有意义——range 本来就是用户点名要的那段。
   * 本机文件给 null。
   */
  pullMode: 'tail' | 'range' | null
  encoding: string
  /** 原始行。records 在页面层按本来源的 pattern 现算 */
  lines: string[]
  /** 本机：已载入行数；SSH 加载中：已接收字节数（进度条口径），载完归位行数 */
  loadedLines: number
  loading: boolean
  /** 到了上限被截断：本机是行数上限（只留最后 N 行），SSH 是字节上限 */
  truncated: boolean
  error: string | null
  /** 本来源的 pattern：打开时带一份上次用的，识别错了单改这份不影响别的来源 */
  patternText: string
  /** 自动识别只做一次（没认出来也标记），之后靠手改或「自动识别」按钮 */
  sniffed: boolean
  /** SSH 来源这次怎么拉的（不含密码）：「重新加载」按它原样再拉一次 */
  sshPull?: SshPull
}

/** openSsh 的参数去掉密码 */
export interface SshPull {
  host: string
  port: number
  user: string
  remotePath: string
  mode: 'tail' | 'range'
  tailLines?: number
  from?: number
  to?: number
}

/** SSH 最近连接。只存地址不存密码——密码铁律：只活在内存，永不落盘 */
export interface SshRecent {
  host: string
  port: number
  user: string
  remotePath: string
}

/**
 * 跨模块跳转请求：码上测的失败用例想看日志时，带上这次跑批的时间窗。
 * 只在内存传话——页面拿到就消费掉，不持久化。
 */
export interface LogJump {
  since: number
  until: number
  /** 人话说明（报告页哪次跑批），没有日志来源时展示给用户 */
  label: string
}

/** 用户服务器的实际格式（真机反馈「这个东西默认，进去就没东西」）：旧缺省跟它
 *  差一点就整份塌成一条无头记录，查看器看起来空的。按用户环境定缺省 */
export const DEFAULT_PATTERN = '[%d{yyyy-MM-dd HH:mm:ss.SSS}]%level [%thread][%logger{50}:%line]-> %msg%n'
/** 上一版缺省（政企老工程常见格式）：老用户的 localStorage 里躺着的多半是它——
 *  那不是用户亲手选的，是我们之前塞的缺省。换缺省时把它当「没存过」处理，
 *  不然新缺省永远被旧存档盖住 */
const LEGACY_DEFAULT_PATTERN = '%d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] %-5level %logger{36} - %msg%n'
const PATTERN_KEY = 'devtools.logview.pattern.v1'
const RECENTS_KEY = 'devtools.logview.recents.v1'
const SSH_RECENTS_KEY = 'devtools.logview.sshrecents.v1'
const SSH_SERVERS_KEY = 'devtools.logview.sshservers.v1'
const NEWEST_FIRST_KEY = 'devtools.logview.newestfirst.v1'

/** 默认最新的在上面：排查看的多是刚出的错；用户切过就记住 */
function loadNewestFirst(): boolean {
  try {
    return localStorage.getItem(NEWEST_FIRST_KEY) !== '0'
  } catch {
    return true
  }
}

function loadPattern(): string {
  try {
    const t = localStorage.getItem(PATTERN_KEY)
    if (!t?.trim() || t === LEGACY_DEFAULT_PATTERN) return DEFAULT_PATTERN
    return t
  } catch {
    return DEFAULT_PATTERN
  }
}

function loadRecents(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function loadSshRecents(): SshRecent[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SSH_RECENTS_KEY) ?? '[]')
    if (!Array.isArray(v)) return []
    const ok = v.filter(
      (x): x is SshRecent =>
        !!x &&
        typeof x === 'object' &&
        typeof (x as SshRecent).host === 'string' &&
        typeof (x as SshRecent).port === 'number' &&
        typeof (x as SshRecent).user === 'string' &&
        typeof (x as SshRecent).remotePath === 'string',
    )
    // 老存档按「主机+文件」记的，同一台有好几条：只留最新那条
    const seen = new Set<string>()
    return ok.filter((r) => {
      const k = `${r.user}@${r.host}:${r.port}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  } catch {
    return []
  }
}

function persistSshServers(list: SshServer[]): void {
  try {
    localStorage.setItem(SSH_SERVERS_KEY, JSON.stringify(list))
  } catch {
    // 隐私模式记不住就算了
  }
}

function loadSshServersFromLocalStorage(): SshServer[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SSH_SERVERS_KEY) ?? 'null')
    return loadSshServers(v)
  } catch {
    return []
  }
}

/** SSH 来源的 fileId 从 -1 往下发，跟 Rust 发的正号永远不撞 */
let nextSshId = -1
/** 正在拉取的远程文件（user@host:port:path）：同一文件不并发拉 */
const sshPulling = new Set<string>()

function pushLinesFromText(src: LogSource, text: string): void {
  const lines = text.split(/\r?\n/)
  // 解码后末尾空串是 split 的副产品（尾部真空行只多一个空串），剥一个刚好对上
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  capLongLines(lines)
  // push 展开有参数个数上限：一次拉 64MB 能拆出几十万行，一把 push(...lines)
  // 直接 RangeError。分批塞——本机文件走 logIpc 分片，天生没这个问题
  for (let i = 0; i < lines.length; i += 8000) src.lines.push(...lines.slice(i, i + 8000))
}

/**
 * 拉取收尾共用的三件事：自动识别 pattern、写回状态、记住上次 pattern。
 * 识别结果必须写进 set 里：加载中每批进度都换了一份新对象，改闭包里的 src
 * 只改到旧对象——之前就这么丢过，识别对了却没套上，第二份打开才好
 */
function finishSource(set: (fn: (s: LogState) => Partial<LogState>) => void, src: LogSource, patch: { truncated: boolean; encoding: string }): void {
  const applied = betterPattern(src.lines, src.patternText)
  if (applied) {
    set(() => ({ lastPattern: applied }))
    try {
      localStorage.setItem(PATTERN_KEY, applied)
    } catch {
      /* 隐私模式记不住就算了 */
    }
  }
  set((s) => ({
    sources: s.sources.map((x) =>
      x.fileId === src.fileId
        ? {
            ...x,
            loading: false,
            truncated: patch.truncated,
            encoding: patch.encoding,
            sniffed: true,
            loadedLines: src.lines.length,
            ...(applied ? { patternText: applied } : {}),
          }
        : x,
    ),
  }))
}

interface LogState {
  sources: LogSource[]
  activeId: number | null
  /** 新开文件带的缺省 pattern = 上次用过的（持久化） */
  lastPattern: string
  filter: LogFilter
  recents: string[]
  sshRecents: SshRecent[]
  /**
   * 常用 SSH 服务器名册（用户手动「存为常用」的，跟自动记录的 sshRecents
   * 是两回事）：选中直接填表单，管理弹窗里改名 / 删除。按最近用过的排。
   */
  sshServers: SshServer[]
  /** 存一台 / 重存一台（同地址算更新：默认目录跟上，备注名保留起过的） */
  saveSshServer: (input: { host: string; port: number; user: string; remotePath: string; name?: string }) => void
  renameSshServer: (id: string, name: string) => void
  removeSshServer: (id: string) => void
  /** 码上测跳转请求（回归时间窗）。没来源时亮在引导卡上，有来源就自动套上 */
  pendingJump: LogJump | null
  openLogFile: () => Promise<void>
  /** replace：重新加载时传旧来源，扫成功才原位替换（沿用它的 pattern），扫失败旧的原样留着 */
  openPath: (path: string, replace?: LogSource) => Promise<void>
  /** 完整拉到返回 true；拉取中途来源被关掉（用户取消）给 false；失败走 throw */
  /** 同一个远程文件已经开着就就地重拉（沿用原页签和 pattern），不再另开一个 */
  openSsh: (
    p: SshPull & {
      /** 密码或私钥口令，空串 = 走本机密钥。只在本函数内存里用，绝不落盘 */
      secret: string
    },
  ) => Promise<boolean>
  closeSource: (fileId: number) => void
  /** 重新加载：本机文件重扫，SSH 按原参数重拉（密码从本机凭据库取） */
  reloadSource: (fileId: number) => Promise<void>
  setActive: (fileId: number) => void
  setPatternText: (t: string) => void
  resetPattern: () => void
  /** 给没做过自动识别（或识别前就加载完）的来源补一次，幂等 */
  sniffIfBad: (fileId: number) => void
  setFilter: (patch: Partial<LogFilter>) => void
  requestJump: (j: LogJump) => void
  clearJump: () => void
  /** 时间线开关：把开着的来源按发生时间交错看（专业版闸门在页面层） */
  timelineOn: boolean
  setTimeline: (on: boolean) => void
  /** 列表顺序：true = 最新的在上面（单份按文件倒序，时间线按时间倒序） */
  newestFirst: boolean
  setNewestFirst: (on: boolean) => void
}

export const useLogStore = create<LogState>((set, get) => ({
  sources: [],
  activeId: null,
  lastPattern: loadPattern(),
  filter: { ...EMPTY_FILTER },
  recents: loadRecents(),
  sshRecents: loadSshRecents(),
  sshServers: sortSshServers(loadSshServersFromLocalStorage()),
  pendingJump: null,
  timelineOn: false,
  newestFirst: loadNewestFirst(),

  openLogFile: async () => {
    const path = await pickLogFile()
    if (path) await get().openPath(path)
  },

  openPath: async (path, replace) => {
    const existed = get().sources.find((s) => s.path === path)
    if (existed && !replace) {
      set({ activeId: existed.fileId })
      return
    }
    // 上限先挡再扫：已经开满时不该再花一次磁盘索引的功夫才知道开不了
    if (!replace && get().sources.length >= MAX_SOURCES) {
      throw new Error(`同时最多开 ${MAX_SOURCES} 份日志（每份都整份在内存里），先关掉几份`)
    }
    let meta: Awaited<ReturnType<typeof logScan>>
    try {
      meta = await logScan(path)
    } catch (e) {
      // 文件已经不在了（删了 / 轮转改名）：从「最近打开」里拿掉，别让人反复点一个打不开的
      const recents = get().recents.filter((r) => r !== path)
      if (recents.length !== get().recents.length) {
        try {
          localStorage.setItem(RECENTS_KEY, JSON.stringify(recents))
        } catch {
          // 隐私模式记不住就算了
        }
        set({ recents })
      }
      throw e
    }
    // 超过行数上限只读最后 MAX_LINES 行：日志最新的在尾巴，读开头等于恰好看不到最近的报错
    const firstLine = Math.max(0, meta.totalLines - MAX_LINES)
    const src: LogSource = {
      fileId: meta.fileId,
      kind: 'file',
      path,
      name: path.split(/[\\/]/).pop() ?? path,
      sizeBytes: meta.sizeBytes,
      totalLines: meta.totalLines,
      lineOffset: firstLine,
      sshTotalLines: null,
      pullMode: null,
      encoding: meta.encoding,
      lines: [],
      loadedLines: 0,
      loading: true,
      truncated: false,
      error: null,
      patternText: replace?.patternText ?? get().lastPattern,
      sniffed: replace?.sniffed ?? false,
    }
    const recents = [path, ...get().recents.filter((r) => r !== path)].slice(0, 10)
    try {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(recents))
    } catch {
      // 隐私模式记不住就算了
    }
    const inPlace = !!replace && get().sources.some((x) => x.fileId === replace.fileId)
    set((s) => ({
      sources: inPlace ? s.sources.map((x) => (x.fileId === replace?.fileId ? src : x)) : [src, ...s.sources],
      activeId: src.fileId,
      recents,
    }))
    // 旧来源的 Rust 侧索引释放掉（新的已另发了号）
    if (inPlace && replace) void logClose(replace.fileId)
    try {
      let start = firstLine
      while (start < meta.totalLines) {
        // 加载中把这份来源关掉了：立刻收手，别再往已卸载的对象里堆行
        if (!get().sources.some((s) => s.fileId === meta.fileId)) return
        const n = Math.min(SLICE_LINES, meta.totalLines - start)
        const bytes = await logSlice(meta.fileId, start, n)
        const lines = sliceToLines(bytes, meta.encoding)
        for (let i = 0; i < lines.length; i += 8000) src.lines.push(...lines.slice(i, i + 8000))
        start += n
        const loaded = start - firstLine
        set((s) => ({
          sources: s.sources.map((x) => (x.fileId === meta.fileId ? { ...x, loadedLines: loaded } : x)),
        }))
      }
      finishSource(set, src, { truncated: firstLine > 0, encoding: meta.encoding })
    } catch (e) {
      set((s) => ({
        sources: s.sources.map((x) =>
          x.fileId === meta.fileId
            ? { ...x, loading: false, error: e instanceof Error ? e.message : String(e), sniffed: true }
            : x,
        ),
      }))
    }
  },

  openSsh: async ({ host, port, user, secret, remotePath, mode, tailLines, from, to }) => {
    const pull = buildPullCmd(
      remotePath,
      mode === 'range'
        ? { kind: 'range', from: from ?? 1, to: to ?? 1 }
        : // 字节上限在服务器上卡（tail -c），超了丢的是最旧的那段
          { kind: 'tail', n: tailLines ?? DEFAULT_TAIL_LINES, maxBytes: MAX_SSH_BYTES },
    )
    if ('error' in pull) throw new Error(pull.error)
    const displayPath = `${sshTarget(user, host)}:${remotePath}`
    // 「同一个文件」按主机+端口+用户+路径认：展示串不带端口，同机不同端口的两个容器会被当成一个
    const key = `${user}@${host}:${port}:${remotePath}`
    if (sshPulling.has(key)) throw new Error('这个文件正在拉取，稍等它拉完')
    const existed = get().sources.find(
      (s) =>
        s.sshPull !== undefined &&
        `${s.sshPull.user}@${s.sshPull.host}:${s.sshPull.port}:${s.sshPull.remotePath}` === key,
    )
    if (!existed && get().sources.length >= MAX_SOURCES) {
      throw new Error(`同时最多开 ${MAX_SOURCES} 份日志（每份都整份在内存里），先关掉几份`)
    }
    // 同一文件拉取中再来一次（连点重新加载 / 侧栏又点）直接挡掉，否则两条拉取各插一个页签
    sshPulling.add(key)
    try {
      // wc 预检兼探总行数：连不上、密码不对、文件不存在，在这一步就人话报错，
      // 不让用户干等一次注定失败的大拉取。wc 数不出（个别文件系统怪象）不拦路
      const probe = await sshCollect(
        { host, port, user, secret: secret || undefined, remoteCmd: cmdWcLines(remotePath) },
        { capBytes: 64 * 1024 },
      )
      const sshTotalLines = parseWcInt(probe.text)
      const src: LogSource = {
        fileId: nextSshId--,
        kind: 'ssh',
        path: displayPath,
        name: remotePath.split('/').pop() ?? remotePath,
        sizeBytes: 0,
        totalLines: 0,
        lineOffset: 0,
        sshTotalLines,
        pullMode: mode,
        encoding: 'utf-8',
        lines: [],
        loadedLines: 0,
        loading: true,
        truncated: false,
        error: null,
        // 重拉沿用旧页签调好的 pattern，不再重新识别
        patternText: existed?.patternText ?? get().lastPattern,
        sniffed: existed?.sniffed ?? false,
        sshPull: { host, port, user, remotePath, mode, tailLines, from, to },
      }
      // 最近连接记「文件所在目录」、一台机器只一条：记文件的话下次展开路径框是个文件，
      // ls 出来拼成 /a/x.log//a/x.log；按文件去重则同一台出一排一模一样的 user@host 按钮
      const dir = parentDir(remotePath)
      const sshRecents = [
        { host, port, user, remotePath: dir },
        ...get().sshRecents.filter((r) => !(r.host === host && r.port === port && r.user === user)),
      ].slice(0, 10)
      try {
        localStorage.setItem(SSH_RECENTS_KEY, JSON.stringify(sshRecents))
      } catch {
        // 隐私模式记不住就算了
      }
      // 旧页签还在就原位替换：它的 fileId 没了，若还在拉，shouldStop 会让它自己收手
      set((s) => ({
        sources:
          existed && s.sources.some((x) => x.fileId === existed.fileId)
            ? s.sources.map((x) => (x.fileId === existed.fileId ? src : x))
            : [src, ...s.sources],
        activeId: src.fileId,
        sshRecents,
      }))
      // 进度最多 0.2 秒写一次：每块都 set 会让整页跟着重画
      let lastTick = 0
      try {
        const res = await sshCollect(
          { host, port, user, secret: secret || undefined, remoteCmd: pull.cmd },
          {
            // tail 模式服务器已经卡了字节，这里只当兜底；行区间模式在这里掐断
            capBytes: mode === 'tail' ? MAX_SSH_BYTES + 1024 * 1024 : MAX_SSH_BYTES,
            onProgress: (received) => {
              const now = Date.now()
              if (now - lastTick < 200) return
              lastTick = now
              set((s) => ({
                sources: s.sources.map((x) => (x.fileId === src.fileId ? { ...x, loadedLines: received } : x)),
              }))
            },
            shouldStop: () => !get().sources.some((x) => x.fileId === src.fileId),
          },
        )
        // 拉取中把这份来源关掉了：sshCollect 已经收手，这边安静退场（不算拉完，
        // 返回 false 让调用方别弹「拉下来了」）
        if (!get().sources.some((x) => x.fileId === src.fileId)) return false
        // tail 模式打满字节上限 = 服务器从头部切过，第一行是半行
        const headCut = mode === 'tail' && res.sizeBytes >= MAX_SSH_BYTES
        pushLinesFromText(src, headCut ? dropPartialHead(res.text) : res.text)
        finishSource(set, src, { truncated: headCut || res.truncated, encoding: res.encoding })
        const pulled = src.lines.length
        const lineOffset =
          mode === 'range' ? (from ?? 1) - 1 : sshTotalLines !== null ? Math.max(0, sshTotalLines - pulled) : 0
        set((s) => ({
          sources: s.sources.map((x) =>
            x.fileId === src.fileId
              ? { ...x, sizeBytes: res.sizeBytes, totalLines: pulled, lineOffset, sshTotalLines }
              : x,
          ),
        }))
        return true
      } catch (e) {
        // 拉取失败：是刷新就把旧内容放回原位（别让一次断网把整份日志弄丢），
        // 新开的空来源直接撤掉；人话错误抛回给调用方提示
        set((s) => {
          if (existed) {
            return {
              sources: s.sources.map((x) => (x.fileId === src.fileId ? existed : x)),
              activeId: s.activeId === src.fileId ? existed.fileId : s.activeId,
            }
          }
          const sources = s.sources.filter((x) => x.fileId !== src.fileId)
          return { sources, activeId: s.activeId === src.fileId ? (sources[0]?.fileId ?? null) : s.activeId }
        })
        throw e instanceof Error ? e : new Error(String(e))
      }
    } finally {
      sshPulling.delete(key)
    }
  },

  closeSource: (fileId) => {
    const src = get().sources.find((x) => x.fileId === fileId)
    // 本机文件的行偏移索引在 Rust 侧，不关就一直占着（千万行 80MB）
    if (src?.kind === 'file') void logClose(fileId)
    set((s) => {
      const sources = s.sources.filter((x) => x.fileId !== fileId)
      return { sources, activeId: s.activeId === fileId ? (sources[0]?.fileId ?? null) : s.activeId }
    })
  },

  reloadSource: async (fileId) => {
    const src = get().sources.find((x) => x.fileId === fileId)
    if (!src) return
    if (src.kind === 'ssh') {
      if (!src.sshPull) return
      const p = src.sshPull
      const saved = await sshCredGet({ host: p.host, port: p.port, user: p.user }).catch(() => null)
      try {
        await get().openSsh({ ...p, secret: saved ?? '' })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // 没记密码的服务器这里拿不到口令：指一条能走通的路
        throw new Error(saved ? msg : `${msg}（这台没记住密码：在左边侧栏重新点一下这个文件也能刷新）`)
      }
      return
    }
    // 重新扫一遍拿文件最新内容（日志还在写）：扫成功才原位替换、带上这份的 pattern；
    // 文件刚好轮转改名扫不到时，旧内容原样留着
    await get().openPath(src.path, src)
  },

  setActive: (fileId) => set({ activeId: fileId }),

  setPatternText: (t) => {
    set((s) => ({
      // 空串是「清空了准备重输」的中间态，不当「上次用的」记住——不然下一份
      // 来源一打开就是空 pattern，整份文件塌成逐行记录（真机踩过）
      lastPattern: t.trim() ? t : s.lastPattern,
      sources: s.sources.map((x) => (x.fileId === s.activeId ? { ...x, patternText: t } : x)),
    }))
    if (t.trim()) {
      try {
        localStorage.setItem(PATTERN_KEY, t)
      } catch {
        // 隐私模式记不住就算了
      }
    }
  },

  resetPattern: () => get().setPatternText(DEFAULT_PATTERN),

  sniffIfBad: (fileId) => {
    const src = get().sources.find((s) => s.fileId === fileId)
    if (!src || src.loading || src.sniffed) return
    const applied = betterPattern(src.lines, src.patternText)
    set((s) => ({
      sources: s.sources.map((x) => (x.fileId === fileId ? { ...x, sniffed: true } : x)),
    }))
    if (applied) get().setPatternText(applied)
  },

  setFilter: (patch) => set({ filter: { ...get().filter, ...patch } }),

  requestJump: (j) => set({ pendingJump: j }),
  clearJump: () => set({ pendingJump: null }),

  setTimeline: (on) => set({ timelineOn: on }),

  setNewestFirst: (on) => {
    try {
      localStorage.setItem(NEWEST_FIRST_KEY, on ? '1' : '0')
    } catch {
      // 隐私模式记不住就算了
    }
    set({ newestFirst: on })
  },

  saveSshServer: (input) => {
    const sshServers = sortSshServers(upsertSshServer(get().sshServers, input))
    persistSshServers(sshServers)
    set({ sshServers })
  },

  renameSshServer: (id, name) => {
    const sshServers = renameSshServer(get().sshServers, id, name)
    persistSshServers(sshServers)
    set({ sshServers })
  },

  removeSshServer: (id) => {
    const sshServers = removeSshServer(get().sshServers, id)
    persistSshServers(sshServers)
    set({ sshServers })
  },
}))
