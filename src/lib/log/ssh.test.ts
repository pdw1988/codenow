import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildPullCmd,
  cmdFind,
  cmdLs,
  cmdLsAbs,
  splitPwd,
  cmdWcLines,
  decodeBytesSmart,
  dropPartialHead,
  guessSshError,
  isMissingPathError,
  joinRemote,
  parentDir,
  FIND_LIMIT,
  fmtMtime,
  hitParts,
  parseFindHits,
  pathCrumbs,
  parseLsLong,
  parseWcInt,
  safeRemotePath,
  sortRemoteFiles,
  splitFuzzyPath,
  sq,
  sshLabel,
  sshTarget,
} from './ssh'

test('sq：无单引号的路径两端加引号', () => {
  assert.equal(sq('/var/log/app.log'), `'/var/log/app.log'`)
})

test('sq：路径里的单引号要闭合再转义', () => {
  assert.equal(sq(`it's.log`), `'it'\\''s.log'`)
})

test('safeRemotePath：以 - 开头的路径垫 ./ 防止被当选项', () => {
  assert.equal(safeRemotePath('-weird.log'), './-weird.log')
  assert.equal(safeRemotePath('/var/log'), '/var/log')
})

test('sshTarget：分开填的用户名和主机会拼起来，整段粘贴的不重复拼', () => {
  assert.equal(sshTarget('app', '10.0.0.5'), 'app@10.0.0.5')
  assert.equal(sshTarget('', 'app@10.0.0.5'), 'app@10.0.0.5')
})

test('cmdLs：带引号，且 busybox 没有 --time-style 时就地回退普通 ls', () => {
  const cmd = cmdLs('/var/log')
  assert.ok(cmd.includes(`'/var/log'`), cmd)
  assert.ok(cmd.includes('--time-style=long-iso'), cmd)
  assert.ok(cmd.includes('|| ls -la'), cmd)
})

test('cmdLsAbs：先 cd 再 pwd 再 ls，路径带引号', () => {
  const cmd = cmdLsAbs('.')
  assert.ok(cmd.startsWith(`cd '.' && pwd && `), cmd)
  assert.ok(cmd.includes('ls -la'), cmd)
})

test('splitPwd：首行绝对路径拆出来，不是就原样返回', () => {
  assert.deepEqual(splitPwd('/home/app\ntotal 8\nx\n'), { dir: '/home/app', rest: 'total 8\nx\n' })
  assert.deepEqual(splitPwd('total 8\n'), { dir: null, rest: 'total 8\n' })
  assert.deepEqual(splitPwd('/root'), { dir: '/root', rest: '' })
})

test('cmdWcLines：重定向取数字，不带文件名噪声', () => {
  assert.equal(cmdWcLines('/var/log/a.log'), `wc -l < '/var/log/a.log'`)
})

test('buildPullCmd：tail 正常拼；行数超上限报人话错', () => {
  const ok = buildPullCmd('/var/log/a.log', { kind: 'tail', n: 200_000 })
  assert.ok('cmd' in ok && ok.cmd.startsWith(`tail -n 200000 '/var/log/a.log' | LC_ALL=C awk 'length($0)>60000{`), JSON.stringify(ok))
  // 带字节上限：先截超长行，再在服务器上只留尾巴，丢的是最旧的那段
  const capped = buildPullCmd('/var/log/a.log', { kind: 'tail', n: 10, maxBytes: 1024 })
  assert.ok('cmd' in capped && /^tail -n 10 '\/var\/log\/a\.log' \| LC_ALL=C awk .+ \| tail -c 1024$/.test(capped.cmd), JSON.stringify(capped))
  assert.equal(dropPartialHead('半行\n整行1\n整行2'), '整行1\n整行2')
  assert.equal(dropPartialHead('没有换行'), '没有换行')
  // 开头是半个汉字（tail -c 切的）：仍按 UTF-8，不整段误判 GBK
  const full = new TextEncoder().encode('中文日志\n第二行也是中文\n')
  assert.equal(decodeBytesSmart(full.subarray(1)).encoding, 'utf-8')
  const bad = buildPullCmd('/var/log/a.log', { kind: 'tail', n: 900_000 })
  assert.ok('error' in bad && bad.error.includes('最多'), JSON.stringify(bad))
})

test('buildPullCmd：区间正常拼；起止颠倒、非整数、区间过大都拦下', () => {
  const r = buildPullCmd('/a.log', { kind: 'range', from: 5, to: 10 })
  assert.ok('cmd' in r && r.cmd.startsWith(`sed -n '5,10p' '/a.log' | LC_ALL=C awk `), JSON.stringify(r))
  assert.ok('error' in buildPullCmd('/a.log', { kind: 'range', from: 10, to: 5 }))
  assert.ok('error' in buildPullCmd('/a.log', { kind: 'range', from: 1.5, to: 10 }))
  assert.ok('error' in buildPullCmd('/a.log', { kind: 'range', from: 1, to: 2_000_000 }))
  assert.ok('error' in buildPullCmd('', { kind: 'tail', n: 10 }))
})

test('parseWcInt：吃得下 wc 的前导空格，错误信息给 null', () => {
  assert.equal(parseWcInt('  123456\n'), 123456)
  assert.equal(parseWcInt('bash: line 0: x'), null)
})

test('parseLsLong：long-iso 日期、名字带空格、total 行跳过', () => {
  const files = parseLsLong(
    [
      'total 12345',
      '-rw-r--r-- 1 app app 2048 2026-10-01 12:34 app.log',
      '-rw-r--r-- 1 app app 512 2026-09-30 08:01 error log.txt',
    ].join('\n'),
  )
  assert.equal(files.length, 2)
  assert.equal(files[0].name, 'app.log')
  assert.equal(files[0].sizeBytes, 2048)
  assert.equal(files[0].isDir, false)
  assert.equal(files[0].mtimeText, '2026-10-01 12:34')
  assert.ok(files[0].mtime !== null)
  assert.equal(files[1].name, 'error log.txt')
})

test('parseLsLong：C locale 近期文件省年份按今年，跨年退去年', () => {
  const files = parseLsLong(
    ['-rw-r--r-- 1 app app 4096 Oct  1 09:15 catalina.out', '-rw-r--r-- 1 app app 4096 Nov  3  2025 old.log'].join('\n'),
  )
  assert.equal(files[0].name, 'catalina.out')
  assert.equal(files[0].mtimeText, 'Oct 1 09:15')
  const now = new Date()
  const recent = new Date(files[0].mtime!)
  assert.equal(recent.getFullYear(), now.getFullYear())
  assert.equal(recent.getMonth(), 9)
  assert.equal(files[1].name, 'old.log')
  assert.equal(new Date(files[1].mtime!).getFullYear(), 2025)
})

test('parseLsLong：目录、symlink 留链接名、告警行不进列表', () => {
  const files = parseLsLong(
    [
      'ls: cannot open xxx: Permission denied',
      'drwxr-xr-x 2 app app 4096 Oct  1 09:00 archive',
      'lrwxrwxrwx 1 app app 11 Oct  1 09:00 latest -> app.log',
    ].join('\n'),
  )
  assert.equal(files.length, 2)
  assert.equal(files[0].name, 'archive')
  assert.equal(files[0].isDir, true)
  assert.equal(files[1].name, 'latest')
})

test('parseLsLong：SELinux 权限位尾巴（drwxr-x---.）不把字段顶歪——真机 /var/log 撞出来的', () => {
  const files = parseLsLong(
    [
      'drwxr-x---. 2 root root 4096 2026-10-02 03:21 audit',
      'drwxr-xr-x+ 3 app app 4096 Oct  1 09:15 acl目录',
      'lrwxrwxrwx. 1 root root 11 Oct  1 09:00 latest -> app.log',
    ].join('\n'),
  )
  assert.equal(files.length, 3)
  assert.equal(files[0].name, 'audit')
  assert.equal(files[0].mtimeText, '2026-10-02 03:21')
  assert.equal(files[0].isDir, true)
  assert.equal(files[1].name, 'acl目录')
  assert.equal(files[2].name, 'latest')
})

test('parseLsLong：. 和 .. 不进列表（导航有「上一级」按钮了）', () => {
  const files = parseLsLong(
    [
      'drwxr-xr-x 21 root root 4096 2026-10-02 03:21 .',
      'drwxr-xr-x 1 root root 4096 2026-10-01 09:00 ..',
      'drwxr-xr-x 2 root root 4096 2026-10-01 09:00 app',
    ].join('\n'),
  )
  assert.deepEqual(
    files.map((f) => f.name),
    ['app'],
  )
})

test('sortRemoteFiles：目录在前，文件按时间新到旧，没时间的垫底', () => {
  const sorted = sortRemoteFiles([
    { name: 'b.log', sizeBytes: 1, isDir: false, mtime: 200, mtimeText: 'b' },
    { name: 'dir', sizeBytes: 0, isDir: true, mtime: 100, mtimeText: '' },
    { name: 'a.log', sizeBytes: 1, isDir: false, mtime: null, mtimeText: '' },
    { name: 'c.log', sizeBytes: 1, isDir: false, mtime: 300, mtimeText: 'c' },
  ])
  assert.deepEqual(
    sorted.map((f) => f.name),
    ['dir', 'c.log', 'b.log', 'a.log'],
  )
})

test('parentDir / joinRemote：目录导航的基本功', () => {
  assert.equal(parentDir('/var/log'), '/var')
  assert.equal(parentDir('/var/log/'), '/var')
  assert.equal(parentDir('/'), '/')
  assert.equal(parentDir('logs'), '/')
  assert.equal(joinRemote('/var/log', 'app.log'), '/var/log/app.log')
  assert.equal(joinRemote('/var/log/', 'app.log'), '/var/log/app.log')
})

test('guessSshError：登录被拒、指纹变化、解析失败、远端没文件各说各话', () => {
  assert.ok(guessSshError('ssh: Permission denied (publickey,password).', 255).includes('用户名或密码'))
  assert.ok(guessSshError('REMOTE HOST IDENTIFICATION HAS CHANGED!', 255).includes('指纹'))
  assert.ok(guessSshError('ssh: Could not resolve hostname abc: Name or service not known', 255).includes('解析'))
  assert.ok(guessSshError('tail: cannot open app.log: No such file or directory', 1).includes('没有这个文件'))
  assert.ok(guessSshError('tail: error reading app.log: Is a directory', 1).includes('目录'))
  assert.ok(guessSshError('ls: cannot open .: Permission denied', 2).includes('没有读'))
})

test('guessSshError：认不出的错把退出码和 stderr 尾巴带上', () => {
  const msg = guessSshError('something weird\nhappened', 7)
  assert.ok(msg.includes('7'), msg)
  assert.ok(msg.includes('happened'), msg)
})

test('cmdFind：目录加引号、按路径筛、GNU 按时间排、busybox 退路、结果封顶', () => {
  const ok = cmdFind('/app/log', 'shop')
  assert.ok('cmd' in ok, JSON.stringify(ok))
  if (!('cmd' in ok)) return
  assert.ok(ok.cmd.includes(`find '/app/log' -maxdepth 8 -type f -printf '%T@\\t%s\\t%p\\n'`), ok.cmd)
  assert.ok(ok.cmd.includes(`-v d='/app/log' -v k='shop'`), ok.cmd)
  assert.ok(ok.cmd.includes('| sort -rn | head -301'), ok.cmd)
  assert.ok(ok.cmd.includes(`else find '/app/log' -maxdepth 8 -type f 2>/dev/null |`), ok.cmd)
  assert.ok('error' in cmdFind('/app/log', '  '))
  assert.ok('error' in cmdFind('/app/log', ''))
  assert.ok('error' in cmdFind('/app/log', `'"\\`))
})

test('cmdFind：剥掉引号反斜杠但保留普通字符', () => {
  const r = cmdFind('/app/log', `or'der.log`)
  assert.ok('cmd' in r && r.cmd.includes(`-v k='order.log'`), JSON.stringify(r))
})

test('parseFindHits：带时间大小的行和只有路径的行都认，去空行去重保序', () => {
  const r = parseFindHits('1728450000.5\t2048\t/app/log/shop/a b.log\n\n/app/log/shop/b.log\n/app/log/shop/b.log\n')
  assert.deepEqual(r.hits, [
    { path: '/app/log/shop/a b.log', sizeBytes: 2048, mtime: 1728450000500 },
    { path: '/app/log/shop/b.log', sizeBytes: null, mtime: null },
  ])
  assert.equal(r.more, false)
  assert.deepEqual(parseFindHits(''), { hits: [], more: false })
})

test('parseFindHits：多出上限的那条不列，只报还有更多', () => {
  const out = Array.from({ length: FIND_LIMIT + 1 }, (_, i) => `/l/${i}.log`).join('\n')
  const r = parseFindHits(out)
  assert.equal(r.hits.length, FIND_LIMIT)
  assert.equal(r.more, true)
})

test('hitParts：名字和相对起点的目录分开，起点带不带尾斜杠一样', () => {
  assert.deepEqual(hitParts('/app/log', '/app/log/shop/pod-1/info.log'), { name: 'info.log', dir: 'shop/pod-1' })
  assert.deepEqual(hitParts('/app/log/', '/app/log/info.log'), { name: 'info.log', dir: '' })
  assert.deepEqual(hitParts('/app/log', '/other/x.log'), { name: 'x.log', dir: '/other' })
  // 同前缀但不是子目录：/app/logs 不算 /app/log 里面
  assert.deepEqual(hitParts('/app/log', '/app/logs/x.log'), { name: 'x.log', dir: '/app/logs' })
})

test('pathCrumbs：根加每一段，尾斜杠和连续斜杠不出空段', () => {
  assert.deepEqual(pathCrumbs('/app//log/'), [
    { label: '/', path: '/' },
    { label: 'app', path: '/app' },
    { label: 'log', path: '/app/log' },
  ])
  assert.deepEqual(pathCrumbs('/'), [{ label: '/', path: '/' }])
})

test('fmtMtime：本机时区到分钟', () => {
  assert.equal(fmtMtime(new Date(2026, 9, 9, 8, 5, 59).getTime()), '2026-10-09 08:05')
})

test('sshLabel：按「:/」切出 user@host，IPv6 的冒号不背锅', () => {
  assert.equal(sshLabel('app@10.0.0.5:/var/log/a.log'), 'app@10.0.0.5')
  // IPv6：地址里一堆冒号，split(':') 会把主机切成「app@[fd00」
  assert.equal(sshLabel('app@[fd00::5]:/var/log/a.log'), 'app@[fd00::5]')
  assert.equal(sshLabel('app@10.0.0.5'), 'app@10.0.0.5')
})

test('decodeBytesSmart：按字节上限掐断切在多字节中间，仍按 UTF-8 解而不是全屏 GBK 乱码', () => {
  const full = new TextEncoder().encode('2026-10-01 ERROR 服务异常')
  // 掐掉最后 2 个字节：最后一个 3 字节汉字只剩前 1 个字节，严格解必炸
  const cut = full.subarray(0, full.length - 2)
  const r = decodeBytesSmart(new Uint8Array(cut))
  assert.equal(r.encoding, 'utf-8')
  assert.ok(r.text.startsWith('2026-10-01 ERROR 服务异'), JSON.stringify(r))
  // 真GBK（整段没有一处合法 UTF-8）：掐尾救不回来，照样落 GBK
  const gbk = new Uint8Array([0xc8, 0xd5, 0xd6, 0xbe, 0xc8, 0xd5])
  assert.equal(decodeBytesSmart(gbk).encoding, 'gbk')
})

test('decodeBytesSmart：UTF-8、BOM、GBK、空各归各位', () => {
  const utf8 = new TextEncoder().encode('hello 日志')
  assert.deepEqual(decodeBytesSmart(utf8), { text: 'hello 日志', encoding: 'utf-8' })
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8])
  assert.deepEqual(decodeBytesSmart(bom), { text: 'hello 日志', encoding: 'utf-8' })
  // 「日志」的 GBK 字节：C8D5 D6BE——按 UTF-8 解不合法，会落到 GBK
  assert.deepEqual(decodeBytesSmart(new Uint8Array([0xc8, 0xd5, 0xd6, 0xbe])), {
    text: '日志',
    encoding: 'gbk',
  })
  assert.deepEqual(decodeBytesSmart(new Uint8Array(0)), { text: '', encoding: 'utf-8' })
})

test('splitFuzzyPath：不存在的路径拆出上级和尾段，模糊兜底用', () => {
  assert.deepEqual(splitFuzzyPath('/app/log/shop'), { parent: '/app/log', last: 'shop' })
  // 尾斜杠不当目录名：照样拆出 shop
  assert.deepEqual(splitFuzzyPath('/app/log/shop/'), { parent: '/app/log', last: 'shop' })
  // 顶层目录的上级是根
  assert.deepEqual(splitFuzzyPath('/app'), { parent: '/', last: 'app' })
  // 根目录没有尾段、相对路径没有可靠上级：都不兜
  assert.equal(splitFuzzyPath('/'), null)
  assert.equal(splitFuzzyPath('app/log'), null)
})

test('isMissingPathError：认得 guessSshError 翻译后的「没这个文件」，别的错不认', () => {
  // 钉住两边的短语：改 guessSshError 的翻译而不改这里，兜底会悄悄失灵
  const missing = guessSshError('ls: /app/log/shop: No such file or directory', 2)
  assert.equal(isMissingPathError(missing), true)
  assert.equal(isMissingPathError(guessSshError('ls: /x: Permission denied', 2)), false)
  assert.equal(isMissingPathError('连接超时：检查 IP、端口'), false)
})
