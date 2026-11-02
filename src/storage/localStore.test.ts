/**
 * LocalStorageStore 的回归测试（bug.txt bug5）。
 *
 * node:test 环境没有 localStorage，先在 globalThis 上装一个 Map 垫片。
 * 「刷新」在这个测试里等价于「新建一个实例再 init」——存档在 localStorage
 * 垫片里，不在实例上，跟浏览器里刷新后重新建 store 是同一件事。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ---- localStorage 垫片：必须在 import 被测模块之前装好 ----
const backing = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => {
      backing.set(k, String(v))
    },
    removeItem: (k: string) => {
      backing.delete(k)
    },
    clear: () => backing.clear(),
  },
})

const { MemoryStore } = await import('./memoryStore')
const { LocalStorageStore } = await import('./localStore')
const { parseTemplates } = await import('./templates')
const { ADVICE_LOG_KEY } = await import('./adviceLog')
const { MOCK_TABLES } = await import('./mockData')

/** 造一张与种子不同的表，名字带序号避免用例间串扰 */
let seq = 0
function makeTable() {
  seq += 1
  const now = new Date().toISOString()
  return {
    name: `t_imported_${seq}`,
    comment: '用户导入的表',
    source: 'sql' as const,
    javaClass: `TImported${seq}`,
    columns: [
      {
        name: 'id',
        type: 'NUMBER(25)',
        nullable: false,
        isPrimaryKey: true,
        isAutoIncrement: false,
        comment: '主键',
        javaField: 'id',
        javaType: 'Long',
      },
    ],
    createdAt: now,
    updatedAt: now,
  }
}

describe('LocalStorageStore：导入的数据刷新后还在（bug5）', () => {
  it('导入的表和外键，新实例（= 刷新）init 后原样读回', async () => {
    const first = new LocalStorageStore()
    await first.init()
    const imported = makeTable()
    await first.upsertTables([imported])
    await first.upsertForeignKeys([
      {
        fromTable: imported.name,
        fromColumn: 'id',
        toTable: MOCK_TABLES[0].name,
        toColumn: 'id',
        confidence: 'naming',
      },
    ])

    // 模拟刷新：全新实例 + 重新 init。这是本 bug 的核心断言，
    // MemoryStore 在这一步会只剩种子数据
    const second = new LocalStorageStore()
    await second.init()
    const tables = await second.listTables()
    assert.ok(
      tables.some((t) => t.name === imported.name),
      '导入的表刷新后丢了',
    )
    assert.ok(
      tables.some((t) => t.name === MOCK_TABLES[0].name),
      '种子数据不见了',
    )
    const fks = await second.listForeignKeys()
    assert.ok(fks.some((f) => f.fromTable === imported.name), '导入的外键刷新后丢了')

    // 第三次刷新仍然在——持久化不是「多活一次」的巧合
    const third = new LocalStorageStore()
    await third.init()
    assert.ok((await third.listTables()).some((t) => t.name === imported.name))
  })

  it('删除表连带级联外键，刷新后仍是删后的样子', async () => {
    const s = new LocalStorageStore()
    await s.init()
    const a = makeTable()
    const b = makeTable()
    await s.upsertTables([a, b])
    await s.upsertForeignKeys([
      { fromTable: b.name, fromColumn: 'id', toTable: a.name, toColumn: 'id', confidence: 'naming' },
    ])
    await s.deleteTable(a.name)

    const next = new LocalStorageStore()
    await next.init()
    const names = (await next.listTables()).map((t) => t.name)
    assert.ok(!names.includes(a.name), '删掉的表刷新后又回来了')
    // 级联删掉的悬空外键不能复活
    const fks = await next.listForeignKeys()
    assert.ok(!fks.some((f) => f.toTable === a.name), '指向被删表的关联刷新后又回来了')
  })

  it('清空缓存后表没了、模板保留；再刷新回到种子数据（与内存实现同语义）', async () => {
    const s = new LocalStorageStore()
    await s.init()
    await s.saveTemplate({
      id: 'tpl1',
      name: '我的模板',
      tags: [],
      mainTable: 'user',
      mode: 'single',
      dialect: 'mysql',
      kinds: ['insert'],
      outputKind: 'prepared',
      columns: null,
      links: [],
      withHeader: true,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    })
    await s.upsertTables([makeTable()])
    await s.clear()

    const afterClear = new LocalStorageStore()
    await afterClear.init()
    assert.equal((await afterClear.listTemplates()).length, 1, '「清空缓存」不该清模板')
    // 清空后没有存档 → 回到种子数据，和 MemoryStore 刷新后的行为一致
    assert.ok(
      (await afterClear.listTables()).some((t) => t.name === MOCK_TABLES[0].name),
      '清空缓存并刷新后应回到种子数据',
    )
  })

  /* 优化记录跟模板一个待遇：连库查询一次次跑出来的历史，清了不会自己长回来。
     浏览器模式的 blob 全在 devtools.apiforge.meta 里（memoryStore.ts:32），
     clear() 只删 devtools.cache.v1（localStore.ts:81），所以天然留得住 ——
     这条用例是钉住「以后别顺手把 blob 也清了」。 */
  it('清空缓存不清优化记录', async () => {
    const s = new LocalStorageStore()
    await s.init()
    await s.saveMetaBlob(ADVICE_LOG_KEY, '[{"id":"a1"}]')
    await s.upsertTables([makeTable()])
    await s.clear()

    const afterClear = new LocalStorageStore()
    await afterClear.init()
    assert.equal(await afterClear.getMetaBlob(ADVICE_LOG_KEY), '[{"id":"a1"}]', '「清空缓存」不该清优化记录')
  })

  it('存档损坏时按「没有存档」处理，重新播种而不是抛错', async () => {
    backing.set('devtools.cache.v1', '{这不是JSON')
    const s = new LocalStorageStore()
    // 不该抛，且回到种子
    await s.init()
    assert.ok((await s.listTables()).some((t) => t.name === MOCK_TABLES[0].name))
  })

  it('probe() 能识破「读可以写抛」的假 localStorage', () => {
    const realSet = backing.set.bind(backing)
    // 模拟隐私模式：写入静默不生效
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        ...globalThis.localStorage,
        setItem: (k: string, v: string) => {
          /* 吞掉 */
          void k
          void v
        },
      },
    })
    const s = new LocalStorageStore()
    assert.throws(() => s.probe(), Error, '写入未生效时 probe 必须抛')
    // 还原。注意必须 bind：直接传 backing.set 的话 this 会指到垫片对象上，
    // 写进的是对象的自由属性而不是 Map（这个测试自己就踩了一回）
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
        setItem: realSet,
        removeItem: (k: string) => {
          backing.delete(k)
        },
        clear: () => backing.clear(),
      },
    })
    s.probe() // 还原后写入恢复正常，不该抛
  })

  it('与 MemoryStore 共用同一批键：内存里存的模板，local 实现能读到', async () => {
    backing.clear()
    const mem = new MemoryStore()
    await mem.saveTemplate({
      id: 'tpl2',
      name: '内存侧模板',
      tags: [],
      mainTable: 'user',
      mode: 'single',
      dialect: 'mysql',
      kinds: ['select'],
      outputKind: 'prepared',
      columns: null,
      links: [],
      withHeader: true,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    })
    const local = new LocalStorageStore()
    const list = await local.listTemplates()
    assert.equal(list.length, 1)
    assert.equal(list[0].name, '内存侧模板')
    // 键一致性的直接证据：raw JSON 用 templates 自己的解析器也能解出来
    assert.equal(parseTemplates(backing.get('devtools.templates') ?? null)?.length, 1)
  })

  it('配置草稿刷新后还在，且和表存档是两个键', async () => {
    backing.clear()
    const first = new LocalStorageStore()
    await first.init()
    await first.saveConfigDraft('application.yml|dev', 'server:\n  port: 8080')

    // 草稿在独立键上：删掉表存档模拟「存档坏了」，草稿必须还活着
    assert.ok(backing.has('devtools.config.v1'), '草稿该有自己独立的 localStorage 键')
    backing.delete('devtools.cache.v1')

    const second = new LocalStorageStore()
    await second.init()
    const drafts = await second.getConfigDrafts()
    assert.equal(drafts['application.yml|dev'], 'server:\n  port: 8080', '草稿刷新后丢了')
    // 表那边则按「没有存档」回种子——两条持久化互不拖累
    assert.ok((await second.listTables()).some((t) => t.name === MOCK_TABLES[0].name))
  })

  it('「清空缓存」清掉导入的表但保留配置草稿（PRD 5.6：草稿没法重新导入）', async () => {
    backing.clear()
    const s = new LocalStorageStore()
    await s.init()
    await s.saveConfigDraft('logback.xml|dev', '<configuration/>')
    await s.upsertTables([makeTable()])

    await s.clear()

    // 同一个实例内就能看到：clear 只动表，不动草稿
    const draftsAfterClear = await s.getConfigDrafts()
    assert.equal(draftsAfterClear['logback.xml|dev'], '<configuration/>', '清空缓存不该动草稿')
    assert.equal(
      (await s.listTables()).filter((t) => t.source === 'sql').length,
      0,
      '导入的表要被清掉',
    )

    // 刷新后依然如此
    const next = new LocalStorageStore()
    await next.init()
    assert.equal(
      (await next.getConfigDrafts())['logback.xml|dev'],
      '<configuration/>',
      '清空缓存 + 刷新后草稿还在',
    )
  })
})
