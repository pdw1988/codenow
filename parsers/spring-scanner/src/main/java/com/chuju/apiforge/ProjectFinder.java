package com.chuju.apiforge;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/** 工程发现：从根目录递归找出所有 Maven/Gradle 工程目录 */
final class ProjectFinder {

    /**
     * 根目录本身是工程 → 单工程；否则递归往下找，直到没有子目录为止（用户拍板：
     * shop/mobile/xxx 这种两层以下的工程也要扫出来）。命中构建文件的目录算一个
     * 工程并停止下钻 —— 工程内部的源码由 SourceCollector 全量收集，多模块 Maven 的
     * 子模块类文件本来就在工程目录下，重复下钻只会把同一批接口报两遍。
     */
    List<Path> findProjectDirs(Path root) {
        List<Path> out = new ArrayList<>();
        if (hasBuildFile(root)) {
            out.add(root);
            return out;
        }
        walkForProjects(root.toAbsolutePath().normalize(), new HashSet<String>(), out);
        if (out.isEmpty() && Files.isDirectory(root.resolve("src"))) {
            // 没有构建文件但直接有 src —— 也当工程试一次，扫出来是空就报空
            out.add(root);
        }
        return out;
    }

    /** 工程数上限：只防符号链接成环/病态目录树，正常远到不了 */
    private static final int MAX_PROJECT_DIRS = 500;

    private void walkForProjects(Path dir, Set<String> visited, List<Path> out) {
        if (out.size() >= MAX_PROJECT_DIRS) return;
        // toRealPath 解析符号链接，环在这里断掉
        String key;
        try {
            key = dir.toRealPath().toString();
        } catch (IOException e) {
            key = dir.toString();
        }
        if (!visited.add(key)) return;
        try (Stream<Path> kids = Files.list(dir)) {
            List<Path> sorted = kids.sorted(Comparator.comparing(p -> p.getFileName().toString()))
                    .collect(Collectors.toList());
            for (Path k : sorted) {
                if (out.size() >= MAX_PROJECT_DIRS) return;
                if (!Files.isDirectory(k)) continue;
                String name = k.getFileName().toString();
                if (ScanRules.SKIP_DIRS.contains(name.toLowerCase(java.util.Locale.ROOT))) continue;
                if (name.startsWith(".")) continue;
                if (hasBuildFile(k)) {
                    out.add(k.toAbsolutePath().normalize());
                    continue;
                }
                walkForProjects(k, visited, out);
            }
        } catch (IOException e) {
            System.err.println("列目录失败 " + dir + ": " + e);
        }
    }

    private boolean hasBuildFile(Path dir) {
        return Files.exists(dir.resolve("pom.xml")) || Files.exists(dir.resolve("build.gradle"))
                || Files.exists(dir.resolve("build.gradle.kts"));
    }
}
