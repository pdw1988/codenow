/**
 * 日志参数回填的回归测试，PRD 4.14。
 *
 * 这个功能的失败模式跟别处不一样：它**不会报错，只会给出错的数据**。
 * 参数错位一格，语句照样能跑，插进去的是别人的名字——比语法错误难查得多。
 * 所以这里的用例集中在两件事：
 *   1. PRD 4.14「必须处理的边界」那 6 条，每条一个用例
 *   2. 还原出来的 SQL 真的能跑，而且值真的落在对的列上（node:sqlite 真执行）
 * 只比字符串的断言只能证明「输出没变」，证明不了「填对了」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import type { GenDialect } from './dialect'
import {
  buildFilledSql,
  countPlaceholders,
  fillPlaceholders,
  inferFillDialect,
  parseLog,
  renderFilled,
  renderParam,
  type LogParam,
} from './logFill'

/** 解析 + 回填，一步到位。绝大多数用例只关心最终 SQL */
function fill(log: string, dialect: GenDialect = 'mysql') {
  const parsed = parseLog(log)
  return parsed.statements.map((s) => buildFilledSql(s, dialect))
}

/** 只有一条语句时的快捷断言入口 */
function one(log: string, dialect: GenDialect = 'mysql') {
  const all = fill(log, dialect)
  assert.equal(all.length, 1, `期望 1 条语句，实际 ${all.length} 条`)
  return all[0]
}

const param = (value: string, declaredType?: string): LogParam => ({
  raw: value,
  value,
  declaredType,
})

/* ---------- 五种日志格式 ---------- */

test('MyBatis 日志：Preparing + Parameters 还原成可执行 SQL（PRD 4.14 格式 1）', () => {
  const f = one(`
==>  Preparing: INSERT INTO user (username, age) VALUES (?, ?)
==> Parameters: 张三(String), 18(Integer)
`)
  assert.equal(f.statement.format, 'mybatis')
  assert.equal(f.sql, "INSERT INTO user (username, age) VALUES ('张三', 18);")
  assert.equal(f.error, undefined)
})

test('裸占位 + 参数行：没有类型标注也能回填（格式 2）', () => {
  const f = one(`
UPDATE user SET username = ?, age = ? WHERE id = ?
李四, 20, 1
`)
  assert.equal(f.statement.format, 'plain')
  assert.equal(f.sql, "UPDATE user SET username = '李四', age = 20 WHERE id = 1;")
})

test('p6spy：最后一段已经是填好的 SQL，不需要回填（格式 3）', () => {
  const f = one(
    '1690000000000|3|statement|connection 1|url jdbc:mysql://localhost/test|' +
      'SELECT * FROM user WHERE id = ?|SELECT * FROM user WHERE id = 42',
  )
  assert.equal(f.statement.format, 'p6spy')
  assert.equal(f.sql, 'SELECT * FROM user WHERE id = 42;')
  assert.equal(f.statement.placeholders, 0, '取到的是带 ? 的那一段，说明挑错了')
})

test('Hibernate：按 [n] 定位，不依赖参数出现的顺序（格式 4）', () => {
  /*
   * 高并发时多个 session 的日志会交错，binding 行的物理顺序靠不住。
   * 所以这里故意把 [2] 打在 [1] 前面——按顺序取就会把 18 填给 username。
   */
  const f = one(`
Hibernate: insert into user (username, age) values (?, ?)
binding parameter [2] as [INTEGER] - [18]
binding parameter [1] as [VARCHAR] - [张三]
`)
  assert.equal(f.statement.format, 'hibernate')
  assert.equal(f.sql, "insert into user (username, age) values ('张三', 18);")
})

test('Hibernate 6.x 的新写法 (1:VARCHAR) <- [值] 也认', () => {
  const f = one(`
Hibernate: select u.id from user u where u.username = ?
binding parameter (1:VARCHAR) <- [张三]
`)
  assert.equal(f.sql, "select u.id from user u where u.username = '张三';")
})

test('Druid：Parameters : [值, 值] 方括号形式（格式 5）', () => {
  const f = one(`
Preparing : INSERT INTO user (username, age) VALUES (?, ?)
Parameters : [张三, 18]
`)
  assert.equal(f.statement.format, 'druid', '方括号形式应该被认成 Druid')
  assert.equal(f.sql, "INSERT INTO user (username, age) VALUES ('张三', 18);")
})

/* ---------- PRD 4.14 的 6 条必须处理的边界 ---------- */

test('边界 1：字符串里的 ? 不是占位符', () => {
  const f = one(`
==>  Preparing: SELECT * FROM user WHERE remark = 'a?b' AND id = ?
==> Parameters: 7(Long)
`)
  assert.equal(f.sql, "SELECT * FROM user WHERE remark = 'a?b' AND id = 7;")
  assert.equal(f.statement.placeholders, 1, "'a?b' 里的问号被算成占位符了")
})

test('边界 1：注释里的 ? 也不算占位符', () => {
  const f = one(`
==>  Preparing: SELECT * FROM user -- 这里能填 ? 吗
==> Parameters:
`)
  assert.equal(f.statement.placeholders, 0)
  assert.equal(f.sql, 'SELECT * FROM user -- 这里能填 ? 吗;')
})

test('边界 2：占位符个数 ≠ 参数个数时必须报错，并且两边的个数都说出来', () => {
  const f = one(`
==>  Preparing: INSERT INTO user (username, age, city) VALUES (?, ?, ?)
==> Parameters: 张三(String), 18(Integer)
`)
  assert.ok(f.error, '个数对不上却没报错——这正是「能跑但数据是错的」的来源')
  assert.match(f.error, /3/)
  assert.match(f.error, /2/)
  // 少的那个保持裸 ?：留在那儿是语法错误，一执行就报，比悄悄补一个值安全
  assert.match(f.sql, /\?/)
})

test('边界 2：参数比占位符多也要报错，不能默默丢掉多的', () => {
  const f = one(`
==>  Preparing: INSERT INTO user (username) VALUES (?)
==> Parameters: 张三(String), 多出来的(String)
`)
  assert.ok(f.error)
  assert.match(f.error, /占位符 1 个/)
})

test('边界 3：参数值自己含逗号，靠 (类型) 锚点切分而不是 split(,)', () => {
  const f = one(`
==>  Preparing: INSERT INTO addr (city, age) VALUES (?, ?)
==> Parameters: 北京市, 朝阳区(String), 18(Integer)
`)
  assert.equal(f.params.length, 2, '按逗号硬切会切出 3 个参数')
  assert.equal(f.sql, "INSERT INTO addr (city, age) VALUES ('北京市, 朝阳区', 18);")
  assert.equal(f.error, undefined)
})

test('边界 4：参数值自己含 ?，替换进去之后不会被二次替换', () => {
  const f = one(`
==>  Preparing: INSERT INTO log (msg, level) VALUES (?, ?)
==> Parameters: 真的吗?(String), 1(Integer)
`)
  assert.equal(f.sql, "INSERT INTO log (msg, level) VALUES ('真的吗?', 1);")
  // 值里的 ? 如果被当成占位符，第二个参数就会填到它身上，level 位置留下裸 ?
  assert.doesNotMatch(f.sql, /\?\s*\)/)
})

test('边界 5：一段日志里多组语句，各出一条，顺序按原文', () => {
  const all = fill(`
==>  Preparing: INSERT INTO user (username) VALUES (?)
==> Parameters: 张三(String)
<==      Updates: 1
==>  Preparing: UPDATE user SET age = ? WHERE id = ?
==> Parameters: 18(Integer), 1(Long)
<==      Updates: 1
`)
  assert.equal(all.length, 2)
  assert.equal(all[0].sql, "INSERT INTO user (username) VALUES ('张三');")
  assert.equal(all[1].sql, 'UPDATE user SET age = 18 WHERE id = 1;')
})

test('边界 5：批量插入是一条 Preparing 跟多条 Parameters，每组都要出来', () => {
  /*
   * ExecutorType.BATCH 下 MyBatis 只打一次 SQL，参数一行一条。
   * 早先的实现配上第一条参数就把模板丢了，第二条往后**静默消失**——
   * 用户以为复现了，其实只插了一行。
   */
  const all = fill(`
==>  Preparing: INSERT INTO user (username, age) VALUES (?, ?)
==> Parameters: 张三(String), 18(Integer)
==> Parameters: 李四(String), 20(Integer)
==> Parameters: 王五(String), 22(Integer)
`)
  assert.equal(all.length, 3, '批量的后几条被丢掉了')
  assert.deepEqual(
    all.map((f) => f.sql),
    [
      "INSERT INTO user (username, age) VALUES ('张三', 18);",
      "INSERT INTO user (username, age) VALUES ('李四', 20);",
      "INSERT INTO user (username, age) VALUES ('王五', 22);",
    ],
  )
  assert.deepEqual(all.map((f) => f.error), [undefined, undefined, undefined])
})

test('边界 6：空串输出 \'\' 而不是 NULL（日志里空串和 null 是两回事）', () => {
  /*
   * MyBatis 给 null 打的是不带类型的 `null`，空串打出来是 `(String)`——
   * 前面什么都没有，类型还在。当成 NULL 的话：非空列插不进去，
   * 或者「查空串」被查成「查 NULL」——`= ''` 有结果，`= NULL` 永远没结果。
   */
  const f = one(`
==>  Preparing: INSERT INTO user (username, remark) VALUES (?, ?)
==> Parameters: 张三(String), (String)
`)
  assert.equal(f.sql, "INSERT INTO user (username, remark) VALUES ('张三', '');")
  assert.doesNotMatch(f.sql, /NULL/)
})

test('边界 6 的反面：不带类型的 null 就是 NULL，不加引号', () => {
  const f = one(`
==>  Preparing: INSERT INTO user (username, remark) VALUES (?, ?)
==> Parameters: 张三(String), null
`)
  assert.equal(f.sql, "INSERT INTO user (username, remark) VALUES ('张三', NULL);")
  assert.doesNotMatch(f.sql, /'null'/i, "NULL 被当成字符串了，插进去是 4 个字母")
})

test('null 在中间也能切出来：null, 张三(String) 是两个参数', () => {
  const f = one(`
==>  Preparing: INSERT INTO user (remark, username) VALUES (?, ?)
==> Parameters: null, 张三(String)
`)
  assert.equal(f.params.length, 2)
  assert.equal(f.sql, "INSERT INTO user (remark, username) VALUES (NULL, '张三');")
})

/* ---------- 值 → 字面量的规则表（PRD 4.14） ---------- */

test('字符串里的单引号翻倍，不然语句断在半截', () => {
  const f = one(`
==>  Preparing: INSERT INTO user (username) VALUES (?)
==> Parameters: O'Brien(String)
`)
  assert.equal(f.sql, "INSERT INTO user (username) VALUES ('O''Brien');")
})

test('数字不加引号，字符串加引号', () => {
  assert.equal(renderParam(param('18', 'Integer'), 'mysql').literal, '18')
  assert.equal(renderParam(param('9.90', 'BigDecimal'), 'mysql').literal, '9.90')
  assert.equal(renderParam(param('-3', 'Long'), 'mysql').literal, '-3')
  assert.equal(renderParam(param('张三', 'String'), 'mysql').literal, "'张三'")
  assert.equal(renderParam(param('a', 'java.lang.Character'), 'mysql').literal, "'a'")
})

test('Boolean 按方言给：MySQL/PG 是 TRUE/FALSE，Oracle 没有布尔字面量只能 1/0', () => {
  const cases: Array<[GenDialect, string, string]> = [
    ['mysql', 'TRUE', 'FALSE'],
    ['postgresql', 'TRUE', 'FALSE'],
    ['sqlite', '1', '0'],
    ['oracle', '1', '0'],
  ]
  for (const [dialect, yes, no] of cases) {
    assert.equal(renderParam(param('true', 'Boolean'), dialect).literal, yes)
    assert.equal(renderParam(param('false', 'Boolean'), dialect).literal, no)
  }
})

test('日期：只有 Oracle 要 TO_DATE，毫秒和 T 分隔要先规整掉', () => {
  const ts = param('2026-08-22T10:30:00.123', 'java.sql.Timestamp')
  assert.equal(renderParam(ts, 'mysql').literal, "'2026-08-22 10:30:00'")
  assert.equal(
    renderParam(ts, 'oracle').literal,
    "TO_DATE('2026-08-22 10:30:00', 'YYYY-MM-DD HH24:MI:SS')",
  )
  // 只有日期没时分秒时格式串要跟着变，写错会 ORA-01861
  assert.equal(
    renderParam(param('2026-08-22', 'LocalDate'), 'oracle').literal,
    "TO_DATE('2026-08-22', 'YYYY-MM-DD')",
  )
})

test('从骨架猜方言：INSERT / UPDATE / DELETE 同一套，不看动词', () => {
  assert.equal(inferFillDialect('INSERT INTO `order` (id) VALUES (?)'), 'mysql')
  assert.equal(inferFillDialect('UPDATE `order` SET status = ? WHERE id = ?'), 'mysql')
  assert.equal(inferFillDialect('DELETE FROM `order` WHERE id = ?'), 'mysql')

  assert.equal(inferFillDialect('INSERT INTO emp (dt) VALUES (NVL(?, SYSDATE))'), 'oracle')
  assert.equal(inferFillDialect('UPDATE emp SET dt = NVL(?, SYSDATE) WHERE id = ?'), 'oracle')
  assert.equal(inferFillDialect('DELETE FROM emp WHERE ROWNUM = ?'), 'oracle')

  assert.equal(inferFillDialect('INSERT INTO t (name) VALUES (?::text)'), 'postgresql')
  assert.equal(inferFillDialect('UPDATE t SET name = ? WHERE name ILIKE ?'), 'postgresql')
  assert.equal(inferFillDialect('DELETE FROM t WHERE name ILIKE ?'), 'postgresql')

  assert.equal(inferFillDialect('INSERT INTO t (id) VALUES (?)'), 'oracle')
  // 反引号只出现在字符串里：不是 MySQL 标识符
  assert.equal(inferFillDialect("INSERT INTO t (remark) VALUES ('uses `ticks`')"), 'oracle')
})

test('猜到 MySQL 后日期不加 TO_DATE：UPDATE / DELETE 跟 INSERT 一样', () => {
  const ts = '2026-08-22 10:30:00(Timestamp)'
  const guessed = (log: string) => {
    const parsed = parseLog(log)
    assert.equal(parsed.statements.length, 1)
    return buildFilledSql(parsed.statements[0], inferFillDialect(parsed.statements[0].template))
  }
  const insert = guessed(
    `==>  Preparing: INSERT INTO \`order\` (create_time) VALUES (?)\n==> Parameters: ${ts}`,
  )
  const update = guessed(
    `==>  Preparing: UPDATE \`order\` SET create_time = ? WHERE id = ?\n==> Parameters: ${ts}, 1(Long)`,
  )
  const del = guessed(
    `==>  Preparing: DELETE FROM \`order\` WHERE create_time = ?\n==> Parameters: ${ts}`,
  )
  assert.equal(insert.sql, "INSERT INTO `order` (create_time) VALUES ('2026-08-22 10:30:00');")
  assert.equal(update.sql, "UPDATE `order` SET create_time = '2026-08-22 10:30:00' WHERE id = 1;")
  assert.equal(del.sql, "DELETE FROM `order` WHERE create_time = '2026-08-22 10:30:00';")
})

test('未知类型：保守加引号并标 uncertain，让界面提示核对', () => {
  const r = renderParam(param('某个值', 'com.example.MyEnum'), 'mysql')
  assert.equal(r.literal, "'某个值'")
  assert.ok(r.uncertain, '类型没认出来却没标记，用户不知道该核对哪一行')
})

test('标着数字类型但值不是数字：加引号让它报语法错误，而不是拼出个错数据', () => {
  // 日志被截断过的话会出现这种情况。语法错误一执行就发现，静默的错数据发现不了
  assert.equal(renderParam(param('18abc', 'Integer'), 'mysql').literal, "'18abc'")
})

test('值改成 NOW() / NULL 这类关键字时不加引号（对照表里绕过引号的唯一出口）', () => {
  assert.equal(renderParam(param('NOW()', 'String'), 'mysql').literal, 'NOW()')
  assert.equal(renderParam(param('null', 'String'), 'mysql').literal, 'NULL')
  assert.equal(renderParam(param('CURRENT_TIMESTAMP', 'String'), 'mysql').literal, 'CURRENT_TIMESTAMP')
})

test('没有类型标注时按值的形状猜：数字裸写、日期按方言、其余加引号', () => {
  assert.equal(renderParam(param('18'), 'mysql').literal, '18')
  assert.equal(renderParam(param('张三'), 'mysql').literal, "'张三'")
  assert.equal(renderParam(param('2026-08-22 10:30:00'), 'mysql').literal, "'2026-08-22 10:30:00'")
  // 没标类型不算「类型没认出来」，这是格式 2 的常态，不该满屏 ⚠️
  assert.equal(renderParam(param('张三'), 'mysql').uncertain, false)
})

/* ---------- 折行、切分、识别失败 ---------- */

test('日志里被换行折断的长 SQL 能接回来', () => {
  const f = one(`
==>  Preparing: INSERT INTO user
    (username, age)
    VALUES (?, ?)
==> Parameters: 张三(String), 18(Integer)
`)
  assert.equal(f.statement.placeholders, 2)
  assert.match(f.sql, /INSERT INTO user \(username, age\) VALUES \('张三', 18\);/)
})

test('格式 2 的分隔符按「切出来的个数正好对上占位符」来定，制表符和空格都试', () => {
  const tab = one('SELECT * FROM user WHERE username = ? AND age = ?\n张三\t18')
  assert.equal(tab.sql, "SELECT * FROM user WHERE username = '张三' AND age = 18;")

  const space = one('SELECT * FROM user WHERE username = ? AND age = ?\n张三 18')
  assert.equal(space.sql, "SELECT * FROM user WHERE username = '张三' AND age = 18;")
})

test('认不出来就说认不出来，不硬凑一条', () => {
  const r = parseLog('今天天气不错，这段里没有 SQL')
  assert.deepEqual(r.statements, [])
  assert.ok(r.note)
})

test('空输入给提示，不当成错误', () => {
  const r = parseLog('   \n  ')
  assert.deepEqual(r.statements, [])
  assert.ok(r.note)
})

test('已经填好值的裸 SQL 直接收下，当零参数语句', () => {
  const f = one('SELECT * FROM user WHERE id = 42')
  assert.equal(f.statement.placeholders, 0)
  assert.equal(f.sql, 'SELECT * FROM user WHERE id = 42;')
  assert.equal(f.error, undefined)
})

test('无参语句：有 Preparing 没 Parameters 照样出来', () => {
  const f = one('==>  Preparing: SELECT 1')
  assert.equal(f.sql, 'SELECT 1;')
  assert.equal(f.error, undefined)
})

test('原文末尾的分号不会变成两个', () => {
  const f = one(`
==>  Preparing: DELETE FROM user WHERE id = ?;
==> Parameters: 1(Long)
`)
  assert.equal(f.sql, 'DELETE FROM user WHERE id = 1;')
})

test('用户在对照表里改过的值生效（overrides）', () => {
  const parsed = parseLog(`
==>  Preparing: INSERT INTO user (username, age) VALUES (?, ?)
==> Parameters: 张三(String), 18(Integer)
`)
  const st = parsed.statements[0]
  const f = buildFilledSql(st, 'mysql', [param('李四', 'String'), param('20', 'Integer')])
  assert.equal(f.sql, "INSERT INTO user (username, age) VALUES ('李四', 20);")
})

test('fillPlaceholders / countPlaceholders：块注释和双引号标识符里的 ? 都不算', () => {
  assert.equal(countPlaceholders('SELECT ? /* 这里的 ? 不算 */ FROM t WHERE a = ?'), 2)
  assert.equal(countPlaceholders('SELECT "a?b" FROM t WHERE id = ?'), 1)
  assert.equal(fillPlaceholders('a = ? AND b = ?', ["'x'", '1']), "a = 'x' AND b = 1")
  // 字面量不够时留下裸 ?，不循环用前面的值
  assert.equal(fillPlaceholders('a = ? AND b = ?', ["'x'"]), "a = 'x' AND b = ?")
})

test('renderFilled：注释头带来源和个数核对，出错的标 ❌', () => {
  const ok = renderFilled(
    fill(`
==>  Preparing: INSERT INTO user (username) VALUES (?)
==> Parameters: 张三(String)
`),
  )
  assert.match(ok, /-- 第 1 条 {2}MyBatis 日志/)
  assert.match(ok, /占位符 1 个 \/ 参数 1 个 {2}✅/)

  const bad = renderFilled(
    fill(`
==>  Preparing: INSERT INTO user (username, age) VALUES (?, ?)
==> Parameters: 张三(String)
`),
  )
  assert.match(bad, /❌/)
  assert.match(bad, /⚠️/)
})

test('renderFilled：一条都没有时给说明而不是空白', () => {
  assert.match(renderFilled([]), /还没有识别到语句/)
})

/* ---------- 真执行：能跑，而且值落在对的列上 ---------- */

test('SQLite 真执行：还原出来的 INSERT 能跑，每个值都落在对的列上', () => {
  /*
   * 这条是整个功能最该被守住的行为。前面的字符串断言只能证明「输出没变」，
   * 证明不了「填对了」——参数错位一格，语句照样能跑。
   * 所以这里真建表、真插入、再把每一列读回来逐个比。
   */
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE "user" (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      remark TEXT,
      age INTEGER,
      balance REAL,
      city TEXT,
      create_time TEXT
    )
  `)

  const [f] = fill(
    `
==>  Preparing: INSERT INTO "user" (id, username, remark, age, balance, city, create_time) VALUES (?, ?, ?, ?, ?, ?, ?)
==> Parameters: 1(Long), O'Brien(String), (String), 18(Integer), 99.9(BigDecimal), 北京市, 朝阳区(String), 2026-08-22 10:30:00(Timestamp)
`,
    'sqlite',
  )
  assert.equal(f.error, undefined, f.error)
  assert.doesNotThrow(() => db.exec(f.sql), `还原出来的 SQL 跑不起来：\n${f.sql}`)

  const row = db.prepare('SELECT * FROM "user" WHERE id = 1').get()
  // node:sqlite 返回的行是 null 原型对象，展开一层才好跟字面量比
  assert.deepEqual({ ...row }, {
    id: 1,
    username: "O'Brien",
    remark: '', // 空串，不是 null——边界 6
    age: 18,
    balance: 99.9,
    city: '北京市, 朝阳区', // 带逗号的值没被切开——边界 3
    create_time: '2026-08-22 10:30:00',
  })
  db.close()
})

test('SQLite 真执行：批量的三条各插一行，顺序和值都对', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE "user" (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, age INTEGER)')

  for (const f of fill(
    `
==>  Preparing: INSERT INTO "user" (username, age) VALUES (?, ?)
==> Parameters: 张三(String), 18(Integer)
==> Parameters: 李四(String), 20(Integer)
==> Parameters: 王五(String), 22(Integer)
`,
    'sqlite',
  )) {
    db.exec(f.sql)
  }

  const rows = db.prepare('SELECT username, age FROM "user" ORDER BY id').all()
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { username: '张三', age: 18 },
    { username: '李四', age: 20 },
    { username: '王五', age: 22 },
  ])
  db.close()
})

test('SQLite 真执行：字符串里带 ? 的 WHERE 条件，查出来的还是那一行', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE "user" (id INTEGER PRIMARY KEY, remark TEXT)')
  db.exec(`INSERT INTO "user" (id, remark) VALUES (7, 'a?b'), (8, 'other')`)

  const [f] = fill(
    `
==>  Preparing: SELECT id FROM "user" WHERE remark = 'a?b' AND id = ?
==> Parameters: 7(Long)
`,
    'sqlite',
  )
  const rows = db.prepare(f.sql.replace(/;$/, '')).all()
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ id: 7 }], '字符串里的 ? 被替换掉了，条件跟着变了')
  db.close()
})

test('SQLite 真执行：个数对不上时，已填的值不会错位到别的列上', () => {
  /*
   * 「宁可报语法错误也不要静默生成错数据」这条规则的实测。
   *
   * 注意各家客户端对留下来的裸 `?` 反应不一样：MySQL / Navicat 直接语法错误，
   * 而 SQLite 把 `?` 当成未绑定参数、绑成 NULL 照跑。所以这里不断言「一定抛异常」
   * ——那是引擎行为，靠不住。真正必须守住的是**没有错位**：
   * 少一个参数时，前面的值仍然待在自己的列上，而不是整体左移一格
   * （左移的话 age 会拿到 '张三'，city 拿到 18，语句照样能跑，数据全错）。
   */
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE "user" (username TEXT, age INTEGER, city TEXT)')

  const [f] = fill(
    `
==>  Preparing: INSERT INTO "user" (username, age, city) VALUES (?, ?, ?)
==> Parameters: 张三(String), 18(Integer)
`,
    'sqlite',
  )
  assert.ok(f.error, '个数对不上却没报错')
  assert.match(f.sql, /\?/, '缺的那个位置应该留着裸 ?，让人一眼看见')

  db.exec(f.sql)
  const row = db.prepare('SELECT * FROM "user"').get()
  assert.deepEqual({ ...row }, { username: '张三', age: 18, city: null }, '值发生了错位')
  db.close()
})

/* ---------- 日志头不能进参数（bug.txt bug1） ---------- */

/*
 * 用户真实粘进来的日志：logback 的 pattern 前缀 + MyBatis 那一截，两截连在同一行。
 *   [2026-08-20 06:36:13.081]DEBUG [asyncTaskExecutor-1][c.a…Mapper.insert:159]-> ==> Parameters: …
 * 他报的是「把日志头也进参数了」：第 1 个参数变成了这一整截前缀，
 * 第一列于是插进去一段日志文本——而且**语句照样能跑**，属于最难查的那类错。
 * 下面每条对应一种真实出现过的行形态，全部要求「参数干净 + 个数对上」。
 */
const HEAD =
  '[2026-08-20 06:36:13.080]DEBUG [asyncTaskExecutor-1][c.r.s.b.a.t.dao.PurchaseInterfaceLogMapper.insert:159]-> '
const BARE_SQL = 'INSERT INTO purchase_log (order_no, city, amount) VALUES (?, ?, ?)'
const PARAM_LINE = `${HEAD}==> Parameters: CT20260820000123(String), 宁波(String), 388.00(BigDecimal)`
/** 紧跟在后面的另一条日志，跟这条语句无关 */
const NEXT_LOG =
  '[2026-08-20 06:36:13.090]DEBUG [asyncTaskExecutor-1][c.r.s.b.a.t.s.i.PayServiceImpl.searchOrder:88]-> 查询完成'

/** 日志头的碎片一个都不许出现在还原结果里 */
const LOG_DIRT = ['DEBUG', 'asyncTaskExecutor', 'Mapper.insert', 'Parameters', '==>', '06:36:13.0']

function assertClean(f: ReturnType<typeof one>): void {
  for (const dirt of LOG_DIRT) {
    assert.ok(!f.sql.includes(dirt), `还原出来的 SQL 里混进了日志头的「${dirt}」：${f.sql}`)
  }
}

test('SQL 行丢了 Preparing: 时，参数行的日志头不能变成第 1 个参数', () => {
  // 人工从日志里挑行时最常见的形态：SQL 那行被复制成裸语句，参数那行还带着完整前缀
  const f = one(`${BARE_SQL}\n${PARAM_LINE}`)
  assert.equal(f.params.length, 3, `日志头被当成参数切进来了：${JSON.stringify(f.params.map((p) => p.value))}`)
  assert.equal(f.params[0].value, 'CT20260820000123')
  assert.equal(f.error, undefined)
  assertClean(f)
})

test('SQL 行带日志头但没有 Preparing: 时，头要从模板里摘掉', () => {
  const f = one(`${HEAD}==>  ${BARE_SQL}\n${PARAM_LINE}`)
  assert.match(f.sql, /^INSERT INTO purchase_log/, `模板前面还挂着日志头：${f.sql}`)
  assert.equal(f.params.length, 3)
  assert.equal(f.error, undefined)
  assertClean(f)
})

test('参数行后面紧跟一条无关日志时，它不算参数', () => {
  /*
   * 参数行会被折断（见下一条），所以后续行要往上接。
   * 但接的条件必须是「这行不是一条新日志记录」——否则下一条 DEBUG 记录会被接成第 4 个参数，
   * 个数从 3 变 4，报「对不上」，而用户明明只粘了一条语句。
   */
  const f = one(`${HEAD}==>  Preparing: ${BARE_SQL}\n${PARAM_LINE}\n${NEXT_LOG}`)
  assert.equal(f.params.length, 3, `后面那条无关日志被接成参数了：${JSON.stringify(f.params.at(-1)?.value)}`)
  assert.equal(f.error, undefined)
  assertClean(f)
})

test('参数行被折断时后续行仍要接回来（跟上一条是同一个判断的两面）', () => {
  const f = one(`${HEAD}==>  Preparing: ${BARE_SQL}\n${HEAD}==> Parameters: CT20260820000123(String), 宁\n波(String), 388.00(BigDecimal)`)
  assert.equal(f.params.length, 3, '折断的下半截没接回来')
  assert.equal(f.params[1].value.replace(/\s+/g, ''), '宁波')
  assert.equal(f.error, undefined)
})

test('参数值里带 (Ningbo) 这种括号，不能被当成类型锚点切开', () => {
  /*
   * 边界 3 的加强版：切分靠 `(类型)` 锚点，而店名里正好有个括号。
   * 把 `(Ningbo)` 当锚点的话这一个值会被切成两三个参数，后面全部错位。
   * 所以锚点要求括号里的词是认识的类型名、且后面紧跟逗号或行尾。
   */
  const f = one(`
==>  Preparing: INSERT INTO store (name, city) VALUES (?, ?)
==> Parameters: Acme Store (Ningbo)(String), 宁波(String)
`)
  assert.equal(f.params.length, 2, `切成了 ${f.params.length} 个：${JSON.stringify(f.params.map((p) => p.value))}`)
  assert.equal(f.params[0].value, 'Acme Store (Ningbo)')
  assert.equal(f.sql, "INSERT INTO store (name, city) VALUES ('Acme Store (Ningbo)', '宁波');")
})

test('参数行第一个值本身就是时间戳时，不能把整行当日志丢掉', () => {
  /*
   * 「这行是日志记录」的判据必须同时要求时间戳**和**日志标记（级别/类名:行号/==>）。
   * 只看时间戳的话，格式 2 手工贴的参数行 `2026-08-20 06:36:13, 张三`
   * 会被整行当噪音删掉——参数全没了，比留着脏东西更糟。
   */
  const f = one('select * from t where dt = ? and name = ?\n2026-08-20 06:36:13, 张三')
  assert.equal(f.params.length, 2, `参数行被当成日志丢掉了：${JSON.stringify(f.params.map((p) => p.value))}`)
  assert.equal(f.params[0].value, '2026-08-20 06:36:13')
  assert.equal(f.params[1].value, '张三')
})

test('SQLite 真执行：带日志头的那条 INSERT，每个值都落在对的列上', () => {
  /*
   * 只断言「SQL 里没有 DEBUG 字样」还不够——日志头也可能整体错位一格，
   * 每个值单独看都干净，插进去却全错了。所以真插一行，逐列对。
   */
  const db = new DatabaseSync(':memory:')
  db.exec(
    'CREATE TABLE purchase_log (order_no TEXT, store_name TEXT, city TEXT, amount REAL, create_time TEXT, err_msg TEXT)',
  )

  const [f] = fill(
    `${HEAD}==>  Preparing: INSERT INTO purchase_log (order_no, store_name, city, amount, create_time, err_msg) VALUES (?, ?, ?, ?, ?, ?)
${HEAD}==> Parameters: CT20260820000123(String), Acme Store (Ningbo)(String), 宁波(String), 388.00(BigDecimal), 2026-08-20 06:36:13.081(Timestamp), null
${NEXT_LOG}`,
    'sqlite',
  )
  assert.equal(f.error, undefined, f.error)

  db.exec(f.sql)
  const row = db.prepare('SELECT * FROM purchase_log').get()
  assert.deepEqual(
    { ...row },
    {
      order_no: 'CT20260820000123',
      store_name: 'Acme Store (Ningbo)',
      city: '宁波',
      amount: 388,
      // 毫秒被规整掉是既有行为（见上面「毫秒和 T 分隔要先规整掉」那条）
      create_time: '2026-08-20 06:36:13',
      err_msg: null,
    },
  )
  db.close()
})
