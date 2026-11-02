import test from 'node:test'
import assert from 'node:assert/strict'
import { compilePattern } from './pattern'
import { groupRecords } from './records'

/** 编译失败直接把错误抛进测试输出（每个测试文件自带一份，避免跨测试文件 import 被跑两遍） */
function mustCompile(pattern: string) {
  const r = compilePattern(pattern)
  if ('error' in r) throw new Error(`pattern 编译失败：${r.error}`)
  return r
}

test('开头就在堆栈中间（文件从半截开始）：落成无头记录，内容不丢', () => {
  const p = mustCompile('%d{HH:mm:ss} %-5level %logger - %msg%n')
  const rs = groupRecords(['at com.a.B.b(B.java:1)', '09:00:00 INFO x - 起来了'], p)
  assert.equal(rs.length, 2)
  assert.equal(rs[0].index, 0)
  assert.equal(rs[0].level, null)
  assert.equal(rs[0].msg, 'at com.a.B.b(B.java:1)')
  assert.equal(rs[1].index, 1)
  assert.equal(rs[1].level, 'INFO')
})

test('匹配行开新记录，不匹配的行归入上一条的 stack', () => {
  const p = mustCompile('%d{HH:mm:ss} %-5level %logger - %msg%n')
  const rs = groupRecords(
    [
      '09:00:00 ERROR c.a.Service - 保存失败',
      'java.lang.IllegalStateException: boom',
      '\tat com.a.Service.save(Service.java:10)',
      'Caused by: java.sql.SQLException: 断连',
      '\tat com.a.Dao.q(Dao.java:5)',
      '09:00:01 INFO  c.a.Service - 重试成功',
    ],
    p,
  )
  assert.equal(rs.length, 2)
  assert.equal(rs[0].level, 'ERROR')
  assert.equal(rs[0].stack.length, 4)
  assert.equal(rs[0].stack[0], 'java.lang.IllegalStateException: boom')
  assert.equal(rs[0].stack[2], 'Caused by: java.sql.SQLException: 断连')
  assert.equal(rs[1].level, 'INFO')
  assert.deepEqual(rs[1].stack, [])
})

test('pattern 为 null：每行一条，级别从行内嗅探，WARNING 归一成 WARN', () => {
  const rs = groupRecords(
    ['xx ERROR yy', '纯文本没有级别', 'zz WARNING zz', '2026-10-01 12:00:00,000 INFO ok'],
    null,
  )
  assert.equal(rs.length, 4)
  assert.equal(rs[0].level, 'ERROR')
  assert.equal(rs[1].level, null)
  assert.equal(rs[2].level, 'WARN')
  assert.equal(rs[3].level, 'INFO')
  assert.equal(rs[0].index, 0)
  assert.equal(rs[3].index, 3)
})

test('JUL 的 SEVERE / FINE 归一到 ERROR / DEBUG，FATAL 单独一档', () => {
  const rs = groupRecords(['a SEVERE b', 'e FATAL f'], null)
  assert.deepEqual(
    rs.map((r) => r.level),
    ['ERROR', 'FATAL'],
  )
  // FINE 只在 pattern 拆出的级别列里归一；纯文本嗅探不收它，普通句子里太容易撞上
  const p = mustCompile('%level - %msg%n')
  assert.equal(groupRecords(['FINE - d'], p)[0].level, 'DEBUG')
})

test('每条记录的 raw 只含首行，堆栈全在 stack 里', () => {
  const p = mustCompile('%d{HH:mm:ss} %-5level %logger - %msg%n')
  const rs = groupRecords(['09:00:00 ERROR a - 挂了', '\tat x.y(Z.java:2)'], p)
  assert.equal(rs[0].raw, '09:00:00 ERROR a - 挂了')
  assert.equal(rs[0].msg, '挂了')
  assert.deepEqual(rs[0].stack, ['\tat x.y(Z.java:2)'])
})
