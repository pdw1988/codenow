package com.chuju.apiforge;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Collectors;

/** 工程内文件收集与指纹：源码一变指纹变，缓存失效（技术方案 §2.8） */
final class SourceCollector {
    /** 防护上限：出句导入页同款哲学 —— 宁可截断报出来，不要把进程卡死 */
    private static final int MAX_FILES = 20000;
    private static final long MAX_FILE_BYTES = 4L * 1024 * 1024;

    private final List<Path> javaFiles = new ArrayList<>();
    private final List<Path> xmlFiles = new ArrayList<>();
    private int fileCount = 0;

    /** 每个工程重置：文件清单与计数都归零 */
    void reset() {
        javaFiles.clear();
        xmlFiles.clear();
        fileCount = 0;
    }

    List<Path> javaFiles() {
        return javaFiles;
    }

    List<Path> xmlFiles() {
        return xmlFiles;
    }

    void collect(Path dir) {
        if (fileCount > MAX_FILES) return;
        try (java.util.stream.Stream<Path> kids = Files.list(dir)) {
            List<Path> sorted = kids.sorted(
                    Comparator.comparing(p -> p.getFileName().toString())).collect(Collectors.toList());
            for (Path p : sorted) {
                if (fileCount > MAX_FILES) return;
                String name = p.getFileName().toString();
                if (Files.isDirectory(p)) {
                    if (ScanRules.SKIP_DIRS.contains(name.toLowerCase(java.util.Locale.ROOT))) continue;
                    collect(p);
                } else {
                    fileCount++;
                    String lower = name.toLowerCase(java.util.Locale.ROOT);
                    try {
                        long size = Files.size(p);
                        if (lower.endsWith(".java") && size <= MAX_FILE_BYTES) {
                            javaFiles.add(p);
                        } else if (lower.endsWith(".xml") && size <= MAX_FILE_BYTES) {
                            xmlFiles.add(p);
                        }
                    } catch (IOException ignored) {
                        // 大小读不到（权限/占用）就跳过，不算失败
                    }
                }
            }
        } catch (IOException e) {
            System.err.println("遍历失败 " + dir + ": " + e);
        }
    }

    /** 路径 + 大小 + 修改时间散列出指纹：源码一变指纹变，缓存失效（技术方案 §2.8） */
    String fingerprint() {
        long h = 0x811c9dc5L;
        for (Path p : javaFiles) h = mix(h, p + "|" + fileSize(p) + "|" + fileMtime(p));
        for (Path p : xmlFiles) h = mix(h, p + "|" + fileSize(p) + "|" + fileMtime(p));
        return String.format("%08x", h);
    }

    /** FNV 搅拌。jar 模式算单文件指纹（路径|大小|修改时间）也用它，混法必须一致 */
    static long mix(long h, String s) {
        for (int i = 0; i < s.length(); i++) {
            h ^= s.charAt(i);
            h *= 0x01000193L;
        }
        return h & 0xffffffffL;
    }

    private long fileSize(Path p) {
        try { return Files.size(p); } catch (IOException e) { return -1; }
    }

    private long fileMtime(Path p) {
        try { return Files.getLastModifiedTime(p).toMillis(); } catch (IOException e) { return -1; }
    }
}
