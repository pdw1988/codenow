package com.chuju.apiforge;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 来源链第三级：依赖 jar 字节码兜底。
 * 从构建产物里解析 DTO 字段表，登记进注册表（putIfAbsent，源码优先）。
 * 来源三种：工程 target/*.jar（Spring Boot fat jar 则拆 BOOT-INF）、
 * target/lib/（dependency-plugin 拷贝的依赖）、&lt;artifactId&gt;/target/ 的 jar。
 * 字节码只有字段名/类型/运行时注解——Javadoc 编译后就没了，没编进注解
 * （@ApiModelProperty/@Schema）的字段说明为空，这是字节码路径的天然上限。
 *
 * 只认 jar、不认 &lt;artifactId&gt;/target/classes：那是「编译过但没打包」的中间产物，
 * 属于使用者该重新 package 的事，扫描器不为它兜底（会读的话反而把「产物是旧的」
 * 这个真问题盖掉）。
 */
final class JarArtifactResolver implements DtoFieldSource {
    /** 祖先链向上找几层：多模块仓库的模块不一定是直接兄弟
     *  （mobile/biz/ruoyi-biz-order-service 依赖的 ruoyi-api 在两级之上），
     *  再往上就是盘符根了 */
    private static final int HUNT_ANCESTORS = 4;
    /** 每个祖先下找模块目录的深度（shop/mobile/biz/xxx-api 正好 3 层，多留余量） */
    private static final int HUNT_DEPTH = 8;

    private final DtoRegistry registry;

    JarArtifactResolver(DtoRegistry registry) {
        this.registry = registry;
    }

    @Override
    public int register(Path dir, Set<String> wanted) {
        wanted = new HashSet<>(wanted);
        wanted.removeAll(Names.NON_DTO_TYPES);
        if (wanted.isEmpty()) return 0;
        Set<String> arts = pomArtifactIds(dir.resolve("pom.xml"));
        if (arts.isEmpty()) return 0;
        int types = 0;
        for (Path jar : jarCandidates(dir, arts)) {
            int before = types;
            types += readJarClasses(jar, wanted, arts);
            if (types > before) {
                Progress.report("  依赖 jar 兜底：" + jar.getFileName() + " 解析出 " + (types - before) + " 个 DTO 字段表");
            }
        }
        if (types > 0) {
            Progress.report("  ✓ 字节码兜底共登记 " + types + " 个 DTO 的字段（说明取决于产物里是否带注解）");
        }
        return types;
    }

    /**
     * 收集可能带 DTO 的产物：工程 target、target/lib（dependency-plugin 拷贝目录）、
     * 祖先目录下**按依赖 artifactId 命名**的模块目录的 target/*.jar。
     * 祖先深挖只认目录名、只下钻目录、深度封顶，大仓库也拖不慢扫描。
     */
    private List<Path> jarCandidates(Path dir, Set<String> arts) {
        LinkedHashSet<Path> out = new LinkedHashSet<>();
        collectJars(dir.resolve("target"), arts, out);
        collectJars(dir.resolve("target").resolve("lib"), null, out); // 依赖拷贝目录不用过滤
        Path p = dir.getParent();
        for (int i = 0; p != null && p.getParent() != null && i < HUNT_ANCESTORS; i++) {
            huntModuleJars(p, arts, out, 0);
            p = p.getParent();
        }
        return new ArrayList<>(out);
    }

    /** 在 root 下按目录名找模块（目录名命中依赖 artifactId 就收它的 target/*.jar），命中即止不再下钻 */
    private void huntModuleJars(Path dir, Set<String> arts, LinkedHashSet<Path> out, int depth) {
        if (depth > HUNT_DEPTH || !Files.isDirectory(dir)) return;
        String name = dir.getFileName() == null ? "" : dir.getFileName().toString();
        if (arts.contains(name)) {
            collectJars(dir.resolve("target"), null, out);
            return;
        }
        if (ScanRules.SKIP_DIRS.contains(name.toLowerCase(Locale.ROOT))) return;
        try (java.util.stream.Stream<Path> kids = Files.list(dir)) {
            for (Path k : kids.collect(Collectors.toList())) {
                if (Files.isDirectory(k)) huntModuleJars(k, arts, out, depth + 1);
            }
        } catch (IOException ignored) {
            // 目录读不了就跳过这棵子树
        }
    }

    /** 目录下的 *.jar（不递归），sources/javadoc 排除；filter 非空时按 artifactId 前缀过滤 */
    private void collectJars(Path dir, Set<String> filter, LinkedHashSet<Path> out) {
        if (!Files.isDirectory(dir)) return;
        try (java.util.stream.Stream<Path> kids = Files.list(dir)) {
            for (Path p : kids.sorted(java.util.Comparator.comparing(x -> x.getFileName().toString())).collect(Collectors.toList())) {
                String name = p.getFileName().toString();
                String lower = name.toLowerCase(Locale.ROOT);
                if (!lower.endsWith(".jar") || lower.endsWith("-sources.jar") || lower.endsWith("-javadoc.jar")) continue;
                if (filter != null && !matchesArtifact(name, filter)) continue;
                out.add(p);
            }
        } catch (IOException ignored) {
            // 目录读不了就没有这份兜底，不算失败
        }
    }

    /** ruoyi-api-2.2.0-SNAPSHOT.jar 是否以某个依赖 artifactId 开头 */
    private boolean matchesArtifact(String jarName, Set<String> arts) {
        for (String a : arts) {
            if (jarName.startsWith(a)) return true;
        }
        return false;
    }

    /** pom.xml 里出现过的 artifactId（正则就够；父子 pom 继承不在扫描器里解析）。
     *  排除块里的 &lt;artifactId&gt;*&lt;/artifactId&gt; 通配符也得挡掉——
     *  Windows 上拿 "*\..." 当路径 resolve 直接抛 InvalidPathException */
    private Set<String> pomArtifactIds(Path pom) {
        Set<String> out = new HashSet<>();
        try {
            String xml = new String(Files.readAllBytes(pom), StandardCharsets.UTF_8);
            Matcher mt = Pattern.compile("<artifactId>([^<]+)</artifactId>").matcher(xml);
            while (mt.find()) {
                String a = mt.group(1).trim();
                if (a.matches("[A-Za-z0-9._-]+")) out.add(a);
            }
        } catch (IOException ignored) {
        }
        return out;
    }

    /**
     * fat jar：BOOT-INF/lib/*.jar 逐个嵌套读（只拆名字命中 pom 依赖的——fat jar 里
     * 几百个 spring-* 用不着全拆）；普通 jar：整个都是 class。返回解析出的类型数
     */
    private int readJarClasses(Path jar, Set<String> wanted, Set<String> arts) {
        int n = 0;
        try (JarFile jf = new JarFile(jar.toFile())) {
            Enumeration<JarEntry> en = jf.entries();
            while (en.hasMoreElements()) {
                JarEntry e = en.nextElement();
                String name = e.getName();
                if (name.startsWith("BOOT-INF/lib/") && name.endsWith(".jar")) {
                    String libName = name.substring(name.lastIndexOf('/') + 1);
                    if (!matchesArtifact(libName, arts)) continue;
                    n += readNestedJar(readEntry(jf, e), wanted);
                } else if (name.endsWith(".class") && !name.contains("$")) {
                    String simple = entrySimpleName(name);
                    if (!wanted.contains(simple)) continue; // 先对名单再读字节，别给每个 class 都掏 IO
                    n += tryRegisterDto(readEntry(jf, e), simple, wanted);
                }
            }
        } catch (IOException ex) {
            Progress.report("err jar 读不了 " + jar.getFileName() + ": " + ex);
        }
        return n;
    }

    /** 读一个 jar 条目并立刻关掉它的流（条目流归 JarFile 管，不关会一直占着） */
    private static byte[] readEntry(JarFile jf, JarEntry e) throws IOException {
        try (InputStream is = jf.getInputStream(e)) {
            return readAll(is);
        }
    }

    /** 嵌套 jar 的 class 遍历（BOOT-INF/lib 里不会再有 BOOT-INF，不递归） */
    private int readNestedJar(byte[] nested, Set<String> wanted) throws IOException {
        int n = 0;
        try (ZipInputStream zin = new ZipInputStream(new ByteArrayInputStream(nested))) {
            ZipEntry e;
            while ((e = zin.getNextEntry()) != null) {
                String name = e.getName();
                if (name.endsWith(".class") && !name.contains("$")) {
                    n += tryRegisterDto(readAll(zin), entrySimpleName(name), wanted);
                }
            }
        }
        return n;
    }

    private String entrySimpleName(String entryName) {
        String name = entryName.substring(0, entryName.length() - 6); // 去 .class
        int slash = name.lastIndexOf('/');
        return slash >= 0 ? name.substring(slash + 1) : name;
    }

    /** 命中 wanted 就解析登记，返回 1 否则 0 */
    private int tryRegisterDto(byte[] data, String simpleName, Set<String> wanted) {
        if (!wanted.contains(simpleName)) return 0;
        try {
            List<Map<String, Object>> fields = dtoFieldsFromClass(data);
            if (!fields.isEmpty()) {
                registry.registerBytecode(simpleName, fields);
                return 1;
            }
        } catch (IOException ignored) {
            // 坏 class 只丢这一个 DTO
        }
        return 0;
    }

    /**
     * 极简 .class 字段表解析（JVMS 常量池 + fields），只取字段名/描述符/运行时注解。
     * 不引 ASM——扫描器 shade 的原则是单文件可用，字段表解析不值得多背一份依赖。
     * 解析到 fields 结束就停，方法区不读。
     */
    private List<Map<String, Object>> dtoFieldsFromClass(byte[] data) throws IOException {
        DataInputStream in = new DataInputStream(new ByteArrayInputStream(data));
        if (in.readInt() != 0xCAFEBABE) throw new IOException("不是 class 文件");
        in.readUnsignedShort(); // minor
        in.readUnsignedShort(); // major
        int cpCount = in.readUnsignedShort();
        String[] utf8 = new String[cpCount];
        for (int i = 1; i < cpCount; i++) {
            int tag = in.readUnsignedByte();
            switch (tag) {
                case 1: utf8[i] = in.readUTF(); break; // Utf8
                case 5: case 6: in.readLong(); i++; break; // Long/Double 占两个槽
                case 7: case 8: case 16: case 19: case 20: in.readUnsignedShort(); break;
                case 9: case 10: case 11: case 12: case 17: case 18:
                    in.readUnsignedShort(); in.readUnsignedShort(); break;
                case 3: case 4: in.readInt(); break;
                case 15: in.readUnsignedByte(); in.readUnsignedShort(); break; // MethodHandle
                default: throw new IOException("未知常量池 tag " + tag);
            }
        }
        in.readUnsignedShort(); // access_flags
        in.readUnsignedShort(); // this_class
        in.readUnsignedShort(); // super_class
        int ifc = in.readUnsignedShort();
        for (int i = 0; i < ifc; i++) in.readUnsignedShort();
        List<Map<String, Object>> fields = new ArrayList<>();
        int fieldCount = in.readUnsignedShort();
        for (int i = 0; i < fieldCount; i++) {
            int flags = in.readUnsignedShort();
            String fname = utf8[in.readUnsignedShort()];
            String desc = utf8[in.readUnsignedShort()];
            int attrCount = in.readUnsignedShort();
            boolean required = false;
            String fDesc = null;
            String sig = null;
            for (int a = 0; a < attrCount; a++) {
                String aname = utf8[in.readUnsignedShort()];
                byte[] body = new byte[in.readInt()];
                in.readFully(body);
                /*
                 * 泛型实参只活在 Signature 属性里。描述符是**擦除后**的（字段 List<Long>
                 * 只有 Ljava/util/List;），不读这一条，jar 里的 List<Long> 到前端就只剩
                 * 裸 List —— 集合元素认不出来，只能给空数组（cases/generate.ts 的脚手架
                 * 对裸集合就是这么兜的）。源码路径没这问题（JavaSourceParser 保留泛型），
                 * 所以这是只有 jar 来源的 DTO 才踩的断层，而不少工程的 DTO 基本都在 jar 里。
                 */
                if (aname.equals("Signature")) {
                    DataInputStream sgin = new DataInputStream(new ByteArrayInputStream(body));
                    int idx = sgin.readUnsignedShort();
                    if (idx > 0 && idx < utf8.length) sig = utf8[idx];
                    continue;
                }
                if (!aname.equals("RuntimeVisibleAnnotations") && !aname.equals("RuntimeInvisibleAnnotations")) continue;
                DataInputStream ann = new DataInputStream(new ByteArrayInputStream(body));
                int cnt = ann.readUnsignedShort();
                for (int k = 0; k < cnt; k++) {
                    // 类型描述符 Ljavax/validation/constraints/NotNull; → NotNull
                    String type = utf8[ann.readUnsignedShort()];
                    String simple = type;
                    int slash = simple.lastIndexOf('/');
                    if (slash >= 0) simple = simple.substring(slash + 1);
                    if (simple.endsWith(";")) simple = simple.substring(0, simple.length() - 1);
                    int pairs = ann.readUnsignedShort();
                    String value = null, notes = null, description = null, title = null;
                    for (int p = 0; p < pairs; p++) {
                        String pname = utf8[ann.readUnsignedShort()];
                        String v = elementValueText(ann, utf8);
                        if (v == null) continue;
                        if (pname.equals("value") && value == null) value = v;
                        else if (pname.equals("notes") && notes == null) notes = v;
                        else if (pname.equals("description") && description == null) description = v;
                        else if (pname.equals("title") && title == null) title = v;
                    }
                    if (simple.equals("NotNull") || simple.equals("NotBlank") || simple.equals("NotEmpty")) required = true;
                    else if (simple.equals("ApiModelProperty")) fDesc = Texts.firstNonEmpty(fDesc, value, notes);
                    else if (simple.equals("Schema")) fDesc = Texts.firstNonEmpty(fDesc, description, title);
                }
            }
            // static（serialVersionUID 这类）和编译器合成字段都不当业务字段
            if ((flags & 0x0008) != 0 || (flags & 0x1000) != 0) continue;
        // 有 Signature 就用它（带泛型）；没有 / 解析不出来退回描述符（裸类型）
        String typeText = sig == null ? "" : Names.signatureToText(sig);
        Map<String, Object> fm = new java.util.LinkedHashMap<>();
        fm.put("name", fname);
        fm.put("javaType", typeText.isEmpty() ? Names.descriptorToText(desc) : typeText);
            fm.put("required", required);
            if (fDesc != null && !fDesc.isEmpty()) fm.put("description", fDesc);
            fields.add(fm);
        }
        return fields; // 方法区不读，到这里就停
    }

    /**
     * element_value 只取能落成字符串的（'s' 字符串），其余按结构原样消费字节但不取值
     * ——注解嵌套/数组/枚举都必须读对长度，否则后续全错位。
     */
    private String elementValueText(DataInputStream ann, String[] utf8) throws IOException {
        int tag = ann.readUnsignedByte();
        switch (tag) {
            case 's': return utf8[ann.readUnsignedShort()];
            case 'B': case 'C': case 'D': case 'F': case 'I': case 'J': case 'S': case 'Z':
                ann.readUnsignedShort(); return null; // 常量池 idx，原始值不细究
            case 'e': ann.readUnsignedShort(); ann.readUnsignedShort(); return null; // 枚举
            case 'c': ann.readUnsignedShort(); return null; // class
            case '@': { // 嵌套注解：type + 键值对，结构要吃完
                ann.readUnsignedShort();
                int pairs = ann.readUnsignedShort();
                for (int p = 0; p < pairs; p++) {
                    ann.readUnsignedShort();
                    elementValueText(ann, utf8);
                }
                return null;
            }
            case '[': {
                int n = ann.readUnsignedShort();
                for (int p = 0; p < n; p++) elementValueText(ann, utf8);
                return null;
            }
            default: throw new IOException("未知 element_value tag " + tag);
        }
    }

    /** 字段描述符 → 简名文本的规则本体在 Names.descriptorToText（jar 模式共用） */

    /**
     * 读整个流。**不关流**：流的所有权在调用方。
     *
     * 原来是读完就 `in.close()`，对 JarFile 条目流正好、对嵌套 jar 的 ZipInputStream
     * 是灾难：那一遍整包共用同一个流，读完第一个 class 就被关掉，下一次 getNextEntry()
     * 抛「Stream closed」，readJarClasses 的 catch 把整个 jar 剩下的条目全丢了——
     * 嵌套依赖 jar 里只有**第一个 class**能登记成 DTO。Scanner.parseClass 是同一个坑，
     * 两边都走在 jar 上，改一处漏一处照样复发，所以连读法一起收成「readAll 只读不关」。
     */
    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        return bo.toByteArray();
    }
}
