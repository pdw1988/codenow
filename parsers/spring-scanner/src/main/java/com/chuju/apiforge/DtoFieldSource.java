package com.chuju.apiforge;

import java.nio.file.Path;
import java.util.Set;

/**
 * DTO 字段来源链的一级兜底。完整链路：本工程已解析（第一遍解析直接登记，
 * 由 WorkspaceSourceResolver 循环顶部的检查认领——它依赖循环内的解析副作用，
 * 做不成独立实现）→ 跨工程源码 → 依赖 jar 字节码。
 * 同一接口、按序兜底：每级把自己认领的类型从 wanted 摘除，剩下的留给下一级；
 * 登记一律 putIfAbsent，源码永远压过字节码，双保险。
 */
interface DtoFieldSource {
    /** 处理 wanted 里还剩下的类型，返回本级新认领的个数 */
    int register(Path projectDir, Set<String> wanted);
}
