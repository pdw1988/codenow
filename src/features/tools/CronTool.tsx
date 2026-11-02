/**
 * Cron 表达式生成器，PRD 二十。挂在「🧰 小工具」组，排在 JSONPath 后面。
 *
 * 跟正则测试器同一条设计：**没有「生成」按钮，输入即解析**。cron 是反着写的
 * （人想的是「每 5 分钟」，写出来是 `0 0/5 * * * ?`），所以产物顺序是先给
 * 「文本解读」和「接下来 N 次触发时间」——用户来是为了确认自己没写错，
 * 不是先读一份字段说明。输入框和常用表达式都在结果下面那一列。
 *
 * 规则本体全在 lib/cron.ts（纯函数 + 33 条用例钉住边界），这里只做渲染。
 * **界面文案用术语不用口语**：时刻写 `09:00` 不写「早上 9 点」，校验状态写
 * 「未通过校验」不写「还没写对」——同类工具（Jenkins / Quartz 文档）怎么叫，
 * 这里就怎么叫。
 */
import { useEffect, useMemo, useState } from 'react'
import { Page } from '../../components/shell/Page'
import {
  Auto,
  Band,
  Btn,
  Card,
  Chips,
  Code,
  Col,
  CopyBtn,
  Hint,
  Lbl,
  Mono,
  Row,
  Split,
  Tag,
  Tbl,
  type TblCol,
} from '../../components/ui'
import { describeCron, nextRuns, parseCron, type CronSchedule } from '../../lib/cron'

/**
 * 常用表达式。**每条都写成六段（Spring @Scheduled 的口径）**——这个工具的用户
 * 最多的是后端，粘回去能直接跑；五段的 crontab 少一个秒位，照抄过去反而是错的。
 *
 * 名字统一用 HH:mm 写时刻，跟下面「解读」那句话的说法对齐：一处写「早上 9 点」、
 * 另一处写「09:00」，用户要在心里翻译一遍。
 */
const PRESETS: Array<{ nm: string; expr: string; why: string }> = [
  { nm: '每分钟', expr: '0 * * * * ?', why: '秒位固定为 0，整分触发' },
  { nm: '每 5 分钟', expr: '0 0/5 * * * ?', why: '轮询、对账常用' },
  { nm: '每 30 秒', expr: '*/30 * * * * ?', why: '秒位等差；五段表达式没有秒位' },
  { nm: '每小时', expr: '0 0 * * * ?', why: '每小时的 0 分 0 秒' },
  { nm: '每天 00:00', expr: '0 0 0 * * ?', why: '日切（T+1）批处理' },
  { nm: '每天 09:00', expr: '0 0 9 * * ?', why: '单一定时' },
  { nm: '工作日 09:00', expr: '0 0 9 * * MON-FRI', why: '周一至周五触发，周末不触发' },
  { nm: '每周一 10:00', expr: '0 0 10 ? * MON', why: '周报场景' },
  { nm: '每月 1 日 00:00', expr: '0 0 0 1 * ?', why: '月初账期切换' },
  { nm: '每月最后一天', expr: '0 0 0 L * ?', why: '用 L，不必计算当月天数' },
  { nm: '每月最后一个工作日', expr: '0 0 0 LW * ?', why: '用 LW，避开周末' },
  { nm: '每月第三个周五', expr: '0 0 0 ? * 5#3', why: '金融交割、结算日常见' },
  { nm: '每年 1 月 1 日', expr: '0 0 0 1 1 ?', why: '年度账期切换' },
]

/** 一次往后看几次。20 次足够看出周期，又不至于把表格拉满 */
const SHOW = 20

/** 段位说明。做成表而不是一句话：`?` 和 `*` 的区别、日与周的或关系都在这儿 */
const SEGMENTS: Array<{ seg: string; vals: string; note: string }> = [
  { seg: '秒', vals: '0–59', note: '六段起才有；五段表达式该位固定为 0' },
  { seg: '分', vals: '0–59', note: '' },
  { seg: '时', vals: '0–23', note: '' },
  { seg: '日', vals: '1–31', note: 'L=月末、L-n=倒数第 n 天、nW=距 n 号最近的工作日、LW=当月最后一个工作日' },
  { seg: '月', vals: '1–12 / JAN–DEC', note: '支持 NOV-FEB 这类跨年区间' },
  { seg: '周', vals: '0–7 / SUN–SAT', note: 'n#k=当月第 k 个星期 n、nL=当月最后一个星期 n；0 和 7 都是周日' },
  { seg: '年', vals: '1970–2099', note: '七段（Quartz）才有；该位缺省表示不限' },
]

const DOW = ['日', '一', '二', '三', '四', '五', '六']

const pad = (n: number) => String(n).padStart(2, '0')

/** 本地墙上时间。定时任务跑在本机上，给 UTC 等于把用户的执行时间骗了 */
function wall(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 「3 分钟后」「2 小时后」「5 天后」。当天内的不说日期，跨天才说 */
function rel(d: Date, now: Date): string {
  const sec = Math.round((d.getTime() - now.getTime()) / 1000)
  if (sec < 60) return `${sec} 秒后`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} 分钟后`
  const hour = Math.floor(min / 60)
  if (hour < 24 && d.getDate() === now.getDate()) return `${hour} 小时 ${min % 60} 分后`
  const day = Math.round(
    (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
      - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000,
  )
  if (day <= 1) return '次日'
  if (day < 30) return `${day} 天后`
  const month = (d.getFullYear() - now.getFullYear()) * 12 + d.getMonth() - now.getMonth()
  return month < 12 ? `${month} 个月后` : `${Math.floor(month / 12)} 年后`
}

const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6

/** 分段解读：把每段展开成的取值摆出来，用户自己能核对「我写的到底是什么意思」 */
function segView(s: CronSchedule): Array<{ n: string; v: string }> {
  const names = s.hasSeconds ? ['秒', '分', '时', '日', '月', '周'] : ['分', '时', '日', '月', '周']
  const slots = s.hasSeconds ? [0, 1, 2, 3, 4, 5] : [1, 2, 3, 4, 5]
  if (s.yearRestricted) {
    names.push('年')
    slots.push(6)
  }
  return names.map((n, i) => {
    const v = s.sets[slots[i]]
    return { n, v: v.length > 12 ? `${v.slice(0, 12).join(',')}…` : v.join(',') }
  })
}

interface SegRow {
  seg: string
  vals: string
  note: string
}

interface RunRow {
  d: Date
  i: number
}

export function CronTool() {
  const [expr, setExpr] = useState(PRESETS[1].expr)
  /** 「字段说明」默认折起；它讲的是语法而不是结果，不该挤占首屏 */
  const [segOpen, setSegOpen] = useState(false)
  /** 半分钟一跳：表格里的「3 分钟后」不能停在打开页面那一刻，否则待一会儿就成了假话 */
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000)
    return () => clearInterval(t)
  }, [])

  const parsed = useMemo(() => parseCron(expr), [expr])
  const runs = useMemo(
    () => (parsed.ok ? nextRuns(parsed.schedule, now, SHOW) : []),
    [parsed, now],
  )
  const words = useMemo(() => (parsed.ok ? describeCron(parsed.schedule) : ''), [parsed])
  const segs = useMemo(() => (parsed.ok ? segView(parsed.schedule) : []), [parsed])

  /*
   * 窄列的宽度要按「表头字数 × 12.5px + td 左右各 12px 内边距」算，不能凭手感给 40：
   * 「星期」两字占 25px，加 24px 内边距要 49px，给 40 会被折成「星 / 期」两行，
   * 表头行高从 28px 涨到 41px，整张表看着像多了一行（真浏览器量出来的）。
   * 「#」列要装下两位行号（`20` ≈ 15px）。
   */
  const runCols: Array<TblCol<RunRow>> = [
    { key: '#', title: '#', cls: 'num', width: 44, render: (r) => r.i + 1 },
    { key: 't', title: '触发时间', cls: 'mono', render: (r) => wall(r.d) },
    { key: 'w', title: '星期', cls: 'num', width: 52, render: (r) => <span title={isWeekend(r.d) ? '周末' : undefined}>{DOW[r.d.getDay()]}</span> },
    { key: 'rel', title: '相对当前时间', cls: 'relt', width: 118, render: (r) => rel(r.d, now) },
  ]

  const segCols: Array<TblCol<SegRow>> = [
    // 同上：「字段」两字 + 24px 内边距要 49px，46 会被折成「字 / 段」
    { key: 'seg', title: '字段', width: 52, render: (r) => <b>{r.seg}</b> },
    { key: 'vals', title: '取值', cls: 'mono', render: (r) => r.vals },
    { key: 'note', title: '说明', cls: 'muted', render: (r) => r.note },
  ]

  return (
    <Page tab="cron" actions={<Auto>本地解析 · 输入即出结果 · 不上传</Auto>}>
      <Split even>
        <Col>
          {/* 产物在右栏第一张卡；这一列只放输入、常用项和说明 */}
          <Card hero
            title="Cron 表达式"
            who={parsed.ok ? (parsed.schedule.hasSeconds ? '六段 · 含秒位' : '五段 · 不含秒位') : '未通过校验'}
          >
            <div className="stack">
              <textarea
                className="fld mono cron-input"
                value={expr}
                onChange={(e) => setExpr(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                rows={2}
                aria-label="Cron 表达式"
              />

              {!parsed.ok && (
                <Band tone="err" title="表达式校验未通过">
                  <Mono>{parsed.error}</Mono>
                  <br />
                  <Hint>字段之间以空格分隔；输入到一半时只校验已填写的字段</Hint>
                </Band>
              )}

              {parsed.ok && (
                <>
                  <Row tight>
                    <CopyBtn text={expr} title="复制表达式，可直接粘贴到 @Scheduled(cron = &quot;…&quot;)" />
                    <Btn variant="mini" onClick={() => setExpr('')}>
                      清空
                    </Btn>
                  </Row>
                  <Row tight>
                    <Lbl>字段展开为</Lbl>
                    <Chips>
                      {segs.map((s) => (
                        <Tag key={s.n} title={`${s.n} 字段展开后的取值集合`}>
                          {s.n} {s.v || '—'}
                        </Tag>
                      ))}
                    </Chips>
                  </Row>
                </>
              )}
            </div>
          </Card>

          <Card title="常用表达式" extra={<Auto>点击后填入上方输入框</Auto>}>
            <div className="pre-grid">
              {PRESETS.map((p) => (
                <Btn
                  key={p.nm}
                  variant="mini"
                  on={expr.trim() === p.expr}
                  title={`${p.expr} —— ${p.why}`}
                  onClick={() => setExpr(p.expr)}
                >
                  {p.nm}
                </Btn>
              ))}
            </div>
          </Card>

          {parsed.ok && (
            <Card title="表达式（带中文注释）" who="可直接粘进代码注释">
              <Code code={`${expr}\n\n# ${words}`} lang="text" name="cron.txt" download="cron.txt" size="sm" />
            </Card>
          )}

          {/*
            默认折起（产物首屏可见那条铁律），但**必须真能展开**：onToggle 写成
            `() => undefined` 的话 Card 认为这是张折叠卡、按 CSS 把 cbody 藏了，
            而 open 永远 false —— 用户看到一个能点的箭头，点了毫无反应，
             「? 和 * 的区别」「日与周的或关系」这几条等于不存在
          */}
          <Card
            title="字段说明"
            who="五段起 · 七段含秒位与年位"
            open={segOpen}
            onToggle={setSegOpen}
          >
            <div className="stack">
              <Tbl cols={segCols} rows={SEGMENTS} rowKey={(r) => r.seg} />
              <Band tone="warn" title="「日」与「周」同时限定时为「或」关系">
                <Mono>0 0 1 * 1</Mono> 表示「每月 1 日 <b>或</b> 每周一」，不是「既是 1 日又是周一」。
                任一位是 <Mono>*</Mono> 或 <Mono>?</Mono> 时，二者才是并且关系。
              </Band>
            </div>
          </Card>
        </Col>

        <Col>
          <Card
            title="文本解读"
            who={parsed.ok ? '中文说明' : '表达式未通过校验'}
            extra={parsed.ok ? <Tag tone="hi">本地推算</Tag> : undefined}
          >
            {parsed.ok ? (
              <div className="stack">
                <div className="cron-words">{words}</div>
                {!parsed.schedule.domWild && !parsed.schedule.dowWild && (
                  <Hint>「日」与「周」为「或」：每月 1 日与每周一均触发</Hint>
                )}
              </div>
            ) : (
              <Hint>表达式通过校验后，此处显示中文解读</Hint>
            )}
          </Card>

          <Card
            title={`接下来 ${SHOW} 次`}
            who={parsed.ok ? '按本机时间计算 · 每 30 秒刷新' : undefined}
            tight
          >
            {runs.length === 0 ? (
              <div className="stack">
                <Band tone="warn" title="计算范围内无触发时间">
                  日与月的组合不成立（例如 <Mono>2 月 30 日</Mono>），或年位限定在过去的时间。
                  请调整日 / 月 / 年三位。
                </Band>
                <Hint>计算范围为未来 10 年；2 月 29 日这类闰年日期同样可以推算</Hint>
              </div>
            ) : (
              <Tbl
                cols={runCols}
                rows={runs.map((d, i) => ({ d, i }))}
                rowKey={(r) => String(r.d.getTime())}
                /* 这一页有两张表（「每一段写什么」也是 Tbl）。挂个类名，e2e 才能
                   只挑这一张——按 .tbl 全查会把段位表的行混进来，hour 切片拿到的是
                   「0–59」这种取值文本，断言就悄悄废了 */
                className="cron-runs"
              />
            )}
          </Card>
        </Col>
      </Split>
    </Page>
  )
}
