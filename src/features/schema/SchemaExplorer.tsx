/**
 * 表结构速查主面板，PRD 第三章。
 *
 * 搜索框是这一页的重心，所以它走 `Page` 的 `hero` ——
 * 通栏、贴着顶栏、字号大一档，而不是挤在卡片里当一个筛选器。
 *
 * 布局照极光设计稿：统计行 + 左边命中列表、右边选中表的详情卡。
 * 「选中哪张」在这一层：换关键字之后第一名自动选中，只有列表这一层知道谁是第一名。
 */
import { useDeferredValue, useMemo, useState } from 'react'
import { SearchOutlined } from '@ant-design/icons'
import { searchTables } from '../../lib/search'
import { SEED_STAMP } from '../../storage/mockData'
import { useSchemaStore } from '../../store/useSchemaStore'
import { useUiStore } from '../../store/useUiStore'
import { Page } from '../../components/shell/Page'
import { Auto, Band, Btn, Card, Chip, Chips, EmptyBox, Hint, Lbl, Row, Stack, Stat, Stats } from '../../components/ui'
import { cx } from '../../components/ui/cx'
import { Hit } from '../../components/Hit'
import { TableCard } from './TableCard'
import { NoTablesEmpty } from './NoTablesEmpty'

/** 用户点过「知道了」就不再打扰（localStorage，跟更新跳过同一个命名风格） */
const DEMO_NOTE_SKIP = 'chuju.demo-note.skip'

function dismissedDemoNote(): boolean {
  try {
    return localStorage.getItem(DEMO_NOTE_SKIP) === '1'
  } catch {
    return false
  }
}

export function SchemaExplorer() {
  const tables = useSchemaStore((s) => s.tables)
  const loading = useSchemaStore((s) => s.loading)
  const loadErr = useSchemaStore((s) => s.loadErr)
  const query = useSchemaStore((s) => s.query)
  const setQuery = useSchemaStore((s) => s.setQuery)
  const recent = useSchemaStore((s) => s.recent)
  const touchTable = useSchemaStore((s) => s.touchTable)
  const removeRecent = useSchemaStore((s) => s.removeRecent)
  const setActiveTab = useUiStore((s) => s.setActiveTab)

  // 全部表都带着种子时间戳 = 用户还没导入过任何东西，首启演示态。
  // 导入/清空之后这条自然消失；点「知道了」本机不再出现。
  const demoOnly = !loading && tables.length > 0 && tables.every((t) => t.createdAt === SEED_STAMP)
  const [demoNoteGone, setDemoNoteGone] = useState(dismissedDemoNote)

  // 输入框保持即时响应，重算搜索结果延后一帧，避免大表集下打字卡顿
  const deferredQuery = useDeferredValue(query)
  const kw = deferredQuery.trim()
  // 左栏要能翻到每一张表，不用默认的 50 条上限（标题写的就是「全部 N 张」）
  const hits = useMemo(() => searchTables(tables, deferredQuery, Infinity), [tables, deferredQuery])

  const hitKey = hits.map((h) => h.table.name).join(',')
  const [seenKey, setSeenKey] = useState(hitKey)
  const [picked, setPicked] = useState(() => hits[0]?.table.name ?? '')
  // 渲染期校正：结果集变了就选中第一名。搜到了还要再点一次才能看字段，等于白搜一趟
  if (hitKey !== seenKey) {
    setSeenKey(hitKey)
    setPicked(hits[0]?.table.name ?? '')
  }
  const current = hits.find((h) => h.table.name === picked) ?? hits[0]

  /** 点开一张表算一次「查过」 */
  const pick = (name: string) => {
    setPicked(name)
    void touchTable(name)
  }

  const fkCount = useSchemaStore((s) => s.foreignKeys.length)
  const colCount = tables.reduce((n, t) => n + t.columns.length, 0)
  const fromDdl = tables.filter((t) => t.source === 'sql').length

  const hero = (
    <div className="pane-hero">
      {demoOnly && !demoNoteGone && (
        <div className="demo-note" role="note">
          <span className="demo-note-t">
            这两张是内置演示表，开箱即看不用导入；<b>导入你的 DDL 或连库后会自动替换</b>。
          </span>
          <button type="button" onClick={() => setActiveTab('import')}>
            导入我的表 →
          </button>
          <button
            type="button"
            className="x"
            title="不再提示"
            aria-label="不再提示"
            onClick={() => {
              try {
                localStorage.setItem(DEMO_NOTE_SKIP, '1')
              } catch {
                /* 隐私模式写不上就本次会话还显示，不影响功能 */
              }
              setDemoNoteGone(true)
            }}
          >
            ✕
          </button>
        </div>
      )}
      <div className="searchbox">
        <span className="ic" aria-hidden="true"><SearchOutlined /></span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="表名 / 字段 / 注释 / Java 类 / 拼音首字母"
          aria-label="搜索表结构"
        />
        <span className="cnt">
          <b>{kw ? `命中 ${hits.length} / ${tables.length}` : `${tables.length} 张`}</b>
          {query && (
            <button type="button" className="x" title="清空" onClick={() => setQuery('')}>
              ✕
            </button>
          )}
        </span>
      </div>

      {recent.length > 0 && (
        <Row>
          <Lbl>最近查过</Lbl>
          <Chips>
            {recent.map((name) => (
              <Chip
                key={name}
                badge="↺"
                onClick={() => setQuery(name)}
                onRemove={() => void removeRecent(name)}
              >
                {name}
              </Chip>
            ))}
          </Chips>
        </Row>
      )}
    </div>
  )

  return (
    <Page tab="schema" actions={<Auto>输入即时检索</Auto>} hero={hero}>
      <Stack>
        {tables.length > 0 && (
          <Stats className="stats-4">
            <Stat t="缓存表" v={tables.length} f={`DDL 导入 ${fromDdl} · 其他 ${tables.length - fromDdl}`} />
            <Stat t="字段" v={colCount} f={`平均每表 ${Math.round(colCount / tables.length)} 个`} />
            <Stat t="外键关系" v={fkCount} f="表之间的关联" />
            <Stat t={kw ? '本次命中' : '最近查过'} v={kw ? hits.length : recent.length} tone="acc" f={kw ? '按匹配度排序' : '点上面的标签直达'} />
          </Stats>
        )}

        {loading ? (
          <EmptyBox>正在读缓存…</EmptyBox>
        ) : loadErr ? (
          <Band tone="err" title="读表结构缓存失败">
            {loadErr}
            <Btn variant="mini" onClick={() => void useSchemaStore.getState().init()}>
              重试
            </Btn>
          </Band>
        ) : tables.length === 0 ? (
          <NoTablesEmpty />
        ) : hits.length === 0 ? (
          <EmptyBox>
            没有匹配「{kw}」的表
            <br />
            <Hint>可按表名片段、字段名或注释拼音首字母检索</Hint>
          </EmptyBox>
        ) : (
          <div className="g-side">
            <Card title={kw ? `命中 ${hits.length} 张表` : `全部 ${tables.length} 张表`} className="side-list">
              <div className="pick-list">
                {hits.map(({ table }) => (
                  <button
                    type="button"
                    key={table.name}
                    className={cx('pick-item', table.name === current?.table.name && 'on')}
                    onClick={() => pick(table.name)}
                    title={table.comment ? `${table.name}：${table.comment}` : table.name}
                  >
                    <b className="mono">
                      <Hit text={table.name} kw={kw} />
                    </b>
                    <span>{table.comment}</span>
                  </button>
                ))}
              </div>
            </Card>
            {current && <TableCard key={current.table.name} hit={current} kw={kw} />}
          </div>
        )}
      </Stack>
    </Page>
  )
}
