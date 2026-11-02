/**
 * MyBatis XML 生成，PRD 4.6。这是 PRD 里点名的差异化亮点。
 *
 * 单表出 resultMap + 四个 CRUD；多表出带 <collection> 的嵌套 resultMap，
 * 后者是手写最容易错的部分（column 要对上 SELECT 的别名，不是原字段名）。
 */
import type { Column, Dialect, TableInfo } from '../../types/schema'
import { DIALECTS } from './dialect'
import type { MultiTableResult } from './multiTable'
import { toCamelCase, toPascalCase } from '../javaType'

export interface MyBatisOptions {
  dialect: Dialect
  /** Mapper 接口所在包，如 com.example.mapper */
  mapperPackage: string
  /** 实体 / VO 所在包 */
  modelPackage: string
}

export const DEFAULT_MYBATIS_OPTIONS: MyBatisOptions = {
  dialect: 'mysql',
  mapperPackage: 'com.example.mapper',
  modelPackage: 'com.example.model',
}

const indent = (level: number) => '  '.repeat(level)

/** resultMap 的一行，主键用 <id> 而非 <result>，MyBatis 靠它做行去重 */
function resultLine(col: Column, column: string, level: number): string {
  const tag = col.isPrimaryKey ? 'id' : 'result'
  const tail = col.comment ? `<!-- ${col.comment} -->` : ''
  return `${indent(level)}<${tag} column="${column}" property="${col.javaField}" />${tail}`
}

/** 生成单表 Mapper XML */
export function generateSingleTableXml(table: TableInfo, options: MyBatisOptions): string {
  const q = DIALECTS[options.dialect].quote
  const entity = toPascalCase(table.name)
  const ns = `${options.mapperPackage}.${entity}Mapper`
  const model = `${options.modelPackage}.${entity}`

  const pks = table.columns.filter((c) => c.isPrimaryKey)
  const insertable = table.columns.filter((c) => !c.isAutoIncrement)
  const settable = table.columns.filter((c) => !c.isPrimaryKey)

  const where = pks.length
    ? pks.map((pk) => `${q(pk.name)} = #{${pk.javaField}}`).join(' AND ')
    : null

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN"',
    '  "https://mybatis.org/dtd/mybatis-3-mapper.dtd">',
    `<mapper namespace="${ns}">`,
    '',
    `${indent(1)}<resultMap id="BaseResultMap" type="${model}">`,
    ...table.columns.map((c) => resultLine(c, c.name, 2)),
    `${indent(1)}</resultMap>`,
    '',
    `${indent(1)}<sql id="Base_Column_List">`,
    `${indent(2)}${table.columns.map((c) => q(c.name)).join(', ')}`,
    `${indent(1)}</sql>`,
    '',
  ]

  // INSERT：自增主键用 useGeneratedKeys 回填，这是 MyBatis 的标准做法
  const autoPk = pks.find((c) => c.isAutoIncrement)
  lines.push(
    `${indent(1)}<insert id="insert" parameterType="${model}"${
      autoPk ? ` useGeneratedKeys="true" keyProperty="${autoPk.javaField}"` : ''
    }>`,
    `${indent(2)}INSERT INTO ${q(table.name)} (`,
    `${indent(3)}${insertable.map((c) => q(c.name)).join(', ')}`,
    `${indent(2)}) VALUES (`,
    `${indent(3)}${insertable.map((c) => `#{${c.javaField}}`).join(', ')}`,
    `${indent(2)})`,
    `${indent(1)}</insert>`,
    '',
  )

  // UPDATE：动态 SET，只更新非空字段——这是实际项目里最常用的形态
  if (where && settable.length) {
    lines.push(
      `${indent(1)}<update id="updateSelective" parameterType="${model}">`,
      `${indent(2)}UPDATE ${q(table.name)}`,
      `${indent(2)}<set>`,
      ...settable.map(
        (c) =>
          `${indent(3)}<if test="${c.javaField} != null">${q(c.name)} = #{${c.javaField}},</if>`,
      ),
      `${indent(2)}</set>`,
      `${indent(2)}WHERE ${where}`,
      `${indent(1)}</update>`,
      '',
      `${indent(1)}<delete id="deleteByPrimaryKey">`,
      `${indent(2)}DELETE FROM ${q(table.name)} WHERE ${where}`,
      `${indent(1)}</delete>`,
      '',
      `${indent(1)}<select id="selectByPrimaryKey" resultMap="BaseResultMap">`,
      `${indent(2)}SELECT <include refid="Base_Column_List" />`,
      `${indent(2)}FROM ${q(table.name)} WHERE ${where}`,
      `${indent(1)}</select>`,
      '',
    )
  } else {
    lines.push(`${indent(1)}<!-- ${table.name} 无主键，跳过 update/delete/selectByPrimaryKey -->`, '')
  }

  lines.push(`</mapper>`)
  return lines.join('\n')
}

/**
 * 生成多表关联的 Mapper XML。
 *
 * 关键点：resultMap 的 column 必须用 SELECT 里的输出别名（order_id），
 * 不是原字段名（id），否则跨表同名字段会互相覆盖。别名映射由
 * generateMultiTable 一并返回，这里直接复用，避免两处各算一遍算出不一样的结果。
 */
export function generateMultiTableXml(
  mainTable: TableInfo,
  tables: Map<string, TableInfo>,
  result: MultiTableResult,
  options: MyBatisOptions,
): string {
  const entity = toPascalCase(mainTable.name)
  const childNames = result.joined.filter((t) => t !== mainTable.name)
  const voName = `${entity}${childNames.map(toPascalCase).join('')}VO`
  const ns = `${options.mapperPackage}.${voName.replace(/VO$/, '')}Mapper`

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN"',
    '  "https://mybatis.org/dtd/mybatis-3-mapper.dtd">',
    `<mapper namespace="${ns}">`,
    '',
    `${indent(1)}<resultMap id="${voName}Map" type="${options.modelPackage}.${voName}">`,
  ]

  // 主表字段直接挂在 resultMap 上
  for (const col of mainTable.columns) {
    const outName = result.aliasByKey.get(`${mainTable.name}.${col.name}`) ?? col.name
    lines.push(resultLine(col, outName, 2))
  }

  // 从表字段包进 <collection>，一对多才是真实场景（一个 user 多个 order）
  for (const childName of childNames) {
    const child = tables.get(childName)
    if (!child) continue
    const childEntity = toPascalCase(childName)
    lines.push(
      '',
      `${indent(2)}<!-- 一对多：一个 ${mainTable.name} 对应多条 ${childName} -->`,
      `${indent(2)}<collection property="${toCamelCase(childName)}List" ofType="${options.modelPackage}.${childEntity}">`,
      ...child.columns.map((col) => {
        const outName = result.aliasByKey.get(`${childName}.${col.name}`) ?? col.name
        return resultLine(col, outName, 3)
      }),
      `${indent(2)}</collection>`,
    )
  }

  lines.push(`${indent(1)}</resultMap>`, '')

  // 把生成好的列表查询塞进 <select>，可选条件转成 <if>
  const listSql = result.sql
    .split('\n\n')
    .find((block) => block.startsWith('-- 1.'))
    ?.split('\n')
    .slice(1)
    .join('\n')

  if (listSql) {
    const withIfs = listSql
      // 行尾的 -- 注释在 XML 里没有价值（字段含义已经写在 resultMap 上），
      // 留着反而有风险：一旦 SQL 被拼成单行，后面全被注释掉
      .replace(/ {2}--(?! AND ).*$/gm, '')
      .replace(
        /^ {2}-- AND (\S+) = #\{(\w+)\}$/gm,
        (_m, expr: string, param: string) =>
          `${indent(3)}<if test="${param} != null">AND ${expr} = #{${param}}</if>`,
      )
    lines.push(
      `${indent(1)}<select id="select${voName.replace(/VO$/, '')}List" resultMap="${voName}Map">`,
      withIfs
        .split('\n')
        .map((l) => (l.trimStart().startsWith('<if') ? l : `${indent(2)}${l.trim()}`))
        .join('\n')
        .replace(/;$/, ''),
      `${indent(1)}</select>`,
      '',
    )
  }

  lines.push('</mapper>')
  return lines.join('\n')
}
