/**
 * 功能页的元信息：图标、导航名、顶栏标题和副标题。
 *
 * 集中在这里而不是散在各页组件里，是为了让**左侧导航和顶栏标题不可能不一致**
 * ——两处各写一份的话，改名只改一处，用户看到的是「点了 A 进到 B」。
 *
 * 图标是 @ant-design/icons 的组件引用（Outlined 一套到底），不再是 emoji：
 * 彩色 emoji 在 Windows 上自带系统配色，跟任何主题都不搭，是「个人作品感」
 * 最重的一处。存组件引用而不是 emoji 字符串，图标跟着主题的 currentColor 走。
 *
 * 数组顺序 = 页面挂载顺序。左侧怎么分组看 `NAV`：数据库相关全收「码上查」一大组，
 * 「码上写」（三种配置格式互转）和「码上测」各自独立一级，正则 / JSONPath
 * 收在末尾的「小工具」组。
 */
import type { ComponentType } from 'react'
import {
  ApiOutlined,
  BookOutlined,
  BulbOutlined,
  ClockCircleOutlined,
  CloudServerOutlined,
  CodeOutlined,
  CompassOutlined,
  DatabaseOutlined,
  FormOutlined,
  HddOutlined,
  ImportOutlined,
  InboxOutlined,
  KeyOutlined,
  ProfileOutlined,
  SearchOutlined,
  TableOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from '@ant-design/icons'
import type { TabKey } from '../../store/useUiStore'

export interface PageMeta {
  key: TabKey
  icon: ComponentType<{ className?: string }>
  /** 左侧导航里的名字，短 */
  label: string
  /** 顶栏标题（纯文字；图标由 Page 顶栏单独渲染） */
  title: string
  /** 顶栏副标题：一句话说清这一页的规则，不要写「欢迎使用」那种废话 */
  sub: string
}

export const PAGES: readonly PageMeta[] = [
  {
    key: 'import',
    icon: ImportOutlined,
    label: '导入表结构',
    title: '导入表结构',
    sub: '粘贴即解析 · 右侧预览 · 确认后写入缓存',
  },
  {
    key: 'schema',
    icon: SearchOutlined,
    label: '查看表结构',
    title: '查看表结构',
    sub: '表名 / 注释 / 字段 / Java 类 / 拼音',
  },
  {
    key: 'batch-insert',
    icon: InboxOutlined,
    label: '批量 INSERT',
    title: '批量 INSERT',
    sub: '造测试数据 · 字段规则 · 逐条 / 多 VALUES / 分批',
  },
  {
    key: 'dbquery',
    icon: TableOutlined,
    label: '连库查询',
    title: '连库查询',
    sub: '点表立刻查 · 勾列与条件在 SQL 下 · 勾选复制、更新、删除，或插入一行',
  },
  {
    key: 'redis',
    icon: HddOutlined,
    label: 'Redis',
    title: 'Redis',
    sub: '按前缀分组看键 · 文本 / JSON / 十六进制 · 改值、过期、命令窗口 · 生产默认只读',
  },
  {
    key: 'dbadvice',
    icon: BulbOutlined,
    label: '优化记录',
    title: '优化记录',
    sub: '每次跑 SQL 记一笔 · 看建议怎么变的 · 哪条规则老犯',
  },
  {
    key: 'dbconns',
    icon: ApiOutlined,
    label: '我的连接',
    title: '我的连接',
    sub: '起名收藏地址 · 测试/本地可记住密码 · 生产每次现输',
  },
  {
    key: 'sqlfav',
    icon: BookOutlined,
    label: '我的SQL库',
    title: '我的SQL库',
    sub: '收藏 SQL 成品 · 名称 / 标签 / 表名 / 内容检索 · JSON 备份',
  },
  {
    key: 'config',
    icon: FormOutlined,
    label: '配置转换',
    title: '配置转换',
    sub: 'YAML ↔ Properties ↔ JSON 粘贴即转 · 注释保活 · 校验报行号 · Spring 智能提示',
  },
  {
    key: 'apiforge',
    icon: ThunderboltOutlined,
    label: '码上测',
    title: '码上测',
    sub: '一键扫出 Spring Boot 全部接口 · 喂给 AI 写单测 · 一键回归',
  },
  {
    key: 'jsonpath',
    icon: CompassOutlined,
    label: 'JSON查看',
    title: 'JSON 查看',
    sub: '粘贴即格式化 · 树形展开折叠 · 搜索定位到节点',
  },
  {
    key: 'cron',
    icon: ClockCircleOutlined,
    label: 'Cron表达式',
    title: 'Cron 表达式',
    sub: '粘贴即解读 · 推算后续触发时间 · 常用示例一键填入',
  },
  {
    key: 'logview',
    icon: ProfileOutlined,
    label: '日志查看（码上追）',
    title: '码上追 · 日志查看',
    sub: '本机大日志文件秒开 · 按 logback pattern 拆列过滤 · 堆栈折叠，不用部署任何东西',
  },
  {
    key: 'term',
    icon: CodeOutlined,
    label: 'SSH 终端（码上连）',
    title: '码上连 · SSH 终端',
    sub: '应用里直接开交互式终端 · 常用服务器一键连 · vim/htop 全屏可用',
  },
  {
    key: 'vault',
    icon: KeyOutlined,
    label: '常用信息',
    title: '常用信息',
    sub: 'VPN / 堡垒机 / 生产库的账号地址收在一处 · 逐个复制 · 密码加密存本机',
  },
]

/**
 * 左侧导航的树。PAGES 只描述「这一页叫什么」；谁跟谁合成一级菜单在这里。
 *
 * 2026-09-13 起数据库相关页全部收进「码上查」一个大组（马上查：表结构 /
 * 生成 SQL / 收藏 / 连库都在里面），接口模块「码上测」独立一级。
 */
export type NavNode =
  | { type: 'group'; id: string; icon: ComponentType<{ className?: string }>; label: string; keys: readonly TabKey[] }
  | { type: 'page'; key: TabKey }

export const NAV: readonly NavNode[] = [
  {
    type: 'group',
    id: 'db',
    icon: DatabaseOutlined,
    label: '码上查',
    keys: [
      'import',
      'schema',
      'batch-insert',
      'sqlfav',
      'dbconns',
      'dbquery',
      'redis',
      'dbadvice',
    ],
  },
  /* 独立一级，排在最末：它自己页内有七个子页签（首页/扫描/接口库/关联表/报告/压测/环境），
     跟「码上查」里同级并列的页不是一类，收进组里会多一层 */
  { type: 'page', key: 'apiforge' },
  /* 码上运维（查 → 写 → 测 → 运维）：都是「上服务器干活」，共用常用服务器名册和凭据库。
     2026-10-10 用户定的合并（之前码上追、码上连各自一级） */
  {
    type: 'group',
    id: 'ops',
    icon: CloudServerOutlined,
    label: '码上运维',
    keys: ['logview', 'term'],
  },
  /* 常用信息 2026-10-30 加（用户：每次去找文本太麻烦）。查/测/运维哪条线都会用到，
     不归任何一组，独立一级排在小工具前面 */
  { type: 'page', key: 'vault' },
  /* 小工具（码上写 2026-10-11 并进来排第一，同日改名「配置转换」——进了小工具就按
     功能叫，跟 JSON查看 / Cron表达式 一个口径；「码上写」这个名字随 查→写→测 的
     独立一级一起退役）：都是「手上的活干到一半要转一下 /
     验一下」的顺手工具，跟码上查/测/运维三条主线都不是一类，塞进任何一组都会让那组的
     主题变糊。排在最末——它们是旁路，不是主流程上的一步。
     码上写为什么降级：它再扎实也是一个转换器，撑不起和「码上测」（七个子页签的模块）
     平级的独立一级；但它又是 Spring 开发的周期性刚需，藏起来比多一次点击更亏——
     进小工具，名字不变，品牌不丢。
     2026-09-22：正则测试器 / JSONPath 查询曾以「小工具」组回来，同日码上写补 JSON 格式。
     2026-09-22：Cron 表达式生成器进「小工具」组（PRD 二十，v6.4 清单里排 P2 的那条）。 */
  {
    type: 'group',
    id: 'tools',
    icon: ToolOutlined,
    label: '小工具',
    keys: ['config', 'jsonpath', 'cron'],
  },
]

/**
 * 2026-08-28 收敛菜单时暂退了 sqlgen / s2u / batch / sqlfav 四条；同日 sqlfav
 * 随「日志转SQL 结果卡的 ⭐ 收藏」恢复进导航——收藏了得有地方看，条目原文
 * 从 git 历史（948345c^）取回。
 * 2026-10-11：批量 INSERT 回归（用户：造测试数据是常干的活），位置照旧在
 * 「查看表结构」后面——码上查组内现在是一条线：导进来 → 看 → 从表造数据 →
 * 资产（收藏 / 连接）→ 查数据 → 报告。批量 UPDATE 等其余五页照旧暂退。
 * 2026-10-10：正则测试器暂退（用户：用处不大）。页面组件 / TabKey / VIEWS 都留着，
 * 要回来补回 PAGES 一条（key 'regex'、图标 CodeOutlined、名「正则测试器」）和小工具组的 key。
 * 2026-10-10：日志转SQL（logfill，FileSearchOutlined）、SELECT转UPDATE（s2u，SwapOutlined）
 * 同日暂退，原来在码上查组「批量 UPDATE」后面。跨页入口（连库查询「转 UPDATE」、
 * 批量 UPDATE「从 SELECT 导入」）用 pageInNav('s2u') 门着，补回导航就自动出现。
 * 2026-10-10：单表 SQL（sqlgen-single，FileTextOutlined）、多表关联（sqlgen-multi，
 * ApartmentOutlined）、批量 INSERT（batch-insert，InboxOutlined）、批量 UPDATE（batch-update，
 * EditOutlined）同日暂退，原来在码上查组「查看表结构」后面。速查卡「生成 SQL」照旧由
 * pageInNav('sqlgen-single') 门着。
 * 2026-09-22：正则测试器 / JSONPath 查询以「小工具」组回来，同日码上写补 JSON 格式。
 * 2026-09-22：Cron 表达式生成器进「小工具」组（PRD 二十，v6.4 清单里排 P2 的那条）。
 * 它跟正则 / JSONPath 一样是「手上的活干到一半要验一下」，不进三条主线。
 * 2026-09-22：优化记录进「码上查」，排在连库查询后面——它记的就是连库那页每次
 * 跑出来的建议，两个页是「体检」和「报告」的关系，得挨着。
 * 2026-08-30：导航收成三组。连库查询+我的连接 →「连库」；批量 / 日志转SQL /
 * SELECT转UPDATE 在「生成 SQL」组；我的SQL库独立一级（在连库上面），避免被底栏顶出视口。
 * 2026-09-22：组内「我的连接」与「连库查询」对调——选连接是入口，排在查数据前面。
 * 2026-08-30：s2u 加回导航，布局改成贴完先看见 UPDATE。
 * 2026-08-29：batch 拆成 batch-insert / batch-update 两条加回导航——原来
 * 一页用段切换藏半屏卡片，造测试数据和改已有行挤在一起。
 * 唯一的跨页入口是速查卡的「生成 SQL」按钮，TableCard 用
 * pageInNav('sqlgen-single') 门着 —— 它统一跳单表页（JOIN 要用户自己点菜单过去）。
 */

const BY_KEY = new Map<TabKey, PageMeta>(PAGES.map((p) => [p.key, p]))

export const pageMeta = (key: TabKey): PageMeta => BY_KEY.get(key)!

/**
 * 这一页在不在导航里。给暂退页的跨页入口用（速查卡的「生成 SQL」）：
 * 页面下架后按钮要是不跟着藏，点了就是把主区切到一片空白——
 * 比点不动更糟，用户不知道发生了什么。
 */
export const pageInNav = (key: TabKey): boolean => BY_KEY.has(key)
