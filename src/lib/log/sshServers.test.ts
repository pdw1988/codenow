/**
 * 常用 SSH 服务器名册的边界：同地址重存算更新不算两条（主机名大小写不算
 * 两台）、备注名保留用户起过的、坏数据读回来宁缺毋滥。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  loadSshServers,
  removeSshServer,
  renameSshServer,
  sortSshServers,
  upsertSshServer,
  type SshServer,
} from './sshServers'

const mk = (over: Partial<SshServer> = {}): SshServer => ({
  id: 'deploy@demo.host:22',
  name: '演示机',
  host: 'demo.host',
  port: 22,
  user: 'deploy',
  remotePath: '/var/log/app',
  lastUsed: 1000,
  ...over,
})

test('新机器插到最前，缺省备注名是 user@host', () => {
  const list = upsertSshServer([], { host: 'Demo.Host', port: 22, user: 'deploy', remotePath: '/var/log' })
  assert.equal(list.length, 1)
  // 身份键里主机归一小写：同一台机器大小写打两遍不算两台
  assert.equal(list[0]!.id, 'deploy@demo.host:22')
  assert.equal(list[0]!.name, 'deploy@Demo.Host')
  assert.equal(list[0]!.remotePath, '/var/log')
})

test('同地址重存是更新：目录跟上、备注名保留、只剩一条', () => {
  const first = upsertSshServer([], { host: 'demo.host', port: 22, user: 'deploy', remotePath: '/var/log', name: '演示机' })
  const again = upsertSshServer(first, { host: 'demo.host', port: 22, user: 'deploy', remotePath: '/data/logs' })
  assert.equal(again.length, 1)
  assert.equal(again[0]!.name, '演示机', '重存不丢用户起过的备注名')
  assert.equal(again[0]!.remotePath, '/data/logs')
})

test('重存时显式给了新备注名才换名', () => {
  const first = upsertSshServer([], { host: 'demo.host', port: 22, user: 'deploy', remotePath: '/var/log', name: '演示机' })
  const renamed = upsertSshServer(first, { host: 'demo.host', port: 22, user: 'deploy', remotePath: '/var/log', name: '生产演示' })
  assert.equal(renamed[0]!.name, '生产演示')
  // 空名字 / 纯空白不算给了新名字
  const kept = upsertSshServer(renamed, { host: 'demo.host', port: 22, user: 'deploy', remotePath: '/var/log', name: '  ' })
  assert.equal(kept[0]!.name, '生产演示')
})

test('不同端口 / 用户是不同的机器', () => {
  const list = upsertSshServer(
    upsertSshServer([], { host: 'h', port: 22, user: 'a', remotePath: '/x' }),
    { host: 'h', port: 2222, user: 'a', remotePath: '/x' },
  )
  assert.equal(list.length, 2)
  assert.deepEqual(list.map((s) => s.port).sort(), [22, 2222])
})

test('改名：清空不生效，空白裁掉', () => {
  const list = [mk()]
  assert.equal(renameSshServer(list, mk().id, '  ')[0]!.name, '演示机')
  assert.equal(renameSshServer(list, mk().id, ' 新名 ')[0]!.name, '新名')
  // 不存在的 id 不动
  assert.deepEqual(renameSshServer(list, 'nope', 'x'), list)
})

test('删除按身份键', () => {
  const list = upsertSshServer([mk()], { host: 'b.host', port: 22, user: 'u', remotePath: '/y' })
  const after = removeSshServer(list, 'u@b.host:22')
  assert.equal(after.length, 1)
  assert.equal(after[0]!.id, 'deploy@demo.host:22')
})

test('排序：最近用过的在前', () => {
  const sorted = sortSshServers([mk({ lastUsed: 5 }), mk({ id: 'x', lastUsed: 9 }), mk({ id: 'y', lastUsed: 7 })])
  assert.deepEqual(
    sorted.map((s) => s.id),
    ['x', 'y', 'deploy@demo.host:22'],
  )
})

test('坏数据读回来宁缺毋滥', () => {
  assert.deepEqual(loadSshServers(null), [])
  assert.deepEqual(loadSshServers('nope'), [])
  assert.deepEqual(loadSshServers([null, 3, {}]), [])
  const good = mk()
  const list = loadSshServers([
    good,
    mk({ port: 0 }), // 端口越界
    mk({ port: 70000 }),
    mk({ host: '' }),
    mk({ user: '' }),
    mk({ name: undefined as unknown as string }),
    mk({ remotePath: undefined as unknown as string }),
    mk({ lastUsed: 'x' as unknown as number }),
  ])
  assert.deepEqual(list, [good])
})
