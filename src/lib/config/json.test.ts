/**
 * JSON 侧的回归。钉三件事：数组 ↔ 数字键树的往返、类型不失真、报错带行号。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { YamlNode } from './common'
import { dumpJson, parseJson } from './json'

const errOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('预期抛错没有抛')
}

test('parse：嵌套对象成树，JSON 没有注释所以 notes 恒空', () => {
  const { tree, notes } = parseJson('{"spring": {"datasource": {"url": "jdbc:x"}}}')
  assert.deepEqual(tree, { spring: { datasource: { url: 'jdbc:x' } } })
  assert.deepEqual(notes, {})
})

test('parse：数组变成数字字符串键的对象，跟 YAML 侧同一套表示', () => {
  // flatten/nest/dumpYaml 都认这个形状，JSON 因此不用为列表单开分支
  const { tree } = parseJson('{"servers": ["alpha", "beta"]}')
  assert.deepEqual((tree.servers as YamlNode), { 0: 'alpha', 1: 'beta' })
})

test('parse：数字/布尔/null 三种标量原样进树，不被字符串化', () => {
  const { tree } = parseJson('{"port": 8080, "ssl": false, "extra": null}')
  assert.equal(tree.port, 8080)
  assert.equal(tree.ssl, false)
  assert.equal(tree.extra, null)
})

test('dump：数字键树还原成真数组，层级用传入的缩进宽度', () => {
  const tree = parseJson('{"servers": ["alpha", {"host": "h"}]}').tree
  assert.equal(dumpJson(tree, 2), JSON.stringify({ servers: ['alpha', { host: 'h' }] }, null, 2))
  assert.match(dumpJson({ a: { b: 1 } }, 4), /\{\n {4}"a": \{\n {8}"b": 1/)
})

test('往返：parse→dump→parse 树不变，dump 自身也幂等', () => {
  const src = '{"a": {"b": 1}, "list": [1, 2], "n": null, "s": "x"}'
  const first = parseJson(src)
  const dumped = dumpJson(first.tree, 2)
  const second = parseJson(dumped)
  assert.deepEqual(second.tree, first.tree)
  assert.equal(dumpJson(second.tree, 2), dumped)
})

test('报错：语法错误时要带「第 N 行」，指得出用户该改哪一行', () => {
  const src = ['{', '  "a": 1,', '  "b": ,', '}'].join('\n')
  const msg = errOf(() => parseJson(src))
  assert.match(msg, /第 3 行/)
  assert.match(msg, /不是合法 JSON/)
})

test('报错：收尾不完整时行号跟着 V8 的能力走——有 position 就指对行，没有就不编', () => {
  // Node 24 的 V8 对 `{"a": 1` 报「…at position 7 (line 1 column 8)」，有位置线索，
  // 折出来的「第 1 行」就是真的；老的 V8 只说「Unexpected end of JSON input」，
  // 那时候报一个行号等于指着没问题的代码骂。两种都算对，但不许出现折错的行号。
  const msg = errOf(() => parseJson('{"a": 1'))
  assert.match(msg, /不是合法 JSON/)
  if (/position \d+/.test(msg)) assert.match(msg, /第 1 行/, `行号要指对行：${msg}`)
  else assert.ok(!/第 \d+ 行/.test(msg), `不该出现行号：${msg}`)
})

test('报错：顶层是散落标量时拒绝——配置文件是一堆键，不是一个值', () => {
  assert.match(errOf(() => parseJson('42')), /第 1 行.*顶层必须是对象或数组/)
  assert.match(errOf(() => parseJson('"x"')), /顶层必须是对象或数组/)
  assert.match(errOf(() => parseJson('null')), /顶层必须是对象或数组/)
})
