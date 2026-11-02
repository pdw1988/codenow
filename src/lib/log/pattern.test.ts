import test from 'node:test'
import assert from 'node:assert/strict'
import { compilePattern, parseLineWith, parseStamp } from './pattern'

/** 编译失败直接把错误抛进测试输出，别让 undefined 往下走出一串难懂的断言 */
function mustCompile(pattern: string) {
  const r = compilePattern(pattern)
  if ('error' in r) throw new Error(`pattern 编译失败：${r.error}`)
  return r
}

test('标准 logback 组合：拆列全对，%-5level 的补位空格被吸收', () => {
  const p = mustCompile('%d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] %-5level %logger{36} - %msg%n')
  const h = parseLineWith(
    '2026-10-01 12:34:56.789 [http-nio-8080-exec-3] INFO  com.chuju.purchase.PurchaseService - 采购申请单保存成功 pk=123',
    p,
  )
  assert.equal(h?.ts, '2026-10-01 12:34:56.789')
  assert.equal(h?.thread, 'http-nio-8080-exec-3')
  assert.equal(h?.level, 'INFO')
  assert.equal(h?.logger, 'com.chuju.purchase.PurchaseService')
  assert.equal(h?.msg, '采购申请单保存成功 pk=123')
})

test('logback 缺省毫秒是逗号分隔：%d 缺省格式按 yyyy-MM-dd HH:mm:ss,SSS 解', () => {
  const p = mustCompile('%d [%p] %t %c - %m%n')
  const h = parseLineWith('2026-10-01 09:00:00,123 [WARN] main c.x.ConfigLoader - 老配置兜底', p)
  assert.equal(h?.ts, '2026-10-01 09:00:00,123')
  assert.equal(h?.level, 'WARN')
  assert.equal(h?.thread, 'main')
  assert.equal(h?.msg, '老配置兜底')
})

test('%X{traceId} 的值进 mdc，按名字取', () => {
  const p = mustCompile('%d{HH:mm:ss} %-5level %X{traceId} - %msg%n')
  const h = parseLineWith('14:03:07 ERROR T20261001143030 - 查询超时', p)
  assert.equal(h?.mdc['traceId'], 'T20261001143030')
  assert.equal(h?.level, 'ERROR')
})

test('竖线分隔 + 斜杠日期：字面量原样匹配', () => {
  const p = mustCompile('[%d{yyyy/MM/dd HH:mm:ss}][%t]%m%n')
  const h = parseLineWith('[2026/10/01 09:05:00][main]直接是消息没有前缀', p)
  assert.equal(h?.thread, 'main')
  assert.equal(h?.msg, '直接是消息没有前缀')
})

test('堆栈行不匹配 pattern：给 null（归组时并进上一条）', () => {
  const p = mustCompile('%d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] %-5level %logger - %msg%n')
  assert.equal(
    parseLineWith('at com.chuju.purchase.PurchaseService.save(PurchaseService.java:88)', p),
    null,
  )
})

test('不认识的转换器报人话 error，不硬猜', () => {
  const r1 = compilePattern('%d{MMM dd HH:mm:ss} %msg%n')
  assert.ok(!('regex' in r1) && /还不支持/.test(r1.error ?? ''), (r1 as { error?: string }).error)
  const r2 = compilePattern('%r %msg%n')
  assert.ok(!('regex' in r2) && /%r/.test(r2.error ?? ''), (r2 as { error?: string }).error)
})

test('MDC 为空（定时任务没有 traceId，打出 []）：仍是头行，不被并进上一条堆栈', () => {
  const p = mustCompile('%d{yyyy-MM-dd HH:mm:ss.SSS} [%X{traceId}] [%thread] %-5level %logger - %msg%n')
  const h = parseLineWith('2026-10-01 12:00:00.123 [] [main] INFO  a.B - 定时任务', p)
  assert.equal(h?.level, 'INFO')
  assert.equal(h?.mdc['traceId'], '')
})

test('[%thread] 里线程名带空格（undertow / RMI）：吃到右括号；定宽补位空格裁掉', () => {
  const p = mustCompile('%d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] %-5level %logger - %msg%n')
  assert.equal(parseLineWith('2026-10-01 12:00:00.123 [XNIO-1 task-2] INFO  a.B - x', p)?.thread, 'XNIO-1 task-2')
  assert.equal(
    parseLineWith('2026-10-01 12:00:00.123 [RMI TCP Connection(3)-10.0.0.1] WARN  a.B - y', p)?.thread,
    'RMI TCP Connection(3)-10.0.0.1',
  )
  const fixed = mustCompile('%d [%15.15t] %-5level %logger - %msg%n')
  assert.equal(parseLineWith('2026-10-01 12:00:00,123 [           main] INFO  a.B - z', fixed)?.thread, 'main')
})

test('%d{ISO8601}、带时区选项的 %d、%5level 右对齐紧贴字面量', () => {
  const iso = mustCompile('%d{ISO8601} %-5level %logger - %msg%n')
  assert.equal(parseLineWith('2026-10-01 12:00:00,123 INFO  a.B - x', iso)?.level, 'INFO')
  const tz = mustCompile('%d{HH:mm:ss.SSS, Asia/Shanghai} %level - %msg%n')
  assert.equal(parseLineWith('12:00:00.123 ERROR - y', tz)?.level, 'ERROR')
  const right = mustCompile('[%d]%5p - %m%n')
  assert.equal(parseLineWith('[2026-10-01 12:00:00,123] INFO - z', right)?.level, 'INFO')
})

test('Spring Boot 缺省格式：%clr 上色剥掉、${PID} 占位、\'T\' 字面量和时区偏移、%wEx 不输出', () => {
  const p = mustCompile(
    "%clr(%d{yyyy-MM-dd'T'HH:mm:ss.SSSXXX}){faint} %clr(%5p) %clr(${PID:- }){magenta} %clr(---){faint} %clr([%15.15t]){faint} %clr(%-40.40logger{39}){cyan} %clr(:){faint} %m%n%wEx",
  )
  const h = parseLineWith(
    '2026-10-01T12:00:00.123+08:00  INFO 12345 --- [           main] c.a.DemoApplication                      : Started',
    p,
  )
  assert.equal(h?.level, 'INFO')
  assert.equal(h?.thread, 'main')
  assert.equal(h?.logger, 'c.a.DemoApplication')
  assert.equal(h?.msg, 'Started')
  assert.ok(parseStamp(h!.ts!, p.tsFormat!) !== null)
})

test('parseStamp：本地时区逐段解析，13 月 / 尾巴多字给 null', () => {
  const good = parseStamp('2026-10-01 12:34:56.789', 'yyyy-MM-dd HH:mm:ss.SSS')
  assert.ok(good !== null)
  const d = new Date(good!)
  assert.equal(d.getFullYear(), 2026)
  assert.equal(d.getMonth(), 9) // 0 起，10 月
  assert.equal(d.getDate(), 1)
  assert.equal(d.getHours(), 12)
  assert.equal(d.getMilliseconds(), 789)

  const comma = parseStamp('2026-10-01 09:00:00,123', 'yyyy-MM-dd HH:mm:ss,SSS')
  assert.equal(new Date(comma!).getMilliseconds(), 123)

  assert.equal(parseStamp('2026-13-01 09:00:00,000', 'yyyy-MM-dd HH:mm:ss,SSS'), null)
  assert.equal(parseStamp('2026-10-01 09:00:00,123  额外的尾巴', 'yyyy-MM-dd HH:mm:ss,SSS'), null)
  assert.equal(parseStamp('不是时间', 'yyyy-MM-dd HH:mm:ss,SSS'), null)
})
