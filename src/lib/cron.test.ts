import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCron, nextRuns, describeCron, type CronSchedule } from './cron'

/** 固定基准时刻：2026-09-22 14:32:07（周二）。所有「接下来几次」都从它算 */
const AT = new Date(2026, 8, 22, 14, 32, 7)

function ok(expr: string): CronSchedule {
  const r = parseCron(expr)
  if (!r.ok) throw new Error(`本该解析成功：${expr} → ${r.error}`)
  return r.schedule
}

function times(expr: string, from: Date = AT, n = 5): string[] {
  return nextRuns(ok(expr), from, n).map(fmt)
}

/** 本地分量的可读形式，不带上时区——断言只看墙上时间 */
function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 六段（Spring @Scheduled）：每 5 分钟 */
test('nextRuns：0 0/5 * * * ? 从 14:32:07 起是 14:35、14:40、14:45…', () => {
  assert.deepEqual(times('0 0/5 * * * ?'), [
    '2026-09-22 14:35:00',
    '2026-09-22 14:40:00',
    '2026-09-22 14:45:00',
    '2026-09-22 14:50:00',
    '2026-09-22 14:55:00',
  ])
})

test('nextRuns：整秒等差 */15 落在 0、15、30、45 秒', () => {
  assert.deepEqual(times('*/15 * * * * ?', new Date(2026, 8, 22, 14, 32, 7), 4), [
    '2026-09-22 14:32:15',
    '2026-09-22 14:32:30',
    '2026-09-22 14:32:45',
    '2026-09-22 14:33:00',
  ])
})

/** cron 头号陷阱：写并且的话这条一年只剩几天 */
test('日与周同时限死时是「或」：0 0 1 * 1 每月 1 号和每周一都跑', () => {
  const got = times('0 0 1 * 1', new Date(2026, 8, 22, 0, 0, 0), 8)
  // 2026-09-22 是周二；本月已过的周一 21 号不再算，下一个 1 号是 10 月 1 号（周四）
  assert.deepEqual(got, [
    '2026-09-28 00:00:00', // 周一
    '2026-10-01 00:00:00', // 1 号
    '2026-10-05 00:00:00', // 周一
    '2026-10-12 00:00:00', // 周一
    '2026-10-19 00:00:00', // 周一
    '2026-10-26 00:00:00', // 周一
    '2026-11-01 00:00:00', // 1 号
    '2026-11-02 00:00:00', // 周一
  ])
})

test('只有一段限死时另一段是通配，退化成并且：0 0 1 * * 只管 1 号', () => {
  const got = times('0 0 1 * *', new Date(2026, 8, 22, 0, 0, 0), 3)
  assert.deepEqual(got, ['2026-10-01 00:00:00', '2026-11-01 00:00:00', '2026-12-01 00:00:00'])
})

test('日段用 ? 表示不限：0 0 0 ? * 1 只按周一跑', () => {
  const got = times('0 0 0 ? * 1', new Date(2026, 8, 22, 0, 0, 0), 2)
  assert.deepEqual(got, ['2026-09-28 00:00:00', '2026-10-05 00:00:00'])
})

test('L：0 0 0 L * ? 出月末，平年 2 月是 28、闰年是 29', () => {
  assert.deepEqual(times('0 0 0 L * ?', new Date(2026, 8, 22, 0, 0, 0), 4), [
    '2026-09-30 00:00:00',
    '2026-10-31 00:00:00',
    '2026-11-30 00:00:00',
    '2026-12-31 00:00:00',
  ])
  assert.deepEqual(times('0 0 0 L * ?', new Date(2027, 1, 3, 0, 0, 0), 1), ['2027-02-28 00:00:00'])
  assert.deepEqual(times('0 0 0 L * ?', new Date(2028, 1, 3, 0, 0, 0), 1), ['2028-02-29 00:00:00'])
})

test('L-3：倒数第 3 天', () => {
  assert.deepEqual(times('0 0 0 L-3 * ?', new Date(2026, 8, 22, 0, 0, 0), 2), [
    '2026-09-27 00:00:00',
    '2026-10-28 00:00:00',
  ])
})

test('nW：15W 是离 15 号最近的工作日，撞上周六退到 14、周日进到 16', () => {
  // 2026-11-15 是周日 → 16（周一）；2026-08-15 是周六 → 14（周五）
  assert.deepEqual(times('0 0 0 15W * ?', new Date(2026, 6, 20, 0, 0, 0), 1), ['2026-08-14 00:00:00'])
  assert.deepEqual(times('0 0 0 15W * ?', new Date(2026, 10, 1, 0, 0, 0), 1), ['2026-11-16 00:00:00'])
})

test('LW：本月最后一个工作日。2026-05-31 是周日 → 退到 29（周五）', () => {
  assert.deepEqual(times('0 0 0 LW * ?', new Date(2026, 4, 10, 0, 0, 0), 1), ['2026-05-29 00:00:00'])
})

test('n#k：0 0 0 ? * 5#3 只出每月第三个星期五', () => {
  assert.deepEqual(times('0 0 0 ? * 5#3', new Date(2026, 8, 22, 0, 0, 0), 2), [
    '2026-10-16 00:00:00',
    '2026-11-20 00:00:00',
  ])
})

test('nL / FRIL：每月最后一个星期五', () => {
  assert.deepEqual(times('0 0 0 ? * 5L', new Date(2026, 8, 22, 0, 0, 0), 2), [
    '2026-09-25 00:00:00',
    '2026-10-30 00:00:00',
  ])
  assert.deepEqual(times('0 0 0 ? * FRIL', new Date(2026, 8, 22, 0, 0, 0), 1), ['2026-09-25 00:00:00'])
})

test('2 月 30 号不存在：0 0 0 30 2 ? 一次都不触发，且不死循环', () => {
  assert.deepEqual(nextRuns(ok('0 0 0 30 2 ?'), AT, 5), [])
})

test('2 月 29：闰年才触发，horizon 要够长才找得到', () => {
  assert.deepEqual(times('0 0 0 29 2 ?', new Date(2026, 8, 22, 0, 0, 0), 2), [
    '2028-02-29 00:00:00',
    '2032-02-29 00:00:00',
  ])
})

test('年段限死时整年整年跳：0 0 0 1 1 ? 2030', () => {
  assert.deepEqual(times('0 0 0 1 1 ? 2030', new Date(2026, 8, 22, 0, 0, 0), 2), [
    '2030-01-01 00:00:00',
  ])
  assert.deepEqual(times('0 0 0 1 1 ? 2025', new Date(2026, 8, 22, 0, 0, 0), 2), [])
})

test('段数：5 段（crontab）/ 6 段（Spring）/ 7 段（Quartz）都收，8 段报错', () => {
  assert.equal(ok('0 0 * * *').hasSeconds, false)
  assert.equal(ok('0 0 * * * ?').hasSeconds, true)
  assert.equal(ok('0 0 0 * * ?').hasSeconds, true)
  assert.equal(ok('0 0 0 * * ? 2027').yearRestricted, true)
  const bad = parseCron('0 0 0 * * ? 2027 extra')
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.error, /8 个字段过多/)
})

test('月份英文名：JAN、JAN-MAR、NOV-FEB 回头段', () => {
  assert.deepEqual(times('0 0 0 1 JAN *', new Date(2026, 8, 22, 0, 0, 0), 2), [
    '2027-01-01 00:00:00',
    '2028-01-01 00:00:00',
  ])
  // NOV-FEB：11、12、1、2 月都算
  const s = ok('0 0 0 1 NOV-FEB *')
  assert.deepEqual(s.sets[4], [1, 2, 11, 12])
})

test('星期英文名与 7：MON-FRI 是工作日，7 也是周日', () => {
  const s = ok('0 0 0 * * MON-FRI')
  assert.deepEqual(s.sets[5], [1, 2, 3, 4, 5])
  assert.deepEqual(ok('0 0 0 * * 7').sets[5], [0]) // Quartz 的 7 = 周六前的周日
  assert.deepEqual(ok('0 0 0 * * 0').sets[5], [0]) // Vixie 的 0 = 周日
})

test('macros：@daily / @hourly / @monthly 等价展开', () => {
  assert.deepEqual(ok('@daily').sets.slice(1, 6), ok('0 0 0 * * *').sets.slice(1, 6))
  assert.deepEqual(ok('@hourly').sets[1], [0])
  assert.deepEqual(ok('@monthly').sets[3], [1])
  assert.deepEqual(times('@daily', AT, 2), ['2026-09-23 00:00:00', '2026-09-24 00:00:00'])
})

test('5/10 是从 5 开始每 10 分跑到 55，不是只出一个值', () => {
  assert.deepEqual(ok('0 5/10 * * * ?').sets[1], [5, 15, 25, 35, 45, 55])
})

test('小时间隔跨天：0 0 */6 * * ? 出 0、6、12、18 时', () => {
  assert.deepEqual(times('0 0 */6 * * ?', new Date(2026, 8, 22, 13, 0, 0), 3), [
    '2026-09-22 18:00:00',
    '2026-09-23 00:00:00',
    '2026-09-23 06:00:00',
  ])
})

test('报错指到段：0 0/ 的第 2 段（分）步长不完整', () => {
  const r = parseCron('0 0/')
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.match(r.error, /第 2 段（分）/)
    assert.match(r.error, /步长/)
  }
})

test('打到一半：段数不够时报「还差几段」，不报看不懂的错', () => {
  for (const [expr, re] of [
    ['0', /至少 5 段/],
    ['0 0 0 *', /至少 5 段/],
    ['0 0/5', /至少 5 段/],
  ] as const) {
    const r = parseCron(expr)
    assert.equal(r.ok, false, `${expr} 本该报错`)
    if (!r.ok) assert.match(r.error, re)
  }
})

test('报错：星期写 8 越界、范围反了、逗号空了都指到段', () => {
  for (const [expr, re] of [
    ['0 0 0 * * 8', /第 5 段（周）/],
    ['0 10-2 * * *', /起止颠倒/],
    ['0 0 0 1,, * *', /空的逗号分段/],
    ['0 0 0 FOO * *', /无法识别/],
    ['0 0 0 1 * 5#9', /仅支持 1~5/],
    ['', /表达式为空/],
  ] as const) {
    const r = parseCron(expr)
    assert.equal(r.ok, false, `${expr} 本该报错`)
    if (!r.ok) assert.match(r.error, re, `${expr} 的报错要说清`)
  }
})

test('describeCron：每 5 分钟', () => {
  assert.equal(describeCron(ok('0 0/5 * * * ?')), '每天 每 5 分钟（自第 0 分起）')
})

test('describeCron：秒不在整 0 时才念出来', () => {
  // 30 0/5 * * * ? —— 秒是 30，必须出现在句子里
  assert.equal(describeCron(ok('30 0/5 * * * ?')), '每天 每 5 分钟（自第 0 分起），第 30 秒')
})

test('describeCron：每天零点、工作日早上 9 点、每月 1 日', () => {
  // 时刻直接给墙上时间：术语里「00:00」比「第 0 点第 0 分」短，也不跟段位名字混
  assert.equal(describeCron(ok('0 0 0 * * ?')), '每天 00:00')
  // 周一至周五整段命中说「工作日」，不逐个念成五句话——用户要看的是「09:00」
  assert.equal(describeCron(ok('0 0 9 * * MON-FRI')), '工作日 09:00')
  assert.equal(describeCron(ok('0 0 0 1 * ?')), '每月 1 日 00:00')
})

test('describeCron：周少一天就不叫「工作日」', () => {
  // MON-WED 是三天，不是工作日。说成「工作日」等于替用户把范围说大了
  assert.equal(describeCron(ok('0 0 9 * * MON-WED')), '每周一、周二、周三 09:00')
  // 六天（含周六）更不是
  assert.equal(describeCron(ok('0 0 9 * * MON-SAT')), '每周一、周二、周三、周四、周五、周六 09:00')
})

test('describeCron：月份限死时不跟「每月」打架', () => {
  assert.equal(describeCron(ok('0 0 0 1 1 *')), '1 月 1 日 00:00')
  assert.equal(describeCron(ok('0 0 0 * 1 1')), '1 月 每周一 00:00')
})

test('describeCron：时刻列全时给墙上时间，列不全才逐段念', () => {
  assert.equal(describeCron(ok('0 0 0,6 * * ?')), '每天 00:00、06:00')
  // 小时 × 分钟正好 6 个组合时仍然枚举，全是墙上时间
  assert.equal(describeCron(ok('0 0,30 9,10,11 * * ?')), '每天 09:00、09:30、10:00、10:30、11:00、11:30')
  // 分钟是等差时不说时刻，说间隔
  assert.equal(describeCron(ok('0 0/5 * * * ?')), '每天 每 5 分钟（自第 0 分起）')
  assert.equal(describeCron(ok('0 0/15 * * * ?')), '每天 每 15 分钟（自第 0 分起）')
})

test('describeCron：整段通配的时段说术语，别一段都不念', () => {
  // 分时都通配 → 每分钟。掉进下面那个循环会一段都不念，整句只剩「每天」
  assert.equal(describeCron(ok('0 * * * * ?')), '每天 每分钟')
  // 分固定成单值 + 时通配 → 每小时，不是「每天 第 0 分」
  assert.equal(describeCron(ok('0 0 * * * ?')), '每天 每小时')
  assert.equal(describeCron(ok('@hourly')), '每天 每小时')
  // 4 个时刻也列得下，仍然是墙上时间；列不下（0/5 分钟这种）才说间隔
  assert.equal(describeCron(ok('0 0 */6 * * ?')), '每天 00:00、06:00、12:00、18:00')
})

test('describeCron：日与周同时限死时要点明是「或」', () => {
  assert.match(describeCron(ok('0 0 1 * 1')), /^每月 1 日或每周一（日与星期为「或」，满足其一即触发） 00:00$/)
})

test('describeCron：L / W / # 也要说成术语', () => {
  assert.match(describeCron(ok('0 0 0 L * ?')), /每月 最后一天/)
  assert.match(describeCron(ok('0 0 0 15W * ?')), /距 15 日最近的工作日/)
  assert.match(describeCron(ok('0 0 0 ? * 5#3')), /每月第 3 个周五/)
  assert.match(describeCron(ok('0 0 0 ? * 5L')), /每月最后一个周五/)
  assert.match(describeCron(ok('0 0 0 LW * ?')), /最后一个工作日/)
})

test('describeCron：年段限死时写在最前面', () => {
  assert.match(describeCron(ok('0 0 0 1 1 ? 2027')), /^仅 2027 年/)
})
