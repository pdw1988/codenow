package com.chuju.apiforge;

import com.github.javaparser.ast.expr.AnnotationExpr;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** 一个接口方法的解析产物（Controller 里带 mapping 注解的方法） */
final class MethodDecl {
    String name;
    String httpMethod;
    String methodPath = "";
    /** 命中的 mapping 注解名（解析流水「注解 @XxxMapping」行显示用） */
    String mappingAnno = "";
    /** 方法 Javadoc 的 @author / @date（流水显示用，不进 JSON）；说明进 description */
    String docAuthor = "";
    String docDate = "";
    String responseType = "";
    String description = "";
    final List<Map<String, Object>> parameters = new ArrayList<>();
    /** 与 parameters 按下标对齐的校验注解串（如 "@Size(max=64)"），没有为空串；只进流水 */
    final List<String> paramNotes = new ArrayList<>();
    String bodyType = null;
    /** 集合 body 的元素简名（List<UserReq> → UserReq）；字段按元素反查，type 照实写 List<UserReq> */
    String bodyElem = null;
    List<Map<String, Object>> bodyFields = new ArrayList<>();
    /**
     * 无注解的命令对象参数（{@code getApplyPage(OrderQueryCondition condition)}）：
     * Spring 按字段名把表单/查询参数绑到对象上，所以它既不是 body 也不是一个 query 单值。
     * 解析期只记得下类型名 —— 字段展开留到装配阶段（DTO 源码可能排在 Controller 之后解析，
     * 跨工程源码 / 依赖 jar 两条兜底也还没跑，与 body 的补查同一时机）。
     * formParams/formTypes 按下标对齐（参数名 → 类型简名），与 parameters/paramNotes 同一约定。
     */
    final List<String> formParams = new ArrayList<>();
    final List<String> formTypes = new ArrayList<>();
    /** 方法上标了 @ResponseBody：类是 @Controller 时，靠它把接口方法和页面方法分开 */
    boolean responseBody = false;
    /** 页面方法的视图名（shop/purchase/purchaseApplyList），认不出为 null（见 ViewNames） */
    String viewName = null;
    /** 要带参数才能打开：@PathVariable、必填且无默认值的 @RequestParam、@RequestBody */
    boolean needsParams = false;
    /**
     * 非空 = 自定义 mapping 候选（httpMethod 为 null）：没直接命中内置 mapping
     * 注解时先把方法按候选收下来，HierarchyResolver 落判——@interface 声明文件
     * 可能排在这个文件之后解析，当场判不了。认不出的候选落判时从清单摘除。
     */
    List<AnnotationExpr> pendingAnnos;
}
