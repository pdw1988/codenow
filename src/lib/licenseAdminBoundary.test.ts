import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 许可台只能活在 /__license。主应用一旦静态 import，生产包就会带上签发页。
 */
const ROOT = join(import.meta.dirname, '..', '..')

describe('许可台不进主应用入口', () => {
  it('App / 壳 / 导航都不引用 license-admin', () => {
    const files = [
      'src/App.tsx',
      'src/main.tsx',
      'src/components/AppShell.tsx',
      'src/components/shell/pages.ts',
      'src/store/useUiStore.ts',
    ]
    for (const f of files) {
      const text = readFileSync(join(ROOT, f), 'utf8')
      assert.equal(text.includes('license-admin'), false, f)
      assert.equal(text.includes('__license'), false, f)
    }
  })
})
