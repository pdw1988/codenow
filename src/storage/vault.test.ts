import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  matchVault,
  parseVault,
  parseVaultText,
  presetFields,
  removeVault,
  splitSecrets,
  upsertVault,
  vaultCredTarget,
  vaultSummary,
  VAULT_KEY,
  type VaultItem,
} from './vault'
import { DBCONNS_KEY } from './dbconn'
import { REDIS_CONNS_KEY } from './redisConns'

const item = (id: string, over: Partial<VaultItem> = {}): VaultItem => ({
  id,
  name: `条目${id}`,
  cat: 'vpn',
  fields: [
    { id: 'a', label: '地址', value: 'vpn.example.com', secret: false },
    { id: 'p', label: '密码', value: '', secret: true },
  ],
  note: '',
  updatedAt: 1,
  ...over,
})

test('parseVault：坏 JSON / 坏条目跳过，敏感字段误存的值洗掉', () => {
  assert.deepEqual(parseVault(null), [])
  assert.deepEqual(parseVault('{'), [])
  const raw = JSON.stringify([
    { id: '1', name: ' 公司 VPN ', cat: 'vpn', fields: [{ id: 'p', label: '密码', value: 'leak', secret: true }] },
    { id: '', name: 'x', fields: [] },
    { id: '2', name: 'y', cat: 'nope', fields: [{ id: '', label: 'bad', value: '' }] },
  ])
  const got = parseVault(raw)
  assert.equal(got.length, 2)
  assert.equal(got[0].name, '公司 VPN')
  assert.equal(got[0].fields[0].value, '')
  assert.equal(got[1].cat, 'other')
  assert.equal(got[1].fields.length, 0)
})

test('splitSecrets：敏感值拆出去、空行去掉，密码不 trim', () => {
  const { item: it, secrets } = splitSecrets(
    item('1', {
      fields: [
        { id: 'a', label: ' 地址 ', value: ' h ', secret: false },
        { id: 'p', label: '密码', value: ' s3 ', secret: true },
        { id: 'e', label: '', value: '  ', secret: false },
      ],
    }),
  )
  assert.deepEqual(secrets, { p: ' s3 ' })
  assert.deepEqual(
    it.fields.map((x) => [x.label, x.value]),
    [
      ['地址', 'h'],
      ['密码', ''],
    ],
  )
})

test('upsertVault：改的留原位，新的放最前；removeVault', () => {
  const list = [item('1'), item('2')]
  assert.deepEqual(upsertVault(list, item('2', { name: '改' })).map((x) => x.name), ['条目1', '改'])
  assert.deepEqual(upsertVault(list, item('3')).map((x) => x.id), ['3', '1', '2'])
  assert.deepEqual(removeVault(list, '1').map((x) => x.id), ['2'])
})

test('matchVault / vaultSummary：搜得到字段值和分类名，摘要不露密码', () => {
  const it = item('1')
  assert.ok(matchVault(it, 'EXAMPLE'))
  assert.ok(matchVault(it, 'vpn'))
  assert.ok(!matchVault(it, 'nothing'))
  assert.equal(vaultSummary(it), 'vpn.example.com')
})

test('parseVaultText：中英文冒号、等号、地址行、其余进备注', () => {
  const { fields, note } = parseVaultText(
    [
      '地址：10.0.0.8',
      'user: root',
      'password=abc:123',
      'https://vpn.example.com:8443/login',
      'jdbc:oracle:thin:@10.0.0.9:1521/ORCL',
      '10.0.0.7:22',
      '周末不要用',
      '',
    ].join('\r\n'),
  )
  assert.deepEqual(
    fields.map((x) => [x.label, x.value, x.secret]),
    [
      ['地址', '10.0.0.8', false],
      ['user', 'root', false],
      ['password', 'abc:123', true],
      ['地址', 'https://vpn.example.com:8443/login', false],
      ['地址', 'jdbc:oracle:thin:@10.0.0.9:1521/ORCL', false],
      ['地址', '10.0.0.7:22', false],
    ],
  )
  assert.equal(note, '周末不要用')
})

test('预填字段带密码行且 id 不重；存储键不跟别的撞', () => {
  const fs = presetFields('db')
  assert.ok(fs.some((x) => x.secret))
  assert.equal(new Set(fs.map((x) => x.id)).size, fs.length)
  assert.notEqual(VAULT_KEY, DBCONNS_KEY)
  assert.notEqual(VAULT_KEY, REDIS_CONNS_KEY)
  assert.equal(vaultCredTarget('x'), 'vault|x')
})
