# spring-scanner

APIForge 的 Spring Boot 源码扫描器（PRD v0.3 模块 4.1）。独立 Java 进程，stdout 出 JSON，
stderr 出日志；单文件解析失败不阻断整体。目标 **Java 8** 运行时，8/11/17/21 的 JRE 都能跑
（3.26.4 的 class 版本实测仍是 52）；解析语言级别设到 JAVA_21，老工程的 8 语法、新工程的
record / sealed / switch 模式守卫都能解析，module-info.java 也不拦路。JavaParser 打进
fat jar，用户机器只需要一个 JRE。

两种扫描目标，`--root` 按类型自动分流：

- **目录**（源码模式）：递归发现 Maven/Gradle 工程，JavaParser 解析源码——完整能力
  （Javadoc 说明、业务异常 bizThrows、跨工程 DTO 索引）。
- **.jar 文件**（jar 模式，`scanJar`）：没有源码、只有构建产物时，读 class 文件里的
  RuntimeVisible(Invisible) 注解出同一份 JSON 契约（`ClassBytecodeReader` 读常量池 +
  `JarClassParser` 登记进同一套 Catalog/Registry/装配器，前端零改动）。Spring Boot fat jar
  连 `BOOT-INF/classes`（用户类，简名冲突时优先）与 `BOOT-INF/lib/*.jar`（嵌套依赖 jar，
  兄弟模块的 Controller/DTO 也住这里）一起解析；`BOOT-INF/classes` 下的 mapper XML
  照常抽表名。上限 12 万个类 / 500 条错误，防畸形超大包。

  jar 模式拿不到的（字节码的天然上限，前端已有兜底）：Javadoc（说明只剩 Swagger 注解，
  `@ApiOperation`/`@Api(tags)`/`@ApiModelProperty`/`@Schema` 编进注解的都在）；方法体里
  的 `throw new` 语句（`bizThrows` 为空，业务异常用例走「逐字段探查」兜底）；参数名
  （javac 不带 `-parameters` 时只有 `arg0`，Spring 的 `@RequestParam("x")` 写了名的不受影响）；
  自定义**组合注解**落判（`@interface` 的元注解在 jar 模式组不成材料，只认内置映射注解）。
  Controller→Service→Mapper 调用链保住了：方法体字节按指令长度表走一遍，
  `getfield/putfield` 命中本类字段的记 `methodUses`（`resolveMethodUses`）。

## 构建

```bash
cd parsers/spring-scanner
mvn -gs mvn-settings.xml -s mvn-settings.xml package -DskipTests
cd ../.. && pnpm scanner:sync
```

**`-gs` / `-s` 不能省**：本机全局 `conf/settings.xml` 里的阿里云镜像还是废弃的
`http://maven.aliyun.com/nexus/...`（现在返回 HTML 错误页，缓存里全是毒 POM）。
`mvn-settings.xml` 把镜像覆盖成 `https://maven.aliyun.com/repository/public`，
只对本工程生效，不动用户全局配置。

**改完必须跑 `pnpm scanner:sync`，不要手 `cp` 一份到 `src-tauri/resources/`。**
JAR 有三处副本，`tauri dev` / `tauri build` 实际加载的是
`src-tauri/target/{debug,release}/resources/` 里那份（Rust 侧 `scanner_jar` 的候选顺序里
Resource 目录排最前）。只手 cp 进 `src-tauri/resources/` 的话，开发模式会一直跑旧 JAR ——
你改了扫描器、重扫界面没变化就是这么来的。`scanner:sync` 三处一起写，存在的唯一理由就是这个。

进安装包的那份由 `tauri.conf.json` 的 `bundle.resources` 登记。OCI 包用的是另一份配置
（`pnpm tauri:build:oci` 走 `--config src-tauri/tauri.oci.conf.json`），它自己那份
`resources` 里也登记了扫描器 —— 改这里时两边都要在。

## 手动验证

```bash
java -Dfile.encoding=UTF-8 -jar target/spring-scanner.jar --root <工程目录或 .jar> | head -c 2000
```

stdout 必须是单个 JSON 对象（`root/scannedAt/projects[]/errors[]`）。
出句仓库 `src/lib/apiforge/scan/normalize.test.ts` 钉了输出契约的消费端。
jar 模式冒烟：任意带 `@RestController` 的 jar（fat jar 更好），`controllers[]` 应出接口、
fat jar 的 `BOOT-INF/lib` 依赖类应能补出 body 字段、`BOOT-INF/classes` 下 mapper XML 应进
`mappers[]`。

## 进度行契约（stderr）

stdout 是 JSON 契约不能碰，**实时进度一律走 stderr、带前缀**：

- `PROG projects <n>` — 工程发现完成（前端工程队列据此建条目）
- `PROG proj <工程名> · <相对路径>` — 发现一个工程（此时状态是「等待」；jar 模式相对路径是「jar 包」）
- `PROG files <n> java / <m> xml · <目录名>` — 该工程文件收集完成（→「解析中」；jar 模式写 `<n> class / <m> xml`）
- `PROG parsing <i>/<N> <文件名>` — 解析进度（每 5 个文件报一次，最后必报）
- `PROG controller <类名> · <n> api` — 装配阶段发现 Controller
- `PROG api <METHOD> <路径> · <方法名>` — 发现接口（方法名给实时发现树；老前端可忽略 ` · …`）
- `PROG proj done <工程名> · <n> api` — 该工程解析完成（n 是权威接口数）
- `PROG proj fail <工程名>` — 该工程整体解析失败（错误进 JSON 的 errors[]）
- `PROG err <文件名> 解析失败已跳过` — 单文件失败（同时进 JSON 的 errors[]）
- `ERR ...` 保留前缀：Rust 侧只转发 `PROG `/`ERR ` 开头的行成
  `apiforge-scan-log` 事件，其余 stderr（JVM 警告等）不进前端流水。

事件按工程串行推进：`proj ×N`（等待）→ 逐工程 `files → parsing → controller/api → proj done`。
前端 `src/lib/apiforge/scan/queue.ts` 消费这些行还原「第二级 · 工程队列」；
不认识的行原样跳过，向前兼容。

## 人话解析块（流水上屏行）

除机器事件外，扫描器还发给人看的解析块：同样带 `PROG ` 前缀走同一条 stderr 通道，
但**不是**上面任何机器事件词开头。前端 `queue.ts` 的 `isMachineEvent` 判据把机器行
滤掉（只喂队列/KPI/接口数；store 封顶流水时也只封人话行，机器行的完整序列不能丢）、
把这些行剥掉前缀上屏（扫描 HUD + 解析流水面板）：

    ════════ 工程 mall-backend ════════
    JavaParser 打开模块 · 126 个 Java 文件

      ▶ 检测到 @RestController：OrderController
        class com.mall.web.OrderController
        说明 订单管理接口
        作者 pdw · 2026-01-15
        @RequestMapping("/api/orders")
        ▸ [1/3] GET /api/orders
            解析方法 listOrders()
            说明 查询订单列表
            注解 @GetMapping → /api/orders
            参数 @RequestParam status:String
            RequestBody CreateOrderReq { userId@NotNull, amount@DecimalMin("0.01") }
            返回类型 R<List<OrderVO>>
            ✓ 归属工程 mall-backend · 已加入接口库
      ✓ OrderController 解析完毕
      → 同工程下一个 Controller：ProductController

    ✓ 工程 mall-backend 完成 · 5 接口
    → 下一个工程：pay-service

- 参数行带校验注解（`@Size(max=64)`），请求体字段带 `@NotNull` 等——认的是
  javax/jakarta validation 常用集（`ScanRules.VALIDATION_ANNOTATIONS`，源码路径与
  jar 字节码路径共用一份），别的注解不上流水。
- `说明` / `作者` 来自 Javadoc：类与方法的首行说明、`@author`、`@date`（及
  `@DateTime`/`@CreateTime`/`@CreatedDate` 等常见变体，`Scanner.DATE_TAGS`）。
  方法的说明同时进 JSON 的 `description`（Swagger 注解 @ApiOperation/@Operation 优先），
  **Controller 业务名**进 JSON 的 `controllers[].description`（取值顺序：
  `@Api(tags|value)` → `@Tag(name)` → 类 Javadoc 首行），作者/日期只进流水。
- 校验注解只进流水不进 JSON：`MethodDecl.paramNotes` / `dtoFieldNotes` 是扫描器本地态。
- RequestBody 字段在装配阶段补查一次：DTO 文件可能排在 Controller 之后解析，
  第一遍反查（buildApiMethod）时还没登记。

## 关联表识别数据（JSON 契约里的 `classUses` / `mappers`）

- `mappers`：MyBatis XML 的语句 → 表名（`extractTables` 只抽静态表名，`${...}`
  动态表名宁可少报）。
- `classUses`：类内每个方法用到的注入字段类型。实现类条目会按 `implements` 的
  接口简名**别名登记一份**（`OrderServiceImpl` 的调用链同时挂在 `OrderService`
  名下）——Spring 上层注入的是接口，没有别名 Controller→Service 第一跳就断，
  关联表识别全军覆没。消费端：`resolveLinks.ts`（识别走法）、`ci/impact.ts`
  （反向调用图，另有去 `Impl` 后缀的兜底）。
- 没有 XML 语句的 mapper（MyBatis-Plus / 注解 SQL）抽不出表名：这部分接口靠
  命名推断兜底（`resolveLinks` 的 naming 置信级，默认不启用）。

## RequestBody 字段反查的两级兜底（源码 → 依赖 jar）

`@RequestBody` 的对象参数要解析成具体字段（`requestBody.fields`，用例造值靠它），
字段表来自两级查找：

1. **源码**（`registerDtoFields`）：工程里能解析到的 DTO 类，字段名/类型/必填
   （@NotNull/@NotBlank/@NotEmpty）/说明（@ApiModelProperty/@Schema/Javadoc）全有。
2. **依赖 jar 兜底**（`resolveDtoFieldsFromJars`）：源码查不到的 body 类型，去构建
   产物 jar 里按**字节码**解析（`dtoFieldsFromClass`，JVMS 常量池 + fields 的极简
   解析，不引 ASM）。jar 三种来源：工程 `target/*.jar`（Spring Boot fat jar 自动拆
   `BOOT-INF/lib` 嵌套 jar + `BOOT-INF/classes`，嵌套 jar 只拆名字命中 pom 依赖的）、
   `target/lib/`（dependency-plugin 拷贝目录）、**祖先目录下按依赖 artifactId 命名
   的模块目录**的 target——模块不一定是直接兄弟（mobile/biz/xxx-service 依赖的
   ruoyi-api 在两级之上），所以沿祖先链逐级深挖：只认目录名、只下钻目录、
   深度封顶（`HUNT_ANCESTORS`/`HUNT_DEPTH`），大仓库拖不慢扫描。fastjson
   `JSONObject`、`Map`、`String` 这类没有静态 schema 的类型在 `NON_DTO_TYPES`
   排除表里，不会把库类的内部字段误登记。

字节码路径的天然上限：Javadoc 编译后就没了，jar 里没编 `@ApiModelProperty`/
`@Schema` 注解的字段**说明为空**（字段名/类型/必填仍可用——纯 Lombok POJO 的
api jar 就是这种情况）。依赖 jar 本机不存在（模块没构建、没 install 到本地库）
的类型兜不了，工程 `mvn install` 后重扫即可。

**泛型从前也在这条路上丢**：字段描述符是擦除后的 `Ljava/util/List;`，`List<Long>`
到前端只剩裸 `List` —— 集合元素认不出来，用例 body 里那个字段就落成 `[]`
（实测 `detailList`）。已修：字段的 `Signature` 属性里带着真泛型，解析器读出来
经 `Names.signatureToText` 翻成 `List<Long>` / `Map<String,Object>` / `String[]`
这种前端读得懂的简名文本；没有 `Signature` 才退回描述符。**这条只影响 jar 来源的
DTO**，源码路径本来就保留泛型。

集合 body 也反查：`List<UserReq>` 的字段表按元素类型 `UserReq` 查
（`collectionElement`），JSON 的 `requestBody.type` 照实写成 `List<UserReq>`。

## 无注解参数：简单类型当查询参数，复杂类型展开成命令对象的字段

Spring 的绑定不要求写注解：`list(String status)` 的 status 是查询参数，
`getApplyPage(OrderQueryCondition condition)` 的 condition 是**命令对象** ——
表单/查询参数按**字段名**绑到对象的字段上。这两类原来都落成 `position:"unknown"`，
而前端只认 `query/path/body/header`，于是整个参数被丢掉：界面上写「无 path/query/body，
直接发送即可」，POST 发出去既没参数也没有 body —— **静默发一个空请求，不是报错**。

现在的落判（`Names.isSimpleParamType` / `Names.isCommandObjectType`）：

| 参数 | 落成 | 依据 |
|---|---|---|
| 简单类型（String / 基本类型+包装 / Date / java.time / UUID / …） | `position:"query"` 一个参数 | Spring 直接绑一个值 |
| 命令对象（其余首字母大写的类） | **它自己不占参数位**，字段逐个展开成 `query` 参数，另带 `fromForm:true` | Spring 按字段名绑 |
| 集合 / 数组 | 维持 `unknown`（前端不显示） | 无注解集合的绑定取决于泛型与配置，猜错会凭空长出参数 |
| 框架注入类型（`HttpServletRequest` / `Model` / `ModelAndView` / `MultipartFile` / …，见 `NON_DTO_TYPES`） | 维持 `unknown` | 既不是一个值，也没有字段表 |

排除表最后那一格是拿真工程撞出来的：一个后台工程就常有几十个方法写成
`public ModelAndView noticeList(ModelAndView modelAndView, String moduleCode)`（JSP 时代的页面
Controller，`ModelAndView` 与 `Model`/`ModelMap` 同属 Spring 注入的渲染对象）。它不在
`NON_DTO_TYPES` 里时，每个方法都会被当成命令对象走一遍展开、再去源码和 jar 里白找一圈，
流水还谎称「字段没解析到——它可能在没构建的模块里」：框架类在任何模块里都没有源码，
那句话是在指一条不存在的路。

展开在**装配阶段**做（`ProjectAssembler.expandFormParams`），与 body 字段的补查同一时机：
解析期只有类型名，DTO 源码可能排在 Controller 之后解析，跨工程源码 / 依赖 jar 两条兜底
这时也还没跑。命令对象因此也进 `Scanner` 的 `wanted` 兜底候选 —— 它和 body DTO 一样常住在
兄弟工程（Controller 在 `system-service`、`QueryCondition` 在 `api` 模块）。

**只导入单个工程也能出字段**，靠的是 jar 那条路：跨工程*源码*索引只覆盖扫描根下的工程
（够不到兄弟模块），但字节码兜底会沿祖先目录找「按依赖 artifactId 命名的模块目录」，读它的
`target/*.jar`。前提两条：① 扫的那个工程 pom.xml 里**字面**写了该 artifactId（扫描器不解析
父子 pom 继承与传递依赖）；② 那个模块**打过包**（只认 jar，不认 `target/classes`——故意的，
「编译过但没打包」属于该重新 package 的事）。两条都满足时字段名/类型/必填照出，**代价是
说明可能为空**（Javadoc 编不进字节码，字段上编了 @ApiModelProperty/@Schema 的才有说明）；
要连说明一起要，扫整个工作区根目录。模块没打包时才是真没有，流水会说「（表单对象，字段
没解析到——它可能在没构建的模块里）」，那是让你去 package，不是悄悄给半份数据。

拿 `ruoyi-admin-ui` 实测过这两个数：**262 个方法**靠 jar 那条路展开成功，剩 **14 个**没解析到。
那 14 个的类型只有两组，两组都踩在上面两条前提上——`ShopUser`/`ShopRole`/`ShopModule`/`ShopPlatform`
的源码在 `ruoyi-service`（不是 admin-ui 的依赖、也没有 `target/*.jar`），
`ShopUserCondition` 那一组的包是 `com.ruoyi.cloud.basic.api.request.condition.*`
（公共 jar，工作区里没源码，`ruoyi-basic-api` 也不在 pom 的依赖里）。
**所以这句提示不总是「去 package」**：依赖压根不在 pom 里时，package 多少次都没用——
先看那个模块是不是这个工程的依赖。（这条实测还顺带证明了跨工程源码索引够不到兄弟模块时，
单工程扫描确实走的 jar 兜底。）

两条自我约束：

- 展开出来的字段 `position` 写 `query` 是给前端用的（它只认那四种），但源码里并没有
  `@RequestParam`，**流水不许替它们认领注解**（靠 `fromForm` 标记，见 `positionAnno`）。
- 只展开一层、不递归：`brandOwner` 这种嵌套对象原样留成一个参数名。Spring 的
  `brandOwner.id=` 点号绑定极少见，猜错比不猜更坏。

前端一行没改：`normalize.ts` 显式构造 `RawParameter`，多余的 `fromForm` 键被丢掉。
查询串和表单参数在 Spring 侧绑的是同一个命令对象，所以把表单参数发成查询串业务是通的。

## `@RequestMapping` 不写 method：带 `@RequestBody` 的记成 POST

`@RequestMapping` 不写 `method` 时 Spring 的语义是**响应所有动词**，扫描器必须挑一个写进
`httpMethod`。原来的口径是一律按 GET 试探（`AnnoReaders.requestMappingMethod`），对**没写
`@RequestBody`** 的方法没问题——命令对象和普通参数 Spring 都能从查询串绑。但方法带
`@RequestBody` 时试探方向是反的：真调它的人必然 POST 带 JSON，按 GET 发过去照样进得了这个方法
（不写 method 不分动词），只是 `RequestResponseBodyMethodProcessor` 读不出 body，直接抛
`Required request body is missing`，全局异常再翻成 500——报出来像接口坏了，实际上是扫描器
记错了动词，自动化发出的请求少一个 body。

现在的口径（`JavaSourceParser` 参数解析完的复核 + `HierarchyResolver` 的 `"ALL"` 分支同一条）：

| 方法 | 落判 |
|---|---|
| `@RequestMapping("/x")` 不写 method + 有 `@RequestBody` | **POST** |
| `@RequestMapping("/x")` 不写 method + 没有 `@RequestBody` | GET（试探口径不变） |
| `@RequestMapping(value="/x", method=RequestMethod.XXX)` | 写了的算数 |
| `@PostMapping` / `@GetMapping` 等 | 照注解 |

实测 `ruoyi-biz-order-service` 的 `PayOrderPushController`：写的是
`@RequestMapping(value = "/orderPush")`，原来扫成 GET（自动化 500）；同名的
`ruoyi-mobile` 那份写的是 `@PostMapping("/orderPush")`，扫成 POST（200）。同一个坑的另一条
入口是自定义组合注解（`@MyPost` 内标 `@RequestMapping` 不写 method），走 `HierarchyResolver`，
两条口径必须一致，否则只修好一半。

## Service 方法体里的业务异常收集（`bizThrows`）

业务异常用例的正源不是字段注释（那是「猜」），是 Service 方法体里真实的
`throw new XxxException(...)`——`if (dto.getBrandOwnerId() == null) throw new BizException("品牌商id必填")`
一条就同时给出「哪个字段」和「后端自己的文案」，前端据此生成用例名带后端文案的
「异常·业务」用例（期望 `[200,400]`：业务异常被全局异常处理器优雅接住怎么回都行，回 500 才是没兜住）。

收集规则（`JavaSourceParser.collectBizThrows`）：

| 维度 | 口径 |
|---|---|
| 异常类型 | 构造类型简名以 `Exception` 收尾才收（不带 Exception 结尾的构造多半是业务对象） |
| 消息文案 | 构造实参里**所有字符串字面量拼接**（`"品牌商" + name + "不能为空"` 至少留下字面量那半截） |
| 违例字段 | 外层 `if` 条件里的 `getXxx()/isXxx()` 调用（取**最内层** if——嵌套守卫里真正拦 throw 的是最近那个条件） |
| lambda | 闭包里的 throw **不认领**外层 if（闭包的守卫语义在别处） |

输出走 `ProjectAssembler` 的 `bizThrows[]`（`className/methodName/throws[{type,message,fields}]`），
登记口径与 `classUses` 同款双轨：**实现类全名 + 接口简名别名各一条**——Controller 注入的是接口，
按实现类全名查不到。前端按 `方法名 + throw 内容` 去重，同一个 throw 经两条路走到也不会成对出用例。

v1 已知不认的（**宁可少报**）：校验写在工具/父类方法里、先收集一批错误再一次抛、消息全靠运行时
拼出来。这类接口前端有「逐字段缺一探查」兜底（满员 body 逐字段摘，后端拦了就说明有校验），
扫描器不为它们硬猜。

手动验证：真扫一个带业务校验的工程（如 shop 的 `AdminOrderServiceImpl`），stdout JSON 的
`bizThrows` 里应能看到 `methodName:"saveApply"` 的条目，`message` 是代码里那句文案，
`fields` 是 if 条件里 get 到的字段。

## 页面（`pages`，页面测试用）

`@Controller` 里返回视图的方法单独收一份：类和方法都没有 `@ResponseBody`、动词是 GET、
认出了视图名（`ViewNames`：`return "x"` / 本类 `static final String` 常量 / `setViewName(x)` /
`new ModelAndView(x, …)`，`redirect:` / `forward:` 不算）。模板按
`src/main/webapp/WEB-INF/views/<视图名>.ftl` → `src/main/resources/templates/<视图名>.ftl|.html` 找，
原文放进 `ftlText` 交给前端算页面画像（前端读不了磁盘）。

`needsParams`：有 `@PathVariable`、必填且无默认值的 `@RequestParam`、`@RequestBody` 之一。
这类页面（详情 / 编辑页）没有 id 打不开，第一版跳过。

`controllers[]` 不受影响：页面方法照旧以 GET 接口出现在接口库里。

实测 `ruoyi-admin-ui`：`pages` 210 条，`ftlText` 非空 200 条，`needsParams` 21 条；
`AdminPurchaseApplyController.getPurchaseApplyListPage`（视图名常量 `SHOP_PURCHASE_APPLY_PAGE`
定义在本类）能正确解出 `classBasePath:/ui/shop/purchaseapply`、`methodPath:/getPurchaseApplyListPage`、
`needsParams:false`、`ftlText` 长度 26725。`ViewNames` 只认**本类** `static final` 常量，
跨类/接口常量（视图名定义在别的常量类或接口里）解不出来，按设计落 `viewName:null`（少报，
不硬猜）。


