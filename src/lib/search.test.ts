/**
 * 表结构搜索的回归测试，PRD 3.4 的 7 条匹配规则。
 *
 * 这块逻辑之前只在 e2e 里搜过一个 `order` 就算过了——那只能证明「搜得出东西」，
 * 证明不了「排在前面的是对的」。搜索的失败模式是**静默的**：规则之间的优先级错了，
 * 结果照样有内容、照样不报错，用户只会觉得「这工具搜不准」，然后回去手翻建表语句。
 *
 * 所以断言全部落在**相对顺序**上，不写死分数（WEIGHTS 本来也没导出）：
 * 断言 `score === 300` 只能钉住常量没被改，钉不住「前缀该排在包含前面」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeReason, searchTables, textMatchesQuery } from './search'
import type { Column, MatchReason, TableInfo } from '../types/schema'

const col = (name: string, over: Partial<Column> = {}): Column => ({
  name,
  type: 'VARCHAR(50)',
  nullable: true,
  isPrimaryKey: false,
  isAutoIncrement: false,
  javaField: name,
  javaType: 'String',
  ...over,
})

const tbl = (name: string, over: Partial<TableInfo> = {}): TableInfo => ({
  name,
  source: 'sql',
  columns: [col('id', { isPrimaryKey: true })],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

/** 命中的表名，按分数顺序 —— 大部分用例只关心这个 */
const names = (tables: TableInfo[], q: string, limit?: number) =>
  searchTables(tables, q, limit).map((h) => h.table.name)

/** 某张表被命中的原因种类 */
const kinds = (tables: TableInfo[], q: string, name = tables[0].name) =>
  searchTables(tables, q)
    .find((h) => h.table.name === name)
    ?.reasons.map((r) => r.kind)

/* ---------- 规则 1/2：表名精确 → 前缀 → 包含 ---------- */

test('规则 1 表名精确匹配：大小写不敏感，且 reason 是 tableExact', () => {
  const tables = [tbl('user')]
  assert.deepEqual(kinds(tables, 'user'), ['tableExact'])
  assert.deepEqual(kinds(tables, 'USER'), ['tableExact'], '用户不会记得表名的大小写')
  assert.deepEqual(kinds(tables, 'User'), ['tableExact'])
})

test('规则 2 表名模糊匹配：前缀排在「包含」前面', () => {
  // 搜 user 时 user_role 比 sys_user 更可能是想找的那张
  const tables = [tbl('sys_user'), tbl('user_role')]
  assert.deepEqual(names(tables, 'user'), ['user_role', 'sys_user'])
})

test('规则 1/2 三档同时存在时，精确 > 前缀 > 包含', () => {
  const tables = [tbl('sys_user'), tbl('user_role'), tbl('user')]
  assert.deepEqual(names(tables, 'user'), ['user', 'user_role', 'sys_user'])
})

test('规则 2 前缀和包含共用 tableFuzzy 这一个 reason（UI 上不区分，只体现在排序）', () => {
  assert.deepEqual(kinds([tbl('user_role')], 'user'), ['tableFuzzy'])
  assert.deepEqual(kinds([tbl('sys_user')], 'user'), ['tableFuzzy'])
})

/* ---------- 规则 3：字段名匹配 ---------- */

test('规则 3 字段名匹配：命中的字段全列出来，不是只给第一个', () => {
  const tables = [
    tbl('order', { columns: [col('id'), col('user_id'), col('user_name'), col('amount')] }),
  ]
  const reason = searchTables(tables, 'user')[0].reasons.find((r) => r.kind === 'column')
  assert.deepEqual(
    reason,
    { kind: 'column', columns: ['user_id', 'user_name'] },
    '结果卡片要告诉用户是哪几个字段命中的，否则他还得自己再找一遍',
  )
})

test('规则 3 字段名越多命中，排得越前', () => {
  const tables = [
    tbl('a', { columns: [col('user_id')] }),
    tbl('b', { columns: [col('user_id'), col('user_name'), col('user_age')] }),
  ]
  assert.deepEqual(names(tables, 'user'), ['b', 'a'])
})

/* ---------- 规则 4/5：注释匹配、中文语义 ---------- */

test('规则 4 表注释匹配', () => {
  assert.deepEqual(kinds([tbl('t_uc_001', { comment: '用户中心主表' })], '用户'), ['tableComment'])
})

test('规则 4 字段注释匹配：带上是哪几个字段', () => {
  const tables = [
    tbl('order', {
      columns: [
        col('id'),
        col('st', { comment: '订单状态：1待付款' }),
        col('pay_st', { comment: '支付状态' }),
        col('amount', { comment: '金额' }),
      ],
    }),
  ]
  assert.deepEqual(searchTables(tables, '状态')[0].reasons, [
    { kind: 'columnComment', columns: ['st', 'pay_st'] },
  ])
})

test('规则 5 中文语义匹配：表名毫无关系，靠注释也能搜到（PRD 3.4「用户」→「用户表」）', () => {
  // 这是速查功能存在的理由之一：只知道业务名，不知道表叫什么
  const tables = [tbl('t_sys_001', { comment: '用户表' }), tbl('t_sys_002', { comment: '订单表' })]
  assert.deepEqual(names(tables, '用户'), ['t_sys_001'])
})

test('注释匹配大小写不敏感', () => {
  assert.deepEqual(kinds([tbl('t', { comment: 'User center' })], 'user'), ['tableComment'])
})

/* ---------- 规则 6：拼音 / 首字母 ---------- */

test('textMatchesQuery：字面包含和拼音共用，选表下拉跟速查同一条', () => {
  assert.equal(textMatchesQuery('用户表', 'yh'), true)
  assert.equal(textMatchesQuery('用户表', 'yonghu'), true)
  assert.equal(textMatchesQuery('ORDER', 'ord'), true)
  assert.equal(textMatchesQuery('user', 'us'), true)
  assert.equal(textMatchesQuery('user', 'yh'), false)
  assert.equal(textMatchesQuery(undefined, 'yh'), false)
})

test('规则 6 拼音首字母：yh → 用户表（PRD 3.4 的例子）', () => {
  const tables = [tbl('t_sys_001', { comment: '用户表' }), tbl('t_sys_002', { comment: '订单表' })]
  assert.deepEqual(names(tables, 'yh'), ['t_sys_001'])
  assert.deepEqual(kinds(tables, 'yh', 't_sys_001'), ['tablePinyin'])
})

test('规则 6 拼音大小写不敏感，全拼也认', () => {
  const tables = [tbl('t', { comment: '用户表' })]
  assert.deepEqual(kinds(tables, 'YH'), ['tablePinyin'], '大写首字母是常见输入')
  assert.deepEqual(kinds(tables, 'yonghu'), ['tablePinyin'])
})

test('规则 6 纯英文文本不走拼音，避免莫名其妙的命中', () => {
  // PinyinMatch.match('user', 'us') 本身是返回 true 的，靠 HAS_CJK 挡掉
  const reasons = kinds([tbl('user')], 'us')
  assert.deepEqual(reasons, ['tableFuzzy'])
  assert.ok(!reasons?.includes('tablePinyin'))
})

test('规则 6 字面已经命中的，不再挂一个假的「拼音匹配」标签', () => {
  // PinyinMatch 对原文也返回 true，所以中文查询命中注释时，拼音判断必然也成立。
  // 修之前搜「用户」会同时挂上「表注释匹配」+「拼音匹配」——用户输的是汉字，
  // 标签却说是拼音命中，等于告诉他一件假事，还多算了一份分数。
  assert.deepEqual(kinds([tbl('t', { comment: '用户表' })], '用户'), ['tableComment'])
  // 表名本身是中文时同理：这是前缀命中，不是拼音命中
  assert.deepEqual(kinds([tbl('用户信息')], '用户'), ['tableFuzzy'])
})

/* ---------- 规则 7：Java 类名 ---------- */

test('规则 7 Java 类名匹配（PRD 3.4 的例子 UserEntity）', () => {
  const tables = [tbl('t_user', { javaClass: 'UserEntity' })]
  assert.deepEqual(kinds(tables, 'UserEntity'), ['javaClass'])
  assert.deepEqual(kinds(tables, 'userentity'), ['javaClass'], '大小写不敏感')
})

test('规则 7 类名只是「包含」时，必须排在表名前缀匹配之后', () => {
  // 项目里类名普遍带 Entity/DO/DTO 后缀。要是「包含」也给高分，
  // 搜 user 时 javaClass 叫 UserAudit 的 audit 表就排在真的叫 user_role 的表前面；
  // 更糟的是搜 "entity" 会把所有表都以高分捞出来，等于搜索废了。
  const tables = [tbl('audit', { javaClass: 'UserAudit' }), tbl('user_role')]
  assert.deepEqual(names(tables, 'user'), ['user_role', 'audit'])
})

test('规则 7 类名全等比「包含」可信，排在前面', () => {
  const tables = [tbl('a', { javaClass: 'UserAuditLog' }), tbl('b', { javaClass: 'User' })]
  assert.deepEqual(names(tables, 'user'), ['b', 'a'])
})

/* ---------- 规则之间的总优先级 ---------- */

test('六种命中方式同时出现时的完整顺序', () => {
  // 一次把 PRD 3.4 的规则表钉成一个可执行的断言：
  // 表名精确 > 表名前缀 > 类名包含 > 表名包含 > 表注释 > 字段名
  const tables = [
    tbl('perm', { columns: [col('user_id')] }), // 只有字段名
    tbl('sys_user'), // 表名包含
    tbl('user_role'), // 表名前缀
    tbl('user'), // 表名精确
    tbl('audit', { javaClass: 'UserAudit' }), // 只有类名（包含）
    tbl('log', { comment: 'user 操作日志' }), // 只有表注释
  ]
  assert.deepEqual(names(tables, 'user'), [
    'user',
    'user_role',
    'audit',
    'sys_user',
    'log',
    'perm',
  ])
})

test('同分时按表名字母序，保证渲染顺序稳定', () => {
  // 不定序的话同一次搜索两次刷新出来的顺序可能不一样，用户会以为数据变了
  const tables = [tbl('z_user'), tbl('a_user'), tbl('m_user')]
  assert.deepEqual(names(tables, 'user'), ['a_user', 'm_user', 'z_user'])
})

test('一张表可以同时因多种原因命中，reason 全部保留', () => {
  const tables = [
    tbl('user', {
      comment: '用户表',
      javaClass: 'UserEntity',
      columns: [col('id'), col('user_name')],
    }),
  ]
  // 注意「用户表」里并没有 ASCII 的 user，所以英文关键字不该命中表注释——
  // 纯中文注释要靠中文或拼音关键字才搜得到（见规则 5/6 的用例）
  assert.deepEqual(kinds(tables, 'user'), ['tableExact', 'javaClass', 'column'])
  // 换成中文关键字，命中的就只剩注释这一条
  assert.deepEqual(kinds(tables, '用户'), ['tableComment'])
})

test('同一个字段同时命中字段名和字段注释，两条 reason 都带上它', () => {
  const tables = [tbl('t', { columns: [col('status', { comment: 'status 状态' })] })]
  assert.deepEqual(searchTables(tables, 'status')[0].reasons, [
    { kind: 'column', columns: ['status'] },
    { kind: 'columnComment', columns: ['status'] },
  ])
})

/* ---------- 空查询 / limit / 入参 ---------- */

test('空查询返回全部，按表名排序，score 0 且没有 reason', () => {
  const tables = [tbl('order'), tbl('user'), tbl('apply')]
  const hits = searchTables(tables, '')
  assert.deepEqual(
    hits.map((h) => h.table.name),
    ['apply', 'order', 'user'],
  )
  assert.ok(hits.every((h) => h.score === 0 && h.reasons.length === 0))
})

test('纯空白查询等同于空查询，前后空格会被 trim', () => {
  const tables = [tbl('order'), tbl('user')]
  assert.deepEqual(names(tables, '   '), ['order', 'user'])
  assert.deepEqual(names(tables, '\t\n '), ['order', 'user'])
  assert.deepEqual(names(tables, '  user  '), ['user'], '从别处复制表名常带空格')
})

test('limit 截断的是分数低的那些', () => {
  const tables = [tbl('sys_user'), tbl('user_role'), tbl('user')]
  assert.deepEqual(names(tables, 'user', 2), ['user', 'user_role'])
  assert.deepEqual(names(tables, 'user', 0), [])
})

test('limit 对空查询也生效（防止一次渲染几百张表）', () => {
  const tables = Array.from({ length: 80 }, (_, i) => tbl(`t${String(i).padStart(2, '0')}`))
  assert.equal(searchTables(tables, '').length, 50, '默认上限 50')
  assert.deepEqual(names(tables, '', 3), ['t00', 't01', 't02'])
})

test('不改入参：空查询那条路排序前必须先拷贝', () => {
  // 直接 sort 会把 store 里的数组重排，表卡片顺序跟着变，且改动发生在渲染期
  const tables = [tbl('z'), tbl('a'), tbl('m')]
  searchTables(tables, '')
  searchTables(tables, 'a')
  assert.deepEqual(
    tables.map((t) => t.name),
    ['z', 'a', 'm'],
  )
})

test('无命中返回空数组，不是 undefined', () => {
  assert.deepEqual(searchTables([tbl('user')], '压根不存在的关键字'), [])
  assert.deepEqual(searchTables([], 'user'), [])
  assert.deepEqual(searchTables([], ''), [])
})

/* ---------- 恶劣输入 ---------- */

test('正则元字符按普通文本处理，不抛异常也不当模式用', () => {
  const tables = [tbl('user', { comment: '用户表', javaClass: 'User' })]
  // 这些以前若被拿去 new RegExp 就会抛，或者 .* 把所有表都匹配上
  for (const q of ['%user%', '(', ')', '[a-z]+', '\\', '*', '.*', '$^', '{2,}']) {
    assert.deepEqual(searchTables(tables, q), [], `${JSON.stringify(q)} 不该命中任何表`)
  }
})

test('超长关键字、emoji、缺字段的表都不会崩', () => {
  const tables = [
    tbl('user', { comment: undefined, javaClass: undefined, columns: [] }),
    tbl('order', { comment: '订单', columns: [col('id', { comment: undefined })] }),
  ]
  assert.deepEqual(searchTables(tables, 'a'.repeat(500)), [])
  assert.deepEqual(searchTables(tables, '💡🔍'), [])
  assert.deepEqual(names(tables, 'user'), ['user'], '没有注释/类名/字段的表照样能按表名搜到')
})

/* ---------- describeReason ---------- */

test('describeReason：7 种 kind 全都有中文说明', () => {
  const all: MatchReason[] = [
    { kind: 'tableExact' },
    { kind: 'tableFuzzy' },
    { kind: 'tablePinyin' },
    { kind: 'tableComment' },
    { kind: 'javaClass' },
    { kind: 'column', columns: ['user_id', 'user_name'] },
    { kind: 'columnComment', columns: ['st'] },
  ]
  for (const r of all) {
    const text = describeReason(r)
    assert.ok(text && text.length > 0, `${r.kind} 没有说明文案`)
  }
  assert.equal(describeReason(all[5]), '字段：user_id, user_name', '多个字段用逗号连接')
  assert.equal(describeReason(all[6]), '字段注释：st')
})
