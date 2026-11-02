/**
 * parseYaml/dumpYaml 的回归。用例名对应真会踩的坑：
 * 注释保活是 PRD MVP 第 9 条的 P0 正主，行号报错是第五章的验收标准。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dumpYaml, parseYaml } from './yaml'

const errOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('预期抛错没有抛')
}

test('嵌套层级与标量类型：数字、布尔、null/~ 各归各位', () => {
  const { tree } = parseYaml(
    ['a:', '  n: 10', '  f: false', '  ok: true', '  x: null', '  y: ~', '  s: hello'].join('\n'),
  )
  const a = tree.a as Record<string, unknown>
  assert.equal(a.n, 10)
  assert.equal(a.f, false)
  assert.equal(a.ok, true)
  assert.equal(a.x, null)
  assert.equal(a.y, null)
  assert.equal(a.s, 'hello')
})

test('行尾注释按完整点分路径记进 notes——url 和 redis.url 的注释不串', () => {
  const src = [
    'spring:',
    '  datasource:',
    '    url: jdbc:mysql://local   # 主库',
    '  redis:',
    '    url: redis://local   # 缓存',
  ].join('\n')
  const { notes } = parseYaml(src)
  assert.equal(notes['spring.datasource.url'], '# 主库')
  assert.equal(notes['spring.redis.url'], '# 缓存')
})

test('制表符缩进报「非法字符」且带行号', () => {
  const msg = errOf(() => parseYaml('a:\n\tb: 1'))
  assert.match(msg, /第 2 行/)
  assert.match(msg, /制表符/)
})

test('奇数空格缩进报期望偶数空格并带实际个数', () => {
  const msg = errOf(() => parseYaml('a:\n   b: 1'))
  assert.match(msg, /第 2 行/)
  assert.match(msg, /实际 3 个/)
})

test('重复键报错带行号', () => {
  const msg = errOf(() => parseYaml('a: 1\na: 2'))
  assert.match(msg, /第 2 行/)
  assert.match(msg, /重复键 'a'/)
})

test('既不是键值对也不是列表项的行报「看不懂」', () => {
  const msg = errOf(() => parseYaml('只是一段话'))
  assert.match(msg, /第 1 行/)
  assert.match(msg, /看不懂/)
})

test('列表项挂在最近的键下，注释记成 键[下标]', () => {
  const { tree, notes } = parseYaml(['servers:   # 列表', '  - alpha   # 第一台', '  - beta'].join('\n'))
  assert.deepEqual(tree.servers, { 0: 'alpha', 1: 'beta' })
  assert.equal(notes['servers[0]'], '# 第一台')
})

test('引号里的 # 不是注释；值里无空格引导的 # 原样保留', () => {
  const { tree } = parseYaml("u: 'has # hash'")
  assert.equal(tree.u, 'has # hash')
  const { tree: t2 } = parseYaml('u: v#2')
  assert.equal(t2.u, 'v#2')
})

test('dump：null 出 ~，含 #: 的字符串加单引号，notes 按路径回填', () => {
  const out = dumpYaml({ a: { x: null, u: 'a:b#c' } }, 2, { 'a.x': '# 空' })
  assert.match(out, /^a:\n {2}x: ~ {3}# 空\n {2}u: 'a:b#c'$/m)
})

test('格式化幂等：dump(parse(dump)) 与第一次 dump 相同', () => {
  const src = ['a:', '  b: 1   # 注', '  c: "quoted"', 'd: ~'].join('\n')
  const once = dumpYaml(parseYaml(src).tree, 2, parseYaml(src).notes)
  const twice = dumpYaml(parseYaml(once).tree, 2, parseYaml(once).notes)
  assert.equal(twice, once)
})

test('含 - 列表的 YAML 格式化后还是 - 形式，不是 0:/1: 数字键', () => {
  const parsed = parseYaml(['servers:', '  - alpha', '  - beta'].join('\n'))
  const out = dumpYaml(parsed.tree, 2)
  assert.match(out, /servers:\n {2}- alpha\n {2}- beta/)
})

test('parse→dump→parse 往返：树和注释都无损', () => {
  const src = [
    'spring:',
    '  datasource:',
    '    url: jdbc:mysql://localhost:3306/test   # 本地库',
    '    username: root',
    'logging:',
    '  level:',
    '    root: info',
  ].join('\n')
  const first = parseYaml(src)
  const dumped = dumpYaml(first.tree, 2, first.notes)
  const second = parseYaml(dumped)
  assert.deepEqual(second.tree, first.tree)
  assert.deepEqual(second.notes, first.notes)
})
