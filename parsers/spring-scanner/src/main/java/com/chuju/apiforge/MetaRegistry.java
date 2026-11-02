package com.chuju.apiforge;

import com.github.javaparser.ast.expr.AnnotationExpr;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 工作区级注解元数据：源码里每个 @interface 声明 → 它自带的注解。
 *
 * 组合注解（自定义 @MyApi 内标 @RestController、@MyGet 内标 @GetMapping）是
 * Spring 的一等公民，只认内置注解会把整类整方法漏掉。@interface 声明和用它的
 * Controller 解析顺序不保证，所以这里只登记、不当场判，装配前由 HierarchyResolver
 * 统一落判。
 *
 * 跨工程留用：api/common 模块定义注解、web 模块使用是常态。
 * 同名 @interface 先到先得（putIfAbsent，与 DtoRegistry.parents 同口径）。
 * 依赖 jar 里的注解（Spring 自带的 GetMapping 等）没有源码、不登记——那是内置表的事。
 */
final class MetaRegistry {

    /** mapping 注解名 → HTTP 动词。@RequestMapping 的 method 属性单独解析（AnnoReaders）。
     *  从 JavaSourceParser 挪过来：组合注解落判（verbOfDeclChain）要查同一张表 */
    static final Map<String, String> MAPPING_VERBS = new HashMap<>();
    static {
        MAPPING_VERBS.put("GetMapping", "GET");
        MAPPING_VERBS.put("PostMapping", "POST");
        MAPPING_VERBS.put("PutMapping", "PUT");
        MAPPING_VERBS.put("DeleteMapping", "DELETE");
        MAPPING_VERBS.put("PatchMapping", "PATCH");
    }

    /** @interface 简名 → 自带注解（直接一层，含空表 = 源码里声明过但没有元注解） */
    private final Map<String, List<AnnotationExpr>> metas = new HashMap<>();

    void register(String annoSimpleName, List<AnnotationExpr> own) {
        if (annoSimpleName != null && !annoSimpleName.isEmpty()) {
            metas.putIfAbsent(annoSimpleName, own);
        }
    }

    /**
     * 声明链落判：这个注解（含传递元注解）最终是不是某个内置 mapping。
     * 返回动词；"ALL" = 链上命中 @RequestMapping 但没定 method（给用法定/默认 GET 兜）；
     * null = 不是 mapping。防环。
     */
    String verbOfDeclChain(String annoSimpleName) {
        return verbOf(annoSimpleName, new HashSet<String>());
    }

    /** 注解（含传递元注解）是否最终挂到 target（"RestController"/"Controller"/"ResponseBody"） */
    boolean resolvesTo(String annoSimpleName, String target) {
        return resolves(annoSimpleName, target, new HashSet<String>());
    }

    private boolean resolves(String name, String target, Set<String> seen) {
        if (name == null || name.isEmpty() || !seen.add(name)) return false;
        if (name.equals(target)) return true;
        List<AnnotationExpr> own = metas.get(name);
        if (own == null) return false;
        for (AnnotationExpr a : own) {
            if (resolves(Names.simpleName(a.getNameAsString()), target, seen)) return true;
        }
        return false;
    }

    private String verbOf(String name, Set<String> seen) {
        if (name == null || name.isEmpty() || !seen.add(name)) return null;
        String v = MAPPING_VERBS.get(name);
        if (v != null) return v;
        List<AnnotationExpr> own = metas.get(name);
        if (own == null) return null;
        for (AnnotationExpr a : own) {
            String child = Names.simpleName(a.getNameAsString());
            if ("RequestMapping".equals(child)) {
                // 自定义 @MyPost 内标 @RequestMapping(method = POST)：method 在声明处
                String declared = AnnoReaders.methodAttrOf(a);
                return declared != null ? declared : "ALL";
            }
            String r = verbOf(child, seen);
            if (r != null) return r;
        }
        return null;
    }
}
