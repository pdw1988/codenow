/**
 * 用 CDP 驱动 headless Edge 实测导航里的功能页。
 * 导航以 pages.ts 的 PAGES 为准。2026-09-22 码上写、正则测试器、JSONPath 查询
 * 三条一起回到导航，逐页快照循环随导航一起加回（此前它们暂退，整段摘除过）。
 * 这三页没有专门的走查段：快照 + 控制台无 error 就是它们的验收。
 * SELECT转UPDATE 已加回：走查从 948345c^ 取回后按默认方言 oracle、表名 ORDER 改过断言。
 * 2026-10-10 单表/多表/批量、日志转SQL、SELECT转UPDATE 暂退导航：它们的专项走查先 inNav
 * 判断，不在菜单里就整段跳过（不算失败），页面回到菜单自动恢复。
 * Node 24 自带 WebSocket，不需要 puppeteer。
 *
 * 壳层已经从 antd Tabs 换成自研的 .app/.rail/.pagehost（见 AppShell.tsx），
 * 所以「当前页」的判定是 `.pagehost:not([hidden])`，导航是 .rail .nav button。
 * 所有页面同时挂在 DOM 里（hidden 切换），找元素必须限定在当前 pagehost 里。
 */
const CDP = 'http://127.0.0.1:9333'

const targets = await (await fetch(`${CDP}/json/list`)).json()
let page = targets.find((t) => t.type === 'page')
if (!page) {
  await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })
  page = (await (await fetch(`${CDP}/json/list`)).json()).find((t) => t.type === 'page')
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))

let id = 0
const pending = new Map()
const logs = []
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    // 参数序列化到 preview 一层：React 的告警 key 值 / 组件栈都在后续参数里，
    // 只拼 value 会把定位信息全丢掉（2026-10-01 追「重复 key」时吃的亏）
    const serA = (a) =>
      a.value !== undefined
        ? typeof a.value === 'string'
          ? a.value
          : JSON.stringify(a.value)
        : a.description ??
          (a.preview ? '{' + (a.preview.properties ?? []).map((p) => `${p.name}=${p.value}`).join(', ') + '}' : '')
    logs.push(`[console.${msg.params.type}] ${msg.params.args.map(serA).join(' § ')}`)
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    logs.push(`[exception] ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`)
  }
}
const send = (method, params = {}) =>
  new Promise((res) => {
    const n = ++id
    pending.set(n, res)
    ws.send(JSON.stringify({ id: n, method, params }))
  })

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result?.result?.value
}
/** 每步开始前打一行进度：中途崩了也能看出死在哪一段，而不是只拿到一行裸异常 */
const mark = (s) => console.log(`▶ [${Date.now()}] ${s}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// React 的「重复 key」告警参数经 CDP consoleAPICalled 转发会整段丢掉（key 值 /
// 组件栈都不在），在页面里原地截 console.error 计数；一旦响了，fiber 走查把
// 还在渲染重复 children 的组件链揪出来（容器上的 __reactContainer$ 是当前树的
// 根 fiber，WIP 半成品树挂在它的 .alternate 上——2026-10-01 追「两个空 option」
// 时摸清的形状）。dupKeyN 进 allOk：这类告警挡门。
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (function () {
    var orig = console.error
    function nameOf(t) {
      if (!t) return '(root)'
      if (typeof t === 'function') return t.displayName || t.name || '(fn)'
      if (typeof t === 'string') return t
      if (t.type) return nameOf(t.type)
      return '?'
    }
    function findDups() {
      try {
        var rootEl = document.getElementById('root')
        if (!rootEl) return
        var ck = Object.keys(rootEl).find(function (k) { return k.indexOf('__reactContainer$') === 0 })
        if (!ck || !rootEl[ck]) return
        var out = []
        var seen = 0
        function scan(kids, f, names) {
          if (!Array.isArray(kids) || seen > 200000) return
          var keys = []
          for (var j = 0; j < kids.length; j++) {
            seen++
            var c = kids[j]
            if (Array.isArray(c)) { scan(c, f, names); continue }
            if (c && c.key != null) keys.push(String(c.key))
          }
          var dups = keys.filter(function (k, i) { return keys.indexOf(k) !== i })
          if (dups.length) {
            var vals = []
            for (var j2 = 0; j2 < kids.length; j2++) {
              var c2 = kids[j2]
              if (c2 && c2.props) vals.push(String(c2.props.value ?? '?') + '=' + String(c2.props.children ?? '?').slice(0, 20))
            }
            out.push({ comp: names.join(' < '), keys: Array.from(new Set(dups)).slice(0, 4), vals: vals.slice(0, 6) })
          }
        }
        function walk(f) {
          while (f && seen < 200000) {
            seen++
            var names = []
            var p = f.return
            for (var d = 0; p && d < 8; d++) { names.unshift(nameOf(p.type)); p = p.return }
            scan((f.memoizedProps || {}).children, f, names)
            scan((f.pendingProps || {}).children, f, names)
            if (f.child) walk(f.child)
            f = f.sibling
          }
        }
        var rf = rootEl[ck]
        var roots = [rf]
        if (rf.alternate) roots.push(rf.alternate)
        for (var ri = 0; ri < roots.length; ri++) walk(roots[ri])
        if (out.length) window.__dupComps = ((window.__dupComps || []).concat(out)).slice(0, 40)
      } catch (e) { window.__dupComps = [{ err: String(e) }] }
    }
    console.error = function () {
      try {
        if (String(arguments[0]).indexOf('two children with the same key') !== -1) {
          ;(window.__dupKeys = window.__dupKeys || []).push({ k: String(arguments[1]), phase: window.__phase || 'pre' })
          findDups()
        }
      } catch (e) {}
      return orig.apply(this, arguments)
    }
  })()
` })

/** 当前可见的功能页。六个 pagehost 同时挂着，靠 hidden 切换 */
const ACTIVE = `document.querySelector('.pagehost:not([hidden])')`

await send('Runtime.enable')
await send('Page.enable')

// 崩了也要把攒到的控制台消息倒出来，不然死因跟着进程一起埋掉
process.on('uncaughtException', (err) => {
  console.error('\n💥 崩在半路：', err.message)
  if (logs.length) console.error('--- 之前攒的控制台消息 ---\n' + logs.join('\n'))
  ws.close()
  process.exit(1)
})

mark('加载页面（第一次）')
await send('Page.navigate', { url: 'http://localhost:5173/' })
await sleep(3500)
// 上一次跑留下的 localStorage 会把起始页钉在任意一个 tab 上（useUiStore 持久化了 activeTab）。
// 先清掉再刷新，保证每次都从第一页开始、缓存里都是种子数据。
await evaluate(`localStorage.clear(); 'ok'`)
mark('清掉持久化状态，重新加载')
await send('Page.navigate', { url: 'http://localhost:5173/' })
// 等 .rail 真挂出来再继续——固定睡多久都会赶上冷启动慢的那次
for (let i = 0; i < 40; i++) {
  const n = await evaluate(`document.querySelectorAll('.rail .nav button').length`)
  // 16 个功能页 + 2 个一级分组标题 + 2 个折叠开关 = 20，增减后记得同步。
  // 阈值别卡满：分组被用户收起时下面的页根本不在 DOM 里
  if (n >= 14) break
  await sleep(500)
}
await sleep(800)
// 页面里注册几个取节点的辅助函数。
// pane()/p()：当前可见的 pagehost。找不到就抛异常——静默降级会让选择器坏掉却一直报告成功。
// modal()/m()：当前打开的弹窗。弹窗挂在 body 的 portal 上，不在 pagehost 里，
//   查弹窗内容绝对不能用 p()。目前只有导出 DDL / 编辑表结构两个弹窗还在用 antd Modal。
// btn()/norm()：按文字找按钮。必须先去掉空白：antd 会在两个汉字的按钮里插一个空格，
//   「取消」在 DOM 里其实是「取 消」，直接 includes('取消') 永远找不到。
// type()：受控输入得走原型 setter + input 事件；textarea / select 各有各的 prototype。
await evaluate(`window.pane = () => ${ACTIVE};
  window.p = () => { const x = window.pane(); if (!x) throw new Error('PAGEHOST NOT FOUND'); return x };
  window.modal = () => [...document.querySelectorAll('.ant-modal-wrap')]
    .find(w => w.style.display !== 'none' && w.getClientRects().length > 0) ?? null;
  window.m = () => { const x = window.modal(); if (!x) throw new Error('MODAL NOT FOUND'); return x };
  window.norm = (s) => (s ?? '').replace(/\\s+/g, '');
  window.btn = (root, text) => [...root.querySelectorAll('button')]
    .find(b => norm(b.innerText).includes(norm(text))) ?? null;
  window.btnEq = (root, text) => [...root.querySelectorAll('button')]
    .find(b => norm(b.innerText) === norm(text)) ?? null;
  window.cardByTitle = (root, title) => [...root.querySelectorAll('.card')]
    .find(c => norm(c.querySelector('.chead .h')?.innerText ?? '') === norm(title)) ?? null;
  // 值面板的小节按标题定位，不按下标：加一栏就整体错位，而且错位后断言照样「通过」
  window.vsecOf = (root, label) => [...root.querySelectorAll('.vsec')]
    .find(v => (v.querySelector(':scope > .lbl')?.innerText ?? '').includes(label)) ?? null;
  window.vTable = (root, label) => vsecOf(root, label)?.querySelector('table.tbl') ?? null;
  window.mouse = (el) => {
    for (const t of ['mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    }
  };
  window.type = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  window.pressEnter = (el) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  'ok'`)

// 清掉导航之前攒下的控制台消息：改代码时 HMR 会把半成品推给还开着的旧页面，
// 那些崩溃跟本次跑的代码无关，留着会让报告看起来有 bug 其实没有。
logs.length = 0

// 点左侧导航。各页名字靠字数区分，includes 足够。
// 用 textContent 而不是 innerText：窗口一窄主题就把 .nav button span 藏起来
// （_theme.css 的响应式规则），innerText 里只剩图标，按 innerText 找永远找不到。
// 找不到就抛：静默返回会让后面每一步都在错的前提下「跑成功」
const clickNav = async (label) => {
  const r = await evaluate(`(() => {
    const all = [...document.querySelectorAll('.rail .nav button')];
    // 一级分组（码上查 / 小工具）也是 button，分组标题右侧的折叠开关
    // （.navfold，文字只有 ▾/▸）也是。按页名点的时候跳过它们，否则
    // includes('SQL') 会先命中「码上查」而不是「单表 SQL」。
    const pages = all.filter(x => !x.classList.contains('navtop') && !x.classList.contains('navfold'));
    const b = pages.find(x => norm(x.textContent).includes(norm(${JSON.stringify(label)})))
      ?? all.find(x => norm(x.textContent).includes(norm(${JSON.stringify(label)})));
    if (!b) return 'NOT FOUND: ' + all.map(x => x.textContent).join(' | ');
    b.click(); return 'clicked';
  })()`)
  if (typeof r === 'string' && r.startsWith('NOT FOUND')) throw new Error('导航点不到「' + label + '」：' + r)
  return r
}

// 菜单里有没有这一页。页面暂退导航时，它的专项走查整段跳过（不算失败）
const inNav = async (label) =>
  evaluate(`[...document.querySelectorAll('.rail .nav button')].some(x => norm(x.textContent).includes(norm(${JSON.stringify(label)})))`)

const snapshot = async () =>
  evaluate(`(() => {
    const pane = ${ACTIVE};
    return {
      chars: pane ? pane.innerText.length : 0,
      head: pane ? pane.innerText.slice(0, 260).replace(/\\n{2,}/g,'\\n') : '(空)',
      // 只看当前页里的红色提示带：全部页面都挂在 DOM 里，全文档查会把别的页算到这一页头上
      errors: [...(pane ?? document).querySelectorAll('.band.err')].map(e => e.innerText.slice(0,120)),
    };
  })()`)

mark('① 全部页面逐页快照')
const report = []
// 只快照导航里实际存在的页（pages.ts 的 PAGES，标签与顺序跟它保持一致）。
// 「码上测」不在这个循环里：它自己页内有七个子页签，逐页快照会连带触发扫描，
// 另走专门的段（要跑就单独跑，别塞进这个每页 1 秒的快照循环）。
for (const label of ['导入表结构', '查看表结构', '连库查询', '优化记录', '我的连接', '我的SQL库', '码上写', 'JSON查看', 'Cron表达式']) {
  const clicked = await clickNav(label)
  await sleep(1000)
  const snap = await snapshot()
  report.push({ tab: label, clicked, ...snap })
}

// 优化记录的空态：新开的浏览器没有任何记录，四张卡里「记录」那张必须说明
// 下一步该干什么，而不是给一块空白（用户第一次点进来看到空白会以为功能坏了）。
// 连库链路原本 e2e 走不到（没装 Tauri 时连库按钮是禁用的），所以优化记录这里只钉
// 空态和统计归零。2026-09-25 起末尾的「查询框分流」段给页面注入 Tauri IPC 桩
// （window.__TAURI_INTERNALS__.invoke，按命令回假数据、调用全记录），
// 连库查询的整条链——连接、SELECT 直跑、UPDATE 确认、取消不执行——在浏览器里真跑一遍。
await clickNav('优化记录')
await sleep(800)
const adv = await evaluate(`(() => {
  const rec = cardByTitle(p(), '记录');
  const sta = p().querySelector('.stats');
  return {
    recFound: rec !== null,
    emptyHint: rec ? norm(rec.innerText).includes('还没有记录') : false,
    // 统计卡里四项全 0：数据不是写死的演示数字。
    // 只读 .v 那个数字格，别整块 innerText —— 「最近 7 天」的标题本身就带个 7
    stats: sta ? [...sta.querySelectorAll('.stat .v')].map(s => norm(s.innerText)) : [],
  };
})()`)
adv.ok = adv.recFound && adv.emptyHint && adv.stats.length === 4 && adv.stats.every(s => /^(0|—|-)$/.test(s))

// 走一遍真实主流程：粘贴 DDL → 实时预览 → 确认导入 → 速查
//
// 下面找按钮一律限定在当前 pagehost（btn(p(), …)）里，不查整个 document。
// 导航里的三页同时挂着，「日志转SQL」页上也有同名的按钮/输入框——
// 全文档 find 会点到别的页去，后面整条链路就全在错的前提下跑。
mark('② 主流程：填示例 → 粘贴确认导入 → 速查')
await clickNav('导入表结构')
await sleep(800)
const flow = {}
flow.fillSample = await evaluate(`(() => {
  const b = btn(p(), '填示例');
  if (!b) return 'no 填示例 button';
  b.click(); return 'ok';
})()`)
await sleep(800)
// 没有「解析」按钮了：粘完即预览。断言的是绿色结果带和统计块真的出现了
flow.previewBand = await evaluate(`(() => {
  const band = [...p().querySelectorAll('.band.ok')].find(b => b.innerText.includes('解析出'));
  const stats = [...p().querySelectorAll('.stat')].map(s => norm(s.innerText)).slice(0, 4);
  return { band: band?.innerText.replace(/\\n/g, ' ').slice(0, 120) ?? null, stats };
})()`)
// 导入没有手动按钮（评审定稿：只走「粘贴 → 是否导入」确认框）。示例是 setSql 填的、
// 不触发粘贴，所以补发一个 paste 事件把确认框引出来。合成的 paste 没有浏览器默认行为
// （不会真插入文本），而本页 onPaste 只数粘贴次数、文本靠 onChange 进 state——
// 所以不清空输入框，让 sql 保持在「已粘了示例」的状态，确认框才能数出表来
flow.pasteDispatch = await evaluate(`(() => {
  const ta = p().querySelector('textarea');
  if (!ta) return 'no textarea';
  if (!ta.value.trim()) return 'empty textarea';
  const dt = new DataTransfer();
  dt.setData('text', ta.value);
  ta.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  return 'pasted';
})()`)
await sleep(900)
// modal.confirm 挂在 body 的 portal 上，不在 pagehost 里——按 CLAUDE.md 的规矩查 document；
// 按文字找按钮先 norm()：antd 会在两个汉字的按钮里插空格
flow.confirmImport = await evaluate(`(() => {
  const ok = [...document.querySelectorAll('.ant-modal .ant-btn')]
    .find(b => norm(b.innerText) === '导入');
  if (!ok) return 'no confirm dialog';
  ok.click(); return 'ok';
})()`)
await sleep(2000)
flow.afterImport = await evaluate(`(() => ({
  activeNav: document.querySelector('.rail .nav button.on')?.innerText.replace(/\\n/g, ' '),
  stayBand: [...p().querySelectorAll('.band.ok')].find(b => b.innerText.includes('已导入'))?.innerText.replace(/\\n/g, ' ').slice(0, 120) ?? null,
}))()`)

// 导入不再自动跳页（评审定稿：结果留在导入页，标签换「已导入」），
// 要去速查页得自己点导航 —— stayBand 顺带断言了「导入后预览还在本页」
await clickNav('查看表结构')
await sleep(800)

// 搜一张刚导入的表，展开看字段（后面点「生成 SQL」要靠卡片真的在）
flow.search = await evaluate(`(() => {
  // 速查页的搜索框是裸 <input>（.searchbox 里），不是 .fld —— 别拿错到模板输入框上
  const input = p().querySelector('.searchbox input');
  if (!input) return 'no search input';
  type(input, 'order');
  return 'typed order';
})()`)
await sleep(1200)
flow.searchResult = await evaluate(`(() => {
  const hits = [...p().querySelectorAll('.card.foldable > .chead .h')].map(h => h.innerText.replace(/\\n/g, ' '));
  return hits.slice(0, 6);
})()`)
flow.expand = await evaluate(`(() => {
  const c = [...p().querySelectorAll('.card.foldable')].find(x => x.innerText.includes('ORDER'));
  if (!c) return 'no order card';
  const head = c.querySelector('.chead');
  if (!head) return 'no chead';
  if (c.classList.contains('on')) return 'already expanded';
  head.click(); return 'expanded';
})()`)
await sleep(1000)
flow.columns = await evaluate(`(() => {
  const c = [...p().querySelectorAll('.card.foldable')].find(x => x.classList.contains('on'));
  const rows = [...(c?.querySelectorAll('table.tbl tbody tr') ?? [])].map(r => r.innerText.replace(/\\n/g,' | '));
  return rows.slice(0, 8);
})()`)
// 速查卡的「生成 SQL」按钮用 pageInNav 门着：单表 SQL 在菜单里，按钮必须在且点了真跳到
// 单表 SQL 页；不在菜单里，按钮必须藏起来（点了也没地方去）。
if (await inNav('单表 SQL')) {
  await evaluate(`(() => { btn(p(), '生成 SQL')?.click() })()`)
  await sleep(900)
  flow.genJump = await evaluate(`(() => {
    const page = p();
    // 单表 SQL 页的标志卡是「选表和语句」+ 结果卡的 .sgen-out。别的页没有这两个
    return {
      onSql: !!page.querySelector('.sgen-out'),
      picked: !!page.querySelector('.card.foldable, .card'),
    };
  })()`)
} else {
  flow.genJump = await evaluate(`(() => ({ skipped: true, btnHidden: !btn(p(), '生成 SQL') }))()`)
}

// 生成SQL 页暂退导航，它上面的三段走查（模板存/套用、可执行值面板、SELECT 条件勾选）
// 整段摘了——留在原地只会对着速查页报一堆假失败。恢复导航时从 git 历史整段取回，
// 别凭记忆重写（同配置管理走查段的处理）。

// ---- 导出 DDL / 编辑表结构（表卡片上的两个按钮，弹窗仍是 antd Modal）----
mark('③ 导出 DDL / 编辑表结构弹窗')
await clickNav('查看表结构')
await sleep(1000)
const card = {}
card.expand = await evaluate(`(() => {
  const target = [...p().querySelectorAll('.card.foldable')].find(x => x.innerText.includes('ORDER'));
  if (!target) return 'no order card';
  if (target.classList.contains('on')) return 'already expanded';
  target.querySelector('.chead')?.click();
  return 'expanded';
})()`)
await sleep(1000)
card.openDdl = await evaluate(`(() => {
  const b = btn(p(), '导出 DDL');
  if (!b) return 'no 导出 DDL button'; b.click(); return 'ok';
})()`)
await sleep(1200)
card.ddl = await evaluate(`(() => {
  const pre = m().querySelector('pre');
  return { head: pre ? pre.innerText.slice(0, 420) : '(弹窗里没有 pre)' };
})()`)
// 换方言：PostgreSQL 用双引号且 IDENTITY，跟 MySQL 的反引号 / AUTO_INCREMENT 必须不一样。
// 弹窗里地方小，方言用的是 DialectSeg（自研 Seg 按钮），不是 antd Select——
// 旧版那套 mousedown 三连的坑在这里用不上了，点按钮就行
card.switchDialect = await evaluate(`(() => {
  const b = btnEq(m(), 'PostgreSQL');
  if (!b) return 'no PostgreSQL seg'; b.click(); return 'ok';
})()`)
await sleep(1000)
card.ddlPg = await evaluate(`(() => {
  const pre = m().querySelector('pre');
  return pre ? pre.innerText.slice(0, 420) : '(无)';
})()`)
card.closeDdl = await evaluate(`(() => {
  const x = m().querySelector('.ant-modal-close');
  if (!x) return 'no close button'; x.click(); return 'ok';
})()`)
await sleep(900)

card.openEdit = await evaluate(`(() => {
  const b = btn(p(), '编辑表结构');
  if (!b) return 'no 编辑表结构 button'; b.click(); return 'ok';
})()`)
await sleep(1200)
card.editRows = await evaluate(`(() => {
  // 编辑弹窗里是自研 Tbl（.tbl），不是 antd 表格；字段名/类型/长度是带 aria-label 的 Fld
  const rows = [...m().querySelectorAll('.tbl tbody tr')];
  const val = (row, label) => row?.querySelector('input[aria-label="' + label + '"]')?.value ?? '';
  return {
    rowCount: rows.length,
    firstRow: [val(rows[0], '字段名'), val(rows[0], '类型'), val(rows[0], '长度')].join(' | '),
    lastRow: [val(rows.at(-1), '字段名'), val(rows.at(-1), '类型'), val(rows.at(-1), '长度')].join(' | '),
    editableInputs: m().querySelectorAll('.tbl tbody input').length,
  };
})()`)
// 类型列的常用类型下拉（自研 TypePick）：点 ▾ 出清单、点选项回填输入框。
// 清单只列基础类型词，长度/精度在旁边独立的「长度」列填（类型和长度拆成两列）。
// 必须真点一遍——光看「箭头按钮存在」证明不了清单和回填是通的
card.typePickOpen = await evaluate(`(() => {
  const arrow = m().querySelector('.tbl tbody tr .typepick > button');
  if (!arrow) return 'no typepick arrow'; arrow.click(); return 'ok';
})()`)
await sleep(400)
// TypePick 的清单是自己 portal 到 body 的（跟 PopSel 一样，为了不被带
// backdrop-filter 的卡片裁掉），所以查 document 不查 m()。按 m() 查会一条都找不到，
// 报「no DECIMAL item」——那是脚本查错了地方，页面的下拉其实是好的。
card.typePickItems = await evaluate(`(() =>
  document.querySelectorAll('.typepick-pop button').length
)()`)
card.typePickApply = await evaluate(`(() => {
  const item = [...document.querySelectorAll('.typepick-pop button')].find(b => b.textContent === 'DECIMAL');
  if (!item) return 'no DECIMAL item';
  item.click(); return 'ok';
})()`)
await sleep(400)
// 值和「弹层已收起」分开读：React 的状态更新是批处理的，点完同一拍读 DOM 拿到的是旧值
card.typePickValue = await evaluate(`(() =>
  m().querySelector('.tbl tbody tr input[aria-label="类型"]')?.value ?? '(no input)'
)()`)
// 长度是独立一列：DECIMAL 的精度带小数位一起写（12,2），拼回去必须还是 DECIMAL(12,2)
card.lenFill = await evaluate(`(() => {
  const input = m().querySelector('.tbl tbody tr input[aria-label="长度"]');
  if (!input) return 'no length input';
  window.type(input, '12,2');
  return 'ok';
})()`)
await sleep(400)
card.lenValue = await evaluate(`(() =>
  m().querySelector('.tbl tbody tr input[aria-label="长度"]')?.value ?? '(no input)'
)()`)
// 收起也要按 body 查：清单 portal 在 body 里，查 m() 永远是 null，
// 那样这条断言等于没写（点了不收起也照样「通过」）
card.typePickClosed = await evaluate(`(() => document.querySelector('.typepick-pop') === null)()`)
// 增量 DDL：类型一改，弹窗下方的 ALTER 块就得实时跟上（默认 oracle，MODIFY (…) 形态）。
// 再切到 MySQL 验证方言切换真的反映进语句：DECIMAL(12,2) 原样出现（oracle 下会被翻译成 NUMBER）
card.alterShown = await evaluate(`(() => {
  const pre = [...m().querySelectorAll('.code pre')].map(x => x.innerText).join('\\n');
  return { hasAlter: pre.includes('ALTER TABLE'), stmts: (pre.match(/ALTER TABLE/g) ?? []).length };
})()`)
card.alterMysqlClick = await evaluate(`(() => {
  const b = btnEq(m(), 'MySQL');
  if (!b) return 'no dialect seg'; b.click(); return 'ok';
})()`)
await sleep(400)
card.alterMysql = await evaluate(`(() => {
  const pre = [...m().querySelectorAll('.code pre')].map(x => x.innerText).join('\\n');
  return {
    modify: pre.includes('MODIFY COLUMN'),
    declaredType: pre.includes('DECIMAL(12,2)'),
    noDrop: !pre.includes('DROP COLUMN'),
  };
})()`)
// 改个字段名：派生的 Java 映射不再占一列（注释要宽度），悬停字段名框能看到
card.renameField = await evaluate(`(() => {
  const input = m().querySelector('.tbl tbody tr input[aria-label="字段名"]');
  if (!input) return 'no name input';
  type(input, 'order_no_x');
  return 'renamed';
})()`)
await sleep(800)
card.afterRename = await evaluate(`(() => {
  const input = m().querySelector('.tbl tbody tr input[aria-label="字段名"]');
  return {
    name: input?.value ?? '(no input)',
    derivedTitle: input?.title ?? '',
  };
})()`)
// 取消退出，不要把改动写进缓存——后面还要跑别的断言。
// Dlg 把按钮放进自己的 .acts 里，antd 的 footer 是被置空的，别去 .ant-modal-footer 找
card.cancelEdit = await evaluate(`(() => {
  const b = btn(m().querySelector('.acts'), '取消');
  if (!b) return 'no cancel button'; b.click(); return 'ok';
})()`)
await sleep(900)
card.closed = await evaluate(`(() => window.modal() === null)()`)
card.dialectDiffers = card.ddl.head !== card.ddlPg
// 类型下拉五连：箭头在、清单 ≥ 20 条、点选真的填进了类型框、长度框填的 12,2
// 能和类型词拼回 DECIMAL(12,2)（见下方 alterMysql.declaredType）、填完弹层自己收起
card.typePickOk =
  card.typePickOpen === 'ok' &&
  card.typePickItems >= 20 &&
  card.typePickApply === 'ok' &&
  card.typePickValue === 'DECIMAL' &&
  card.lenFill === 'ok' &&
  card.lenValue === '12,2' &&
  card.typePickClosed
// 增量 DDL 三连：改了类型 ALTER 就得出现；切 MySQL 后整份 MODIFY 重定义、
// 用户写的类型原样在（说明类型翻译只在切方言时发生）；这步没增删字段，不该有 DROP
card.alterOk =
  card.alterShown.hasAlter &&
  card.alterShown.stmts >= 1 &&
  card.alterMysqlClick === 'ok' &&
  card.alterMysql.modify &&
  card.alterMysql.declaredType &&
  card.alterMysql.noDrop

// ---- Tab 布局：只有 .pane 滚动，顶栏和侧栏固定 ----
// 壳换成自研之后这条断言换了对象，但目的没变：哪天有人把 overflow 写回 body 上，
// 整页跟着滚、顶栏被滚走，这里要第一个红。
mark('④ 页面布局')
const layout = await evaluate(`(() => {
  const pane = p().querySelector('.pane');
  return {
    paneFound: pane !== null,
    paneOverflowY: pane ? getComputedStyle(pane).overflowY : '?',
    paneScrollable: pane ? pane.scrollHeight > pane.clientHeight : false,
    docScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 2,
    navFound: document.querySelector('.rail .nav button.on') !== null,
  };
})()`)
layout.ok = layout.paneFound && ['auto', 'scroll'].includes(layout.paneOverflowY) && !layout.docScrolls

// ---- 码上写：行号编辑器不许被行号栏撑高 ----
// 2026-09-22 的 bug：行号栏是几十个 <i>，留在文档流里就成了 flex 行的最高项，
// 默认的 align-items:stretch 把编辑器一起顶到「行数 × 21px」—— 粘一段长配置
// 进来，输入框直接长出屏幕外（用户报「JSON 一粘进来框就顶到底」）。
// 页面上肉眼一眼看见，四道闸门全绿：只有量高度才抓得到。
// 断言挑能证伪的量：粘 80 行前后 clientHeight 必须一模一样，且行号栏自己也被裁在框内。
await clickNav('码上写')
await sleep(800)
const edBefore = await evaluate(`(() => {
  const ta = p().querySelector('.edwrap textarea');
  return ta ? ta.clientHeight : -1;
})()`)
await evaluate(`(() => {
  const ta = p().querySelector('.edwrap textarea');
  if (!ta) return;
  window.type(ta, Array.from({ length: 80 }, (_, i) =>
    'server.list[' + i + '].host: h' + i).join('\\n'));
})()`)
await sleep(400)
const edAfter = await evaluate(`(() => {
  const ta = p().querySelector('.edwrap textarea');
  const gut = p().querySelector('.edwrap .gut');
  const pane = p().querySelector('.pane');
  return {
    h: ta ? ta.clientHeight : -1,
    gutH: gut ? gut.clientHeight : -1,
    paneH: pane ? pane.clientHeight : -1,
  };
})()`)
const editorOk =
  edBefore > 0 &&
  edAfter.h === edBefore &&
  edAfter.h <= edAfter.paneH &&
  edAfter.gutH <= edAfter.h + 1

// ---- 左侧「码上查」整组折叠 ----
// 用户 2026-09-22：「码上查，这个菜单我要能进行收缩」。四道闸门对 CSS 命不中、
// localStorage 键写错、折叠后组标题点不动，全都照不到——只有真浏览器量得出。
// 断言挑能证伪的量：折叠后面板按钮必须**正好少 6 个**（= pages.ts 里码上查组的页数，改菜单要跟着改；多一个说明别组被连带收起，
// 少一个说明自己没折），aria-expanded 变成 'false'，localStorage 里留下 'db'，
// 并且**收起后点组标题仍能进那几页**（`.on` 落在组标题上）——这条是防
// 「折叠了但整组点不动」的，那种改法按钮数是对的，功能是残的。
// 先跳到「码上写」（在码上查组外）是为了让 `before` 有判别力：站在原地量的话，
// 组标题本来带 `.on`，折不折叠都分不出来。
await clickNav('码上写')
await sleep(400)
const navFold = await evaluate(`(async () => {
  // 点完必须让出一个宏任务再量：React 的离散事件更新排进微任务，
  // 同一个同步函数里紧跟一句读 DOM，读到的还是上一帧
  const tick = () => new Promise(r => setTimeout(r, 30));
  const pages = () => [...document.querySelectorAll('.rail .nav button')]
    .filter(x => !x.classList.contains('navtop') && !x.classList.contains('navfold'));
  const sw = [...document.querySelectorAll('.rail .nav .navfold')]
    .find(b => norm(b.title).includes('码上查'));
  // 组标题按 title 属性比（「码上查 · 点这里进第一项」）。以前按 span 的
  // textContent 比——2026-09-30 图标换单色组件后 <em> 里先出现一个空的 <span>，
  // querySelector('span') 摸到的是图标的，标题永远比不中
  const top = [...document.querySelectorAll('.rail .nav .navtop')]
    .find(b => norm(b.title).startsWith('码上查'));
  if (!sw || !top) return { err: '找不到「码上查」的折叠开关 / 组标题' };
  const open = pages().length;
  const before = top.classList.contains('on');
  sw.click();
  await tick();
  const folded = pages().length;
  const expanded = sw.getAttribute('aria-expanded');
  const stored = localStorage.getItem('devtools.nav.folded.v1');
  top.click();
  await tick();
  const landed = top.classList.contains('on');
  sw.click();
  await tick();
  return { open, folded, expanded, stored, back: pages().length, before, landed };
})()`)
const navFoldOk =
  !navFold.err &&
  navFold.before === false &&
  navFold.folded === navFold.open - 6 &&
  navFold.expanded === 'false' &&
  navFold.landed === true &&
  navFold.back === navFold.open &&
  /db/.test(navFold.stored ?? '')

console.log('\\n\\n===== 左侧「码上查」整组折叠 =====')
console.log(JSON.stringify(navFold, null, 2))
console.log(
  navFold.err
    ? `❌ ${navFold.err}`
    : navFoldOk
      ? '✅ 折叠后面板正好少 6 个按钮，状态落库，收起后组标题仍点得动'
      : '❌ 折叠行为不对——见上面几个量',
)

// ---- JSON 查看：左边 JSON 卡跟右栏一样高 ----
// 右栏是定高的 JSON 树，比输入卡高；左栏不跟着伸的话，
// 卡底下空一块，两栏一大一小（用户 2026-09-22：「跟右边保持一样的长度」）。
// 这条纯 CSS（align-self + .card.fill），改坏了四道闸门全绿，只有量高度抓得到。
// 断言挑能证伪的量：左卡 offsetHeight 必须等于右栏高度，且输入框没被压瘪
// （460 的地板来自 flush tall，压瘪说明 flex 链条里少了 min-height:0）。
await clickNav('JSON查看')
await sleep(800)
const jp = await evaluate(`(() => {
  const split = p().querySelector('.split.even');
  const left = split ? split.querySelector('.col.stretch') : null;
  const cols = split ? split.querySelectorAll(':scope > .col') : [];
  const card = left ? left.querySelector('.card') : null;
  const ta = card ? card.querySelector('textarea') : null;
  return {
    leftH: left ? left.offsetHeight : -1,
    rightH: cols.length === 2 && cols[1] !== left ? cols[1].offsetHeight : -1,
    taH: ta ? ta.clientHeight : -1,
    cardFill: card ? card.classList.contains('fill') : false,
  };
})()`)
const jpOk =
  jp.leftH > 0 &&
  jp.rightH > 0 &&
  Math.abs(jp.leftH - jp.rightH) <= 2 &&
  jp.taH >= 440 &&
  jp.cardFill

// ---- Cron 表达式（PRD 二十）----
// 失败模式不是「没输出」，而是「解读写着每 5 分钟、下一次却显示 3 小时后」——
// 秒段和分段的槽位错一位照样能算出 20 行来。所以断言拿真实时间序列对：
// 每次必须严格晚于上一次、间隔必须是 5 分钟的整数倍（0 0/5 * * * ? 的口径），
// 解读里必须真的出现「每 5 分钟」。再把日 / 周都限死的那条喂进去，
// 它必须点明这是「或」——悄悄按「并且」算的用户会等到天荒地老。
await clickNav('Cron表达式')
await sleep(900)
const cron = await evaluate(`(() => {
  const pane = p();
  const words = pane.querySelector('.cron-words');
  const rows = Array.from(pane.querySelectorAll('.cron-runs tbody tr'));
  const times = rows
    .map((tr) => (tr.children[1] ? tr.children[1].textContent.trim() : ''))
    .filter((t) => /^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$/.test(t));
  const spans = times.slice(1).map((t, i) =>
    (new Date(t.replace(' ', 'T')) - new Date(times[i].replace(' ', 'T'))) / 1000);
  return {
    expr: pane.querySelector('textarea').value,
    words: words ? words.textContent.trim() : '',
    n: times.length,
    times: times.slice(0, 3),
    spans,
    bad: !!pane.querySelector('.band.err'),
    // 窄列折行是「看得见但四道闸门照不到」的那类毛病：表头「星期」两字加 td
    // 左右各 12px 内边距要 49px，列宽写 40 就被折成「星 / 期」，表头行高从 28px
    // 涨到 41px（用户 2026-09-22 提的）。按行盒数量判，不按高度猜——高度还受
    // mono 行高影响，说不上来是哪个单元格折的
    thLines: Array.from(pane.querySelectorAll('.cron-runs thead th')).map((h) => {
      const r = document.createRange();
      r.selectNodeContents(h);
      return r.getClientRects().length;
    }),
    // 「21 小时 53 分后」约 103px，比 118 - 24 内边距 = 94px 宽，不锁 nowrap 会偶发折行
    relNowrap: getComputedStyle(
      pane.querySelector('.cron-runs tbody tr td:nth-child(4)') ?? document.body,
    ).whiteSpace,
  };
})()`)
// 点「工作日 09:00」：周段 MON-FRI + 只在 9 点，产物文案必须带「工作日」，
// 且接下来 20 次全是 9 点整、且一次都不落在周六周日。
await evaluate(`(() => {
  const btns = Array.from(p().querySelectorAll('.pre-grid button'));
  const b = btns.find((x) => x.textContent.trim() === '工作日 09:00');
  if (b) b.click();
})()`)
await sleep(400)
const cronWeek = await evaluate(`(() => {
  const pane = p();
  const words = pane.querySelector('.cron-words');
  const rows = Array.from(pane.querySelectorAll('.cron-runs tbody tr'));
  const hours = rows.map((tr) => (tr.children[1] ? tr.children[1].textContent.trim().slice(11, 13) : ''));
  const dows = rows.map((tr) => (tr.children[2] ? tr.children[2].textContent.trim() : ''));
  return {
    expr: pane.querySelector('textarea').value,
    words: words ? words.textContent.trim() : '',
    allAt9: hours.length > 0 && hours.every((h) => h === '09'),
    noWeekend: dows.every((d) => d !== '六' && d !== '日'),
  };
})()`)
// 日 1 号 + 周一都写：必须出现「或」的提示，否则用户会以为是「并且」
await evaluate(`(() => {
  const ta = p().querySelector('textarea');
  window.type(ta, '0 0 0 1 * MON');
})()`)
await sleep(400)
const cronOr = await evaluate(`(() => {
  const words = p().querySelector('.cron-words');
  return words ? words.textContent.trim() : '';
})()`)
// 「字段说明」默认折起，但必须真能展开。onToggle 写成 `() => undefined` 时 Card
// 认为这是张折叠卡、按 CSS 把 cbody 藏了，open 又永远 false —— 用户看到一个
// 能点的箭头，点了毫无反应，「? 与 * 的区别」「日与周的或关系」直接不存在
// （2026-09-22 自己写错过一次）。顺带把这张表的表头也按行盒量一遍：
// 「字段」两字 + td 左右 12px 内边距要 49px，给 46 照样折成「字 / 段」
await evaluate(`(() => {
  const card = Array.from(p().querySelectorAll('.card'))
    .find((c) => norm(c.querySelector('.chead .h')?.textContent ?? '') === '字段说明');
  if (!card) throw new Error('cron 字段说明 card not found');
  card.querySelector('.chead').click();
})()`)
await sleep(400)
const cronSeg = await evaluate(`(() => {
  const card = Array.from(p().querySelectorAll('.card'))
    .find((c) => norm(c.querySelector('.chead .h')?.textContent ?? '') === '字段说明');
  const ths = card ? Array.from(card.querySelectorAll('table.tbl thead th')) : [];
  return {
    open: !!card?.classList.contains('on'),
    bodyH: card?.querySelector('.cbody').offsetHeight ?? -1,
    n: ths.length,
    thLines: ths.map((h) => {
      const r = document.createRange();
      r.selectNodeContents(h);
      return r.getClientRects().length;
    }),
    // 表里那几条真解得开的内容：只断言数量的话，展开的是张空表也算过
    hasLW: !!card && card.textContent.includes('LW=当月最后一个工作日'),
    hasHash: !!card && card.textContent.includes('n#k=当月第 k 个星期 n'),
  };
})()`)
const cronOk =
  cron.bad === false &&
  cron.n === 20 &&
  cron.spans.every((s) => s === 300) &&
  cron.words.includes('每 5 分钟') &&
  cron.thLines.length === 4 &&
  cron.thLines.every((n) => n === 1) &&
  cron.relNowrap === 'nowrap' &&
  cronWeek.expr === '0 0 9 * * MON-FRI' &&
  cronWeek.words.includes('工作日') &&
  cronWeek.allAt9 &&
  cronWeek.noWeekend &&
  cronOr.includes('或') &&
  cronSeg.open &&
  cronSeg.bodyH > 100 &&
  cronSeg.n === 3 &&
  cronSeg.thLines.every((n) => n === 1) &&
  cronSeg.hasLW &&
  cronSeg.hasHash

// ---- 日志转 SQL（PRD 4.14，对话流改版）----
// 这个功能的失败模式是「语句照样能跑，只是数据是错的」，所以断言不能只看「有输出」：
// 粘贴即出卡片（不用点按钮）、批量的每组各出一条、值里的逗号不能被切开、
// 单引号要翻倍、空串是 '' 而不带类型的 null 才是 NULL、参数对照表常驻历史。
const lf = { skipped: !(await inNav('日志转SQL')) }
if (!lf.skipped) {
  await clickNav('日志转SQL')
  await sleep(1000)
  const LOG = [
    // 批量是 Preparing/Parameters 成对重复。别写成一个 Preparing 配两行参数——
    // 那会被解析成一条语句吞下 6 个参数，报「个数对不上」，而那是解析器该干的
    '==>  Preparing: INSERT INTO `order` (order_no, addr, remark) VALUES (?, ?, ?)',
    "==> Parameters: CT20260820000123(String), 北京市, 朝阳区(String), O'Brien(String)",
    '==>  Preparing: INSERT INTO `order` (order_no, addr, remark) VALUES (?, ?, ?)',
    '==> Parameters: CT20260820000124(String), (String), null',
  ].join('\n')
  // 真派发一次 paste 事件：PRD 4.14 要求「贴进来就自动识别」，
  // 而 paste 触发时 textarea.value 还是旧的，读错地方就拿到空串——这条路只能在真浏览器里验。
  lf.paste = await evaluate(`(() => {
    const ta = p().querySelector('.comp textarea');
    if (!ta) return 'no composer textarea';
    const dt = new DataTransfer();
    dt.setData('text', ${JSON.stringify(LOG)});
    ta.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    return 'pasted';
  })()`)
  await sleep(1400)
  lf.turn = await evaluate(`(() => {
    const turns = [...p().querySelectorAll('.turn')];
    const reply = turns.at(-1)?.querySelector('.card');
    const pres = [...(reply?.querySelectorAll('.code pre') ?? [])];
    const sql = pres.map(x => x.innerText).join('\\n');
    return {
      turnCount: turns.length,
      bubble: turns.at(-1)?.querySelector('.me pre')?.innerText.slice(0, 80) ?? null,
      who: reply?.querySelector('.chead .who')?.innerText,
      extraTags: norm(reply?.querySelector('.chead .spacer ~ *')?.innerText ?? reply?.querySelector('.chead')?.innerText ?? ''),
      codeBlocks: pres.length,
      fnNames: [...(reply?.querySelectorAll('.code-bar .fn') ?? [])].map(f => f.innerText),
      // 参数对照表现在是回答卡的一部分（Fold 展开态），不再藏进弹窗
      paramRows: [...(reply?.querySelectorAll('table.tbl tbody tr') ?? [])]
        .slice(0, 3)
        .map(r => r.innerText.replace(/\\n/g, ' | ')),
      sqlHead: sql.slice(0, 500),
      statements: (sql.match(/INSERT INTO/g) ?? []).length,
      // 注释头里不会有 ?，去掉注释后还剩 ? 就说明有占位符没被填上
      leftoverPlaceholder: /\\?/.test(sql.replace(/--.*/g, '')),
      histbar: [...document.querySelectorAll('.histbar button')].map(b => norm(b.innerText)),
    };
  })()`)
  lf.valuesOk =
    lf.turn.statements === 2 &&
    !lf.turn.leftoverPlaceholder &&
    lf.turn.paramRows.some(r => r.includes("'O''Brien'")) &&
    lf.turn.paramRows.some(r => r.includes('北京市, 朝阳区'))

  // 打字追问：固定词表的指令。发一条「复制」，会话里要留一条确认
  lf.cmd = await evaluate(`(() => {
    const ta = p().querySelector('.comp textarea');
    if (!ta) return 'no composer';
    type(ta, '复制');
    pressEnter(ta);
    return 'sent';
  })()`)
  await sleep(1000)
  lf.cmdResult = await evaluate(`(() => {
    const cards = [...p().querySelectorAll('.turn .card')];
    const last = cards.at(-1);
    return {
      who: last?.querySelector('.chead .who')?.innerText,
      ack: norm(last?.innerText ?? '').slice(0, 120),
    };
  })()`)

  // 词表外的输入必须明说认不得，并列出认得的意图——绝不似是而非地回一条
  lf.bad = await evaluate(`(() => {
    const ta = p().querySelector('.comp textarea');
    type(ta, '帮我把这段日志变成接口文档');
    pressEnter(ta);
    return 'sent';
  })()`)
  await sleep(900)
  lf.badResult = await evaluate(`(() => {
    const last = [...p().querySelectorAll('.turn .card')].at(-1);
    const text = norm(last?.innerText ?? '');
    return {
      errCard: last?.classList.contains('err') ?? false,
      who: last?.querySelector('.chead .who')?.innerText,
      listsIntents: text.includes('第N个参数改成X') && text.includes('复制'),
    };
  })()`)

  lf.ok =
    lf.turn.turnCount === 1 &&
    lf.turn.bubble !== null &&
    lf.turn.who === '解析结果' &&
    lf.turn.codeBlocks === 2 &&
    lf.valuesOk &&
    lf.turn.histbar.length >= 1 &&
    lf.cmdResult.who === '已执行' &&
    lf.cmdResult.ack.includes('已复制到剪贴板') &&
    lf.badResult.errCard &&
    lf.badResult.listsIntents

  // ⭐ 收藏：整卡语句存进「我的SQL库」，范围跟「复制全部纯 SQL」一致。
  // 库按内容寻址：同一张卡点两次仍是一条（第二次是置顶，不是新建）；
  // 收藏了得有地方看——顺路把恢复进导航的「我的SQL库」页也验一眼
  lf.fav = await evaluate(`(() => {
    // 2026-09-30 图标化后按钮文字是「 收藏」（⭐ 没了）。这页的收藏一点就存，没有弹框
    const b = btn(p(), '收藏');
    if (!b) return 'no 收藏 button';
    b.click(); return 'clicked';
  })()`)
  await sleep(1200)
  // 浏览器模式走 LocalStorageStore：整包 JSON 落在 devtools.favorites 这个 key 里
  lf.favStored = await evaluate(`(() => {
    const raw = localStorage.getItem('devtools.favorites');
    if (!raw) return 'no favorites blob';
    const items = JSON.parse(raw);
    return { count: items.length, name: items[0]?.name ?? null, tables: items[0]?.tables ?? [] };
  })()`)
  lf.favAgain = await evaluate(`(() => {
    const b = btn(p(), '收藏');
    if (!b) return 'no button';
    b.click(); return 'clicked';
  })()`)
  await sleep(1200)
  lf.favCountAfterAgain = await evaluate(
    `JSON.parse(localStorage.getItem('devtools.favorites') ?? '[]').length`,
  )
  await clickNav('我的SQL库')
  await sleep(1000)
  lf.favPage = await evaluate(`(() => {
    const rows = [...p().querySelectorAll('.favitem')];
    return {
      rows: rows.length,
      first: norm(rows[0]?.innerText ?? '').slice(0, 60),
      hasCopy: rows.some((r) => [...r.querySelectorAll('button')].some((b) => norm(b.innerText) === '复制')),
    };
  })()`)
  lf.favOk =
    lf.fav === 'clicked' &&
    typeof lf.favStored === 'object' &&
    lf.favStored.count === 1 &&
    lf.favStored.name.startsWith('ORDER · ') &&
    lf.favStored.tables.includes('order') &&
    lf.favAgain === 'clicked' &&
    lf.favCountAfterAgain === 1 &&
    lf.favPage.rows >= 1 &&
    lf.favPage.hasCopy
}

// ---- SELECT转UPDATE（PRD v6.4 §4.16）----
// 必须先选表再粘贴：没列头时按表字段顺序对齐，默默拿第一张表会悄悄对错列。
// 走查从 948345c^ 整段取回后改过：先选 ORDER，默认方言 oracle（先点 MySQL
// 再点 Oracle）、Oracle 断言是 "ORDER"、清空只在贴完后的顶栏出现。
// 拍板语义 1（WHERE 只放值有变化的行）是最能证伪的一条：字符串比对通过不代表范围对，
// 必须盯住「谁不在 IN 里」。粘贴走真 paste 事件：onPaste 从 clipboardData 读，
// 读 value 拿到的是旧值——这条路只有真浏览器验得出来。
const s2u = { skipped: !(await inNav('SELECT转UPDATE')) }
if (!s2u.skipped) {
  await clickNav('SELECT转UPDATE')
  await sleep(800)
  const S2U_PASTE = [
    'id | order_no | status | total',
    '101 | NO001 | 0 | 99.00',
    '102 | NO002 | 1 | 199.00',
    '103 | NO003 | 0 | 59.50',
  ].join('\n')
  s2u.pickTable = await evaluate(`(() => {
    const btn = p().querySelector('button.popsel[aria-label="当前表"]');
    if (!btn) return 'no table select';
    btn.click();
    return 'clicked';
  })()`)
  // 弹层是 setOpen 之后 React 渲染出来的 portal，点完那一瞬 DOM 里还没有。
  // 同步接着查选项只会拿到空列表、报「no ORDER option」——那是脚本的时序问题，
  // 不是页面的毛病，而后面整条链都会在这个错的前提下「跑成功」。
  await sleep(300)
  s2u.pickOrder = await evaluate(`(() => {
    const opt = [...document.querySelectorAll('.popsel-pop button[role="option"]')].find(
      (b) => b.getAttribute('data-value') === 'ORDER',
    );
    if (!opt) return 'no ORDER option';
    opt.click();
    return opt.getAttribute('data-value');
  })()`)
  await sleep(300)
  s2u.paste = await evaluate(`(() => {
    const ta = p().querySelector('textarea');
    if (!ta) return 'no textarea';
    const dt = new DataTransfer();
    dt.setData('text', ${JSON.stringify(S2U_PASTE)});
    ta.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    return 'pasted';
  })()`)
  await sleep(800)
  s2u.result = await evaluate(`(() => {
    const sql = [...p().querySelectorAll('.code pre')].map(x => x.innerText).join('\\n');
    return {
      shape: [...p().querySelectorAll('.hint')].map(h => h.innerText).find(t => t.includes('行 ×')) ?? null,
      pkTag: norm([...p().querySelectorAll('.tag')].map(t => t.innerText).find(t => t.includes('缓存')) ?? ''),
      previewRows: p().querySelectorAll('table.tbl tbody tr').length,
      skippedBand: [...p().querySelectorAll('.band')].map(b => b.innerText).find(t => t.includes('已等于目标值')) ?? null,
      autoTag: norm([...p().querySelectorAll('.auto')].map(a => a.innerText).join('')),
      hasSet: /SET[\\s\\S]*= 1/.test(sql),
      inList: sql.includes('(101, 103)'),
      excluded102: !sql.includes('102'),
    };
  })()`)
  s2u.ok =
    s2u.pickTable === 'clicked' &&
    s2u.pickOrder === 'ORDER' &&
    s2u.paste === 'pasted' &&
    (s2u.result.shape ?? '').includes('识别到表头') &&
    // 2026-09-30 状态标签图标化：✅ 换成单色组件，innerText 里不再有 ✅
    s2u.result.pkTag.startsWith('来自表结构缓存') &&
    s2u.result.previewRows === 2 &&
    (s2u.result.skippedBand ?? '').includes('1 行') &&
    s2u.result.autoTag.includes('自动→IN列表') &&
    s2u.result.hasSet &&
    s2u.result.inList &&
    // 已是目标值的 102 绝不能出现在语句里——WHERE 范围错了不报错，只能这么盯
    s2u.result.excluded102

  // 「填示例」必须直接落到**活的**生成态：示例列选取曾把 status 排在样本外，
  // 用户旅程联动（自动勾 status 填 1）永不触发，页面停在「还不能生成」占位注释上——
  // 此时切方言/格式全都看不到变化，用户报的就是「切方言没反应」。钉死两条：
  // 示例贴完就有 UPDATE，且顶栏从 MySQL 切到 Oracle 后引号从反引号换成 "ORDER"。
  s2u.demoClear = await evaluate(`(() => {
    const clear = btn(p(), '返回选表');
    if (!clear) return 'no 返回选表';  clear.click(); return 'ok';
  })()`)
  await sleep(300)
  s2u.demoClick = await evaluate(`(() => {
    const b = btn(p(), '填示例');
    if (!b) return 'no 填示例';
    b.click(); return 'ok';
  })()`)
  await sleep(500)
  const codeText = () =>
    evaluate(`(() => ({
      fn: p().querySelector('.code-bar .fn')?.innerText ?? null,
      sql: [...p().querySelectorAll('.code pre')].map(x => x.innerText).join('\\n'),
      rows: p().querySelectorAll('table.tbl tbody tr').length,
      autoTag: norm([...p().querySelectorAll('.auto')].map(a => a.innerText).join('')),
    }))()`)
  s2u.mysqlClick = await evaluate(`(() => {
    const b = [...p().querySelectorAll('.seg button')].find(x => x.textContent.includes('MySQL'));
    if (!b) return 'no MySQL 按钮';
    b.click(); return 'ok';
  })()`)
  await sleep(400)
  const mysqlSt = await codeText()
  s2u.oracleClick = await evaluate(`(() => {
    const b = [...p().querySelectorAll('.seg button')].find(x => x.textContent.includes('Oracle'));
    if (!b) return 'no Oracle 按钮';
    b.click(); return 'ok';
  })()`)
  await sleep(400)
  const oraSt = await codeText()
  s2u.demoMysql = {
    click: `${s2u.demoClear}/${s2u.demoClick}/${s2u.mysqlClick}`,
    fn: mysqlSt.fn,
    hasUpdate: mysqlSt.sql.includes('UPDATE '),
    rows: mysqlSt.rows,
    autoTag: mysqlSt.autoTag,
  }
  s2u.demoOracle = {
    click: s2u.oracleClick,
    fn: oraSt.fn,
    hasDoubleQuoteId: oraSt.sql.includes('"ORDER"'),
    noBacktick: !oraSt.sql.includes(String.fromCharCode(96)),
  }
  s2u.demoOk =
    s2u.demoMysql.click === 'ok/ok/ok' &&
    String(s2u.demoMysql.fn).includes('_mysql') &&
    s2u.demoMysql.hasUpdate &&
    s2u.demoMysql.rows === 4 &&
    s2u.demoMysql.autoTag.includes('自动→IN列表') &&
    s2u.demoOracle.click === 'ok' &&
    String(s2u.demoOracle.fn).includes('_oracle') &&
    s2u.demoOracle.hasDoubleQuoteId &&
    s2u.demoOracle.noBacktick
}

console.log('===== 各页渲染 =====')
for (const r of report) {
  console.log(`\\n[${r.tab}] click=${r.clicked} 文本长度=${r.chars}`)
  console.log('  ' + r.head.split('\\n').slice(0, 5).join('\\n  '))
  if (r.errors.length) console.log('  ⚠️ error bands:', r.errors)
}
console.log('\\n\\n===== 主流程实测 =====')
console.log(JSON.stringify(flow, null, 2))
console.log('\\n\\n===== 导出 DDL / 编辑表结构 =====')
console.log(JSON.stringify(card, null, 2))
console.log(
  card.dialectDiffers
    ? '✅ 切到 PostgreSQL 后 DDL 确实变了'
    : '❌ 换方言没有改变输出（Select 没点开？还是翻译没生效？）',
)
console.log('\\n\\n===== 页面布局 =====')
console.log(JSON.stringify(layout, null, 2))
console.log(
  layout.ok
    ? '✅ pane 自己滚，整页不滚'
    : '❌ 布局 CSS 没生效——检查 _theme.css 里 .pane 的 overflow',
)
console.log('\\n\\n===== 码上写：长配置的输入框高度 =====')
console.log(JSON.stringify({ before: edBefore, after: edAfter }, null, 2))
console.log(
  editorOk
    ? '✅ 粘 80 行配置，输入框高度没变（行号栏裁在框内跟着滚）'
    : '❌ 输入框被行号栏撑高了——检查 _theme.css 里 .edwrap .gut 的定位',
)
console.log('\\n\\n===== JSON 查看：左栏 JSON 卡高度 =====')
console.log(JSON.stringify(jp, null, 2))
console.log(
  jpOk
    ? '✅ JSON 输入卡跟右栏一样高，输入框没被压瘪'
    : '❌ 左卡没跟上右栏高度——检查 JsonPathQuery 的 stretch/fill 与 .card.fill 的 flex 链',
)
console.log('\\n\\n===== Cron 表达式（PRD 二十）=====')
console.log(JSON.stringify({ ...cron, week: cronWeek, or: cronOr, seg: cronSeg }, null, 2))
console.log(
  cronOk
    ? '✅ 每 5 分钟那条的 20 次间隔全是 300 秒，窄列表头没折行，工作日那条只在 9 点、不落周末，日与周都限死时点明是「或」，字段说明点得开且表头没折行'
    : '❌ Cron 不对：次数 / 间隔 / 窄列折行 / 解读文案 / 或关系 / 字段说明折叠有一条没对上',
)
console.log('\\n\\n===== 日志转 SQL（PRD 4.14 对话流）=====')
if (lf.skipped) console.log('⏭ 日志转SQL 不在菜单里，跳过')
else {
  console.log(JSON.stringify({ ...lf, turn: { ...lf.turn, sqlHead: lf.turn.sqlHead.slice(0, 200) } }, null, 2))
  console.log(
    lf.ok
      ? `✅ 粘贴即出卡片，${lf.turn.statements} 组参数各出一条语句，对照表常驻；指令和词表外的输入都按约定走`
      : '❌ 对话流不对：粘贴没出卡 / 批量少了语句 / 对照表不在 / 指令或报错卡没按约定来',
  )
  console.log(
    lf.favOk
      ? '✅ ⭐ 收藏整卡入我的SQL库：自动起名带表名，同卡重按不重复建，页里看得见'
      : '❌ 收藏链路不通（按钮没点上 / 库里条数不对 / 页面看不到）',
  )
}
console.log('\\n\\n===== SELECT转UPDATE（PRD v6.4 §4.16）=====')
if (s2u.skipped) console.log('⏭ SELECT转UPDATE 不在菜单里，跳过')
else {
  console.log(JSON.stringify(s2u, null, 2))
  console.log(
    s2u.ok
      ? `✅ 真粘贴出 ${s2u.result.previewRows} 行变化进 IN 列表，已一致的行留在 WHERE 外，主键走缓存识别，自动选中 IN 格式`
      : '❌ SELECT转UPDATE 不对：粘贴没解析 / 主键没认上 / 预览或跳过数不对 / WHERE 范围混进了已一致的行 / 自动格式不对',
  )
  console.log(
    s2u.demoOk
      ? `✅ 填示例直接落到活的生成态（${s2u.demoMysql.rows} 行进预览 ${s2u.demoMysql.autoTag}），切 Oracle 引号变 "ORDER"`
      : `❌ 填示例 / 切方言不对 ${JSON.stringify({ mysql: s2u.demoMysql, oracle: s2u.demoOracle })}`,
  )
}
console.log('\\n\\n===== 优化记录（连库查询的历史）=====')
console.log(JSON.stringify(adv, null, 2))
console.log(
  adv.ok
    ? '✅ 空态说明下一步该干什么，统计四项归零（不是写死的演示数字）'
    : '❌ 优化记录页空态不对：没有「记录」卡 / 没提示怎么产生第一条 / 统计有残留数字',
)
console.log('\n\n===== 查询框分流：SELECT 直跑 / UPDATE 确认 / 取消不执行（v1.7.0）=====')
mark('连库查询：注入 Tauri IPC 桩，连库链路第一次在浏览器里真跑')
await clickNav('连库查询')
await sleep(600)
const qsplit = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const NL = String.fromCharCode(10);
  const out = { connectOk: false, selectOk: false, selectNoExec: false, confirmOk: false, previewOk: false, cancelOk: false, execOk: false };
  const waitFor = async (fn, tries, ms) => {
    for (let i = 0; i < (tries ?? 30); i++) {
      const v = fn();
      if (v) return v;
      await sleep(ms ?? 250);
    }
    throw new Error('waitFor 超时');
  };
  // —— IPC 桩：调用全记进 __ipc，按命令回形状正确的假数据 ——
  window.__ipc = [];
  window.__TAURI_INTERNALS__ = { invoke: async (cmd, args) => {
    window.__ipc.push([cmd, args ?? null]);
    if (cmd === 'oracle_connect') return { version: 'e2e-mock', tables: [{ tname: 'T_ORDER', tcmt: '订单' }, { tname: 'T_USER', tcmt: '用户' }], counts: [{ tname: 'T_ORDER', n: 2 }], fks: [] };
    if (cmd === 'oracle_columns') return [
      { cname: 'ID', dtype: 'NUMBER', dprec: '25', dscale: '0', cnull: 'N', pk: 'Y' },
      { cname: 'STATUS', dtype: 'NUMBER', dprec: '3', dscale: '0', cnull: 'Y' },
      { cname: 'BUYER_NAME', dtype: 'VARCHAR2', dlen: '80', cnull: 'Y' },
    ];
    if (cmd === 'oracle_query') return { columns: ['ID', 'BUYER_NAME'], rows: [['1', '张三'], ['2', '李四']], truncated: false, cap: 200 };
    if (cmd === 'oracle_exec_ddl') return { affected: 1, ran: 1 };
    // 桩一挂，Rail 的更新检查就以为自己在桌面版（v1.7.0 真踩到：它弹了「发现新版本」
    // 空版本号的框，挡在确认断言前面）。version 给真值、check 回 null＝无更新
    if (cmd === 'plugin:app|version') return '1.7.0';
    if (cmd === 'plugin:updater|check') return null;
    return [];
  } };

  const field = (label) => { const el = window.p().querySelector('[aria-label="' + label + '"]'); if (!el) throw new Error('no field: ' + label); return el; };
  const ta = () => window.p().querySelector('[aria-label="查询 SQL"]');
  const runBtn = () => [...window.p().querySelectorAll('button')].find((b) => window.norm(b.innerText) === '运行');
  const modal = () => [...document.querySelectorAll('.ant-modal-wrap')].find((w) => w.style.display !== 'none' && w.getClientRects().length > 0) ?? null;
  const ddlCalls = () => window.__ipc.filter((c) => c[0] === 'oracle_exec_ddl');
  const clickModalBtn = (root, text) => { const b = [...root.querySelectorAll('button')].find((x) => window.norm(x.innerText) === text); if (!b) throw new Error('no modal button: ' + text); b.click(); };
  // warn → sql 两段确认有挂载/动画竞态（同一脚本两次跑死在不同步），不按固定顺序点：
  // 屏上是 warn 就点继续，见到「确定改删」就是预览框到了；谁都不像就把它记进诊断
  const reachSqlDlg = async () => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await sleep(200);
      const m = modal();
      if (!m) continue;
      const t = window.norm(m.innerText);
      if (t.includes('将改删行')) { out.sawWarn = true; clickModalBtn(m, '继续'); continue; }
      if (t.includes('确定改删')) return m;
      out.lastModalText = m.innerText.slice(0, 200);
    }
    throw new Error('8 秒内没到预览确认框' + (out.lastModalText ? '，最后停在：' + out.lastModalText : ''));
  };

  // 连库：默认 Oracle / 测试环境。填表单点「连接并读取」，等查询框挂出来
  window.type(field('主机'), '10.0.0.1');
  window.type(field('端口'), '1521');
  window.type(field('用户名'), 'SCOTT');
  window.type(field('密码'), 'tiger');
  window.type(field('服务名'), 'ORCLPDB1');
  const connBtn = [...window.p().querySelectorAll('button')].find((b) => window.norm(b.innerText).includes('连接并读取'));
  if (!connBtn || connBtn.disabled) throw new Error('连接按钮不存在或仍禁用（IPC 桩没生效？）');
  connBtn.click();
  await waitFor(() => ta());
  out.connectOk = true;

  // ① SELECT 直跑：网格出现、桩里的行真在，且全程没碰 exec 通道
  window.__ipc.length = 0;
  window.type(ta(), 'SELECT ID, BUYER_NAME FROM T_ORDER WHERE STATUS = 1');
  runBtn().click();
  await waitFor(() => window.p().querySelector('table.qgrid'));
  out.selectOk = window.p().innerText.includes('BUYER_NAME') && window.p().innerText.includes('张三');
  out.selectNoExec = ddlCalls().length === 0;

  // ② UPDATE 点运行 → 两段确认（将改删行 → 预览语句），SET 里带注释行也认
  window.__ipc.length = 0;
  window.type(ta(), ['UPDATE T_ORDER', '   SET STATUS = 0,                        -- 0 = 待提交', '       BUYER_NAME = NULL', ' WHERE ID = 1'].join(NL));
  runBtn().click();
  const m2 = await reachSqlDlg();
  out.confirmOk = out.sawWarn === true;
  out.previewOk = m2.innerText.includes('UPDATE T_ORDER');

  // ③ 取消：弹窗关掉，exec 通道一次都没被调到
  clickModalBtn(modal(), '取消');
  await sleep(450);
  out.cancelOk = modal() === null && ddlCalls().length === 0;

  // ④ 确认改删：oracle_exec_ddl 恰好一次，语句原样（含注释）进通道
  runBtn().click();
  await reachSqlDlg();
  clickModalBtn(modal(), '确定改删');
  // 手动轮询而不是 waitFor：超时要把「最后一次弹窗内容 + IPC 尾巴」带出去，
  // 否则只知道超时不知道死在哪（第一次跑就死在这，靠这段才定位）
  out.execDiag = { ddl: 0, lastModal: '', ipcTail: [] };
  {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await sleep(250);
      const m = modal();
      if (m) out.execDiag.lastModal = m.innerText.slice(0, 300);
      if (ddlCalls().length > 0 && !m) break;
    }
  }
  await sleep(600); // 执行后的缓存刷新是后台异步，别带着半截异步拆桩
  const calls = ddlCalls();
  out.execDiag.ddl = calls.length;
  out.execDiag.ipcTail = window.__ipc.slice(-4).map((c) => c[0]);
  out.execOk = calls.length === 1
    && (calls[0][1]?.statements ?? []).join(' ').includes('UPDATE T_ORDER')
    && document.body.innerText.includes('已在库上执行 1 条');

  // 拆桩：本段后面没有别的段了，留着只会让后续调试时的「浏览器模式」类断言失真
  delete window.__TAURI_INTERNALS__;
  return out;
})()`)
console.log(JSON.stringify(qsplit, null, 2))
const qsplitOk =
  qsplit.connectOk && qsplit.selectOk && qsplit.selectNoExec &&
  qsplit.confirmOk && qsplit.previewOk && qsplit.cancelOk && qsplit.execOk
console.log(
  qsplitOk
    ? '✅ 分流三条全过：SELECT 直跑出网格没碰写通道；UPDATE 弹「将改删行」两段确认，取消后一次没执行；确认后 exec 通道恰好一次、语句原样'
    : '❌ 查询框分流不对：连接 / 直跑 / 确认弹窗 / 预览 / 取消 / 执行，哪段挂了看上面字段',
)

// ===== 码上测走查（2026-09-30 沉淀）：种子注入 + 环境组一键切换 + 数据驱动期望体 / 401 自救 =====
// 码上测不在开头的逐页快照循环里（数据驱动要扫描结果才走得通）。这段把一次性探针的
// 配方沉淀为常驻走查：CDP 注入种子（workspace 缓存 + env + 数据表）+ Tauri 桩
// （license pro + 有状态 apiforge_http：/login 发 T2，接口只认 Bearer T2）——
// 全程进程内，不依赖任何外部 mock 服务。hash 在 node 侧算好，页面端零转义。
mark('码上测：种子 + 环境组 + 数据驱动')
await send('Page.enable')
const _apfNorm = 'd:/probe-demo'
let _apfH = 0x811c9dc5
for (let i = 0; i < _apfNorm.length; i++) {
  _apfH ^= _apfNorm.charCodeAt(i)
  _apfH = Math.imul(_apfH, 0x01000193)
}
const APF_HASH = (_apfH >>> 0).toString(16).padStart(8, '0')
const APF_SCAN = {
  root: 'D:/probe-demo', scannedAt: '2026-09-30T00:00:00.000Z', fingerprint: 'e2e', errors: [],
  projects: [{
    projectId: 'p1', projectPath: 'D:/probe-demo/demo', projectName: 'probe-demo', mappers: [], classUses: [],
    controllers: [{
      className: 'BrandController', packageName: 'com.probe.web', basePath: '', filePath: 'f.java',
      description: '', author: '', date: '',
      methods: [{
        id: 'f.java#get#1', methodName: 'get', httpMethod: 'GET', path: '/api/brands/{id}',
        parameters: [{ name: 'id', javaType: 'Long', position: 'path', required: true }],
        requestBodyType: null, requestBodyFields: [], responseType: 'BrandVo', description: '',
        controllerClass: 'BrandController', filePath: 'f.java', projectId: 'p1',
      }],
    }],
  }],
}
const APF_DD = {
  id: 'dde2e', name: '期望体矩阵', apiId: 'f.java#get#1', columns: ['id'],
  rows: [
    { params: { id: '1' }, expected: '', expectedBody: '$.code=0;$.data.id 存在', enabled: true },
    { params: { id: '2' }, expected: '', expectedBody: '', enabled: true },
    { params: { id: '3' }, expected: '', expectedBody: '$.code=999', enabled: true },
  ],
  updatedAt: 0,
}
const APF_BOOT = [
  'window.__ipc = [];',
  'window.__phase = "pre";',
  'window.__cb = 0;',
  'window.__TAURI_INTERNALS__ = {',
  '  transformCallback: (cb) => { window[++window.__cb] = cb; return window.__cb; },',
  '  invoke: async (cmd, args) => {',
  '  window.__ipc.push([cmd, args ?? null]);',
  "  if (cmd === 'license_verify') return { v: 1, kind: 'pro', forever: true, code: 'E2E-PRO' };",
  "  if (cmd === 'apiforge_http') {",
  '    const r = args.req;',
  "    if (r.url.endsWith('/login')) return { status: 200, bodyText: '{\"data\":{\"token\":\"T2\"}}' };",
  "    if (String((r.headers ?? {}).Authorization ?? '') === 'Bearer T2') return { status: 200, bodyText: '{\"code\":\"0\",\"data\":{\"id\":\"1\"}}' };",
  "    return { status: 401, bodyText: '{\"msg\":\"token 过期\"}' };",
  '  }',
  "  if (cmd === 'plugin:event|listen' || cmd === 'plugin:event|unlisten') return ++window.__cb;",
  "  if (cmd === 'plugin:app|version') return '1.7.0';",
  "  if (cmd === 'plugin:updater|check') return null;",
  "  throw new Error('stub: unhandled ' + cmd);",
  '} };',
  "if (!localStorage.getItem('apiforge.e2e.seeded')) {",
  "  const META = 'devtools.apiforge.meta';",
  "  const meta = JSON.parse(localStorage.getItem(META) || '{}');",
  "  meta['apiforge.workspace.index'] = " + JSON.stringify(JSON.stringify([{ root: 'D:/probe-demo', hash: APF_HASH, bytes: 4096 }])) + ";",
  "  meta['apiforge.workspace." + APF_HASH + "'] = " + JSON.stringify(JSON.stringify(APF_SCAN)) + ";",
  "  meta['apiforge.history'] = " + JSON.stringify(JSON.stringify([{ root: 'D:/probe-demo', scannedAt: '2026-09-30T00:00:00.000Z', projects: [{ name: 'probe-demo', controllers: 1, apis: 1 }] }])) + ";",
  "  meta['apiforge.env'] = " + JSON.stringify(JSON.stringify({ baseUrl: 'http://e2e.local', loginApi: '/login', username: 'e2e', password: 'e2e-pass', tokenHeader: 'Authorization', tokenPrefix: 'Bearer', timeoutMs: 5000, connId: '', assertMode: 'observe' })) + ";",
  "  meta['apiforge.datadriven'] = " + JSON.stringify(JSON.stringify([APF_DD])) + ";",
  "  meta['apiforge.scenarios'] = " + JSON.stringify(JSON.stringify([{
    id: 'scne2e', name: '品牌查询链', updatedAt: 0, dataSetId: 'dde2e',
    steps: [
      { id: 'st1', apiId: 'f.java#get#1', enabled: true, overrides: { id: '{{id}}' } },
      { id: 'st2', apiId: 'f.java#get#1', enabled: true, overrides: { id: '{{id}}' } },
    ],
  }])) + ";",
  '  localStorage.setItem(META, JSON.stringify(meta));',
  "  localStorage.setItem('devtools.license.v1', 'E2E-PRO');",
  "  localStorage.setItem('apiforge.e2e.seeded', '1');",
  '}',
].join('\n')
await send('Page.addScriptToEvaluateOnNewDocument', { source: APF_BOOT })
await send('Page.navigate', { url: 'http://localhost:5173/' })
await sleep(3500)
const apf = await evaluate(`(async () => {
  const out = {}
  const p = () => document.querySelector('.pagehost:not([hidden])')
  const tick = (ms) => new Promise(r => setTimeout(r, ms))
  const setVal = (el, v) => {
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
    d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const foldByTitle = (t) => [...p().querySelectorAll('.apf-fold')].find(f => f.querySelector('.apf-fold-title')?.textContent === t)

  ;[...document.querySelectorAll('.rail .nav button')].find(b => b.textContent.includes('码上测'))?.click()
  window.__phase = 'apf-env'
  await tick(700)
  // 进门先弹「继续上次的项目？」——只有「打开结果」会把缓存 scan 装进工作台，
  // 不点它数据驱动会以「还没有扫描结果」空转（第一次实跑就栽在这）
  const openBtn = [...document.querySelectorAll('.ant-modal button')]
    .find(b => b.textContent.replace(/\\s/g, '') === '打开结果' && b.closest('.ant-modal-wrap')?.style.display !== 'none')
  out.resumeOk = !!openBtn
  openBtn?.click()
  await tick(700)
  ;[...p().querySelectorAll('button')].find(b => b.textContent.trim() === '环境 / 连库')?.click()
  await tick(700)

  // —— 环境组：存「测试组」→ 改 Base URL → 点组名切换（确认框）——
  window.__phase = 'env-fold'
  const fold = foldByTitle('环境组')
  ;(fold?.querySelector('.fold-head button, .fold-head, button, [role="button"]') ?? fold?.firstElementChild)?.click()
  await tick(400)
  const name = [...(fold?.querySelectorAll('input.fld') ?? [])].find(i => i.placeholder.includes('环境组名'))
  setVal(name, '测试组')
  window.__phase = 'env-save'
  ;[...(fold?.querySelectorAll('button') ?? [])].find(b => b.textContent.includes('保存当前配置'))?.click()
  await tick(600)
  window.__phase = 'env-saved'
  out.savedChip = [...(fold?.querySelectorAll('button') ?? [])].some(b => b.textContent.includes('测试组'))
  out.summary = fold?.querySelector('.apf-fold-sum')?.textContent ?? ''
  const profiles = JSON.parse(JSON.parse(localStorage.getItem('devtools.apiforge.meta'))['apiforge.envProfiles'] || '[]')
  out.blobCount = profiles.length
  out.noPassword = !JSON.stringify(profiles).includes('password')

  const url = p().querySelector('input[placeholder="http://localhost:8080"]')
  setVal(url, 'http://changed.example')
  window.__phase = 'env-chip'
  ;[...(fold?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === '测试组')?.click()
  await tick(500)
  window.__phase = 'env-confirm'
  // 确认框：antd 会把两字按钮渲染成「切 换」；旧弹窗节点常驻 DOM，只点可见包裹里的
  const okBtn = [...document.querySelectorAll('.ant-modal button')]
    .find(b => b.textContent.replace(/\\s/g, '') === '切换' && b.closest('.ant-modal-wrap')?.style.display !== 'none')
  out.confirmSeen = !!okBtn
  okBtn?.click()
  await tick(700)
  window.__phase = 'env-switched'
  out.switched = url.value === 'http://e2e.local'

  // —— 数据驱动：三行矩阵（行1 无 token → 401 自救；行3 期望体挂）——
  ;[...p().querySelectorAll('button')].find(b => b.textContent.trim() === '数据驱动')?.click()
  window.__phase = 'dd-tab'
  await tick(700)
  ;[...p().querySelectorAll('button.apf-atchip')].find(b => b.textContent.includes('期望体矩阵'))?.click()
  await tick(500)
  window.__phase = 'dd-run'
  ;[...p().querySelectorAll('button')].find(b => b.textContent.includes('跑这批数据'))?.click()
  await tick(2500)
  window.__phase = 'dd-done'
  out.ddShown = p().innerText.includes('/api/brands/1')
  out.assertFailShown = p().innerText.includes('✗ $.code')
  const httpCalls = window.__ipc.filter(([c]) => c === 'apiforge_http').map(([, a]) => a.req.method + ' ' + a.req.url + ' auth=' + ((a.req.headers ?? {}).Authorization ?? '-'))
  out.httpSeq = httpCalls.join(' | ')
  out.seqOk = httpCalls.length === 5
    && httpCalls[0].startsWith('GET ') && httpCalls[0].endsWith('/api/brands/1 auth=-')
    && httpCalls[1].startsWith('POST ') && httpCalls[1].endsWith('/login auth=-')
    && httpCalls[2].startsWith('GET ') && httpCalls[2].endsWith('/api/brands/1 auth=Bearer T2')
    && httpCalls[3].startsWith('GET ') && httpCalls[3].endsWith('/api/brands/2 auth=Bearer T2')
    && httpCalls[4].startsWith('GET ') && httpCalls[4].endsWith('/api/brands/3 auth=Bearer T2')

  // —— 报告历史「和上次比」（复盘短板 ③）：跑两轮全自动回归，第二轮出对比带 ——
  // 第一轮收尾存历史（没有可比的上次，对比带不出）；第二轮 diff 出来上屏。
  // 流水日志里也有「和上次比：」一行，所以按 .apf-atchips-lbl 找带子，不匹配全文
  const diffBand = () =>
    [...p().querySelectorAll('.apf-atchips')].find(
      (x) => x.querySelector('.apf-atchips-lbl')?.textContent === '和上次比',
    )
  let regN = 0
  const runReg = async () => {
    window.__phase = 'reg' + ++regN
    ;[...p().querySelectorAll('button')].find(b => b.textContent.includes('全自动回归'))?.click()
    await tick(3500)
    window.__phase = 'reg' + regN + '-done'
  }
  await runReg()
  // 报告行显示的是接口路径占位符（/api/brands/{id}），不是解析后的实际 URL
  out.repShown = p().innerText.includes('测试结果') && p().innerText.includes('/api/brands/{id}')
  out.diffAbsentFirstRun = !diffBand()
  await runReg()
  const band = diffBand()
  out.diffShown = !!band
  out.diffLine = band ? band.innerText.replace(/\\n/g, ' ').slice(0, 160) : ''

  // —— 场景 Outline（复盘短板 ④）：一条链 × 数据表 3 行，行数据当 {{变量}} ——
  // 种子的场景绑了 dde2e 表（行 id=1/2/3），两步都用 {{id}}；此时 store token
  // 已被前面的回归登录成 T2，3 行 × 2 步 = 6 次请求按行分组、全程无需再自救
  ;[...p().querySelectorAll('button')].find(b => b.textContent.trim() === '场景')?.click()
  await tick(600)
  out.scnBtn = [...p().querySelectorAll('button')].find(b => b.textContent.includes('跑 3 轮'))?.textContent.trim() ?? null
  const httpN = () => window.__ipc.filter(([c]) => c === 'apiforge_http').length
  const beforeScn = httpN()
  ;[...p().querySelectorAll('button')].find(b => b.textContent.includes('跑 3 轮'))?.click()
  window.__phase = 'outline'
  await tick(3500)
  window.__phase = 'outline-done'
  out.outlineShown = p().innerText.includes('Outline · 数据表「期望体矩阵」')
  out.row3Shown = p().innerText.includes('行 3 · id=3')
  out.outlineUrl = p().innerText.includes('/api/brands/1')
  const scnCalls = window.__ipc.filter(([c]) => c === 'apiforge_http').slice(beforeScn)
    .map(([, a]) => a.req.method + ' ' + a.req.url.replace('http://e2e.local', '') + ' ' + ((a.req.headers ?? {}).Authorization ?? '-'))
  out.outlineSeq = scnCalls.join(' | ')
  out.outlineCallsOk = scnCalls.length === 6
    && scnCalls.every(x => x.startsWith('GET /api/brands/') && x.endsWith('Bearer T2'))
    && scnCalls[0].includes('/1') && scnCalls[1].includes('/1')
    && scnCalls[2].includes('/2') && scnCalls[3].includes('/2')
    && scnCalls[4].includes('/3') && scnCalls[5].includes('/3')

  // —— 压测参数化（复盘短板 ④）：勾选落盘（展开逻辑是纯函数，单测钉死）——
  ;[...p().querySelectorAll('button')].find(b => b.textContent.trim() === '压测')?.click()
  window.__phase = 'bench'
  await tick(600)
  const paramLbl = [...p().querySelectorAll('label')].find(l => l.textContent.includes('按数据表参数化'))
  ;(paramLbl?.querySelector('input[type="checkbox"]') ?? paramLbl)?.click()
  await tick(600)
  out.parametrizeStored = JSON.parse(JSON.parse(localStorage.getItem('devtools.apiforge.meta'))['apiforge.bench'] || '{}').parametrize === true
  // 拆桩：后面只剩汇总了
  delete window.__TAURI_INTERNALS__
  return out
})()`)
console.log(JSON.stringify(apf, null, 2))
const apfOk =
  apf.savedChip && apf.summary === '1 组' && apf.blobCount === 1 && apf.noPassword &&
  apf.confirmSeen && apf.switched && apf.resumeOk && apf.ddShown && apf.assertFailShown && apf.seqOk &&
  apf.repShown && apf.diffAbsentFirstRun && apf.diffShown &&
  apf.outlineShown && apf.row3Shown && apf.outlineUrl && apf.outlineCallsOk && apf.parametrizeStored
console.log(
  apfOk
    ? '✅ 码上测全过：环境组 / 数据驱动期望体 + 401 自救 / 报告「和上次比」/ 场景 Outline 三行全跑 / 压测参数化落盘'
    : '❌ 码上测走查不对：环境组 / 数据驱动 / 401 / 报告对比 / Outline / 参数化，哪段挂了看上面字段',
)

console.log('\\n===== React 重复 key（页面内截获，进 allOk 挡门）=====')
const dupKeys = await evaluate('window.__dupKeys ?? []')
const dupKeyN = dupKeys.length
console.log(dupKeyN === 0 ? '✅ 重复 key 告警 0 次' : `❌ 重复 key 告警 ${dupKeyN} 次：\n${JSON.stringify(dupKeys, null, 1)}`)
const dupComps = await evaluate('window.__dupComps ?? []')
if (dupComps.length) console.log('组件链：\n' + JSON.stringify(dupComps, null, 1))
console.log('\\n===== 浏览器控制台 error/warning =====')
console.log(logs.length ? logs.join('\\n') : '(无)')
const allOk =
  flow.confirmImport === 'ok' &&
  (flow.genJump.skipped ? flow.genJump.btnHidden : flow.genJump.onSql) &&
  flow.afterImport.stayBand !== null &&
  card.dialectDiffers && card.typePickOk && card.alterOk && layout.ok && (lf.skipped || (lf.ok && lf.favOk)) &&
  (s2u.skipped || (s2u.ok && s2u.demoOk)) && editorOk && navFoldOk && jpOk && cronOk && adv.ok &&
  qsplitOk &&
  apfOk &&
  dupKeyN === 0 &&
  report.every(r => !r.errors.length)
console.log(allOk ? '\\n🎉 全部通过' : '\\n💥 有失败项，见上')
ws.close()
