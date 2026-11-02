package com.chuju.apiforge;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * jar 模式的类登记：一个 .class 字节进、Catalog/Registry 登记出。
 * 是 JavaSourceParser 的字节码对应物——同样的容器（ClassCatalog/DtoRegistry）、
 * 同样的装配器（ProjectAssembler），产出 JSON 契约不变，前端零改动。
 *
 * 字节码能拿到什么：注解（映射/Swagger/校验）、字段名与类型（含 Signature 泛型）、
 * 方法参数与返回类型、方法体里的字段访问指令。拿不到什么：Javadoc（编译即失，
 * 说明只剩 Swagger 注解）、throw new 语句的字面量（bizThrows 空，业务异常用例
 * 由前端「逐字段探查」兜底）——这是字节码路径的天然上限，与 JarArtifactResolver
 * 当年登记 DTO 字段时遇到的断层同一条。
 */
final class JarClassParser {

    private final ClassCatalog catalog;
    private final DtoRegistry registry;

    JarClassParser(ClassCatalog catalog, DtoRegistry registry) {
        this.catalog = catalog;
        this.registry = registry;
    }

    /** 一个 .class 字节进、登记出。返回 1 = 成功（进度计数），0 = 失败（进 errors） */
    int parse(byte[] data, String entryName, List<String> errors) {
        try {
            register(ClassBytecodeReader.parse(data), entryName);
            return 1;
        } catch (Exception e) {
            errors.add("{\"file\":" + Json.str(entryName)
                    + ",\"message\":" + Json.str(String.valueOf(e)) + "}");
            return 0;
        }
    }

    private void register(ClassBytecodeReader.ClassInfo ci, String entryName) {
        // 接口/@interface/合成类：接口没有方法体（链路走不进去），注解声明在 jar 模式
        // 组不成 MetaRegistry 的落判材料，合成类不是人写的代码
        if ((ci.access & ClassBytecodeReader.ACC_INTERFACE) != 0
                || (ci.access & ClassBytecodeReader.ACC_ANNOTATION) != 0
                || (ci.access & ClassBytecodeReader.ACC_SYNTHETIC) != 0) return;

        String internal = ci.thisName;
        if (internal.isEmpty()) return;
        String qualified = internal.replace('/', '.');
        int dot = qualified.lastIndexOf('.');
        String simple = dot >= 0 ? qualified.substring(dot + 1) : qualified;
        if (simple.isEmpty()) return;

        ClassFile cf = new ClassFile();
        cf.simpleName = simple;
        cf.qualifiedName = qualified;
        cf.filePath = entryName;
        cf.packageName = dot >= 0 ? qualified.substring(0, dot) : "";

        for (ClassBytecodeReader.Anno a : ci.annos) {
            String n = a.name;
            if (n.equals("RestController")) {
                cf.isController = true;
                cf.isResponseBody = true;
            } else if (n.equals("Controller")) {
                cf.isController = true;
            } else if (n.equals("ResponseBody")) {
                cf.isResponseBody = true;
            } else if (n.equals("RequestMapping")) {
                cf.classBasePath = pathAttr(a);
            } else if (n.equals("Api")) {
                // swagger v2：@Api(tags=…) / @Api(value=…)
                String tags = Texts.firstNonEmpty(firstOfArray(a.attr("tags", null)), firstOfArray(a.attr("value", null)));
                if (tags != null && !tags.isEmpty()) cf.description = tags;
            } else if (n.equals("Tag")) {
                String tagName = Texts.firstNonEmpty(firstOfArray(a.attr("name", null)));
                if (tagName != null && !tagName.isEmpty()) cf.description = tagName;
            }
        }
        // 字节码没有 Javadoc 可兜底：没有 Swagger 名就空着，流水照常出类名

        // extends 记工作区级表：Condition 基类在依赖 jar 里时 fieldsFor 顺链合并要靠它
        String sup = ci.superName.replace('/', '.');
        if (!sup.isEmpty() && !sup.startsWith("java.") && !sup.equals(qualified)) {
            int sdot = sup.lastIndexOf('.');
            String supSimple = sdot >= 0 ? sup.substring(sdot + 1) : sup;
            if (!supSimple.isEmpty() && !supSimple.equals(simple)) registry.recordExtends(simple, supSimple);
        }
        // implements 的接口：调用链条目按接口名出别名（与源码路径同口径）
        for (String iface : ci.ifaces) {
            String dotted = iface.replace('/', '.');
            int idot = dotted.lastIndexOf('.');
            String n = idot >= 0 ? dotted.substring(idot + 1) : dotted;
            if (!n.isEmpty() && !cf.ifaceNames.contains(n)) cf.ifaceNames.add(n);
        }

        for (ClassBytecodeReader.FieldInfo f : ci.fields) {
            if ((f.flags & 0x0008) != 0 || (f.flags & ClassBytecodeReader.ACC_SYNTHETIC) != 0) continue;
            cf.fieldTypes.put(f.name, Names.descriptorToText(f.descriptor));
        }

        registerDtoFields(cf, ci);

        for (ClassBytecodeReader.MethodInfo m : ci.methods) {
            if (m.name.startsWith("<")) continue; // <init>/<clinit>
            if ((m.flags & 0x0040) != 0 || (m.flags & ClassBytecodeReader.ACC_SYNTHETIC) != 0) continue; // bridge/synthetic
            // 所有方法都记字段使用：Service 的方法调 mapper 字段，链路第二跳靠它
            cf.methodUses.put(m.name, resolveMethodUses(ci, m, cf));
            MethodDecl dm = buildApiMethod(m);
            if (dm != null) cf.methods.add(dm);
        }
        catalog.register(cf);
    }

    /** 字段表 + 校验注解串登记。与源码 registerDtoFields 同一产出形状 */
    private void registerDtoFields(ClassFile cf, ClassBytecodeReader.ClassInfo ci) {
        List<Map<String, Object>> fields = new ArrayList<>();
        Map<String, String> notes = new java.util.LinkedHashMap<>();
        for (ClassBytecodeReader.FieldInfo f : ci.fields) {
            if ((f.flags & 0x0008) != 0 || (f.flags & ClassBytecodeReader.ACC_SYNTHETIC) != 0) continue;
            boolean required = false;
            StringBuilder note = new StringBuilder();
            String desc = null;
            for (ClassBytecodeReader.Anno a : f.annos) {
                String n = a.name;
                if (n.equals("NotNull") || n.equals("NotBlank") || n.equals("NotEmpty")) required = true;
                if (ScanRules.VALIDATION_ANNOTATIONS.contains(n)) {
                    if (note.length() > 0) note.append(' ');
                    note.append(a.text());
                }
                if (n.equals("ApiModelProperty")) {
                    desc = Texts.firstNonEmpty(desc, a.attr("value", null), a.attr("notes", null));
                } else if (n.equals("Schema")) {
                    desc = Texts.firstNonEmpty(desc, a.attr("description", null), a.attr("title", null));
                }
            }
            // 有 Signature 用它（带泛型）；解析不出退回描述符（裸类型）——与 JarArtifactResolver 同口径
            String typeText = f.signature != null ? Names.signatureToText(f.signature) : "";
            Map<String, Object> fm = new java.util.LinkedHashMap<>();
            fm.put("name", f.name);
            fm.put("javaType", typeText.isEmpty() ? Names.descriptorToText(f.descriptor) : typeText);
            fm.put("required", required);
            if (desc != null && !desc.isEmpty()) fm.put("description", desc);
            fields.add(fm);
            notes.put(f.name, note.toString());
        }
        registry.registerSource(cf.qualifiedName, cf.simpleName, fields, notes);
    }

    /**
     * 方法体 getfield/putfield 扫描 → 用到的注入字段类型（调用链的边）。
     * 源码路径是「方法调用的作用域是字段」；字节码等价形状就是
     * aload_0 + getfield this.userService 之后再 invoke —— 这里认一切
     * **本类字段**的读写指令（getfield/putfield），getstatic 是别人的静态字段不认。
     * 指令走错位时 fieldRefOf 的 tag 校验挡一道，最多漏认不会乱认。
     */
    private Set<String> resolveMethodUses(ClassBytecodeReader.ClassInfo ci,
                                          ClassBytecodeReader.MethodInfo m, ClassFile cf) {
        Set<String> out = new LinkedHashSet<>();
        byte[] code = m.code;
        if (code == null) return out;
        int i = 0;
        while (i < code.length) {
            int op = code[i] & 0xff;
            if ((op == 0xB4 || op == 0xB5) && i + 2 < code.length) {
                int idx = ((code[i + 1] & 0xff) << 8) | (code[i + 2] & 0xff);
                String[] ref = ci.fieldRefOf(idx);
                if (ref != null && ref[0].equals(ci.thisName) && cf.fieldTypes.containsKey(ref[1])) {
                    out.add(cf.fieldTypes.get(ref[1]));
                }
                i += 3;
            } else {
                i += ClassBytecodeReader.instrLen(op, code, i);
            }
        }
        return out;
    }

    /** path 属性取值：value 优先；数组 {"/a", "/b"} 取第一个；没有属性给 ""（源码 annValuePath 口径，调用方直接 isEmpty 判） */
    private static String pathAttr(ClassBytecodeReader.Anno a) {
        String v = firstOfArray(a.attr("value", null));
        if (v == null) v = firstOfArray(a.attr("path", null));
        return v == null ? "" : v;
    }

    /** "{a, b}" → "a"；单值原样；null 进 null 出 */
    private static String firstOfArray(String text) {
        if (text == null) return null;
        String t = text.trim();
        if (t.startsWith("{") && t.endsWith("}")) t = t.substring(1, t.length() - 1);
        int comma = t.indexOf(',');
        String first = (comma >= 0 ? t.substring(0, comma) : t).trim();
        return first.isEmpty() ? null : first;
    }

    /** @RequestMapping 的 method 属性 → 动词；没写返回 null（区别于 GET 兜底） */
    private static String methodAttrOf(ClassBytecodeReader.Anno a) {
        String raw = firstOfArray(a.attr("method", null));
        if (raw == null) return null;
        String upper = raw.toUpperCase(java.util.Locale.ROOT);
        for (String verb : new String[]{"GET", "POST", "PUT", "DELETE", "PATCH"}) {
            if (upper.contains(verb)) return verb;
        }
        return null;
    }

    /**
     * 映射注解 → MethodDecl。与 JavaSourceParser.buildApiMethod 同一套 Spring 落判：
     * GetXxxMapping 直接认；@RequestMapping 没写 method 按 GET 试探，带 @RequestBody
     * 复核成 POST；无注解参数简单类型 → query、命令对象 → formParams（装配期字段展开）。
     * 字节码组不成组合注解的落判材料（@interface 的元注解要它的源码/注解类都进来），
     * 没直接命中内置映射的方法直接不收——宁可少报，与 HierarchyResolver 摘候选同果。
     */
    private MethodDecl buildApiMethod(ClassBytecodeReader.MethodInfo m) {
        String http = null;
        String path = null;
        String mappingAnno = null;
        boolean verbGuessed = false;
        for (ClassBytecodeReader.Anno a : m.annos) {
            String verb = MetaRegistry.MAPPING_VERBS.get(a.name);
            if (verb != null) {
                http = verb;
                path = pathAttr(a);
                mappingAnno = "@" + a.name;
            } else if ("RequestMapping".equals(a.name) && http == null) {
                String declared = methodAttrOf(a);
                http = declared != null ? declared : "GET";
                verbGuessed = declared == null;
                path = pathAttr(a);
                mappingAnno = "@RequestMapping";
            }
        }
        if (http == null) return null;

        MethodDecl md = new MethodDecl();
        md.name = m.name;
        md.httpMethod = http;
        md.methodPath = path == null ? "" : path;
        md.mappingAnno = mappingAnno;
        // 返回类型优先走方法签名（保留泛型），解析不动退回擦除描述符
        String sigReturn = Names.methodReturnTypeText(m.signature);
        md.responseType = sigReturn != null ? sigReturn
                : Names.descriptorToText(returnDescriptorOf(m.descriptor));

        for (ClassBytecodeReader.Anno a : m.annos) {
            if (a.name.equals("ApiOperation")) {
                String v = Texts.firstNonEmpty(firstOfArray(a.attr("value", null)));
                if (v != null && !v.isEmpty() && md.description.isEmpty()) md.description = v;
            } else if (a.name.equals("Operation")) {
                String v = Texts.firstNonEmpty(firstOfArray(a.attr("summary", null)));
                if (v != null && !v.isEmpty() && md.description.isEmpty()) md.description = v;
            }
        }

        List<String> descParams = Names.descriptorParamTypes(m.descriptor);
        List<String> sigParams = Names.methodParamTypeTexts(m.signature);
        int paramCount = descParams.size();
        for (int pi = 0; pi < paramCount; pi++) {
            String descType = descParams.get(pi);
            // 泛型实参只在方法签名里；该下标解析不出退回擦除类型
            String sigType = sigParams != null && pi < sigParams.size() ? sigParams.get(pi) : null;
            String pType = sigType != null && !sigType.isEmpty() ? sigType : descType;

            Map<String, Object> pm = new java.util.LinkedHashMap<>();
            String pName = "arg" + pi; // 字节码没有参数名（javac -parameters 才有，不指望）
            String position = "unknown";
            boolean required = true;
            String dflt = null;
            String pDesc = null;
            boolean isBody = false;

            List<String> extras = new ArrayList<>();
            if (pi < m.paramAnnos.size()) {
                for (ClassBytecodeReader.Anno a : m.paramAnnos.get(pi)) {
                    String n = a.name;
                    if (n.equals("RequestParam")) {
                        position = "query";
                        pName = Texts.firstNonEmpty(a.attr("name", null), a.attr("value", null), pName);
                        required = a.attr("required", "true").equalsIgnoreCase("false") ? false : true;
                        dflt = a.attr("defaultValue", null);
                    } else if (n.equals("PathVariable")) {
                        position = "path";
                        pName = Texts.firstNonEmpty(a.attr("name", null), a.attr("value", null), pName);
                    } else if (n.equals("RequestBody")) {
                        isBody = true;
                        position = "body";
                        required = !a.attr("required", "true").equalsIgnoreCase("false");
                    } else if (n.equals("RequestHeader")) {
                        position = "header";
                        pName = Texts.firstNonEmpty(a.attr("name", null), a.attr("value", null), pName);
                    } else if (n.equals("ApiParam")) {
                        pDesc = Texts.firstNonEmpty(pDesc, firstOfArray(a.attr("value", null)), firstOfArray(a.attr("name", null)));
                    } else if (n.equals("Parameter")) {
                        pDesc = Texts.firstNonEmpty(pDesc, firstOfArray(a.attr("description", null)));
                    } else if (ScanRules.VALIDATION_ANNOTATIONS.contains(n)) {
                        extras.add(a.text());
                    }
                }
            }
            // 没写位置注解的参数按 Spring 绑定约定落判——与源码路径同一条
            if (position.equals("unknown") && !isBody) {
                if (Names.isSimpleParamType(pType)) {
                    position = "query";
                } else if (Names.isCommandObjectType(pType)) {
                    md.formParams.add(pName);
                    md.formTypes.add(Names.simpleName(pType));
                    continue;
                }
            }
            if (isBody && md.bodyType == null) {
                String base = Names.simpleName(pType);
                md.bodyElem = Names.collectionElement(pType);
                md.bodyType = md.bodyElem != null ? base + "<" + md.bodyElem + ">" : base;
                List<Map<String, Object>> fields = registry.fieldsFor(
                        md.bodyElem != null ? md.bodyElem : base, new java.util.HashSet<String>());
                md.bodyFields = fields == null ? new ArrayList<Map<String, Object>>() : fields;
            }

            pm.put("name", pName);
            pm.put("javaType", Names.simpleName(pType));
            pm.put("position", position);
            pm.put("required", required);
            if (dflt != null) pm.put("defaultValue", dflt);
            if (pDesc != null && !pDesc.isEmpty()) pm.put("description", pDesc);
            md.parameters.add(pm);
            md.paramNotes.add(extras.isEmpty() ? "" : String.join(" ", extras));
        }
        // 动词试探复核：不写 method 的 @RequestMapping 实际响应所有动词，
        // 带 body 的方法按 POST 记（与源码路径同一口径，省一次 500 试错）
        if (verbGuessed && md.bodyType != null) {
            md.httpMethod = "POST";
        }
        return md;
    }

    /** "(Ljava/lang/String;I)V" → "V"：描述符的返回段 */
    private static String returnDescriptorOf(String methodDesc) {
        if (methodDesc == null) return "V";
        int close = methodDesc.lastIndexOf(')');
        return close >= 0 && close + 1 < methodDesc.length() ? methodDesc.substring(close + 1) : "V";
    }
}
