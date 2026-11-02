/**
 * 骨架阶段的种子数据，首次启动且缓存为空时兜底，让新用户点进来就能看到东西。
 *
 * 全项目的示例只用**订单 + 订单明细**这一对表（导入页的两段 DDL、日志转 SQL 的样例日志、
 * 正则测试的样本都是这两张），user / product / user_role / log 那些都删掉了：
 * 示例表越多，用户越要先分辨「哪张是我的表、哪张是工具自带的」，而多出来的表
 * 一条也没多演示什么。
 *
 * 表名用**大写** ORDER / ORDER_DETAIL，不是跟着 Oracle 示例走的风格偏好：
 * 缓存按名字原文区分大小写，种子叫小写 order、示例导进来叫大写 ORDER 时，
 * 速查页会同时出现两张「订单表」（用户实际撞过）。统一成一套写法才不会重复。
 *
 * 这一对表是刻意选的，一张表演示不了的东西全在它们身上：
 * 一对多关联（生成 JOIN、MyBatis 的 `<collection>`）、`status` 列（SELECT转UPDATE 页
 * 「自动勾 status 填 1」的用户旅程靠它触发）、DECIMAL 金额、`ORDER` 本身是 SQL 保留字
 * （生成的语句必须带引号，见 dialect.ts 的 quote）。
 */
import type { Column, ForeignKey, TableInfo } from '../types/schema'
import { toCamelCase, toJavaType, toPascalCase } from '../lib/javaType'

/** 精简字段定义，javaField / javaType 由类型和字段名推导，避免手写重复 */
function col(
  name: string,
  type: string,
  opts: Partial<Omit<Column, 'name' | 'type' | 'javaField' | 'javaType'>> = {},
): Column {
  return {
    name,
    type,
    nullable: opts.nullable ?? true,
    isPrimaryKey: opts.isPrimaryKey ?? false,
    isAutoIncrement: opts.isAutoIncrement ?? false,
    defaultValue: opts.defaultValue,
    comment: opts.comment,
    javaField: toCamelCase(name),
    javaType: toJavaType(type),
  }
}

/** 自增主键 id，抽出来复用 */
const pk = () =>
  col('id', 'BIGINT', {
    nullable: false,
    isPrimaryKey: true,
    isAutoIncrement: true,
    comment: '主键',
  })

const createTime = () =>
  col('create_time', 'DATETIME', {
    nullable: false,
    defaultValue: 'CURRENT_TIMESTAMP',
    comment: '创建时间',
  })

/**
 * 内置表的播种时间戳。历代版本的种子一直共用这一个值（v0.3.0~至今没变过），
 * 所以它是「这行数据是工具播的种子还是用户导入的」唯一可靠凭证：
 * builtinSeed.ts 凭 name + 这个戳清理历史残留、刷新旧定义。
 * 改种子内容时**不要**换这个值（换了旧残留就认不出来了）；真要全量换代时，
 * 走 builtinSeed.ts 的退役清单那条路。
 */
export const SEED_STAMP = '2026-08-21T14:30:00'
const SEED_AT = SEED_STAMP

function table(
  name: string,
  comment: string,
  columns: Column[],
  /** ORDER 这种没有下划线的全大写名推导不出来（toPascalCase('ORDER') 还是 'ORDER'），类名显式给 */
  javaClass: string = toPascalCase(name),
): TableInfo {
  return {
    name,
    comment,
    javaClass,
    source: 'sql',
    columns,
    createdAt: SEED_AT,
    updatedAt: SEED_AT,
  }
}

export const MOCK_TABLES: TableInfo[] = [
  // ORDER 排在第一张：SELECT转UPDATE / SQL 生成页在用户没选表时跟着 tables[0] 走，
  // 让默认落在主表上，进去就能演示 JOIN 和 status 联动
  table('ORDER', '订单表', [
    pk(),
    col('order_no', 'VARCHAR(32)', { nullable: false, isUnique: true, comment: '订单号' }),
    col('total', 'DECIMAL(12,2)', { nullable: false, defaultValue: '0.00', comment: '订单金额' }),
    col('status', 'TINYINT', { nullable: false, defaultValue: '0', comment: '状态：0待付 1已付 2已发货 3完成' }),
    col('del_flag', 'TINYINT(1)', { nullable: false, defaultValue: '0', comment: '是否删除：0否 1是' }),
    col('remark', 'VARCHAR(200)', { comment: '备注' }),
    createTime(),
  ], 'Order'),
  table('ORDER_DETAIL', '订单明细表', [
    pk(),
    col('order_id', 'BIGINT', { nullable: false, comment: '所属订单' }),
    col('sku', 'VARCHAR(40)', { nullable: false, comment: '商品编码' }),
    col('qty', 'INT', { nullable: false, defaultValue: '1', comment: '数量' }),
    col('price', 'DECIMAL(12,2)', { nullable: false, defaultValue: '0.00', comment: '单价' }),
    createTime(),
  ], 'OrderDetail'),
]

/**
 * 种子里给的是**真外键约束**（绿色 ✅、默认勾选），不是命名推断：
 * 空手进来的用户第一眼就要能点出一条 JOIN。命名推断（黄色 ⚠️）那一级
 * 在导入页的 Oracle 示例里演示——那段 DDL 故意没写 FK 约束。
 */
export const MOCK_FOREIGN_KEYS: ForeignKey[] = [
  {
    fromTable: 'ORDER_DETAIL',
    fromColumn: 'order_id',
    toTable: 'ORDER',
    toColumn: 'id',
    constraintName: 'FK_ORDER_DETAIL_ORDER',
    confidence: 'constraint',
  },
]
