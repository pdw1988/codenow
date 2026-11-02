/**
 * 批量生成原先一页双模式，已拆成 BatchInsertPage / BatchUpdatePage。
 * 生成逻辑仍在 lib/sqlgen/batchGen.ts，这里只做出口，免得旧 import 断掉。
 */
export { BatchInsertPage } from './BatchInsertPage'
export { BatchUpdatePage } from './BatchUpdatePage'
