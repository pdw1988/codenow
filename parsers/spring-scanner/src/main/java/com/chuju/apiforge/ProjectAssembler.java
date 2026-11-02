package com.chuju.apiforge;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 工程装配：第一遍解析完、来源链兜底完之后的收尾。
 * 出两样东西——stderr 的人话解析流水（逐 Controller 逐接口）和
 * stdout JSON 里的本工程块（controllers/mappers/classUses/types/errors）。
 * 流水不是日志是产品：前端实时上屏，行文顺序有契约，改一个字都要过对比。
 */
final class ProjectAssembler {
    private final ClassCatalog catalog;
    private final DtoRegistry registry;
    private final EntityRegistry entities;
    /** 当前工程的接口计数：proj done 事件行要用（前端工程队列的完成态） */
    private int projApis = 0;

    ProjectAssembler(ClassCatalog catalog, DtoRegistry registry, EntityRegistry entities) {
        this.catalog = catalog;
        this.registry = registry;
        this.entities = entities;
    }

    void resetApiCount() {
        projApis = 0;
    }

    int apiCount() {
        return projApis;
    }

    /** 源码路径入口：XML 文件读进内存走同一套装配（jar 模式直接传条目对） */
    String assembleProject(Path dir, String fingerprint, List<String> errors, List<Path> xmlFiles) {
        List<String[]> pairs = new ArrayList<>();
        for (Path f : xmlFiles) {
            try {
                pairs.add(new String[]{f.toString().replace('\\', '/'),
                        new String(java.nio.file.Files.readAllBytes(f), java.nio.charset.StandardCharsets.UTF_8)});
            } catch (java.io.IOException e) {
                continue; // XML 读不了就丢这一个，不阻断
            }
        }
        return assemble(dir, fingerprint, errors, pairs);
    }

    /**
     * 装配主体。xmlPairs 是 [路径/条目名, XML 文本] 对——源码路径来自磁盘文件，
     * jar 模式来自 jar 条目，两者只差这一处，controllers/classUses/types 全共用。
     */
    String assemble(Path dir, String fingerprint, List<String> errors, List<String[]> xmlPairs) {
        String projectName = dir.getFileName() == null
                ? dir.toString() : dir.getFileName().toString();

        StringBuilder controllersJson = new StringBuilder();
        StringBuilder classUsesJson = new StringBuilder();
        StringBuilder bizThrowsJson = new StringBuilder();
        // 每个类以全名/简名两个 key 存进 classes，values() 会有同一份对象；
        // LinkedHashSet 按对象身份去重，否则 Controller 输出两遍
        Set<ClassFile> unique = catalog.unique();
        // Controller 先收成清单：人话块要预告「下一个 Controller」是谁
        List<ClassFile> ctrls = new ArrayList<>();
        for (ClassFile cf : unique) {
            if (cf.isController && !cf.methods.isEmpty()) ctrls.add(cf);
            for (Map.Entry<String, Set<String>> e : cf.methodUses.entrySet()) {
                if (e.getValue().isEmpty()) continue;
                appendClassUse(classUsesJson, cf.qualifiedName, e.getKey(), e.getValue());
                // 接口别名：同一份调用链按实现的接口简名再登记一份，
                // Controller 拿接口名（XxxService）就能查到实现类的调用链
                for (String iface : cf.ifaceNames) {
                    appendClassUse(classUsesJson, iface, e.getKey(), e.getValue());
                }
            }
            // 业务异常收集同一条双轨：实现类全名 + 接口别名（前端按
            // Controller 简名查到接口别名条目，才能走进实现类的 Service 方法）
            for (Map.Entry<String, List<Map<String, Object>>> e : cf.bizThrows.entrySet()) {
                if (e.getValue().isEmpty()) continue;
                appendBizThrow(bizThrowsJson, cf.qualifiedName, e.getKey(), e.getValue());
                for (String iface : cf.ifaceNames) {
                    appendBizThrow(bizThrowsJson, iface, e.getKey(), e.getValue());
                }
            }
        }
        for (int ci = 0; ci < ctrls.size(); ci++) {
            ClassFile cf = ctrls.get(ci);
            Progress.report("controller " + cf.simpleName + " · " + cf.methods.size() + " api");
            if (ci > 0) Progress.report("");
            Progress.report("  ▶ 检测到 @RestController：" + cf.simpleName
                    + (cf.description.isEmpty() ? "" : "（" + cf.description + "）"));
            Progress.report("    class " + cf.qualifiedName);
            String cwho = authorLine(cf.docAuthor, cf.docDate);
            if (!cf.description.isEmpty()) Progress.report("    名称 " + cf.description);
            else if (!cf.docSummary.isEmpty()) Progress.report("    说明 " + cf.docSummary);
            if (!cwho.isEmpty()) Progress.report("    作者 " + cwho);
            if (!cf.classBasePath.isEmpty()) {
                Progress.report("    @RequestMapping(\"" + cf.classBasePath + "\")");
            }
            for (int mi = 0; mi < cf.methods.size(); mi++) {
                MethodDecl m = cf.methods.get(mi);
                projApis++;
                String fullPath = cf.classBasePath + m.methodPath;
                // 末尾 · 方法名：前端实时发现树要显接口名；老前端不认也只当路径尾巴被截掉，无害
                Progress.report("api " + m.httpMethod + " " + fullPath + " · " + m.name);
                Progress.report("    ▸ [" + (mi + 1) + "/" + cf.methods.size() + "] " + m.httpMethod + " " + fullPath);
                Progress.report("        解析方法 " + m.name + "()");
                if (m.description != null && !m.description.isEmpty()) {
                    Progress.report("        说明 " + m.description);
                }
                String mwho = authorLine(m.docAuthor, m.docDate);
                if (!mwho.isEmpty()) Progress.report("        作者 " + mwho);
                Progress.report("        注解 " + m.mappingAnno + " → " + fullPath);
                expandFormParams(m);
                for (int pj = 0; pj < m.parameters.size(); pj++) {
                    Map<String, Object> pm = m.parameters.get(pj);
                    String pos = String.valueOf(pm.get("position"));
                    if (pos.equals("body")) continue; // 请求体在参数后单独一行出
                    StringBuilder pline = new StringBuilder("        参数 ");
                    String anno = positionAnno(pm, pos);
                    if (!anno.isEmpty()) pline.append(anno).append(' ');
                    pline.append(pm.get("name")).append(':').append(pm.get("javaType"));
                    if (pj < m.paramNotes.size() && !m.paramNotes.get(pj).isEmpty()) {
                        pline.append(' ').append(m.paramNotes.get(pj));
                    }
                    if (pos.equals("path")) pline.append(" required");
                    else if (!Boolean.TRUE.equals(pm.get("required"))) pline.append(" 非必填");
                    Progress.report(pline.toString());
                }
                if (m.bodyType != null) {
                    // bodyFields 在第一遍解析时反查，DTO 文件可能排在 Controller 之后没登记到；
                    // 到装配阶段所有类都解析完了（含兜底链），这里补查一次（流水和 JSON 都受益）
                    String bodyKey = m.bodyElem != null ? m.bodyElem : m.bodyType;
                    if (m.bodyFields.isEmpty()) {
                        List<Map<String, Object>> late = registry.fieldsFor(bodyKey, new HashSet<String>());
                        if (late != null && !late.isEmpty()) m.bodyFields = late;
                    }
                    StringBuilder fs = new StringBuilder();
                    Map<String, String> notes = registry.notesFor(bodyKey);
                    for (Map<String, Object> fm : m.bodyFields) {
                        if (fs.length() > 0) fs.append(", ");
                        String fname = String.valueOf(fm.get("name"));
                        fs.append(fname);
                        String note = notes == null ? null : notes.get(fname);
                        if (note != null && !note.isEmpty()) fs.append(note);
                    }
                    Progress.report("        RequestBody " + m.bodyType + (fs.length() > 0 ? " { " + fs + " }" : ""));
                }
                Progress.report("        返回类型 " + m.responseType);
                Progress.report("        ✓ 归属工程 " + projectName + " · 已加入接口库");
            }
            Progress.report("  ✓ " + cf.simpleName + " 解析完毕");
            if (ci + 1 < ctrls.size()) {
                Progress.report("  → 同工程下一个 Controller：" + ctrls.get(ci + 1).simpleName);
            }
            if (controllersJson.length() > 0) controllersJson.append(',');
            controllersJson.append(controllerJson(cf));
        }

        return "{\"projectId\":" + Json.str(dir.toString().replace('\\', '/'))
                + ",\"projectPath\":" + Json.str(dir.toString().replace('\\', '/'))
                + ",\"projectName\":" + Json.str(projectName)
                + ",\"fingerprint\":\"" + fingerprint + "\""
                + ",\"controllers\":[" + controllersJson + "]"
                + ",\"mappers\":[" + MapperXmlParser.mappersJsonText(xmlPairs) + "]"
                + ",\"classUses\":[" + classUsesJson + "]"
                + ",\"bizThrows\":[" + bizThrowsJson + "]"
                + ",\"types\":[" + typesJson() + "]"
                + ",\"entities\":[" + entitiesJson() + "]"
                + ",\"pages\":[" + pagesJson(dir, ctrls) + "]"
                + ",\"errors\":[" + String.join(",", errors) + "]}";
    }

    /** classUses 条目。className 传实现类全名，或接口简名（别名条目，供接口注入的链路反查） */
    private static void appendClassUse(StringBuilder sb, String className, String methodName, Set<String> used) {
        if (sb.length() > 0) sb.append(',');
        sb.append("{\"className\":").append(Json.str(className))
                .append(",\"methodName\":").append(Json.str(methodName))
                .append(",\"usedFieldTypes\":").append(Json.strArr(used)).append('}');
    }

    /**
     * bizThrows 条目（className 语义同 appendClassUse）。throw 细节是
     * 类型/消息/字段三元组；字段数组必须用 strArr 自己拼 —— Json.obj 只认标量，
     * List 会被 String.valueOf 成 `[a, b]` 这种坏 JSON。
     */
    @SuppressWarnings("unchecked")
    private static void appendBizThrow(StringBuilder sb, String className, String methodName,
                                       List<Map<String, Object>> items) {
        if (sb.length() > 0) sb.append(',');
        StringBuilder ts = new StringBuilder();
        for (Map<String, Object> t : items) {
            if (ts.length() > 0) ts.append(',');
            ts.append("{\"type\":").append(Json.str(String.valueOf(t.get("type"))))
                    .append(",\"message\":").append(Json.str(String.valueOf(t.get("message"))))
                    .append(",\"fields\":").append(Json.strArr((java.util.List<String>) t.get("fields")))
                    .append('}');
        }
        sb.append("{\"className\":").append(Json.str(className))
                .append(",\"methodName\":").append(Json.str(methodName))
                .append(",\"throws\":[").append(ts).append("]}");
    }

    /**
     * 工程里的 VO/DTO 字段表。试跑响应的 JSON key 靠它标含义——
     * Controller 返回 {@code Map<String,Object>} 时方法签名里没有 VO，
     * 但 JSON 里的 flowCode 仍能对上 FlowInstanceVo。
     * 只出简名、跳过 Controller 自己，避免跟全名重复、避免把注入的 Service 当字段。
     */
    /**
     * 实体清单（PRD v0.6 模块 4.15）。EntityRegistry 已经把字段拼成
     * name/column/javaType/pk 的 Map，这里只做 JSON 转义与数组拼装。
     */
    private String entitiesJson() {
        StringBuilder sb = new StringBuilder();
        for (Map<String, Object> e : entities.all()) {
            if (sb.length() > 0) sb.append(',');
            StringBuilder fs = new StringBuilder();
            for (Map<String, Object> f : (List<Map<String, Object>>) e.get("fields")) {
                if (fs.length() > 0) fs.append(',');
                fs.append("{\"name\":").append(Json.str(String.valueOf(f.get("name"))))
                        .append(",\"column\":").append(Json.str(String.valueOf(f.get("column"))))
                        .append(",\"javaType\":").append(Json.str(String.valueOf(f.get("javaType"))))
                        .append(",\"pk\":").append(f.get("pk")).append('}');
            }
            sb.append("{\"className\":").append(Json.str(String.valueOf(e.get("className"))))
                    .append(",\"table\":").append(Json.str(String.valueOf(e.get("table"))))
                    .append(",\"fields\":[").append(fs).append("]}");
        }
        return sb.toString();
    }

    private String typesJson() {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, List<Map<String, Object>>> e : registry.entries()) {
            String name = e.getKey();
            if (name.indexOf('.') >= 0) continue;
            ClassFile cf = catalog.get(name);
            if (cf != null && cf.isController) continue;
            List<Map<String, Object>> fields = e.getValue();
            if (fields == null || fields.isEmpty()) continue;
            boolean anyDesc = false;
            for (Map<String, Object> f : fields) {
                Object d = f.get("description");
                if (d instanceof String && !((String) d).isEmpty()) {
                    anyDesc = true;
                    break;
                }
            }
            // 收录判据：写得有字段说明的、名字像模型的，或者**从某个 @RequestBody 走得到的**。
            // 最后一条是给 `*Condition` 这类名字不沾边、说明又只写在 Javadoc（编不进字节码）的
            // DTO 开的：它们是某个 body 的字段类型，前端就靠这张表造元素骨架
            // （List<OrderItemAddCondition> detailList 否则只能给空数组）。
            if (!anyDesc && !Names.isDtoLikeName(name) && !registry.isReachable(name)) continue;
            if (sb.length() > 0) sb.append(',');
            StringBuilder fs = new StringBuilder();
            for (Map<String, Object> f : fields) {
                if (fs.length() > 0) fs.append(',');
                fs.append(Json.obj(f));
            }
            sb.append("{\"name\":").append(Json.str(name))
                    .append(",\"fields\":[").append(fs).append("]}");
        }
        return sb.toString();
    }

    /**
     * 页面方法（页面测试用）：类不是 @RestController / 类级 @ResponseBody、方法也没 @ResponseBody、
     * 动词是 GET、认出了视图名。模板原文带出去由前端算画像（前端读不了磁盘）；
     * jar 模式 dir 是 jar 文件，找不到模板，ftlText 为空。
     */
    private static String pagesJson(Path dir, List<ClassFile> ctrls) {
        StringBuilder sb = new StringBuilder();
        for (ClassFile cf : ctrls) {
            if (cf.isResponseBody) continue;
            for (MethodDecl m : cf.methods) {
                if (m.responseBody || m.viewName == null || !"GET".equals(m.httpMethod)) continue;
                Path ftl = findTemplate(dir, m.viewName);
                String text = "";
                if (ftl != null) {
                    try {
                        text = new String(Files.readAllBytes(ftl), StandardCharsets.UTF_8);
                    } catch (IOException e) {
                        text = ""; // 读不了就当没找到，前端只做巡检
                    }
                }
                if (sb.length() > 0) sb.append(',');
                sb.append("{\"controllerClass\":").append(Json.str(cf.simpleName))
                        .append(",\"methodName\":").append(Json.str(m.name))
                        .append(",\"classBasePath\":").append(Json.str(cf.classBasePath))
                        .append(",\"methodPath\":").append(Json.str(m.methodPath))
                        .append(",\"viewName\":").append(Json.str(m.viewName))
                        .append(",\"needsParams\":").append(m.needsParams)
                        .append(",\"ftlFile\":").append(Json.str(ftl == null ? "" : ftl.toString().replace('\\', '/')))
                        .append(",\"ftlText\":").append(Json.str(text))
                        .append('}');
            }
        }
        return sb.toString();
    }

    /** 视图名 → 模板文件。FreeMarker 老工程在 webapp/WEB-INF/views，Spring Boot 默认在 resources/templates */
    private static Path findTemplate(Path dir, String viewName) {
        String[] roots = {"src/main/webapp/WEB-INF/views", "src/main/resources/templates"};
        String[] exts = {".ftl", ".html"};
        for (String r : roots) {
            for (String ext : exts) {
                Path p = dir.resolve(r).resolve(viewName + ext);
                if (Files.isRegularFile(p)) return p;
            }
        }
        return null;
    }

    private static String controllerJson(ClassFile cf) {
        StringBuilder methods = new StringBuilder();
        for (MethodDecl m : cf.methods) {
            if (methods.length() > 0) methods.append(',');
            StringBuilder params = new StringBuilder();
            for (Map<String, Object> p : m.parameters) {
                if (params.length() > 0) params.append(',');
                params.append(Json.obj(p));
            }
            StringBuilder bodyFields = new StringBuilder();
            for (Map<String, Object> p : m.bodyFields) {
                if (bodyFields.length() > 0) bodyFields.append(',');
                bodyFields.append(Json.obj(p));
            }
            methods.append("{\"methodName\":").append(Json.str(m.name))
                    .append(",\"httpMethod\":\"").append(m.httpMethod).append('"')
                    .append(",\"classBasePath\":").append(Json.str(cf.classBasePath))
                    .append(",\"methodPath\":").append(Json.str(m.methodPath))
                    .append(",\"parameters\":[").append(params).append(']')
                    .append(",\"requestBody\":")
                    .append(m.bodyType == null ? "null"
                            : "{\"type\":" + Json.str(m.bodyType)
                              + ",\"fields\":[" + bodyFields + "]}")
                    .append(",\"responseType\":").append(Json.str(m.responseType))
                    .append(",\"description\":").append(Json.str(m.description))
                    .append(",\"controllerClass\":").append(Json.str(cf.simpleName))
                    .append('}');
        }
        return "{\"className\":" + Json.str(cf.simpleName)
                + ",\"packageName\":" + Json.str(cf.packageName)
                + ",\"basePath\":" + Json.str(cf.classBasePath)
                + ",\"filePath\":" + Json.str(cf.filePath)
                + ",\"description\":" + Json.str(cf.description)
                // 类 Javadoc 的 @author / @date 系 tag。原样输出，不在这里归一：
                // 归一是纯函数，放前端 lib/apiforge/docmeta.ts 才能被 node:test 钉住
                + ",\"author\":" + Json.str(cf.docAuthor)
                + ",\"date\":" + Json.str(cf.docDate)
                + ",\"methods\":[" + methods + "]}";
    }

    /**
     * 无注解命令对象的字段展开（Spring 表单参数绑定的形状）：
     * {@code getApplyPage(OrderQueryCondition condition)} 在页面上不是一个
     * 「condition」参数，而是 applyNo / brandOwnerId / … 逐个查询参数。
     *
     * 为什么在装配阶段才做：解析期只记得下类型名——DTO 源码可能排在 Controller 之后解析，
     * 跨工程源码 / 依赖 jar 两条兜底也要等全工程解析完（与 body 的补查同一时机）。
     *
     * 展开出来的字段 position 写 query：前端只认 query/path/body/header 四种，而命令对象
     * 在线路上确实就是逐个查询（表单）参数。但另外带一个 fromForm 标记——源码里这些字段
     * 没有 @RequestParam 注解，流水不许替它们认领一个（见 positionAnno）。
     *
     * 只展开一层、不递归：嵌套对象字段（brandOwner 这种）照原样留成一个参数名。
     * Spring 的 {@code brandOwner.id=} 点号绑定极少见，猜错了比不猜更坏。
     */
    private void expandFormParams(MethodDecl m) {
        if (m.formTypes.isEmpty()) return;
        Set<String> declared = new HashSet<>();
        for (Map<String, Object> p : m.parameters) declared.add(String.valueOf(p.get("name")));
        for (int i = 0; i < m.formTypes.size(); i++) {
            String type = m.formTypes.get(i);
            String pname = i < m.formParams.size() ? m.formParams.get(i) : type;
            List<Map<String, Object>> fields = registry.fieldsFor(type, new HashSet<String>());
            boolean empty = fields == null || fields.isEmpty();
            Progress.report("        参数 " + pname + ":" + type
                    + (empty ? "（表单对象，字段没解析到——它可能在没构建的模块里）"
                             : "（表单对象，字段按查询参数绑定）"));
            if (empty) continue;
            Map<String, String> notes = registry.notesFor(type);
            for (Map<String, Object> f : fields) {
                String fname = String.valueOf(f.get("name"));
                // 同名的显式参数（@RequestParam applyNo）已经在了就跳过：重一个名字
                // 前端会拼出 ?applyNo=a&applyNo=b 这种谁都没写过的请求
                if (!declared.add(fname)) continue;
                Map<String, Object> pm = new LinkedHashMap<>();
                pm.put("name", fname);
                pm.put("javaType", String.valueOf(f.get("javaType")));
                pm.put("position", "query");
                pm.put("required", Boolean.TRUE.equals(f.get("required")));
                Object desc = f.get("description");
                if (desc instanceof String && !((String) desc).isEmpty()) pm.put("description", desc);
                pm.put("fromForm", true);
                m.parameters.add(pm);
                String note = notes == null ? null : notes.get(fname);
                m.paramNotes.add(note == null ? "" : note);
            }
        }
        // 展开完清空：万一同一批 MethodDecl 被装配两次，字段不能重复追加
        m.formTypes.clear();
        m.formParams.clear();
    }

    /**
     * 参数位置 → 流水「参数」行的注解名；body 单独一行，unknown 不带注解。
     * 命令对象展开出来的字段（fromForm）也不带：它们 position 写 query 是给前端用的，
     * 源码里并没有 @RequestParam，流水不能替它认领一个。
     */
    private static String positionAnno(Map<String, Object> pm, String position) {
        if (Boolean.TRUE.equals(pm.get("fromForm"))) return "";
        if ("query".equals(position)) return "@RequestParam";
        if ("path".equals(position)) return "@PathVariable";
        if ("header".equals(position)) return "@RequestHeader";
        return "";
    }

    /** 「作者」行内容：author · date，缺谁补谁，俩都空返回空串 */
    private static String authorLine(String author, String date) {
        if (author.isEmpty()) return date;
        return date.isEmpty() ? author : author + " · " + date;
    }
}
