/* 批量 INSERT / 批量 UPDATE 两页共用的生成管线（原 batch-gen.html 内联脚本）。
   页面用 <body data-batch="insert|update"> 锁死模式，不再用段切换来藏半屏卡片。
   冒烟钩子 window.__T 仍挂在这里，node _smoke-batch.mjs 直接跑这份文件。 */
{
  const { tables, byName, DIALECTS } = DATA
  const { esc, sqlHi, copy } = UI
  const $ = s => document.querySelector(s)
  const pageMode = () => document.body?.dataset?.batch || S.mode

  const S = {
    mode: 'insert',
    loc: 'pk',
    table: 'order',
    dia: 'mysql',
    n: 20,
    insFmt: 'each',
    perStmt: 10,
    startId: '',
    hdr: true,
    upFmt: 'each',
    upBatch: 20,
    pkRaw: '',
    setOn: {},
    condOn: {}, cval: {},
    fixedOk: false,
    rule: {},
  }
  if (document.body?.dataset?.batch) S.mode = document.body.dataset.batch

  const RESERVED = new Set(['order', 'user', 'group', 'table', 'key', 'index', 'desc', 'comment',
    'level', 'number', 'date', 'value', 'check', 'session', 'mode', 'view', 'raw', 'size', 'start', 'no'])
  const qi = s => (RESERVED.has(s.toLowerCase()) ? DIALECTS[S.dia].q(s) : s)

  function litByCol(c, text){
    const D = DIALECTS[S.dia]
    const v = String(text).trim()
    if (/^(null)$/i.test(v)) return 'NULL'
    const isStr = !!c && (c.j === 'String' || /CHAR|TEXT|CLOB/i.test(c.t || ''))
    if (!isStr){
      if (/^-?\d+(\.\d+)?$/.test(v)) return v
      if (/^true$/i.test(v)) return D.bool(true)
      if (/^false$/i.test(v)) return D.bool(false)
      if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(v)) return D.date(v.replace('T', ' '))
    }
    return `'${v.replaceAll("'", "''")}'`
  }

  const banner = lines => ['-- ' + '='.repeat(58),
    ...lines.filter(Boolean).map(l => '-- ' + l),
    '-- ' + '='.repeat(58)].join('\n')

  function h32(i, name){
    let h = 2166136261 >>> 0
    const s = i + '\x1f' + name
    for (let k = 0; k < s.length; k++){ h ^= s.charCodeAt(k); h = Math.imul(h, 16777619) >>> 0 }
    return h
  }

  function legacyAuto(t, c, i){
    if (c.j === 'Boolean') return i % 2 === 0 ? 'true' : 'false'
    if (c.j === 'LocalDateTime' || /^(DATE|DATETIME|TIMESTAMP)/i.test(c.t))
      return `2026-08-26 ${String(8 + (i % 12)).padStart(2, '0')}:30:00`
    if (c.j === 'BigDecimal') return `${99 + i * 100}.50`
    if (c.j === 'Long' || c.j === 'Integer'){
      if (c.pk || /_id$/.test(c.n)) return String(1000 + i * 7)
      if (c.n === 'status') return (c.d ?? '0')
      if (c.n === 'quantity') return String(1 + i % 5)
      if (c.n === 'stock') return String(100 * i)
      return String((i * 13 + t.name.length) % 97 + 1)
    }
    if (c.n === 'username') return 'batch_user_' + String(i).padStart(3, '0')
    if (c.n === 'password') return 'e10adc3949ba59abbe56e057f20f883e'
    if (c.n === 'email') return `batch${String(i).padStart(3, '0')}@example.com`
    if (c.n === 'order_no') return 'NO2026082600' + String(i).padStart(2, '0')
    if (c.n === 'code') return 'ROLE_' + ['ADMIN', 'USER', 'AUDITOR'][i % 3]
    if (c.n === 'name') return t.name === 'product' ? '测试商品' + i : '管理员'
    if (c.n === 'detail') return '批量造数第 ' + i + ' 条'
    if (c.n === 'action') return ['LOGIN', 'UPDATE_ORDER', 'EXPORT'][i % 3]
    return '测试' + (c.c || c.n)
  }

  function ruleText(c, i){
    const r = S.rule[c.n] || {}
    const p = r.p || {}
    const a = String(p.a ?? ''), b = String(p.b ?? '')
    switch (r.k){
      case 'tpl':   return a.replaceAll('{n}', String(i))
      case 'fixed': return a
      case 'rnum': {
        const lo = Number.parseInt(a, 10) || 0
        const hi = Number.parseInt(b, 10) || lo
        return String(lo + h32(i, c.n) % (Math.abs(hi - lo) + 1))
      }
      case 'rstr': {
        const len = Math.min(64, Math.max(1, Number.parseInt(a, 10) || 8))
        const CS = { alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
                     num: '0123456789', lower: 'abcdefghijklmnopqrstuvwxyz' }
        const cs = CS[b] || CS.alnum
        let out = ''
        for (let k = 0; k < len; k++) out += cs[h32(i * 131 + k, c.n) % cs.length]
        return out
      }
      case 'renum': {
        const opts = a.split(/[,，]/).map(x => x.trim()).filter(Boolean)
        return opts.length ? opts[h32(i, c.n) % opts.length] : ''
      }
      case 'rdate': {
        const t0 = Date.parse(a), t1 = Date.parse(b)
        if (Number.isNaN(t0) || Number.isNaN(t1)) return a || b || ''
        const lo = Math.min(t0, t1), span = Math.max(0, Math.abs(t1 - t0))
        const d = new Date(lo + h32(i, c.n) % (span + 86400000))
        const pd = x => String(x).padStart(2, '0')
        return `${d.getFullYear()}-${pd(d.getMonth() + 1)}-${pd(d.getDate())}`
      }
      case 'phone': return '138' + String(h32(i, c.n) % 100000000).padStart(8, '0')
      case 'email': {
        const L = 'abcdefghjkmnpqrstwxyz'
        const w = n => Array.from({ length: n }, (_, k) => L[h32(i * 7 + k, c.n) % L.length]).join('')
        return w(4) + '.' + w(3) + '@test.com'
      }
      case 'name': return ['张三', '李四', '王五', '赵六', '陈七', '周八', '吴九', '郑十'][h32(i, c.n) % 8]
    }
    return ''
  }

  function ruleLit(t, c, i){
    const r = S.rule[c.n] || {}
    if (r.k === 'now') return DIALECTS[S.dia].now
    if (r.k === 'null') return 'NULL'
    const txt = (!r.k || r.k === 'auto') ? legacyAuto(t, c, i) : ruleText(c, i)
    return litByCol(c, txt)
  }

  function varying(c){
    const k = (S.rule[c.n] || {}).k
    return !(k === 'fixed' || k === 'now' || k === 'null')
  }

  function genInsert(){
    const t = byName[S.table], D = DIALECTS[S.dia], N = S.n
    const sid = /^\d+$/.test(String(S.startId).trim()) ? parseInt(S.startId, 10) : null
    const aiCols = t.columns.filter(c => c.ai)
    const cols = t.columns.filter(c => !c.ai || sid !== null)
    const cell = (c, i) => (c.ai && sid !== null) ? String(sid + i - 1) : ruleLit(t, c, i)
    const row = i => '(' + cols.map(c => cell(c, i)).join(', ') + ')'
    const fmtLabel = { each: '逐条', multi: '一条多VALUES(MySQL)',
                       chunk: `分批（每 ${S.perStmt} 条一组，超 1MB 自动再切)` }[S.insFmt]
    const head = S.hdr
      ? banner([
          `批量INSERT : ${t.name} (${t.comment})`,
          `共 ${N} 条 · 形态 ${fmtLabel} · ${D.label}`,
          sid !== null && aiCols.length
            ? `起始ID=${sid}：自增列 ${aiCols.map(c => c.n).join('、')} 一并写入（${sid} 编到 ${sid + N - 1}）`
            : `自增列已整列跳过：${aiCols.length ? aiCols.map(c => c.n).join('、') : '（无）'}`,
          `默认值=§4.4 自动值（第 n 行的值由 (n,表,字段) 决定，两次生成一致）；自定义规则逐列生效`,
        ]) + '\n\n'
      : ''
    let body
    if (S.insFmt === 'multi'){
      const prefix = `INSERT INTO ${qi(t.name)} (${cols.map(c => qi(c.n)).join(', ')}) VALUES`
      body = prefix + '\n' + Array.from({ length: N }, (_, k) => row(k + 1)).join(',\n') + ';'
    } else if (S.insFmt === 'chunk'){
      const prefix = `INSERT INTO ${qi(t.name)} (${cols.map(c => qi(c.n)).join(', ')}) VALUES`
      const LIMIT = 1024 * 1024
      const groups = []
      let buf = []
      for (let i = 1; i <= N; i++){
        const r = row(i)
        if (buf.length && (buf.length >= S.perStmt
            || (prefix + '\n' + [...buf, r].join(',\n')).length > LIMIT)){
          groups.push(prefix + '\n' + buf.join(',\n') + ';')
          buf = []
        }
        buf.push(r)
      }
      if (buf.length) groups.push(prefix + '\n' + buf.join(',\n') + ';')
      body = groups.join('\n\n')
    } else {
      const colsHead = `INSERT INTO ${qi(t.name)} (${cols.map(c => qi(c.n)).join(', ')}) VALUES`
      body = Array.from({ length: N }, (_, k) => colsHead + '\n  ' + row(k + 1) + ';').join('\n\n')
    }
    return { sql: head + body + '\n', stat: `${N} 条`, previewRows: N }
  }

  function parsePkList(raw){
    const seen = new Map()
    let overRange = 0
    for (const tok of String(raw).split(/[\s,，;；]+/)){
      const t = tok.trim()
      if (!t) continue
      const m = t.match(/^(\d+)\s*[-~]\s*(\d+)$/)
      if (m){
        let a = +m[1], b = +m[2]
        if (a > b)[a, b] = [b, a]
        if (b - a + 1 > 2000){ overRange++; continue }
        for (let v = a; v <= b; v++){ const s = String(v); if (!seen.has(s)) seen.set(s, true) }
      } else if (!seen.has(t)) seen.set(t, true)
    }
    return { list: [...seen.keys()], overRange }
  }

  const refuse = (msg, warn, pvNote) => ({
    sql: msg.split('\n').map(l => '-- ' + l).join('\n'),
    stat: '', warn: warn ?? null,
    pv: `<div class="empty">${esc(pvNote ?? '补齐左侧配置后出语句')}</div>`,
  })

  const setColsOf = t => t.columns.filter(c => !c.pk && S.setOn[c.n])

  function genUpdatePk(){
    const t = byName[S.table], D = DIALECTS[S.dia]
    const { list: pks, overRange } = parsePkList(S.pkRaw)
    const pkc = t.columns.find(c => c.pk) ?? t.columns[0]
    const warns = []
    if (overRange) warns.push(`<b>${overRange} 个范围写法跨度超过 2000 已跳过</b>（防手滑展开几十万个主键）`)
    const multiPk = t.columns.filter(c => c.pk).length > 1
    if (multiPk) warns.push('<b>复合主键表：</b>WHERE 只用了第一列 ' + esc(pkc.n) + ' —— 复合主键要几列一起才唯一，执行前确认')
    const warnOf = () => (warns.length ? { tone: 'warn', html: warns.join('<br>') } : null)
    if (!pks.length)
      return refuse('先粘贴主键列表：范围(1-100) / 逗号 / 空格 / 换行都可以\n这份列表就是 WHERE 的全部范围，执行前核对一遍个数',
        warnOf(), '← 左边贴主键后，这里抽样展示')
    const sets = setColsOf(t)
    if (!sets.length)
      return refuse(t.columns.every(c => c.pk)
        ? '这张表所有列都是主键，没有可更新的字段\n关联表要改关系请用 DELETE + INSERT，而不是 UPDATE 主键'
        : '还不能生成：先在左边勾选 SET 字段\n新值来自字段规则（默认 §4.4 自动值；要统一值就把规则改成「固定值」）',
        warnOf(), '勾好 SET 字段后出语句')

    const head = banner([
      `批量UPDATE : ${t.name} (${t.comment}) · 定位方式：主键列表`,
      `给定主键 ${pks.length} 个 · 格式 ${S.upFmt === 'case' ? 'CASE WHEN(100条/组)' : `逐条(${S.upBatch}条/批)`} · ${D.label}`,
      `SET：${sets.map(c => c.n).join('，')}（新值来自字段规则，随行号变化）`,
      `说明：没有旧值可比，全部给定主键都进 WHERE；要只改值有变化的行，用「从SELECT结果导入」`,
    ])

    const stmtFor = i => `UPDATE ${qi(t.name)} SET\n`
      + sets.map(c => `  ${qi(c.n)} = ${ruleLit(t, c, i)}`).join(',\n')
      + `\nWHERE ${qi(pkc.n)} = ${litByCol(pkc, pks[i - 1])};`

    let body
    if (S.upFmt === 'case'){
      const CH = 100
      const vc = sets.filter(c => varying(c)), ic = sets.filter(c => !varying(c))
      const chunks = []
      for (let g = 0; g < pks.length; g += CH){
        const idx = pks.slice(g, g + CH)
        const setLines = vc.map(c => `  ${qi(c.n)} = CASE ${qi(pkc.n)}\n`
          + idx.map((_, j) => `    WHEN ${litByCol(pkc, idx[j])} THEN ${ruleLit(t, c, g + j + 1)}`).join('\n')
          + '\n    END').join(',\n')
        const plain = ic.map(c => `${qi(c.n)} = ${ruleLit(t, c, 1)}`).join(', ')
        const allSet = [setLines, plain].filter(Boolean).join(setLines && plain ? ',\n' : '')
        chunks.push(`UPDATE ${qi(t.name)} SET\n` + allSet
          + `\nWHERE ${qi(pkc.n)} IN (${idx.map(x => litByCol(pkc, x)).join(', ')});`)
      }
      body = chunks.join('\n\n')
    } else {
      const parts = []
      let bno = 0
      for (let g = 0; g < pks.length; g += S.upBatch){
        const grp = []
        for (let j = g; j < Math.min(g + S.upBatch, pks.length); j++) grp.push(stmtFor(j + 1))
        if (pks.length > S.upBatch){ bno++; parts.push(`-- ── 第 ${bno} 批（${grp.length} 条）──`) }
        parts.push(grp.join('\n\n'))
      }
      body = parts.join('\n\n')
    }

    const sample = pks.slice(0, 10)
    const pv = `<table class="tbl"><thead><tr><th>${esc(pkc.n)}（主键）</th>`
      + sets.map(c => `<th>${esc(c.n)} 新值</th>`).join('')
      + '</tr></thead><tbody>'
      + sample.map((p, j) => '<tr><td class="mono">' + esc(p) + '</td>'
          + sets.map(c => `<td class="mono">${esc(ruleLit(t, c, j + 1))}</td>`).join('') + '</tr>').join('')
      + (pks.length > sample.length
          ? `<tr><td class="mono muted" colspan="${sets.length + 1}">… 其余 ${pks.length - sample.length} 行见语句</td></tr>` : '')
      + '</tbody></table>'
      + '<div class="hint" style="margin-top:6px">「原值 → 新值」对比需要连库取旧值——离线场景用「从SELECT结果导入」做对比</div>'

    return { sql: head + '\n\n' + body + '\n',
             stat: `${pks.length} 个主键 · ${S.upFmt === 'case' ? 'CASE WHEN' : '逐条'}`,
             pv, pvLabel: `共 ${pks.length} 行（前 ${sample.length} 抽样）`,
             warn: warnOf() }
  }

  function genUpdateCond(){
    const t = byName[S.table], D = DIALECTS[S.dia]
    const conds = t.columns.filter(c => S.condOn[c.n])
    const whereTxt = conds.length
      ? conds.map(c => {
          const v = String(S.cval[c.n] ?? '').trim()
          return v === '' || /^null$/i.test(v)
            ? `${qi(c.n)} IS NULL`
            : `${qi(c.n)} = ${litByCol(c, v)}`
        }).join('\n  AND ')
      : null
    if (!conds.length)
      return refuse('至少勾一个条件字段：无 WHERE 的批量 UPDATE 改的是全表\n这是防呆，不是限制——真要清空条件请回 SELECT导入 或单条模式',
        { tone: 'err', html: '<b>一个条件都没勾：</b>生成的语句会不带 WHERE、改掉全表，所以拒绝生成。勾上条件或改用其他定位方式。' },
        '勾选 WHERE 条件字段后，这里明示最终子句')
    const sets = setColsOf(t)
    if (!sets.length)
      return refuse('还不能生成：先在左边勾选 SET 字段\n新值来自字段规则（默认 §4.4 自动值；要统一值就把规则改成「固定值」）',
        null, '勾好 SET 字段后出语句')
    const anyVary = sets.some(c => varying(c))
    const head = banner([
      `批量UPDATE : ${t.name} (${t.comment}) · 定位方式：条件字段`,
      `WHERE：${conds.map(c => c.n).join(' AND ')} · SET：${sets.map(c => c.n).join('，')} · ${D.label}`,
      ...(anyVary ? [`注意：SET 规则随行号变化，此模式统一取第 1 行的值套用到所有匹配行`] : []),
      `影响多少行执行前先拿同条件 SELECT 核一遍 —— 工具不猜行数`,
    ])
    const sql = head + '\n\nUPDATE ' + qi(t.name) + ' SET\n'
      + sets.map(c => `  ${qi(c.n)} = ${ruleLit(t, c, 1)}`).join(',\n')
      + '\nWHERE\n  ' + whereTxt + ';\n'
    const pv = '<pre style="margin:0;white-space:pre-wrap;font:12.5px/1.6 var(--mono)">WHERE\n  '
      + esc(whereTxt) + '</pre>'
    return { sql, stat: `${conds.length} 个条件`, pv,
             pvLabel: `${conds.length} 个条件 AND 连接`,
             warn: anyVary ? { tone: 'warn', html: '<b>SET 规则含模板/随机类：</b>此模式没有行号，全部匹配行都取第 1 行的值；要每行不同请用主键列表定位。' } : null }
  }

  function genUpdateFixed(){
    const t = byName[S.table], D = DIALECTS[S.dia]
    const sets = setColsOf(t)
    if (!sets.length)
      return refuse('还不能生成：先在左边勾选 SET 字段\n新值来自字段规则（默认 §4.4 自动值；要统一值就把规则改成「固定值」）',
        null, '勾好 SET 字段后出语句')
    if (!S.fixedOk)
      return refuse('「按固定条件」就是 WHERE 1=1：这张表的每一行都会被改掉。\n先在左边勾选确认框，再回来生成。',
        { tone: 'err', html: '<b>全表更新（慎用）：</b>该定位不带任何过滤。真要执行，先勾选「我确认要更新这张表的全部行」。' },
        '确认后这里展示最终语句')
    const head = banner([
      `批量UPDATE : ${t.name} (${t.comment}) · 定位方式：固定条件 WHERE 1=1 ⚠ 全表更新`,
      `SET：${sets.map(c => c.n).join('，')} · ${D.label}`,
      `执行前务必拿 SELECT COUNT(*) 核一遍行数；建议先在事务里跑，确认影响行数再提交`,
    ])
    const sql = head + '\n\nUPDATE ' + qi(t.name) + ' SET\n'
      + sets.map(c => `  ${qi(c.n)} = ${ruleLit(t, c, 1)}`).join(',\n')
      + '\nWHERE 1=1;\n'
    return { sql, stat: '全表（WHERE 1=1）',
             pv: '<pre style="margin:0;white-space:pre-wrap;font:12.5px/1.6 var(--mono)">UPDATE ' + esc(qi(t.name))
               + ' SET …\nWHERE 1=1;   ← 无任何过滤，每一行都会被更新</pre>',
             pvLabel: '慎用：影响全表',
             warn: { tone: 'warn', html: '<b>这条语句会更新全表。</b>规格标了「慎用」——确认框挡住的是误触，挡不住决心，执行前再核一遍行数。' } }
  }

  const Tbl = () => byName[S.table]

  const RKINDS = [
    { v: 'auto',  l: '沿用自动值' },
    { v: 'tpl',   l: '模板 {n}' },
    { v: 'fixed', l: '固定值' },
    { v: 'rnum',  l: '随机 · 数字' },
    { v: 'rstr',  l: '随机 · 字符串' },
    { v: 'renum', l: '随机 · 枚举' },
    { v: 'rdate', l: '随机 · 日期' },
    { v: 'phone', l: '随机 · 手机号' },
    { v: 'email', l: '随机 · 邮箱' },
    { v: 'name',  l: '随机 · 姓名' },
    { v: 'now',   l: '当前时间 NOW()' },
    { v: 'null',  l: 'NULL' },
  ]
  const RPARAM = {
    tpl:   [{ dft: 'xx_{n}', ph: '前缀_{n}', tt: '{n} 会替换成行号（1 起）' }],
    fixed: [{ dft: '', ph: '所有行都用这个值', tt: '数字/日期会按字段类型转字面量' }],
    rnum:  [{ dft: '1', ph: '最小', tt: '随机整数下界' }, { dft: '100', ph: '最大', tt: '闭区间，含两端' }],
    rstr:  [{ dft: '8', ph: '长度', tt: '字符个数' }, { dft: 'alnum', ph: '字符集', tt: 'alnum=字母数字 / num=纯数字 / lower=小写字母' }],
    renum: [{ dft: 'A,B,C', ph: '逗号分隔候选值', tt: '每次从中取一个' }],
    rdate: [{ dft: '2026-01-01', ph: '起始日期', tt: '' }, { dft: '2026-12-31', ph: '结束日期', tt: '随机落在区间内（含端点）' }],
  }

  function dispVal(t, c, i = 1){
    const r = S.rule[c.n] || {}
    if (r.k === 'now') return DIALECTS[S.dia].now
    if (r.k === 'null') return 'NULL'
    if (!r.k || r.k === 'auto') return legacyAuto(t, c, i)
    return ruleText(c, i)
  }

  function paintRules(hostId, forInsert){
    const t = Tbl(), host = $(hostId)
    if (!host) return
    host.innerHTML = (forInsert ? t.columns : t.columns.filter(c => !c.pk)).map(c => {
      const r = S.rule[c.n] || {}
      const k = r.k || 'auto'
      const lockAi = forInsert && c.ai
      return `
        <div class="prow">
          ${forInsert ? '' : `<label class="cb"><input type="checkbox" data-k="${esc(c.n)}"
            ${S.setOn[c.n] ? 'checked' : ''}></label>`}
          <span class="cn">${esc(c.n)}</span>
          <span class="cc">${esc(c.c || '')}${c.ai ? ' · 自增' : ''}</span>
          ${lockAi
            ? `<span class="hint" style="flex:none;width:150px;text-align:center">${/^\d+$/.test(String(S.startId).trim()) ? Number(S.startId) + ' 起连续编号' : '自动排除'}</span>`
            : `<select class="fld rk" data-rk="${esc(c.n)}">${RKINDS.map(o =>
                `<option value="${o.v}" ${o.v === k ? 'selected' : ''}>${o.l}</option>`).join('')}</select>`
              + (RPARAM[k] || []).map((sp, ix) => `<input class="fld rp" data-rp="${esc(c.n)}" data-slot="${ix ? 'b' : 'a'}"
                  value="${esc(r.p?.[ix ? 'b' : 'a'] ?? sp.dft)}" placeholder="${sp.ph}" title="${sp.tt}"
                  style="width:${ix ? 96 : 118}px">`).join('')}
          <div class="spacer"></div>
          <span class="rv" title="第 1 行的预览值">${esc(dispVal(t, c))}</span>
        </div>`
    }).join('') || '<div class="empty">这张表除主键外没有可用的字段</div>'
    host.onchange = e => {
      const el = e.target
      if (el.dataset.rk !== undefined){
        const ps = RPARAM[el.value]
        S.rule[el.dataset.rk] = { k: el.value,
          p: ps ? Object.fromEntries(ps.map((sp, ix) => [ix ? 'b' : 'a', sp.dft])) : {} }
      }
      if (el.dataset.rp !== undefined){
        const r = S.rule[el.dataset.rp] ||= { k: 'fixed', p: {} }
        r.p[el.dataset.slot] = el.value
      }
      if (el.dataset.k !== undefined) S.setOn[el.dataset.k] = el.checked
      paint()
    }
  }

  function paintCondFields(){
    const t = Tbl(), host = $('#condList')
    if (!host) return
    host.innerHTML = t.columns.map(c => `
      <div class="prow">
        <label class="cb"><input type="checkbox" data-k="${esc(c.n)}" ${S.condOn[c.n] ? 'checked' : ''}></label>
        <span class="cn">${esc(c.n)}</span>
        <span class="cc">${esc(c.c || '')}</span>
        <div class="spacer"></div>
        <input class="fld tgt" data-tk="${esc(c.n)}" value="${esc(S.cval[c.n] ?? '')}"
          placeholder="留空 = IS NULL" style="width:150px">
      </div>`).join('')
    host.onchange = e => {
      const el = e.target
      if (el.dataset.k !== undefined) S.condOn[el.dataset.k] = el.checked
      if (el.dataset.tk !== undefined) S.cval[el.dataset.tk] = el.value
      paint()
    }
  }

  function paintResult(r, name){
    const w = $('#warn')
    if (w){
      if (r.warn){ w.hidden = false; w.className = 'band ' + r.warn.tone; w.innerHTML = r.warn.html }
      else w.hidden = true
    }
    if ($('#sqlOut')) $('#sqlOut').innerHTML = sqlHi(r.sql)
    if ($('#statLbl')) $('#statLbl').textContent = r.stat || ''
    if ($('#fnName')) $('#fnName').textContent = name
    if ($('#codeMeta')) $('#codeMeta').textContent = r.sql.split('\n').length + ' 行 / ' + r.sql.length + ' 字符'
    window.__lastSql = r.sql
  }

  function paintInsert(){
    const t = Tbl()
    if ($('#tblSel')) $('#tblSel').innerHTML = tables.map(x =>
      `<option value="${esc(x.name)}" ${x.name === S.table ? 'selected' : ''}>${esc(x.name)} — ${esc(x.comment)}</option>`).join('')
    for (const [segId, key] of [['#diaSeg', 'dia'], ['#insSeg', 'insFmt'], ['#perSeg', 'perStmt']])
      $(segId)?.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === String(S[key])))
    $('#insSeg')?.querySelectorAll('button[data-v="multi"],button[data-v="chunk"]')
      .forEach(b => { b.disabled = S.dia !== 'mysql'; b.title = S.dia !== 'mysql'
        ? '多 VALUES 只有 MySQL 方言支持（Oracle 要 INSERT ALL）；先切到 MySQL 再选'
        : b.dataset.v === 'chunk' ? '每 N 条一组 INSERT，组内是多 VALUES；超 1MB 自动再切'
          : '拼成一条 INSERT … VALUES (…),(…)…' })
    if ($('#perRow')) $('#perRow').hidden = S.insFmt !== 'chunk'
    paintRules('#insRules', true)
    const r = genInsert()
    const cols = t.columns.filter(c => !c.ai || /^\d+$/.test(String(S.startId).trim()))
    const sid = /^\d+$/.test(String(S.startId).trim()) ? parseInt(S.startId, 10) : null
    const rows = Math.min(10, S.n)
    if ($('#pvTitle')) $('#pvTitle').textContent = `预览前 ${rows} 行（共 ${S.n} 行）`
    if ($('#pvLbl')) $('#pvLbl').textContent = ''
    const pvCell = (c, k) => {
      let v = c.ai && sid !== null ? String(sid + k) : dispVal(t, c, k + 1)
      if (v === '') v = '（参数未填）'
      return `<td class="mono">${esc(v)}</td>`
    }
    if ($('#preview')) $('#preview').innerHTML =
      `<div class="scroll"><table class="tbl"><thead><tr><th>#</th>${cols.map(c => `<th>${esc(c.n)}</th>`).join('')}</tr></thead><tbody>`
      + Array.from({ length: rows }, (_, k) => '<tr><td class="mono muted">' + (k + 1) + '</td>'
          + cols.map(c => pvCell(c, k)).join('') + '</tr>').join('')
      + '</tbody></table></div>'
      + (S.n > rows ? `<div class="hint" style="margin-top:6px">预览只画前 ${rows} 行，完整 ${S.n} 条看上面的语句</div>` : '')
    paintResult(r, `${S.table}_batch_insert_${S.dia}.sql`)
  }

  function paintUpdate(){
    if ($('#tblSel')) $('#tblSel').innerHTML = tables.map(x =>
      `<option value="${esc(x.name)}" ${x.name === S.table ? 'selected' : ''}>${esc(x.name)} — ${esc(x.comment)}</option>`).join('')
    for (const [segId, key] of [['#diaSeg', 'dia'], ['#locSeg', 'loc'], ['#upFmtSeg', 'upFmt']])
      $(segId)?.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === String(S[key])))
    if ($('#pkCard')) $('#pkCard').hidden = S.loc !== 'pk'
    if ($('#condCard')) $('#condCard').hidden = S.loc !== 'cond'
    if ($('#fixedCard')) $('#fixedCard').hidden = S.loc !== 'fixed'
    if ($('#setCard')) $('#setCard').hidden = S.loc === 'src'
    if ($('#srcCard')) $('#srcCard').hidden = S.loc !== 'src'
    if ($('#upBatchHint')) $('#upBatchHint').textContent = S.upFmt === 'case'
      ? 'CASE WHEN 固定每 100 条一组' : `逐条每 ${S.upBatch} 条一组注释分隔`

    let r
    if (S.loc === 'src'){
      r = { sql: '-- 从SELECT结果导入已上线：点左侧链接进 select2update.html 体验\n', stat: '', warn: null }
      if ($('#pvTitle')) $('#pvTitle').textContent = '预览'
      if ($('#pvLbl')) $('#pvLbl').textContent = ''
      if ($('#preview')) $('#preview').innerHTML = '<div class="empty">该定位方式在独立页面里，点左边链接过去</div>'
    } else {
      if (S.loc === 'cond') paintCondFields()
      paintRules('#setRules', false)
      if ($('#varyHint')) $('#varyHint').hidden = !setColsOf(Tbl()).some(c => varying(c))
      r = S.loc === 'pk' ? genUpdatePk() : S.loc === 'cond' ? genUpdateCond() : genUpdateFixed()
      if ($('#pvTitle')) $('#pvTitle').textContent = S.loc === 'pk' ? '主键与新值抽样' : S.loc === 'cond' ? '最终 WHERE 子句' : '最终语句'
      if ($('#pvLbl')) $('#pvLbl').textContent = r.pvLabel ?? ''
      if ($('#preview')) $('#preview').innerHTML = r.pv
      if ($('#pkStat')) $('#pkStat').innerHTML = S.loc === 'pk'
        ? parsePkList(S.pkRaw).list.length + ' 个主键待更新' : ''
    }
    paintResult(r, `${S.table}_batch_update_${S.loc}_${S.dia}.sql`)
  }

  function paint(){
    if (pageMode() === 'update') paintUpdate()
    else paintInsert()
  }

  const bindSeg = (sel, fn) => {
    const el = $(sel)
    if (!el) return
    el.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || b.disabled) return; fn(b.dataset.v); paint()
    })
  }
  const bind = (sel, evt, fn) => {
    const el = $(sel)
    if (!el) return
    el.addEventListener(evt, e => { fn(e); paint() })
  }

  bindSeg('#diaSeg', v => { S.dia = v; if (v !== 'mysql') S.insFmt = 'each' })
  bindSeg('#locSeg', v => { S.loc = v })
  bindSeg('#insSeg', v => { S.insFmt = v })
  bindSeg('#perSeg', v => { S.perStmt = +v })
  bindSeg('#upFmtSeg', v => { S.upFmt = v })

  bind('#tblSel', 'change', e => { S.table = e.target.value })
  bind('#cntInp', 'input', e => {
    const v = parseInt(e.target.value, 10)
    if (!Number.isNaN(v)) S.n = Math.min(500, Math.max(1, v))
  })
  bind('#startIdInp', 'input', e => {
    const v = e.target.value.trim()
    S.startId = /^\d+$/.test(v) ? v : ''
  })
  bind('#pkPaste', 'input', e => { S.pkRaw = e.target.value })
  bind('#upBatchInp', 'change', e => {
    const v = parseInt(e.target.value, 10)
    if (!Number.isNaN(v)) S.upBatch = Math.min(500, Math.max(1, v))
  })
  bind('#hdrCb', 'change', e => { S.hdr = e.target.checked })
  bind('#fixedOkCb', 'change', e => { S.fixedOk = e.target.checked })
  $('#cpBtn')?.addEventListener('click', () => copy(window.__lastSql ?? '', $('#cpBtn')))
  $('#dlBtn')?.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([window.__lastSql ?? ''], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a'); a.href = url; a.download = $('#fnName')?.textContent || 'batch.sql'; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  })

  if ($('#diaSeg')){
    $('#diaSeg').innerHTML = Object.entries(DIALECTS)
      .map(([k, D]) => `<button data-v="${k}">${esc(D.label)}</button>`).join('')
  }

  paint()

  globalThis.__T = () => ({
    S, parsePkList, legacyAuto, ruleText, ruleLit, litByCol,
    genInsert, genUpdatePk, genUpdateCond, genUpdateFixed,
    set: (k, v) => { S[k] = v },
  })
}
