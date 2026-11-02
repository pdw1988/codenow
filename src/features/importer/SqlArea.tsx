/**
 * 手写 SQL 输入框 + 轻提示（连库查询页）。textarea 仍是原生控件，提示是浮在上面的
 * 绝对定位下拉。光标像素坐标 textarea 拿不到，用一个复制了字体/内边距/宽度的镜像
 * div 量：把光标前的文本灌进去，探针 span 的矩形就是光标位置。
 *
 * 触发场景见 lib/sqlhint（只有 `t.` / 别名点号出列、FROM/JOIN 后出表名）。
 * 键盘：↑↓ 挑、Enter/Tab 采纳、Esc 关、←→ 关；中文输入法组词中不出提示（isComposing）。
 *
 * 点击 textarea **不**触发提示——点一下弹一片列名比不出还烦（用户 2026-09-20），
 * 提示只跟打字走。Ctrl/Cmd+Enter 永远是运行，不被提示拦走；有选中文本时
 * 只执行选中的那一段（Navicat / DBeaver 惯例），没有就执行整个框。
 */
import { useRef, useState } from 'react'
import { cx } from '../../components/ui'
import { sqlHintAt, type SqlHint } from '../../lib/sqlhint'

interface Props {
  value: string
  onChange: (v: string) => void
  /** Ctrl/Cmd+Enter。参数 = 要执行的文本：有选中文本时是选中的片段，否则是整个框 */
  onRun: (sql: string) => void
  ariaLabel: string
  placeholder?: string
  /** 库里的表名。FROM / JOIN 后面出表名提示 */
  tableNames: readonly string[]
  /** 表 → 列名清单。还没拉过字段的表返回空，等调用方懒拉完再打一个字就有 */
  colsOf: (table: string) => string[]
  /** 把内部 textarea 交给父组件：优化建议的「点建议定位」要 focus + 选中片段 */
  textareaRef?: (el: HTMLTextAreaElement | null) => void
}

interface Sug {
  hint: SqlHint
  /** 采纳时光标所在位置（替换范围的终点） */
  caret: number
  active: number
  pos: { left: number; top: number }
}

/** 下拉别贴着光标右边直接怼出卡片，留一点往左收 */
const MIN_DROPDOWN_ROOM = 200

export function SqlArea({ value, onChange, onRun, ariaLabel, placeholder, tableNames, colsOf, textareaRef }: Props) {
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const mirrorRef = useRef<HTMLDivElement | null>(null)
  const [sug, setSug] = useState<Sug | null>(null)

  /** 镜像量光标。返回相对 textarea 边框盒的坐标（wrapper 里 textarea 就在 0,0） */
  const measurePos = (caret: number): { left: number; top: number } | null => {
    const ta = taRef.current
    const mir = mirrorRef.current
    if (!ta || !mir) return null
    const cs = getComputedStyle(ta)
    mir.style.fontFamily = cs.fontFamily
    mir.style.fontSize = cs.fontSize
    mir.style.fontWeight = cs.fontWeight
    mir.style.lineHeight = cs.lineHeight
    mir.style.letterSpacing = cs.letterSpacing
    mir.style.padding = `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`
    // clientWidth 含 padding 不含边框；镜像无框、content-box，文本宽度和 textarea 对齐
    mir.style.width = `${Math.max(0, ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))}px`
    mir.textContent = ''
    mir.appendChild(document.createTextNode(ta.value.slice(0, caret)))
    const probe = document.createElement('span')
    // 结尾换行在 pre-wrap 里不占行盒，探针给它一个零宽字符兜底
    probe.textContent = '\u200b'
    mir.appendChild(probe)
    const taBox = ta.getBoundingClientRect()
    const probeBox = probe.getBoundingClientRect()
    const bl = parseFloat(cs.borderLeftWidth) || 0
    const bt = parseFloat(cs.borderTopWidth) || 0
    return {
      // 下拉至少留 MIN_DROPDOWN_ROOM 的宽度：光标太靠右就把提示拉回来。
      // 在这里钳（事件期）而不是渲染期钳——渲染期读 taRef 是反模式，
      // 代价只是「开着下拉时改窗口宽度」要等下一次按键才重新钳位
      left: Math.max(
        0,
        Math.min(bl + probeBox.left - taBox.left - ta.scrollLeft, ta.clientWidth - MIN_DROPDOWN_ROOM),
      ),
      top: bt + probeBox.top - taBox.top - ta.scrollTop,
    }
  }

  const recompute = (caret: number) => {
    const ta = taRef.current
    if (!ta) return
    const hint = sqlHintAt(ta.value, caret, { tableNames, colsOf })
    if (!hint) {
      setSug(null)
      return
    }
    const pos = measurePos(caret)
    if (!pos) {
      setSug(null)
      return
    }
    setSug({ hint, caret, active: 0, pos })
  }

  const accept = (s: Sug, i: number) => {
    const item = s.hint.items[i]
    const ta = taRef.current
    if (item === undefined || !ta) return
    const base = ta.value
    const next = base.slice(0, s.hint.from) + item + base.slice(s.caret)
    const caretTo = s.hint.from + item.length
    onChange(next)
    setSug(null)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(caretTo, caretTo)
    })
  }

  return (
    <div className="sql-area">
      <textarea
        ref={(el) => {
          taRef.current = el
          textareaRef?.(el)
        }}
        spellCheck={false}
        className="fld mono flush"
        rows={3}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(e) => {
          onChange(e.target.value)
          recompute(e.target.selectionStart)
        }}
        // 点击不弹提示：用户点进来改光标/选中是高频操作，弹一片列名是干扰。
        // 提示只跟打字走（onChange / onKeyUp）。
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault()
            // 有选中就只跑选中那段（Navicat / DBeaver 惯例）；没有就整个框。
            // textarea 失焦后选区仍保留，从当前 DOM 值取最稳。
            const ta = e.currentTarget
            const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd)
            onRun(sel.trim() ? sel : ta.value)
            return
          }
          if (!sug) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const n = sug.hint.items.length
            if (n > 0) {
              const d = e.key === 'ArrowDown' ? 1 : -1
              setSug({ ...sug, active: (sug.active + d + n) % n })
            }
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            accept(sug, sug.active)
          } else if (e.key === 'Escape' || e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
            setSug(null)
          }
        }}
        onBlur={() => {
          // 120ms 是给「点提示项」留的：mousedown 被 preventDefault，焦点本不该走；
          // 真点空白处失焦时这个兜底把下拉收掉
          window.setTimeout(() => setSug(null), 120)
        }}
      />
      <div ref={mirrorRef} className="sql-mirror" aria-hidden />
      {sug && sug.pos && (
        <div
          className="sql-sug"
          role="listbox"
          aria-label="SQL 提示"
          style={{
            left: sug.pos.left,
            top: sug.pos.top,
          }}
        >
          {sug.hint.items.map((it, i) => (
            <div
              key={it}
              role="option"
              aria-selected={i === sug.active}
              className={cx('it', i === sug.active && 'on')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => accept(sug, i)}
            >
              {it}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
