import test from 'node:test'
import assert from 'node:assert/strict'
import { parseStamp } from './pattern'
import { EMPTY_FILTER, isValidRegex, makePredicate } from './filter'
import type { LogRecord } from './records'

const rec = (over: Partial<LogRecord>): LogRecord => ({
  index: 0,
  raw: '',
  ts: null,
  level: null,
  thread: null,
  logger: null,
  msg: '',
  stack: [],
  mdc: {},
  ...over,
})

test('级别多选：没选不过滤，选了 ERROR 只放 ERROR，没级别的记录被挡', () => {
  const all = [
    rec({ level: 'ERROR' }),
    rec({ level: 'WARN' }),
    rec({ level: 'INFO' }),
    rec({ level: null }),
  ]
  const none = makePredicate({ ...EMPTY_FILTER })
  assert.equal(all.filter(none).length, 4)
  const onlyErr = makePredicate({ ...EMPTY_FILTER, levels: ['ERROR'] })
  assert.deepEqual(all.filter(onlyErr).length, 1)
})

test('时间窗：两端各自生效，ts 未知（null）的记录在有窗时被挡', () => {
  const t = (s: string) => parseStamp(s, 'yyyy-MM-dd HH:mm:ss,SSS')!
  const all = [rec({ ts: t('2026-10-01 09:00:00,000') }), rec({ ts: t('2026-10-01 10:00:00,000') }), rec({ ts: null })]
  const since930 = makePredicate({ ...EMPTY_FILTER, since: t('2026-10-01 09:30:00,000') })
  assert.deepEqual(all.filter(since930).length, 1)
  const until930 = makePredicate({ ...EMPTY_FILTER, until: t('2026-10-01 09:30:00,000') })
  assert.deepEqual(all.filter(until930).length, 1)
})

test('关键字：默认按原文包含（含堆栈），regex 模式按正则', () => {
  const withStack = rec({ raw: '09:00:00 ERROR a - 挂了', stack: ['\tat com.a.Dao.query(Dao.java:5)'], level: 'ERROR' })
  const plain = makePredicate({ ...EMPTY_FILTER, text: 'Dao.java' })
  assert.equal(plain(withStack), true)
  const re = makePredicate({ ...EMPTY_FILTER, text: 'Dao\\.java:\\d+\\)', regex: true })
  assert.equal(re(withStack), true)
  const noMatch = makePredicate({ ...EMPTY_FILTER, text: '不存在' })
  assert.equal(noMatch(withStack), false)
})

test('关键字缺省不分大小写，勾了区分才严格；正则里的特殊字符在包含模式下按字面算', () => {
  const r = rec({ raw: 'x', stack: ['java.lang.NullPointerException: a.b(c)'] })
  assert.equal(makePredicate({ ...EMPTY_FILTER, text: 'nullpointer' })(r), true)
  assert.equal(makePredicate({ ...EMPTY_FILTER, text: 'nullpointer', caseSensitive: true })(r), false)
  assert.equal(makePredicate({ ...EMPTY_FILTER, text: 'a.b(c)' })(r), true)
  assert.equal(makePredicate({ ...EMPTY_FILTER, text: 'a.b(d' })(r), false)
})

test('isValidRegex：坏正则给 false，让界面提前提示而不是运行时炸', () => {
  assert.equal(isValidRegex('Dao\\.java:\\d+'), true)
  assert.equal(isValidRegex('(未闭合'), false)
})

test('组合过滤是 AND：级别 + 关键字同时命中才放行', () => {
  const all = [
    rec({ level: 'ERROR', msg: '保存失败' }),
    rec({ level: 'WARN', msg: '保存慢' }),
    rec({ level: 'ERROR', msg: '查询超时' }),
  ]
  const both = makePredicate({ ...EMPTY_FILTER, levels: ['ERROR'], text: '保存' })
  assert.deepEqual(all.filter(both).length, 1)
})
