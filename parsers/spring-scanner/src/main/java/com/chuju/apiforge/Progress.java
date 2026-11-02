package com.chuju.apiforge;

/**
 * 实时进度行：一律走 stderr、带 "PROG " 前缀（stdout 是 JSON 契约不能碰）。
 * Rust 侧只转发这个前缀的行，别的 stderr 内容（JVM 警告等）不进前端流水。
 */
final class Progress {
    private Progress() {
    }

    static void report(String msg) {
        System.err.println("PROG " + msg);
    }
}
