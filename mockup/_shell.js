/* ==========================================================================
   mockup/ 的共享外壳脚本。每页 <script src="_shell.js"> 一行就够。

   它负责三件所有页面都一样、不该抄 7 份的事：
     1. 背景层（网格/扫描线/光晕）注入到 [data-hud]
     2. 左侧导航注入到 [data-rail]，按 data-page 标当前页
     3. 主题选择器注入到 [data-tp]，并把主题带到下一页

   主题怎么传：file:// 下 Chrome/Edge 默认禁 localStorage（要 --allow-file-
   access-from-files），只靠它评审时每翻一页主题就弹回默认，等于没法比。
   所以主题写在 URL 的 ?t= 上，导航链接点击时现拼；localStorage 只当锦上添花，
   放在 try 里，抛了也无所谓。
   ========================================================================== */
(() => {
  const THEMES = [
    { id: 'aurora',    label: '极光',     a: '#3b63e0', b: '#dfe3f6', note: '浅色渐变底 + 毛玻璃卡片' },
    { id: 'graphite',  label: '石墨',     a: '#5b9bc4', b: '#181c22', note: '中性深灰，平面无发光' },
  ]

  /* 顺序 = 优先级。导入和日志转SQL放最前：一个是所有数据的入口（没导表其他页都是空的），
     一个是最高频的独立入口（不依赖表结构缓存，随手粘一段日志就用）。
     速查/生成排在后面 —— 它们得先有表。配置管理是独立的核心模块（PRD 第五章），
     不依赖表结构；正则和 JSONPath 是顺手带的小工具，垫底。 */
  const NAV = [
    { id: 'index',    href: 'index.html',          icon: '◈', label: '样式总览' },
    { id: 'import',   href: 'import-clean.html',   icon: '📥', label: '导入表结构' },
    { id: 'dbsrc',    href: 'import-db-src.html',  icon: '🗄️', label: '连库·扫源码导入' },
    { id: 'dbq',      href: 'db-query.html',       icon: '▦', label: '连库查询' },
    { id: 'dbconns',  href: 'db-conns.html',       icon: '🔌', label: '我的连接' },
    { id: 'logfill',  href: 'logfill-chat.html',   icon: '🧩', label: '日志转SQL' },
    { id: 'schema',   href: 'schema.html',         icon: '🔍', label: '表结构速查' },
    { id: 'sqlgen',   href: 'sqlgen.html',         icon: '📝', label: 'SQL 生成' },
    { id: 's2u',       href: 'select2update.html',  icon: '🔁', label: 'SELECT转UPDATE' },
    { id: 'batch-ins', href: 'batch-insert.html',   icon: '📦', label: '批量 INSERT', group: '批量生成' },
    { id: 'batch-upd', href: 'batch-update.html',   icon: '✏️', label: '批量 UPDATE', group: '批量生成' },
    { id: 'sqlfav',    href: 'sqlfav.html',         icon: '📚', label: '我的SQL库' },
    { id: 'config',   href: 'config.html',         icon: '⚙️', label: '配置管理' },
    { id: 'regex',    href: 'regex.html',          icon: '🔬', label: '正则测试' },
    { id: 'jsonpath', href: 'jsonpath.html',       icon: '🔎', label: 'JSONPath' },
  ]

  const LS = 'devtools-mockup-theme'
  const store = {
    get() { try { return localStorage.getItem(LS) } catch { return null } },
    set(v) { try { localStorage.setItem(LS, v) } catch { /* file:// 下会抛，忽略 */ } },
  }

  const ids = THEMES.map(t => t.id)
  const fromUrl = new URLSearchParams(location.search).get('t')
  let cur = ids.includes(fromUrl) ? fromUrl : (ids.includes(store.get()) ? store.get() : 'aurora')

  function apply(id, silent) {
    cur = id
    document.documentElement.dataset.theme = id
    store.set(id)
    document.querySelectorAll('[data-tp] .sw').forEach(b => b.classList.toggle('on', b.dataset.t === id))
    const nm = document.querySelector('[data-tp] .nm')
    if (nm) nm.textContent = THEMES.find(t => t.id === id).label
    // 导航 href 跟着改，这样翻页不掉主题
    document.querySelectorAll('[data-rail] .nav a').forEach(a => {
      a.href = a.dataset.href + '?t=' + id
    })
    if (!silent) window.dispatchEvent(new CustomEvent('themechange', { detail: id }))
  }

  // 先把主题挂上去再渲染，避免默认色闪一帧
  document.documentElement.dataset.theme = cur

  function boot() {
    const hud = document.querySelector('[data-hud]')
    if (hud) hud.innerHTML = '<i class="aura"></i><i class="grid"></i><i class="scan"></i>'

    const rail = document.querySelector('[data-rail]')
    if (rail) {
      const page = rail.dataset.page || ''
      rail.innerHTML = `
        <div class="brand">
          <div class="mark">⛁</div>
          <div>
            <b>码上 CodeNow</b>
            <span class="ver">对着表 · 出一句能跑的 SQL</span>
          </div>
        </div>
        <h4>功能页</h4>
        <nav class="nav">
          ${NAV.map((n, i) => {
            const head = n.group && n.group !== NAV[i - 1]?.group
              ? `<div class="navg">${n.group}</div>` : ''
            return `${head}<a data-href="${n.href}" href="${n.href}" class="${n.id === page ? 'on' : ''}"
              ><em>${n.icon}</em><span>${n.label}</span></a>`
          }).join('')}
        </nav>
        <div class="railfoot">
          <div class="lbl" style="margin-bottom:8px">整体样式 · <kbd>1</kbd>–<kbd>${THEMES.length}</kbd> 切换</div>
          <div class="stack" style="gap:4px">
            ${THEMES.map((t, i) => `<button class="mini" data-pick="${t.id}"
                style="text-align:left;display:flex;gap:7px;align-items:center">
                <i style="width:9px;height:9px;border-radius:2px;background:${t.a};flex:none"></i>
                ${i + 1}. ${t.label}</button>`).join('')}
          </div>
        </div>`
      rail.querySelectorAll('[data-pick]').forEach(b => { b.onclick = () => apply(b.dataset.pick) })
    }

    document.querySelectorAll('[data-tp]').forEach(tp => {
      tp.classList.add('tp')
      const light = THEMES.filter(t => t.id === 'aurora')
      const dark = THEMES.filter(t => t.id !== 'aurora')
      const sw = t => `<button class="sw" data-t="${t.id}" title="${t.label} — ${t.note}"
           style="--sw-a:${t.a};--sw-b:${t.b}"></button>`
      tp.innerHTML = light.map(sw).join('')
        + '<i class="tp-sep" aria-hidden="true" title="左侧浅色 · 右侧极客暗色"></i>'
        + dark.map(sw).join('')
        + '<span class="nm"></span>'
      tp.querySelectorAll('.sw').forEach(b => { b.onclick = () => apply(b.dataset.t) })
    })

    // 数字键切主题。输入框里打字时不能抢，否则填个 1 就换皮
    addEventListener('keydown', e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return
      const i = +e.key
      if (i >= 1 && i <= THEMES.length) { apply(THEMES[i - 1].id); e.preventDefault() }
    })

    apply(cur, true)
  }

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot)
  else boot()

  /* ---------------- 各页共用的小工具 ---------------- */
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const KW = ('select|insert|into|values|update|set|delete|from|where|and|or|not|null|is|left|right|inner|full|outer|'
    + 'join|on|as|order|group|by|having|limit|offset|create|table|primary|key|foreign|references|constraint|default|'
    + 'comment|auto_increment|unique|index|alter|add|drop|rownum|fetch|first|next|rows|only|case|when|then|else|end|'
    + 'in|like|between|distinct|exists|union|all|count|sum|avg|max|min|coalesce|nvl|to_date|to_char|sysdate|now|'
    + 'current_timestamp|true|false|desc|asc|charset|engine|using|with|generated|identity|number|varchar2|varchar|'
    + 'char|int|integer|bigint|smallint|tinyint|decimal|numeric|date|datetime|timestamp|text|clob|blob|boolean')

  /* SQL 上色。一条主正则一次扫完，不是「先换注释再换字符串」那种叠加式替换 ——
     叠加会让注释里的引号把后面的规则带偏，且先插入的 <span> 又被后一条规则当成文本再切一次。 */
  const sqlHi = src => esc(src).replace(
    new RegExp(
      '(--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)'      // 1 注释
      + "|('(?:[^']|'')*')"                      // 2 字符串
      + '|(#\\{[\\w.]+\\}|\\?)'                  // 3 占位符
      + '|\\b(\\d+(?:\\.\\d+)?)\\b'              // 4 数字
      + '|\\b(' + KW + ')\\b',                   // 5 关键字
      'gi')
    , (m, c, s, p, n, k) =>
      c ? `<span class="c">${c}</span>` : s ? `<span class="s">${s}</span>`
        : p ? `<span class="f">${p}</span>` : n ? `<span class="n">${n}</span>`
          : `<span class="k">${k}</span>`)

  /* XML：标签名和属性名一个色，属性值走字符串色 */
  const xmlHi = src => esc(src)
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="c">$1</span>')
    .replace(/(&lt;\/?)([\w:.-]+)/g, '$1<span class="k">$2</span>')
    .replace(/([\w:.-]+)=(&quot;|")((?:(?!\2).)*)\2/g, '<span class="f">$1</span>=<span class="s">$2$3$2</span>')
    .replace(/(#\{[\w.]+\})/g, '<span class="n">$1</span>')

  /* JSON：键和值分开着色，键要能跟字符串值区分，靠后面紧跟的冒号判断 */
  const jsonHi = src => esc(src).replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(true|false|null)\b/g,
    (m, str, colon, num, lit) =>
      str ? (colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`)
        : num ? `<span class="n">${num}</span>` : `<span class="f">${lit}</span>`)

  /* 复制。file:// 下 navigator.clipboard 常常不给，退回 execCommand，
     不然按钮点了没反应也不报错，评审时以为是原型坏了 */
  function copy(text, btn) {
    const done = ok => {
      if (!btn) return
      const old = btn.textContent
      btn.textContent = ok ? '✓ 已复制' : '✗ 复制失败'
      setTimeout(() => { btn.textContent = old }, 1300)
    }
    const fallback = () => {
      const ta = document.createElement('textarea')
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(ta); ta.select()
      let ok = false
      try { ok = document.execCommand('copy') } catch { ok = false }
      ta.remove(); done(ok)
    }
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => done(true), fallback)
    else fallback()
  }

  /* 折叠块：整站一个写法，点标题头切 .on */
  function bindFolds(root = document) {
    root.querySelectorAll('.fold > .fold-h').forEach(h => {
      if (h.dataset.bound) return
      h.dataset.bound = '1'
      h.onclick = e => {
        if (e.target.closest('button,a,input,.tag.click')) return
        h.parentElement.classList.toggle('on')
      }
    })
  }

  /* textarea 高度跟着内容长，最多到 max —— 少一次「拖一下滚动条」 */
  const autoGrow = (el, max = 300) => {
    el.style.height = 'auto'
    el.style.height = Math.min(max, el.scrollHeight + 2) + 'px'
  }

  window.UI = { THEMES, NAV, esc, sqlHi, xmlHi, jsonHi, copy, bindFolds, autoGrow, apply, theme: () => cur }
})()
