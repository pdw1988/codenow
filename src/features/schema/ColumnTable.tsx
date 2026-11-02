/**
 * 字段清单表格，对应 PRD 3.3 界面里的字段列表。
 *
 * 除 PRD 要求的 字段名/类型/主键/默认值/注释 外，多出一列 Java 映射 ——
 * 这是「做细」的差异点：写实体类时直接照抄。
 *
 * **两个字段表现在都不显示 Java 列**，两个调用点都传 hide：
 * - 连库查询（2026-09-21 用户拍板）：对着「看看这张表长什么样」的场景，Java 列
 *   用不上，却实占 168px，把字段名和注释挤成一条缝；
 * - 速查页 TableCard（2026-09-22 用户拍板「不关心」）：同上。
 * 默认值列当天先被一起砍掉、用户随即要求加回，所以最终只有 Java 列不显示。
 * 列定义仍然只有一份（hide 按 key 滤），要恢复就删掉调用点的 hide 参数。
 *
 * 搜索关键字要传进来：用户搜 `create_time` 命中了 6 张表，展开之后还得自己
 * 在 40 行里找那一行 —— 高亮省掉的就是这一趟。
 */
import { Hit } from '../../components/Hit'
import { Tag, Tbl, type TblCol } from '../../components/ui'
import type { Column } from '../../types/schema'
import { sortColumnsForUi } from '../../lib/columnOrder'
import { displayDbType } from '../../lib/dbType'

/** 列定义依赖关键字，所以是个函数。表头文案是 e2e 的定位锚点，别动 */
const cols = (kw?: string, hide?: ReadonlySet<ColKey>): Array<TblCol<Column>> => {
  const all: Array<TblCol<Column>> = [
  {
    key: 'name',
    title: '字段名',
    // 128 只放得下 ~18 个字符——Oracle 的 snake_case 字段名普遍 20~30 字符，
    // 全被 ellip 截断还无从看全（连库查询表结构用户反馈）。放到 208 约容 26 字符；
    // 更长的（12.2 起 128 字符）靠悬停 title，跟类型列同一个兜底套路
    cls: 'mono ellip',
    width: 208,
    render: (c) => (
      <span title={c.name}>
        <Hit text={c.name} kw={kw} />
      </span>
    ),
  },
  {
    key: 'type',
    title: '类型',
    cls: 'mono muted ellip',
    // 136 放得下 NVARCHAR2(1000)；低于这个宽度完整类型必截断，只能悬停看 title
    width: 136,
    render: (c) => <span title={c.type}>{displayDbType(c.type)}</span>,
  },
  {
    key: 'pk',
    title: '主键',
    width: 72,
    render: (c) =>
      c.isPrimaryKey ? (
        <Tag tone="pk">PK{c.isAutoIncrement ? ' 自增' : ''}</Tag>
      ) : c.isUnique ? (
        <Tag tone="hi">UK</Tag>
      ) : c.isIndexed ? (
        <Tag tone="hi">IDX</Tag>
      ) : null,
  },
  {
    key: 'nn',
    title: '必填',
    // NOT NULL 徽章实宽 ~80px：56 放不下，fixed 布局下会盖到默认值列首位
    width: 92,
    render: (c) => (c.nullable ? <span className="muted">—</span> : <Tag>NOT NULL</Tag>),
  },
  {
    key: 'def',
    title: '默认值',
    cls: 'mono muted ellip',
    width: 88,
    render: (c) => c.defaultValue ?? '—',
  },
  {
    key: 'cm',
    title: '注释',
    cls: 'ellip cm',
    // 注释不设 width 时会吞掉表格全部富余（table-layout:fixed + width:100%），
    // 类型/默认值被挤成一条缝。封顶后富余按列宽比例摊回各列。
    // 列宽总和就是表的最小宽度：默认窗口 1280 时速查页右边详情卡只有 ~740px，
    // 去掉 Java 后要压在这以内（现 736），否则注释列被裁、底下出横向滚动条
    width: 140,
    render: (c) =>
      c.comment ? (
        <span title={c.comment}>
          <Hit text={c.comment} kw={kw} />
        </span>
      ) : (
        <span className="muted">—</span>
      ),
  },
  {
    key: 'java',
    title: 'Java',
    cls: 'mono muted ellip',
    width: 168,
    render: (c) => `${c.javaType.split('.').pop()} ${c.javaField}`,
  },
  ]

  // 按 key 滤，不拆成两份列定义数组：两份表头文案总有一天只改一份，
  // 然后两个页面的列 silently 长歪（本项目「同一规则有两份」的坑踩过多次）
  return hide && hide.size > 0 ? all.filter((c) => !hide.has(c.key as ColKey)) : all
}

/** 允许不显示的列。加新列时这里要同步 */
type ColKey = 'name' | 'type' | 'pk' | 'nn' | 'def' | 'cm' | 'java'

export function ColumnTable({
  columns,
  kw,
  hide,
}: {
  columns: Column[]
  kw?: string
  hide?: ReadonlySet<ColKey>
}) {
  return (
    <Tbl
      className="cols-fit"
      cols={cols(kw, hide)}
      rows={sortColumnsForUi(columns)}
      rowKey={(c) => c.name}
    />
  )
}
