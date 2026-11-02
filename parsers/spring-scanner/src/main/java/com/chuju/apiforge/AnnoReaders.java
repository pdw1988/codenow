package com.chuju.apiforge;

import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.ArrayInitializerExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.MemberValuePair;
import com.github.javaparser.ast.expr.NormalAnnotationExpr;
import com.github.javaparser.ast.expr.SingleMemberAnnotationExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;

import java.util.Locale;

/** 注解取值的纯函数集：路径、具名属性、布尔、@RequestMapping 的 method */
final class AnnoReaders {
    private AnnoReaders() {
    }

    /** @Xxx("/path") / @Xxx(value="/path") / @Xxx(path={"/a","/b"}) 的路径值 */
    static String annValuePath(AnnotationExpr ann) {
        if (ann instanceof SingleMemberAnnotationExpr) {
            Expression v = ((SingleMemberAnnotationExpr) ann).getMemberValue();
            if (v instanceof StringLiteralExpr) return ((StringLiteralExpr) v).getValue();
        } else if (ann instanceof NormalAnnotationExpr) {
            for (MemberValuePair pair : ((NormalAnnotationExpr) ann).getPairs()) {
                String n = pair.getNameAsString();
                if (n.equals("value") || n.equals("path")) return literalOrFirst(pair.getValue());
            }
        }
        return "";
    }

    /**
     * 取注解属性。单成员简写形式（`@Api("商品表相关接口")`）在 JavaParser 里是
     * SingleMemberAnnotationExpr，根本没有命名对，只扫 NormalAnnotationExpr 会静默抽不到。
     * 简写的语义就是 value，所以**只在查 value 时**回退；查 tags / name / defaultValue
     * 这些具名属性时不能吃简写值，否则 `@Api("x")` 会被当成 tags="x"。
     */
    static String annAttr(AnnotationExpr ann, String attr, String dflt) {
        if (ann instanceof NormalAnnotationExpr) {
            for (MemberValuePair pair : ((NormalAnnotationExpr) ann).getPairs()) {
                if (pair.getNameAsString().equals(attr)) return literalOrFirst(pair.getValue());
            }
        } else if (ann instanceof SingleMemberAnnotationExpr && "value".equals(attr)) {
            return literalOrFirst(((SingleMemberAnnotationExpr) ann).getMemberValue());
        }
        return dflt;
    }

    static boolean annBoolAttr(AnnotationExpr ann, String attr, boolean dflt) {
        String v = annAttr(ann, attr, null);
        return v == null ? dflt : v.equalsIgnoreCase("true");
    }

    /** value = {"/a", "/b"} 取第一个；value = RequestMethod.POST 原样返回字符串 */
    static String literalOrFirst(Expression e) {
        if (e instanceof StringLiteralExpr) return ((StringLiteralExpr) e).getValue();
        if (e instanceof ArrayInitializerExpr) {
            for (Expression v : ((ArrayInitializerExpr) e).getValues()) {
                String first = literalOrFirst(v);
                if (!first.isEmpty()) return first;
            }
            return "";
        }
        return e.toString();
    }

    /** @RequestMapping(method = RequestMethod.POST)，method = {POST, GET} 取第一个能认的 */
    static String requestMappingMethod(AnnotationExpr ann) {
        String v = methodAttrOf(ann);
        return v != null ? v : "GET"; // Spring 的 @RequestMapping 不写 method 时默认响应所有动词，按 GET 试探
    }

    /** method 属性里的动词；没写返回 null（区别于 requestMappingMethod 的 GET 兜底） */
    static String methodAttrOf(AnnotationExpr ann) {
        if (!(ann instanceof NormalAnnotationExpr)) return null;
        for (MemberValuePair pair : ((NormalAnnotationExpr) ann).getPairs()) {
            if (pair.getNameAsString().equals("method")) {
                String raw = literalOrFirst(pair.getValue()).toUpperCase(Locale.ROOT);
                for (String verb : new String[]{"GET", "POST", "PUT", "DELETE", "PATCH"}) {
                    if (raw.contains(verb)) return verb;
                }
                return null;
            }
        }
        return null;
    }
}
