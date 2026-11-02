/**
 * JOIN 行的 id。只用来做 React key 和定位改哪一行，不需要跨会话稳定。
 * 单独成文件是因为 JoinEditor 是组件文件、再导出工厂函数会让 fast refresh 失效；
 * MultiSqlPage 套用模板时也要造行——两边共用这一个计数器才不会撞出重复 id。
 */
let seq = 0

export const newJoinId = () => `j${++seq}`
