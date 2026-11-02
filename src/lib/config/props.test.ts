/**
 * parseProps/dumpProps 的回归。续行和转义是正式版补齐原型欠账的能力，
 * 每条都对应老配置文件里真实存在的写法。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeEscapes, dumpProps, parseProps } from './props'

const errOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('预期抛错没有抛')
}

test('= 和 : 都算分隔符；键值两侧空白剥掉；注释与空行跳过', () => {
  const { tree } = parseProps(
    ['# 头注释', 'a.b = 1', '', 'c.d:2', '   # 整行注释', 'e= 三'].join('\n'),
  )
  assert.deepEqual(tree, { 'a.b': '1', 'c.d': '2', e: '三' })
})

test('重复键报第一次出现的行号', () => {
  const msg = errOf(() => parseProps('a=1\nb=2\na=3'))
  assert.match(msg, /第 3 行/)
  assert.match(msg, /第一次出现在第 1 行/)
})

test('缺分隔符的行报错带行号', () => {
  const msg = errOf(() => parseProps('# ok\n这行啥都不是'))
  assert.match(msg, /第 2 行/)
  assert.match(msg, /=/)
})

test('反斜杠续行把多行拼成一个值；错误发生在续行块里时报的是逻辑行首行号', () => {
  const { tree } = parseProps(['desc=line one\\', '      line two', 'next=1'].join('\n'))
  assert.equal(tree.desc, 'line oneline two')
  assert.equal(tree.next, '1')

  // 「缺分隔符」的其实是物理第 2 行的内容，但它拼在第 1 行后面——报第 1 行
  const msg = errOf(() => parseProps(['justtext\\', 'more'].join('\n')))
  assert.match(msg, /第 1 行/)
})

test('偶数个行尾反斜杠是转义不是续行', () => {
  // 输入是「p=a\\⏎q=2」（两个反斜杠），解码后是单个字面反斜杠
  const { tree } = parseProps('p=a\\\\\nq=2')
  assert.equal(tree.p, 'a\\')
  assert.equal(tree.q, '2')
})

test('转义解码：\\t \\n \\\\ \\uXXXX 与 \\其他字符', () => {
  assert.equal(decodeEscapes('a\\tb'), 'a\tb')
  assert.equal(decodeEscapes('\\u4e2d\\u6587'), '中文')
  assert.equal(decodeEscapes('a\\\\b'), 'a\\b')
  assert.equal(decodeEscapes('a\\:b'), 'a:b')
  assert.equal(decodeEscapes('bad\\uZZZZ'), 'baduZZZZ') // 假 \\u 宽容处理
})

test('键里的转义也解码：\\= 不算分隔符', () => {
  const { tree } = parseProps('weird\\=key=v')
  assert.deepEqual(tree, { 'weird=key': 'v' })
})

test('值原样输出不加引号——jdbc url 加引号反而是错的', () => {
  const out = dumpProps({ 'spring.datasource.url': 'jdbc:mysql://localhost:3306/test?x=1:y' })
  assert.equal(out, 'spring.datasource.url=jdbc:mysql://localhost:3306/test?x=1:y')
})

test('多行值 dump 时编码成 \\n，能再解析回来；C:\\names 这类反斜杠不被误解码', () => {
  const multiline = 'row1\nrow2'
  const once = dumpProps({ k: multiline })
  assert.equal(once, 'k=row1\\nrow2')
  assert.equal(parseProps(once).tree.k, multiline)

  // 反斜杠后面跟 n 才翻倍；跟 d 是字面量不翻倍
  const winpath = 'C:\\names'
  const dumped = dumpProps({ p: winpath })
  assert.equal(dumped, 'p=C:\\\\names')
  assert.equal(dumpProps({ p: 'C:\\dir' }), 'p=C:\\dir')
})

test('排序可选，注释跟着原来的键走不换位', () => {
  const notes = { b: '# 注b', a: '# 注a' }
  const out = dumpProps({ b: '2', a: '1' }, notes, true)
  assert.match(out.split('\n')[0], /^a=1 {3}# 注a$/)
  assert.match(out.split('\n')[1], /^b=2 {3}# 注b$/)
})

test('parse→dump→parse 往返：键值集相等', () => {
  const src = [
    '# app',
    'spring.datasource.url=jdbc:mysql://localhost:3306/test   # 本地库',
    'server.port=8080',
    'text=has\\t tab',
  ].join('\n')
  const first = parseProps(src)
  const second = parseProps(dumpProps(first.tree, first.notes))
  assert.deepEqual(second.tree, first.tree)
})
