/**
 * 正则测试器，PRD 7.1。
 *
 * 关键点是「不能因为用户打字打到一半就崩」：正则在输入过程中必然经历
 * 非法状态（`[a-` 这种），所有 new RegExp 都得包在 try 里。
 *
 * 没有「测试」按钮 —— 输入即匹配。
 */
import { useMemo, useState } from 'react'
import { Page } from '../../components/shell/Page'
import {
  Auto,
  Band,
  Btn,
  Card,
  Code,
  Col,
  Hint,
  Lbl,
  Mono,
  Row,
  Split,
  Tag,
  Tbl,
  TextArea,
  type TblCol,
} from '../../components/ui'

const FLAGS = [
  ['g', '全局'],
  ['i', '忽略大小写'],
  ['m', '多行'],
  ['s', '. 匹配换行'],
] as const

type Flag = (typeof FLAGS)[number][0]

/**
 * PRD 点名的几类常用正则。**每条连测试文本一起给**：
 * 只给正则不给样本，用户还得自己造一段能命中的文本，那才是这一页最费时间的一步。
 * 样本里故意留了「不该命中」的行，让人一眼看出这条正则的边界在哪。
 */
const PRESETS: Array<{ nm: string; rx: string; txt: string }> = [
  {
    nm: '邮箱',
    rx: String.raw`[\w.+-]+@[\w-]+\.[\w.-]+`,
    txt: `联系人：zhangsan@example.com、li.si+dev@corp.com.cn
错的：@nope.com、user@、a@b（这几个不该整条命中）
运维邮箱 ops_01@sub.example.org 每天收报警`,
  },
  {
    nm: '手机号',
    rx: String.raw`1[3-9]\d{9}`,
    txt: `13812345678 / 13900000000 / 18600000000
12345678901（1 后面是 2，不该命中）
座机 010-12345678 也不该命中`,
  },
  {
    nm: '身份证',
    rx: String.raw`[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]`,
    txt: `11010519880307123X
440305199001011234
110105208813071234（月份 88，不该命中）`,
  },
  {
    nm: 'URL',
    rx: String.raw`https?://[\w.-]+(?::\d+)?(?:/[\w./?%&=~+-]*)?`,
    txt: `http://localhost:5173/#/schema
https://mybatis.org/dtd/mybatis-3-mapper.dtd
jdbc:mysql://127.0.0.1:3306/demo?useSSL=false（jdbc: 开头，前缀不该被吃掉）`,
  },
  {
    nm: 'IPv4',
    rx: String.raw`\b(?:\d{1,3}\.){3}\d{1,3}\b`,
    txt: `来源 192.168.1.100，网关 192.168.1.1
公网 8.8.8.8 / 300.1.1.1（这个不是合法 IP，纯正则拦不住）
版本号 1.2.3.4 会被误命中 —— 这就是为什么要看明细`,
  },
  {
    nm: '日期',
    rx: String.raw`(\d{4})-(\d{2})-(\d{2})`,
    txt: `create_time = 2026-08-24 10:30:00
到期 2026-12-31，签约 2025-01-01
2026/08/24（斜杠的不命中）`,
  },
  {
    nm: '中文',
    rx: String.raw`[一-龥]+`,
    txt: `COMMENT '状态 0待付 1已付 2已发货 3完成'
comment on column "ORDER".del_flag is '是否删除（0否 1是）';`,
  },
  {
    nm: 'Java 字段',
    rx: String.raw`private\s+(\w+(?:<[\w,\s]+>)?)\s+([a-z]\w*)\s*;`,
    txt: `private Long id;
private String orderNo;
private BigDecimal total;
private LocalDateTime createTime;
private List<OrderDetail> details;
public String getOrderNo() { return orderNo; }`,
  },
  {
    nm: '日志取 SQL',
    rx: String.raw`Preparing:\s*(.+)`,
    txt: `2026-08-24 10:30:01 DEBUG [pool-1] c.e.d.OrderDao.insert:159 -> ==>  Preparing: insert into \`order\` (order_no, total) values (?, ?)
2026-08-24 10:30:01 DEBUG [pool-1] c.e.d.OrderDao.insert:159 -> ==> Parameters: CT20260820000123(String), 199.00(BigDecimal)`,
  },
  {
    nm: '日志取参数',
    rx: String.raw`([^,(]+)\(([A-Za-z]+)\)`,
    txt: `Parameters: 10231(Long), CT20260820000123(String), 199.00(BigDecimal), 2026-08-24 10:30:00.0(Timestamp), null`,
  },
  {
    nm: '去行尾空白',
    rx: String.raw`[ \t]+$`,
    txt: '这一行尾巴有空格   \n这一行没有\n这一行有制表符\t\t',
  },
  {
    nm: '重复词',
    rx: String.raw`\b(\w+)\s+\1\b`,
    txt: 'the the quick brown fox fox jumps\nselect select 1 from dual',
  },
]

interface MatchRow {
  key: number
  index: number
  end: number
  text: string
  /** 没参与匹配的分组是 `undefined`，跟「匹配到空串」不是一回事，所以不能塞 '' */
  groups: Array<string | undefined>
}

/** 一次跑完，返回匹配列表或错误信息。不开 g 就只取第一处 —— 跟 JS 本身的语义一致 */
function exec(source: string, flags: string, text: string): { rows: MatchRow[]; err: string } {
  if (!source) return { rows: [], err: '' }

  let re: RegExp
  try {
    re = new RegExp(source, flags)
  } catch (e) {
    return { rows: [], err: e instanceof Error ? e.message : String(e) }
  }

  const rows: MatchRow[] = []
  const push = (m: RegExpExecArray) =>
    rows.push({
      key: rows.length,
      index: m.index,
      end: m.index + m[0].length,
      text: m[0],
      groups: m.slice(1),
    })

  if (re.global) {
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      push(m)
      // 零长度匹配（`\b`、`a*`）不推进 lastIndex 就是死循环
      if (m.index === re.lastIndex) re.lastIndex += 1
      if (rows.length > 3000) break
    }
  } else {
    const m = re.exec(text)
    if (m) push(m)
  }

  return { rows, err: '' }
}

export function RegexTester() {
  const [source, setSource] = useState(PRESETS[0].rx)
  const [text, setText] = useState(PRESETS[0].txt)
  const [preset, setPreset] = useState(PRESETS[0].nm)
  const [on, setOn] = useState<Record<Flag, boolean>>({ g: true, i: true, m: false, s: false })

  // 顺序固定按 FLAGS 来，不按用户点击顺序 —— 否则同样的修饰符会显示成 `ig` 和 `gi` 两种样子
  const flags = FLAGS.filter(([f]) => on[f])
    .map(([f]) => f)
    .join('')

  const { rows, err } = useMemo(() => exec(source, flags, text), [source, flags, text])

  const groupCount = rows.reduce((n, r) => Math.max(n, r.groups.length), 0)

  /** 按位置把原文切成「命中 / 没命中」的片段。切原文而不是切转义后的串 */
  const parts = useMemo(() => {
    const out: Array<{ text: string; hit: boolean }> = []
    let cursor = 0
    for (const r of rows) {
      if (r.index > cursor) out.push({ text: text.slice(cursor, r.index), hit: false })
      out.push({ text: r.text, hit: true })
      cursor = r.end
    }
    if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false })
    return out
  }, [rows, text])

  const cols: Array<TblCol<MatchRow>> = [
    { key: '#', title: '#', cls: 'num', width: 44, render: (_r, i) => i + 1 },
    { key: 'pos', title: '位置', cls: 'mono muted', width: 90, render: (r) => `${r.index}–${r.end}` },
    {
      key: 'text',
      title: '匹配内容',
      cls: 'mono',
      render: (r) => r.text || <span className="muted">（零长度）</span>,
    },
    // 只在真有捕获组时才加列，否则表格白占一栏
    ...Array.from({ length: groupCount }, (_, g): TblCol<MatchRow> => ({
      key: `g${g}`,
      title: `组 ${g + 1}`,
      cls: 'mono',
      render: (r) =>
        r.groups[g] === undefined ? <span className="muted">—</span> : r.groups[g],
    })),
  ]

  return (
    <Page tab="regex" actions={<Auto>无「测试」按钮 · 输入即匹配</Auto>}>
      <Split even>
        <Col>
          <Card hero
            title="正则表达式"
            who={err ? '写错了' : rows.length ? `${rows.length} 处 · ${groupCount} 个分组` : '没有命中'}
          >
            <div className="stack">
              <div className={err ? 'rx bad' : 'rx'}>
                <span className="sl">/</span>
                <input
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="正则表达式"
                />
                <span className="sl">/</span>
                <span className="fl">{flags || '（无）'}</span>
              </div>

              <Row tight>
                <Lbl>修饰符</Lbl>
                {FLAGS.map(([f, label]) => (
                  <Btn
                    key={f}
                    variant="mini"
                    on={on[f]}
                    onClick={() => setOn((s) => ({ ...s, [f]: !s[f] }))}
                  >
                    <Mono>
                      <b>{f}</b>
                    </Mono>{' '}
                    {label}
                  </Btn>
                ))}
              </Row>

              {err && (
                <Band tone="err" title="正则不合法">
                  <Mono>{err}</Mono>
                </Band>
              )}
            </div>
          </Card>

          <Card title="常用" extra={<Auto>点一下连测试文本一起换</Auto>}>
            <div className="pre-grid">
              {PRESETS.map((p) => (
                <Btn
                  key={p.nm}
                  variant="mini"
                  on={preset === p.nm}
                  onClick={() => {
                    setSource(p.rx)
                    setText(p.txt)
                    setPreset(p.nm)
                  }}
                >
                  {p.nm}
                </Btn>
              ))}
            </div>
          </Card>

          <Card
            title="测试文本"
            who={`${text.length} 字符 · ${text.split('\n').length} 行`}
            tight
          >
            <TextArea
              className="flush"
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="测试文本"
            />
          </Card>
        </Col>

        <Col>
          <Card title="高亮预览" extra={<Tag tone="hi">{rows.length} 处匹配</Tag>} tight>
            <pre className="prev">
              {parts.length === 0 ? (
                <Hint>测试文本是空的</Hint>
              ) : (
                parts.map((p, i) =>
                  p.hit ? (
                    // 零长度命中画一个符号，否则用户看到的是「什么都没发生」
                    <mark key={i}>{p.text || '␀'}</mark>
                  ) : (
                    <span key={i}>{p.text}</span>
                  ),
                )
              )}
            </pre>
          </Card>

          <Card title="匹配明细" who={rows.length && !flags.includes('g') ? '没开 g，只找第一处' : undefined} tight>
            <Tbl
              cols={cols}
              rows={rows}
              rowKey={(r) => String(r.key)}
              scroll="lg"
              empty={
                err ? (
                  '先把正则改对'
                ) : !source ? (
                  '在上面写个正则'
                ) : (
                  <>
                    一处都没命中
                    <br />
                    <Hint>左边的测试文本里每条预设都故意留了「不该命中」的行</Hint>
                  </>
                )
              }
            />
          </Card>

          <Code
            code={rows.map((r) => r.text).join('\n')}
            lang="text"
            name="匹配结果（每行一处）"
            download="matches.txt"
            size="sm"
          />
        </Col>
      </Split>
    </Page>
  )
}
