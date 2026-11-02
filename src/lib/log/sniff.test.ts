import test from 'node:test'
import assert from 'node:assert/strict'
import { compilePattern, parseLineWith } from './pattern'
import { betterPattern, matchRate, sniffPattern } from './sniff'

test('方括号全包带行号的格式（ruoyi service 日志）：识别成对应 pattern，命中近满', () => {
  const lines = [
    '[2026-09-30 00:38:02.310]WARN  [ConsumeMessageThread_8][c.r.s.b.shop.message.OrderPaidMessageHandler:46] ->  订单支付结算消息:MessageEntity [msgKey=1, tenantId=1001]',
    '[2026-09-30 00:38:11.206]ERROR [ConsumeMessageThread_7][c.r.s.b.shop.message.X:9] ->  失败',
    '[2026-09-30 00:38:20.001]INFO  [main][c.r.s.b.shop.message.Boot:20] ->  起来了',
  ]
  const s = sniffPattern(lines)
  assert.ok(s, '应该识别出 pattern')
  assert.ok(s!.rate > 0.99, `命中率应近满，实际 ${s!.rate}`)
  const p = compilePattern(s!.pattern)
  if ('error' in p) throw new Error(`识别出的 pattern 编不过：${p.error}`)
  const h = parseLineWith(lines[0]!, p)
  assert.equal(h?.level, 'WARN')
  assert.equal(h?.thread, 'ConsumeMessageThread_8')
  assert.equal(h?.logger, 'c.r.s.b.shop.message.OrderPaidMessageHandler')
})

test('方括号紧贴 ->（ruoyi RollingFileAppender 的真实格式，logback.xml 里贴来的）：独立候选命中', () => {
  const lines = [
    '[2026-10-02 11:57:00.123]WARN [ConsumeMessageThread_8][c.r.s.b.shop.message.H:46]-> 订单支付结算消息:MessageEntity [msgKey=1, tenantId=1001]',
    '[2026-10-02 11:57:09.206]ERROR [ConsumeMessageThread_7][c.r.s.b.shop.message.X:9]-> 失败',
  ]
  const s = sniffPattern(lines)
  assert.ok(s, '应该识别出 pattern')
  assert.equal(s!.label, '方括号全包带行号（->紧贴）')
  const p = compilePattern(s!.pattern)
  if ('error' in p) throw new Error(`识别出的 pattern 编不过：${p.error}`)
  const h = parseLineWith(lines[0]!, p)
  assert.equal(h?.level, 'WARN')
  assert.equal(h?.thread, 'ConsumeMessageThread_8')
  assert.equal(h?.logger, 'c.r.s.b.shop.message.H')
})

test('标准 logback 仍识别成标准 pattern；matchRate 与 sniff 一致', () => {
  const lines = [
    '2026-10-01 12:34:56.789 [http-nio-8080-exec-3] INFO  com.chuju.PurchaseService - 查询成功',
    '2026-10-01 12:34:57.789 [http-nio-8080-exec-3] ERROR com.chuju.PurchaseService - 保存失败',
  ]
  const s = sniffPattern(lines)
  assert.ok(s)
  assert.equal(s!.label, '标准 logback')
  assert.equal(matchRate(lines, s!.pattern) > 0.99, true)
})

test('全是垃圾行：识别给 null；betterPattern 在没对上时换识别结果、对上了不动', () => {
  const junk = ['随便什么', '没有格式的东西', '===== divider =====']
  assert.equal(sniffPattern(junk), null)
  assert.equal(matchRate(junk, '%d{HH:mm:ss} %msg%n'), 0)
  assert.equal(betterPattern(junk, '%d{HH:mm:ss} %msg%n'), null)
  const good = ['2026-10-01 12:00:00,000 [main] INFO a - 好']
  // 当前 pattern 是垃圾（命中率 0）：换成识别出来的
  assert.ok(betterPattern(good, '随便一个不匹配的 pattern')?.includes('%d'), '应该换')
  // 当前 pattern 命中过半：不动
  assert.equal(betterPattern(good, '%d{yyyy-MM-dd HH:mm:ss,SSS} [%thread] %-5level %logger - %msg%n'), null)
})

test('堆栈/SQL 占九成六的日志（真机 ruoyi 文件长相）：头行只占几个百分点也要认出、也要换上', () => {
  const head = '[2026-10-02 00:02:00.059]DEBUG [Thread-1098][com.ruoyi.sql:134]-> SELECT * from t_invoice'
  const stack = 'at com.ruoyi.cloud.biz.shop.job.AbstractJobHandler.exec(AbstractJobHandler.java:1)'
  const lines: string[] = []
  for (let i = 0; i < 40; i++) {
    lines.push(head)
    for (let j = 0; j < 26; j++) lines.push(stack)
  }
  // 头行占比 ~3.7%：拿「一半行是头行」当门槛，正确格式永远进不了门
  const s = sniffPattern(lines)
  assert.ok(s, '堆栈重也应该认出格式')
  assert.equal(s!.label, '方括号全包带行号（->紧贴）')
  // 缺省 pattern 拆不动 → 自动换上；已经换上的（同分）不折腾；空串（用户清空过）也救得回
  assert.ok(betterPattern(lines, '%d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] %-5level %logger{36} - %msg%n'), '应该自动换上')
  assert.equal(betterPattern(lines, s!.pattern), null, '已经是对的就不折腾')
  assert.ok(betterPattern(lines, ''), '空 pattern 也应该换上')
})
