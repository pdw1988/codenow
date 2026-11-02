/**
 * 带行号栏的配置编辑器（PRD 五；原型 mockup/config.html 同款自研结构）。
 *
 * 不引 Monaco/CodeMirror：这个页面的核心是「全文解析 → 校验报行号 → 互转」，
 * 一个 textarea 加一列行号就够了，第三方编辑器的高亮模型反而跟
 * lib/config 的解析结果对不上号（两套语法认知）。
 *
 * 行号单独一列而不是画进 textarea：滚动位置能同步，字体渲染同步不了，
 * 画进去必然错位半行。跟随滚动用 transform 直改 DOM、不经 setState——
 * 滚动是高频事件，每帧过一遍 React 协调不值得，而且行号位移不是「状态」，
 * 没有任何别的渲染依赖它。
 *
 * **行号栏不许参与撑高度**：这里有全部行号（几十行配置就是几十个 <i>），
 * 一旦它留在文档流里，`.edwrap` 这个 flex 行的交叉尺寸就被它定死，
 * align-items:stretch 会把编辑器一起顶到「行数 × 21px」。所以 `.gut` 在
 * `_theme.css` 里是绝对定位的 —— 改那条 CSS 之前先想清楚这一条，
 * 否则症状是「粘一段长配置，输入框长出屏幕外」。
 */
import type { ChangeEvent, RefObject, UIEvent } from 'react'
import { useRef } from 'react'
import { cx } from '../../components/ui'

interface GutterEditorProps {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  /** 校验出错的那一行（1 起），行号标红。通过或还没粘时传 null */
  badLine?: number | null
  /**
   * 编辑器 textarea 的引用。智能提示「点一条补进编辑器」要拿光标位置，
   * 光标是 DOM 态不是 React 态，只能从元素上读——所以由调用方给 ref。
   */
  taRef?: RefObject<HTMLTextAreaElement | null>
}

export function GutterEditor({ value, onChange, placeholder, badLine, taRef }: GutterEditorProps) {
  const gutInRef = useRef<HTMLDivElement>(null)
  const localTaRef = useRef<HTMLTextAreaElement | null>(null)

  // 空文本也算一行：textarea 从来不会少于一行，行号栏得跟它对齐
  const lines = value ? value.split('\n').length : 1

  const syncScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    if (gutInRef.current) gutInRef.current.style.transform = `translateY(${-e.currentTarget.scrollTop}px)`
  }

  const emit = (e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)

  return (
    <div className="edwrap">
      <div className="gut" aria-hidden>
        {/* 内层再包一层：外层的 overflow:hidden 负责裁掉滚出去的行号，
            transform 加在内层上——padding 在内层，数字才会齐着上边缘消失 */}
        <div ref={gutInRef}>
          {Array.from({ length: lines }, (_, i) => (
            <i key={i} className={cx(badLine != null && i + 1 === badLine && 'bad')}>
              {i + 1}
            </i>
          ))}
        </div>
      </div>
      <textarea
        ref={(el) => {
          localTaRef.current = el
          if (taRef) taRef.current = el
        }}
        className="fld"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={emit}
        onScroll={syncScroll}
      />
    </div>
  )
}
