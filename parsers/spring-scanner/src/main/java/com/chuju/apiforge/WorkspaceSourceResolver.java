package com.chuju.apiforge;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

/**
 * 来源链第二级：跨工程源码兜底。
 * 跨工程 DTO 源码索引：类简名 → 源文件。多工程根目录下「Controller 在 A 工程、
 * DTO 在 B 工程（api 模块）」是常态——只在 A 工程里反查，body 字段就是空的。
 * 扫根目录时一次建好（只收文件名，不解析），按类简名查（Java 一公共类一文件）。
 */
final class WorkspaceSourceResolver implements DtoFieldSource {
    private final SourceFileParser parser;
    private final DtoRegistry registry;
    private final Map<String, Path> workspaceSources = new HashMap<>();

    WorkspaceSourceResolver(SourceFileParser parser, DtoRegistry registry) {
        this.parser = parser;
        this.registry = registry;
    }

    void buildWorkspaceIndex(List<Path> projectDirs) {
        workspaceSources.clear();
        for (Path dir : projectDirs) {
            try (Stream<Path> walk = Files.walk(dir)) {
                walk.filter(Files::isRegularFile)
                    .filter(p -> {
                        for (Path part : p) {
                            String n = part.toString().toLowerCase(Locale.ROOT);
                            if (ScanRules.SKIP_DIRS.contains(n) || (n.startsWith(".") && n.length() > 1)) return false;
                        }
                        return true;
                    })
                    .forEach(p -> {
                        String name = p.getFileName().toString();
                        if (name.endsWith(".java")) {
                            workspaceSources.putIfAbsent(name.substring(0, name.length() - 5), p);
                        }
                    });
            } catch (IOException e) {
                System.err.println("跨工程索引失败 " + dir + ": " + e);
            }
        }
    }

    /**
     * 本工程反查不到的 body DTO，去工作区索引里找源文件走同一条解析流程登记。
     * 命中的从 wanted 移除，jar 兜底只处理真不在源码树里的。
     * 循环顶部的「已登记非空就静默摘除」就是来源链的第一级（本工程已解析）——
     * 它必须留在循环里：前面类型 parseJavaFile 的副作用会顺带登记后面的类型
     * （同文件多类、父类顺链），提前到循环外做，这些类型就会被重复认领、流水变多。
     */
    @Override
    public int register(Path projectDir, Set<String> wanted) {
        if (workspaceSources.isEmpty()) return 0;
        int hit = 0;
        for (String type : new LinkedHashSet<>(wanted)) {
            // 登记过但字段为空的不算数：extends 基类的 Condition 本类就没有字段，
            // 要走下面的顺链解析把父类补上
            List<Map<String, Object>> known = registry.rawFields(type);
            if (known != null && !known.isEmpty()) {
                wanted.remove(type);
                continue;
            }
            String simple = type.contains("<") ? type.substring(0, type.indexOf('<')) : type;
            Path src = workspaceSources.get(simple);
            if (src == null) continue;
            try {
                parser.parse(src);
                // 本类没字段不算完：Condition 普遍 extends 基类，父类可能也在别的
                // 工程——顺 extends 链把父类源码解析了，fieldsFor 合并才有的合
                Set<String> chain = new HashSet<>(Arrays.asList(simple));
                String parent = registry.parentOf(simple);
                while (parent != null && chain.add(parent)) {
                    List<Map<String, Object>> pf = registry.rawFields(parent);
                    if (pf != null && !pf.isEmpty()) break;
                    Path psrc = workspaceSources.get(parent);
                    if (psrc == null) break;
                    try {
                        parser.parse(psrc);
                    } catch (Exception e) {
                        Progress.report("err " + parent + " 跨工程父类解析失败：" + e);
                        break;
                    }
                    parent = registry.parentOf(parent);
                }
                List<Map<String, Object>> fields = registry.fieldsFor(simple, new HashSet<String>());
                if (fields != null && !fields.isEmpty()) {
                    wanted.remove(type);
                    hit++;
                    Progress.report("  dto " + simple + " 字段来自跨工程源码 " + src.getFileName());
                }
            } catch (Exception e) {
                Progress.report("err " + simple + " 跨工程解析失败：" + e);
            }
        }
        if (hit > 0) Progress.report("  ✓ 跨工程源码兜底登记 " + hit + " 个 DTO 的字段");
        return hit;
    }
}
