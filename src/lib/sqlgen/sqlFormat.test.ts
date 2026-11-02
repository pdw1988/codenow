/**
 * sqlFormat 的回归测试 —— bug.txt 优化条：「解析后需要对 SQL 自动格式化，
 * 参数值太长，后面的列全部看不到了」。
 *
 * 格式化器的失败模式和搜索一样是静默的：换行插错位置不报错，复制出去的 SQL
 * 却跑不起来，或者更糟——字符串字面量被从中间切开。所以每条用例都钉一个
 * 真实的失败方式，另外有一条全局不变量兜底：**去掉所有空白后必须与原文逐字符
 * 相等**（格式化只准动空白），任何一条规则将来改坏都会先撞上它。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatSql } from './sqlFormat'

const lines = (s: string) => s.split('\n')

test('单行 INSERT 拆成 INSERT 行 + VALUES 行，列清单保持一行', () => {
  const out = formatSql(`INSERT INTO purchase_order (order_no, city) VALUES ('CT01', '宁波')`)
  const ls = lines(out)
  assert.equal(ls.length, 2)
  assert.ok(ls[0].startsWith('INSERT INTO purchase_order (order_no, city)'), ls[0])
  assert.equal(ls[1], `VALUES ('CT01', '宁波')`)
})

test('超长参数元组逐参数一行，值里的逗号不被切开（本条 bug 的正主）', () => {
  const out = formatSql(
    `INSERT INTO t_user_log (id, username, city, remark, create_time, err_msg, del_flag) VALUES ` +
      `(1000000001, 'zhangsan', '北京市, 朝阳区', 'O''Brien 备注内容很长很长很长很长很长', NOW(), ` +
      `'错误信息也很长很长很长很长很长很长很长', 0)`,
  )
  // 每个参数独占一行——后面的列不再被长值顶出视野
  assert.ok(lines(out).length >= 9, `行数不够：\n${out}`)
  assert.ok(
    lines(out).some((l) => l === `  '北京市, 朝阳区',`),
    `带逗号的值被切开了？\n${out}`,
  )
  assert.ok(out.includes(`'O''Brien 备注内容很长很长很长很长很长'`), `转义引号被破坏？\n${out}`)
  assert.ok(lines(out).at(-1) === ')', out)
})

test('单赋值的短 UPDATE：SET / WHERE 各自成行，但不给赋值硬造第二行', () => {
  assert.deepEqual(lines(formatSql(`UPDATE user SET username = 'x' WHERE id = 1`)), [
    'UPDATE user',
    `SET username = 'x'`,
    'WHERE id = 1',
  ])
})

test('BETWEEN 的 AND 是它自己的语法，不当新条件折行', () => {
  assert.deepEqual(lines(formatSql(`select * from t where x between 1 and 9 and y = 2`)), [
    'select *',
    'from t',
    'where x between 1 and 9',
    '  and y = 2',
  ])
})

test('UPDATE 的 SET 每个赋值一行并与第一个对齐，WHERE 独立成行', () => {
  const out = formatSql(
    `UPDATE t_user SET username = 'zhangsan', nickname = '张三', balance = 100.50, remark = null, update_time = NOW() WHERE id = 5`,
  )
  assert.deepEqual(lines(out), [
    'UPDATE t_user',
    `SET username = 'zhangsan',`,
    `    nickname = '张三',`,
    '    balance = 100.50,',
    '    remark = null,',
    '    update_time = NOW()',
    'WHERE id = 5',
  ])
})

test('WHERE 的每个 AND/OR 一行，小写 Hibernate 风格也认得', () => {
  const out = formatSql(
    `select u.id, u.username from user u where u.username = ? and u.is_vip = true or u.age > 18 order by u.id`,
  )
  assert.deepEqual(lines(out), [
    'select u.id, u.username',
    'from user u',
    'where u.username = ?',
    '  and u.is_vip = true',
    '  or u.age > 18',
    'order by u.id',
  ])
})

test('FROM 里的 LEFT JOIN 单独成行', () => {
  const out = formatSql(`SELECT a.id FROM t_a a LEFT JOIN t_b b ON a.id = b.aid WHERE a.x = 1`)
  assert.deepEqual(lines(out), ['SELECT a.id', 'FROM t_a a', 'LEFT JOIN t_b b ON a.id = b.aid', 'WHERE a.x = 1'])
})

test("字符串里的 SET/WHERE/AND 和逗号骗不到拆行规则", () => {
  const out = formatSql(`UPDATE t SET remark = 'please SET x WHERE y AND z', city = 'a,b' WHERE id = 1`)
  // 字符串整体留在一行里，没有从内部的 SET/WHERE 处断开
  assert.ok(
    lines(out).some((l) => l.includes(`'please SET x WHERE y AND z',`)),
    out,
  )
  assert.ok(out.trimEnd().endsWith('WHERE id = 1'), out)
})

test('批量多组 VALUES 超出一行宽度的，一组一行用行尾逗号串起来', () => {
  const out = formatSql(
    `INSERT INTO order_item (order_no, sku, qty, note) VALUES ` +
      `('CT20260820000123', 'SKU-A-001-BLK-42', 2, '补货'), ('CT20260820000123', 'SKU-B-114-WHT-07', 1, '正常')`,
  )
  assert.deepEqual(lines(out), [
    'INSERT INTO order_item (order_no, sku, qty, note)',
    'VALUES',
    `  ('CT20260820000123', 'SKU-A-001-BLK-42', 2, '补货'),`,
    `  ('CT20260820000123', 'SKU-B-114-WHT-07', 1, '正常')`,
  ])
})

test('个数对不上时留下的 ? 占位符照常格式化——错误卡也要可读', () => {
  const out = formatSql(
    `UPDATE user SET username = ?, nickname = ?, balance = ?, remark = ?, update_time = ? WHERE id = ?`,
  )
  assert.equal(lines(out).filter((l) => l.includes('?')).length, 6)
  assert.equal(out.split('?').length - 1, 6)
})

test('尾分号接回最后一行末尾，不会黏在参数后面', () => {
  const out = formatSql(`DELETE FROM t_user WHERE id = 1;`)
  assert.equal(lines(out).join('|'), 'DELETE FROM t_user|WHERE id = 1;')
})

test('没有子句头的输入（DDL 等）原样返回，宁可不格式化也不瞎动', () => {
  const ddl = 'CREATE TABLE t_tmp (id NUMBER(25) not null)'
  assert.equal(formatSql(ddl), ddl)
})

test('空串和纯空白返回空串', () => {
  assert.equal(formatSql(''), '')
  assert.equal(formatSql('   \n\t '), '')
})

test('不变量：去掉所有空白后必须与原文逐字符相等（只准动空白）', () => {
  const inputs = [
    `INSERT INTO purchase_order (order_no, city, amount, remark, create_time, err_msg, del_flag) VALUES ('CT20260820000123', '宁波市, 鄞州区', 388.00, 'O''Brien 备注', NOW(), '', 0)`,
    `UPDATE t_user SET username = 'please SET x WHERE y AND z', balance = 12.5 WHERE id = 7 OR id = 8`,
    `select a, b, c from t where x = 'in, side' and y between 1 and 9`,
    `INSERT INTO i (a, b) VALUES (1, 2), (3, 4), (5, TO_DATE('2026-08-25', 'YYYY-MM-DD'))`,
  ]
  for (const s of inputs) {
    const strip = (x: string) => x.replace(/\s+/g, '')
    assert.equal(strip(formatSql(s)), strip(s), s)
  }
})

test('幂等：对已格式化的输出再跑一遍结果不变', () => {
  const samples = [
    `INSERT INTO purchase_order (order_no, city, amount, remark) VALUES ('CT20260820000123', '宁波市, 鄞州区', 388.00, 'O''Brien 备注', 0)`,
    `UPDATE t_user SET username = 'zhangsan', nickname = '张三', balance = 100.50 WHERE id = 5`,
    `select u.id, u.username from user u where u.username = ? and u.is_vip = true order by u.id`,
  ]
  for (const s of samples) assert.equal(formatSql(formatSql(s)), formatSql(s))
})
