import test from 'node:test'
import assert from 'node:assert/strict'
import { apiProjectIndex, projectIdOfApi } from './scanIndex'
import type { WorkspaceScanResult } from './types'

const scanOf = (projects: { projectId: string; apis: string[] }[]): WorkspaceScanResult =>
  ({
    root: '/w',
    scannedAt: '',
    fingerprint: '',
    errors: [],
    projects: projects.map((p) => ({ projectId: p.projectId, controllers: [{ methods: p.apis.map((id) => ({ id })) }] })),
  }) as unknown as WorkspaceScanResult

test('projectIdOfApi：按接口找到所属工程，找不到或没 scan 返回 undefined', () => {
  const scan = scanOf([{ projectId: 'a', apis: ['a1', 'a2'] }, { projectId: 'b', apis: ['b1'] }])
  assert.equal(projectIdOfApi(scan, 'a2'), 'a')
  assert.equal(projectIdOfApi(scan, 'b1'), 'b')
  assert.equal(projectIdOfApi(scan, 'x'), undefined)
  assert.equal(projectIdOfApi(null, 'a1'), undefined)
})

test('apiProjectIndex：同一个 scan 只建一次，换 scan 重建', () => {
  const s1 = scanOf([{ projectId: 'a', apis: ['a1'] }])
  assert.equal(apiProjectIndex(s1), apiProjectIndex(s1))
  const s2 = scanOf([{ projectId: 'b', apis: ['a1'] }])
  assert.equal(projectIdOfApi(s2, 'a1'), 'b')
})
