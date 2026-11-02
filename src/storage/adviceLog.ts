/**
 * 优化记录 blob 的存储键。
 *
 * 解析、去重、统计这些规则都在 `lib/sqladviseLog.ts`（跟 apiforge 的扫描历史一个
 * 分工：纯函数在 lib，存储位在 storage）。这里只留键本身——因为「清空缓存」要按
 * 键放行（`sqliteStore.ts` 的白名单），同 templates / favorites / dbconn 的摆法。
 *
 * 别改成 `apiforge.` 前缀：那个前缀在清空规则里是整体豁免的，套上来就白不放行了。
 */
export const ADVICE_LOG_KEY = 'sqlAdviseLog'
