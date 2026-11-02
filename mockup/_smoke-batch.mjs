// 批量 INSERT / UPDATE 管线冒烟：直接跑 _batch.js，不走 DOM。
// 改原型后重跑：node _smoke-batch.mjs
import fs from 'node:fs'
import vm from 'node:vm'

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
    documentElement: stub(),
    querySelector: () => stub(),
    querySelectorAll: () => [],
    createElement: () => stub(),
    head: { appendChild() {} },
    body: { appendChild() {}, dataset: {} },
    addEventListener() {},
  },
  window: { dispatchEvent() {}, addEventListener() {} },
  location: { search: '' },
  URLSearchParams,
  addEventListener() {},
  navigator: {}, setTimeout() {}, URL, Blob: class {}, CustomEvent: class {},
}
vm.createContext(ctx)

for (const f of ['_shell.js', '_data.js']) {
  vm.runInContext(fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'), ctx, { filename: f })
}
ctx.DATA = ctx.window.DATA
ctx.UI = ctx.window.UI
if (!ctx.DATA || !ctx.UI) throw new Error('DATA/UI 桥接失败')

const js = fs.readFileSync(new URL('./_batch.js', import.meta.url), 'utf8')
vm.runInContext(js, ctx, { filename: '_batch.js' })
if (!ctx.__T) throw new Error('__T 冒烟钩子没挂上（页面脚本中途抛了？）')
const T = ctx.__T()
const j = v => JSON.stringify(v)
const cnt = (s, re) => (String(s).match(re) ?? []).length

let pass = 0, fail = 0
const eq = (name, got, want) => {
  const ok = String(got).includes(String(want))
  console.log((ok ? '✓' : '✗') + ' ' + name)
  if (!ok) { fail++; console.log('  期望包含: ' + JSON.stringify(want)); console.log('  实际: ' + JSON.stringify(got)) }
  else pass++
}

const base = () => {
  T.set('mode', 'insert'); T.set('table', 'order'); T.set('dia', 'mysql')
  T.set('n', 3); T.set('insFmt', 'each'); T.set('hdr', true); T.set('startId', '')
  T.S.rule = {}; T.S.setOn = {}; T.S.condOn = {}; T.S.cval = {}
}

/* ── 1. 批量INSERT · 逐条 · 默认规则（§4.4 自动值）── */
base()
let r = T.genInsert()
eq('order 是保留字，MySQL 加反引号', r.sql, 'INSERT INTO `order`')
eq('列清单=非自增列、保持表定义序（起始ID留空 → 自增 id 整列排除）',
  r.sql, '(user_id, order_no, total, status, create_time)')
eq('条数=3：逐条出 3 句', String(cnt(r.sql, /INSERT INTO/g)), '3')
eq('订单号按行号造值（第 1 行 …0001）', r.sql, "'NO202608260001'")
eq('BigDecimal 随行号递增（199.50 → 399.50）', r.sql.match(/199\.50[\s\S]*399\.50/) ? 'yes' : 'no', 'yes')
const again = T.genInsert()
eq('同配置两次生成逐字符一致（种子是行号，不是随机数）', String(again.sql === r.sql), 'true')

/* ── 2. 多 VALUES / 注释头开关 / 方言 ── */
T.set('insFmt', 'multi'); r = T.genInsert()
eq('多VALUES 整体只有一条 INSERT', String(cnt(r.sql, /INSERT INTO/g)), '1')
eq('多VALUES 行与行以 "),\\n(" 相接', r.sql, '),\n(')
T.set('hdr', false)
eq('关掉注释头后输出不以 -- 开头', String(T.genInsert().sql.startsWith('-- ')), 'false')
T.set('hdr', true); T.set('dia', 'oracle'); r = T.genInsert()
eq('Oracle 保留字表名换双引号', r.sql, '"order"')
eq('Oracle 输出里一个反引号都没有', String(r.sql.includes('`')), 'false')

/* ── 3. 起始ID（§4.15：留空排除自增列，填了就连号写进去）── */
// insFmt 得显式掉回「逐条」：上一段把它改成了 multi，而下面两条断言的是逐条形态的缩进
// （`\n  (500, `）——不换回来就是在拿 multi 的输出套逐条的尺子，挂了也不是代码的错
T.set('dia', 'mysql'); T.set('insFmt', 'each'); T.set('startId', '500'); r = T.genInsert()
eq('给了起始ID：自增列回到列清单第一位', r.sql, '(id, user_id')
eq('第 1 行从 500 起编', r.sql, '\n  (500, ')
eq('第 3 行编到 502', r.sql, '\n  (502, ')
T.set('startId', '')

/* ── 4. 字段级规则引擎（§4.15 那 12 种里的代表）── */
T.S.rule.order_no = { k: 'tpl', p: { a: 'NO-{n}' } }
r = T.genInsert()
eq('模板 {n} 按行号展开', r.sql, "'NO-1'")
T.S.rule.order_no = { k: 'phone' }
r = T.genInsert()
eq('手机号规则出 138 开头的 11 位', String(/'138\d{8}'/.test(r.sql)), 'true')
T.S.rule.order_no = { k: 'fixed', p: { a: 'KEEP' } }
r = T.genInsert()
eq('固定值三行全一样', String(cnt(r.sql, /'KEEP'/g)), '3')
T.S.rule.total = { k: 'rnum', p: { a: '66', b: '66' } }
r = T.genInsert()
eq('随机数字 min=max 时每行都是该值（区间闭含两端）', r.sql, ', 66,')
T.S.rule.create_time = { k: 'now' }
r = T.genInsert()
eq('当前时间给函数字面量（MySQL=NOW()），不是拼死的字符串', r.sql, ', NOW())')
T.S.rule.status = { k: 'null' }
r = T.genInsert()
eq('NULL 规则原样出 NULL 关键字', r.sql, ', NULL,')

/* ── 5. 分批格式（§4.15：每组一个多 VALUES 的 INSERT；>1MB 再切由同一段代码管）── */
T.S.rule = {}; T.set('insFmt', 'chunk'); T.set('perStmt', 2)
r = T.genInsert()
eq('3 条按每组 2 条切成 2 个 INSERT', String(cnt(r.sql, /INSERT INTO/g)), '2')
eq('只有第一组内部有行间连接符', String(cnt(r.sql, /\),\n\(/g)), '1')
T.set('insFmt', 'each')

/* ── 6. 主键列表解析（§4.16 三种写法）── */
eq('逗号/中文逗号/分号/空白混切 + 保序去重',
  j(T.parsePkList('1001 1005，1009;1013\n1005 1017').list),
  '["1001","1005","1009","1013","1017"]')
eq('范围写法 1-3 展开成闭区间并与散值合并去重',
  j(T.parsePkList('1-3, 9').list), '["1","2","3","9"]')
const big = T.parsePkList('1-999999')
eq('跨度超上限的范围整段跳过并计数（不卡死页面）',
  `${big.list.length}个/${big.overRange}超限`, '0个/1超限')

/* ── 7. 批量UPDATE · 主键列表 ─ */
base(); T.set('mode', 'update'); T.set('loc', 'pk'); T.set('table', 'order')
T.S.pkRaw = ''; let rr = T.genUpdatePk()
eq('没贴主键不硬生成', rr.sql, '先粘贴主键列表')
T.S.pkRaw = '1001 1005，1009;1013\n1005 1017'; T.S.setOn = {}; rr = T.genUpdatePk()
eq('没勾 SET 字段也不悄悄生成', rr.sql, '先在左边勾选 SET 字段')
T.S.setOn = { status: true }; r = T.genUpdatePk()
eq('逐条格式：每个主键一条 UPDATE', String(cnt(r.sql, /UPDATE `/g)), '5')
eq('主键各自进各自的 WHERE', r.sql, 'WHERE id = 1013;')
eq('注释头把语义边界写在语句前面（没有旧值可比，全部主键进 WHERE）', r.sql, '全部给定主键都进 WHERE')
T.set('upFmt', 'case'); T.S.rule.status = { k: 'fixed', p: { a: '2' } }; r = T.genUpdatePk()
eq('SET 值全固定时 CASE WHEN 退化成普通 IN 更新', r.sql, 'WHERE id IN (')
eq('退化形式照样带 SET 赋值', r.sql, 'status = 2')
eq('5 个主键一组内收成 1 条语句', String(cnt(r.sql, /UPDATE `order` SET/g)), '1')
T.S.rule.status = { k: 'rnum', p: { a: '1', b: '9' } }; r = T.genUpdatePk()
eq('随行变化的值走 CASE id WHEN … THEN …', r.sql, 'CASE id')
eq('THEN 后面是该行的规则值', r.sql, 'WHEN 1001 THEN ')
T.set('upFmt', 'each'); T.S.rule = {}
T.set('table', 'user_role'); T.S.setOn = { role_id: true }; T.S.rule.role_id = { k: 'fixed', p: { a: '9' } }
r = T.genUpdatePk()
eq('复合主键表出黄色警告（WHERE 只用了第一列）', String(r.warn?.tone ?? ''), 'warn')

/* ── 8. 批量UPDATE · 条件字段 ── */
base(); T.set('mode', 'update'); T.set('loc', 'cond'); T.set('table', 'order')
T.S.condOn = {}; T.S.cval = {}; T.S.setOn = { total: true }
T.S.rule.total = { k: 'fixed', p: { a: '666.00' } }
rr = T.genUpdateCond()
eq('零条件拒绝生成（无 WHERE 改的是全表）', rr.sql, '至少勾一个条件字段')
eq('零条件的提示带 err 色', String(rr.warn?.tone ?? ''), 'err')
T.S.condOn = { status: true }; T.S.cval = { status: '' }
r = T.genUpdateCond()
eq('条件值留空 = IS NULL（永远不是 = NULL）', r.sql, 'status IS NULL')
eq('SET 值来自规则引擎的固定值', r.sql, 'total = 666.00')
T.S.cval = { status: '1' }
r = T.genUpdateCond()
eq('条件 AND 连接、分号收尾', r.sql, 'status = 1;')
T.S.rule.total = { k: 'tpl', p: { a: '{n}' } }
r = T.genUpdateCond()
eq('随行变化的规则在条件模式下降级并黄牌提示（只取第 1 行的值）', String(r.warn?.tone ?? ''), 'warn')

/* ── 9. 批量UPDATE · 固定条件（§4.16 第三种定位，慎用）─── */
base(); T.set('mode', 'update'); T.set('loc', 'fixed'); T.set('table', 'order')
T.S.fixedOk = false; T.S.setOn = { status: true }
rr = T.genUpdateFixed()
eq('没勾确认不出语句', rr.sql, '确认')
eq('未确认的提示带 err 色', String(rr.warn?.tone ?? ''), 'err')
T.S.fixedOk = true
r = T.genUpdateFixed()
eq('确认后出 WHERE 1=1 全表更新', r.sql, 'WHERE 1=1;')
eq('全表更新常驻黄色警告', String(r.warn?.tone ?? ''), 'warn')

/* ── 10. 确定性抽查：随机规则与自动值的种子都是行号 ── */
base()
T.S.rule.total = { k: 'rnum', p: { a: '1', b: '100' } }
const g1 = T.genInsert(), g2 = T.genInsert()
eq('「随机」数字两次生成也逐字符一致（哈希种子，评审可比对）', String(g1.sql === g2.sql), 'true')
const prod = ctx.DATA.byName.product   // byName 是表名→表的映射，不是函数
const onSale = prod.columns.find((c) => c.n === 'on_sale')
const m1 = T.legacyAuto(prod, onSale, 1), m2 = T.legacyAuto(prod, onSale, 2), m3 = T.legacyAuto(prod, onSale, 3)
eq('Boolean 按行交替且周期为 2（单条模式恒 true 的对照面）', String(m1 !== m2 && m1 === m3), 'true')

console.log(`\n${pass} 过 / ${fail} 挂`)
process.exit(fail ? 1 : 0)
