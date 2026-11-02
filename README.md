# 码上 CodeNow

**Java 开发者的桌面工具箱**：表结构速查、造测试数据、连库查询、Redis、日志查看、接口测试，一个窗口里干完。
全部在本机算，表结构、连接、密码都不出你的电脑。

[下载安装包](https://pdw1988.github.io/devtools-releases/) ·
[Gitee 下载（国内快）](https://gitee.com/pdwcloud/devtools-releases/releases) ·
[源码国内镜像（Gitee）](https://gitee.com/pdwcloud/codenow) ·
[用户手册](用户手册.md) ·
[开源协议 Apache-2.0](LICENSE)

![连库查询：点表就查](.github/assets/db-query.png)

<!-- 截图都是用演示数据（若依 sys_* + 商城 shop_*、造的日志和 demo-shop 工程）录的，重录也别用真实数据。 -->

## 它干什么

- **码上查**：粘建表语句、连库或扫源码导入表结构；搜表名 / 字段 / 注释（支持拼音）；
  按字段规则批量造 INSERT 测试数据；我的 SQL 库收藏常用语句。
- **连库查询**：Oracle（含 11g）/ MySQL / PostgreSQL / SQLite，点表就查、手写 SQL 带补全、勾行复制 INSERT；
  写语句要二次确认，没有 WHERE 的 UPDATE / DELETE 一律拒。SQL 优化检查（结合库里的索引）和「优化记录」。
- **Redis**：单机 / 哨兵 / 集群，按前缀浏览、gzip 值自动解压、大键提醒、按前缀批量删。
- **日志查看**：几百 MB 的本机日志秒开，按 logback / log4j 的 pattern 拆成列，按级别、关键字过滤。
- **码上测**：直接扫 Spring Boot 源码出全部接口（不用写 Swagger 注解），自动造好请求体，单接口发送，
  导出 Markdown / HTML / OpenAPI 文档。
- **常用信息**：VPN / 堡垒机 / 数据库的账号地址收在一处，逐个复制，密码加密存本机。
- **小工具**：YAML / Properties / JSON 互转校验、JSON 树形查看与搜索、Cron 表达式解读。

| | |
|---|---|
| ![搜「下单时间」直接定位到字段](.github/assets/schema-search.png) | ![按字段规则批量造 INSERT](.github/assets/batch-insert.png) |
| 表结构速查：搜注释、字段、拼音首字母 | 批量 INSERT：按字段造测试数据 |
| ![100 MB 日志按级别过滤，点一行看完整堆栈](.github/assets/log-view.png) | ![扫出的接口直接发送，响应带字段注释](.github/assets/api-test.png) |
| 日志查看：100 MB 日志按级别过滤，点一行看堆栈 | 码上测：扫出接口就能发，响应带字段注释 |

## 开源版和官方安装包

这个仓库是基础版，**全部免费、不限量**。官方安装包 = 基础版 + 专业版功能（源码不在这里），
装好可以免费试用 7 天，之后 199 元终身。

| | 开源版（本仓库） | 专业版（官方安装包） |
|---|---|---|
| 表结构、批量 INSERT、连库查询、我的连接 / SQL 库、优化记录 | ✅ | ✅ |
| Redis 单机 / 哨兵 / 集群 | ✅ | ✅ + Java 序列化对象解析、走跳板机 |
| 日志查看 | 本机文件 | + 连服务器拉日志、多份日志合并时间线 |
| SSH 终端、服务器文件互传 | — | ✅ |
| 码上测：扫接口、单接口发送、导出文档 | ✅ | ✅ |
| 码上测：批量跑用例、全自动回归、页面测试、给 AI 用的接口说明、命令行 / CI 回归 | — | ✅ |
| 常用信息、小工具 | ✅ | ✅ |

开源版里专业版功能的菜单还在，点进去是一张说明卡。

## 隐私

- 表结构、连接信息存在本机 SQLite；记住的密码 Windows 上用系统 DPAPI 加密，macOS 用钥匙串。
- 没有遥测、不上传数据。会联网的只有：你自己配的数据库 / Redis / 接口地址，和官方包的检查更新。
- 码上测扫源码是文本解析，不运行你的工程代码。

这也是开源的理由：一个要存数据库密码的工具，代码公开了你才好放心装。

## 从源码编译

需要：Node 20+、pnpm 10、Rust stable，以及 [Tauri 2 的系统依赖](https://v2.tauri.app/start/prerequisites/)
（Windows 是 WebView2 + MSVC 生成工具，macOS 是 Xcode 命令行工具）。码上测扫 Java 工程时要本机有 JRE 8+。

```bash
pnpm install
pnpm tauri:dev      # 桌面窗口（开发模式）
pnpm tauri:build    # 打安装包
pnpm dev            # 只开浏览器调界面，不用 Rust；连库、读本机文件这类功能不可用
```

没有 `pro/` 目录时自动按开源版编（前端看 `vite.config.ts`，Rust 看 `src-tauri/build.rs`），不用改配置。

改完代码跑一遍：

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
cd src-tauri && cargo test
```

连 Oracle 11g、没有客户端的情况、各页怎么用，见[用户手册](用户手册.md)。

## 目录

```
src/                 前端（React 19 + antd 6 + zustand）
  features/          各页面
  lib/               纯函数：DDL 解析、SQL 生成、日志解析、码上测扫描与判定……（测试就放旁边）
  storage/           本机存储（SQLite → localStorage → 内存，逐级降级）
  pro-stub/          开源版里专业版功能的占位
src-tauri/           桌面端（Tauri 2 / Rust）：数据库驱动、Redis、读大文件、凭据加密
parsers/             码上测用的 Spring 工程扫描器（Java，编好的 jar 在 src-tauri/resources）
mockup/              界面设计稿；_theme.css 是全应用的主题
```

## 反馈与贡献

有 bug 或想要的功能，直接开 Issue。PR 欢迎，提交前请跑过上面的检查；代码注释用中文，写「为什么」。
细则见 [CONTRIBUTING.md](CONTRIBUTING.md)，代码怎么分层见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 支持一下

开源不易。觉得好用的话，买个专业版就是最大的支持；也可以请作者喝杯咖啡 ☕

<img src=".github/assets/sponsor-wechat.jpg" width="200" alt="微信赞赏码">

## 协议

本仓库代码按 [Apache-2.0](LICENSE) 开源。官方安装包里的专业版部分不在本仓库，不属于开源范围。
