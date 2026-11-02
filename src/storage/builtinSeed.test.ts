/**
 * 内置示例表启动同步的回归测试（bug.txt bug9 / bug10）。
 *
 * node:test 环境没有 localStorage，先装 Map 垫片——和 localStore.test.ts
 * 同一个思路；两个测试文件各自进程，垫片互不影响。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
// 纯类型，零运行时代码，放垫片前面也不碍事
import type { TableInfo } from '../types/schema'
// MemoryStore 当类型用时必须走静态 type-import（下面的动态 import 只拿值）
import type { MemoryStore as MemoryStoreT } from './memoryStore'

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
const { syncBuiltinTables } = await import('./builtinSeed')
const { MOCK_TABLES, MOCK_FOREIGN_KEYS, SEED_STAMP } = await import('./mockData')

/** 复刻 v0.3.x~v0.4.0 发出去的旧种子：同名 + 同一枚时间戳，列定义是当时的（更少） */
function legacySeed(name: string): TableInfo {
  const current = MOCK_TABLES.find((m) => m.name === name)
  return {
    name,
    comment: `${name}历史种子`,
    javaClass: name.toUpperCase(),
    source: 'sql',
    // 故意砍掉第一个字段模拟「定义比新版少」：刷新用例要能看出被盖成了新形状
    columns: current ? current.columns.slice(1) : [],
    createdAt: SEED_STAMP,
    updatedAt: SEED_STAMP,
  }
}

/**
 * 已退役的内置表全集：v0.4.0 的 7 张里刨去还在役的两张示例，再加上
 * 种子表名统一成大写 ORDER / ORDER_DETAIL 后退役的小写旧名 order / order_detail
 */
const RETIRED = ['user', 'order_item', 'product', 'role', 'user_role', 'log', 'order', 'order_detail']

/** 用户自己导入的表：时间戳是「现在」，跟种子的固定戳不同 */
async function importOwn(store: MemoryStoreT, name: string): Promise<TableInfo> {
  const now = new Date().toISOString()
  const t: TableInfo = {
    name,
    comment: '用户粘贴 DDL 导入的表',
    source: 'sql',
    columns: [
      {
        name: 'id',
        type: 'NUMBER(25)',
        nullable: false,
        isPrimaryKey: true,
        isAutoIncrement: false,
        javaField: 'id',
        javaType: 'Long',
      },
    ],
    createdAt: now,
    updatedAt: now,
  }
  await store.upsertTables([t])
  return t
}

describe('syncBuiltinTables：空库', () => {
  it('全新环境播种两张示例（此前 Tauri 首启什么都不种）', async () => {
    const s = new MemoryStore()
    await syncBuiltinTables(s)
    const names = (await s.listTables()).map((t) => t.name).sort()
    assert.deepEqual(names, ['ORDER', 'ORDER_DETAIL'])
    assert.equal((await s.listForeignKeys()).length, 1)
  })
})

describe('syncBuiltinTables：老版本残留清理（bug9 本体）', () => {
  it('历代退役种子（含小写旧名）全在时全部清掉，只留大写订单两兄弟', async () => {
    const s = new MemoryStore()
    // 旧版在役的两张同样以旧形状入场（历史上它们就是这么发出去的）
    await s.upsertTables([...RETIRED, ...MOCK_TABLES.map((m) => m.name)].map(legacySeed))
    await syncBuiltinTables(s)
    const names = (await s.listTables()).map((t) => t.name).sort()
    assert.deepEqual(names, ['ORDER', 'ORDER_DETAIL'])
  })

  it('只有小写旧种子的机器升级：清掉旧名后当场补播大写种子，不能留给空库', async () => {
    const s = new MemoryStore()
    // 装了 v0.4.0 但从没导入过大写示例：缓存里只有小写 order / order_detail
    await s.upsertTables(['order', 'order_detail'].map(legacySeed))
    await syncBuiltinTables(s)
    const names = (await s.listTables()).map((t) => t.name).sort()
    assert.deepEqual(names, ['ORDER', 'ORDER_DETAIL'])
    assert.equal((await s.listForeignKeys()).length, 1)
  })

  it('清完退役表，两端指向它们的旧外键不留悬空', async () => {
    const s = new MemoryStore()
    await s.upsertTables([...RETIRED.map(legacySeed), ...MOCK_TABLES])
    // 旧版明细表 → 订单的外键，随清理一起消失
    await s.upsertForeignKeys([
      ...MOCK_FOREIGN_KEYS,
      {
        fromTable: 'product',
        fromColumn: 'order_id',
        toTable: 'order',
        toColumn: 'id',
        confidence: 'naming',
      },
    ])
    await syncBuiltinTables(s)
    const fks = await s.listForeignKeys()
    assert.equal(fks.length, 1)
    assert.equal(fks[0].fromTable, 'ORDER_DETAIL')
  })

  it('用户自己导入的 user 表（时间戳不是种子戳）绝不被顺手删掉', async () => {
    const s = new MemoryStore()
    await s.upsertTables(MOCK_TABLES)
    const own = await importOwn(s, 'user')
    await syncBuiltinTables(s)
    const kept = await s.getTable('user')
    assert.ok(kept, '用户导入的表被误删了')
    assert.equal(kept.createdAt, own.createdAt)
  })

  it('在役示例带着种子戳但列定义是旧的 → 刷新成当前定义', async () => {
    const s = new MemoryStore()
    await s.upsertTables([legacySeed('ORDER'), legacySeed('ORDER_DETAIL')])
    await syncBuiltinTables(s)
    const order = await s.getTable('ORDER')
    assert.ok(order)
    // 旧形状是截掉首字段的，新定义必须原样还原回来
    assert.equal(order.columns[0]?.name, 'id')
    assert.equal(order.columns.length, MOCK_TABLES[0].columns.length)
  })
})

describe('syncBuiltinTables：与 bug10 删除功能配合', () => {
  it('用户删掉 ORDER_DETAIL 之后，下次启动不得复活（也不给它挂悬空外键）', async () => {
    const s = new MemoryStore()
    await syncBuiltinTables(s) // 首启播种
    await s.deleteTable('ORDER_DETAIL') // bug10 场景：用户明确不要这张
    await syncBuiltinTables(s) // 重启再同步
    assert.equal(await s.getTable('ORDER_DETAIL'), null, '删除的内置表被播种逻辑复活了')
    const fks = await s.listForeignKeys()
    assert.equal(fks.length, 0, '缺了一张表还补外键，等于挂悬空关联')
    // 还在役的另一张照常刷新，不受影响
    assert.ok(await s.getTable('ORDER'))
  })
})

describe('LocalStorageStore 上同样成立（同一段逻辑要跨实现生效）', () => {
  it('存档里的老残留经一次 init + 同步后被清掉，「刷新」后仍然干净', async () => {
    backing.clear()
    const first = new LocalStorageStore()
    await first.upsertTables([...RETIRED.map(legacySeed), ...MOCK_TABLES])
    // 模拟升级到新版后的第一次启动：读档 → 同步
    const upgraded = new LocalStorageStore()
    await upgraded.init()
    await syncBuiltinTables(upgraded)
    let names = (await upgraded.listTables()).map((t) => t.name).sort()
    assert.deepEqual(names, ['ORDER', 'ORDER_DETAIL'])

    // 再来一次「刷新」（新实例重读同一份存档），不能越清越多或死灰复燃
    const again = new LocalStorageStore()
    await again.init()
    await syncBuiltinTables(again)
    names = (await again.listTables()).map((t) => t.name).sort()
    assert.deepEqual(names, ['ORDER', 'ORDER_DETAIL'])
  })
})
