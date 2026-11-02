/* 原型用的表结构种子数据，抄自 src/storage/mockData.ts。

   为什么单独一份而不是每页内联：速查、SQL 生成、导入三个页面展示的是同一批表，
   各写一份必然会漂 —— 评审时看到 order 在这页有 6 个字段、那页 7 个，
   讨论就从「样式好不好」跑到「到底哪个是对的」上去了。 */
window.DATA = (() => {
  // 简写：n=字段名 t=类型 j=Java 类型 c=注释 pk=主键 ai=自增 nn=非空 d=默认值
  const T = (name, comment, javaClass, columns) => ({ name, comment, javaClass, columns })

  const tables = [
    T('user', '用户表', 'User', [
      { n: 'id', t: 'BIGINT', j: 'Long', c: '主键', pk: 1, ai: 1, nn: 1 },
      { n: 'username', t: 'VARCHAR(50)', j: 'String', c: '用户名', nn: 1 },
      { n: 'password', t: 'VARCHAR(100)', j: 'String', c: '密码(加密)', nn: 1 },
      { n: 'email', t: 'VARCHAR(100)', j: 'String', c: '邮箱' },
      { n: 'status', t: 'TINYINT', j: 'Integer', c: '状态 1正常 0禁用', nn: 1, d: '1' },
      { n: 'create_time', t: 'DATETIME', j: 'LocalDateTime', c: '创建时间', nn: 1, d: 'CURRENT_TIMESTAMP' },
    ]),
    T('order', '订单表', 'Order', [
      { n: 'id', t: 'BIGINT', j: 'Long', c: '主键', pk: 1, ai: 1, nn: 1 },
      { n: 'user_id', t: 'BIGINT', j: 'Long', c: '下单用户', nn: 1 },
      { n: 'order_no', t: 'VARCHAR(32)', j: 'String', c: '订单号', nn: 1 },
      { n: 'total', t: 'DECIMAL(12,2)', j: 'BigDecimal', c: '订单金额', nn: 1, d: '0.00' },
      { n: 'status', t: 'TINYINT', j: 'Integer', c: '状态 0待付 1已付 2已发货 3完成', nn: 1, d: '0' },
      { n: 'create_time', t: 'DATETIME', j: 'LocalDateTime', c: '下单时间', nn: 1, d: 'CURRENT_TIMESTAMP' },
    ]),
    T('order_item', '订单明细表', 'OrderItem', [
      { n: 'id', t: 'BIGINT', j: 'Long', c: '主键', pk: 1, ai: 1, nn: 1 },
      { n: 'order_id', t: 'BIGINT', j: 'Long', c: '所属订单', nn: 1 },
      { n: 'product_id', t: 'BIGINT', j: 'Long', c: '商品', nn: 1 },
      { n: 'quantity', t: 'INT', j: 'Integer', c: '数量', nn: 1, d: '1' },
      { n: 'price', t: 'DECIMAL(12,2)', j: 'BigDecimal', c: '成交单价', nn: 1 },
    ]),
    T('product', '商品表', 'Product', [
      { n: 'id', t: 'BIGINT', j: 'Long', c: '主键', pk: 1, ai: 1, nn: 1 },
      { n: 'name', t: 'VARCHAR(120)', j: 'String', c: '商品名称', nn: 1 },
      { n: 'price', t: 'DECIMAL(12,2)', j: 'BigDecimal', c: '售价', nn: 1 },
      { n: 'stock', t: 'INT', j: 'Integer', c: '库存', nn: 1, d: '0' },
      { n: 'on_sale', t: 'TINYINT(1)', j: 'Boolean', c: '是否上架', nn: 1, d: '1' },
      { n: 'create_time', t: 'DATETIME', j: 'LocalDateTime', c: '上架时间', nn: 1, d: 'CURRENT_TIMESTAMP' },
    ]),
    T('role', '角色表', 'Role', [
      { n: 'id', t: 'BIGINT', j: 'Long', c: '主键', pk: 1, ai: 1, nn: 1 },
      { n: 'code', t: 'VARCHAR(40)', j: 'String', c: '角色编码', nn: 1 },
      { n: 'name', t: 'VARCHAR(40)', j: 'String', c: '角色名称', nn: 1 },
    ]),
    T('user_role', '用户角色关联表', 'UserRole', [
      { n: 'user_id', t: 'BIGINT', j: 'Long', c: '用户', pk: 1, nn: 1 },
      { n: 'role_id', t: 'BIGINT', j: 'Long', c: '角色', pk: 1, nn: 1 },
    ]),
    T('log', '操作日志表', 'Log', [
      { n: 'id', t: 'BIGINT', j: 'Long', c: '主键', pk: 1, ai: 1, nn: 1 },
      { n: 'user_id', t: 'BIGINT', j: 'Long', c: '操作人' },
      { n: 'action', t: 'VARCHAR(60)', j: 'String', c: '操作类型', nn: 1 },
      { n: 'detail', t: 'VARCHAR(500)', j: 'String', c: '详情' },
      { n: 'create_time', t: 'DATETIME', j: 'LocalDateTime', c: '操作时间', nn: 1, d: 'CURRENT_TIMESTAMP' },
    ]),
  ]

  /* 两级可信度是全项目的核心概念（CLAUDE.md）：真约束绿色默认勾，
     命名推断橙色默认不勾 —— 推断可能是错的，默认参与 JOIN 等于悄悄生成错 SQL。 */
  const fks = [
    { name: 'fk_order_user', from: 'order', fromCol: 'user_id', to: 'user', toCol: 'id', conf: 'constraint' },
    { name: 'fk_order_item_order', from: 'order_item', fromCol: 'order_id', to: 'order', toCol: 'id', conf: 'constraint' },
    { name: 'fk_order_item_product', from: 'order_item', fromCol: 'product_id', to: 'product', toCol: 'id', conf: 'constraint' },
    { name: '', from: 'log', fromCol: 'user_id', to: 'user', toCol: 'id', conf: 'naming' },
    { name: '', from: 'user_role', fromCol: 'user_id', to: 'user', toCol: 'id', conf: 'naming' },
    { name: '', from: 'user_role', fromCol: 'role_id', to: 'role', toCol: 'id', conf: 'naming' },
  ]

  const src = { user: 'sql', order: 'sql', order_item: 'sql', product: 'db', role: 'db', user_role: 'db', log: 'project' }
  const SRC_LABEL = { sql: 'DDL 导入', db: '数据库读取', project: '源码扫描' }

  const byName = Object.fromEntries(tables.map(t => [t.name, t]))
  const fksOf = name => fks.filter(f => f.from === name || f.to === name)

  /* 方言差异只准写在一处（CLAUDE.md：DialectSpec）。原型里同样只留这一张表，
     页面里不准出现 dialect === 'oracle' ? … : …

     键的顺序就是所有页面上方言的显示顺序：Oracle → MySQL → PG
     （跟 src/lib/sqlgen/dialect.ts 的 DIALECT_OPTIONS 一致）。
     手写文案里列举方言时也按这个顺序 —— 同一个工具在两页上给出两种顺序，
     用户会以为是两套不同的支持范围。 */
  const DIALECTS = {
    oracle: {
      label: 'Oracle', q: s => `"${s}"`, bool: v => (v ? '1' : '0'),
      date: s => `TO_DATE('${s}','YYYY-MM-DD HH24:MI:SS')`, now: 'SYSDATE',
      page: n => `FETCH FIRST ${n} ROWS ONLY`,
    },
    mysql: {
      label: 'MySQL', q: s => `\`${s}\``, bool: v => (v ? 'TRUE' : 'FALSE'),
      date: s => `'${s}'`, now: 'NOW()', page: n => `LIMIT ${n}`,
    },
    postgresql: {
      label: 'PG', q: s => `"${s}"`, bool: v => (v ? 'TRUE' : 'FALSE'),
      date: s => `'${s}'`, now: 'CURRENT_TIMESTAMP', page: n => `LIMIT ${n}`,
    },
  }

  /* 我的连接种子。两页共用（管理页 + 连库查询未连接态），各写一份地址会对不上。
     密码故意不在这里——原型也不演示落盘。 */
  const conns = [
    { id: 1, name: '生产只读', kind: 'mysql', env: 'prod', host: 'rm-bp18x.mysql.rds.aliyuncs.com', port: '3306', user: 'ro_reader', db: 'mall_prod', remark: '只读账号，别拿去改数' },
    { id: 2, name: '测试 ORCL · SCOTT', kind: 'oracle', env: 'test', host: '10.0.1.8', port: '1521', user: 'SCOTT', db: 'ORCL', remark: '11g，本机要 Instant Client' },
    { id: 3, name: '开发 PDB', kind: 'oracle', env: 'test', host: '192.168.10.20', port: '1521', user: 'DEV_RUOYI', db: 'ORCLPDB1', remark: '' },
    { id: 4, name: '本地 MySQL', kind: 'mysql', env: 'local', host: 'localhost', port: '3306', user: 'root', db: 'mall', remark: '本机 Docker' },
  ]
  const CONN_ENV = {
    prod: { label: '生产', tone: 'wr' },
    test: { label: '测试', tone: 'hi' },
    local: { label: '本地', tone: 'ok' },
  }
  const CONN_KIND = { oracle: 'Oracle', mysql: 'MySQL' }

  return { tables, fks, src, SRC_LABEL, byName, fksOf, DIALECTS, conns, CONN_ENV, CONN_KIND }
})()
