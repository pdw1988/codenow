/**
 * 「整个标题条都能点开/收起」这件事的唯一实现。
 *
 * `Fold`（块内折叠）和 `Card`（整张卡折叠）都要它，抄两份就会出现
 * 「一处忘了排除按钮」——表头上常挂着「复制」「跳转」这类动作，
 * 点它们的同时把面板折起来，用户会以为自己点错了。
 */
import type { KeyboardEvent, MouseEvent } from 'react'

const INTERACTIVE = 'button,a,input,select,textarea,label,.tag.click'

/** 摊到标题条元素上的 props。键盘也要能用，所以给了 role/tabIndex */
export function headToggle(open: boolean, onToggle: (open: boolean) => void) {
  return {
    role: 'button',
    tabIndex: 0,
    'aria-expanded': open,
    onClick: (e: MouseEvent<HTMLElement>) => {
      if ((e.target as HTMLElement).closest(INTERACTIVE)) return
      onToggle(!open)
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      // 只认落在标题条自己身上的按键：里面的按钮按回车是那个按钮的事
      if (e.target !== e.currentTarget) return
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault() // 空格默认是滚动页面
      onToggle(!open)
    },
  } as const
}
