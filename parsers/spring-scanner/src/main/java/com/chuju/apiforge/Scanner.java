package com.chuju.apiforge;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

/**
 * APIForge 源码扫描器（PRD v0.3 模块 4.1/4.2 的 Java 侧）。
 *
 * 用法：java -jar spring-scanner.jar --root <目录>
 * stdout 只输出 JSON（技术方案的接口契约）；日志一律 stderr。
 * 单文件解析失败不阻断整体：错误进 errors[]，进程照常 exit 0 ——
 * 一个坏文件让整次扫描报废，用户看到的就是「工具不能用」。
 *
 * 产出五类信息：
 *  controllers  Controller 清单 + 接口方法（REST 注解 → HTTP 方法/路径/参数）
 *  mappers      MyBatis XML 的语句 → 表名（关联表识别的高可信证据）
 *  classUses    类内每个方法用到的注入字段类型（Controller→Service→Mapper 链路；
 *               实现类条目会按 implements 的接口简名别名登记一份）
 *  types        VO/DTO 字段 + 说明（试跑响应 JSON key 标含义；返回 Map 时靠它）
 *  errors       单文件失败清单
 *
 * 职责划分（一个类一个责任，本类只做编排）：
 *  ProjectFinder          找工程目录（递归到没有子目录为止）
 *  SourceCollector        收文件、算指纹
 *  JavaSourceParser       解析 Java 源码 → ClassFile/MethodDecl
 *  MetaRegistry           @interface 声明 → 元注解（组合注解落判的依据）
 *  HierarchyResolver      装配前落判：组合注解身份/动词 + 继承链前缀与基类方法
 *  MapperXmlParser        解析 MyBatis XML → 语句/表名
 *  ClassCatalog/DtoRegistry 解析产物的两个容器（类清单、DTO 字段表）
 *  DtoFieldSource 链      body DTO 反查不到时的按序兜底：
 *                         本工程已解析 → 跨工程源码 → 依赖 jar 字节码
 *                         并把 body 字段引用的嵌套类型逐层展开（resolveBodyDtos）
 *  ProjectAssembler       人话流水 + 本工程 JSON 块
 */
public class Scanner {

    private final ProjectFinder finder = new ProjectFinder();
    private final SourceCollector collector = new SourceCollector();
    private final ClassCatalog catalog = new ClassCatalog();
    private final DtoRegistry registry = new DtoRegistry();
    private final MetaRegistry metaRegistry = new MetaRegistry();
    private final EntityRegistry entities = new EntityRegistry();
    private final JavaSourceParser parser = new JavaSourceParser(catalog, registry, metaRegistry, entities);
    private final HierarchyResolver hierarchyResolver = new HierarchyResolver(catalog, registry, metaRegistry);
    private final WorkspaceSourceResolver workspaceResolver = new WorkspaceSourceResolver(parser, registry);
    /** body DTO 字段来源链：前一级认领的从 wanted 摘除，后一级只看剩下的。
     *  第一级「本工程已解析」不是独立实现——它在 WorkspaceSourceResolver 循环
     *  顶部做（检查依赖循环内的解析副作用，提出去行为就变，见该类注释） */
    private final List<DtoFieldSource> dtoSources = Arrays.asList(
            workspaceResolver,
            new JarArtifactResolver(registry));
    private final ProjectAssembler assembler = new ProjectAssembler(catalog, registry, entities);

    public static void main(String[] args) {
        String root = null;
        for (int i = 0; i < args.length - 1; i++) {
            if ("--root".equals(args[i])) root = args[i + 1];
        }
        if (root == null || root.trim().isEmpty()) {
            System.err.println("缺少 --root 参数");
            System.exit(2);
        }
        Scanner scanner = new Scanner();
        try {
            System.out.println(scanner.scan(Paths.get(root.trim()).toAbsolutePath().normalize()));
        } catch (Exception e) {
            // 整体失败也往 stdout 写一份合法 JSON：调用方只认 stdout 的契约不能破，
            // 人话进 stderr 供日志排查（堆栈只上 stderr，Rust 只转发 PROG/ERR 行）
            e.printStackTrace();
            System.err.println("扫描失败: " + e);
            System.out.println("{\"root\":" + Json.str(root)
                    + ",\"scannedAt\":\"" + now() + "\",\"fingerprint\":\"\",\"projects\":[],"
                    + "\"errors\":[{\"file\":" + Json.str(root)
                    + ",\"message\":" + Json.str(String.valueOf(e)) + "}]}");
        }
    }

    private static String now() {
        return java.time.Instant.now().toString();
    }

    private String scan(Path root) throws IOException {
        if (java.nio.file.Files.isRegularFile(root)) {
            String name = root.getFileName().toString().toLowerCase(java.util.Locale.ROOT);
            if (!name.endsWith(".jar")) {
                throw new IOException("不是支持的扫描目标（要目录或 .jar）: " + root);
            }
            return scanJar(root);
        }
        if (!Files.isDirectory(root)) throw new IOException("目录不存在: " + root);

        List<Path> projectDirs = finder.findProjectDirs(root);
        // 跨工程 DTO 索引：api 模块定义请求类、ui/service 工程引用是常态，
        // 没有这张索引，各工程只查自己，body 字段就是空的
        workspaceResolver.buildWorkspaceIndex(projectDirs);
        // 工程队列事件：先把全部工程报出来（前端队列立刻出现「等待」条目），
        // 再逐个工程解析。事件行契约见 README「stderr 进度协议」。
        Progress.report("projects " + projectDirs.size());
        for (Path dir : projectDirs) {
            String rel = root.relativize(dir).toString().replace('\\', '/');
            Progress.report("proj " + dir.getFileName() + " · " + rel);
        }
        StringBuilder projectsJson = new StringBuilder();
        List<String> topErrors = new ArrayList<>();

        for (int pi = 0; pi < projectDirs.size(); pi++) {
            Path dir = projectDirs.get(pi);
            collector.reset();
            catalog.clear();
            registry.clearProjectScope();
            assembler.resetApiCount();
            // 人话解析块从工程头开始；机器事件行前端不上屏（只喂队列/KPI）
            Progress.report("════════ 工程 " + dir.getFileName() + " ════════");
            collector.collect(dir);
            Progress.report("files " + collector.javaFiles().size() + " java / " + collector.xmlFiles().size() + " xml · " + dir.getFileName());
            Progress.report("JavaParser 打开模块 · " + collector.javaFiles().size() + " 个 Java 文件");
            Progress.report("");
            String fp = collector.fingerprint();
            try {
                if (projectsJson.length() > 0) projectsJson.append(',');
                projectsJson.append(scanProject(dir, fp));
                Progress.report("✓ 工程 " + dir.getFileName() + " 完成 · " + assembler.apiCount() + " 接口");
                Progress.report("proj done " + dir.getFileName() + " · " + assembler.apiCount() + " api");
                if (pi + 1 < projectDirs.size()) {
                    Progress.report("→ 下一个工程：" + projectDirs.get(pi + 1).getFileName());
                }
            } catch (Exception e) {
                topErrors.add("{\"file\":" + Json.str(dir.toString().replace('\\', '/'))
                        + ",\"message\":" + Json.str(String.valueOf(e)) + "}");
                Progress.report("✗ 工程 " + dir.getFileName() + " 解析失败");
                Progress.report("proj fail " + dir.getFileName());
            }
        }
        return "{\"root\":" + Json.str(root.toString().replace('\\', '/'))
                + ",\"scannedAt\":\"" + now() + "\",\"projects\":["
                + projectsJson + "],\"errors\":["
                + String.join(",", topErrors) + "]}";
    }

    /**
     * 扫一个工程：第一遍把所有类解析进内存（DTO 字段要跨文件反查，不能边扫边出），
     * 然后跑来源链兜底，最后交给装配器出流水和 JSON。
     */
    private String scanProject(Path dir, String fingerprint) {
        List<String> errors = new ArrayList<>();

        // 解析是最慢的一步，逐文件发进度（stderr → Rust 事件 → 前端流水）
        List<Path> files = collector.javaFiles();
        int total = files.size();
        int done = 0;
        for (Path f : files) {
            try {
                parser.parse(f);
            } catch (Exception e) {
                errors.add("{\"file\":" + Json.str(f.toString().replace('\\', '/'))
                        + ",\"message\":" + Json.str(String.valueOf(e)) + "}");
                Progress.report("err " + f.getFileName() + " 解析失败已跳过");
                Progress.report("✗ " + f.getFileName() + " 解析失败，已跳过");
            }
            done++;
            if (done % 5 == 0 || done == total) {
                Progress.report("parsing " + done + "/" + total + " " + f.getFileName());
            }
        }

        // 继承链 + 组合注解落判：要全工程解析完才能定（@interface 声明文件可能
        // 排在 Controller 之后、父类可能在任何文件里）。放在 DTO 兜底之前——
        // 晚认出的 Controller 的 body DTO 也要进 wanted
        hierarchyResolver.resolve();

        // 源码里反查不到的 @RequestBody DTO（在兄弟模块打出的依赖 jar 里，
        // 如 api 模块的请求类）：从构建产物按字节码兜底。装配阶段那些 fieldsFor 补查要在这之后跑
        Set<String> wanted = new HashSet<>();
        for (ClassFile cf : catalog.unique()) {
            if (!cf.isController) continue;
            for (MethodDecl m : cf.methods) {
                if (m.bodyType == null || (m.bodyFields != null && !m.bodyFields.isEmpty())) continue;
                wanted.add(m.bodyElem != null ? m.bodyElem : m.bodyType);
            }
        }
        // 无注解命令对象的字段表走同一组兜底：它跟 body DTO 一样常常住在兄弟工程
        // （Controller 在 system-service、QueryCondition 在 api 模块），不兜底到装配阶段
        // 展开时就只剩一个类型名。判据用 registry.hasFields（含父类链合并），
        // 与 body 那条口径一致——Condition 的字段大量长在基类里。
        for (ClassFile cf : catalog.unique()) {
            if (!cf.isController) continue;
            for (MethodDecl m : cf.methods) {
                for (String ft : m.formTypes) {
                    if (!registry.hasFields(ft)) wanted.add(ft);
                }
            }
        }
        if (!wanted.isEmpty()) resolveBodyDtos(dir, wanted);

        return assembler.assembleProject(dir, fingerprint, errors, collector.xmlFiles());
    }

    /** jar 模式解析上限（含 BOOT-INF/lib 嵌套）：防畸形超大包拖满 180 秒超时 */
    private static final int MAX_JAR_CLASSES = 120000;
    /** jar 模式错误上限：坏 class 太多说明产物损坏，收满就不再追加 */
    private static final int MAX_JAR_ERRORS = 500;

    /**
     * 扫一个 jar 包：没有源码、只有构建产物时的路。
     * Spring Boot fat jar = BOOT-INF/classes（用户自己的类）+ BOOT-INF/lib/*.jar
     * （依赖，兄弟模块的 Controller/DTO 也住这里）；普通 jar 整包都是类。
     * 先摸条目头数出顶层类做进度总量，再解析——用户类先于依赖 jar 登记，
     * 简名冲突时（registry 的 putIfAbsent）用户类赢。
     * 产出与源码模式同一份 JSON 契约（同一套容器和装配器），前端零改动。
     */
    private String scanJar(Path jarPath) throws IOException {
        String jarName = jarPath.getFileName().toString();
        catalog.clear();
        registry.clearProjectScope();
        assembler.resetApiCount();
        Progress.report("projects 1");
        Progress.report("proj " + jarName + " · jar 包");
        Progress.report("════════ 工程 " + jarName + " ════════");

        long size = Files.size(jarPath);
        String fp = String.format("%08x", SourceCollector.mix(0x811c9dc5L,
                jarPath + "|" + size + "|" + Files.getLastModifiedTime(jarPath).toMillis()));

        JarClassParser jarParser = new JarClassParser(catalog, registry);
        List<String[]> xmlPairs = new ArrayList<>();
        List<String> errors = new ArrayList<>();
        int[] parsed = {0};

        try (JarFile jf = new JarFile(jarPath.toFile())) {
            // 元数据遍历：数顶层类（进度总量）、收集嵌套依赖 jar 名——只摸条目头，不解压
            List<String> libEntries = new ArrayList<>();
            int topLevelClasses = 0;
            int xmlCandidates = 0;
            Enumeration<JarEntry> meta = jf.entries();
            while (meta.hasMoreElements()) {
                String name = meta.nextElement().getName();
                if (name.startsWith("BOOT-INF/lib/") && name.endsWith(".jar")) {
                    libEntries.add(name);
                } else if (name.endsWith(".class") && isScannableClass(name)) {
                    topLevelClasses++;
                } else if (name.endsWith(".xml") && !name.startsWith("META-INF/")) {
                    xmlCandidates++;
                }
            }
            Progress.report("files " + topLevelClasses + " class / " + xmlCandidates + " xml · " + jarName);

            long t0 = System.currentTimeMillis();
            // 第一遍：顶层 class（fat jar 的 BOOT-INF/classes 也在这一层）+ mapper XML
            Enumeration<JarEntry> en = jf.entries();
            while (en.hasMoreElements()) {
                JarEntry e = en.nextElement();
                String name = e.getName();
                if (name.startsWith("BOOT-INF/lib/")) continue; // 依赖 jar 第二遍
                if (name.endsWith(".class") && isScannableClass(name)) {
                    if (parsed[0] >= MAX_JAR_CLASSES) continue;
                    // 条目流在这里关：parseClass 不关入参（关了就修不了下面那个坑）
                    try (java.io.InputStream is = jf.getInputStream(e)) {
                        parseClass(is, name, jarParser, errors, parsed);
                    }
                    if (parsed[0] % 20 == 0) {
                        Progress.report("parsing " + parsed[0] + "/" + topLevelClasses + " " + name.substring(name.lastIndexOf('/') + 1));
                    }
                } else if (name.endsWith(".xml") && !name.startsWith("META-INF/")) {
                    try (java.io.InputStream is = jf.getInputStream(e)) {
                        collectXml(is, name, xmlPairs);
                    }
                }
            }
            Progress.report("parsing " + topLevelClasses + "/" + topLevelClasses + " " + jarName);

            // 第二遍：嵌套依赖 jar。BOOT-INF/lib 里不会再有 BOOT-INF，一层拆平
            for (String libName : libEntries) {
                if (parsed[0] >= MAX_JAR_CLASSES) {
                    Progress.report("  已到 " + MAX_JAR_CLASSES + " 个类上限，剩余依赖 jar 跳过");
                    break;
                }
                int before = parsed[0];
                try {
                    readNestedLib(jf.getInputStream(jf.getJarEntry(libName)), libName, jarParser, xmlPairs, errors, parsed);
                } catch (IOException ex) {
                    Progress.report("err 依赖 jar 读不了 " + libName + ": " + ex);
                }
                Progress.report("  依赖模块 " + libName.substring(libName.lastIndexOf('/') + 1)
                        + " · " + (parsed[0] - before) + " 个类");
            }
            Progress.report("字节码解析完成 · " + parsed[0] + " 个类（" + (System.currentTimeMillis() - t0) + " ms）");
        }

        String projectJson = scanJarProject(jarPath, fp, errors, xmlPairs);
        Progress.report("✓ 工程 " + jarName + " 完成 · " + assembler.apiCount() + " 接口");
        Progress.report("proj done " + jarName + " · " + assembler.apiCount() + " api");
        return "{\"root\":" + Json.str(jarPath.toString().replace('\\', '/'))
                + ",\"scannedAt\":" + Json.str(java.time.Instant.now().toString())
                + ",\"fingerprint\":\"" + fp + "\""
                + ",\"projects\":[" + projectJson + "],\"errors\":["
                + String.join(",", errors) + "]}";
    }

    /** 要解析的 class：顶层类（内部类跳过，与源码路径只收顶层类同口径）；package-info/module-info 没有接口 */
    private static boolean isScannableClass(String entryName) {
        return !entryName.contains("$")
                && !entryName.endsWith("package-info.class")
                && !entryName.endsWith("module-info.class");
    }

    /**
     * 解析一个 class 条目。**不关入参流**：流的所有权在调用方。
     *
     * 原来是 `finally { in.close(); }`，对第一遍的 JarFile 条目流正好、对第二遍的
     * 嵌套 jar 是灾难——那一遍整包共用同一个 ZipInputStream，读完第一个 class 就被关掉，
     * 下一次 getNextEntry() 抛「Stream closed」，整个依赖 jar 只剩 1 个类。症状极有欺骗性：
     * 扫描 exit 0、errors 里只有一行「依赖 jar 读不了」、Controller 照常出，但二方库
     * （DTO/Controller 住的那个 BOOT-INF/lib/*.jar）里的类**一个都没登记**，于是
     * @RequestBody 字段空、命令对象字段空——用户看到的就是「参数对象出不来」。
     */
    private void parseClass(java.io.InputStream in, String name, JarClassParser jarParser,
                            List<String> errors, int[] parsed) throws IOException {
        parsed[0] += jarParser.parse(readAll(in), name, errors);
        if (errors.size() > MAX_JAR_ERRORS) errors.clear(); // 烂 jar 别把 JSON 撑爆
    }

    /**
     * 嵌套依赖 jar：ZipInputStream 拆平读 class 与 mapper XML。
     * **zin 是整包共用的流**：parseClass / collectXml 只准读不准关，
     * 关一次剩下的类就全读不到了（见 parseClass 的注释）
     */
    private void readNestedLib(java.io.InputStream raw, String libName, JarClassParser jarParser,
                               List<String[]> xmlPairs, List<String> errors, int[] parsed) throws IOException {
        try (java.util.zip.ZipInputStream zin = new java.util.zip.ZipInputStream(raw)) {
            java.util.zip.ZipEntry e;
            while ((e = zin.getNextEntry()) != null) {
                String name = e.getName();
                if (name.endsWith(".class") && isScannableClass(name)) {
                    if (parsed[0] >= MAX_JAR_CLASSES) return;
                    parseClass(zin, libName + "!/" + name, jarParser, errors, parsed);
                } else if (name.endsWith(".xml") && !name.startsWith("META-INF/")) {
                    collectXml(zin, libName + "!/" + name, xmlPairs);
                }
            }
        } finally {
            raw.close();
        }
    }

    /** mapper XML 候选收进内存（namespace 判据在 MapperXmlParser，非 mapper 的会被丢） */
    private void collectXml(java.io.InputStream in, String name, List<String[]> xmlPairs) throws IOException {
        byte[] data = readAll(in);
        if (data.length <= 2L * 1024 * 1024) {
            xmlPairs.add(new String[]{name, new String(data, java.nio.charset.StandardCharsets.UTF_8)});
        }
    }

    private static byte[] readAll(java.io.InputStream in) throws IOException {
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        return bo.toByteArray();
    }

    /**
     * jar 工程的装配：与源码 scanProject 同一条链——继承落判、body/formTypes 兜底、
     * 嵌套展开，最后进装配器出流水和 JSON。DTO 兜底的三个来源在这里天然是
     * no-op（无跨工程源码索引、无 pom），全工程类已在第一遍登记完，
     * 跑这条链的意义只剩 markReachable（types[] 的收录判据）。
     */
    private String scanJarProject(Path jarPath, String fingerprint,
                                  List<String> errors, List<String[]> xmlPairs) {
        hierarchyResolver.resolve();

        Set<String> wanted = new HashSet<>();
        for (ClassFile cf : catalog.unique()) {
            if (!cf.isController) continue;
            for (MethodDecl m : cf.methods) {
                if (m.bodyType == null || (m.bodyFields != null && !m.bodyFields.isEmpty())) continue;
                wanted.add(m.bodyElem != null ? m.bodyElem : m.bodyType);
            }
            for (MethodDecl m : cf.methods) {
                for (String ft : m.formTypes) {
                    if (!registry.hasFields(ft)) wanted.add(ft);
                }
            }
        }
        if (!wanted.isEmpty()) resolveBodyDtos(jarPath, wanted);

        return assembler.assemble(jarPath, fingerprint, errors, xmlPairs);
    }

    /** 逐层展开的层数上限：0 = body 本身，1 = body 的字段类型…… 第 4 轮够到第 3 层，
     *  跟前端骨架的 MAX_NEST_DEPTH(3) 对齐——再深前端也不造了，挖了是白挖 */
    private static final int NESTED_ROUNDS = 4;
    /** 展开出来的类型总量上限：DTO 图可以很大（实体互引、树状结构），别为了造骨架把 types[] 灌爆 */
    private static final int MAX_REACHABLE_TYPES = 500;

    /**
     * body DTO 的字段兜底，**按层展开**：@RequestBody 那一层解析出来之后，把它字段里引用的
     * 类型（`List<Detail>`、对象字段）接着交给同一组来源解析，一起登记成「从 body 走得到的
     * 类型」（types[] 的收录判据之一，见 ProjectAssembler.typesJson）。
     *
     * 只做第一层的话，`List<OrderItemAddCondition> detailList`（注释写着
     * 「至少一条」）在字典里查不到元素类型，冒烟 body 只能给空数组 `[]`——正常用例照样被
     * 业务校验拦下，跟 body 是 `{}` 是同一种假失败，只是藏得更深。
     */
    private void resolveBodyDtos(Path dir, Set<String> wanted) {
        Set<String> pending = new HashSet<>(wanted);
        // 认不出来的（不在源码树、产物里也没有）：试过这一轮就不再重试，
        // 不然每轮都要把产物完整 walk 一遍
        Set<String> giveUp = new HashSet<>();
        Set<String> known = new HashSet<>();
        for (int round = 0; round < NESTED_ROUNDS && !pending.isEmpty(); round++) {
            Set<String> batch = new HashSet<>(pending);
            for (DtoFieldSource src : dtoSources) src.register(dir, batch);
            // 认下来的算数靠**问注册表**，不靠「wanted 被摘剩什么」：各来源是否就地摘除入参
            // 由它们自己决定（JarArtifactResolver 就不改入参，rebind 的是它自己的局部变量），
            // 拿剩下的反推会把它认下的整批都当失败
            Set<String> resolved = new HashSet<>();
            for (String t : pending) {
                if (registry.hasFields(t)) resolved.add(t);
            }
            if (resolved.isEmpty()) return; // 一层都认不下来，再挖也没有新东西
            known.addAll(resolved);
            registry.markReachable(resolved);
            // round 0 是 body 本身（各来源已经各自报过流水了），后面几轮是它字段引用的类型
            if (round > 0) {
                Progress.report("  ↳ body 字段引用的嵌套类型：" + resolved.size() + " 个（前端造元素骨架要用）");
            }
            for (String t : pending) {
                if (!resolved.contains(t)) giveUp.add(t);
            }
            pending.clear();
            if (known.size() >= MAX_REACHABLE_TYPES) {
                Progress.report("  body 嵌套类型展开到 " + known.size() + " 个，封顶收手（骨架也只造到第 3 层）");
                return;
            }
            for (String t : resolved) {
                for (String ref : registry.referencedTypes(t)) {
                    if (!known.contains(ref) && !giveUp.contains(ref)) pending.add(ref);
                }
            }
        }
    }
}
