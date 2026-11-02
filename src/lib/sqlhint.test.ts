/**
 * sqlhint 回归。钉的是会踩坑的语义：字符串里的点号不当限定符、别名在点号后面
 * 也能解析、`from t ` 后面不该再出表名、替换起点必须保住 `别名.`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { maskLiterals, sqlHintAt, sqlNames } from './sqlhint'

const COLS: Record<string, string[]> = {
  brand: ['id', 'brand_name', 'owner_id'],
  sku: ['id', 'brand_id', 'sku_code', 'price'],
}

const opts = {
  tableNames: ['brand', 'sku', 'order_info'],
  colsOf: (t: string) => COLS[t.toLowerCase()] ?? [],
}

/** 光标在文尾时给提示 */
const atEnd = (text: string) => sqlHintAt(text, text.length, opts)

test('maskLiterals 等长抹除：字符串、行注释、块注释', () => {
  const sql = "select 'a.b', x -- c.d\n/* e.f */ from t"
  const masked = maskLiterals(sql)
  assert.equal(masked.length, sql.length)
  assert.ok(!masked.includes("'"))
  assert.ok(!masked.includes('.b'))
  assert.ok(!masked.includes('c.d'))
  assert.ok(!masked.includes('e.f'))
  assert.ok(masked.includes('from t'))
  assert.equal(masked.split('\n').length, sql.split('\n').length)
})

test('maskLiterals：转义引号不提前闭合', () => {
  const masked = maskLiterals("where a = 'it''s x.y'")
  assert.ok(!masked.includes('x.y'))
  assert.ok(masked.includes('where'))
})

test('sqlNames：别名、as 别名、关键字不当别名、表名自引用', () => {
  const { tables, aliasToTable } = sqlNames(
    'select * from brand b join sku as s on b.id = s.brand_id where b.owner_id = 1',
  )
  assert.deepEqual(tables, ['brand', 'sku'])
  assert.equal(aliasToTable.get('b'), 'brand')
  assert.equal(aliasToTable.get('s'), 'sku')
})

test('sqlNames：`from t where` 的 where 不进别名表', () => {
  const { tables, aliasToTable } = sqlNames('select * from brand where id = 1')
  assert.deepEqual(tables, ['brand'])
  assert.ok(!aliasToTable.has('where'))
  assert.equal(aliasToTable.get('brand'), 'brand')
})

test('sqlNames：字符串里的 from 不算表', () => {
  const { tables } = sqlNames("select 'from ghost' from brand")
  assert.deepEqual(tables, ['brand'])
})

test('别名点号：`select a. from brand a` 列出全列，替换起点在点号后', () => {
  const sql = 'select a. from brand a'
  const hint = sqlHintAt(sql, 9, opts) // 光标在 `a.` 后
  assert.ok(hint)
  assert.equal(hint.kind, 'column')
  assert.deepEqual(hint.items, ['id', 'brand_name', 'owner_id'])
  assert.equal(hint.from, 9)
})

test('别名点号：别名定义在光标之后也能解析', () => {
  const sql = 'select a. from brand a'
  const hint = sqlHintAt(sql, 9, opts)
  assert.ok(hint)
  // 上面光标后的文本里才有 `from brand a`，全表扫描兜住了
  assert.equal(hint.items.length, 3)
})

test('别名点号：带前缀只出匹配项，from 指向前缀起点', () => {
  const sql = 'select * from brand b where b.br'
  const hint = sqlHintAt(sql, sql.length, opts)
  assert.ok(hint)
  assert.equal(hint.kind, 'column')
  assert.deepEqual(hint.items, ['brand_name'])
  assert.equal(hint.from, sql.length - 2)
})

test('表名点号（无别名）：`select brand.|`', () => {
  const hint = sqlHintAt('select brand. from brand', 13, opts)
  assert.ok(hint)
  assert.equal(hint.kind, 'column')
  assert.equal(hint.items.length, 3)
})

test('未知限定符不出提示', () => {
  assert.equal(sqlHintAt('select x. from brand', 9, opts), null)
})

test('FROM 空格后出表名', () => {
  const hint = atEnd('select * from ')
  assert.ok(hint)
  assert.equal(hint.kind, 'table')
  assert.deepEqual(hint.items, ['brand', 'sku', 'order_info'])
  assert.equal(hint.from, 'select * from '.length)
})

test('FROM 后打字过滤表名', () => {
  const hint = atEnd('select * from ord')
  assert.ok(hint)
  assert.deepEqual(hint.items, ['order_info'])
})

test('`from (` 子查询开头不出表名', () => {
  assert.equal(atEnd('select * from ('), null)
})

test('ORDER BY / GROUP BY / WHERE 空格后不再出列（用户拍板：只有 t. 点号出列）', () => {
  for (const tail of ['order by ', 'group by ', 'where ', 'select ', 'and ']) {
    assert.equal(atEnd(`select * from brand ${tail}`), null, tail)
  }
})

test('SELECT 列位裸打前缀不再出列：`select br| from brand`', () => {
  assert.equal(sqlHintAt('select br from brand', 9, opts), null)
})

test('多表 JOIN 里 `select |` 也不出（要列请打 `别名.`）', () => {
  assert.equal(sqlHintAt('select  from brand join sku on brand.id = sku.brand_id', 7, opts), null)
})

test('逗号后不再出列：`select brand.id, |`', () => {
  assert.equal(sqlHintAt('select brand.id, from brand', 17, opts), null)
})

test('点号场景无前缀匹配时退回包含匹配：`b.wn` → owner_id', () => {
  const hint = sqlHintAt('select b.wn from brand b', 11, opts)
  assert.ok(hint)
  assert.deepEqual(hint.items, ['owner_id'])
})

test('字符串里不出提示', () => {
  assert.equal(atEnd("select * from brand where brand_name = 'x."), null)
  assert.equal(atEnd("select 'a."), null)
})

test('注释里不出提示', () => {
  assert.equal(atEnd('select 1 -- brand.'), null)
})

test('没写表之前不出列提示', () => {
  assert.equal(atEnd('select '), null)
})

test('一个都没有就不出', () => {
  assert.equal(sqlHintAt('select brand.zzz from brand', 16, opts), null)
})

test('换行后的 `b.` 照样出列', () => {
  const sql = 'select * from brand b\nwhere b.'
  const hint = atEnd(sql)
  assert.ok(hint)
  assert.equal(hint.kind, 'column')
})
