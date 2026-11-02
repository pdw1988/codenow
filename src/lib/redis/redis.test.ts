import test from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { b64ToBytes, bytesToB64, escapeBytes, gunzip, hexDump, jsonPretty, preview, sniff, textToBytes, ttlText, utf8OrNull } from './codec'
import { asArr, asInt, asText, formatReply, splitArgs, type Reply } from './reply'
import { allGroupIds, groupPattern, keyRows, type RedisKey } from './keyTree'

test('gzip 解压后再识别；压缩炸弹到上限就停', async () => {
  const z = new Uint8Array(gzipSync(Buffer.from('{"msg":"操作成功"}')))
  assert.equal(sniff(z), 'gzip')
  const r = await gunzip(z)
  assert.equal(r.cut, false)
  assert.equal(sniff(r.bytes), 'json')
  const bomb = new Uint8Array(gzipSync(Buffer.alloc(5_000_000)))
  const b = await gunzip(bomb, 1_000_000)
  assert.equal(b.cut, true)
  assert.equal(b.bytes.length, 1_000_000)
  await assert.rejects(gunzip(Uint8Array.of(0x1f, 0x8b, 1, 2, 3)))
})

test('按组批量删的模式：前缀里的通配符转义', () => {
  assert.equal(groupPattern('login_tokens:'), 'login_tokens:*')
  assert.equal(groupPattern('a*b:[x]?:'), 'a\\*b:\\[x\\]\\?:*')
  assert.equal(groupPattern('c:\\d:'), 'c:\\\\d:*')
})

const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const str = (s: string): Reply => ({ t: 'str', v: bytesToB64(textToBytes(s)) })

test('base64 往返不丢字节：Java 序列化头 AC ED 不能经过字符串变成 �', () => {
  const raw = Uint8Array.of(0xac, 0xed, 0x00, 0x05, 0x74, 0x00, 0x03)
  assert.deepEqual(b64ToBytes(bytesToB64(raw)), raw)
  assert.equal(utf8OrNull(raw), null)
  assert.equal(sniff(raw), 'jdk')
})

test('大值分块转 base64，不爆调用栈', () => {
  const big = new Uint8Array(300_000).fill(65)
  assert.equal(b64ToBytes(bytesToB64(big)).length, 300_000)
})

test('识别：JSON / 文本 / gzip / 其它二进制', () => {
  assert.equal(sniff(textToBytes('{"a":1}')), 'json')
  assert.equal(sniff(textToBytes('[1,2]')), 'json')
  assert.equal(sniff(textToBytes('{不是json')), 'text')
  assert.equal(sniff(textToBytes('12345')), 'text')
  assert.equal(sniff(Uint8Array.of(0x1f, 0x8b, 8, 0)), 'gzip')
  assert.equal(sniff(Uint8Array.of(0xff, 0xfe, 0x00)), 'binary')
})

test('JSON 格式化不丢长整数精度（雪花 ID）', () => {
  const out = jsonPretty('{"id":1234567890123456789}')
  assert.ok(out?.includes('1234567890123456789'))
})

test('二进制键名按 redis-cli 写法转义，中文原样', () => {
  assert.equal(escapeBytes(Uint8Array.of(0xac, 0xed, 0x41)), '\\xac\\xedA')
  assert.equal(escapeBytes(textToBytes('用户:1\n')), '用户:1\\n')
  assert.equal(escapeBytes(textToBytes('a"b')), 'a\\"b')
})

test('十六进制每行 16 字节，右边是可见字符', () => {
  const lines = hexDump(textToBytes('ABCDEFGHIJKLMNOPQ')).split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0]!, /^00000000 {2}41 42/)
  assert.match(lines[1]!, /\|Q\|$/)
})

test('预览压成一行；Java 序列化只写类型和长度', () => {
  assert.equal(preview(textToBytes('a\n  b')), 'a b')
  assert.match(preview(Uint8Array.of(0xac, 0xed, 0, 5)), /Java 序列化 · 4 字节/)
})

test('过期时间：取最大的两档，-1 是永不过期', () => {
  assert.equal(ttlText(-1), '永不过期')
  assert.equal(ttlText(90_061_000), '1 天 1 小时')
  assert.equal(ttlText(59_000), '59 秒')
  assert.equal(ttlText(0), '0 秒')
})

test('命令行：引号里的空格是一个参数，\\x 写二进制字节', () => {
  const args = splitArgs('SET "user name" \'it\\\'s\' "\\xac\\xed\\n"')
  assert.ok(Array.isArray(args))
  assert.deepEqual(args.slice(0, 3).map(dec), ['SET', 'user name', "it's"])
  assert.deepEqual([...args[3]!], [0xac, 0xed, 0x0a])
})

test('命令行：引号没配对给错误，不是把半句发出去', () => {
  assert.equal(typeof splitArgs('GET "abc'), 'string')
  assert.deepEqual(splitArgs('   '), [])
})

test('回复按 redis-cli 的样子排，嵌套数组缩进对齐', () => {
  assert.equal(formatReply({ t: 'nil' }), '(nil)')
  assert.equal(formatReply({ t: 'int', v: 3 }), '(integer) 3')
  assert.equal(formatReply(str('你好\n')), '"你好\\n"')
  assert.equal(formatReply({ t: 'arr', v: [] }), '(empty array)')
  const nested: Reply = { t: 'arr', v: [str('0'), { t: 'arr', v: [str('a'), str('b')] }] }
  assert.equal(formatReply(nested), '1) "0"\n2) 1) "a"\n   2) "b"')
})

test('从回复取值：形状不对给空值', () => {
  assert.equal(asInt({ t: 'int', v: 7 }), 7)
  assert.equal(asInt(str('42')), 42)
  assert.equal(asText({ t: 'status', v: 'hash' }), 'hash')
  assert.deepEqual(asArr({ t: 'nil' }), [])
})

const K = (name: string, type = 'string'): RedisKey => ({ b64: bytesToB64(textToBytes(name)), name, type })

test('键树：按冒号分组，组在前键在后，收起的组不展开', () => {
  const keys = [K('user:2:token'), K('user:1:token'), K('user:1:name'), K('config')]
  const closed = keyRows(keys, ':', new Set())
  assert.deepEqual(
    closed.map((r) => [r.kind, r.label, r.count]),
    [
      ['group', 'user', 3],
      ['key', 'config', undefined],
    ],
  )
  const opened = keyRows(keys, ':', allGroupIds(keys, ':'))
  assert.deepEqual(
    opened.map((r) => `${'  '.repeat(r.depth)}${r.label}`),
    ['user', '  1', '    name', '    token', '  2', '    token', 'config'],
  )
})

test('键树：同名的键和组各算各的，双冒号的空段也是一组', () => {
  const keys = [K('user'), K('user:1'), K('a::b')]
  const rows = keyRows(keys, ':', allGroupIds(keys, ':'))
  assert.deepEqual(
    rows.map((r) => [r.kind, r.label]),
    [
      ['group', 'a'],
      ['group', ''],
      ['key', 'b'],
      ['group', 'user'],
      ['key', '1'],
      ['key', 'user'],
    ],
  )
})

test('键树：分隔符为空就是平铺', () => {
  const rows = keyRows([K('b:1'), K('a:1')], '', new Set())
  assert.deepEqual(
    rows.map((r) => r.label),
    ['a:1', 'b:1'],
  )
})
