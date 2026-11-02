package com.chuju.apiforge;

import java.util.Map;

/** 极简 JSON 值转义。只服务本扫描器的输出，性能不是考量，正确性是 */
final class Json {
    private Json() {
    }

    static String str(String s) {
        if (s == null) return "\"\"";
        StringBuilder sb = new StringBuilder(s.length() + 8);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    static String strArr(Iterable<String> items) {
        StringBuilder sb = new StringBuilder("[");
        boolean first = true;
        for (String s : items) {
            if (!first) sb.append(',');
            sb.append(str(s));
            first = false;
        }
        return sb.append(']').toString();
    }

    @SuppressWarnings("unchecked")
    static String obj(Map<String, Object> map) {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, Object> e : map.entrySet()) {
            if (!first) sb.append(',');
            sb.append(str(e.getKey())).append(':');
            Object v = e.getValue();
            if (v instanceof Boolean || v instanceof Number) sb.append(v);
            else sb.append(str(String.valueOf(v)));
            first = false;
        }
        return sb.append('}').toString();
    }
}
