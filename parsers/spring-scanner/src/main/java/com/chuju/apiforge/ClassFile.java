package com.chuju.apiforge;

import com.github.javaparser.ast.expr.AnnotationExpr;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 一个顶层类的解析产物。字段对本包开放（shade 后整个扫描器就这一个包，
 * 包就是封装边界）；写入只发生在 JavaSourceParser，读取在装配与来源链。
 */
final class ClassFile {
    String simpleName;
    String qualifiedName;
    String filePath;
    String packageName = "";
    boolean isController = false;
    boolean isResponseBody = false;
    String classBasePath = "";
    /**
     * Controller 业务名（进 JSON 的 description）：
     * @Api(tags) / @Tag(name) 优先，没有再用类 Javadoc 首行。
     * 类简名（UserController）一直有；业务名才是「控制器叫什么」给人看的。
     */
    String description = "";
    /** 类 Javadoc：首行说明 / @author / @date（流水显示用） */
    String docSummary = "";
    String docAuthor = "";
    String docDate = "";
    /** 类级注解原样引用：组合注解（自定义 @MyApi 内标 @RestController）装配前由 HierarchyResolver 统一落判 */
    final List<AnnotationExpr> annoExprs = new ArrayList<>();
    /** 字段名 → 字段类型简名（类内调用链解析用） */
    final Map<String, String> fieldTypes = new LinkedHashMap<>();
    /** static final String 常量（名 → 字面量）：页面 Controller 爱把视图名写成常量 */
    final Map<String, String> stringConsts = new LinkedHashMap<>();
    /** 方法名 → 方法里用到注入字段的类型（去重保序） */
    final Map<String, Set<String>> methodUses = new LinkedHashMap<>();
    /**
     * 方法名 → 方法体里 throw new XxxException(...) 的收集（类型/消息文案/外层 if
     * 认领的违例字段）。业务异常用例的正源：throw 语句不会撒谎，字段注释会缺席。
     * 只在非空时登记，JSON 里按 methodUses 同样的「实现类 + 接口别名」双份输出。
     */
    final Map<String, List<Map<String, Object>>> bizThrows = new LinkedHashMap<>();
    /** implements 的接口简名：调用链要按接口名再登记一份，Controller 注入接口时链路才不断 */
    final List<String> ifaceNames = new ArrayList<>();
    final List<MethodDecl> methods = new ArrayList<>();
}
