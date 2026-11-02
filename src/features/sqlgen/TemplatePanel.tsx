/**
 * 模板的保存与套用，PRD 4.13（原型 mockup/sqlgen.html 的「模板」卡）。
 *
 * 模板存的是配置不是 SQL 文本（理由见 types/template.ts），所以「套用」的效果
 * 等于把左边那几个控件恢复成保存当时的样子，结果区照旧实时重算。
 * 这样表结构后来改了（加字段、改注释），套用旧模板拿到的仍是新结构的 SQL。
 *
 * 存是输入框回车；套用必须点那颗「套用」按钮——整行可点时，扫一眼名字就会
 * 把当前配置冲掉，删按钮旁边那次误触尤其容易。
 * 存和用仍待在同一张卡里：想存的人立刻能看到已有模板长什么样（同名就覆盖）。
 */
import { useState } from 'react'
import { App } from 'antd'
import {
  TEMPLATE_LIMIT,
  type SqlTemplate,
  type TemplateConfig,
} from '../../types/template'
import { newTemplateId, useTemplateStore } from '../../store/useTemplateStore'
import { CRUD_LABELS } from '../../lib/sqlgen/singleTable'
import { DIALECTS } from '../../lib/sqlgen/dialect'
import { Band, Btn, EmptyBox, Fld, Hint, Spacer, Stack } from '../../components/ui'

interface Props {
  /** 当前配置；null 表示还没选主表，此时不能保存 */
  config: TemplateConfig | null
  onApply: (template: SqlTemplate) => void
}

/** 模板行第二行的描述：主表 · 模式 · 语句类型 · 方言。一眼扫得出这是哪套配置 */
function describe(t: SqlTemplate): string {
  const kindText =
    t.mode === 'multi'
      ? '多表'
      : t.kinds.length === 0
        ? '无'
        : t.kinds.length === 4
          ? '全部'
          : t.kinds.map((k) => CRUD_LABELS[k]).join('/')
  return `${t.mainTable} · ${t.mode === 'multi' ? '多表' : '单表'} · ${kindText} · ${DIALECTS[t.dialect].label}`
}

export function TemplatePanel({ config, onApply }: Props) {
  const { message } = App.useApp()
  const templates = useTemplateStore((s) => s.templates)
  const save = useTemplateStore((s) => s.save)
  const remove = useTemplateStore((s) => s.remove)

  const [name, setName] = useState('')

  const trimmed = name.trim()
  /** 同名视为覆盖：否则列表里很快就是一串「用户订单查询」「用户订单查询2」 */
  const overwrites = templates.find((t) => t.name === trimmed)
  const atLimit = !overwrites && templates.length >= TEMPLATE_LIMIT

  const hasTpl = templates.length > 0
  /** 没选主表就没有可保存的配置：输入框和围着它的提示一起让位。
      原先这里只把输入框 disabled，于是「四层空态 + 一条 Auto」同时占着左栏约 300px。 */
  const hasConfig = Boolean(config)
  /** 一条也不占：既没有模板、又还没选主表 —— 保存这件事根本还没开始。
      选过主表之后才值得铺 EmptyBox + 输入框。 */
  const quietEmpty = !hasTpl && !hasConfig

  const handleSave = async () => {
    if (!config || !trimmed || atLimit) return
    const now = new Date().toISOString()
    try {
      await save({
        ...config,
        id: overwrites?.id ?? newTemplateId(),
        name: trimmed,
        // 标签不在输入框里管：覆盖时保留原模板的标签，新建给空
        tags: overwrites?.tags ?? [],
        createdAt: overwrites?.createdAt ?? now,
        updatedAt: now,
      })
      message.success(overwrites ? `已覆盖模板「${trimmed}」` : `已保存模板「${trimmed}」`)
      setName('')
    } catch (err) {
      message.error(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleApply = (t: SqlTemplate) => {
    onApply(t)
    message.success(`已套用「${t.name}」`)
  }

  const handleDelete = async (t: SqlTemplate) => {
    try {
      await remove(t.id)
      message.success(`已删除「${t.name}」`)
    } catch (err) {
      message.error(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <Stack>
      {hasTpl ? (
        <Stack gap={7}>
          {templates.map((t) => (
            <div key={t.id} className="tpl">
              <div>
                <div className="nm">{t.name}</div>
                <div className="ds">{describe(t)}</div>
              </div>
              <Spacer />
              <Btn variant="mini" title={`套用「${t.name}」`} onClick={() => handleApply(t)}>
                套用
              </Btn>
              <Btn
                variant="mini"
                danger
                title={`删除「${t.name}」`}
                onClick={() => void handleDelete(t)}
              >
                删
              </Btn>
            </div>
          ))}
        </Stack>
      ) : quietEmpty ? (
        <Hint>尚无模板。选好主表后可存为模板。</Hint>
      ) : (
        /* 无模板但已选主表：这时候真能存，才值得留空态 */
        <EmptyBox className="slim">尚无模板</EmptyBox>
      )}

      {hasConfig && (
        <Fld
          value={name}
          placeholder="模板名称，回车保存"
          aria-label="模板名称"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSave()
          }}
        />
      )}

      {hasConfig && overwrites && !atLimit && (
        <Hint>同名模板「{overwrites.name}」将被覆盖</Hint>
      )}
      {hasConfig && atLimit && (
        <Band tone="warn" title={`模板已达上限 ${TEMPLATE_LIMIT} 条`}>
          请先删除后再保存。
        </Band>
      )}
      {/* 输入框收起来之后，得告诉用户它去哪了 —— 禁用但不说明，点了只像卡住了 */}
      {!hasConfig && hasTpl && <Hint>选择主表后，可将当前配置存为模板</Hint>}
    </Stack>
  )
}
