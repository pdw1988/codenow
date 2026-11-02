package com.chuju.apiforge;

import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * 当前工程的类清单：全名/简名 → 类信息（简名给 DTO 反查用）。
 * 每个工程解析开始前 clear()。
 */
final class ClassCatalog {
    private final Map<String, ClassFile> classes = new HashMap<>();

    void clear() {
        classes.clear();
    }

    /**
     * 全名 key 允许覆盖；简名 key putIfAbsent。跨文件查 DTO 只有简名
     * （@RequestBody UserReq），同简名冲突时后扫的覆盖先扫的 —— 概率低，
     * 且用户在详情里看得见。putIfAbsent：同一对象两个 key，输出侧必须
     * 按对象去重（unique()）。
     */
    void register(ClassFile cf) {
        classes.put(cf.qualifiedName, cf);
        classes.putIfAbsent(cf.simpleName, cf);
    }

    ClassFile get(String name) {
        return classes.get(name);
    }

    /**
     * HashMap 遍历序的按对象身份去重快照。两次快照之间可能因兜底解析
     * （跨工程源码）而多出类，所以每次用都重新取，不能缓存。
     */
    Set<ClassFile> unique() {
        return new LinkedHashSet<>(classes.values());
    }
}
