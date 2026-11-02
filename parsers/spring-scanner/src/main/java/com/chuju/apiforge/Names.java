package com.chuju.apiforge;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/** 类型名/类名的纯函数集：剥泛型、剥包名、集合元素提取、DTO 命名判别 */
final class Names {
    private Names() {
    }

    private static final Set<String> COLLECTION_TYPES = new HashSet<>(Arrays.asList(
            "List", "Set", "Collection", "Iterable", "ArrayList", "LinkedList", "HashSet",
            "LinkedHashSet", "TreeSet", "Stack", "Vector", "Queue", "Deque"));

    /**
     * 这些类型当 @RequestBody / 嵌套字段就**没有静态字段可言**（JDK、fastjson、Spring 的容器类），
     * 字节码兜底不许把它们的内部字段误登记成 DTO 字段表。
     *
     * 原来住在 JarArtifactResolver，挪到 Names 是因为 Scanner 展开嵌套类型时要用同一份判据
     * （见 referencedType）——同一条规则两处各列一份的结果就是只修好一份。
     *
     * ModelAndView 是后补的：JSP 时代的页面 Controller 爱写成
     * {@code public ModelAndView noticeList(ModelAndView modelAndView, String moduleCode)}，
     * 它是 Spring 注入的页面渲染对象（与 Model/ModelMap 同类），不是命令对象——
     * 不排除的话 一个后台工程就会有几十个方法被误当成表单对象，
     * 流水还会谎称「它可能在没构建的模块里」（它是框架类，任何模块里都没有它的源码）。
     */
    static final Set<String> NON_DTO_TYPES = new HashSet<>(Arrays.asList(
            "String", "Integer", "Long", "Short", "Byte", "Boolean", "Double", "Float", "Character",
            "Object", "Number", "Map", "HashMap", "LinkedHashMap", "List", "ArrayList", "Set",
            "Collection", "Date", "BigDecimal", "BigInteger", "JSONObject", "JSONArray", "JSON",
            "MultipartFile", "File", "JsonNode", "ObjectNode", "HttpServletRequest",
            "HttpServletResponse", "BindingResult", "Model", "ModelMap", "ModelAndView", "Principal", "Locale"));

    /**
     * 无注解的方法参数里，Spring 能直接当一个值绑定的类型（查询/表单参数）。
     * 与 NON_DTO_TYPES 有重叠（Date/Locale 两张表都在）是**故意**的：那张表问的是
     * 「有没有字段表可言」，这张问的是「能不能当一个值绑」，两条判据不同，不要合并。
     */
    static final Set<String> SIMPLE_PARAM_TYPES = new HashSet<>(Arrays.asList(
            "int", "long", "short", "byte", "boolean", "double", "float", "char",
            "Integer", "Long", "Short", "Byte", "Boolean", "Double", "Float", "Character",
            "String", "CharSequence", "StringBuilder", "StringBuffer", "Number",
            "BigDecimal", "BigInteger", "Date", "LocalDate", "LocalDateTime", "LocalTime",
            "OffsetDateTime", "Instant", "Duration", "Period",
            "UUID", "URI", "URL", "Class", "TimeZone", "ZoneId", "Charset", "Currency", "Locale"));

    /**
     * 无注解参数是不是「简单类型」——是就按 Spring 约定当查询参数（{@code list(String status)}）。
     * simpleName 已经剥掉了数组维度和泛型，这里只查表。
     */
    static boolean isSimpleParamType(String type) {
        String n = simpleName(type == null ? "" : type);
        return SIMPLE_PARAM_TYPES.contains(n);
    }

    /**
     * 无注解参数是不是「命令对象」——是就说明**它的字段**才是参数
     * （{@code getApplyPage(OrderQueryCondition condition)}，表单参数按字段名绑）。
     *
     * 集合与数组一律不认：Spring 对无注解集合/数组的绑定取决于泛型与配置，
     * 猜错会凭空长出参数；维持 unknown（前端此时什么都不显示）比造一个假参数安全。
     * 框架注入类型（HttpServletRequest/Model/MultipartFile…）走 NON_DTO_TYPES 排除。
     */
    static boolean isCommandObjectType(String type) {
        String t = type == null ? "" : type.trim();
        if (t.isEmpty() || t.endsWith("[]")) return false;
        if (collectionElement(t) != null) return false;
        String n = simpleName(t);
        // 首字母大写才是类名（int/T/小写开头的都不是）
        if (n.isEmpty() || !Character.isUpperCase(n.charAt(0))) return false;
        return !SIMPLE_PARAM_TYPES.contains(n) && !NON_DTO_TYPES.contains(n);
    }

    /**
     * 一个字段类型文本（fieldTypeText / signatureToText 的产出形状）**引用的 DTO 类型名**：
     * {@code List<DetailAdd>} → {@code DetailAdd}、{@code AddCondition[]} → {@code AddCondition}、
     * {@code Sub} → {@code Sub}；JDK / 容器 / 框架类型和基本类型返回 null（它们没有字段表可言）。
     *
     * 用途只有一个：Scanner 把 @RequestBody 的字段里引用的类型接着当候选去兜底，
     * 不然 {@code List<OrderItemAddCondition> detailList} 这种集合在字典里
     * 查不到元素类型，冒烟 body 只能给空数组——「注释写着至少一条」的字段照样被业务校验拦下。
     */
    static String referencedType(String fieldType) {
        String t = fieldType == null ? "" : fieldType.trim();
        if (t.isEmpty()) return null;
        String elem = collectionElement(t);
        String name = elem != null ? elem : simpleName(t);
        // 泛型变量（T）、内建类型（int）、非类名一律不认：首字母大写才是类
        if (name.isEmpty() || !Character.isUpperCase(name.charAt(0))) return null;
        return NON_DTO_TYPES.contains(name) ? null : name;
    }

    /** List<com.x.User> → User；User[] → User；java.lang.String → String */
    static String simpleName(String type) {
        String t = type;
        int lt = t.indexOf('<');
        if (lt > 0) t = t.substring(0, lt);
        if (t.endsWith("[]")) t = t.substring(0, t.length() - 2);
        int dot = t.lastIndexOf('.');
        t = dot > 0 ? t.substring(dot + 1) : t;
        return t.trim();
    }

    /**
     * DTO 字段类型：集合保留一层泛型（元素走简名），其余照 simpleName 剥掉。
     * {@code java.util.List<com.ruoyi.B>} → {@code List<B>}；
     * {@code Map<String,Object>} → {@code Map<String,Object>}（泛型在，可读性更好）。
     */
    static String fieldTypeText(String type) {
        int lt = type.indexOf('<');
        int gt = type.lastIndexOf('>');
        if (lt > 0 && gt > lt) {
            return simpleName(type.substring(0, lt)) + '<' + simpleName(type.substring(lt + 1, gt)) + '>';
        }
        return simpleName(type);
    }

    /** List<XxxReq> 的元素简名；不是集合泛型 / 多泛型参数 / 嵌套泛型就返回 null */
    static String collectionElement(String rawType) {
        int lt = rawType.indexOf('<');
        if (lt < 0 || !rawType.endsWith(">")) return null;
        if (!COLLECTION_TYPES.contains(simpleName(rawType.substring(0, lt)))) return null;
        String inner = rawType.substring(lt + 1, rawType.length() - 1);
        if (inner.contains(",") || inner.contains("<")) return null;
        String elem = simpleName(inner);
        return elem.isEmpty() ? null : elem;
    }

    /**
     * JVM 字段签名（.class 的 Signature 属性）→ 前端读得懂的简名文本。
     *
     * 为什么需要：**.class 里的字段类型描述符是擦除后的** `Ljava/util/List;`，
     * 泛型实参只活在 Signature 属性里。jar 里的 DTO 只走描述符的话，`List<Long>`
     * 到了前端就是裸 `List` —— 集合元素认不出来，只能给空数组（`cases/generate.ts`
     * 的脚手架按裸集合兜底）。源码路径没这问题（JavaSourceParser 保留泛型），
     * 所以这是**只有 jar 来源的 DTO 才踩**的一条断层。
     *
     * 产出形状与 fieldTypeText 对齐（集合带实参、实参走简名）：
     * <pre>
     *   Ljava/util/List&lt;Ljava/lang/Long;&gt;;              → List&lt;Long&gt;
     *   Ljava/util/Map&lt;Ljava/lang/String;Ljava/lang/Object;&gt;; → Map&lt;String,Object&gt;
     *   [Ljava/lang/String;                            → String[]
     *   TT;                                            → T（类型变量名）
     *   Ljava/util/List&lt;+Ljava/lang/Number;&gt;;          → List&lt;Number&gt;（通配符剥掉）
     * </pre>
     */
    static String signatureToText(String sig) {
        if (sig == null || sig.isEmpty()) return "";
        int[] pos = {0};
        return readSignature(sig, pos);
    }

    /** 递归下降读一个字段签名。i[0] 是游标，读完停在该类型之后 */
    private static String readSignature(String s, int[] i) {
        int dims = 0;
        while (i[0] < s.length() && s.charAt(i[0]) == '[') {
            i[0]++;
            dims++;
        }
        if (i[0] >= s.length()) return "";
        String base;
        char c = s.charAt(i[0]);
        switch (c) {
            case 'B': base = "byte"; i[0]++; break;
            case 'C': base = "char"; i[0]++; break;
            case 'D': base = "double"; i[0]++; break;
            case 'F': base = "float"; i[0]++; break;
            case 'I': base = "int"; i[0]++; break;
            case 'J': base = "long"; i[0]++; break;
            case 'S': base = "short"; i[0]++; break;
            case 'Z': base = "boolean"; i[0]++; break;
            case 'L': {
                i[0]++; // 吃掉 L
                int from = i[0];
                while (i[0] < s.length() && s.charAt(i[0]) != '<' && s.charAt(i[0]) != ';') i[0]++;
                base = simpleName(s.substring(from, i[0]).replace('/', '.'));
                StringBuilder args = new StringBuilder();
                if (i[0] < s.length() && s.charAt(i[0]) == '<') {
                    i[0]++;
                    while (i[0] < s.length() && s.charAt(i[0]) != '>') {
                        if (args.length() > 0) args.append(',');
                        char w = s.charAt(i[0]);
                        // 通配符：+ extends / - super 只是限定，* 是无界——剥掉限定词
                        if (w == '+' || w == '-') { i[0]++; w = s.charAt(i[0]); }
                        if (w == '*') { i[0]++; args.append('?'); continue; }
                        args.append(readSignature(s, i));
                    }
                    if (i[0] < s.length()) i[0]++; // 吃掉 >
                }
                if (i[0] < s.length() && s.charAt(i[0]) == ';') i[0]++; // 吃掉 ;
                // 实参全空（List<>）就当没泛型，交回裸集合名，跟描述符那条路一致
                if (args.length() > 0) base = base + '<' + args + '>';
                break;
            }
            case 'T': { // 类型变量：T 后面跟名字到 ;
                i[0]++;
                int from = i[0];
                while (i[0] < s.length() && s.charAt(i[0]) != ';') i[0]++;
                base = s.substring(from, i[0]);
                if (i[0] < s.length()) i[0]++;
                break;
            }
            default: i[0]++; base = String.valueOf(c);
        }
        for (int k = 0; k < dims; k++) base += "[]";
        return base;
    }

    /** 名字像请求/响应模型才值得进 types[]；否则只有写了字段说明的类才收 */
    static boolean isDtoLikeName(String n) {
        String x = n.toLowerCase(Locale.ROOT);
        return x.endsWith("vo") || x.endsWith("dto") || x.endsWith("entity")
                || x.endsWith("req") || x.endsWith("request") || x.endsWith("resp")
                || x.endsWith("response") || x.endsWith("bo") || x.endsWith("form")
                || x.endsWith("query") || x.endsWith("param") || x.endsWith("payload")
                || x.endsWith("model") || x.endsWith("bean") || x.endsWith("page");
    }

    /**
     * JVM 字段描述符 → 简名文本：Ljava/lang/String; → String；[[I → int[][]。
     * JarArtifactResolver 的 DTO 字段兜底和 jar 模式的方法参数都用它——
     * 描述符是**擦除后**的，有 Signature 属性时优先走 signatureToText。
     */
    static String descriptorToText(String d) {
        if (d == null || d.isEmpty()) return d;
        int[] pos = {0};
        return readDescriptorText(d, pos);
    }

    /** 方法描述符 "(Ljava/lang/String;I)V" → 各参数的类型文本（擦除后，无泛型） */
    static java.util.List<String> descriptorParamTypes(String methodDesc) {
        java.util.List<String> out = new java.util.ArrayList<>();
        if (methodDesc == null || methodDesc.isEmpty() || methodDesc.charAt(0) != '(') return out;
        int[] pos = {1};
        while (pos[0] < methodDesc.length() && methodDesc.charAt(pos[0]) != ')') {
            String t = readDescriptorText(methodDesc, pos);
            if (t.isEmpty()) break; // 描述符坏了就到此为止，别死循环
            out.add(t);
        }
        return out;
    }

    private static String readDescriptorText(String d, int[] pos) {
        int dims = 0;
        while (pos[0] < d.length() && d.charAt(pos[0]) == '[') {
            pos[0]++;
            dims++;
        }
        if (pos[0] >= d.length()) return "";
        String base;
        char c = d.charAt(pos[0]);
        switch (c) {
            case 'B': base = "byte"; pos[0]++; break;
            case 'C': base = "char"; pos[0]++; break;
            case 'D': base = "double"; pos[0]++; break;
            case 'F': base = "float"; pos[0]++; break;
            case 'I': base = "int"; pos[0]++; break;
            case 'J': base = "long"; pos[0]++; break;
            case 'S': base = "short"; pos[0]++; break;
            case 'Z': base = "boolean"; pos[0]++; break;
            case 'V': base = "void"; pos[0]++; break;
            case 'L': {
                int from = ++pos[0];
                while (pos[0] < d.length() && d.charAt(pos[0]) != ';') pos[0]++;
                base = d.substring(from, pos[0]).replace('/', '.');
                if (pos[0] < d.length()) pos[0]++; // 吃掉 ;
                int dot = base.lastIndexOf('.');
                base = dot >= 0 ? base.substring(dot + 1) : base;
                break;
            }
            default: pos[0]++; return String.valueOf(c);
        }
        StringBuilder sb = new StringBuilder(base);
        for (int i = 0; i < dims; i++) sb.append("[]");
        return sb.toString();
    }

    /**
     * 方法签名（.class 方法的 Signature 属性）的参数类型文本：
     * {@code (Ljava/lang/String;Ljava/util/List<Lcom/x/Req;>;)V} → ["String", "List<Req>"]。
     * 形式类型参数段（{@code <T:Ljava/lang/Object;>}）跳过；sig 缺失/解析不动返回 null，
     * 调用方退回描述符。泛型实参在这里——body 的 List<Req> 元素全靠它，擦除描述符认不出。
     */
    static java.util.List<String> methodParamTypeTexts(String sig) {
        if (sig == null || sig.isEmpty()) return null;
        try {
            int[] pos = {0};
            skipFormalTypeParams(sig, pos);
            if (pos[0] >= sig.length() || sig.charAt(pos[0]) != '(') return null;
            pos[0]++;
            java.util.List<String> out = new java.util.ArrayList<>();
            while (pos[0] < sig.length() && sig.charAt(pos[0]) != ')') {
                String t = readSignature(sig, pos);
                if (t == null || t.isEmpty()) return null;
                out.add(t);
            }
            return pos[0] < sig.length() ? out : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** 方法签名的返回类型文本（')' 之后整段走 signatureToText）；解析不动返回 null */
    static String methodReturnTypeText(String sig) {
        if (sig == null || sig.isEmpty()) return null;
        try {
            int[] pos = {0};
            skipFormalTypeParams(sig, pos);
            while (pos[0] < sig.length() && sig.charAt(pos[0]) != ')') {
                // 参数段整体走一遍游标（readSignature 会推进），只为定位 ')'
                if (readSignature(sig, pos).isEmpty()) return null;
            }
            if (pos[0] >= sig.length()) return null;
            pos[0]++; // 吃掉 )
            String rest = sig.substring(pos[0]);
            String t = signatureToText(rest);
            return t.isEmpty() ? null : t;
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static void skipFormalTypeParams(String sig, int[] pos) {
        if (pos[0] < sig.length() && sig.charAt(pos[0]) != '<') return;
        int depth = 0;
        while (pos[0] < sig.length()) {
            char c = sig.charAt(pos[0]++);
            if (c == '<') depth++;
            else if (c == '>' && --depth == 0) return;
        }
    }
}
