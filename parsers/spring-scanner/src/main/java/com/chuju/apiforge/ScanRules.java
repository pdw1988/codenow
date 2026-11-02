package com.chuju.apiforge;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/** 扫描统一规则。工程发现、文件收集、跨工程索引、jar 深挖共用同一张跳过清单 */
final class ScanRules {
    private ScanRules() {
    }

    static final Set<String> SKIP_DIRS = new HashSet<>(Arrays.asList(
            "target", "node_modules", ".git", "dist", "build", ".idea", ".mvn", ".gradle"));

    /**
     * 解析流水认的校验注解（javax/jakarta validation 常用集），别的注解不上流水。
     * 源码路径（JavaSourceParser）和 jar 字节码路径（JarClassParser）共用——
     * 两条路各自列一份的结果就是流水口径慢慢分叉。
     */
    static final Set<String> VALIDATION_ANNOTATIONS = new HashSet<>(Arrays.asList(
            "NotNull", "NotBlank", "NotEmpty", "Size", "Min", "Max", "DecimalMin", "DecimalMax",
            "Pattern", "Email", "Digits", "Positive", "PositiveOrZero", "Negative", "NegativeOrZero",
            "Past", "PastOrPresent", "Future", "FutureOrPresent", "AssertTrue", "AssertFalse"));
}
