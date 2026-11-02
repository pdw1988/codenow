/**
 * 优化记录的纯函数回归。钉的是四件事：坏数据不砸页面、**按「语句 + 结论」聚合**
 * （调试时连跑三十遍只 +1 次，结论变了才落新的一条）、统计口径稳（次数按 runs 加权，
 * TopN 平局不抖）、老存档缺字段按缺省读回。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DbKind } from '../types/dbconn'
import type { SqlAdvice } from './sqladvise'
import {
  ADVICE_LOG_MAX,
  appendAdviceLog,
  newAdviceLogId,
  parseAdviceLog,
  summarizeAdviceLog,
  type AdviceLogEntry,
} from './sqladviseLog'

const conn = { kind: 'oracle' as DbKind, host: '10.0.0.1', port: '1521', user: 'scott', db: 'orcl' }

const adv = (id: string, severity: SqlAdvice['severity'], title = `规则 ${id}`): SqlAdvice => ({
  id,
  severity,
  title,
  why: '为什么会拖慢',
})

const entry = (over: Partial<AdviceLogEntry> = {}): AdviceLogEntry => ({
  id: 'a1',
  at: '2026-09-22 10:30',
  firstAt: '2026-09-22 10:30',
  runs: 1,
  dialect: 'oracle',
  conn,
  table: 'orders',
  sql: 'SELECT * FROM orders WHERE user_id = 1',
  advice: [adv('no-where', 'high')],
  ...over,
})

test('parseAdviceLog: 空值、坏 JSON、顶层非数组都按空库处理', () => {
  assert.deepEqual(parseAdviceLog(null), [])
  assert.deepEqual(parseAdviceLog(''), [])
  assert.deepEqual(parseAdviceLog('{oops'), [])
  assert.deepEqual(parseAdviceLog('"just a string"'), [])
  assert.deepEqual(parseAdviceLog('{"a":1}'), [])
})

test('parseAdviceLog: 外壳不合格的整条丢，好的留下', () => {
  const raw = JSON.stringify([
    entry(),
    { id: 'x' },
    { ...entry({ id: 'a2' }), dialect: 'db2' },
    { ...entry({ id: 'a3' }), conn: { kind: 'oracle', host: '1.1.1.1' } },
    null,
  ])
  const out = parseAdviceLog(raw)
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'a1')
})

test('parseAdviceLog: 建议缺字段按缺省读回，不整条丢', () => {
  const raw = JSON.stringify([
    {
      ...entry(),
      advice: [
        { id: 'r1', title: '缺一堆字段' },
        { id: 'r2', title: '缺 kind', fix: 'CREATE INDEX i ON t(a)' },
        { id: 'r3', title: '假严重度', severity: 'catastrophic', why: 'why' },
        { title: '没有 id' },
      ],
    },
  ])
  const [got] = parseAdviceLog(raw)
  assert.equal(got.advice.length, 3)
  assert.equal(got.advice[0].severity, 'info')
  assert.equal(got.advice[0].why, '')
  assert.equal(got.advice[0].fixKind, undefined)
  // fix 存在而 fixKind 缺失时按 text：宁可少一个「复制 SQL」标签，也不把说明标成 SQL
  assert.equal(got.advice[1].fixKind, 'text')
  assert.equal(got.advice[2].severity, 'info')
})

test('parseAdviceLog: 超长的 SQL 截断', () => {
  const [got] = parseAdviceLog(JSON.stringify([entry({ sql: 'x'.repeat(5000) })]))
  assert.equal(got.sql.length, 2000)
})

test('parseAdviceLog: 老记录缺 runs / firstAt 按缺省读回（升级不清用户的账）', () => {
  const legacy: Partial<AdviceLogEntry> = { ...entry() }
  delete legacy.runs
  delete legacy.firstAt
  const [got] = parseAdviceLog(JSON.stringify([legacy]))
  assert.equal(got.runs, 1)
  assert.equal(got.firstAt, '2026-09-22 10:30')
  assert.equal(got.at, '2026-09-22 10:30')
})

test('appendAdviceLog: 最新在前', () => {
  let list: AdviceLogEntry[] = []
  list = appendAdviceLog(list, entry())
  list = appendAdviceLog(list, entry({ id: 'a2', sql: 'SELECT * FROM users WHERE id = 1' }))
  assert.deepEqual(
    list.map((e) => e.id),
    ['a2', 'a1'],
  )
})

/* 聚合是整个改动的核心：同一条 SQL、同一套结论重复跑只 +1 次。
   「同分钟」那道老去重挡不住调试时连跑二三十遍——历史会被同一种情况占满，
   真正想对照的上一次反而被 200 条的额度顶出去。 */
test('appendAdviceLog: 同一条句子同一套结论重复跑只 +1 次，不新起一行', () => {
  let list: AdviceLogEntry[] = [entry()]
  list = appendAdviceLog(list, entry({ id: 'a2', at: '2026-09-22 11:31' }))
  assert.equal(list.length, 1)
  assert.equal(list[0].runs, 2)
  assert.equal(list[0].at, '2026-09-22 11:31') // 末次时间往前挪
  assert.equal(list[0].firstAt, '2026-09-22 10:30') // 第一次见的不动
  assert.equal(list[0].id, 'a1') // 保住原来那条：id 变了下 download 名就断了
})

test('appendAdviceLog: 同一条句子换行缩进不同也算同一条', () => {
  let list: AdviceLogEntry[] = [entry()]
  list = appendAdviceLog(list, entry({ id: 'a2', sql: 'SELECT   *\n  FROM orders\n  WHERE user_id = 1' }))
  assert.equal(list.length, 1)
  assert.equal(list[0].runs, 2)
})

test('appendAdviceLog: 同一条句子结论变了才落新的一条，旧的留着对照', () => {
  let list: AdviceLogEntry[] = [entry({ advice: [adv('no-idx', 'high'), adv('like', 'mid')] })]
  list = appendAdviceLog(list, entry({ id: 'a2', at: '2026-09-22 11:00', advice: [adv('no-idx', 'high')] }))
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 'a2') // 新结论在最前：列表按最近一次排
  assert.equal(list[1].runs, 1)
})

test('appendAdviceLog: 结论只多一条 / 少一条都算变了', () => {
  let list: AdviceLogEntry[] = [entry({ advice: [adv('ra', 'mid')] })]
  list = appendAdviceLog(list, entry({ id: 'a2', advice: [adv('ra', 'mid'), adv('rb', 'mid')] }))
  assert.equal(list.length, 2)
})

/* 指纹比的是「哪些规则、多严重」，不比顺序——sqlAdvise 排序变了不该让历史
   凭空多出一条，用户会以为结论真的变过。 */
test('appendAdviceLog: 结论指纹与建议顺序无关', () => {
  let list: AdviceLogEntry[] = [entry({ advice: [adv('ra', 'mid'), adv('rb', 'high')] })]
  list = appendAdviceLog(list, entry({ id: 'a2', advice: [adv('rb', 'high'), adv('ra', 'mid')] }))
  assert.equal(list.length, 1)
  assert.equal(list[0].runs, 2)
})

test('appendAdviceLog: 到 200 种裁最旧的', () => {
  let list: AdviceLogEntry[] = []
  for (let i = 0; i < ADVICE_LOG_MAX; i++) {
    list = appendAdviceLog(list, entry({ id: `a${i}`, sql: `SELECT * FROM t${i} WHERE id = 1` }))
  }
  assert.equal(list.length, ADVICE_LOG_MAX)
  const oldest = list[list.length - 1].id
  list = appendAdviceLog(list, entry({ id: 'new', sql: 'SELECT * FROM fresh WHERE id = 1' }))
  assert.equal(list.length, ADVICE_LOG_MAX)
  assert.equal(list[0].id, 'new')
  assert.ok(!list.some((e) => e.id === oldest))
})

/* 满了之后重跑同一条只该 +1 次：既不该顶掉别人的记录，也不该把刚跑的这条丢了 */
test('appendAdviceLog: 满了之后重跑同一条不占额度', () => {
  let list: AdviceLogEntry[] = []
  for (let i = 0; i < ADVICE_LOG_MAX; i++) {
    list = appendAdviceLog(list, entry({ id: `a${i}`, sql: `SELECT * FROM t${i} WHERE id = 1` }))
  }
  list = appendAdviceLog(list, entry({ id: 'a0', at: '2026-09-23 09:00', sql: 'SELECT * FROM t0 WHERE id = 1' }))
  assert.equal(list.length, ADVICE_LOG_MAX)
  assert.equal(list[0].id, 'a0')
  assert.equal(list[0].runs, 2)
})

test('summarizeAdviceLog: 次数按 runs 加权，条目数另算', () => {
  const s = summarizeAdviceLog([
    entry({ id: 'a1', runs: 3, advice: [adv('r1', 'high'), adv('r2', 'mid')] }),
    entry({ id: 'a2', runs: 1, advice: [adv('r1', 'high')] }),
  ])
  assert.equal(s.runs, 4) // 真跑过 4 次
  assert.equal(s.entries, 2) // 2 种「语句 + 结论」
  assert.equal(s.advice, 7) // 3×2 + 1×1：不加权就把跑了 3 次的问题算成 1 次
  assert.equal(s.high, 4)
})

test('summarizeAdviceLog: 最近 7 天算次数，跨天不破月份', () => {
  const now = new Date(2026, 8, 3, 12, 0) // 2026-09-03
  const s = summarizeAdviceLog(
    [
      entry({ id: 'today', at: '2026-09-03 08:00', runs: 3 }),
      entry({ id: 'six', at: '2026-08-28 23:59', runs: 2 }),
      entry({ id: 'seven', at: '2026-08-27 23:59', runs: 5 }),
    ],
    now,
  )
  assert.equal(s.week, 5) // 3 + 2，第 7 天外的不算
})

test('summarizeAdviceLog: Top5 按次数（加权）降序，平局按规则 id 稳', () => {
  const s = summarizeAdviceLog([
    entry({ runs: 2, advice: [adv('rb', 'mid'), adv('ra', 'mid'), adv('rc', 'high')] }),
    entry({ id: 'a2', runs: 5, advice: [adv('rb', 'mid')] }),
  ])
  assert.deepEqual(
    s.topRules.map((r) => r.id),
    ['rb', 'ra', 'rc'],
  )
  assert.equal(s.topRules[0].count, 7) // 2 + 5
})

test('newAdviceLogId: 不重样，且带 adv 前缀不与收藏 id 混', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newAdviceLogId()))
  assert.equal(ids.size, 200)
  assert.ok([...ids].every((i) => i.startsWith('adv')))
})
