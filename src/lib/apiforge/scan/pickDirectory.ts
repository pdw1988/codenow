/**
 * 系统「选文件夹」对话框。APIForge 扫描根必须是本机绝对路径
 * （丢给 java -jar … --root），webkitdirectory 只有相对名不够用。
 *
 * 动态 import：浏览器调试模式不该为桌面专属绑定付加载成本。
 */
import { isTauri } from '../../../storage'

export async function pickDirectory(title = '选择工程目录'): Promise<string | null> {
  if (!isTauri()) {
    throw new Error('选择本地目录请用桌面版（pnpm tauri:dev 或安装包）')
  }
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    directory: true,
    multiple: false,
    title,
  })
  if (typeof selected === 'string' && selected) return selected
  return null
}

/**
 * 系统「选文件」对话框：jar 扫描模式的入口。没有源码、只有打好的 jar
 * （fat jar / 普通jar）时，扫 class 文件里的 Spring 注解同样能出接口库。
 * 返回的绝对路径直接当扫描 root 传给 java -jar（Java 侧按文件后缀分流）。
 */
export async function pickJarFile(title = '选择 Spring Boot Jar 包'): Promise<string | null> {
  if (!isTauri()) {
    throw new Error('选择本地文件请用桌面版（pnpm tauri:dev 或安装包）')
  }
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    directory: false,
    multiple: false,
    title,
    filters: [{ name: 'Spring Boot Jar', extensions: ['jar'] }],
  })
  if (typeof selected === 'string' && selected) return selected
  return null
}
