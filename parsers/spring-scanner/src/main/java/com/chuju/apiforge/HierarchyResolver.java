package com.chuju.apiforge;

import com.github.javaparser.ast.expr.AnnotationExpr;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;

/**
 * 第一遍解析完、装配前的收尾落判（都依赖全工程解析完才有完整信息）：
 *
 * ① 组合注解落判：自定义 @MyApi 内标 @RestController、@MyGet 内标 @GetMapping。
 *    @interface 声明文件和用它的 Controller 解析顺序不保证，解析当场判不了；
 *    这里拿 MetaRegistry 的声明链统一判——类的 controller/responseBody 身份、
 *    待定方法的 HTTP 动词与路径。认不出的待定（@Transactional、@Override 这类）
 *    从方法清单摘掉，不出 JSON。
 * ② 继承链（Spring 语义）：类级 @RequestMapping 子类没写才沿用最近的父类；
 *    基类的 mapping 方法子类没覆写就按子类前缀原样映射（abstract BaseController
 *    挂 @GetMapping 是国内工程的常态写法）。父类不在本工程源码里（依赖 jar /
 *    兄弟工程）就停——诚实不猜。
 */
final class HierarchyResolver {
    private final ClassCatalog catalog;
    private final DtoRegistry registry;
    private final MetaRegistry meta;

    HierarchyResolver(ClassCatalog catalog, DtoRegistry registry, MetaRegistry meta) {
        this.catalog = catalog;
        this.registry = registry;
        this.meta = meta;
    }

    void resolve() {
        // ① 先补身份（继承的父类方法只对 controller 有意义）；只补 true 不翻 false：
        //    直接注解在解析时就认过了
        for (ClassFile cf : catalog.unique()) {
            classify(cf);
        }
        // ② 待定方法统一落判——要在继承之前：基类方法也可能用自定义注解
        for (ClassFile cf : catalog.unique()) {
            Iterator<MethodDecl> it = cf.methods.iterator();
            while (it.hasNext()) {
                MethodDecl m = it.next();
                if (m.httpMethod != null) continue;
                if (resolvePending(m) == null) it.remove();
            }
        }
        // ③ 继承链拼装
        for (ClassFile cf : catalog.unique()) {
            if (cf.isController) inheritFromParents(cf);
        }
    }

    private void classify(ClassFile cf) {
        for (AnnotationExpr ann : cf.annoExprs) {
            String n = Names.simpleName(ann.getNameAsString());
            if (meta.resolvesTo(n, "RestController")) {
                cf.isController = true;
                cf.isResponseBody = true;
            } else if (meta.resolvesTo(n, "Controller")) {
                cf.isController = true;
            }
            if (meta.resolvesTo(n, "ResponseBody")) cf.isResponseBody = true;
        }
    }

    /** 待定方法的落判。返回动词；null = 候选里没有可认的 mapping，方法从清单摘除 */
    private String resolvePending(MethodDecl m) {
        if (m.pendingAnnos == null) return null;
        for (int i = 0; i < m.pendingAnnos.size(); i++) {
            AnnotationExpr ann = m.pendingAnnos.get(i);
            String n = Names.simpleName(ann.getNameAsString());
            String verb = meta.verbOfDeclChain(n);
            if (verb == null) continue;
            if ("ALL".equals(verb)) {
                // @RequestMapping 语义：用法定了 method 用法说了算，没定按 GET 试探（与内置口径一致）。
                // 试探口径与 JavaSourceParser 末尾的复核是同一条：带 @RequestBody 的方法实际是
                // POST 带 JSON，按 GET 记下来，自动化发出去的请求就少一个 body（服务端 500）
                verb = Texts.firstNonEmpty(AnnoReaders.methodAttrOf(ann), m.bodyType != null ? "POST" : "GET");
            }
            m.httpMethod = verb;
            m.methodPath = AnnoReaders.annValuePath(ann);
            m.mappingAnno = "@" + ann.getNameAsString();
            return verb;
        }
        return null;
    }

    private void inheritFromParents(ClassFile cf) {
        // 子类自己「带着 mapping」的同名方法才算覆写（②步已落判，httpMethod 非
        // null 的就是）；只声明没写注解的覆写，Spring 仍按父类方法上的注解映射
        Set<String> ownMapped = new HashSet<>();
        for (MethodDecl m : cf.methods) {
            ownMapped.add(m.name);
        }
        Set<String> seen = new HashSet<>();
        seen.add(cf.simpleName);
        boolean needBase = cf.classBasePath.isEmpty();
        Set<String> claimed = new HashSet<>();
        List<String> contributed = new ArrayList<>();
        String p = registry.parentOf(cf.simpleName);
        while (p != null && seen.add(p)) {
            ClassFile parent = catalog.get(p);
            if (parent == null) break; // 父类不在本工程源码（依赖 jar / 兄弟工程）：源码范围内无解
            if (needBase && !parent.classBasePath.isEmpty()) {
                cf.classBasePath = parent.classBasePath;
                needBase = false;
                contributed.add(p + " 的类级前缀 " + parent.classBasePath);
            }
            int got = 0;
            for (MethodDecl pm : parent.methods) {
                if (pm.httpMethod == null) continue; // 待定没落判的（理论不该有，防御）
                if (ownMapped.contains(pm.name)) continue; // 子类同名方法有自己的映射：以子类为准
                if (!claimed.add(pm.name)) continue; // 更近的祖先已给过同名方法
                cf.methods.add(pm);
                got++;
            }
            if (got > 0) contributed.add(p + " 的 " + got + " 个接口");
            p = registry.parentOf(p);
        }
        if (!contributed.isEmpty()) {
            Progress.report("  ↳ 继承 " + String.join("，", contributed));
        }
    }
}
