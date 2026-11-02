package com.chuju.apiforge;

import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.MemberValuePair;
import com.github.javaparser.ast.expr.NormalAnnotationExpr;
import com.github.javaparser.ast.expr.SingleMemberAnnotationExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * MyBatis-Plus 实体登记（PRD v0.6 模块 4.15：实体/库表结构对账）。
 *
 * 认两类类注解：
 *  - @TableName("t_order") / @TableName(value = "t_order") —— MyBatis-Plus 实体
 *  - @Table(name = "t_order") —— JPA @Entity 顺带认（同一份对账口径）
 * 没有表名的实体跳过：对不了账。
 *
 * 字段口径（MyBatis-Plus 默认 map-underscore-to-camel-case = true）：
 *  - @TableId(...)                主键；value 属性 = 显式列名
 *  - @TableField(exist = false)   非表字段，跳过
 *  - @TableField("col") / @TableField(value = "col")   显式列名
 *  - 其余 camelCase → snake_case
 * static final 常量（serialVersionUID）跳过；主键列推断不出时也不瞎猜，
 * 对账侧按「没映射列」如实报。
 */
final class EntityRegistry {

    private final List<Map<String, Object>> entities = new ArrayList<>();

    List<Map<String, Object>> all() {
        return entities;
    }

    /** 有 @TableName / @Table 的类登记成实体；普通类进来空手而归 */
    void registerFrom(ClassOrInterfaceDeclaration cls, String pkg) {
        String table = tableOf(cls);
        if (table == null || table.isEmpty()) return;
        List<Map<String, Object>> fields = new ArrayList<>();
        for (FieldDeclaration fd : cls.getFields()) {
            if (fd.isStatic() && fd.isFinal()) continue;
            for (VariableDeclarator v : fd.getVariables()) {
                String name = v.getNameAsString();
                AnnotationExpr tableId = ann(fd, "TableId");
                AnnotationExpr tableField = ann(fd, "TableField");
                if (hasExistFalse(tableField)) continue;
                String column = null;
                if (tableId != null) column = valueOf(tableId);
                if (column == null && tableField != null) column = valueOf(tableField);
                if (column == null) column = camelToSnake(name);
                Map<String, Object> f = new LinkedHashMap<>();
                f.put("name", name);
                f.put("column", column);
                f.put("javaType", v.getType().asString());
                f.put("pk", tableId != null);
                fields.add(f);
            }
        }
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("className", pkg.isEmpty() ? cls.getNameAsString() : pkg + "." + cls.getNameAsString());
        e.put("table", table);
        e.put("fields", fields);
        entities.add(e);
    }

    /** 类注解里找表名：@TableName 优先（MP），@Table 的 name 属性兜底（JPA） */
    private String tableOf(ClassOrInterfaceDeclaration cls) {
        for (AnnotationExpr a : cls.getAnnotations()) {
            String n = shortName(a);
            if (n.equals("TableName")) {
                String v = valueOf(a);
                if (v != null) return v;
            }
            if (n.equals("Table")) {
                String v = attr(a, "name");
                if (v != null) return v;
            }
        }
        return null;
    }

    /** @X("v") 或 @X(value = "v") 的字符串值；没有给 null */
    private String valueOf(AnnotationExpr a) {
        String v = attr(a, "value");
        if (v != null) return v;
        if (a instanceof SingleMemberAnnotationExpr) {
            return stringOf(((SingleMemberAnnotationExpr) a).getMemberValue());
        }
        return null;
    }

    private String attr(AnnotationExpr a, String name) {
        if (a instanceof NormalAnnotationExpr) {
            for (MemberValuePair p : ((NormalAnnotationExpr) a).getPairs()) {
                if (p.getNameAsString().equals(name)) return stringOf(p.getValue());
            }
        }
        return null;
    }

    private String stringOf(com.github.javaparser.ast.expr.Expression e) {
        return e instanceof StringLiteralExpr ? ((StringLiteralExpr) e).getValue() : null;
    }

    private boolean hasExistFalse(AnnotationExpr a) {
        if (!(a instanceof NormalAnnotationExpr)) return false;
        for (MemberValuePair p : ((NormalAnnotationExpr) a).getPairs()) {
            if (p.getNameAsString().equals("exist") && p.getValue().toString().trim().equals("false")) return true;
        }
        return false;
    }

    private AnnotationExpr ann(FieldDeclaration fd, String simpleName) {
        for (AnnotationExpr a : fd.getAnnotations()) {
            if (shortName(a).equals(simpleName)) return a;
        }
        return null;
    }

    private String shortName(AnnotationExpr a) {
        String n = a.getNameAsString();
        int dot = n.lastIndexOf('.');
        return dot >= 0 ? n.substring(dot + 1) : n;
    }

    static String camelToSnake(String s) {
        return s.replaceAll("([a-z0-9])([A-Z])", "$1_$2").toLowerCase();
    }
}
