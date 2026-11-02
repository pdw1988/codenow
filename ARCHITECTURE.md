# 技术架构

> 回答两个问题：**这套东西是怎么搭的**、**新代码该往哪放**。踩坑细节在 [`CLAUDE.md`](CLAUDE.md)。

## 0. 一句话定位

**单进程本地桌面应用，没有服务端。** 前端（React）跑在 Tauri 的 WebView 里，「后端」是同一进程里的 Rust：
本机 SQLite 存缓存，连用户的数据库 / Redis、读大文件、加密凭据都是 Rust 命令。
没有账号、没有遥测；联网只发生在用户自己配的库 / 接口地址，和官方包的检查更新。

## 1. 技术选型

| 位置 | 用什么 | 别乱动的原因 |
|---|---|---|
| 界面 | React 19 + antd 6 + zustand 5 | **antd 是 6 不是 5**：API 改名、DOM 类名全变，照 v5 抄的 CSS 会静默不命中 |
| 语言 | TypeScript 6 | 多个子工程（见 6 节），app 侧没开 `strict` |
| 构建 | Vite 8 | `mockup/` 是设计稿，不进构建；但 `mockup/_theme.css` 是全应用主题，`main.tsx` 会引它 |
| SQL 解析 | node-sql-parser | CJS；`oracle` 故意映射成 `mysql`（它不支持 plsql），预处理见 `lib/oracleDdl.ts` |
| 拼音搜索 | pinyin-match | `match()` 对原文也返回 true，字面命中时要跳过 |
| 桌面壳 | Tauri 2 | Windows 出 NSIS，macOS 出 DMG |
| 本机缓存 | tauri-plugin-sql（sqlite，bundled） | 只给 `cache.db` 用，**不准拿去连用户的库** |
| 连用户的库 | `oracledb` + `oracle`（11g 走 Instant Client）/ `mysql` / `postgres` / `rusqlite` | 都是自写只读 / 写分离的命令，见 3.2 |
| Redis | `redis` crate（单机 / 哨兵 / 集群） | 同步 API + `spawn_blocking`，跟别的驱动一样 |
| 许可 | `ed25519-dalek` | 只验公钥，私钥不在仓库 |
| Lint / 测试 | oxlint、`tsx --test`（`node:test`） | 不是 eslint、不是 vitest；`node:sqlite` 能把生成的 SQL 真跑一遍 |
| E2E | `e2e.mjs` | Node 内置 WebSocket 驱 CDP，不装 puppeteer / playwright |

**加新依赖之前先问一句**：能不能用上面这些 + Node / Rust 标准库做出来？

## 2. 前端

### 2.1 四层，依赖只准从上往下

```
features/  页面，按功能分目录：importer schema sqlgen batch s2u logfill sqlfav dbconns
           config redis logview apiforge（码上测）tools vault
           （sqlgen 单表/多表、s2u、logfill、batch 里的批量 UPDATE 暂不在导航，代码保留，
            导航见 components/shell/pages.ts）
    │      只组装和展示：读 store、调 lib、把结果画出来
    ▼
store/     zustand：把存储里的数据搬进内存并保持同步，一行计算都不放
    ▼
storage/   MetaStore 接口 —— 前端唯一的存储依赖
             SqliteStore        Tauri 里；必须动态 import（静态引会把浏览器模式搞崩）
             LocalStorageStore  浏览器里；Tauri 里 SQLite 起不来时的降级
             MemoryStore        localStorage 也不可用时的最后兜底

lib/       纯函数：无 React、无存储依赖，业务逻辑全在这，测试就放在旁边（*.test.ts）
             ddlParser oracleDdl search sqlgen/ log/ redis/ apiforge/ dbDialects/ …
           *Ipc.ts 是调 Rust 命令的薄壳，不放规则
```

| 层 | 准 | 不准 |
|---|---|---|
| `features/` | 组装组件、绑事件、把 lib 的结果画出来 | 写业务规则；直接 import `sqliteStore` |
| `store/` | CRUD 转发、`reload()`、跨页上下文 | 任何计算 |
| `storage/` | 实现 `MetaStore`、按环境选实现、降级 | 掺业务语义 |
| `lib/` | 全部业务逻辑 | import React / storage、读全局状态 |

写新代码先问：**这段能不能不带 React 写？** 能，就落 `lib/`。逻辑写进组件里就只能靠点界面来验。

### 2.2 壳

`components/shell/`：`AppShell` + `Rail`（左侧导航）+ `TitleBar` + `Page`。所有页面同时挂在 DOM 里，
靠 `hidden` 切换。**每个页面最外层必须包 `<Page tab=…>`**，它提供滚动容器 `.pane`，漏了内容会被裁掉。

### 2.3 主数据流

```
粘 DDL / 连库读字典 / 扫源码
  → lib/oracleDdl（无条件预处理，对纯 MySQL 是恒等变换）→ lib/ddlParser → TableInfo[] + ForeignKey[]
  → useSchemaStore.importTables() → MetaStore → cache.db
  → lib/search（表名 / 注释 / 字段 / Java 类 / 拼音首字母）
  → useUiStore.jumpToSqlGen(...)   ← 跨页传上下文只走这个口子
  → lib/sqlgen/*（useMemo 实时重算，没有「生成」按钮）
```

「日志转 SQL」（当前不在导航）是**独立的第二条流**，不读表结构缓存：没导过表也能用。

### 2.4 状态放哪

- **自动造的值不进 state**，只存用户手改过的。存一整份等于埋一个「表结构变了值还是旧的」不一致点。
- props 变化要重置 state 用**渲染期校正**，不用 `useEffect` + `setState`（会闪一帧，oxlint 也拦）。
- 可勾选集合区分 `null`（没动过 → 默认）和 `[]`（明确清空）。

## 3. Rust 侧（`src-tauri/`）

### 3.1 文件

```
src/lib.rs            注册插件、命令、migration；专业版命令用 #[cfg(pro)] 隔开
src/oracle.rs mysql.rs postgres.rs sqlite.rs   连用户的库
src/sql_readonly.rs   查询闸门：只放行 SELECT / WITH / SHOW，行数封顶
src/sql_write.rs      写闸门：DELETE / UPDATE 必须带 WHERE；DDL 只放行 ALTER / COMMENT ON / CREATE INDEX / ANALYZE
src/redis_client.rs   Redis
src/log_file.rs       本机大日志分块读
src/cred.rs           记住的密码：Windows DPAPI 文件，macOS / Linux 钥匙串
src/apiforge*.rs      码上测：调扫描器 jar、发 HTTP
src/desktop.rs        托盘、全局快捷键 Ctrl+Shift+D
src/license.rs        许可码验签（公钥）
src/ssh_tunnel_free.rs 开源版里 SSH 隧道的占位（调用就报「专业版功能」）
capabilities/         权限；编进二进制，改了要重跑 tauri dev / build
build.rs              有 ../pro/src-tauri 就设 cfg(pro)
```

### 3.2 连用户的库：读写分开

- 查询命令 `*_query` 只跑只读语句；写走独立命令（`*_delete_rows` / `*_update_rows` / `*_insert_rows` /
  `*_exec_sql` / `*_exec_ddl`），每条都有前端（`lib/sql*.ts`）+ Rust（`sql_*.rs`）**两份闸门，白名单一起改**。
- **不要让 `query` 跑写语句，也不要让写命令跑 SELECT。**
- 不走 tauri-plugin-sql：`sql:allow-execute` 是给本机 `cache.db` 的，拿它连业务库等于开了任意写。

### 3.3 缓存库 migration

`cache.db` 的表结构在 `lib.rs` 里按版本号排（目前到 v3）。**改结构只能新增一条 Migration，不准改旧的** ——
老用户的库已经按旧版本建好，不会重跑。新的持久化数据优先塞 `cache_metadata` 这张 key-value 表存 JSON。

## 4. 开源版与专业版

本仓库是开源版。专业版代码在私有的 `pro/` 目录（不在本仓库），编译时自动识别：

| | 有 `pro/` | 没有 `pro/`（开源仓库） |
|---|---|---|
| 前端 `@pro` | `pro/src/index.ts` | `src/pro-stub/`（专业版页签显示说明卡） |
| Rust | `build.rs` 设 `cfg(pro)`，注册专业版命令 | 不注册；`ssh_tunnel_free.rs` 顶替 |
| 强制按开源版编 | 设环境变量 `CODENOW_FREE=1` | — |

规矩：

- `src/` 和 `src-tauri/src/` **不准 import `pro/` 里的东西**，只能经 `@pro` 这一个口子。
- `src/pro-stub/index.ts` 的导出名要和专业版一一对应；新加一个专业版导出，占位这边同时加。
- 专业版功能的入口在开源版里也要能点：点了出说明卡，不要让按钮消失或报错。

## 5. 新增一个功能，按这个顺序

1. 业务规则写成 `lib/` 下的纯函数，同时写测试（中文用例名，一条对应一个真会踩的坑）。
2. 要持久化？先看能不能塞 `cache_metadata`；真要新表就加 migration。
3. 要新 store 字段？只放「用户改过的」和「跨页要传的」，算出来的一律 `useMemo`。
4. UI 落 `features/<功能>/`，最外层 `<Page tab=…>`；toast 用 `App.useApp()` 拿 `message`。
5. 要碰用户的库 / 文件？加 Rust 命令 + capabilities 权限，写操作要有闸门和二次确认。
6. 跑验证（第 6 节）。

### 硬规矩（每条都踩过）

| 规矩 | 不守的后果 |
|---|---|
| 方言差异只写在 `lib/sqlgen/dialect.ts` 的 `DialectSpec` | 同一条规则两份，只修好一份 |
| 拼 WHERE 一律走 `renderCondition()` | `col = NULL` 恒为 unknown：查不出、删不掉，还不报错 |
| 外键分 `constraint`（默认勾）/ `naming`（默认不勾） | 命名推断参与 JOIN = 悄悄生成错 SQL |
| 引号扫描器只准有一份（`replaceInCode()` / `codeMask`） | `default 'NUMBER'` 里的用户数据被当成类型词替换 |
| 用户原样写的类型文本要盖回去（`declaredTypes`） | 导出 DDL 一执行就改了人家表的字段类型 |
| 造值字典只有一份（`lib/sqlgen/mockValue.ts`） | 出 SQL 和码上测造出的值不一致 |
| 禁用的控件要说明为什么 | 点了没反应比报错更让人困惑 |
| 有全选就有全不选；`null` ≠ `[]` | 有一种状态表达不出来 |

## 6. 验证

```bash
pnpm typecheck    # tsc -b：app / app.free（按开源版再查一遍）/ node / test / cli 五个子工程
pnpm lint         # oxlint
pnpm test         # tsx --test
pnpm build        # typecheck + vite build
cd src-tauri && cargo test
```

**这几道闸门证明不了「生成的 SQL 能跑」。** 生成器相关的测试要真执行：

| 验证什么 | 用什么 |
|---|---|
| 生成的 DDL / SQL 语法真能跑 | `node:sqlite` 的 `DatabaseSync(':memory:')` |
| 生成的 DDL 信息无损 | 再喂回 `parseDdl`，断言字段 / 主键 / 注释 / 默认值原样还原 |
| 界面在真浏览器里的行为 | `e2e.mjs` |

断言挑**能证伪**的量，选择器失败必须 `throw`，不准静默降级。

## 7. `mockup/`

界面设计稿，双击 `index.html` 能开，不参与构建。例外是 **`_theme.css`：全应用的外观都在这里**
（主题变量 + 组件样式，组件规则只读 CSS 变量，不写死颜色），改外观改这一个文件。
