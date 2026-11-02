/**
 * JSON 查看页历史记录的存储键。规则在 `lib/jsonHistory.ts`，这里只留键：
 * 「清空缓存」按键放行（`sqliteStore.ts` 的白名单），同 adviceLog.ts 的摆法。
 */
export const JSON_HISTORY_KEY = 'jsonHistory'
