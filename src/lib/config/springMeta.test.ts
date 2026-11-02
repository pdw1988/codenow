/**
 * 智能提示过滤与插入的回归。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeInsertion, filterHints } from './springMeta'

test('空查询给全量内置清单', () => {
  assert.ok(filterHints('').length >= 14)
})

test('前缀命中优先于包含兜底：spring. 只出 spring 系', () => {
  const keys = filterHints('spring.').map((h) => h.key)
  assert.ok(keys.length > 0)
  assert.ok(keys.every((k) => k.startsWith('spring.')))
})

test('大小写不敏感：Spring. 与 spring. 同一批结果', () => {
  assert.deepEqual(filterHints('Spring.').map((h) => h.key), filterHints('spring.').map((h) => h.key))
})

test('描述包含兜底：搜「端口」出 server.port 和 redis.port', () => {
  const keys = filterHints('端口').map((h) => h.key)
  assert.ok(keys.includes('server.port'))
  assert.ok(keys.includes('spring.redis.port'))
})

test('computeInsertion：替换光标前正在打的半词，joiner 按模式给，光标落在补全之后', () => {
  const yaml = computeInsertion('server.', 7, 'server.port', 'yaml')
  assert.equal(yaml.text, 'server.port: ')
  assert.equal(yaml.cursor, 'server.port: '.length)

  const props = computeInsertion('a.b=c\nserve', 11, 'server.port', 'props')
  assert.equal(props.text, 'a.b=c\nserver.port=')
  assert.equal(props.cursor, 'a.b=c\n'.length + 'server.port='.length)

  // 行中间打了一半的词被整体替换，词前面的内容原样保留
  const mid = computeInsertion('v: server.po', 12, 'server.port', 'yaml')
  assert.equal(mid.text, 'v: server.port: ')
})

test('computeInsertion：JSON 模式的键要带引号，分隔符是 ": "', () => {
  const json = computeInsertion('{\n  server.', 11, 'server.port', 'json')
  assert.equal(json.text, '{\n  "server.port": ')
  assert.equal(json.cursor, '{\n  "server.port": '.length)
})
