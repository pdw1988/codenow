import test from 'node:test'
import assert from 'node:assert/strict'
import { normAuthor, normDocDate, whoLine } from './docmeta'

test('normDocDate：实测遇到的四种写法都归到 YYYY-MM-DD', () => {
  // 这四条是 常见的几种写法
  assert.equal(normDocDate('2025-04-09 11:14:07'), '2025-04-09')
  assert.equal(normDocDate('2025/6/12 9:01'), '2025-06-12')
  assert.equal(normDocDate('2025-12-26 17:25:30'), '2025-12-26')
  assert.equal(normDocDate('2026-08-19'), '2026-08-19')
})

test('normDocDate：补零、中文年月日、点分隔、ISO T 分隔', () => {
  assert.equal(normDocDate('2024/1/1'), '2024-01-01')
  assert.equal(normDocDate('2024年3月11日 10:22:33'), '2024-03-11')
  assert.equal(normDocDate('2024.3.11'), '2024-03-11')
  assert.equal(normDocDate('2024-03-11T10:22:33'), '2024-03-11')
})

test('normDocDate：认不出来的原样返回，不编日期', () => {
  assert.equal(normDocDate(''), '')
  assert.equal(normDocDate('  '), '')
  assert.equal(normDocDate('见 git 提交记录'), '见 git 提交记录')
  // 日/月/年歧义：猜错了比不猜更坏
  assert.equal(normDocDate('3/11/2024'), '3/11/2024')
  assert.equal(normDocDate('20250409'), '20250409')
  // 年对了但月份越界，不能归成 2024-13-01
  assert.equal(normDocDate('2024-13-01'), '2024-13-01')
  assert.equal(normDocDate('2024-00-10'), '2024-00-10')
})

test('normAuthor：去邮箱、多作者取第一个', () => {
  assert.equal(normAuthor('张三'), '张三')
  assert.equal(normAuthor('张三 <zhangsan@example.net>'), '张三')
  assert.equal(normAuthor('zhangsan@example.net'), '')
  assert.equal(normAuthor('张三, 李四'), '张三')
  assert.equal(normAuthor('张三、李四'), '张三')
  assert.equal(normAuthor('张三/李四'), '张三')
  assert.equal(normAuthor(''), '')
})

test('normAuthor：保留含空格的英文名，只折叠多余空白', () => {
  // 这种写法也见过
  assert.equal(normAuthor('Leiming Xi'), 'Leiming Xi')
  assert.equal(normAuthor('  Leiming   Xi  '), 'Leiming Xi')
  assert.equal(normAuthor('若依科技'), '若依科技')
})

test('whoLine：缺一个不拖分隔符，都缺给空串', () => {
  assert.equal(whoLine({ author: '张三', date: '2024-03-11' }), '张三·2024-03-11')
  assert.equal(whoLine({ author: '张三', date: '' }), '张三')
  assert.equal(whoLine({ author: '', date: '2024-03-11' }), '2024-03-11')
  assert.equal(whoLine({ author: '', date: '' }), '')
})
