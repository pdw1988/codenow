/**
 * 「表在当前连接的库不存在」的识别与话术（纯函数）。
 *
 * 关联表识别的高可信来源是 mapper XML，但 mapper 里的表未必在**测试这个连接**的
 * schema 里（表住在另一个服务/另一个用户的 schema 下是常态）。库验证引擎对每个
 * 用例、每轮前后各快照一次——一张不存在的表能把报告刷成一片 ORA-00942，而它
 * 根本不是接口的错。识别出来之后引擎跳过这张表（会话级），给一句可行动的话：
 * 取消勾选，或者连到有这张表的库。
 *
 * 各方言的「表不存在」长什么样（实测报错原文都会包一层「快照查询失败：」，
 * 这里认的是里面的方言特征）：
 *  Oracle    ORA-00942: table or view does not exist
 *  MySQL     Error 1146 (42S02) ... doesn't exist / ER_NO_SUCH_TABLE
 *  PostgreSQL 42P01 ... relation "t" does not exist（42703 是列不存在，不能算）
 *  SQLite    no such table: t
 */
export function isMissingTableError(message: string): boolean {
  return (
    /ORA-00942/i.test(message) ||
    /\b1146\b|ER_NO_SUCH_TABLE|table\s+'[^']+'\s+doesn't exist/i.test(message) ||
    /\b42P01\b|relation\s+"[^"]+"\s+does not exist/i.test(message) ||
    /no such table/i.test(message)
  )
}

/** 命中后的错误文案：说清发生了什么、引擎做了什么、用户能干什么 */
export function missingTableNote(table: string): string {
  return (
    `表 ${table} 在当前连接的库不存在，本轮起跳过它的库验证。` +
    `可在「关联表」卡取消勾选，或连到有这张表的库再跑。`
  )
}
