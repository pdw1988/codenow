import test from 'node:test'
import assert from 'node:assert/strict'
import { ENV_PROFILES_MAX, evictedBy, parseProfiles, upsertProfile } from './envProfiles'
import type { EnvProfile, EnvironmentConfig } from './types'

const env = (baseUrl: string): EnvironmentConfig =>
  ({
    baseUrl,
    loginApi: '',
    username: '',
    tokenHeader: 'Authorization',
    tokenPrefix: 'Bearer',
    timeoutMs: 5000,
    connId: '',
    assertMode: 'observe',
  }) as EnvironmentConfig

test('upsertProfile：新的排最前，返回存进去的那一份', () => {
  const first = upsertProfile([], '开发', env('http://dev'))
  const second = upsertProfile(first.list, '测试', env('http://sit'))
  assert.equal(second.list.length, 2)
  assert.equal(second.list[0]!.name, '测试')
  assert.equal(second.profile.name, '测试')
  assert.equal(second.profile.env.baseUrl, 'http://sit')
})

test('upsertProfile：同名覆盖——旧的条目消失，不留两份「测试」', () => {
  const a = upsertProfile([], '测试', env('http://sit-old'))
  const b = upsertProfile(a.list, '测试', env('http://sit-new'))
  assert.equal(b.list.length, 1)
  assert.equal(b.list[0]!.env.baseUrl, 'http://sit-new')
  assert.notEqual(b.list[0]!.id, a.profile.id, '同名覆盖生成新条目，以名字为业务身份')
})

test(`upsertProfile：超过 ${ENV_PROFILES_MAX} 组从队尾裁`, () => {
  let list: EnvProfile[] = []
  for (let i = 0; i < ENV_PROFILES_MAX + 3; i++) {
    list = upsertProfile(list, `组${i}`, env(`http://x${i}`)).list
  }
  assert.equal(list.length, ENV_PROFILES_MAX)
  assert.equal(list[0]!.name, `组${ENV_PROFILES_MAX + 2}`, '最新的一组保住')
})

test('evictedBy：满了才挤最旧的；同名覆盖不挤；与 upsertProfile 实际裁掉的一致', () => {
  let list: EnvProfile[] = []
  for (let i = 0; i < ENV_PROFILES_MAX; i++) list = upsertProfile(list, `组${i}`, env(`http://x${i}`)).list
  assert.equal(evictedBy(list.slice(1), '新'), null, '未满')
  assert.equal(evictedBy(list, '组3'), null, '同名')
  const gone = evictedBy(list, '新')
  assert.equal(gone, '组0')
  const after = upsertProfile(list, '新', env('http://n')).list
  assert.ok(!after.some((p) => p.name === gone))
})

test('parseProfiles：往返无损；坏 JSON / 非数组 / 残缺条目都不挡页面', () => {
  const good: EnvProfile[] = [{ id: 'p1', name: '测试', savedAt: 123, env: env('http://sit') }]
  assert.deepEqual(parseProfiles(JSON.stringify(good)), good)

  assert.deepEqual(parseProfiles(null), [])
  assert.deepEqual(parseProfiles(''), [])
  assert.deepEqual(parseProfiles('不是 JSON'), [])
  assert.deepEqual(parseProfiles('{"a":1}'), [])
  assert.deepEqual(
    parseProfiles(JSON.stringify([{ id: '', name: 'x', env: {} }, { id: 'p2', env: {} }, { id: 'p3', name: '没env' }, 'str'])),
    [],
    '缺 id / 名字 / env 的条目逐条丢掉',
  )
  const partial = parseProfiles(JSON.stringify([{ id: 'p9', name: '没时间戳', env: env('http://x') }]))
  assert.equal(partial[0]!.savedAt, 0)
})
