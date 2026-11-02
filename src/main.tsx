import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
/**
 * 先引 `mockup/_theme.css`，再引 `index.css`。
 *
 * `_theme.css` 是这个项目唯一的设计系统（5 套主题的变量 + 全部组件类），
 * 原型页面和真应用共用同一份文件 —— 不是「照着原型抄一份 CSS」，
 * 抄一份的结局是原型改了应用没跟着改，然后谁也说不清哪个才对。
 * 它在 vite 的 root（devtools/）里面，所以能直接 import。
 *
 * `index.css` 只放 antd 的桥接和真应用独有的几条，顺序在后面才能盖得住。
 */
import '../mockup/_theme.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
