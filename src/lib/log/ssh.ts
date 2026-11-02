/**
 * 码上追 · SSH 拉日志的纯函数层：远程命令拼装、ls 输出解析、ssh 报错翻译、
 * 编码嗅探。协议本身不在这一层——真正跑 ssh 的是系统自带的 ssh 客户端
 * （Rust 侧 spawn），这里是「要对服务器说什么、听回来的是什么」的知识。
 *
 * 依赖决策（方案里预留的点）：不引 russh，用外壳 ssh。理由：用户已有的
 * ~/.ssh/config（跳板机 ProxyJump）、known_hosts、私钥全部自动生效；加密
 * 实现是 OpenSSH 的，我们不维护；零新依赖继续守住。代价是 Windows 的
 * OpenSSH 不支持连接复用，浏览/数行/拉取各自一条连接——密码由 askpass
 * （应用自己的 exe）自动应答，见 main.rs。
 */

/** 拉取行数上限：跟本机文件的 MAX_LINES 同量级，再多 UI 也扛不住 */
export const PULL_LINE_CAP = 800_000

/** POSIX 单引号转义：路径里的 `'` 闭引号加转义引号再开引号 */
export function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** 以 `-` 开头的路径会被当成命令选项，垫个 ./ */
export function safeRemotePath(p: string): string {
  const t = p.trim()
  return t.startsWith('-') ? `./${t}` : t
}

/** user@host：host 里已经带了 @（用户整段粘贴）就别再拼一层 */
export function sshTarget(user: string, host: string): string {
  const h = host.trim()
  const u = user.trim()
  if (!u || h.includes('@')) return h
  return `${u}@${h}`
}

/**
 * 「user@host:路径」的展示串 → user@host（时间线每行的来源标签）。按第一个
 * 「:/」切而不是 split(':')：IPv6 地址（user@fd00::5）里本来就全是冒号，
 * 按冒号切会把主机名切得只剩个头。
 */
export function sshLabel(displayPath: string): string {
  const i = displayPath.indexOf(':/')
  return i >= 0 ? displayPath.slice(0, i) : displayPath
}

function quotedPath(p: string): string {
  return sq(safeRemotePath(p))
}

/** 浏览目录。--time-style=long-iso 的日期好解析，但 busybox 没有：失败就地回退普通 ls */
export function cmdLs(dir: string): string {
  const p = quotedPath(dir)
  return `ls -la --time-style=long-iso ${p} 2>/dev/null || ls -la ${p}`
}

/** 列相对路径（如主目录 .）时顺带报它的绝对路径：首行 pwd，其余是 ls（拆分见 splitPwd） */
export function cmdLsAbs(dir: string): string {
  return `cd ${quotedPath(dir)} && pwd && { ${cmdLs('.')}; }`
}

/** cmdLsAbs 的输出拆成绝对路径 + ls 文本；首行不是绝对路径就当没拿到 */
export function splitPwd(text: string): { dir: string | null; rest: string } {
  const nl = text.indexOf('\n')
  const first = (nl < 0 ? text : text.slice(0, nl)).trim()
  if (!first.startsWith('/')) return { dir: null, rest: text }
  return { dir: first, rest: nl < 0 ? '' : text.slice(nl + 1) }
}

/** 数总行数，好告诉用户「服务器上共 N 行」。失败只影响展示，不拦拉取 */
export function cmdWcLines(file: string): string {
  return `wc -l < ${quotedPath(file)}`
}

/**
 * tail 模式可带 maxBytes：服务器上再接一道 `tail -c`，超了只留最后这么多字节——日志最新的
 * 在尾巴，在客户端按字节上限提前掐断的话丢的恰好是最近的行
 */
export type PullMode = { kind: 'tail'; n: number; maxBytes?: number } | { kind: 'range'; from: number; to: number }

/**
 * 服务器上先把超长行截到 60000 字节再传：有的服务一行打几 MB，100MB 上限只装得下
 * 十来行。C 语言环境按字节截，再去掉被切开的半个 UTF-8 字符（不然整段会被误判成
 * GBK）；行尾追加 \x01CUT<原字节数>，客户端换成中文说明（命令里不放中文，免得编码出岔）
 */
export const REMOTE_LINE_CAP = 60_000
const CAP_LINES = String.raw` | LC_ALL=C awk 'length($0)>${REMOTE_LINE_CAP}{t=substr($0,1,${REMOTE_LINE_CAP});sub(/[\300-\367][\200-\277]*$/,"",t);print t "\001CUT" length($0);next}1'`

/** 组装拉内容的远程命令；参数不合法给说人话的 error，不往服务器扔脏命令 */
export function buildPullCmd(file: string, mode: PullMode): { cmd: string } | { error: string } {
  if (!file.trim()) return { error: '远程路径还没填' }
  if (mode.kind === 'tail') {
    if (!Number.isInteger(mode.n) || mode.n < 1) return { error: '拉取行数得是正整数' }
    if (mode.n > PULL_LINE_CAP) return { error: `一次最多拉 ${PULL_LINE_CAP.toLocaleString()} 行（内存保护）` }
    const cut = mode.maxBytes && Number.isInteger(mode.maxBytes) && mode.maxBytes > 0 ? ` | tail -c ${mode.maxBytes}` : ''
    return { cmd: `tail -n ${mode.n} ${quotedPath(file)}${CAP_LINES}${cut}` }
  }
  const { from, to } = mode
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    return { error: '行区间得是「起始 ≤ 结束」的正整数' }
  }
  if (to - from + 1 > PULL_LINE_CAP) {
    return { error: `区间最多 ${PULL_LINE_CAP.toLocaleString()} 行（内存保护），要更早的先在服务器上截一段` }
  }
  return { cmd: `sed -n '${from},${to}p' ${quotedPath(file)}${CAP_LINES}` }
}

/** 按字节从头部截过的文本，第一行多半是半行：丢到第一个换行为止（没有换行就原样返回） */
export function dropPartialHead(text: string): string {
  const i = text.indexOf('\n')
  return i >= 0 ? text.slice(i + 1) : text
}

/** `wc -l < file` 的输出；认不出数字（比如错误信息）给 null */
export function parseWcInt(out: string): number | null {
  const m = /(\d+)\s*$/.exec(out.trim())
  return m ? Number(m[1]) : null
}

export interface RemoteFile {
  name: string
  sizeBytes: number
  isDir: boolean
  /** 解析出来的时间戳（本地时区口径，跨时区看会有偏差），只用于排序 */
  mtime: number | null
  /** 服务器原样给的日期文本，展示用它——不假装知道服务器时区 */
  mtimeText: string
}

const MONTHS = new Map(
  ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m, i) => [m.toUpperCase(), i]),
)

function parseIsoLocal(date: string, time: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time)
  if (!d || !t) return null
  return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), t[3] ? Number(t[3]) : 0).getTime()
}

function parseCTime(mon: string, day: string, third: string, now: number): number | null {
  const mo = MONTHS.get(mon.toUpperCase())
  if (mo === undefined) return null
  const d = Number(day)
  if (!Number.isInteger(d) || d < 1 || d > 31) return null
  const t = /^(\d{1,2}):(\d{2})$/.exec(third)
  let year: number
  let hh = 0
  let mm = 0
  if (t) {
    // ls 对近半年内的文件省略年份：猜今年；猜出「未来一天以上」就是跨年了，退回去年
    year = new Date(now).getFullYear()
    hh = Number(t[1])
    mm = Number(t[2])
  } else if (/^\d{4}$/.test(third)) {
    year = Number(third)
  } else {
    return null
  }
  const ts = new Date(year, mo, d, hh, mm).getTime()
  if (t && ts > now + 86_400_000) return new Date(year - 1, mo, d, hh, mm).getTime()
  return ts
}

/**
 * 解析 `ls -la`（长格式）输出。只认「权限位开头」的行：total 行、本地化
 * 告警（「合计：」/「total」）统统靠这个挡掉，不去猜服务器 locale。日期
 * 兼容两种：GNU --time-style=long-iso 两段（2026-10-01 12:34），C locale
 * 三段（Oct  1 12:34 / Oct  1  2025）——文件名带空格也不怕，日期之后全归名字。
 */
export function parseLsLong(out: string): RemoteFile[] {
  const files: RemoteFile[] = []
  const now = Date.now()
  for (const line of out.split(/\r?\n/)) {
    if (!/^[-dlbcps][rwxstST-]{9}/.test(line)) continue
    const isDir = line[0] === 'd'
    const f = line.slice(10).trim().split(/\s+/)
    // SELinux 的「.」/ ACL 的「+」/ macOS 的「@」直接缀在权限位后面（drwxr-xr-x.），
    // RHEL 系的 /var/log 几乎行行都带——不剥掉会把后面所有字段顶歪一位，
    // 日期进名字、整行作废（真机第一天就撞上）
    if (f[0] === '.' || f[0] === '+' || f[0] === '@') f.shift()
    if (f.length < 6) continue
    const size = Number(f[3])
    let mtime: number | null = null
    let mtimeText = ''
    let nameFrom: number
    if (/^\d{4}-\d{2}-\d{2}$/.test(f[4])) {
      nameFrom = 6
      mtimeText = `${f[4]} ${f[5]}`
      mtime = parseIsoLocal(f[4], f[5])
    } else if (MONTHS.has((f[4] ?? '').toUpperCase())) {
      nameFrom = 7
      mtimeText = `${f[4]} ${f[5]} ${f[6]}`
      mtime = parseCTime(f[4], f[5], f[6], now)
    } else {
      // 日期格式没认出来：名字照切（保守从第 6 段起），文件还在，时间不装懂
      nameFrom = 6
    }
    let name = f.slice(nameFrom).join(' ')
    if (!name) continue
    const arrow = name.indexOf(' -> ')
    // symlink 只留链接名：tail/sed 打开时会自己跟过去
    if (arrow > 0) name = name.slice(0, arrow)
    // 本目录 / 上级不进列表——「上一级」按钮已经管了导航，. 只会添乱
    if (name === '.' || name === '..') continue
    files.push({
      name,
      sizeBytes: Number.isFinite(size) && size >= 0 ? size : 0,
      isDir,
      mtime,
      mtimeText,
    })
  }
  return files
}

/** 目录在前，其余按时间新→旧（没时间的垫底按名字）——找「最近写的日志」是这个浏览器的唯一任务 */
export function sortRemoteFiles(files: RemoteFile[]): RemoteFile[] {
  return [...files].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    const ta = a.mtime ?? Number.NEGATIVE_INFINITY
    const tb = b.mtime ?? Number.NEGATIVE_INFINITY
    if (ta !== tb) return tb - ta
    return a.name.localeCompare(b.name)
  })
}

/** `/var/log` → `/`；`/var/log/` → `/var`（尾斜杠当目录名的一部分先剥掉） */
export function parentDir(p: string): string {
  let t = p.trim()
  while (t.length > 1 && t.endsWith('/')) t = t.slice(0, -1)
  const i = t.lastIndexOf('/')
  if (i <= 0) return '/'
  return t.slice(0, i) || '/'
}

/**
 * 路径模糊兜底的拆段：`/app/log/shop` 在服务器上不存在时，退到上级 `/app/log`
 * 拿尾段 `shop` 当关键字模糊找。只认绝对路径（相对路径没有可靠的「上级」），
 * 根目录 `/` 没有尾段，都不兜。尾斜杠无害：`/app/log/shop/` 照样拆出 shop。
 */
export function splitFuzzyPath(p: string): { parent: string; last: string } | null {
  const t = p.trim()
  if (!t.startsWith('/') || t === '/') return null
  const parts = t.split('/').filter(Boolean)
  if (parts.length === 0) return null
  return { parent: '/' + parts.slice(0, -1).join('/'), last: parts[parts.length - 1] }
}

/**
 * 「路径不存在」的失败才值得模糊兜底（权限不足、连不上都不是换关键字能救的）。
 * 判的是 guessSshError 翻译后的人话—— sshCollect 抛出来的就是它，raw stderr
 * 在 collect 里已经丢了。有测试把两边的短语钉在一起，改翻译不至于悄悄失灵。
 */
export function isMissingPathError(message: string): boolean {
  return message.includes('服务器上没有这个文件或目录')
}

export function joinRemote(dir: string, name: string): string {
  const d = dir.trim().replace(/\/+$/, '')
  return d ? `${d}/${name}` : `/${name}`
}

/**
 * ssh 的报错翻译成人话。exit 255 + stderr 里的固定短语是 ssh 自己的错，
 * 其他是远端命令的错——用户要的是「下一步该查什么」，不是错误码。
 */
export function guessSshError(stderr: string, exitCode: number | null): string {
  const s = stderr.toLowerCase()
  if (/permission denied\s*\((publickey|password|keyboard-interactive)/.test(s)) {
    return '服务器拒绝了登录：用户名或密码不对，也可能这台机器只让用私钥。查一下用户名；用私钥的话确认这台电脑的密钥已加到服务器的 authorized_keys。'
  }
  if (s.includes('remote host identification has changed') || s.includes('host key verification failed')) {
    return '服务器指纹变了，ssh 出于安全拒绝连接。如果最近重装过这台服务器，把本机 known_hosts（%USERPROFILE%\\.ssh\\known_hosts）里对应那行删掉再连。'
  }
  if (s.includes('could not resolve hostname')) {
    return '主机名解析不了：检查 IP / 域名有没有写错，本机网络通不通。'
  }
  if (s.includes('connection refused')) {
    return '对端拒绝了连接：确认 sshd 在跑、端口写对了（默认 22）。'
  }
  if (/timed?\s*out/.test(s)) {
    return '连接超时：检查 IP、端口，防火墙 / 安全组有没有放行这个端口。'
  }
  if (s.includes('no such file or directory')) {
    return '服务器上没有这个文件或目录——注意大小写，路径要用绝对路径。'
  }
  if (s.includes('is a directory')) {
    return '选中的是个目录，进目录挑一个日志文件。'
  }
  if (s.includes('permission denied')) {
    return '登录成功了，但当前用户没有读这个文件的权限。'
  }
  if (s.includes('command not found') || s.includes('is not recognized')) {
    return '服务器上没有 ls / tail 这类命令（可能不是 Linux）。拉日志目前只支持 Linux 服务器。'
  }
  if (s.includes('connection closed by') || s.includes('reset by peer')) {
    return '连接被服务器断开：可能被防火墙 / 堡垒机策略拦了，或并发连接数受限。'
  }
  if (exitCode === null) {
    return '连接已取消。'
  }
  const tail = stderr.trim().split(/\r?\n/).slice(-3).join(' ')
  return `连接或执行失败（退出码 ${exitCode}）：${tail || '服务器没有返回原因'}`
}

/** 全树搜最多列几条；服务器上多要一条，好知道「后面还有」 */
export const FIND_LIMIT = 300

/**
 * 全树搜日志：往下 8 层找「相对路径含关键字」的普通文件，不分大小写，空格隔开的
 * 几个词要同时出现。按路径而不是只按文件名搜：k8s 的服务名在目录上，文件本身
 * 多半叫 info.log。GNU find 带回时间和大小，服务器上先按新→旧排好再截；
 * busybox 的 find 没有 -printf，退成只给路径。
 */
export function cmdFind(dir: string, kw: string): { cmd: string } | { error: string } {
  const k = kw.trim()
  if (!k) return { error: '先填要搜的关键字' }
  if (k.length > 100) return { error: '关键字太长了，搜个短的' }
  // 引号和反斜杠会让 awk 变量串变味：直接剥掉——搜的是路径片段，不是表达式
  const safe = k.replace(/['"\\]/g, '')
  if (!safe.trim()) return { error: '关键字里只有引号，没法搜' }
  const d = quotedPath(dir)
  // 只拿起点以下的那段比：起点自己带关键字（/app/shop-log）时不至于全中
  const pick =
    `awk -F'\\t' -v d=${d} -v k=${sq(safe)} 'BEGIN{n=split(tolower(k),w," ")}` +
    `{p=(NF>=3?$3:$0);r=tolower(substr(p,length(d)+1));for(i=1;i<=n;i++)if(!index(r,w[i]))next;print}'`
  const cap = `head -${FIND_LIMIT + 1}`
  return {
    cmd:
      `if find ${d} -maxdepth 0 -printf '' >/dev/null 2>&1; then ` +
      `find ${d} -maxdepth 8 -type f -printf '%T@\\t%s\\t%p\\n' 2>/dev/null | ${pick} | sort -rn | ${cap}; ` +
      `else find ${d} -maxdepth 8 -type f 2>/dev/null | ${pick} | ${cap}; fi`,
  }
}

export interface FoundFile {
  path: string
  /** GNU find 才带得回来，busybox 只有路径 */
  sizeBytes: number | null
  mtime: number | null
}

/** cmdFind 的输出 → 命中列表（去空行去重保序）；多出来的那条只用来报「还有更多」 */
export function parseFindHits(out: string): { hits: FoundFile[]; more: boolean } {
  const seen = new Set<string>()
  const hits: FoundFile[] = []
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d+(?:\.\d+)?)\t(\d+)\t(.+)$/.exec(line)
    const path = (m ? m[3] : line).trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    hits.push({ path, sizeBytes: m ? Number(m[2]) : null, mtime: m ? Math.round(Number(m[1]) * 1000) : null })
  }
  return { hits: hits.slice(0, FIND_LIMIT), more: hits.length > FIND_LIMIT }
}

/** 命中路径拆成「文件名 + 相对搜索起点的目录」：侧栏窄，名字单独一行才看得全 */
export function hitParts(root: string, path: string): { name: string; dir: string } {
  const i = path.lastIndexOf('/')
  const name = path.slice(i + 1)
  const parent = i > 0 ? path.slice(0, i) : '/'
  const r = root.trim().replace(/\/+$/, '')
  if (parent === r) return { name, dir: '' }
  return { name, dir: r && parent.startsWith(`${r}/`) ? parent.slice(r.length + 1) : parent }
}

/** 毫秒时间戳 → 本机时区的「2026-10-09 14:05」 */
export function fmtMtime(ms: number): string {
  const t = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`
}

/** `/app/log/shop` → 根、app、log、shop 四段，每段带自己的完整路径（面包屑用） */
export function pathCrumbs(p: string): { label: string; path: string }[] {
  const parts = p.trim().split('/').filter(Boolean)
  return [{ label: '/', path: '/' }, ...parts.map((label, i) => ({ label, path: `/${parts.slice(0, i + 1).join('/')}` }))]
}

/**
 * 原始字节 → 文本。先按 UTF-8 严格解，不合法按 GBK——跟 Rust 侧本机文件的
 * 判定同一策略（那边是 BOM + 64KB 采样，这边整段在手就不用采样了）。
 */
export function decodeBytesSmart(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'gbk' } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }
  } catch {
    // 严格解失败 ≠ 就是 GBK：拉取按字节上限掐断时，尾巴可能正好切在一个
    // 多字节字符中间，整段 64MB 会被误判成 GBK 全屏乱码。先掐掉最后 1～3 个
    // 字节再严格试一次，能过就说明只是尾字符被切，仍按 UTF-8 解（残缺的那
    // 一个字符变替换符，不影响前面的内容）
    // 头部同理：服务器上 `tail -c` 只留尾巴时，开头可能是半个字符——只跳真正的
    // UTF-8 续字节（10xxxxxx），随便跳几个字节会让短的 GBK 文本也「凑巧合法」
    let head = 0
    while (head < 3 && head < bytes.length && (bytes[head]! & 0xc0) === 0x80) head++
    for (let cut = 0; cut <= 3; cut++) {
      if (head + cut === 0 || bytes.length <= head + cut) continue
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(head, bytes.length - cut))
        return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' }
      } catch {
        /* 不是这个深度，继续试更长的掐尾 */
      }
    }
    return { text: new TextDecoder('gbk').decode(bytes), encoding: 'gbk' }
  }
}
