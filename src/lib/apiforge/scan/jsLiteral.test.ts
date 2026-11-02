import test from 'node:test'
import assert from 'node:assert/strict'
import { matchClose, objectProps, splitTopLevel, stripComments, strLit } from './jsLiteral'

test('去注释：行注释 / 块注释 / HTML 注释去掉，字符串里的 // 留着', () => {
  const src = `const a = 'http://x' // 尾注释\n/* 块 */ b()\n<!-- <ruoyi-search /> --><div/>`
  const out = stripComments(src)
  assert.ok(out.includes("'http://x'"))
  assert.ok(!out.includes('尾注释'))
  assert.ok(!out.includes('块'))
  assert.ok(!out.includes('ruoyi-search'))
  assert.ok(out.includes('<div/>'))
})

test('去注释：模板里的单个撇号只吃到行尾，不会吞掉后面整个文件', () => {
  const out = stripComments("<p>it's</p>\n// x\nkeep()")
  assert.ok(out.includes('keep()'))
  assert.ok(!out.includes('// x'))
})

test('配括号：跨嵌套和字符串里的括号', () => {
  const s = "[{ a: '}]', b: [1, (2)] }, 3]"
  assert.equal(matchClose(s, 0), s.length - 1)
  assert.equal(matchClose('{ (] }', 0), -1)
})

test('拆顺层逗号：对象 / 箭头函数 / 字符串里的逗号不拆', () => {
  assert.deepEqual(splitTopLevel(" ...root, { a: 1, b: 'x,y' }, () => f(1, 2), "), ['...root', "{ a: 1, b: 'x,y' }", '() => f(1, 2)'])
})

test('对象字面量的键：只取顶层，引号键也认，展开和简写跳过', () => {
  const m = objectProps("{ path: '/a', 'name': 'A', meta: { title: '甲' }, ...x, short }")
  assert.equal(m.get('path'), "'/a'")
  assert.equal(m.get('name'), "'A'")
  assert.equal(m.get('meta'), "{ title: '甲' }")
  assert.equal(m.has('title'), false)
  assert.equal(objectProps('not object').size, 0)
})

test('字符串字面量：只认整段是一个字符串的', () => {
  assert.equal(strLit("'/a'"), '/a')
  assert.equal(strLit('"b"'), 'b')
  assert.equal(strLit("x ? '/a' : '/b'"), null)
  assert.equal(strLit(undefined), null)
})
