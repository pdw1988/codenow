import test from 'node:test'
import assert from 'node:assert/strict'
import {
  APF_WORKSPACE_LEGACY_KEY,
  cachedRootsOf,
  evictCacheIndex,
  findCacheEntry,
  parseCacheIndex,
  removeCacheEntry,
  rootHash,
  touchCacheIndex,
  utf8Bytes,
  workspaceKey,
  type WorkspaceCacheEntry,
} from './workspaceCache'

const e = (root: string, bytes = 1000): WorkspaceCacheEntry => ({
  root,
  hash: rootHash(root),
  bytes,
})

test('路径归一化：斜杠方向 / 尾斜杠 / 大小写不影响同一个目录的键', () => {
  const a = workspaceKey('D:\\work\\projA')
  assert.equal(workspaceKey('D:/work/projA'), a)
  assert.equal(workspaceKey('D:/work/projA/'), a)
  assert.equal(workspaceKey('d:\\WORK\\PROJA'), a)
  // 不同目录必须分开，否则一份会盖掉另一份
  assert.notEqual(workspaceKey('D:/work/projB'), a)
  // 键以老键为前缀 + 8 位 hash：跟 `apiforge.workspace.index` 不可能撞
  assert.match(a, new RegExp(`^${APF_WORKSPACE_LEGACY_KEY}\\.[0-9a-f]{8}$`))
})

test('utf8Bytes：中文按 UTF-8 算，不是字符数', () => {
  assert.equal(utf8Bytes('abc'), 3)
  assert.equal(utf8Bytes('接口'), 6)
})

test('touchCacheIndex：新的进队首，同一目录不留重复', () => {
  let idx = touchCacheIndex([], e('D:/a'))
  idx = touchCacheIndex(idx, e('D:/b'))
  assert.deepEqual(cachedRootsOf(idx), ['D:/b', 'D:/a'])

  // 再打开 a：提到队首而不是多一条
  idx = touchCacheIndex(idx, e('D:/a', 2000))
  assert.deepEqual(cachedRootsOf(idx), ['D:/a', 'D:/b'])
  assert.equal(idx.length, 2)
  assert.equal(idx[0]!.bytes, 2000, '体积要跟着新那份更新')

  // 尾斜杠形式不应该另开一条
  idx = touchCacheIndex(idx, e('D:/a/'))
  assert.equal(idx.length, 2)
})

test('evictCacheIndex：份数超上限时删最久没用的那一份', () => {
  const idx = [e('D:/d'), e('D:/c'), e('D:/b'), e('D:/a')]
  const { kept, dropped } = evictCacheIndex(idx, { maxEntries: 3 })
  assert.deepEqual(cachedRootsOf(kept), ['D:/d', 'D:/c', 'D:/b'])
  assert.deepEqual(cachedRootsOf(dropped), ['D:/a'], '队尾出局')
})

test('evictCacheIndex：份数没满但总字节超了，也从队尾开删', () => {
  const idx = [e('D:/big', 8_000_000), e('D:/mid', 8_000_000), e('D:/old', 8_000_000)]
  const { kept, dropped } = evictCacheIndex(idx, { maxEntries: 3, maxBytes: 20 * 1024 * 1024 })
  // 8+8 = 16 MB 过，再加一份 24 MB 超了
  assert.deepEqual(cachedRootsOf(kept), ['D:/big', 'D:/mid'])
  assert.deepEqual(cachedRootsOf(dropped), ['D:/old'])
})

test('evictCacheIndex：队首单份就超总量上限也得保住（否则扫完立马失效）', () => {
  const idx = [e('D:/huge', 999_000_000), e('D:/small', 1000)]
  const { kept, dropped } = evictCacheIndex(idx, { maxEntries: 3, maxBytes: 20 * 1024 * 1024 })
  assert.deepEqual(cachedRootsOf(kept), ['D:/huge'])
  assert.deepEqual(cachedRootsOf(dropped), ['D:/small'])
})

test('evictCacheIndex：没超限就一条不删', () => {
  const idx = [e('D:/a'), e('D:/b')]
  const { kept, dropped } = evictCacheIndex(idx)
  assert.equal(kept.length, 2)
  assert.equal(dropped.length, 0)
})

test('parseCacheIndex：空 / 坏 JSON / 不是数组 / 条目残缺都当空，不报错', () => {
  assert.deepEqual(parseCacheIndex(null), [])
  assert.deepEqual(parseCacheIndex(''), [])
  assert.deepEqual(parseCacheIndex('{不是 json'), [])
  assert.deepEqual(parseCacheIndex('{"root":"D:/a"}'), [])
  assert.deepEqual(parseCacheIndex('[null,3,"x"]'), [])
  assert.deepEqual(parseCacheIndex('[{"root":"D:/a"}]'), [], 'hash 缺了就找不到 blob')
  assert.deepEqual(parseCacheIndex('[{"hash":"deadbeef"}]'), [], 'root 缺了 UI 没法比对')
  // bytes 丢了不能整条丢：当 0，下次写入时会把真实体积补上
  assert.deepEqual(parseCacheIndex('[{"root":"D:/a","hash":"deadbeef"}]'), [
    { root: 'D:/a', hash: 'deadbeef', bytes: 0 },
  ])
})

test('findCacheEntry：按归一化后的路径找，找不到给 null', () => {
  const idx = [e('D:\\work\\projA')]
  assert.equal(findCacheEntry(idx, 'D:/work/projA/')?.root, 'D:\\work\\projA')
  assert.equal(findCacheEntry(idx, 'D:/work/projB'), null)
})

test('removeCacheEntry：删除扫描工程时按根目录摘条目，别的留着', () => {
  const idx = [e('D:/a'), e('D:/b'), e('D:/c')]
  // 尾斜杠 / 斜杠方向都要认得是同一条
  assert.deepEqual(cachedRootsOf(removeCacheEntry(idx, 'D:/b/')), ['D:/a', 'D:/c'])
  assert.deepEqual(cachedRootsOf(removeCacheEntry(idx, 'D:\\B')), ['D:/a', 'D:/c'])
  // 删不存在的目录：原样返回（语义上已经删过了）
  assert.deepEqual(cachedRootsOf(removeCacheEntry(idx, 'D:/missing')), ['D:/a', 'D:/b', 'D:/c'])
})
