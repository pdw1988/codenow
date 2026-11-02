// select2update.html 的管线冒烟：桩 DOM 里整页跑起来，直接驱动 解析→认主键→生成，
// 断言四种粘贴形状、格式自动选择和方言输出。改原型后重跑一遍（node _smoke-s2u.mjs），
// 期望值挂了先分清是「代码错了」还是「期望没跟上」——上一轮 4 个挂全是后者（id/total
// 不是保留字不该带反引号；无表头对齐的是 order 表真实列序，第 2 列是 user_id）。
import fs from 'node:fs'
import vm from 'node:vm'

const html = fs.readFileSync(new URL('./select2update.html', import.meta.url), 'utf8')
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1]

// 万能元素桩：任何属性可读可写、任何方法调用返回新桩。原型脚本只做赋值和遍历，够用
const stub = () => new Proxy(() => {}, {
  get(t, p) {
    if (p === 'classList') return { toggle() {}, add() {}, remove() {} }
    if (p === 'dataset' || p === 'style') return {}
    if (p === Symbol.toPrimitive) return () => ''
    return stub()
  },
  set() { return true },
  apply() { return stub() },
})
const ctx = {
  document: {
    readyState: 'complete',
    documentElement: stub(),          // _shell.js 的 apply() 往 dataset.theme 上写
    querySelector: () => stub(),
    querySelectorAll: () => [],
    createElement: () => stub(),
    head: { appendChild() {} },
    body: { appendChild() {} },
    addEventListener() {},
  },
  window: { dispatchEvent() {}, addEventListener() {} },
  location: { search: '' },
  URLSearchParams,
  addEventListener() {},
  navigator: {}, setTimeout() {}, URL, Blob: class {}, CustomEvent: class {},
}
vm.createContext(ctx)

// 页面在浏览器里按 _shell.js → _data.js → 内联脚本顺序加载，前两个把 DATA/UI 挂到 window；
// 这里照原序跑完再桥接成裸全局，内联脚本里解构的 DATA/UI 才拿得到
for (const f of ['_shell.js', '_data.js']) {
  vm.runInContext(fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'), ctx, { filename: f })
}
ctx.DATA = ctx.window.DATA
ctx.UI = ctx.window.UI
if (!ctx.DATA || !ctx.UI) throw new Error('DATA/UI 桥接失败')

// 暴露内部状态和管线函数给测试用（const 声明在同段脚本作用域里，追加代码可直接摸到）
vm.runInContext(js + `
;(globalThis).__T = () => ({ S, parseRaw, syncAfterParse, includedIdx, resolveFmt, genSql,
  set: (k, v) => { S[k] = v } })`, ctx)
const T = ctx.__T()

let pass = 0, fail = 0
const eq = (name, got, want) => {
  const ok = got.includes(want)
  console.log((ok ? '✓' : '✗') + ' ' + name)
  if (!ok) { fail++; console.log('  期望包含: ' + JSON.stringify(want)); console.log('  实际: ' + JSON.stringify(got)) }
  else pass++
}

// ── 1. 带表头的竖线表格（Navicat 复制的形状）→ 自动勾 status=1 → IN 列表只含变化的行
T.set('table', 'order'); T.set('raw', [
  'id | order_no | status | total',
  '101 | NO001 | 0 | 99.00',
  '102 | NO002 | 1 | 199.00',
  '103 | NO003 | 0 | 59.50',
].join('\n'))
T.parseRaw(); T.syncAfterParse()
let inc = T.includedIdx(), r = T.resolveFmt(inc)
eq('表头识别出 4 列', JSON.stringify(T.S.parsed.cols.map(c => c.name)), '"id","order_no","status","total"')
eq('自动勾选 status 且目标值 1（用户旅程的行为）', JSON.stringify([T.S.updOn.status, T.S.tgt.status]), 'true,"1"')
eq('只把值有变化的行放进 WHERE（取用户旅程一节的 IN 范围）',
  T.genSql(inc, r), 'WHERE id IN (101, 103);')
eq('已是目标值的行不进 SQL', String(!inc.includes(1)), 'true')

// ── 2. total 不勾目标值（以粘贴值为准）→ CASE WHEN 逐行赋值
T.S.updOn = { total: true }; T.S.tgt = {}
inc = T.includedIdx(); r = T.resolveFmt(inc)
eq('逐行不同值自动选 CASE WHEN', r.kind + String(r.auto || ''), 'casetrue')
const sql2 = T.genSql(inc, r)
eq('CASE 按主键逐行赋值', sql2, 'total = CASE id\n    WHEN 101 THEN 99.00')
eq('CASE 也带 WHERE IN 全集', sql2, 'WHERE id IN (101, 102, 103);')

// ── 3. 手动选 IN 但有字段逐行不同 → 不硬拗，降级 CASE 并给警告
T.set('fmt', 'in')
r = T.resolveFmt(T.includedIdx())
eq('手动 IN 遇到逐行不同值降级 CASE + 警告', r.kind + ':' + String(r.warn.includes('IN 格式表达不了')), 'case:true')
T.set('fmt', 'auto')

// ── 4. 无表头纯文本 → 按位置对齐当前表字段。对的是 order 表自己的列序
//   （id, user_id, order_no, total, status, create_time），不是粘贴内容猜出来的列
T.set('raw', '201 8 NO004 77.00 1 2026-08-02'); T.parseRaw(); T.syncAfterParse()
eq('无表头按位置对齐表结构列序',
  JSON.stringify(T.S.parsed.cols.map(c => c.name)),
  '"id","user_id","order_no","total","status","create_time"')

// ── 5. 单列主键列表 → 单列模式，没勾字段时不生成语句只给提示
T.set('raw', '301\n302'); T.parseRaw(); T.syncAfterParse()
eq('单列识别成主键列表', T.S.parsed.single + ':' + T.S.parsed.cols[0].name, 'true:id')

// ── 6. Oracle 方言：保留字表名加引号、日期走 TO_DATE、字符串转义单引号
T.set('dia', 'oracle')
T.set('raw', "id | order_no | remark | create_time\n401 | NO9 | it's ok | 2026-08-01 10:00:00")
T.parseRaw(); T.syncAfterParse()
T.S.updOn = { remark: true, create_time: true }; T.S.updOn.status = false; T.S.tgt = { remark: "done't" }
inc = T.includedIdx(); r = T.resolveFmt(inc)
const sql6 = T.genSql(inc, r)
eq('Oracle 保留字表名加引号', sql6, 'UPDATE "order" SET')
eq("Oracle 字符串内单引号翻倍", sql6, "'done''t'")
eq('Oracle 日期走 TO_DATE', sql6, "TO_DATE('2026-08-01 10:00:00','YYYY-MM-DD HH24:MI:SS')")

console.log(`\n${pass} 过 / ${fail} 挂`)
process.exit(fail ? 1 : 0)
