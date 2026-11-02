/**
 * 编辑表结构弹窗的增量 DDL：拿「打开弹窗时的字段」和「当前编辑中的字段」实时 diff，
 * 生成 ALTER TABLE 语句。加列 / 改列 / 删列都有——很多时候用户只动一列，
 * 全量 CREATE TABLE 帮不上忙（表里已经有数据，重建不现实）。
 *
 * 类型翻译、列片段、默认值渲染全部复用 ddlExport（columnParts / translateType /
 * renderDefault / lit），这里只写「每种方言的 ALTER 长什么样」这一层——
 * 同一列在全量导出和增量语句里必须是同一个类型，分开写迟早改漏一边。
 *
 * 边界（故意的）：主键 / 自增的变化**不生成语句**，只进 `manual` 清单——
 * 真实约束名没存进缓存（全量导出那条也受此限，见 ddlExport 的注释），Oracle 改列类型
 * 还可能要求重建表，硬生成等于给用户一句跑不通的 SQL；列出来让人手工处理才诚实。
 */
import type { Column } from '../../types/schema'
import { DIALECTS, type GenDialect } from './dialect'
import { columnParts, lit, renderDefault, translateType } from './ddlExport'

export interface ColumnDiff {
  /** 新加的字段（按当前列的顺序） */
  added: Column[]
  /** 删掉的字段（按原列的顺序） */
  dropped: Column[]
  /** 定义变了的字段：from 是打开弹窗时的样子，to 是当前编辑中的样子 */
  changed: { from: Column; to: Column }[]
  /** 生成不了可靠 ALTER、需要手工处理的变化，一条一句人话 */
  manual: string[]
}

/** 主键隐含 NOT NULL（保存时会归一化），比较按有效值算——否则 pk 行会报出假的「可空性变了」 */
const effNullable = (c: Column): boolean => (c.isPrimaryKey ? false : c.nullable)

/** 一个字段的「定义」变没变：类型原文、可空、默认值、注释。主键/自增单独看（进 manual） */
const sameDefinition = (a: Column, b: Column): boolean =>
  a.type.trim() === b.type.trim() &&
  effNullable(a) === effNullable(b) &&
  (a.defaultValue ?? '') === (b.defaultValue ?? '') &&
  (a.comment ?? '') === (b.comment ?? '')

const flagsChanged = (a: Column, b: Column): boolean =>
  a.isPrimaryKey !== b.isPrimaryKey ||
  a.isAutoIncrement !== b.isAutoIncrement ||
  !!a.isUnique !== !!b.isUnique ||
  !!a.isIndexed !== !!b.isIndexed

export function diffColumns(original: Column[], current: Column[]): ColumnDiff {
  const origByName = new Map(original.map((c) => [c.name, c]))
  const added: Column[] = []
  const changed: { from: Column; to: Column }[] = []
  const manual: string[] = []

  for (const to of current) {
    const from = origByName.get(to.name)
    if (!from) {
      added.push(to)
      if (to.isPrimaryKey) {
        manual.push(`新字段 ${to.name} 带主键标记——主键约束语句没生成（真实约束名缓存里没有，请手工建）`)
      }
      continue
    }
    if (sameDefinition(from, to) && !flagsChanged(from, to)) continue
    changed.push({ from, to })
    if (flagsChanged(from, to)) {
      manual.push(
        `字段 ${to.name} 的主键/自增/唯一索引/普通索引有变化——约束语句没有对应的 ALTER，请手工处理`,
      )
    }
  }

  const currNames = new Set(current.map((c) => c.name))
  const dropped = original.filter((c) => !currNames.has(c.name))
  const droppedPks = dropped.filter((c) => c.isPrimaryKey)
  if (droppedPks.length) {
    manual.push(
      `删掉的字段里有主键（${droppedPks.map((c) => c.name).join('、')}）——主键约束的删除语句没生成，请手工处理`,
    )
  }

  return { added, dropped, changed, manual }
}

export function hasChanges(diff: ColumnDiff): boolean {
  return diff.added.length > 0 || diff.dropped.length > 0 || diff.changed.length > 0 || diff.manual.length > 0
}

/** MySQL / PG 的加列片段，Oracle 用括号形式，SQLite 只有 ADD/DROP 能用 */
function addColumnStmt(table: string, col: Column, dialect: GenDialect, notes: string[]): string {
  const q = DIALECTS[dialect].quote
  const frag = columnParts(col, dialect, notes).join(' ')
  return dialect === 'oracle'
    ? `ALTER TABLE ${q(table)} ADD (${frag});`
    : `ALTER TABLE ${q(table)} ADD COLUMN ${frag};`
}

export function buildAlterDdl(tableName: string, diff: ColumnDiff, dialect: GenDialect): string {
  if (!hasChanges(diff)) return ''
  const q = DIALECTS[dialect].quote
  const notes: string[] = []
  const stmts: string[] = []

  for (const col of diff.added) {
    stmts.push(addColumnStmt(tableName, col, dialect, notes))
    // MySQL 的注释已经在片段里；Oracle / PG 要单独发 comment on
    if (col.comment && (dialect === 'oracle' || dialect === 'postgresql')) {
      stmts.push(`COMMENT ON COLUMN ${q(tableName)}.${q(col.name)} IS ${lit(col.comment)};`)
    }
  }

  for (const { from, to } of diff.changed) {
    if (dialect === 'mysql') {
      // MySQL 的 MODIFY 就是整份重定义：注释也在片段里，没写就等于清掉
      stmts.push(`ALTER TABLE ${q(tableName)} MODIFY COLUMN ${columnParts(to, dialect, notes).join(' ')};`)
    } else if (dialect === 'oracle') {
      stmts.push(`ALTER TABLE ${q(tableName)} MODIFY (${columnParts(to, dialect, notes).join(' ')});`)
      if ((to.comment ?? '') !== (from.comment ?? '')) {
        // Oracle 清注释只能设成空串，没有 DROP COMMENT 这回事
        stmts.push(`COMMENT ON COLUMN ${q(tableName)}.${q(to.name)} IS ${lit(to.comment ?? '')};`)
      }
    } else if (dialect === 'postgresql') {
      // PG 的列属性各是一条子句，拆开发：每条都能单独复制执行
      if (from.type.trim() !== to.type.trim()) {
        stmts.push(`ALTER TABLE ${q(tableName)} ALTER COLUMN ${q(to.name)} TYPE ${translateType(to.type, dialect).type};`)
      }
      if (effNullable(from) !== effNullable(to)) {
        stmts.push(
          effNullable(to)
            ? `ALTER TABLE ${q(tableName)} ALTER COLUMN ${q(to.name)} DROP NOT NULL;`
            : `ALTER TABLE ${q(tableName)} ALTER COLUMN ${q(to.name)} SET NOT NULL;`,
        )
      }
      if ((from.defaultValue ?? '') !== (to.defaultValue ?? '')) {
        stmts.push(
          to.defaultValue !== undefined && to.defaultValue !== ''
            ? `ALTER TABLE ${q(tableName)} ALTER COLUMN ${q(to.name)} SET DEFAULT ${renderDefault(to.defaultValue)};`
            : `ALTER TABLE ${q(tableName)} ALTER COLUMN ${q(to.name)} DROP DEFAULT;`,
        )
      }
      if ((to.comment ?? '') !== (from.comment ?? '')) {
        stmts.push(`COMMENT ON COLUMN ${q(tableName)}.${q(to.name)} IS ${lit(to.comment ?? '')};`)
      }
    } else {
      // SQLite：ADD / DROP 之外改不了列，动过的只能列出来等重建表
      stmts.push(`-- 字段 ${to.name} 改了定义（${from.type} → ${to.type}）：SQLite 改列要重建表，请手工处理`)
    }
  }

  for (const col of diff.dropped) {
    stmts.push(
      dialect === 'oracle'
        ? `ALTER TABLE ${q(tableName)} DROP (${q(col.name)});`
        : `ALTER TABLE ${q(tableName)} DROP COLUMN ${q(col.name)};`,
    )
  }

  const header = [
    `-- ${tableName} 的增量变更：加 ${diff.added.length} · 改 ${diff.changed.length} · 删 ${diff.dropped.length}`,
    `-- 对照的是打开弹窗时的字段；全量建表语句走卡片上的「导出 DDL」`,
  ]
  if (dialect === 'sqlite') {
    header.push('-- ⚠️ SQLite 只支持加列 / 删列，改列类型要重建表；下面改列的部分只是说明，不是能执行的语句')
  }
  if (diff.manual.length) {
    header.push('-- ⚠️ 以下变化没法生成可靠的 ALTER，请手工处理：', ...diff.manual.map((m) => `--    ${m}`))
  }
  if (notes.length) {
    header.push('-- ⚠️ 以下类型翻译后需要手动确认：', ...[...new Set(notes)].map((n) => `--    ${n}`))
  }

  return [header.join('\n'), ...stmts].join('\n\n')
}
