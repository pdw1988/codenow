import test from 'node:test'
import assert from 'node:assert/strict'
import { HISTORY_MAX, historyCardName, mergeHistory, removeHistoryEntry, type ScanHistoryEntry } from './history'
import type { WorkspaceScanResult } from '../types'

/** 最小可用扫描结果：只带 mergeHistory 用得到的字段 */
function ws(root: string, scannedAt: string, projects: [string, number, number][]): WorkspaceScanResult {
  return {
    root,
    scannedAt,
    fingerprint: '',
    projects: projects.map(([name, controllers, apis]) => ({
      projectId: `E:/work/${name}`,
      projectPath: `E:/work/${name}`,
      projectName: name,
      fingerprint: 'ff',
      controllers: Array.from({ length: controllers }, (_, i) => ({
        className: `C${i}`,
        packageName: 'demo',
        basePath: '/api',
        filePath: 'x',
        // 接口总数拆不均匀没关系，只要方法和等于 apis：最后一个装余数
        methods: Array.from({ length: i === controllers - 1 ? apis - controllers + 1 : 1 }),
      })),
      mappers: [],
      classUses: [],
      errors: [],
    })),
    errors: [],
  } as unknown as WorkspaceScanResult
}

test('历史：新扫描排最前，各工程记 Controller/接口计数', () => {
  const merged = mergeHistory([], ws('E:/work', '2026-09-05T10:00:00Z', [['demo-a', 2, 5], ['demo-b', 1, 3]]))
  assert.equal(merged.length, 1)
  assert.equal(merged[0].root, 'E:/work')
  assert.deepEqual(merged[0].projects, [
    { name: 'demo-a', controllers: 2, apis: 5 },
    { name: 'demo-b', controllers: 1, apis: 3 },
  ])
})

test('历史：同根目录重扫覆盖旧记录且保持原位次', () => {
  const old = [
    { root: 'E:/work', scannedAt: '2026-09-01T08:00:00Z', projects: [{ name: 'demo-a', controllers: 1, apis: 1 }] },
    { root: 'D:/svc', scannedAt: '2026-09-03T08:00:00Z', projects: [{ name: 'svc', controllers: 2, apis: 7 }] },
  ]
  const merged = mergeHistory(old, ws('E:/work', '2026-09-05T10:00:00Z', [['demo-a', 2, 5]]))
  assert.deepEqual(
    merged.map((e) => [e.root, e.scannedAt]),
    [
      ['E:/work', '2026-09-05T10:00:00Z'],
      ['D:/svc', '2026-09-03T08:00:00Z'],
    ],
  )
  assert.equal(merged[0].projects[0].apis, 5)
})

test('历史：封顶 HISTORY_MAX，最旧的被挤掉', () => {
  let list: ScanHistoryEntry[] = []
  for (let i = 0; i < HISTORY_MAX + 2; i++) {
    list = mergeHistory(list, ws(`E:/w${i}`, `2026-09-05T0${i}:00:00Z`, [['p', 1, 1]]))
  }
  assert.equal(list.length, HISTORY_MAX)
  assert.equal(list[0].root, `E:/w${HISTORY_MAX + 1}`)
  assert.ok(!list.some((e) => e.root === 'E:/w0'))
})

test('历史：卡片名照原型叫法，多工程/单工程分册', () => {
  assert.equal(
    historyCardName({ root: 'E:/work', scannedAt: '', projects: [{ name: 'a', controllers: 1, apis: 1 }, { name: 'b', controllers: 1, apis: 1 }] }),
    'work（大目录 · 多工程）',
  )
  assert.equal(
    historyCardName({ root: 'E:/work/demo-spring-boot/', scannedAt: '', projects: [{ name: 'demo-spring-boot', controllers: 3, apis: 9 }] }),
    'demo-spring-boot（单工程）',
  )
})

test('removeHistoryEntry：按根目录摘一条，尾斜杠/斜杠方向都认得', () => {
  const list: ScanHistoryEntry[] = [
    { root: 'E:/work', scannedAt: '', projects: [{ name: 'a', controllers: 1, apis: 1 }] },
    { root: 'D:/svc', scannedAt: '', projects: [{ name: 'svc', controllers: 1, apis: 1 }] },
  ]
  assert.deepEqual(removeHistoryEntry(list, 'D:/svc/').map((e) => e.root), ['E:/work'])
  assert.deepEqual(removeHistoryEntry(list, 'd:\\SVC').map((e) => e.root), ['E:/work'])
  // 删不存在的：原样返回
  assert.deepEqual(removeHistoryEntry(list, 'C:/none').map((e) => e.root), ['E:/work', 'D:/svc'])
})
