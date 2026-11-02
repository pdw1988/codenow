// sqlfav.html 的管线冒烟：桩 DOM 里整页跑起来，直接驱动收藏夹的纯函数——
// 四路搜索+双筛选、最近使用/最常用排序、表名自动提取、命中高亮（转义不错位）、
// 必填校验的增改删、使用计数、JSON 导入的去重与坏行容错。改原型后重跑：
//   node _smoke-fav.mjs
import fs from 'node:fs'
import vm from 'node:vm'

const html = fs.readFileSync(new URL('./sqlfav.html', import.meta.url), 'utf8')
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
  FileReader: class {},
}
vm.createContext(ctx)

for (const f of ['_shell.js', '_data.js']) {
  vm.runInContext(fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'), ctx, { filename: f })
}
ctx.DATA = ctx.window.DATA
ctx.UI = ctx.window.UI
if (!ctx.DATA || !ctx.UI) throw new Error('DATA/UI 桥接失败')

vm.runInContext(js, ctx)
if (!ctx.__T) throw new Error('__T 冒烟钩子没挂上（页面脚本中途抛了？）')
const T = ctx.__T()
const j = v => JSON.stringify(v)

let pass = 0, fail = 0
const eq = (name, got, want) => {
  const ok = String(got).includes(String(want))
  console.log((ok ? '✓' : '✗') + ' ' + name)
  if (!ok) { fail++; console.log('  期望包含: ' + JSON.stringify(want)); console.log('  实际: ' + JSON.stringify(got)) }
  else pass++
}

/* ── 1. 四路搜索 + 标签/表名筛选（§6.5）── */
const F = (q, tag, tbl) => T.filterItems(T.S.items, q, tag, tbl)
eq('按标签搜「报表」命中 1 条（标签是 haystack 一部分）', F('报表', '全部', '').length, '1')
eq('关键词大小写不敏感：ccB 命中标签 CCB 那条', F('ccB', '全部', '').length, '1')
eq('按 SQL 内容搜：product 命中 UPDATE product 那条', F('product', '全部', '').length, '1')
eq('标签筛选「批量更新」两条', F('', '批量更新', '').length, '2')
eq('表名筛选 order 两条（user+order 关联的两条）', F('', '全部', 'order').length, '2')
eq('名称里的「九折」也能搜到', F('九折', '全部', '').length, '1')
eq('没命中的词出 0 条', F('不存在xyz词', '全部', '').length, '0')
eq('不带任何条件就是全部 6 条种子', F('', '全部', '').length, '6')

/* ── 2. 排序（§6.5 最近使用；use_count 是 §6.8 表结构里现成的列）── */
eq('最近使用排第一的是今天早上刚用过的 CCB·批量改状态',
  j(T.sortItems(T.S.items, 'recent')[0].name), '"CCB·批量改状态"')
eq('最常用排第一的是复制了 41 次的查表结构',
  j(T.sortItems(T.S.items, 'often')[0].name), '"查表结构（MySQL）"')

/* ── 3. 表名自动提取（§6.7）── */
eq('反引号表名 + JOIN，各提一次、保序去重',
  j(T.extractTables('SELECT * FROM `order` o INNER JOIN user u ON u.id = o.user_id')),
  '["order","user"]')
eq('UPDATE 后面的表名也认', j(T.extractTables('UPDATE product SET price = price * 0.9 WHERE id = 9;')),
  '["product"]')
eq('INSERT INTO 同样认', j(T.extractTables("INSERT INTO log (action) VALUES ('LOGIN');")), '["log"]')
eq('多语句逐个抓', j(T.extractTables('INSERT INTO a VALUES (1);\nINSERT INTO b VALUES (2);')),
  '["a","b"]')

/* ── 4. 命中高亮：先在原文上定位、切段后转义，不会错位也不吃字符 ── */
eq('空词只转义不高亮（HTML 字符原样安全输出）', T.hi('<x>&amp;', ''), '&lt;x&gt;&amp;amp;')
eq('空词不产生 mark 标签', String(T.hi('<x>&amp;', '').includes('<mark>')), 'false')
eq('多命中全标且原文不变形', T.hi('aabcab', 'ab'), 'a<mark>ab</mark>c<mark>ab</mark>')

/* ── 5. 新建 / 编辑 / 删除（§6.4 名称、内容必填）── */
eq('名称空白不给存', String(T.upsert({ name: '   ', sql: 'SELECT 1;', tables: [], tags: [], remark: '' }) === null), 'true')
eq('SQL 内容空白同样不给存', String(T.upsert({ name: 'x', sql: '', tables: [], tags: [], remark: '' }) === null), 'true')
const before = T.S.items.length
const added = T.upsert({ name: '新收藏', sql: 'SELECT 9;', tables: ['t1'], tags: ['x'], remark: '' })
eq('新建成功：id 接着最大值自增', String(added.id), '7')
eq('新建即入库（6 → 7 条）', String(T.S.items.length), String(before + 1))
eq('新条目 use_count 从 0 起步', String(added.useCount), '0')
eq('时间戳是 YYYY-MM-DD HH:MM 格式（字典序即可比大小）',
  String(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(added.createdAt)), 'true')

T.S.editing = 2
const edited = T.upsert({ name: '统计用户消费总额·改', sql: 'SELECT changed;', tables: ['user', 'order'], tags: ['报表'], remark: '' })
eq('编辑保留原 created_at（不是当新的重建）', j(edited.createdAt), '"2026-08-03 09:12"')
eq('编辑保留原 use_count', String(edited.useCount), '17')
eq('保存后退出编辑态', String(T.S.editing === null), 'true')
eq('编辑不增加条数', String(T.S.items.length), String(before + 1))

/* ── 6. 使用计数与删除 ── */
const u0 = T.S.items.find(x => x.id === 5).useCount
T.markUsed(5)
const hit = T.S.items.find(x => x.id === 5)
eq('复制一次 use_count +1（41 → 42）', String(hit.useCount), String(u0 + 1))
eq('last_used_at 刷成当前时刻且格式不变',
  String(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(hit.lastUsedAt)), 'true')

T.S.sel = 7
T.del(7)
eq('删除生效（回到 6 条）', String(T.S.items.length), String(before))
eq('删掉的条目不再挂在详情上', String(T.S.sel === null), 'true')

/* ── 7. 导入导出（§6.6）：去重、坏行计数、不中断 ── */
eq('非 JSON 文本给错误而不是抛异常',
  String(T.importMerge('这不是json').error?.length > 0), 'true')
eq('顶层不是数组也给错误', T.importMerge('{"a":1}').error, '顶层必须是数组')
const payload = JSON.stringify([
  { name: 'CCB·批量改状态', sql: 'UPDATE user SET status = 1\nWHERE id IN (1001, 1005, 1009, 1013);' }, // 与种子4完全相同 → 跳过
  { name: '外来查询', sql: 'SELECT 9;' },                                                                // 新增
  { name: '', sql: '' },                                                                                 // 坏行
])
const impLenBefore = T.S.items.length
const r = T.importMerge(payload)
eq('重复条目按「名称+SQL 都相同」跳过', String(r.skipped), '1')
eq('新增条目照收', String(r.added), '1')
eq('缺名称/内容的坏行单独计数', String(r.invalid), '1')
eq('净入库 7 → 8 条', String(T.S.items.length), String(impLenBefore + 1))

console.log(`\n${pass} 过 / ${fail} 挂`)
process.exit(fail ? 1 : 0)
