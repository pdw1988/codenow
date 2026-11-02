package com.chuju.apiforge;

import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.ast.stmt.BlockStmt;
import com.github.javaparser.ast.stmt.ReturnStmt;

import java.util.Map;

/**
 * 页面方法的视图名。只认字面量和本类 static final 常量，四种写法：
 * return "x" / return 常量 / mv.setViewName(x) / new ModelAndView(x, ...)。
 * redirect: / forward: 不是页面。认不出宁可 null，前端不硬猜。
 */
final class ViewNames {
    private ViewNames() {
    }

    static String resolve(MethodDeclaration md, Map<String, String> consts) {
        String ret = Names.simpleName(md.getType().asString());
        if (!ret.equals("String") && !ret.equals("ModelAndView")) return null;
        if (!md.getBody().isPresent()) return null;
        BlockStmt body = md.getBody().get();
        for (MethodCallExpr call : body.findAll(MethodCallExpr.class)) {
            if (call.getNameAsString().equals("setViewName") && call.getArguments().size() == 1) {
                String v = valueOf(call.getArgument(0), consts);
                if (v != null) return v;
            }
        }
        for (ObjectCreationExpr oc : body.findAll(ObjectCreationExpr.class)) {
            if (Names.simpleName(oc.getType().getNameAsString()).equals("ModelAndView")
                    && !oc.getArguments().isEmpty()) {
                String v = valueOf(oc.getArgument(0), consts);
                if (v != null) return v;
            }
        }
        if (ret.equals("String")) {
            for (ReturnStmt rs : body.findAll(ReturnStmt.class)) {
                if (!rs.getExpression().isPresent()) continue;
                String v = valueOf(rs.getExpression().get(), consts);
                if (v != null) return v;
            }
        }
        return null;
    }

    private static String valueOf(Expression e, Map<String, String> consts) {
        String v = null;
        if (e.isStringLiteralExpr()) v = e.asStringLiteralExpr().getValue();
        else if (e.isNameExpr()) v = consts.get(e.asNameExpr().getNameAsString());
        if (v == null || v.isEmpty() || v.startsWith("redirect:") || v.startsWith("forward:")) return null;
        return v.startsWith("/") ? v.substring(1) : v;
    }
}
