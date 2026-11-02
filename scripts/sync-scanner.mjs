/**
 * 把重编译出的扫描器 JAR 同步到应用会加载的所有副本位。
 *
 * 为什么要有这个脚本：JAR 有三处副本——Maven 产物（parsers/…/target）、
 * 打包/开发资源（src-tauri/resources）、以及 `tauri dev`/`tauri build` 往
 * `src-tauri/target/{debug,release}/resources` 里拷的运行时副本。Rust 侧
 * scanner_jar 的候选顺序里 Resource 目录（target/…/resources）排在最前，
 * 改了扫描器只重编译 Maven 不同步副本的话，应用会一直用旧 JAR——
 * 「CLI 能扫出来、GUI 重扫没变化」就是这么来的。
 *
 * 用法：重编译扫描器后跑 `pnpm scanner:sync`（maven 打包请看
 * parsers/spring-scanner/README.md）。
 */
import { copyFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const built = path.join(repoRoot, 'parsers/spring-scanner/target/spring-scanner.jar')

if (!existsSync(built)) {
  console.error(`✗ 找不到 ${built}，先构建：cd parsers/spring-scanner && mvn package -DskipTests`)
  process.exit(1)
}

const targets = [
  path.join(repoRoot, 'src-tauri/resources/spring-scanner.jar'),
  path.join(repoRoot, 'src-tauri/target/debug/resources/spring-scanner.jar'),
  path.join(repoRoot, 'src-tauri/target/release/resources/spring-scanner.jar'),
]

for (const t of targets) {
  // release 副本可能还没生成过（没跑过打包），缺目录就不造——tauri build 自己会拷
  if (!existsSync(path.dirname(t))) {
    console.log(`- 跳过 ${path.relative(repoRoot, t)}（目录不存在，打包时会自动生成）`)
    continue
  }
  copyFileSync(built, t)
  console.log(`✓ 已同步 ${path.relative(repoRoot, t)}`)
}
