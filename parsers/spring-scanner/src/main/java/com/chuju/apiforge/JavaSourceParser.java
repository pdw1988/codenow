package com.chuju.apiforge;

import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.AnnotationDeclaration;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.RecordDeclaration;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.comments.JavadocComment;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.LambdaExpr;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.stmt.BlockStmt;
import com.github.javaparser.ast.stmt.IfStmt;
import com.github.javaparser.ast.stmt.ThrowStmt;
import com.github.javaparser.ast.type.ClassOrInterfaceType;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Java 源码解析：一个文件进、类信息出（两遍扫描的第一遍）。
 * 只收顶层类；Spring REST 注解当场认，自定义组合注解（@MyApi 内标 @RestController
 * 这类）先按候选收、装配前由 HierarchyResolver 落判。DTO 字段表与 extends 链登记进
 * DtoRegistry，类登记进 ClassCatalog，@interface 声明登记进 MetaRegistry ——
 * 本类不持有跨文件状态，反查都走这三个容器。
 */
final class JavaSourceParser implements SourceFileParser {

    /** 解析流水认的校验注解（javax/jakarta validation 常用集），别的注解不上流水。
     *  规则本体在 ScanRules（jar 字节码路径共用同一份），这里只是引用 */
    private static final java.util.Set<String> VALIDATION_ANNOTATIONS = ScanRules.VALIDATION_ANNOTATIONS;

    /** record javadoc 里的 @param 行：@param name 用户名 → 描述落回同名组件 */
    private static final java.util.regex.Pattern RECORD_PARAM =
            java.util.regex.Pattern.compile("@param\\s+(\\S+)\\s+(.*)");

    static {
        // 默认语言级别在 JAVA_14 以下，Java 17 工程满地的 record 会整文件解析失败、
        // 接口直接丢。设到 JAVA_21：老工程的 8 语法照常解析（源码级别向后兼容），
        // 新工程的 record/sealed/switch 模式也能进来。本机实测 3.26.4 的 class
        // 版本仍是 52，Java 8 JRE 照跑
        StaticJavaParser.getParserConfiguration()
                .setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_21);
    }

    private final ClassCatalog catalog;
    private final DtoRegistry registry;
    private final MetaRegistry meta;
    private final EntityRegistry entities;

    JavaSourceParser(ClassCatalog catalog, DtoRegistry registry, MetaRegistry meta, EntityRegistry entities) {
        this.catalog = catalog;
        this.registry = registry;
        this.meta = meta;
        this.entities = entities;
    }

    @Override
    public void parse(Path f) throws IOException {
        CompilationUnit cu;
        try {
            cu = StaticJavaParser.parse(f);
        } catch (Exception e) {
            throw new IOException("解析失败: " + e.getMessage());
        }
        String filePath = f.toString().replace('\\', '/');
        String pkg = cu.getPackageDeclaration()
                .map(p -> p.getNameAsString()).orElse("");

        for (ClassOrInterfaceDeclaration cls : cu.findAll(ClassOrInterfaceDeclaration.class)) {
            // 只收顶层类：内部类不是注入目标也不是 Controller 挂载点
            if (cls.isNestedType()) continue;
            ClassFile cf = new ClassFile();
            cf.simpleName = cls.getNameAsString();
            cf.qualifiedName = pkg.isEmpty() ? cf.simpleName : pkg + "." + cf.simpleName;
            cf.filePath = filePath;
            cf.packageName = pkg;
            DocNote cdoc = DocNote.parse(cls.getJavadocComment().map(JavadocComment::getContent).orElse(null));
            cf.docSummary = cdoc.summary;
            cf.docAuthor = cdoc.author;
            cf.docDate = cdoc.date;

            for (AnnotationExpr ann : cls.getAnnotations()) {
                cf.annoExprs.add(ann);
                // 全限定写法（@org.springframework...RequestMapping）也认：剥包名再比
                String n = Names.simpleName(ann.getNameAsString());
                if (n.equals("RestController")) {
                    cf.isController = true;
                    cf.isResponseBody = true;
                } else if (n.equals("Controller")) {
                    cf.isController = true;
                } else if (n.equals("ResponseBody")) {
                    cf.isResponseBody = true;
                } else if (n.equals("RequestMapping")) {
                    cf.classBasePath = AnnoReaders.annValuePath(ann);
                } else if (n.equals("Api")) {
                    // swagger v2：@Api(tags="用户") / @Api(tags={"用户","admin"}) / @Api(value="用户")
                    String tags = AnnoReaders.annAttr(ann, "tags", null);
                    if (tags == null || tags.isEmpty()) tags = AnnoReaders.annAttr(ann, "value", null);
                    if (tags != null && !tags.isEmpty()) cf.description = tags;
                } else if (n.equals("Tag")) {
                    // springdoc / OpenAPI 3：@Tag(name="用户管理")
                    String tagName = AnnoReaders.annAttr(ann, "name", null);
                    if (tagName != null && !tagName.isEmpty()) cf.description = tagName;
                }
            }
            // 注解没给业务名时，用类 Javadoc 首行当名字（很多国内工程只写注释不写 Swagger）
            if (cf.description.isEmpty() && !cf.docSummary.isEmpty()) {
                cf.description = cf.docSummary;
            }

            // MyBatis-Plus / JPA 实体登记（PRD v0.6 模块 4.15）：@TableName / @Table 的类
            // 进对账清单，没注解的类在里面空手而归，零成本
            entities.registerFrom(cls, pkg);

            // implements 的接口（剥包名取简名）。调用链条目挂在实现类名下，而
            // Controller 字段声明的是接口类型 —— 不记接口名，识别第一跳就断
            for (ClassOrInterfaceType it : cls.getImplementedTypes()) {
                String n = it.getNameAsString();
                if (n.contains(".")) n = n.substring(n.lastIndexOf('.') + 1);
                if (!n.isEmpty() && !cf.ifaceNames.contains(n)) cf.ifaceNames.add(n);
            }

            // extends 记一张工作区级表：字段表合并（fieldsFor）与跨工程父类解析都要用
            for (ClassOrInterfaceType it : cls.getExtendedTypes()) {
                String n = it.getNameAsString();
                if (n.contains(".")) n = n.substring(n.lastIndexOf('.') + 1);
                if (!n.isEmpty() && !n.startsWith("java.") && !n.equals(cf.simpleName)) {
                    registry.recordExtends(cf.simpleName, n);
                }
            }

            for (FieldDeclaration fd : cls.getFields()) {
                if (fd.isStatic()) {
                    // 视图名常量：SHOP_PURCHASE_APPLY_PAGE = "shop/purchase/purchaseApplyList"
                    if (fd.isFinal() && "String".equals(fd.getElementType().asString())) {
                        for (VariableDeclarator v : fd.getVariables()) {
                            v.getInitializer().filter(Expression::isStringLiteralExpr).ifPresent(init ->
                                    cf.stringConsts.put(v.getNameAsString(), init.asStringLiteralExpr().getValue()));
                        }
                    }
                    continue;
                }
                String type = fd.getElementType().asString();
                if (type.contains("<")) type = type.substring(0, type.indexOf('<'));
                for (VariableDeclarator v : fd.getVariables()) {
                    cf.fieldTypes.put(v.getNameAsString(), Names.simpleName(type));
                }
            }
            registerDtoFields(cf, cls);

            for (MethodDeclaration md : cls.getMethods()) {
                cf.methodUses.put(md.getNameAsString(), resolveMethodUses(md, cf.fieldTypes));
                List<Map<String, Object>> throwsFound = collectBizThrows(md);
                if (!throwsFound.isEmpty()) cf.bizThrows.put(md.getNameAsString(), throwsFound);
                // 非 Controller 也走方法收集：自定义组合注解的 @interface 声明
                // 可能排在任何文件，Controller 身份要等 HierarchyResolver 落判；
                // 落判认不出的候选会被摘掉，非 Controller 的类不会出 JSON
                MethodDecl m = buildApiMethod(md);
                if (m != null) {
                    m.viewName = ViewNames.resolve(md, cf.stringConsts);
                    cf.methods.add(m);
                }
            }
            catalog.register(cf);
        }

        // record（Java 16+）不能当 Controller，但满世界当请求/响应 DTO 用：
        // 登记字段表和类目录即可，不进方法扫描。老工程没有 record，此循环零命中
        for (RecordDeclaration rec : cu.findAll(RecordDeclaration.class)) {
            if (rec.isNestedType()) continue;
            ClassFile cf = new ClassFile();
            cf.simpleName = rec.getNameAsString();
            cf.qualifiedName = pkg.isEmpty() ? cf.simpleName : pkg + "." + cf.simpleName;
            cf.filePath = filePath;
            cf.packageName = pkg;
            DocNote cdoc = DocNote.parse(rec.getJavadocComment().map(JavadocComment::getContent).orElse(null));
            cf.docSummary = cdoc.summary;
            cf.docAuthor = cdoc.author;
            cf.docDate = cdoc.date;
            registerRecordFields(cf, rec);
            catalog.register(cf);
        }

        // @interface 声明进元注解表：组合注解（@MyApi 内标 @RestController）落判的依据。
        // 嵌套声明一并收；声明和使用的解析顺序不保证，这里只登记不当场判
        for (AnnotationDeclaration ad : cu.findAll(AnnotationDeclaration.class)) {
            meta.register(ad.getNameAsString(), ad.getAnnotations());
        }
    }

    /** 方法体里「字段.方法(...)」与裸字段引用用到的注入字段类型 —— 调用链的边 */
    private Set<String> resolveMethodUses(MethodDeclaration md, Map<String, String> fieldTypes) {
        Set<String> out = new LinkedHashSet<>();
        md.getBody().ifPresent((BlockStmt body) -> {
            for (MethodCallExpr call : body.findAll(MethodCallExpr.class)) {
                Expression scope = call.getScope().orElse(null);
                if (scope instanceof NameExpr) {
                    String fieldType = fieldTypes.get(((NameExpr) scope).getNameAsString());
                    if (fieldType != null) out.add(fieldType);
                }
            }
            for (Expression e : body.findAll(Expression.class)) {
                if (e instanceof NameExpr) {
                    String fieldType = fieldTypes.get(((NameExpr) e).getNameAsString());
                    if (fieldType != null) out.add(fieldType);
                }
            }
        });
        return out;
    }

    /**
     * 方法体里 throw new XxxException(...) 的收集 —— 业务异常用例的正源。
     * throw 语句不会撒谎：`if (dto.getBrandOwnerId() == null) throw new BizException("品牌商不能为空")`
     * 一条就同时给出「哪个字段」和「后端自己的文案」，比字段注释猜出来的准。
     *
     * 消息取构造实参里**所有字符串字面量拼接**（"品牌商" + name + "不能为空" 至少
     * 留下字面量那半截）。违例字段认外层 if 条件里的 getXxx()/isXxx() 调用（取最内层
     * 的 if —— 嵌套守卫里真正拦 throw 的是最近那个条件）；lambda 里的 throw 不认领
     * 外层 if（闭包的守卫语义在别处）。异常类型按名字收尾判：不带 Exception 结尾的
     * 构造多半是业务对象不是异常。
     *
     * v1 已知不认的（宁可少报）：校验写在工具/父类方法里、先收集一批错误再一次抛、
     * 消息全靠运行时拼出来。前端对这类接口有「逐字段缺一探查」的保底兜着。
     */
    private List<Map<String, Object>> collectBizThrows(MethodDeclaration md) {
        List<Map<String, Object>> out = new ArrayList<>();
        md.getBody().ifPresent((BlockStmt body) -> {
            for (ThrowStmt stmt : body.findAll(ThrowStmt.class)) {
                if (!(stmt.getExpression() instanceof ObjectCreationExpr)) continue;
                ObjectCreationExpr oc = (ObjectCreationExpr) stmt.getExpression();
                String type = Names.simpleName(oc.getType().getNameAsString());
                if (!type.endsWith("Exception")) continue;
                StringBuilder msg = new StringBuilder();
                for (Expression arg : oc.getArguments()) {
                    for (StringLiteralExpr lit : arg.findAll(StringLiteralExpr.class)) msg.append(lit.getValue());
                }
                // 外层 if 认领违例字段。ThrowStmt 的直接父节点一般是 BlockStmt，
                // 所以要往上多走几层；封顶 6 层防语义树畸形时死走
                Node n = stmt;
                IfStmt guard = null;
                for (int i = 0; i < 6 && n.getParentNode().isPresent(); i++) {
                    n = n.getParentNode().get();
                    if (n instanceof LambdaExpr) break;
                    if (n instanceof IfStmt) { guard = (IfStmt) n; break; }
                }
                java.util.Set<String> fields = new LinkedHashSet<>();
                if (guard != null) {
                    for (MethodCallExpr call : guard.getCondition().findAll(MethodCallExpr.class)) {
                        String name = call.getNameAsString();
                        // CollUtil.isEmpty(...) 这类工具调用也会撞上 is 前缀，撞出来的
                        // 假字段（empty 之类）反正在 DTO 字段表里对不上号，前端会滤掉
                        if (name.length() > 3 && name.startsWith("get")) fields.add(decap(name.substring(3)));
                        else if (name.length() > 2 && name.startsWith("is")) fields.add(decap(name.substring(2)));
                    }
                }
                Map<String, Object> t = new LinkedHashMap<>();
                t.put("type", type);
                t.put("message", msg.toString().trim());
                t.put("fields", new ArrayList<>(fields));
                out.add(t);
            }
        });
        return out;
    }

    /** getXxx → xxx（getter 名转字段名，首字母小写即可，国内 DTO 少见连续大写前缀） */
    private static String decap(String s) {
        if (s.isEmpty()) return s;
        return Character.toLowerCase(s.charAt(0)) + s.substring(1);
    }

    private MethodDecl buildApiMethod(MethodDeclaration md) {
        String http = null;
        String path = null;
        String mappingAnno = null;
        // @RequestMapping 没写 method 时下面按 GET 试探，是不是试探出来的记一笔，
        // 参数解析完在方法末尾复核（带 @RequestBody 的话探测方向是反的）
        boolean verbGuessed = false;
        for (AnnotationExpr ann : md.getAnnotations()) {
            String simple = Names.simpleName(ann.getNameAsString());
            String verb = MetaRegistry.MAPPING_VERBS.get(simple);
            if (verb != null) {
                http = verb;
                path = AnnoReaders.annValuePath(ann);
                mappingAnno = "@" + simple;
            } else if ("RequestMapping".equals(simple) && http == null) {
                http = AnnoReaders.requestMappingMethod(ann);
                verbGuessed = AnnoReaders.methodAttrOf(ann) == null;
                path = AnnoReaders.annValuePath(ann);
                mappingAnno = "@RequestMapping";
            }
        }
        // 没直接命中内置 mapping 时，带注解的方法先按「自定义 mapping 候选」收下来
        // （httpMethod 留空）：@interface 声明可能在这个文件之后才解析，当场判不了。
        // 认不出的候选（@Transactional/@Override 这类）由 HierarchyResolver 落判时摘掉
        List<AnnotationExpr> pending = null;
        if (http == null) {
            if (md.getAnnotations().isEmpty()) return null;
            pending = new ArrayList<>(md.getAnnotations());
        }

        MethodDecl m = new MethodDecl();
        m.name = md.getNameAsString();
        m.httpMethod = http;
        m.methodPath = path == null ? "" : path;
        m.mappingAnno = mappingAnno;
        m.responseType = md.getType().asString();

        for (AnnotationExpr ann : md.getAnnotations()) {
            String n = Names.simpleName(ann.getNameAsString());
            if (n.equals("ApiOperation")) {
                m.description = AnnoReaders.annAttr(ann, "value", null);
            } else if (n.equals("Operation")) {
                m.description = AnnoReaders.annAttr(ann, "summary", null);
            } else if (n.equals("ResponseBody")) {
                m.responseBody = true;
            }
        }
        // 说明的取值顺序：Swagger 注解（@ApiOperation/@Operation）优先，没有再用 Javadoc 首行
        DocNote mdoc = DocNote.parse(md.getJavadocComment().map(JavadocComment::getContent).orElse(null));
        if (m.description == null || m.description.isEmpty()) m.description = mdoc.summary;
        m.docAuthor = mdoc.author;
        m.docDate = mdoc.date;

        for (Parameter p : md.getParameters()) {
            Map<String, Object> pm = new LinkedHashMap<>();
            String pName = p.getNameAsString();
            String pType = p.getType().asString();
            String position = "unknown";
            boolean required = true;
            String dflt = null;
            String pDesc = null;
            boolean isBody = false;

            List<String> extras = new ArrayList<>();
            for (AnnotationExpr ann : p.getAnnotations()) {
                String n = Names.simpleName(ann.getNameAsString());
                switch (n) {
                    case "RequestParam":
                        position = "query";
                        pName = AnnoReaders.annAttr(ann, "name", AnnoReaders.annAttr(ann, "value", pName));
                        required = AnnoReaders.annBoolAttr(ann, "required", true);
                        dflt = AnnoReaders.annAttr(ann, "defaultValue", null);
                        if (required && dflt == null) m.needsParams = true;
                        break;
                    case "PathVariable":
                        position = "path";
                        pName = AnnoReaders.annAttr(ann, "name", AnnoReaders.annAttr(ann, "value", pName));
                        m.needsParams = true;
                        break;
                    case "RequestBody":
                        isBody = true;
                        position = "body";
                        required = AnnoReaders.annBoolAttr(ann, "required", true);
                        m.needsParams = true;
                        break;
                    case "RequestHeader":
                        position = "header";
                        pName = AnnoReaders.annAttr(ann, "name", AnnoReaders.annAttr(ann, "value", pName));
                        break;
                    case "ApiParam":
                        // Swagger 2：value/name 都可能是说明；简写 @ApiParam("关键字") 走 value
                        pDesc = Texts.firstNonEmpty(pDesc, AnnoReaders.annAttr(ann, "value", null), AnnoReaders.annAttr(ann, "name", null));
                        break;
                    case "Parameter":
                        // OpenAPI 3 / swagger-core：description；name 是参数名不当事说明
                        pDesc = Texts.firstNonEmpty(pDesc, AnnoReaders.annAttr(ann, "description", null));
                        break;
                    default:
                        // 位置注解之外只认校验注解（解析流水显示用，如 @Size(max=64)）
                        if (VALIDATION_ANNOTATIONS.contains(n)) extras.add(ann.toString());
                        break;
                }
            }
            // 没写位置注解的参数按 Spring 的绑定约定落判。原来一律留 unknown，前端只认
            // query/path/body/header，这些参数整个被丢掉——界面上「无 path/query/body」，
            // POST 发出去是空 body，参数一个没带。约定是：简单类型 → 查询参数；
            // 复杂类型 → 命令对象，**它的字段**才是参数（表单提交就是这么绑的）。
            // 框架注入类型（HttpServletRequest/Model/MultipartFile）两条都不沾，维持 unknown：
            // 前端什么都不显示，好过凭空显示一个假参数。
            if (position.equals("unknown") && !isBody) {
                if (Names.isSimpleParamType(pType)) {
                    position = "query";
                } else if (Names.isCommandObjectType(pType)) {
                    m.formParams.add(pName);
                    m.formTypes.add(Names.simpleName(pType));
                    continue;
                }
            }
            // 注解没写说明时退回 Javadoc @param；名字以注解解析后的为准
            if (pDesc == null || pDesc.isEmpty()) {
                pDesc = mdoc.params.get(pName);
            }
            if (isBody && m.bodyType == null) {
                String base = Names.simpleName(pType);
                m.bodyElem = Names.collectionElement(pType);
                // List<UserReq> 这类集合 body：字段清单按元素类型反查，type 照实写成 List<UserReq>
                m.bodyType = m.bodyElem != null ? base + "<" + m.bodyElem + ">" : base;
                List<Map<String, Object>> fields = registry.fieldsFor(m.bodyElem != null ? m.bodyElem : base, new HashSet<String>());
                m.bodyFields = fields == null ? new ArrayList<Map<String, Object>>() : fields;
            }

            pm.put("name", pName);
            pm.put("javaType", Names.simpleName(pType));
            pm.put("position", position);
            pm.put("required", required);
            if (dflt != null) pm.put("defaultValue", dflt);
            if (pDesc != null && !pDesc.isEmpty()) pm.put("description", pDesc);
            m.parameters.add(pm);
            m.paramNotes.add(extras.isEmpty() ? "" : String.join(" ", extras));
        }
        // 动词试探的复核：@RequestMapping 不写 method 是**响应所有动词**，按 GET 试探只是
        // 「好过空着」。方法带 @RequestBody 时试探方向就反了——真正调这个接口的人必然
        // POST 带 JSON，而按 GET 发过去照样进得了这个方法（不写 method 不分动词），
        // 只是 RequestResponseBodyMethodProcessor 读不出 body，直接抛
        // "Required request body is missing"，再被全局异常翻成 500，看着像接口坏了。
        // 实测 /api/shop/payorderpush/orderPush：biz-order-service 那份写的是
        // @RequestMapping(value = "/orderPush")，同名的 mobile 那份写的是 @PostMapping
        // （后者本来就扫成 POST）——同一份业务代码，自动化结果一个 200 一个 500。
        if (verbGuessed && m.bodyType != null) {
            m.httpMethod = "POST";
        }
        m.pendingAnnos = pending;
        return m;
    }

    /**
     * DTO 字段清单进缓存。校验注解（@NotNull/@NotBlank/@NotEmpty）标 required，
     * 是 PRD 模块 4.5 异常用例「缺失必填字段」的识别依据。
     * 字段说明（@ApiModelProperty / @Schema / 字段 Javadoc）一并写入，
     * 给试跑响应「字段含义」用；没有就省略 description，前端按常见名兜底。
     */
    /** 字段/record 组件上的注解统一读一遍：required、校验注解流水、Swagger 描述 */
    private static final class FieldMeta {
        boolean required;
        final StringBuilder note = new StringBuilder();
        String desc;
    }

    private static void readFieldMeta(Iterable<AnnotationExpr> anns, FieldMeta m) {
        for (AnnotationExpr ann : anns) {
            String n = ann.getNameAsString();
            if (n.equals("NotNull") || n.equals("NotBlank") || n.equals("NotEmpty")) {
                m.required = true;
            }
            // 校验注解原样进流水（@DecimalMin("0.01") 这种带参的照抄源码写法）
            if (VALIDATION_ANNOTATIONS.contains(n)) {
                if (m.note.length() > 0) m.note.append(' ');
                m.note.append(ann.toString());
            }
            if (n.equals("ApiModelProperty")) {
                // Swagger 2：简写 @ApiModelProperty("流程编码") 走 value；notes 是补充
                m.desc = Texts.firstNonEmpty(m.desc, AnnoReaders.annAttr(ann, "value", null), AnnoReaders.annAttr(ann, "notes", null));
            } else if (n.equals("Schema")) {
                m.desc = Texts.firstNonEmpty(m.desc, AnnoReaders.annAttr(ann, "description", null), AnnoReaders.annAttr(ann, "title", null));
            }
        }
    }

    private void registerDtoFields(ClassFile cf, ClassOrInterfaceDeclaration cls) {
        List<Map<String, Object>> fields = new ArrayList<>();
        Map<String, String> notes = new LinkedHashMap<>();
        for (FieldDeclaration fd : cls.getFields()) {
            if (fd.isStatic()) continue;
            FieldMeta m = new FieldMeta();
            readFieldMeta(fd.getAnnotations(), m);
            String fDesc;
            if (m.desc == null || m.desc.isEmpty()) {
                DocNote fdDoc = DocNote.parse(fd.getJavadocComment().map(JavadocComment::getContent).orElse(null));
                fDesc = Texts.stripHtml(fdDoc.summary);
            } else {
                fDesc = Texts.stripHtml(m.desc);
            }
            // 集合字段保留泛型（List<OrderItemAddCondition>）：前端按
            // List</Set< 前缀识别集合给 []，裸 List 会认不出来填成字符串
            String javaType = Names.fieldTypeText(fd.getElementType().asString());
            for (VariableDeclarator v : fd.getVariables()) {
                Map<String, Object> fm = new LinkedHashMap<>();
                fm.put("name", v.getNameAsString());
                fm.put("javaType", javaType);
                fm.put("required", m.required);
                if (fDesc != null && !fDesc.isEmpty()) fm.put("description", fDesc);
                fields.add(fm);
                notes.put(v.getNameAsString(), m.note.toString());
            }
        }
        registry.registerSource(cf.qualifiedName, cf.simpleName, fields, notes);
    }

    /**
     * record 组件当 DTO 字段登记。描述优先序：组件上的 Swagger 注解 →
     * record javadoc 的 @param 行（国内工程给 record 写注释主要就这一种）→ 组件自带 javadoc。
     */
    private void registerRecordFields(ClassFile cf, RecordDeclaration rec) {
        Map<String, String> paramDocs = new LinkedHashMap<>();
        String raw = rec.getJavadocComment().map(JavadocComment::getContent).orElse(null);
        if (raw != null) {
            for (String line : raw.split("\n")) {
                String t = line.trim();
                if (t.startsWith("*")) t = t.substring(1).trim();
                java.util.regex.Matcher mm = RECORD_PARAM.matcher(t);
                if (mm.matches()) paramDocs.put(mm.group(1), Texts.stripHtml(mm.group(2).trim()));
            }
        }
        List<Map<String, Object>> fields = new ArrayList<>();
        Map<String, String> notes = new LinkedHashMap<>();
        for (Parameter rc : rec.getParameters()) {
            FieldMeta m = new FieldMeta();
            readFieldMeta(rc.getAnnotations(), m);
            String fDesc = m.desc;
            if (fDesc == null || fDesc.isEmpty()) {
                // 组件描述主要写在 record javadoc 的 @param 行里（上面已收集）
                fDesc = paramDocs.get(rc.getNameAsString());
            } else {
                fDesc = Texts.stripHtml(fDesc);
            }
            Map<String, Object> fm = new LinkedHashMap<>();
            fm.put("name", rc.getNameAsString());
            fm.put("javaType", Names.fieldTypeText(rc.getType().asString()));
            fm.put("required", m.required);
            if (fDesc != null && !fDesc.isEmpty()) fm.put("description", fDesc);
            fields.add(fm);
            notes.put(rc.getNameAsString(), m.note.toString());
        }
        registry.registerSource(cf.qualifiedName, cf.simpleName, fields, notes);
    }
}
