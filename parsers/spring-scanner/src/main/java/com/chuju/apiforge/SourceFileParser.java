package com.chuju.apiforge;

import java.io.IOException;
import java.nio.file.Path;

/** 跨工程兜底要回头解析兄弟工程的源文件 —— 依赖倒置：兜底实现只认这个接口 */
interface SourceFileParser {
    void parse(Path javaFile) throws IOException;
}
