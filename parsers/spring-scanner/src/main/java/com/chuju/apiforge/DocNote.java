package com.chuju.apiforge;

import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Javadoc 摘出来的：首行说明 / @author / @date 系 / @param 名→说明 */
final class DocNote {
    String summary = "";
    String author = "";
    String date = "";
    /** 参数名 → 说明。没有 @param 的参数不进表 */
    final Map<String, String> params = new LinkedHashMap<>();

    /**
     * @date 的常见变体（国内工程一套注释有各种写法），小写比对。
     * since 不是我们发明的：MyBatis-Plus / 各家代码生成器的默认模板就是
     * `@author xxx` + `@since 2025-04-09 11:14:07`（常见写法），
     * 不收它等于对一整类工程拿不到日期。
     */
    private static final Set<String> DATE_TAGS = new HashSet<>(Arrays.asList(
            "date", "datetime", "createtime", "createdtime", "createddate", "datecreated", "created",
            "since"));

    /**
     * 解析 Javadoc 内容：首个非 @ 开头的非空行当说明，@author / @date 系 / @param 取值。
     * 不走 JavaParser 的 Javadoc 结构化 API —— 拿原始文本按行剥星号更直白。
     */
    static DocNote parse(String raw) {
        DocNote note = new DocNote();
        if (raw == null) return note;
        for (String line0 : raw.split("\n")) {
            String line = line0.trim();
            if (line.startsWith("*")) line = line.substring(1).trim();
            if (line.isEmpty()) continue;
            if (line.startsWith("@")) {
                int sp = line.indexOf(' ');
                String tag = (sp < 0 ? line : line.substring(0, sp)).toLowerCase(Locale.ROOT);
                String val = sp < 0 ? "" : line.substring(sp + 1).trim();
                if (tag.equals("@author")) {
                    if (note.author.isEmpty()) note.author = val;
                } else if (tag.equals("@param")) {
                    // `@param keyword 流程编码/名称/业务ID` → name + 余下说明
                    int sp2 = val.indexOf(' ');
                    if (sp2 > 0) {
                        String pname = val.substring(0, sp2).trim();
                        String pdesc = val.substring(sp2 + 1).trim();
                        if (!pname.isEmpty() && !pdesc.isEmpty() && !note.params.containsKey(pname)) {
                            note.params.put(pname, pdesc);
                        }
                    }
                } else if (tag.length() > 1 && DATE_TAGS.contains(tag.substring(1))) {
                    if (note.date.isEmpty()) note.date = val;
                }
            } else if (note.summary.isEmpty()) {
                note.summary = line;
            }
        }
        return note;
    }
}
