package com.chuju.apiforge;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * DTO 字段登记与反查（PRD 模块 4.4/4.5，@RequestBody 造值的依据）。
 * fields/notes 是工程级（每个工程清空重扫）；extends 是工作区级 ——
 * 跨工程父类解析与字段合并要跨工程留用，clearProjectScope 不动它。
 */
final class DtoRegistry {
    /** DTO 简名/全名 → 字段清单 */
    private final Map<String, List<Map<String, Object>>> fields = new HashMap<>();
    /** 类简名 → 父类简名（extends）。Condition/Query 类的字段大量长在基类里，字段表要顺链合并 */
    private final Map<String, String> parents = new HashMap<>();
    /** DTO 字段上的校验注解串（只进解析流水不进 JSON）：类名 → 字段名 → "@NotNull @Size(max=64)" */
    private final Map<String, Map<String, String>> notes = new HashMap<>();
    /**
     * 能从 @RequestBody 走到的类型：body 本身 + 它字段里引用的类型（Scanner 逐层展开时登记）。
     * 只给 typesJson 的收录判据用 —— 这类类型定义上不是噪音，不管它叫什么名字都该进 types[]。
     */
    private final Set<String> reachable = new HashSet<>();

    void clearProjectScope() {
        fields.clear();
        notes.clear();
        reachable.clear();
    }

    /** 登记「这个类型是某个 body 走得到的」（Scanner 每解析完一层调一次） */
    void markReachable(Set<String> names) {
        reachable.addAll(names);
    }

    boolean isReachable(String simple) {
        return reachable.contains(simple);
    }

    /** 原始登记的字段表（不看父类链 —— 链合并是反查 fieldsFor 时才做的事），没有返回 null */
    List<Map<String, Object>> rawFields(String simple) {
        return fields.get(simple);
    }

    /** 子类 → 父类。putIfAbsent：先到先得，工作区里同名类不互相打架 */
    void recordExtends(String child, String parent) {
        parents.putIfAbsent(child, parent);
    }

    String parentOf(String simple) {
        return parents.get(simple);
    }

    /** 源码解析登记：全名必写，简名/注解串 putIfAbsent（同对象双 key，输出按身份去重） */
    void registerSource(String qualifiedName, String simpleName,
                        List<Map<String, Object>> fs, Map<String, String> ns) {
        fields.put(qualifiedName, fs);
        fields.putIfAbsent(simpleName, fs);
        notes.put(qualifiedName, ns);
        notes.putIfAbsent(simpleName, ns);
    }

    /** jar 字节码登记：putIfAbsent —— 源码（带 Javadoc）优先 */
    void registerBytecode(String simpleName, List<Map<String, Object>> fs) {
        fields.putIfAbsent(simpleName, fs);
        notes.putIfAbsent(simpleName, new LinkedHashMap<String, String>());
    }

    /**
     * DTO 字段表带父类链：Condition/Query 普遍 extends 基类（分页参数等），本类
     * 一个字段没有、字段全在父类是常态。按 extends 链合并（父在前、子覆盖同名），
     * seen 防环。没有 extends 或父类查不到就返回本类自己的——诚实不编。
     */
    List<Map<String, Object>> fieldsFor(String simple, Set<String> seen) {
        if (simple == null || !seen.add(simple)) return null;
        List<Map<String, Object>> own = fields.get(simple);
        String parent = parents.get(simple);
        if (parent == null) return own;
        List<Map<String, Object>> p = fieldsFor(parent, seen);
        if (p == null || p.isEmpty()) return own;
        if (own == null || own.isEmpty()) return p;
        LinkedHashMap<String, Map<String, Object>> merged = new LinkedHashMap<>();
        for (Map<String, Object> f : p) merged.put(String.valueOf(f.get("name")), f);
        for (Map<String, Object> f : own) merged.put(String.valueOf(f.get("name")), f);
        return new ArrayList<>(merged.values());
    }

    /** 类名 → 字段注解串表（解析流水 RequestBody 行拼说明用），没有返回 null */
    Map<String, String> notesFor(String name) {
        return notes.get(name);
    }

    /**
     * 这个类型有没有字段表可看（父类链合并之后的）。Scanner 判断兜底有没有把某个类型
     * 认下来时用它，口径与 WorkspaceSourceResolver 的成功判据一致——别各判各的。
     */
    boolean hasFields(String simple) {
        List<Map<String, Object>> fs = fieldsFor(simple, new HashSet<String>());
        return fs != null && !fs.isEmpty();
    }

    /**
     * 字段表里引用的其它 DTO 类型（集合取元素、数组剥维度、对象取自己，判据在
     * Names.referencedType）。Scanner 逐层展开兜底候选时用：body 的字段类型也要有
     * 字段表，前端才造得出元素骨架（`List<OrderItemAddCondition> detailList`）。
     * 字段表还没有就返回空集——不是错误，是这一轮没得挖。
     */
    Set<String> referencedTypes(String simple) {
        Set<String> out = new HashSet<>();
        List<Map<String, Object>> fs = fieldsFor(simple, new HashSet<String>());
        if (fs == null) return out;
        for (Map<String, Object> f : fs) {
            Object jt = f.get("javaType");
            if (!(jt instanceof String)) continue;
            String ref = Names.referencedType((String) jt);
            if (ref != null && !ref.equals(simple)) out.add(ref);
        }
        return out;
    }

    /** types[] 输出用：简名/全名 → 字段清单的原始视图（遍历序 = HashMap 遍历序） */
    Set<Map.Entry<String, List<Map<String, Object>>>> entries() {
        return fields.entrySet();
    }
}
