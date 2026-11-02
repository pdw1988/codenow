/**
 * 结果区在「SQL / MyBatis XML」之间切换。
 *
 * 单表页和多表页共用这一份：两处各写一遍的话，改个标签文案就要改两个地方，
 * 而且早晚会长成「这边叫 XML、那边叫 MyBatis」的两套说法。
 */
export type Output = 'sql' | 'mybatis'

export const OUT_OPTIONS = [
  { value: 'sql', label: 'SQL' },
  { value: 'mybatis', label: 'MyBatis XML' },
] as const
