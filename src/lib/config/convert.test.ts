/**
 * flatten/nest/sniff 的回归 + 一条全链路互转保注释的 P0 正主用例。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { YamlNode } from './common'
import { flatten, nest, sniff } from './convert'
import { dumpProps, parseProps } from './props'
import { dumpJson, parseJson } from './json'
import { dumpYaml, parseYaml } from './yaml'

const errOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('预期抛错没有抛')
}

test('flatten 展开嵌套为点分路径；空分支落成空值而不是 [object Object]', () => {
  const flat = flatten({ spring: { profiles: { active: 'dev' } }, empty: {} })
  assert.deepEqual(flat, { 'spring.profiles.active': 'dev', empty: '' })
})

test('列表子键展开成 servers.0 形式', () => {
  const flat = flatten(parseYaml('servers:\n  - alpha\n  - beta').tree)
  assert.deepEqual(flat, { 'servers.0': 'alpha', 'servers.1': 'beta' })
})

test('nest 折叠回嵌套树，a.b[0] 下标记法拆开还原', () => {
  const tree = nest({ 'a.b[0]': 'x', 'a.b.1': 'y', c: 'z' })
  // YamlNode 的叶子类型宽，这里明知是子分支，断言前收窄
  assert.deepEqual((tree.a as YamlNode).b, { 0: 'x', 1: 'y' })
  assert.equal(tree.c, 'z')
})

test('叶子撞分支报冲突，两个方向都要报', () => {
  assert.match(errOf(() => nest({ a: '1', 'a.b': '2' })), /冲突/)
  assert.match(errOf(() => nest({ 'a.b': '2', a: '1' })), /冲突/)
})

test('sniff：成片 k=v 且无 ": " 判 properties', () => {
  assert.equal(sniff('a.b=c\nx.y=z'), 'props')
})

test('sniff：出现任何 "key: value" 都算 yaml（冒号证据优先）', () => {
  assert.equal(sniff('a=1\nb: 2'), 'yaml')
})

test('sniff：注释开头、纯键名、空文本都默认 yaml', () => {
  assert.equal(sniff('# 只有一句注释\nspring:'), 'yaml')
  assert.equal(sniff(''), 'yaml')
})

test('sniff：行首一个 { 或 [ 就判 json（2026-09-22 加 JSON）', () => {
  // 顶层只可能是对象或数组，所以行首字符足够定性；注释行不算行首
  assert.equal(sniff('{\n  "a": 1\n}'), 'json')
  assert.equal(sniff('  # 说明\n["x"]'), 'json')
  assert.equal(sniff('[\n  {"a": 1}\n]'), 'json')
})

test('sniff：JSON 里的 "key": value 不冒犯 yaml 的冒号证据', () => {
  // 花括号判定排在冒号判定前面，所以这段不会被误认成 yaml
  assert.equal(sniff('{"server": {"port": 8080}}'), 'json')
})

test('P0 正主：YAML → Properties → YAML 全链路，行尾注释还在原来的键上', () => {
  const src = [
    'spring:',
    '  datasource:',
    '    url: jdbc:mysql://localhost:3306/test   # 本地库',
    '    username: root   # 账号',
    '  redis:',
    '    host: localhost',
  ].join('\n')

  const yml = parseYaml(src)
  const propsText = dumpProps(flatten(yml.tree), yml.notes)
  assert.match(propsText, /spring\.datasource\.url=jdbc:mysql:\/\/localhost:3306\/test {3}# 本地库/)

  const props = parseProps(propsText)
  const backToYaml = dumpYaml(nest(props.tree), 2, props.notes)
  // 含冒号的值 dump 时会加单引号（原型的防歧义规则），注释照常跟在后面
  assert.match(backToYaml, /url: 'jdbc:mysql:\/\/localhost:3306\/test' {3}# 本地库/)
  assert.match(backToYaml, /username: root {3}# 账号/)

  // 结构也没丢：再解析一次，嵌套形状和第一遍一致
  const reparsed = parseYaml(backToYaml)
  assert.deepEqual(reparsed.tree, yml.tree)
})

test('P0：JSON 与另两种格式共用同一条中间树 —— 转 Properties 时数字键展开成 servers.0', () => {
  // json.ts 把数组搬成数字字符串键就是为了这一步：不用为第三种格式再写一遍展开规则
  const json = parseJson('{"servers": ["alpha", {"host": "h"}], "port": 8080}')
  assert.equal(
    dumpProps(flatten(json.tree)),
    ['servers.0=alpha', 'servers.1.host=h', 'port=8080'].join('\n'),
  )
})

test('P0：YAML → JSON 时列表还原成真数组，不是 0:/1: 数字键', () => {
  const tree = parseYaml('servers:\n  - alpha\n  - beta').tree
  assert.equal(dumpJson(tree, 2), JSON.stringify({ servers: ['alpha', 'beta'] }, null, 2))
})
