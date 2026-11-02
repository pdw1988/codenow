/**
 * 粘贴 CREATE TABLE 导入，PRD 5.2。
 *
 * **解析是实时的**（粘完就能看见预览）。**写入缓存只有一条路**（2026-08 定稿：
 * 不要手动步骤）：粘贴后立刻弹「是否导入」确认框（优化6），点「导入」直接入库；
 * 「先看看」留在此页看预览，想导就重新粘贴一次。手动「导入 N 张表」按钮已删。
 *
 * 为什么不直接「粘贴即入库」：入库会按表名覆盖已有的表，而 MetaStore 没有快照/
 * 回滚能力，「撤销」只能是假的。所以保留确认这一步，只是把它从「按钮」前移到
 * 「粘贴后的弹窗」里。
 *
 * 预览必须在写入之前：解析结果本身是猜测性的（方言选错、命名推断），
 * 直接落库用户就不知道自己导进去了什么。
 *
 * **导入成功后留在本页**（2026-08 评审定稿，原型 `mockup/import-clean.html`）：
 * 预览不清空、表标签换成「已导入」、顶部换结果条，不再「清空 + 跳速查页」——
 * 「结果当场看得见」比「跳走找结果」符合直觉，回干净态交给「清空」按钮。
 * 撤销不做：覆盖掉的旧定义没存，撤销只能是假的（见上）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { App } from 'antd'
import { FileTextOutlined } from '@ant-design/icons'
import type { Dialect } from '../../types/schema'
import { parseDdl } from '../../lib/ddlParser'
import { useSchemaStore } from '../../store/useSchemaStore'
import { DialectSel } from '../../components/DialectPick'
import { FkLine } from '../../components/FkLine'
import {
  Band,
  Btn,
  Card,
  Col,
  Fold,
  Hint,
  Lbl,
  Mono,
  Row,
  Spacer,
  Split,
  Stack,
  Stat,
  Stats,
  Tag,
  Tbl,
  TextArea,
  type TblCol,
} from '../../components/ui'
import type { Column } from '../../types/schema'
import { sortColumnsForUi } from '../../lib/columnOrder'

/**
 * 两段示例都只用**订单 + 订单明细**这一对表（跟 mockData.ts 的种子表、日志转 SQL 的样例
 * 是同一套），示例里不再出现 user / product 之类的表：多几张表并没有多演示什么，
 * 只会让人先分辨「哪张是工具自带的」。
 *
 * 两段各演示一级外键可信度，这样两个按钮都值得点一下：
 * - MySQL 这段写了 `CONSTRAINT … FOREIGN KEY` → 绿色 ✅ 真约束，默认勾选；
 * - Oracle 那段故意**不写** FK 约束（很多 Oracle 库为了性能真的不建）→ 只能靠
 *   `order_id` 命名推断出黄色 ⚠️，默认不勾。
 *
 * 两段的表名都和 mockData.ts 的种子一致（大写 ORDER / ORDER_DETAIL）：
 * 缓存按名字原文区分大小写，示例跟种子不同名的话，导一次示例就多出一张重复的订单表。
 */
const SAMPLE_MYSQL = `CREATE TABLE \`ORDER\` (
  \`id\`          BIGINT        NOT NULL AUTO_INCREMENT COMMENT '主键',
  \`order_no\`    VARCHAR(32)   NOT NULL COMMENT '订单号',
  \`total\`       DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '订单金额',
  \`status\`      TINYINT       NOT NULL DEFAULT 0 COMMENT '状态 0待付 1已付 2已发货 3完成',
  \`del_flag\`    TINYINT(1)    NOT NULL DEFAULT 0 COMMENT '是否删除 0否 1是',
  \`remark\`      VARCHAR(200)  DEFAULT NULL COMMENT '备注',
  \`create_time\` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '下单时间',
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_order_no\` (\`order_no\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单表';

CREATE TABLE \`ORDER_DETAIL\` (
  \`id\`          BIGINT        NOT NULL AUTO_INCREMENT COMMENT '主键',
  \`order_id\`    BIGINT        NOT NULL COMMENT '所属订单',
  \`sku\`         VARCHAR(40)   NOT NULL COMMENT '商品编码',
  \`qty\`         INT           NOT NULL DEFAULT 1 COMMENT '数量',
  \`price\`       DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '单价',
  \`create_time\` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (\`id\`),
  CONSTRAINT \`fk_order_detail_order\` FOREIGN KEY (\`order_id\`) REFERENCES \`ORDER\` (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单明细表';`

/**
 * PL/SQL Developer 导出的样子：注释是独立语句、主键在 alter table 里、尾巴一堆存储子句。
 *
 * 表名写成 `"ORDER"` 不是画蛇添足：ORDER 是 Oracle 保留字，这张表只能建成带引号的，
 * 导出来就是这个样子。裸写 `create table ORDER` 连解析都过不去（试过：两条语句被跳过，
 * 界面上那张表整个不见）。
 */
const SAMPLE_ORACLE = `create table "ORDER"
(
  id          NUMBER(19) not null,
  order_no    NVARCHAR2(32) not null,
  total       NUMBER(12,2) default 0 not null,
  status      NUMBER(1) default 0 not null,
  remark      LONG RAW,
  create_time TIMESTAMP(6) WITH TIME ZONE default systimestamp not null
)
tablespace USERS
  pctfree 10
  initrans 1
  maxtrans 255
  storage
  (
    initial 64K
    next 1M
  );
comment on table "ORDER" is '订单表';
comment on column "ORDER".id is '主键';
comment on column "ORDER".order_no is '订单号';
comment on column "ORDER".total is '订单金额';
comment on column "ORDER".status is '状态 0待付 1已付 2已发货 9作废';
comment on column "ORDER".remark is '备注（二进制）';
comment on column "ORDER".create_time is '下单时间';
alter table "ORDER" add constraint PK_ORDER primary key (ID);

create table ORDER_DETAIL
(
  id       NUMBER(19) not null,
  order_id NUMBER(19) not null,
  sku      VARCHAR2(40) not null,
  qty      NUMBER(10) default 1 not null,
  price    NUMBER(12,2) default 0 not null
)
tablespace USERS;
comment on table ORDER_DETAIL is '订单明细表';
comment on column ORDER_DETAIL.id is '主键';
comment on column ORDER_DETAIL.order_id is '所属订单';
comment on column ORDER_DETAIL.sku is '商品编码';
comment on column ORDER_DETAIL.qty is '数量';
comment on column ORDER_DETAIL.price is '单价';
alter table ORDER_DETAIL add constraint PK_ORDER_DETAIL primary key (ID);`

/** 字段预览的列。表头文案跟「编辑表结构」弹窗保持一致，两处看到的是同一张表 */
const COLS: Array<TblCol<Column>> = [
  { key: 'name', title: '字段', cls: 'mono', width: 150, render: (c) => c.name },
  // 「你写的类型」而不是「类型」：显示的是用户原样写的文本（declaredTypes 盖回去的），
  // 显示成规整化后的 DECIMAL(25)，用户点一次「导出 DDL」就把人家的表改了
  { key: 'type', title: '声明类型', cls: 'mono muted', width: 180, render: (c) => c.type },
  {
    key: 'pk',
    title: '主键',
    width: 84,
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
    width: 74,
    render: (c) => (c.nullable ? <span className="muted">—</span> : <Tag>NOT NULL</Tag>),
  },
  {
    key: 'def',
    title: '默认值',
    cls: 'mono muted',
    width: 140,
    render: (c) => c.defaultValue ?? '—',
  },
  // 注释一行显示（bug.txt bug3）：超长的注释折行会让整张表的行高参差、没法扫，
  // 截断 + 悬停 title 看全文。`.ellip` 的规则在 _theme.css
  {
    key: 'cm',
    title: '注释',
    cls: 'ellip',
    width: 260,
    render: (c) =>
      c.comment ? <span title={c.comment}>{c.comment}</span> : <span className="muted">—</span>,
  },
  {
    key: 'java',
    title: 'Java 映射',
    cls: 'mono muted',
    width: 200,
    render: (c) => `${c.javaType} ${c.javaField}`,
  },
]

/** 解析出的表默认全折起：字段表展开会把右栏顶出滚动条，要点再看 */
const firstOpen = (): Record<string, boolean> => ({})

export function DdlImport() {
  const { message, modal } = App.useApp()
  const existing = useSchemaStore((s) => s.tables)
  const importTables = useSchemaStore((s) => s.importTables)

  // 进页面是干净的：输入框不预填示例（2026-08 评审定稿），想试有点示例按钮
  const [sql, setSql] = useState('')
  const [dialect, setDialect] = useState<Dialect>('oracle')
  /** 优化6：每次粘贴 +1，触发「是否导入」确认弹窗（确认即入库，没有第二个手动入口） */
  const [pasteNonce, setPasteNonce] = useState(0)
  /**
   * 刚导入成功的这一帧。当前解析结果的 tableKey 对得上就处于「已导入」态：
   * 预览原样保留、表标签换「已导入」、顶部换结果条；用户一改文本（对不上）
   * 就自然退回普通预览态。added/covered 在入库前算好存进来——入库后
   * store 里人人都是「已有」，再算就全是覆盖了。
   */
  const [imported, setImported] = useState<{ key: string; added: number; covered: string[] } | null>(
    null,
  )

  // 解析没有按钮：改一个字就重算。parseDdl 是纯函数，跑一遍是毫秒级的
  const result = useMemo(() => (sql.trim() ? parseDdl(sql, dialect) : null), [sql, dialect])

  const tableKey = result?.tables.map((t) => t.name).join(',') ?? ''
  const [seenKey, setSeenKey] = useState(tableKey)
  const [open, setOpen] = useState<Record<string, boolean>>(() => firstOpen())
  // 渲染期校正：解析出的表变了就重置展开状态（useEffect 版本会先闪一帧旧内容）
  if (tableKey !== seenKey) {
    setSeenKey(tableKey)
    setOpen(firstOpen())
  }

  const existingNames = new Set(existing.map((t) => t.name.toLowerCase()))
  const covered = result?.tables.filter((t) => existingNames.has(t.name.toLowerCase())) ?? []
  const columnCount = result?.tables.reduce((n, t) => n + t.columns.length, 0) ?? 0
  const constraintFks = result?.foreignKeys.filter((fk) => fk.confidence === 'constraint').length ?? 0
  const namingFks = (result?.foreignKeys.length ?? 0) - constraintFks
  // tableKey 对得上才算「已导入」态；贴回去改一个字就退回普通预览
  const frozen = imported && imported.key === tableKey ? imported : null

  const handleImport = useCallback(async () => {
    if (!result?.tables.length) return
    try {
      // 新增/覆盖必须在入库前算：入库后 store 里人人都是「已有」
      const names = new Set(existing.map((t) => t.name.toLowerCase()))
      const coveredNames = result.tables
        .filter((t) => names.has(t.name.toLowerCase()))
        .map((t) => t.name)
      await importTables(result.tables, result.foreignKeys)
      setImported({
        key: tableKey,
        added: result.tables.length - coveredNames.length,
        covered: coveredNames,
      })
      message.success(`已导入 ${result.tables.length} 张表`)
      // 故意不清空、不跳页：结果条和「已导入」标签留在本页，回干净态点「清空」
    } catch (err) {
      message.error(`导入失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [result, tableKey, existing, importTables, message])

  // 优化6：粘贴建表语句后立刻确认是否导入，确认则直接入库
  useEffect(() => {
    if (pasteNonce === 0) return
    // eslint-disable-next-line react/set-state-in-effect -- 把一次性信号清零，StrictMode 下第二次进 effect 直接跳过，弹窗不会弹两遍
    setPasteNonce(0)
    if (!result?.tables.length) return
    modal.confirm({
      title: `检测到建表语句，是否导入 ${result.tables.length} 张表？`,
      content: '导入将按表名覆盖同名表，字段整体替换。选择「仅预览」可先查看右侧解析结果。',
      okText: '导入',
      cancelText: '仅预览',
      onOk: () => void handleImport(),
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 只盯粘贴计数；result/handleImport 用渲染期最新值，避免重复弹窗
  }, [pasteNonce])

  return (
    <Split even className="ddl-import">
      {/* stretch + fill：左栏只有这一张卡，让它跟着右栏预览的高度一起伸到底，
          输入框不再固定 460px（样式在 _theme.css，.col.stretch / .card.fill） */}
      <Col className="stretch">
        <Card hero
          className="fill"
          title="建表语句"
          who="Oracle / MySQL / PG"
          extra={<DialectSel value={dialect} onChange={setDialect} />}
          tight
          actions={
            <>
              <Lbl>示例</Lbl>
              <Btn variant="mini" onClick={() => setSql(SAMPLE_MYSQL)}>
                填示例
              </Btn>
              <Btn variant="mini" onClick={() => setSql(SAMPLE_ORACLE)}>
                Oracle（PL/SQL 导出）
              </Btn>
              <Btn variant="mini" onClick={() => setSql('')} disabled={!sql}>
                清空
              </Btn>
              <Spacer />
              <Hint>{sql ? `${sql.length} 字符 · ${sql.split('\n').length} 行` : ''}</Hint>
            </>
          }
        >
          <TextArea
            className="flush tall"
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onPaste={() => setPasteNonce((n) => n + 1)}
            placeholder={
              '粘贴 Navicat / DataGrip / PL-SQL Developer 导出的 CREATE TABLE。\n' +
              '可一次粘贴多张表；中间的 DROP / SET 会被跳过。粘贴后右侧即时预览。'
            }
            aria-label="建表语句"
          />
        </Card>
      </Col>

      {/* 右栏空态与左栏同构 Card.fill，虚线区与 textarea 同高同起止；有解析结果再走 rpane */}
      <Col className="stretch">
        {!result ? (
          <Card
            className="fill"
            title="解析预览"
            who="粘贴后即时显示"
            tight
            actions={
              <>
                <Spacer />
                <Hint>左侧粘贴 CREATE TABLE 后此处出预览</Hint>
              </>
            }
          >
            <div className="empty-hero flush">
              <div className="ico" aria-hidden="true"><FileTextOutlined /></div>
              <div className="t">等待建表语句</div>
              <div className="s">
                此处显示表、字段、主键与外键的解析预览。
                <br />
                确认后再写入缓存。
              </div>
            </div>
          </Card>
        ) : (
        <div className="ddl-import-rpane">
        {result.tables.length === 0 ? (
          <Band tone="err" title="未能解析 CREATE TABLE">
            请检查语句是否完整，或切换方言。
            {result.errors[0] && (
              <>
                <br />
                <Mono>{result.errors[0]}</Mono>
              </>
            )}
          </Band>
        ) : frozen ? (
          // 已导入态：结果条在顶上，下面的统计/表/外键照常渲染，标签统一「已导入」
          <Stack gap={8}>
            <Band tone="ok" title={`✓ 已导入 ${result.tables.length} 张表 · ${columnCount} 个字段 · ${constraintFks} 条外键`}>
              <Row>
                <Tag tone="ok">新增 {frozen.added}</Tag>
                {frozen.covered.length > 0 && (
                  <Tag tone="wr">覆盖 {frozen.covered.length}：{frozen.covered.join('、')}</Tag>
                )}
              </Row>
            </Band>
            <Band>预览保留如下。点「清空」可重新导入。</Band>
          </Stack>
        ) : (
          // 普通预览态没有导入按钮（2026-08 定稿：导入只走粘贴确认框这一条路，
          // 不给第二个手动入口）——「先看看」的人看完想导，重新粘贴一次即可
          <Stack gap={8}>
            <Band tone="ok" title={`✓ 解析出 ${result.tables.length} 张表 · ${columnCount} 个字段 · ${constraintFks} 条外键`}>
              <Row>
                {covered.length > 0 && (
                  <Tag tone="wr">会覆盖 {covered.map((t) => t.name).join('、')}</Tag>
                )}
                <Hint>选择「仅预览」后，再次粘贴将重新弹出导入确认。</Hint>
              </Row>
            </Band>
          </Stack>
        )}

        {result && result.tables.length > 0 && (
          <>
            <Card title="解析结果" who={result.warnings.length ? `${result.warnings.length} 条提示` : undefined}>
              <Stack>
                <Stats>
                  <Stat t="表" v={result.tables.length} tone="acc" />
                  <Stat t="字段" v={columnCount} />
                  <Stat t="外键约束" v={constraintFks} tone="ok" />
                  <Stat t="命名推断" v={namingFks} tone={namingFks ? 'warn' : undefined} />
                </Stats>

                {(result.errors.length > 0 || result.warnings.length > 0 || namingFks > 0) && (
                  <Stack gap={8}>
                    {result.errors.map((e) => (
                      <Band key={e} tone="err">
                        {e}
                      </Band>
                    ))}
                    {result.warnings.map((w) => (
                      <Band key={w} tone="info">
                        {w}
                      </Band>
                    ))}
                    {namingFks > 0 && (
                      <Band tone="warn" title={`${namingFks} 条关系由 xxx_id 命名推断`}>
                        非真实外键约束。JOIN 默认不勾选，导出 DDL 亦不输出。
                      </Band>
                    )}
                  </Stack>
                )}
              </Stack>
            </Card>

            <Card
              title="表"
              who={`${result.tables.length} 张 · 默认折起`}
              extra={
                <Row tight>
                  <Btn
                    variant="mini"
                    onClick={() =>
                      setOpen(Object.fromEntries(result.tables.map((t) => [t.name, true])))
                    }
                  >
                    全部展开
                  </Btn>
                  <Btn variant="mini" onClick={() => setOpen({})}>
                    全部收起
                  </Btn>
                </Row>
              }
            >
              {result.tables.map((t) => (
                <Fold
                  key={t.name}
                  open={!!open[t.name]}
                  onToggle={(v) => setOpen((s) => ({ ...s, [t.name]: v }))}
                  head={
                    <>
                      <div className="tline">
                        <span className="tn">{t.name}</span>
                        <Hint>{t.comment || '（无表注释）'}</Hint>
                      </div>
                      <Spacer />
                      <Tag>{t.columns.length} 字段</Tag>
                      {t.javaClass && <Tag>{t.javaClass}.java</Tag>}
                      {frozen ? (
                        <Tag tone="ok">已导入</Tag>
                      ) : (
                        <Tag tone={existingNames.has(t.name.toLowerCase()) ? 'wr' : 'ok'}>
                          {existingNames.has(t.name.toLowerCase()) ? '覆盖' : '新增'}
                        </Tag>
                      )}
                    </>
                  }
                >
                  <Tbl cols={COLS} rows={sortColumnsForUi(t.columns)} rowKey={(c) => c.name} />
                </Fold>
              ))}
            </Card>

            {result.foreignKeys.length > 0 && (
              <Card title="外键" who="真约束 / 命名推断，可信度看每条标签">
                {result.foreignKeys.map((fk) => (
                  <FkLine
                    key={`${fk.fromTable}.${fk.fromColumn}->${fk.toTable}.${fk.toColumn}`}
                    fk={fk}
                    dir="out"
                  />
                ))}
              </Card>
            )}
          </>
        )}
        </div>
        )}
      </Col>
    </Split>
  )
}
