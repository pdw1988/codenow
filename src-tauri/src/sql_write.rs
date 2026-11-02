//! 连库写路径闸门（PRD 19.3 / 19.4 / 19.5 / 19.7 / 19.8）。
//!
//! `*_query` 继续只读。
//! `*_delete_rows` 只放行带 WHERE 的单条 DELETE（勾选行）。
//! `*_update_rows` 只放行带 SET + WHERE 的单条 UPDATE（勾选行）。
//! `*_insert_rows` 只放行带 VALUES 的单条 INSERT（插入一行；INSERT … SELECT 拒）。
//! `*_exec_sql` 放行生成页丢过来的 INSERT，以及带 WHERE 的 UPDATE / DELETE。
//! `*_exec_ddl` 放行编辑表结构弹窗的 ALTER TABLE / COMMENT ON、连库页「索引落地」
//! 清单的 CREATE INDEX / ANALYZE，以及 2026-09-24 起手写的带 WHERE 的 UPDATE /
//! DELETE、带 INTO 的 INSERT、CREATE TABLE … AS SELECT（备份表；用户连发三条
//! 被拒才开的口子，判据与前端 sqlAlter.ts 一字不差）。每条跑完立即提交。
//! SQL 框仍然只读，`*_exec_sql` 到今天也不放行任何 DDL。

use crate::sql_readonly::{code_mask, first_keyword, first_keywords, has_second_statement};
use serde::Serialize;

#[derive(Serialize)]
pub struct DeleteResult {
    pub affected: u64,
}

#[derive(Serialize)]
pub struct ExecResult {
    pub affected: u64,
    pub ran: u32,
}

pub const EXEC_STMT_CAP: usize = 2000;
/// 增量 DDL 很短（加/改/删列 + 若干 COMMENT ON），不必给生成页那 2000 的帽。
pub const ALTER_STMT_CAP: usize = 80;

pub fn assert_pk_delete(sql: &str) -> Result<(), String> {
    let first = first_keyword(sql).ok_or_else(|| "没有要执行的 DELETE".to_string())?;
    if first != "DELETE" {
        return Err(format!("这条命令只执行按主键 DELETE，不跑 {first}"));
    }
    if has_second_statement(sql) {
        return Err("一次只跑一条语句，不要带第二段".into());
    }
    if !has_where_predicate(sql) {
        return Err("拒绝没有 WHERE 的 DELETE".into());
    }
    Ok(())
}

pub fn assert_row_insert(sql: &str) -> Result<(), String> {
    let first = first_keyword(sql).ok_or_else(|| "没有要执行的 INSERT".to_string())?;
    if first != "INSERT" {
        return Err(format!("这条命令只执行 INSERT，不跑 {first}"));
    }
    if has_second_statement(sql) {
        return Err("一次只跑一条语句，不要带第二段".into());
    }
    if !has_keyword_predicate(sql, "INTO") {
        return Err("拒绝没有 INTO 的 INSERT".into());
    }
    if !has_keyword_predicate(sql, "VALUES") {
        return Err("这条命令只插入 VALUES，不跑 INSERT … SELECT".into());
    }
    if has_bare_keyword(sql, "SELECT") {
        return Err("这条命令只插入 VALUES，不跑 INSERT … SELECT".into());
    }
    Ok(())
}

pub fn assert_pk_update(sql: &str) -> Result<(), String> {
    let first = first_keyword(sql).ok_or_else(|| "没有要执行的 UPDATE".to_string())?;
    if first != "UPDATE" {
        return Err(format!("这条命令只执行按主键 UPDATE，不跑 {first}"));
    }
    if has_second_statement(sql) {
        return Err("一次只跑一条语句，不要带第二段".into());
    }
    if !has_keyword_predicate(sql, "SET") {
        return Err("拒绝没有 SET 的 UPDATE".into());
    }
    if !has_where_predicate(sql) {
        return Err("拒绝没有 WHERE 的 UPDATE".into());
    }
    Ok(())
}

/// 生成页丢过来的语句：INSERT，或带 WHERE 的 UPDATE / DELETE。
/// 一条字符串只准一条语句。SELECT / DDL / 无 WHERE 的改删都拒。
pub fn assert_gen_write(sql: &str) -> Result<(), String> {
    let first = first_keyword(sql).ok_or_else(|| "没有要执行的语句".to_string())?;
    if has_second_statement(sql) {
        return Err("一次只跑一条语句，不要带第二段".into());
    }
    match first.as_str() {
        "INSERT" | "REPLACE" => Ok(()),
        "UPDATE" | "DELETE" => {
            if !has_where_predicate(sql) {
                return Err(format!("拒绝没有 WHERE 的 {first}"));
            }
            Ok(())
        }
        _ => Err(format!("生成页只执行 INSERT / UPDATE / DELETE，不跑 {first}")),
    }
}

pub fn assert_gen_script(statements: &[String]) -> Result<(), String> {
    if statements.is_empty() {
        return Err("没有要执行的语句".into());
    }
    if statements.len() > EXEC_STMT_CAP {
        return Err(format!("一次最多 {EXEC_STMT_CAP} 条，请缩小批量"));
    }
    for sql in statements {
        assert_gen_write(sql)?;
    }
    Ok(())
}

/// `CREATE [UNIQUE|BITMAP] INDEX` 才算建索引。`INDEX` 必须出现在前 4 个词里，
/// 它前面只许 `UNIQUE` / `BITMAP`（Oracle 位图索引）——所以 `CREATE TABLE`、
/// `CREATE OR REPLACE …`、`CREATE USER`、`CREATE DATABASE` 一条都进不来：
/// 它们压根没有 INDEX 这个词。PG 的 `CONCURRENTLY` / `IF NOT EXISTS`
/// 在 INDEX 后面，不影响判断。
///
/// 放它进来是因为「索引落地」清单承诺「照着这份就能把索引建上」，而用户不想
/// 为了建索引再开一个客户端。风险面很小：建索引不带子查询、不碰行数据，
/// 最坏是建出一个没人用的索引。
fn is_create_index(words: &[String]) -> bool {
    if words.first().map(String::as_str) != Some("CREATE") {
        return false;
    }
    let at = match words[1..].iter().position(|w| w == "INDEX") {
        Some(i) => i + 1,
        None => return false,
    };
    if at > 3 {
        return false;
    }
    words[1..at]
        .iter()
        .all(|w| w == "UNIQUE" || w == "BITMAP")
}

/// `CREATE TABLE … AS SELECT`（CTAS）才算建表。备份一张表（`TMP_XXX_BAK_0924`）是
/// 连库页最常见的建表诉求，普通 CREATE TABLE（列全手写）仍然不收。
/// 判据与前端 `isCtas` 一字不差：`AS` 必须出现且后面第一个词是 `SELECT` / `WITH`；
/// 名字里的数字不进 first_keywords 的词表，只会把长表名拆成几段
/// （如 `T_SHOP_ORDER_APPLY_0924`），所以词数上限给 16。
/// `CREATE GLOBAL TEMPORARY` / `CREATE OR REPLACE` 的第二个词不是 TABLE，进不来。
fn is_ctas(words: &[String]) -> bool {
    if words.first().map(String::as_str) != Some("CREATE") {
        return false;
    }
    if words.get(1).map(String::as_str) != Some("TABLE") {
        return false;
    }
    let at = match words[2..].iter().position(|w| w == "AS") {
        Some(i) => i + 2,
        None => return false,
    };
    matches!(
        words.get(at + 1).map(String::as_str),
        Some("SELECT") | Some("WITH")
    )
}

/// 编辑表结构丢过来的增量 DDL：只放行 ALTER TABLE、COMMENT ON COLUMN / TABLE、
/// CREATE INDEX、ANALYZE。ALTER SESSION / INDEX / USER、DROP TABLE、TRUNCATE、
/// 普通 CREATE TABLE 都拒。
///
/// 2026-09-24 起同一扇门放行手写 DML 与 CTAS：带 WHERE 的 UPDATE / DELETE、
/// 带 INTO 的 INSERT、CREATE TABLE … AS SELECT。UPDATE / DELETE 没有 WHERE
/// 一律拒——全表改删是这条路上最贵的失误；前端 sqlAlter.ts 的同名分支是镜像，
/// 改这里必须同步改那边。
pub fn assert_alter_stmt(sql: &str) -> Result<(), String> {
    let words = first_keywords(sql, 16);
    if words.is_empty() {
        return Err("没有要执行的语句".into());
    }
    if has_second_statement(sql) {
        return Err("一次只跑一条语句，不要带第二段".into());
    }
    match words[0].as_str() {
        "ALTER" => {
            if words.get(1).map(String::as_str) != Some("TABLE") {
                return Err("只执行 ALTER TABLE，不跑 ALTER SESSION / INDEX / USER".into());
            }
            Ok(())
        }
        "COMMENT" => {
            if words.get(1).map(String::as_str) != Some("ON") {
                return Err("只执行 COMMENT ON COLUMN / TABLE".into());
            }
            match words.get(2).map(String::as_str) {
                Some("COLUMN") | Some("TABLE") => Ok(()),
                _ => Err("只执行 COMMENT ON COLUMN / TABLE".into()),
            }
        }
        // SQLite 建完索引不 ANALYZE，优化器照旧统计信息走，新索引等于没建。
        // 它不改行数据，最坏是统计得慢一点。
        "ANALYZE" => Ok(()),
        "CREATE" if is_create_index(&words) => Ok(()),
        "CREATE" if is_ctas(&words) => Ok(()),
        "CREATE" if words.get(1).map(String::as_str) == Some("TABLE") => Err(
            "CREATE TABLE 只放行 … AS SELECT（把查询结果建成表）；普通建表不在这里跑".into(),
        ),
        "UPDATE" => {
            if !has_keyword_predicate(sql, "SET") {
                return Err("拒绝没有 SET 的 UPDATE".into());
            }
            if !has_where_predicate(sql) {
                return Err("拒绝没有 WHERE 的 UPDATE".into());
            }
            Ok(())
        }
        "DELETE" => {
            if !has_where_predicate(sql) {
                return Err("拒绝没有 WHERE 的 DELETE".into());
            }
            Ok(())
        }
        "INSERT" => {
            if !has_keyword_predicate(sql, "INTO") {
                return Err("拒绝没有 INTO 的 INSERT".into());
            }
            Ok(())
        }
        other => Err(format!(
            "只执行 ALTER TABLE / COMMENT ON / CREATE INDEX / ANALYZE / UPDATE / DELETE / INSERT / CREATE TABLE AS SELECT，不跑 {other}"
        )),
    }
}

pub fn assert_alter_script(statements: &[String]) -> Result<(), String> {
    if statements.is_empty() {
        return Err("没有要执行的语句".into());
    }
    if statements.len() > ALTER_STMT_CAP {
        return Err(format!("一次最多 {ALTER_STMT_CAP} 条"));
    }
    for sql in statements {
        assert_alter_stmt(sql)?;
    }
    Ok(())
}

/// 裸代码里要有该关键字，后面还得有内容。字符串 / 注释里的字不算。
fn has_keyword_predicate(sql: &str, keyword: &str) -> bool {
    let mask = code_mask(sql);
    let mut word = String::new();
    let mut after = false;
    let flush = |word: &mut String, after: &mut bool| {
        if word.is_empty() {
            return;
        }
        if word.eq_ignore_ascii_case(keyword) {
            *after = true;
        }
        word.clear();
    };
    for (i, c) in sql.char_indices() {
        if i >= mask.len() || !mask[i] {
            flush(&mut word, &mut after);
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            word.push(c);
            continue;
        }
        flush(&mut word, &mut after);
        if after && !c.is_whitespace() && c != ';' {
            return true;
        }
    }
    flush(&mut word, &mut after);
    false
}

/// 裸代码里出现完整关键字（字符串 / 注释里的字不算）。
fn has_bare_keyword(sql: &str, keyword: &str) -> bool {
    let mask = code_mask(sql);
    let mut word = String::new();
    let flush = |word: &mut String| -> bool {
        if word.is_empty() {
            return false;
        }
        let hit = word.eq_ignore_ascii_case(keyword);
        word.clear();
        hit
    };
    for (i, c) in sql.char_indices() {
        if i >= mask.len() || !mask[i] {
            if flush(&mut word) {
                return true;
            }
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            word.push(c);
            continue;
        }
        if flush(&mut word) {
            return true;
        }
    }
    flush(&mut word)
}

pub(crate) fn has_where_predicate(sql: &str) -> bool {
    has_keyword_predicate(sql, "WHERE")
}

#[cfg(test)]
mod tests {
    use super::{
        assert_alter_script, assert_alter_stmt, assert_gen_script, assert_gen_write,
        assert_pk_delete, assert_pk_update, assert_row_insert, ALTER_STMT_CAP, EXEC_STMT_CAP,
    };

    #[test]
    fn 带_where_的_delete_放行() {
        assert!(assert_pk_delete(r#"DELETE FROM "t" WHERE "id" = 1"#).is_ok());
        assert!(assert_pk_delete("delete from t where a = 1 and b = 2").is_ok());
    }

    #[test]
    fn 没有_where_拒() {
        assert!(assert_pk_delete("DELETE FROM t").is_err());
        assert!(assert_pk_delete("DELETE FROM t WHERE").is_err());
        assert!(assert_pk_delete("DELETE FROM t WHERE;").is_err());
    }

    #[test]
    fn 不是_delete_拒() {
        assert!(assert_pk_delete("SELECT * FROM t").is_err());
        assert!(assert_pk_delete("UPDATE t SET a = 1 WHERE id = 1").is_err());
        assert!(assert_pk_delete("INSERT INTO t VALUES (1)").is_err());
    }

    #[test]
    fn 第二段拒_字符串里的分号不算() {
        assert!(assert_pk_delete("DELETE FROM t WHERE id = 1; DELETE FROM t").is_err());
        assert!(assert_pk_delete("DELETE FROM t WHERE name = 'a;b'").is_ok());
    }

    #[test]
    fn 注释里的_where_不算() {
        assert!(assert_pk_delete("DELETE FROM t -- WHERE id = 1").is_err());
        assert!(assert_pk_delete("DELETE FROM t WHERE id = 1 -- 注释").is_ok());
    }

    #[test]
    fn 带_set_where_的_update_放行() {
        assert!(assert_pk_update(r#"UPDATE "t" SET "a" = 1 WHERE "id" = 1"#).is_ok());
        assert!(assert_pk_update("update t set a = 1 where id = 1").is_ok());
    }

    #[test]
    fn update_没有_where_或_set_拒() {
        assert!(assert_pk_update("UPDATE t SET a = 1").is_err());
        assert!(assert_pk_update("UPDATE t WHERE id = 1").is_err());
        assert!(assert_pk_update("UPDATE t SET").is_err());
        assert!(assert_pk_update("UPDATE t SET;").is_err());
        assert!(assert_pk_update("DELETE FROM t WHERE id = 1").is_err());
        assert!(assert_pk_update("INSERT INTO t VALUES (1)").is_err());
    }

    #[test]
    fn 带_values_的_insert_放行() {
        assert!(assert_row_insert(r#"INSERT INTO "t" ("name") VALUES ('张三')"#).is_ok());
        assert!(assert_row_insert("insert into t (a) values (1)").is_ok());
        assert!(assert_row_insert("INSERT INTO t (name) VALUES ('SELECT')").is_ok());
        assert!(assert_row_insert("INSERT INTO t (name) VALUES ('a;b')").is_ok());
    }

    #[test]
    fn insert_select_或没有_values_拒() {
        assert!(assert_row_insert("INSERT INTO t SELECT * FROM t").is_err());
        assert!(assert_row_insert("INSERT INTO t").is_err());
        assert!(assert_row_insert("INSERT INTO t VALUES").is_err());
        assert!(assert_row_insert("UPDATE t SET a = 1 WHERE id = 1").is_err());
        assert!(assert_row_insert("INSERT INTO t (a) VALUES (1); INSERT INTO t (a) VALUES (2)").is_err());
        assert!(assert_row_insert("INSERT INTO t (a) VALUES ((SELECT 1 FROM dual))").is_err());
    }

    #[test]
    fn update_第二段拒_字符串里的分号不算() {
        assert!(assert_pk_update("UPDATE t SET a = 1 WHERE id = 1; UPDATE t SET a = 2 WHERE id = 2").is_err());
        assert!(assert_pk_update("UPDATE t SET name = 'a;b' WHERE id = 1").is_ok());
    }

    #[test]
    fn 生成页_insert_放行_select_拒() {
        assert!(assert_gen_write("INSERT INTO t (id) VALUES (1)").is_ok());
        assert!(assert_gen_write("UPDATE t SET a = 1 WHERE id = 1").is_ok());
        assert!(assert_gen_write("DELETE FROM t WHERE id = 1").is_ok());
        assert!(assert_gen_write("SELECT * FROM t").is_err());
        assert!(assert_gen_write("UPDATE t SET a = 1").is_err());
        assert!(assert_gen_write("TRUNCATE TABLE t").is_err());
    }

    #[test]
    fn 生成页脚本条数封顶() {
        assert!(assert_gen_script(&[]).is_err());
        assert!(assert_gen_script(&["INSERT INTO t VALUES (1)".into()]).is_ok());
        let too_many = vec!["INSERT INTO t VALUES (1)".into(); EXEC_STMT_CAP + 1];
        assert!(assert_gen_script(&too_many).is_err());
    }

    #[test]
    fn alter_table_和_comment_on_放行() {
        assert!(assert_alter_stmt(r#"ALTER TABLE "t" ADD ("name" VARCHAR2(50))"#).is_ok());
        assert!(assert_alter_stmt("ALTER TABLE t DROP COLUMN name").is_ok());
        assert!(assert_alter_stmt(r#"COMMENT ON COLUMN "t"."name" IS '姓名'"#).is_ok());
        assert!(assert_alter_stmt("COMMENT ON TABLE t IS '用户'").is_ok());
        assert!(assert_alter_stmt("-- 加一列\nALTER TABLE t ADD COLUMN extra INT").is_ok());
    }

    #[test]
    fn alter_session_和_drop_truncate_拒() {
        assert!(assert_alter_stmt("ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY'").is_err());
        assert!(assert_alter_stmt("ALTER SYSTEM SWITCH LOGFILE").is_err());
        assert!(assert_alter_stmt("ALTER USER scott IDENTIFIED BY x").is_err());
        assert!(assert_alter_stmt("ALTER INDEX t_pk REBUILD").is_err());
        assert!(assert_alter_stmt("DROP TABLE t").is_err());
        assert!(assert_alter_stmt("CREATE TABLE t (id INT)").is_err());
        assert!(assert_alter_stmt("TRUNCATE TABLE t").is_err());
        assert!(assert_alter_stmt("COMMENT ON INDEX t_pk IS 'x'").is_err());
        assert!(assert_alter_stmt("ALTER TABLE t ADD (a INT); DROP TABLE t").is_err());
        assert!(assert_alter_stmt("SELECT * FROM t").is_err());
        assert!(assert_alter_stmt("MERGE INTO t USING u ON (1=1) WHEN MATCHED THEN UPDATE SET a = 1").is_err());
    }

    /// 常见的一组改数，旧闸门全拒。备份 → 重置状态 → 清关联数据，
    /// 是同一件事的三步，闸门必须一次放全。
    #[test]
    fn 手写_ctas_update_delete_放行() {
        assert!(assert_alter_stmt(
            "CREATE TABLE TMP_APPLY_BAK_0924 AS\nSELECT * FROM T_SHOP_ORDER_APPLY WHERE ID IN (1900000000000000001, 1900000000000000002)"
        )
        .is_ok());
        // AS (SELECT …) 的括号不进词表，照样判得出
        assert!(assert_alter_stmt("CREATE TABLE t AS (SELECT * FROM u)").is_ok());
        // CTE 开头也行；schema + IF NOT EXISTS + 长表名（数字会被拆段）也在 16 个词内
        assert!(assert_alter_stmt(
            "CREATE TABLE IF NOT EXISTS SHOP.T_SHOP_ORDER_APPLY_0924 AS SELECT * FROM T_SHOP_ORDER_APPLY"
        )
        .is_ok());
        // SET 里夹注释行、注释里带逗号和引号，都不能骗过 SET / WHERE 判据
        assert!(assert_alter_stmt(
            "UPDATE T_SHOP_ORDER_APPLY\n   SET STATUS = 0,                        -- 0 = 待提交\n       FLOW_INSTANCE_ID = NULL,\n       CURR_NODE_ID = NULL,\n       CURR_USER_CODE = NULL\n     -- , USER_CODE = '1000002'         -- 需要换发起人时放开\n WHERE ID = 1900000000000000001"
        )
        .is_ok());
        assert!(
            assert_alter_stmt(
                "DELETE FROM T_SHOP_ORDER_APPROVE_LOG WHERE APPLY_ID = 1900000000000000001"
            )
            .is_ok()
        );
        assert!(assert_alter_stmt("INSERT INTO t (a) VALUES (1)").is_ok());
        assert!(assert_alter_stmt("INSERT INTO t SELECT * FROM u WHERE id = 1").is_ok());
    }

    #[test]
    fn 手写_dml_缺_where_set_into_拒_普通建表拒() {
        assert!(assert_alter_stmt("UPDATE t SET a = 1").is_err());
        assert!(assert_alter_stmt("UPDATE t WHERE id = 1").is_err());
        assert!(assert_alter_stmt("UPDATE t SET a = 1 -- WHERE id = 1").is_err());
        assert!(assert_alter_stmt("DELETE FROM t").is_err());
        assert!(assert_alter_stmt("DELETE FROM t -- WHERE id = 1").is_err());
        assert!(assert_alter_stmt("INSERT t VALUES (1)").is_err());
        // 注释里的 INTO / WHERE 不算数
        assert!(assert_alter_stmt("INSERT t /* INTO */ VALUES (1)").is_err());
        // 普通 CREATE TABLE（列全手写）与 GLOBAL TEMPORARY 仍拒；CREATE 挪到别人头上也拒
        assert!(assert_alter_stmt("CREATE TABLE t (id INT)").is_err());
        assert!(assert_alter_stmt("CREATE GLOBAL TEMPORARY TABLE t AS SELECT 1 FROM u").is_err());
        assert!(assert_alter_stmt("CREATE OR REPLACE TABLE t AS SELECT 1 FROM u").is_err());
    }

    /// 索引落地清单照这个形状出语句。拼错一个词就是「复制过去跑不了」。
    #[test]
    fn create_index_放行_别的_create_拒() {
        assert!(assert_alter_stmt("CREATE INDEX idx_t_order_no ON t_order (order_no) ONLINE").is_ok());
        assert!(assert_alter_stmt("CREATE UNIQUE INDEX uk_x ON t (a)").is_ok());
        assert!(assert_alter_stmt("CREATE BITMAP INDEX bx ON t (a)").is_ok());
        assert!(assert_alter_stmt("CREATE UNIQUE BITMAP INDEX bx ON t (a)").is_ok());
        assert!(assert_alter_stmt("CREATE INDEX CONCURRENTLY ix ON t (a)").is_ok());
        assert!(assert_alter_stmt("CREATE INDEX IF NOT EXISTS ix ON t (a)").is_ok());
        assert!(assert_alter_stmt("ALTER TABLE t ADD INDEX ix (a)").is_ok());
        assert!(assert_alter_stmt("ANALYZE").is_ok());
        assert!(assert_alter_stmt("ANALYZE TABLE t").is_ok());
        // 没有 INDEX 这个词的 CREATE 一条都不进
        assert!(assert_alter_stmt("CREATE OR REPLACE VIEW v AS SELECT 1").is_err());
        assert!(assert_alter_stmt("CREATE USER u IDENTIFIED BY x").is_err());
        assert!(assert_alter_stmt("CREATE DATABASE d").is_err());
        // 注释里的 CREATE INDEX 不算数：真语句是 DROP TABLE，照拒
        assert!(assert_alter_stmt("-- CREATE INDEX 说明\nDROP TABLE t").is_err());
    }

    #[test]
    fn create_index_能整份脚本跑() {
        let script = [
            "CREATE INDEX idx_a ON t (a)".to_string(),
            "CREATE INDEX idx_b ON t (b)".to_string(),
        ];
        assert!(assert_alter_script(&script).is_ok());
        assert!(assert_alter_script(&["CREATE TABLE t (id INT)".to_string()]).is_err());
    }

    #[test]
    fn 增量_ddl_条数封顶() {
        assert!(assert_alter_script(&[]).is_err());
        assert!(assert_alter_script(&["ALTER TABLE t ADD (a INT)".into()]).is_ok());
        let too_many = vec!["ALTER TABLE t ADD (a INT)".into(); ALTER_STMT_CAP + 1];
        assert!(assert_alter_script(&too_many).is_err());
        assert!(assert_alter_script(&["SELECT * FROM t".into()]).is_err());
    }
}
