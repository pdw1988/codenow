# CLAUDE.md

这份文件写给在本仓库里干活的 AI 编程助手（Claude Code 等），人看也一样有用。
分层和代码放哪见 [`ARCHITECTURE.md`](ARCHITECTURE.md)；这里记的是改代码时最容易踩的坑。

## 项目

**码上 CodeNow**：Java 开发者的本地桌面工具（Tauri 2 + React 19 + antd 6 + zustand）。
本仓库是开源版；专业版代码在私有的 `pro/` 目录，不在这里（见 ARCHITECTURE.md 第 4 节）。

## 常用命令

```bash
pnpm dev          # 浏览器调界面，localhost:5173，不需要 Rust；连库等 Rust 命令不可用
pnpm tauri:dev    # 桌面窗口
pnpm tauri:build  # 打安装包

# 改完代码全跑一遍
pnpm typecheck
pnpm lint         # oxlint（不是 eslint）
pnpm test         # tsx --test
pnpm build
cd src-tauri && cargo test

# 单个测试文件 / 单条用例
npx tsx --test src/lib/sqlgen/ddlExport.test.ts
npx tsx --test --test-name-pattern "多表：SUM" "src/**/*.test.ts"
```

## 界面文案

1. 内部编号和黑话只许出现在代码注释里；用户看得见的字符串（标题、提示、title、message）用业务语言。
2. 用专业术语：单发叫「调试」不叫「试跑」，运行用例叫「运行」不叫「跑」。新文案先想同类工具
   （Postman / Apifox / Navicat）管这叫什么。
3. **禁用的控件必须给出「为什么」**（title 或点了 toast 原因）。Windows 上原生 `disabled` 连 title 都不出，
   发灰但仍要点的用 `Btn.blocked` / `.is-off`。

## 开源版 / 专业版边界

- `src/`、`src-tauri/src/` 不准直接引 `pro/`，只能经 `@pro`（前端）和 `#[cfg(pro)]`（Rust）。
- `@pro` 在没有 `pro/` 时指向 `src/pro-stub/`，导出名必须和专业版一一对应。
- `pnpm typecheck` 里的 `tsconfig.app.free.json` 强制按开源版再查一遍，不要删。
- 强制按开源版编：环境变量 `CODENOW_FREE=1`（vite 和 `build.rs` 都认）。
- 许可码只验不签：`license.rs` 里只有 Ed25519 公钥，**不要把任何私钥或对称钥匙写进仓库**。
  开发模式不锁，打包才锁；手拨在 `src/lib/license.ts` 的 `LICENSE_OVERRIDE`（提交时必须是 `null`）。

## Rust 侧

- **缓存库 migration 只增不改**。前端 `sqliteStore.ts` 的每条 SQL 都对着 `lib.rs` 的表结构写，
  改结构两边一起动，并新增一条 Migration。新的持久化数据优先存 `cache_metadata` 的 JSON。
- **`sql:default` 只放行读**。写 `cache.db` 要 `sql:allow-execute`；缺它时读全正常、只有写入报
  `not allowed by ACL`，前端闸门照不到。
- **capabilities 编进二进制**，改了必须重跑 `tauri dev` / `build`。加了命令忘了放行，报的是
  `xxx not allowed`，跟库能不能连无关。
- **连用户的库不走 plugin-sql**，走 `oracle.rs` / `mysql.rs` / `postgres.rs` / `sqlite.rs` 自写命令。
  - 查询 `*_query` 的闸门在 `sql_readonly.rs`：只放行 SELECT / WITH / SHOW，行数先封顶 200，「加载全部」最多 1 万。
  - 写走独立命令：`*_delete_rows`（带 WHERE 的 DELETE）、`*_update_rows`（带 SET + WHERE）、
    `*_insert_rows`（带 VALUES，挡住 INSERT … SELECT）、`*_exec_sql`、`*_exec_ddl`（只放行
    ALTER TABLE / COMMENT ON / CREATE INDEX / ANALYZE）。前端 `sqlExec.ts` / `sqlAlter.ts` 和 Rust `sql_write.rs`
    **两份白名单一起改**。
  - **不要让 `query` 跑写语句，也不要扩 `exec_sql` 去跑 SELECT。**
  - Oracle 两路：官方 `oracledb`（纯 Rust，12.1+ 免客户端）被拒后走 `oracle` crate + Instant Client；
    只塞一个 `oci.dll` 连不上，21c / 23c 客户端连不了 11g。
  - PostgreSQL 云库要求 SSL 时先 NoTls 被拒再走 native-tls。
- **记住的密码**走 `cred.rs`：Windows DPAPI 文件，macOS / Linux 钥匙串。密码不进 JSON 也不进 `cache.db`；
  写失败必须提示，不要空 catch。
- release 版不挂日志插件（只在 `debug_assertions` 下注册），桌面包里排查靠界面报错文案。

## 前端分层

```
lib/       纯函数，无 React、无存储依赖 → 所有业务逻辑在这里，因此可单测
storage/   MetaStore 接口 + 实现
store/     zustand，只负责「把 MetaStore 的数据搬进内存并保持同步」
features/  页面，按功能分目录
```

**计算不进 store**：搜索、SQL 生成、DDL 解析全在 `lib/` 下做成纯函数，这样才能被 `node:test` 直接测到。

### 存储抽象层

- `SqliteStore` —— tauri-plugin-sql，**必须动态 import**（顶层引了 tauri 插件，静态引入会让浏览器模式整个崩掉）。
- `LocalStorageStore` —— 浏览器模式默认。继承 `MemoryStore` 复用全部增删语义，只加「读档 / 写档」。
  改「清空缓存」「外键级联」这类共享语义**只改基类**。
- `MemoryStore` —— localStorage 不可用时的最后兜底。

`initStore()` 按 `window.__TAURI_INTERNALS__` 选实现，降级链 SQLite → localStorage → 内存，做了 in-flight 去重。
**`getStore()` 在 `initStore()` 完成前返回默认的 MemoryStore**：启动期读数据的 store，`reload()` 里要
`await initStore()`，否则在 Tauri 里会读到 localStorage 而不是 SQLite。

### 外键两级可信度（贯穿全项目）

- `confidence: 'constraint'` —— 真实 `FOREIGN KEY` 约束，**默认勾选**
- `confidence: 'naming'` —— 从 `xxx_id` 命名推断，**默认不勾选**

推断可能是错的，让它默认参与 JOIN 等于悄悄生成错 SQL。新功能要保持这个区分（导出 DDL 只输出 `constraint`；
造数排序也只认 `constraint`）。

### SQL 生成没有「生成」按钮

目前导航里体现在批量 INSERT（单表 / 多表页暂不在导航，规则同样适用）。配置一改就在 `useMemo` 里重算，所以 `lib/sqlgen/` 下的函数必须是快的纯函数。
**自动值不进 state**，state 里只有用户手改过的那几个。

## 几个必须知道的坑

### 每个页面最外层必须包 `Page`

`Page`（`components/shell/Page.tsx`）渲染顶栏和 `.pane` 滚动容器。**漏包的话闸门照样全绿**，但超出首屏的
内容被 body 的 `overflow:hidden` 裁掉：卡片「不见了」、页面「滚不动」。空状态的提前 return 分支也要套。

### 产物必须首屏可见

用户来是为了复制结果，右栏 / 主列**第一张卡永远是生成结果**；值表、模板、长字段表放下面或默认折起。

### 勾选

**有「全选」必须有「全不选」**。`null` = 还没动过（走默认），`[]` = 用户明确清空，不要用同一个空值表示两种意思。
字段勾选 / 下拉的**展示顺序**：主键 → 唯一键 → 普通索引 → 日期相关 → 其余，每档按字段名排（`sortColumnsForUi`）；
生成 SQL、导出 DDL 仍用表里的原顺序。

### antd 6，不是 v5

API 改名：`Space.direction`→`orientation`、`Space.split`→`separator`、`Alert.message`→`title`、
`Statistic.valueStyle`→`styles.content`、`Modal.destroyOnClose`→`destroyOnHidden`。`List` 已废弃，用了刷控制台警告。

DOM 类名也变了，照 v5 写的 CSS 会**静默不命中**：

| v5 | antd 6 |
|---|---|
| `.ant-tabs-tabpane` | `.ant-tabs-content`（激活的加 `-active`） |
| `.ant-tabs-content-holder` | `.ant-tabs-body-holder` |
| `.ant-select-selector` | `.ant-select-content` |

`aria-hidden` 在激活的 pane 上也存在，判「当前可见 pane」靠 `.ant-tabs-content-active` + `offsetParent`。
toast 用 `App.useApp()` 拿 `message`，不用静态方法（拿不到主题 context）。

### 外观只在 `mockup/_theme.css`

全应用样式在 `mockup/_theme.css`（CRLF），不在 `src` 里。组件规则只读 CSS 变量，不写死颜色。

### 方言差异只准写在 `dialect.ts` 里

`DialectSpec` 已有 `quote` / `paginate` / `now` / `today` / `dateLiteral` / `boolLiteral`。`paginate` 吃整句
SELECT：MySQL / PG 末尾加 LIMIT，Oracle 用 ROWNUM 外包（不要拼 `OFFSET FETCH`，11g 会 ORA-00933）。
在调用点写 `dialect === 'oracle' ? … : …` 的代价是同一条规则有两份、只修好一份。
连库页同理：接入新库写 `src/lib/dbDialects/<方言>.ts` 并在 `dbDialect.ts` 登记，不要在壳里写 `if (kind === 'mysql')`。

### 造值的字典只有一份：`lib/sqlgen/mockValue.ts`

出 SQL（`autoValue`）和码上测（`mockValueOfField`）共用同一张名字规则表，不建第二份。
只对 String 类 javaType 走字典：`Integer` 拿到 `"T00000001"`、`Boolean` 拿到 `"0"` 都是 400。
`autoValue` 的取值被单测钉死，改字典时别让它变。

### 造数 / 清理的顺序：造数 → 快照 A → 请求 → 快照 B → 清理

`lib/apiforge/data/prepare.ts` 的清理只能在第二个快照之后，否则删自己造的行会被记成「接口删了数据」。
**只删自己造的行**，定位不到就在报告里写「未自动清理」，绝不退化成按范围删。造数默认关：它会往真库写，
要合进「写操作一次总确认」。

### 生成 WHERE：空值是 `IS NULL`，永远不是 `= NULL`

`col = NULL` 恒为 unknown：查不出、删不掉，而且不报错。`executable.ts` 的 `renderCondition()` 统一处理了，
新写任何拼 WHERE 的代码都复用它。

### 改 `lib/search.ts` 的权重

`WEIGHTS` 故意不导出，用例断的是相对顺序。Java 类名只「包含」关键字时不能给高分（类名普遍带
`Entity` / `DTO` 后缀）。`PinyinMatch.match()` 对原文也返回 true，字面命中时要跳过拼音判断。

### oxlint 的 `react(set-state-in-effect)`

props 变化时重置 state，用渲染期校正：

```tsx
const [seen, setSeen] = useState(prop)
if (prop !== seen) { setSeen(prop); setSomething(...) }
```

`useEffect` 版会先用旧值渲染一帧，视觉上是一次闪烁。

### node-sql-parser 是 CJS

```ts
import pkg from 'node-sql-parser'
const { Parser } = pkg
```

- `plsql` 根本不支持，`DIALECT_MAP.oracle` **故意映射成 `'mysql'`**。
- 不认识的类型词是**整条语句报废**，不是跳过一列。
- postgresql 的 AST 把列名包成 `{expr:{type:'default',value:'id'}}`，取列名要归一化。

### Oracle DDL 走 `lib/oracleDdl.ts` 预处理

预处理无条件跑（对纯 MySQL 是恒等变换）。改它前先读：

- `TYPE_FIXES` 和 `CLAUSE_FIXES` 分开，不要合并；`isRepairedType()` 只查前者。
- 替换一律走 `replaceInCode()`（掩掉字符串和注释），引号扫描器只准有一份。
- 顺序有讲究：`NVARCHAR2` 在 `NVARCHAR` 前、`LONG RAW` 在 `RAW` 前。
- 用户原样写的类型要盖回去（`declaredTypes`），否则导出 DDL 会改掉人家表的字段类型。
- 存储子句用白名单删（`CREATE_TAIL`），不要「砍掉右括号后面的东西」：MySQL 的表注释也在那。
- `NUMBER(1)` 不映射成 Boolean（可能取 0/1/9）；`NUMBER(25)` 不给 Long（溢出不报错）。

### 日志转 SQL：不能假设「SQL 之后剩下的行都是参数」

（该页当前不在导航，代码保留）

从控制台框选复制时 SQL 行的 `Preparing:` 前缀常漏掉，参数行的日志头却完整，整段日志头会变成第 1 个参数，
后面全部错位且语句照样能跑。所以 `parsePlainBlock` 先把每行分成 `sql` / `params` / `noise` 再判边界；
`stripLeadingLogHead` 切完必须以 SQL 关键字开头才算成功。粘贴从 `clipboardData` 取，`onPaste` 时 `textarea.value` 还是旧的。
`lib/sqlgen/sqlFormat.ts` 的换行**只加空白不改字符**（有「去掉空白后与原文相等」的不变量用例）。

### tsconfig 是多个子工程

根 `tsconfig.json` 只有 references：app / app.free / node / test / cli。`tsconfig.app.json` 排除了 `*.test.ts`
（测试要 `@types/node`，走 `tsconfig.test.json`）。`tsc -b` 报「找不到 node 类型」是文件落错了子工程。

## 验证：闸门全绿不够

本项目最严重的几个 bug（逗号被行尾注释吃掉、多表输出列名撞车导致 ResultSet 静默覆盖、DDL 往返时注释里的
单引号每次翻倍）都是在闸门全绿时发现的。写生成器相关的测试不要只比字符串：

| 验证什么 | 用什么 |
|---|---|
| 生成的 DDL / SQL 语法真能跑 | `node:sqlite` 的 `DatabaseSync(':memory:')` |
| 生成的 DDL 信息无损 | 再喂回 `parseDdl`，断言原样还原 |
| 界面在真浏览器里的行为 | `e2e.mjs`（Node 内置 WebSocket 驱 CDP） |

`e2e.mjs` 跑法（三个终端）：

```bash
pnpm dev
msedge --remote-debugging-port=9333 --headless=new --window-size=1440,900
pnpm e2e
```

`--window-size` 不能省：窗口一窄导航文字会被响应式规则藏起来。写 e2e 的坑：

- Select 监听 `mousedown`，`click()` 打不开下拉，要依次派发 `mousedown` / `mouseup` / `click`。
- 两个汉字的按钮 antd 会插空格（「取 消」），按文字找先去空白。
- 找元素限定在当前页（`.pagehost:not([hidden])`），不查整个 document：别的页也在 DOM 里，可能有同名按钮。
- 表格按栏目标题定位，不按下标；导航按钮按 `textContent` 找。
- 每次跑前 `localStorage.clear()` 再刷新（当前页会被持久化）。
- 弹窗按钮在弹窗自己的 `.acts` 里，不在 `.ant-modal-footer`。
- **选择器失败必须 `throw`，不准静默降级**；断言挑能证伪的量。

> 写临时探针脚本用文件，不要用 heredoc：heredoc 会把 `\\s` 折成 `\s`，正则静默失效。

## 注释风格

代码注释是中文，**解释「为什么」而不是「做了什么」**，尤其是不这么写就会踩的坑。测试用例名也是中文，
每条对应一个真踩过的坑。不要用 prettier 之类格式化整个文件。
