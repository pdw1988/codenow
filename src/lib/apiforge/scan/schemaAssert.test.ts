import test from 'node:test'
import assert from 'node:assert/strict'
import { schemaCheck, schemaIssuesFor } from './schemaAssert'
import type { TypeDict } from './bodyFields'
import type { DtoField } from '../types'

/** 贴真实字典形状：Long 主键、必填 String、可空 Integer、嵌套 VO、集合 */
const f = (name: string, javaType: string, required = false, description?: string): DtoField => ({
  name,
  javaType,
  required,
  ...(description ? { description } : {}),
})

const dict: TypeDict = new Map([
  [
    'UserVo',
    [
      f('id', 'Long', true),
      f('name', 'String', true),
      f('age', 'Integer'),
      f('createTime', 'Date'),
      f('roles', 'List<RoleVo>', false),
      f('tags', 'List<String>'),
    ],
  ],
  [
    'RoleVo',
    [f('id', 'Long', true), f('roleName', 'String', true), f('parentId', 'Long')],
  ],
  // 截断行为用的宽类型：12 个必填 String，全给数字就有 12 处同源差异
  ['WideVo', Array.from({ length: 12 }, (_, i) => f(`p${i}`, 'String', true))],
])

const issues = (bodyText: string | null | undefined, responseType = 'UserVo'): string[] =>
  schemaIssuesFor(responseType, dict, bodyText)

test('结构对得上 → 零差异', () => {
  const body = JSON.stringify({
    id: 1001,
    name: '张三',
    createTime: '2026-01-01 00:00:00',
    roles: [{ id: 1, roleName: '管理员' }],
    tags: ['vip'],
  })
  assert.deepEqual(issues(body), [])
})

test('多余字段不报：懒加载代理、基类审计字段是序列化噪音不是缺陷', () => {
  const body = JSON.stringify({ id: 1, name: 'a', hibernateLazyInitializer: {}, gmtCreate: 'x' })
  assert.deepEqual(issues(body), [])
})

test('必填缺失 / 必填 null 报，可空字段缺不报', () => {
  const one = issues(JSON.stringify({ name: 'a' }))
  assert.equal(one.length, 1)
  assert.match(one[0]!, /\$\.id：必填字段缺失/)

  const two = issues(JSON.stringify({ id: 1, name: null }))
  assert.equal(two.length, 1)
  assert.match(two[0]!, /\$\.name：必填字段为 null/)

  assert.deepEqual(issues(JSON.stringify({ id: 1, name: 'a' })), [])
})

test('类型不符报人话：声明 Long 实际是字符串样本', () => {
  const one = issues(JSON.stringify({ id: 1, name: ['a'] }))
  assert.equal(one.length, 1)
  assert.match(one[0]!, /\$\.name：声明 String（字符串），实际 数组/)
})

test('雪花 id 是数字字符串：bigIntJson unwrap 出来的形态，按数字放行', () => {
  const body = JSON.stringify({ id: '1987654321098765431', name: 'a' })
  assert.deepEqual(issues(body), [])
})

test('真类型漂移抓得住：数字字段给了非数字串', () => {
  const one = issues(JSON.stringify({ id: 1, name: 'a', age: 'abc' }))
  assert.equal(one.length, 1)
  assert.match(one[0]!, /\$\.age：声明 Integer（数字），实际 字符串 "abc"/)
})

test('Date 给 epoch 毫秒数字放行（Jackson 默认），LocalDate 给数字才报', () => {
  assert.deepEqual(issues(JSON.stringify({ id: 1, name: 'a', createTime: 1727100000000 })), [])
})

test('嵌套 VO 递归校验：内层缺必填带路径报出来', () => {
  const one = issues(JSON.stringify({ id: 1, name: 'a', roles: [{ id: 1 }] }))
  assert.equal(one.length, 1)
  assert.match(one[0]!, /\$\.roles\[0\]\.roleName：必填字段缺失/)
})

test('集合标量元素类型漂移：List<String> 里混进对象要报', () => {
  const one = issues(JSON.stringify({ id: 1, name: 'a', tags: [{ x: 1 }] }))
  assert.equal(one.length, 1)
  assert.match(one[0]!, /\$\.tags\[0\]：声明 String/)
})

test('同形差异判重：20 行都缺同一个字段只报一条', () => {
  const roles = Array.from({ length: 20 }, () => ({ id: 1 }))
  const one = issues(JSON.stringify({ id: 1, name: 'a', roles }))
  assert.equal(one.length, 1)
  assert.match(one[0]!, /\$\.roles\[\*\]\.roleName|roles\[0\]\.roleName/)
})

test('差异超 10 条截断并给省略行', () => {
  const body = JSON.stringify(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`p${i}`, i])))
  const one = issues(body, 'WideVo')
  assert.equal(one.length, 11)
  assert.match(one[10]!, /只列前 10 条/)
})

test('多条不同形的类型漂移逐条报（不是只报第一条）', () => {
  const one = issues(JSON.stringify({ id: 'x', name: 1, age: 'a', createTime: [], roles: 'nope', tags: 3 }))
  assert.equal(one.length, 6)
})

test('声明 DTO 实际回错误信封：根上没有声明字段，拨 data/result 一层对结构', () => {
  const ok = issues(JSON.stringify({ msg: 'ok', code: '0', data: { id: 1, name: 'a' } }))
  assert.deepEqual(ok, [])
  const bad = issues(JSON.stringify({ msg: '请选择品牌商', code: '500', level: 'error' }))
  assert.ok(bad.length >= 2)
  assert.match(bad.join('\n'), /\$\.id.*缺失|\$\.name.*缺失/)
})

test('响应是数组按元素校验（List 泛型被老扫描器剥掉的形态）', () => {
  const good = issues(JSON.stringify([{ id: 1, name: 'a' }]))
  assert.deepEqual(good, [])
  const bad = issues(JSON.stringify([{ name: 'a' }]))
  assert.equal(bad.length, 1)
  assert.match(bad[0]!, /\$\[0\]\.id：必填字段缺失/)
})

test('空体 / null 不算违规：204 和 DELETE 回空没有结构可言', () => {
  assert.deepEqual(issues(''), [])
  assert.deepEqual(issues(null), [])
  assert.deepEqual(issues(undefined), [])
})

test('非 JSON 响应给一句人话：网关错误页也是结构问题', () => {
  const one = issues('<html>502 Bad Gateway</html>')
  assert.equal(one.length, 1)
  assert.match(one[0]!, /不是合法 JSON/)
})

test('字典里没有的类型不校验（Map / String / 外部 VO），标量响应报一句', () => {
  assert.deepEqual(schemaIssuesFor('Map', dict, '{"a":1}'), [])
  assert.deepEqual(schemaIssuesFor('String', dict, '"abc"'), [])
  const one = issues('"abc"')
  assert.match(one[0]!, /标量/)
})

// ---- schemaCheck：资格门 ----

test('schemaCheck：只校验正常用例——边界 / 异常 / 未找到配对都是故意打错误分支', () => {
  const gate = (tc: { type: 'normal' | 'boundary' | 'exception'; probeNotFound?: boolean }) =>
    schemaCheck('UserVo', tc, dict, false)
  assert.ok(gate({ type: 'normal' }))
  assert.equal(gate({ type: 'boundary' }), null)
  assert.equal(gate({ type: 'exception' }), null)
  assert.equal(gate({ type: 'normal', probeNotFound: true }), null)
})

test('schemaCheck：没字典 / 没响应类型 / 字典里没有的类型都不校验', () => {
  assert.equal(schemaCheck('UserVo', { type: 'normal' }, undefined, false), null)
  assert.equal(schemaCheck(null, { type: 'normal' }, dict, false), null)
  assert.equal(schemaCheck('Map', { type: 'normal' }, dict, false), null)
  // 带包名的类型切到简名再查
  assert.ok(schemaCheck('com.a.UserVo', { type: 'normal' }, dict, true))
})
