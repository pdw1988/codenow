package com.chuju.apiforge;

/** 文本小工具：候选取值与说明清洗 */
final class Texts {
    private Texts() {
    }

    /** 若干候选里取第一个非空；都空返回 null（方便调用方判断要不要写 JSON） */
    static String firstNonEmpty(String... cands) {
        if (cands == null) return null;
        for (String c : cands) {
            if (c != null && !c.isEmpty()) return c;
        }
        return null;
    }

    /** Javadoc / Swagger 说明里的 HTML 剥掉，只留给人看的一句话 */
    static String stripHtml(String s) {
        if (s == null || s.isEmpty()) return "";
        String t = s.replaceAll("(?i)<br\\s*/?>", " ");
        t = t.replaceAll("<[^>]+>", "");
        t = t.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&");
        t = t.replaceAll("\\s+", " ").trim();
        return t;
    }
}
