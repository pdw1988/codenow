package com.chuju.apiforge;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** MyBatis mapper XML 解析：语句 → 表名（关联表识别的高可信证据） */
final class MapperXmlParser {
    private MapperXmlParser() {
    }

    /** 文件路径版：读进内存后走同一套解析（jar 模式的 [条目名, 内容] 对也走这里） */
    static String mappersJson(List<Path> xmlFiles) {
        List<String[]> pairs = new ArrayList<>();
        for (Path f : xmlFiles) {
            try {
                pairs.add(new String[]{f.toString().replace('\\', '/'),
                        new String(Files.readAllBytes(f), StandardCharsets.UTF_8)});
            } catch (IOException e) {
                continue; // XML 读不了就丢这一个，不阻断
            }
        }
        return mappersJsonText(pairs);
    }

    /**
     * [路径, XML 文本] 对版。jar 模式的 mapper XML 在 BOOT-INF 里，路径就是条目名
     * （BOOT-INF/classes/mapper/UserMapper.xml）——照原样进 filePath，前端只显示不打开。
     */
    static String mappersJsonText(List<String[]> nameContent) {
        StringBuilder sb = new StringBuilder();
        for (String[] pair : nameContent) {
            String name = pair[0];
            String text = pair[1];
            Matcher ns = Pattern.compile(
                    "<mapper\\b[^>]*\\bnamespace\\s*=\\s*\"([^\"]+)\"").matcher(text);
            if (!ns.find()) continue; // 不是 MyBatis mapper 的 XML（logback 等）
            String namespace = ns.group(1);

            StringBuilder stmts = new StringBuilder();
            Matcher st = Pattern.compile(
                    "<(insert|update|delete|select)\\b[^>]*\\bid\\s*=\\s*\"([^\"]+)\"(.*?)</\\1>",
                    Pattern.CASE_INSENSITIVE | Pattern.DOTALL).matcher(text);
            while (st.find()) {
                List<String> tables = extractTables(st.group(1).toLowerCase(Locale.ROOT), st.group(3));
                if (tables.isEmpty()) continue;
                if (stmts.length() > 0) stmts.append(',');
                stmts.append("{\"id\":").append(Json.str(st.group(2)))
                        .append(",\"op\":\"").append(st.group(1).toLowerCase(Locale.ROOT)).append('"')
                        .append(",\"tables\":").append(Json.strArr(tables)).append('}');
            }
            if (stmts.length() == 0) continue;
            if (sb.length() > 0) sb.append(',');
            sb.append("{\"namespace\":").append(Json.str(namespace))
                    .append(",\"filePath\":").append(Json.str(name))
                    .append(",\"statements\":[").append(stmts).append("]}");
        }
        return sb.toString();
    }

    /**
     * 从 SQL 文本抽表名。insert/update/delete 的首表最可靠；
     * select 抽 from/join 后面的表（关联表识别也要知道读哪些表）。
     * ${...} 动态表名抽不出来 —— 宁可少报，不能报一个不存在的表名。
     */
    private static List<String> extractTables(String op, String sql) {
        Set<String> out = new LinkedHashSet<>();
        List<Pattern> patterns = new ArrayList<>();
        if (op.equals("insert")) {
            patterns.add(Pattern.compile(
                    "\\binsert\\s+into\\s+[`\"\\[]?([\\w$]+)[`\"\\]]?", Pattern.CASE_INSENSITIVE));
        } else if (op.equals("update")) {
            patterns.add(Pattern.compile(
                    "\\bupdate\\s+[`\"\\[]?([\\w$]+)[`\"\\]]?", Pattern.CASE_INSENSITIVE));
        } else if (op.equals("delete")) {
            patterns.add(Pattern.compile(
                    "\\bdelete\\s+from\\s+[`\"\\[]?([\\w$]+)[`\"\\]]?", Pattern.CASE_INSENSITIVE));
        } else {
            patterns.add(Pattern.compile(
                    "\\bfrom\\s+[`\"\\[]?([\\w$]+)[`\"\\]]?", Pattern.CASE_INSENSITIVE));
            patterns.add(Pattern.compile(
                    "\\bjoin\\s+[`\"\\[]?([\\w$]+)[`\"\\]]?", Pattern.CASE_INSENSITIVE));
        }
        for (Pattern p : patterns) {
            Matcher m = p.matcher(sql);
            while (m.find()) {
                String t = m.group(1);
                if (t.contains("$")) continue;
                out.add(t);
            }
        }
        return new ArrayList<>(out);
    }
}
