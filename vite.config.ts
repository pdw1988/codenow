import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = dirname(fileURLToPath(import.meta.url))

// 有 pro/ 就打专业版；开源仓库没有它，@pro 落到占位卡。CODENOW_FREE=1 强制按开源版打，用来验证。
const proEntry = resolve(root, 'pro/src/index.ts')
const withPro = existsSync(proEntry) && !process.env.CODENOW_FREE

// 许可台（签发许可码）只在 pro/ 里、只在开发服务器上挂；开源仓库没有它。
// 路径放变量里：开源版 tsc 不去解析这个不存在的文件；得是绝对 URL，
// vite 把配置编译到 node_modules/.vite-temp 里跑，相对路径会落到那里去。
// rollup input 钉死 index.html，免得 pro/license-admin.html 被打进安装包。
const licenseAdminEntry = pathToFileURL(resolve(root, 'pro/scripts/vite-license-admin.mjs')).href

export default defineConfig(async ({ command }) => ({
  plugins: [
    react(),
    command === 'serve' && withPro ? (await import(licenseAdminEntry)).licenseAdminPlugin() : undefined,
  ],
  resolve: {
    alias: [
      { find: /^@app\//, replacement: resolve(root, 'src') + '/' },
      { find: /^@pro$/, replacement: withPro ? proEntry : resolve(root, 'src/pro-stub/index.ts') },
    ],
  },
  build: {
    rollupOptions: {
      input: resolve(root, 'index.html'),
    },
  },
}))
