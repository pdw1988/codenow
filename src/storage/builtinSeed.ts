/**
 * 内置示例表的启动期同步（bug.txt bug9）。
 *
 * 问题：种子不是只活在前端代码里。已经发出去的 v0.3.x / v0.4.0 把 7 张
 * 示例表（user / order / order_item / product / role / user_role / log）写进了
 * 用户的 cache.db 和 localStorage 存档，而播种只发生在「完全为空」时——
 * 新版代码再怎么改 mockData.ts，老残留也一张不会少，速查页于是混着
 * product、user_role 这些早已退役的「内置表」。
 *
 * 规则（initStore() 选定实现后跑一次，三种实现对它一视同仁）：
 *
 * 1. **空库 → 播种**当前两张示例。此前只有内存实现会播种，Tauri 全新安装
 *    是真的空；顺带把「出厂就有东西可看」的语义补齐到所有实现。
 * 2. **退役清理**：名字在退役清单里、且 createdAt === SEED_STAMP 的行，
 *    删（deleteTable 会连带清两端外键）。时间戳是关键字的一半凭证——
 *    用户后来自己导入的 `user` 表 createdAt 是导入时刻，永远不命中这条规则。
 * 3. **旧定义刷新**：现在还在役的两张表如果带着 SEED_STAMP（比如 v0.4.0
 *    种的 ORDER 列定义是旧的），用当前定义整表覆盖。逐张刷新而不是整批
 *    upsert MOCK_TABLES：用户将来用 bug10 的删除功能删掉了其中一张时，
 *    不能在下次启动把它复活回来。
 * 4. **清空补播**：退役清理删完若一张不剩，当场播当前种子——只升级过、
 *    没导入过大写示例的机器不能对着空速查页过日子。
 *
 * 失败不阻塞启动：同步坏了顶多是旧表多留一会儿，不能让工具打不开。
 */
import type { MetaStore } from './types'
import { MOCK_FOREIGN_KEYS, MOCK_TABLES, SEED_STAMP } from './mockData'

/** 曾作为内置表发出去、后来退役的表名。新退役的往这里加（连同上面的注释更新）。 */
const RETIRED_SEEDS: ReadonlySet<string> = new Set([
  'user',
  'order_item', // 明细表改名成 order_detail 之前的旧名
  'product',
  'role',
  'user_role',
  'log',
  // 种子表名统一成大写 ORDER / ORDER_DETAIL 后退役的小写旧名：不退役的话，
  // 老用户的缓存里「小写种子 + 大写示例」会一直同时挂着两张订单表
  'order',
  'order_detail',
])

export async function syncBuiltinTables(store: MetaStore): Promise<void> {
  const tables = await store.listTables()

  // ── 空库：全新环境第一次启动，播当前种子即可 ──
  if (!tables.length) {
    await store.upsertTables(MOCK_TABLES)
    await store.upsertForeignKeys(MOCK_FOREIGN_KEYS)
    return
  }

  // ── 在役种子逐张刷新（只碰带 SEED_STAMP 的行，用户导入的同名表不动）──
  const stale = tables.filter(
    (t) => MOCK_TABLES.some((m) => m.name === t.name) && t.createdAt === SEED_STAMP,
  )
  if (stale.length) {
    const refresh = MOCK_TABLES.filter((m) => stale.some((t) => t.name === m.name))
    await store.upsertTables(refresh)
    // 外键只在两张种子都刷新时补种：缺了一张还 upsert，等于给孤表挂悬空关联
    if (refresh.length === MOCK_TABLES.length) {
      await store.upsertForeignKeys(MOCK_FOREIGN_KEYS)
    }
  }

  // ── 退役种子清理（放在刷新之后无妨：两拨名字不相交）──
  let cleaned = false
  for (const t of tables) {
    if (RETIRED_SEEDS.has(t.name) && t.createdAt === SEED_STAMP) {
      await store.deleteTable(t.name)
      cleaned = true
    }
  }

  // 清理后一张不剩（老用户只有小写种子、没导入过大写示例）→ 当场播当前种子。
  // 不补这一步的话，这次启动速查页是空的，得再重启一次才见着示例。
  if (cleaned && !(await store.listTables()).length) {
    await store.upsertTables(MOCK_TABLES)
    await store.upsertForeignKeys(MOCK_FOREIGN_KEYS)
  }
}
