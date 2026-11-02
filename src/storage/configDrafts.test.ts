/**
 * 配置管理草稿 blob 的回归测试（同 templates.test.ts 的思路）。
 *
 * blob 可能来自旧版本、可能被手改过，坏数据要逐条跳过而不是整批丢弃——
 * 草稿解析炸了不能挡着应用起来，也不能把用户其他草稿一起带走。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONFIG_DRAFT_LIMIT,
  parseConfigDrafts,
  upsertConfigDraft,
} from './configDrafts'

test('parseConfigDrafts: 空值和非法 JSON 都返回空对象', () => {
  assert.deepEqual(parseConfigDrafts(null), {})
  assert.deepEqual(parseConfigDrafts(''), {})
  assert.deepEqual(parseConfigDrafts('{ 这不是 json'), {})
})

test('parseConfigDrafts: 非字符串值逐条跳过，好的留下', () => {
  const raw = JSON.stringify({
    'application.yml|dev': 'server:\n  port: 8080',
    broken: 123, // 值不是字符串 → 丢掉
    'application.yml|prod': null,
    'logback.xml|dev': '<configuration/>',
  })
  const drafts = parseConfigDrafts(raw)
  assert.deepEqual(Object.keys(drafts).sort(), ['application.yml|dev', 'logback.xml|dev'])
})

/** 造 N 个键名递增的草稿记录 */
function makeDrafts(n: number): Record<string, string> {
  const drafts: Record<string, string> = {}
  for (let i = 0; i < n; i++) drafts[`f${i}.yml|dev`] = `content-${i}`
  return drafts
}

test('upsertConfigDraft: 同键覆盖而不是追加，且挪到插入序末尾', () => {
  // 对象的字符串键按「首次插入的位置」排序，覆盖不改变位置——
  // 所以裁剪永远裁到真正最旧的组合，刚改过的不会意外出局
  const drafts = makeDrafts(3)
  const next = upsertConfigDraft(drafts, 'f0.yml|dev', '改过的内容')
  assert.equal(Object.keys(next).length, 3, '覆盖不该增加条数')
  assert.equal(next['f0.yml|dev'], '改过的内容')
  assert.deepEqual(Object.keys(next)[0], 'f0.yml|dev', 'f0 还在最前（首次插入的位置没变）')
})

test('upsertConfigDraft: 不改入参', () => {
  const drafts = makeDrafts(2)
  const snapshot = JSON.stringify(drafts)
  upsertConfigDraft(drafts, 'new.yml|dev', 'x')
  assert.equal(JSON.stringify(drafts), snapshot)
})

test(`upsertConfigDraft: 超上限时裁掉插入序最旧的`, () => {
  let drafts = makeDrafts(CONFIG_DRAFT_LIMIT)
  drafts = upsertConfigDraft(drafts, 'brand-new.yml|dev', '新内容')
  assert.equal(Object.keys(drafts).length, CONFIG_DRAFT_LIMIT)
  assert.equal(drafts['brand-new.yml|dev'], '新内容', '新存的不能被裁掉')
  assert.ok(
    !Object.hasOwn(drafts, 'f0.yml|dev'),
    '被裁掉的应该是最早插进去的那个',
  )
})
