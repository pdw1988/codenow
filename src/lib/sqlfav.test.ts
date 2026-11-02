/**
 * 我的SQL库的业务纯函数回归，PRD v6.3 §6.1~6.9（原型 `mockup/sqlfav.html`）。
 *
 * 搜索和导入的失败模式都是静默的：优先级错了照样有结果、去重策略错了照样
 * 「导入成功」——所以用例钉的是拍板语义（③名称+SQL 全同才跳过、②识别可手改、
 * ①最常用排序）和真会踩的边界，而不是「函数能返回东西」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultFavName,
  extractTables,
  followTables,
  favNow,
  filterFavorites,
  importFavorites,
  markUsed,
  matchFavConn,
  newFavoriteId,
  saveFavoriteDetailed,
  saveSqlFavorite,
  sortFavorites,
  splitFavList,
} from './sqlfav'
import { FAVORITE_LIMIT, type FavoriteConn, type FavoriteSql } from '../types/favorite'
import type { DbConn } from '../types/dbconn'

const fav = (over: Partial<FavoriteSql> = {}): FavoriteSql => ({
  id: 'f1',
  name: '查询订单列表',
  sql: "SELECT * FROM `order` WHERE status = 1",
  tables: ['order'],
  tags: ['订单模块'],
  remark: '',
  createdAt: '2026-08-01 10:00',
  lastUsedAt: '2026-08-20 10:00',
  useCount: 3,
  ...over,
})

/* ================= §6.5 四路合一搜索 ================= */

test('四路合一：关键词搜名称 / 标签 / 表名 / SQL 内容都命中，备注也算一路', () => {
  // bare 把工厂默认值清掉：不隔离的话每条都带着默认的 order 表名和 SQL，「命中」就串味了。
  // 中文关键词只能中名称/标签/备注这类中文字段，表名和 SQL 是英文——分开断言才不假绿
  const bare = { sql: '', tables: [], tags: [], remark: '' }
  const items = [
    fav({ id: 'a', name: '统计用户消费', ...bare }),
    fav({ id: 'b', name: '随便叫什么', ...bare, tags: ['用户标签'] }),
    fav({ id: 'c', name: '随便叫什么', ...bare, tables: ['t_user'] }),
    fav({ id: 'd', name: '随便叫什么', ...bare, sql: 'UPDATE t_user SET status = 1' }),
    fav({ id: 'e', name: '随便叫什么', ...bare, remark: '用户相关' }),
    fav({ id: 'f', name: '毫无关系', ...bare }),
  ]
  const zhHit = (id: string) => filterFavorites(items, '用户', null, null).some((x) => x.id === id)
  assert.ok(zhHit('a') && zhHit('b') && zhHit('e'))
  // 干草堆整体小写过：大写 USER 照样命中小写表名；SQL 内容也算一路
  assert.ok(filterFavorites(items, 'T_USER', null, null).some((x) => x.id === 'c'))
  assert.ok(filterFavorites(items, 'update', null, null).some((x) => x.id === 'd'))
  assert.ok(!zhHit('f'))
})

test('三层叠加：关键词、标签、表名同时给时是 AND，不是 OR', () => {
  const items = [
    fav({ id: 'both', tables: ['order'], tags: ['运维'] }),
    fav({ id: 'onlyTag', tables: ['user'], tags: ['运维'] }),
    fav({ id: 'onlyTbl', tables: ['order'], tags: ['报表'] }),
  ]
  const r = filterFavorites(items, '', '运维', 'order')
  assert.deepEqual(r.map((x) => x.id), ['both'])
})

test('「全部」用 null 表示：null 和空字符串筛选必须是一个语义，且大小写空白都不碍事', () => {
  // 第二条换掉默认 SQL：不然两条都含 order 表名，「搜 ORDER 只中一条」就没得断言了
  const items = [fav(), fav({ tags: ['其他'], tables: ['product'], sql: 'SELECT 1 FROM product' })]
  assert.equal(filterFavorites(items, '', null, null).length, 2)
  assert.equal(filterFavorites(items, '   ', null, null).length, 2)
  // SQL 内容里的大小写：搜 ORDER 能命中 `order`
  assert.equal(filterFavorites(items, 'ORDER', null, null).length, 1)
})

/* ================= 排序 ================= */

test('排序：最近使用按时间倒序；最常用按次数、平局比最近（拍板①）', () => {
  const items = [
    fav({ id: 'old-few', lastUsedAt: '2026-08-01 09:00', useCount: 5 }),
    fav({ id: 'new-few', lastUsedAt: '2026-08-25 09:00', useCount: 5 }),
    fav({ id: 'many', lastUsedAt: '2026-08-10 09:00', useCount: 99 }),
  ]
  assert.deepEqual(sortFavorites(items, 'recent').map((x) => x.id), ['new-few', 'many', 'old-few'])
  // 刚收藏还没复制过的两条不至于随机排：平局落在 lastUsedAt 上
  assert.deepEqual(sortFavorites(items, 'often').map((x) => x.id), ['many', 'new-few', 'old-few'])
})

test('排序不改入参——items 在 React state 里，原地改等于骗过渲染', () => {
  const items = [fav({ id: 'a', lastUsedAt: '2026-08-01 09:00' }), fav({ id: 'b', lastUsedAt: '2026-08-02 09:00' })]
  sortFavorites(items, 'recent')
  assert.deepEqual(items.map((x) => x.id), ['a', 'b'])
})

/* ================= §6.7 表名提取 ================= */

test('表名提取：FROM/JOIN/UPDATE/INTO 都认，三种引号包裹也认，关键字大小写不敏感', () => {
  const sql = [
    'select * from user u',
    'INNER JOIN `order` o ON o.user_id = u.id',
    'update [product] set price = 1',
    'insert into "user_role" values (1, 2)',
  ].join('\n')
  assert.deepEqual(extractTables(sql), ['user', 'order', 'product', 'user_role'])
})

test('表名提取：库名前缀取末段，information_schema.COLUMNS 认成 columns——精度有限但永远可手改（拍板②）', () => {
  assert.deepEqual(extractTables('SELECT 1 FROM mydb.t_user'), ['t_user'])
  assert.deepEqual(extractTables("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_NAME = 'user'"), [
    'columns',
  ])
  // 去重保序：同表出现多次只留第一个位置
  assert.deepEqual(extractTables('SELECT * FROM a JOIN b ON b.a_id = a.id LEFT JOIN a'), ['a', 'b'])
  // 别名 / 子查询抓不全没关系，但不能把别名当表名抓进来
  assert.deepEqual(extractTables('SELECT * FROM t WHERE id IN (SELECT id FROM other)'), ['t', 'other'])
  assert.ok(!extractTables('SELECT 1').includes(''))
})

test('粘贴 SQL 后所属表自动跟上；手改过表名框就不再覆盖（拍板②）', () => {
  const sql = 'SELECT * FROM user JOIN `order` o ON o.user_id = user.id'
  assert.equal(followTables(sql, false, ''), 'user, order')
  // 没认出时也要清空自动填的，不能把上一句 SQL 的表名留着
  assert.equal(followTables('SELECT 1', false, 'user, order'), '')
  // 手改过：SQL 里多一张表也不能冲掉用户写的
  assert.equal(followTables(sql, true, 'user'), 'user')
})

/* ================= 复制计数 ================= */

test('markUsed：次数 +1、lastUsedAt 到现在、返回新对象不改入参', () => {
  const it = fav({ useCount: 7 })
  const next = markUsed(it)
  assert.equal(next.useCount, 8)
  assert.match(next.lastUsedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.notEqual(next.lastUsedAt, it.lastUsedAt)
  assert.equal(it.useCount, 7)
})

test('favNow 的格式就是存储口径：字典序即时间序，不用解析日期', () => {
  assert.match(favNow(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
})

test('newFavoriteId 以 fav 开头：跟模板 id（t 前缀）永远不会撞', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newFavoriteId()))
  assert.equal(ids.size, 50)
  for (const id of ids) assert.match(id, /^fav/)
})

/* ================= §6.6 导入合并 ================= */

test('导入：正常条目收进来，tables/tags/remark/时间/useCount 原样保留', () => {
  const json = JSON.stringify([
    { name: '查库存', sql: 'SELECT count(*) FROM stock', tables: ['stock'], tags: ['报表'], remark: '每日盘库', createdAt: '2026-01-01 00:00', lastUsedAt: '2026-02-01 00:00', useCount: 12 },
  ])
  const r = importFavorites([], json)
  assert.ok(!('error' in r))
  assert.equal(r.added, 1)
  assert.equal(r.list[0].name, '查库存')
  assert.deepEqual(r.list[0].tables, ['stock'])
  assert.deepEqual(r.list[0].tags, ['报表'])
  assert.equal(r.list[0].remark, '每日盘库')
  assert.equal(r.list[0].createdAt, '2026-01-01 00:00')
  assert.equal(r.list[0].useCount, 12)
})

test('导入去重：名称+SQL 都相同才跳过，id 不同也跳（拍板③跨机器 id 不参与比对）', () => {
  const existing = [fav({ id: 'local-1', name: '同名', sql: 'SELECT 1' })]
  const json = JSON.stringify([
    { name: '同名', sql: 'SELECT 1' }, // 全同 → 跳过，哪怕对方 id 是别的值
    { name: '同名', sql: 'SELECT 2' }, // 同名不同内容 → 追加（用户可能改过 SQL 又导回）
  ])
  const r = importFavorites(existing, json)
  assert.ok(!('error' in r))
  assert.equal(r.added, 1)
  assert.equal(r.skipped, 1)
  assert.equal(r.list.length, 2)
})

test('导入：JSON 内部自重复只收第一条——去重查的是累积后的列表', () => {
  const json = JSON.stringify([
    { name: 'A', sql: 'SELECT 1' },
    { name: 'A', sql: 'SELECT 1' },
  ])
  const r = importFavorites([], json)
  assert.ok(!('error' in r))
  assert.equal(r.added, 1)
  assert.equal(r.skipped, 1)
})

test('导入：坏行单独计数不中断——缺名称、缺 SQL、非对象各算一行，好的照收', () => {
  const json = JSON.stringify([
    { sql: 'SELECT 1' }, // 缺名称
    { name: '没内容' }, // 缺 SQL
    { name: '  ', sql: 'SELECT 1' }, // 名称全空白
    42, // 非对象
    { name: '好的', sql: 'SELECT 1' },
  ])
  const r = importFavorites([], json)
  assert.ok(!('error' in r))
  assert.equal(r.invalid, 4)
  assert.equal(r.added, 1)
})

test('导入：JSON 解析失败和顶层非数组都要报错，不能静默当空导入', () => {
  assert.deepEqual(importFavorites([], '{oops'), { error: 'JSON 解析失败' })
  assert.deepEqual(importFavorites([], '{"name": "x"}'), { error: '顶层必须是数组' })
})

test('导入：一律重新分配本地 id——跨机器的 id 本来就不保证一致，撞了 upsert 会互相顶掉', () => {
  const existing = [fav({ id: 'favZZZ' })]
  const json = JSON.stringify([{ name: 'X', sql: 'SELECT 1', id: 'favZZZ' }])
  const r = importFavorites(existing, json)
  assert.ok(!('error' in r))
  assert.notEqual(r.list[1].id, 'favZZZ')
  // 不改入参
  assert.equal(existing.length, 1)
})

/* ================= 日志转SQL 结果卡的 ⭐ 收藏 ================= */

test('收藏日志转SQL 的结果：自动起名带首表名和时间段，tables 自动识别，置顶', () => {
  const r = saveSqlFavorite(
    [fav({ id: 'old' })],
    "INSERT INTO `order` (order_no) VALUES ('CT1');\n\nINSERT INTO `order_detail` (order_id) VALUES (1);",
    '2026-08-28 15:02',
  )
  assert.equal(r.deduped, false)
  assert.equal(r.list.length, 2)
  assert.equal(r.list[0].name, 'ORDER · 08-28 15:02', '首表名大写 + now 的月-日 时:分')
  assert.deepEqual(r.list[0].tables, ['order', 'order_detail'])
  assert.equal(r.list[0].useCount, 0)
  assert.equal(r.list[0].tags.length, 0)
  assert.equal(r.list[1].id, 'old', '新条目排最前')
})

test('同 SQL 重复收藏不新建：原条目原样置顶，用户改过的名字和使用计数不被覆盖', () => {
  // 重复点击 ⭐、跨会话重贴同一段日志，都是这一条路；库按内容寻址
  const old = fav({ id: 'old', name: '用户改过的名字', useCount: 5, sql: 'UPDATE `order` SET status = 1' })
  const again = saveSqlFavorite([fav({ id: 'newer' }), old], old.sql)
  assert.equal(again.deduped, true)
  assert.equal(again.list.length, 2, '不新建')
  assert.equal(again.list[0].id, 'old', '置顶')
  assert.equal(again.list[0].name, '用户改过的名字')
  assert.equal(again.list[0].useCount, 5)
  // 改了参数值就是另一条 SQL：照常新建
  const changed = saveSqlFavorite(again.list, 'UPDATE `order` SET status = 2')
  assert.equal(changed.deduped, false)
  assert.equal(changed.list.length, 3)
  assert.match(changed.list[0].sql, /status = 2/)
})

test('收藏到上限：新建挤掉数组末尾；重复收藏置顶不挤掉任何条目', () => {
  const full = Array.from({ length: FAVORITE_LIMIT }, (_, i) => fav({ id: `f${i}`, sql: `SELECT ${i}` }))
  const added = saveSqlFavorite(full, 'brand new sql')
  assert.equal(added.deduped, false)
  assert.equal(added.list.length, FAVORITE_LIMIT)
  // 上限裁切跟 upsertFavorite 一样切尾巴：新的插到最前，原来的最后一条出局
  assert.ok(!added.list.some((x) => x.id === `f${FAVORITE_LIMIT - 1}`), '数组末尾那条被挤掉了')
  assert.match(added.list[0].sql, /brand new sql/)
  const touched = saveSqlFavorite(full, full[0].sql)
  assert.equal(touched.deduped, true)
  assert.equal(touched.list.length, FAVORITE_LIMIT, '置顶不减少条目')
  assert.equal(touched.list[0].id, 'f0')
})

/* ================= 连库查询页的收藏弹框 ================= */

const CONN: FavoriteConn = {
  kind: 'mysql',
  host: '10.0.0.9',
  port: '3306',
  user: 'shop',
  db: 'shop',
}

test('defaultFavName：首表名 · 月-日 时:分；没认出表名给 SQL 而不是 UNDEFINED', () => {
  assert.equal(defaultFavName(['t_shop_city'], '2026-09-11 14:30'), 'T_SHOP_CITY · 09-11 14:30')
  assert.equal(defaultFavName([], '2026-09-11 14:30'), 'SQL · 09-11 14:30')
})

test('splitFavList：中英文逗号都认，去空白、去空项', () => {
  assert.deepEqual(splitFavList('订单, 盘库， 报表 '), ['订单', '盘库', '报表'])
  assert.deepEqual(splitFavList('  '), [])
})

test('saveFavoriteDetailed：名字/备注/标签/连接都落到条目上', () => {
  const r = saveFavoriteDetailed(
    [],
    { sql: 'SELECT * FROM t_shop_city', name: '城市字典', remark: '排查用', tags: ['字典'], conn: CONN },
    '2026-09-11 14:30',
  )
  assert.equal(r.deduped, false)
  const it = r.list[0]
  assert.equal(it.name, '城市字典')
  assert.equal(it.remark, '排查用')
  assert.deepEqual(it.tags, ['字典'])
  assert.deepEqual(it.conn, CONN)
  assert.deepEqual(it.tables, ['t_shop_city'], '没给 tables 就从 SQL 认')
})

test('saveFavoriteDetailed：名字留空/全空白 → 退回自动起名，不落个空串进库（name 是必填项）', () => {
  const r = saveFavoriteDetailed([], { sql: 'SELECT 1 FROM stock', name: '   ' }, '2026-09-11 14:30')
  assert.equal(r.list[0].name, 'STOCK · 09-11 14:30')
})

test('saveFavoriteDetailed：同 SQL 已存在 → 原样置顶，弹框里填的不覆盖用户改过的名字/标签', () => {
  const old = fav({ id: 'old', name: '用户改过的名字', tags: ['原标签'], useCount: 5, sql: 'SELECT 9' })
  const r = saveFavoriteDetailed([fav({ id: 'other', sql: 'SELECT 8' }), old], {
    sql: 'SELECT 9',
    name: '这次填的新名字',
    tags: ['新标签'],
    conn: CONN,
  })
  assert.equal(r.deduped, true)
  assert.equal(r.list[0].id, 'old')
  assert.equal(r.list[0].name, '用户改过的名字')
  assert.deepEqual(r.list[0].tags, ['原标签'])
  assert.equal(r.list[0].useCount, 5)
  assert.equal(r.list[0].conn, undefined, '原条目没连接就仍然没有，不偷偷补上')
})

test('saveFavoriteDetailed：没带连接时不写 conn 键（而不是写 undefined）', () => {
  const r = saveFavoriteDetailed([], { sql: 'SELECT 1' })
  assert.ok(!('conn' in r.list[0]))
})

test('matchFavConn：按 addrKey 找回完整连接；没存/已删 → null 让调用方降级', () => {
  const mine: DbConn[] = [
    { id: 'c1', name: '测试库', kind: 'mysql', host: '10.0.0.9', port: '3306', user: 'shop', db: 'shop', env: 'test' },
    { id: 'c2', kind: 'oracle', host: 'db.example.com', port: '1521', user: 'u', db: 'svc' },
  ]
  assert.equal(matchFavConn(mine, CONN)?.id, 'c1')
  assert.equal(matchFavConn(mine, undefined), null, '这条收藏没存连接')
  assert.equal(matchFavConn([], CONN), null, '连接已从「我的连接」里删了')
  assert.equal(
    matchFavConn(mine, { ...CONN, db: 'shop_uat' }),
    null,
    '库名不同就不是同一把钥匙——对错库跑比让用户自己选更糟',
  )
})
