/**
 * 连库查询独立页。原型 `mockup/db-query.html`：一级菜单 + 铺满工作台。
 *
 * 空状态也套 Page（CLAUDE.md：漏包则 .pane 不存在，下面被裁掉）。
 * 连接表单和查询网格都在 DbConnect 里，切走再回来不断开（keep-alive）。
 */
import { Auto } from '../../components/ui'
import { Page } from '../../components/shell/Page'
import { DbConnect } from './DbConnect'

export function DbQueryPage() {
  return (
    <Page
      tab="dbquery"
      fill
      actions={<Auto>先 200 行 · 加载全部最多 1 万</Auto>}
    >
      <DbConnect />
    </Page>
  )
}
