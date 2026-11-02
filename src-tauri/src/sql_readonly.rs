//! 连库查询闸门：只放行只读语句。前端也会验，这里是真正的边界。

use serde::Serialize;

pub const ROW_CAP: usize = 200;
pub const ROW_CAP_ALL: usize = 10_000;

#[derive(Serialize)]
pub struct QueryGrid {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub truncated: bool,
    pub cap: usize,
}

pub fn row_cap(load_all: bool) -> usize {
    if load_all {
        ROW_CAP_ALL
    } else {
        ROW_CAP
    }
}

const ALLOW: &[&str] = &["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"];

/// 只读查询里不允许出现的裸动词。FOR UPDATE / WITH…INSERT / SELECT INTO 都靠这个。
const WRITE: &[&str] = &[
    "INSERT", "UPDATE", "DELETE", "MERGE", "CREATE", "DROP", "ALTER", "TRUNCATE", "GRANT",
    "REVOKE", "REPLACE", "CALL", "EXEC", "EXECUTE", "BEGIN", "DECLARE", "INTO",
];

pub fn assert_readonly_select(sql: &str) -> Result<(), String> {
    let first = first_keyword(sql).ok_or_else(|| "请输入一条 SELECT / WITH 查询".to_string())?;
    if !ALLOW.contains(&first.as_str()) {
        return Err(format!("只接受只读查询（SELECT / WITH / SHOW），不执行 {first}"));
    }
    if has_second_statement(sql) {
        return Err("一次只跑一条语句，不要带第二段".into());
    }
    // SHOW CREATE TABLE 是只读元数据，CREATE 不当写操作。
    if !matches!(first.as_str(), "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN") {
        if let Some(write) = first_write_verb(sql) {
            return Err(format!("只接受只读查询（SELECT / WITH / SHOW），不执行 {write}"));
        }
    }
    Ok(())
}

pub(crate) fn first_keyword(sql: &str) -> Option<String> {
    first_keywords(sql, 1).into_iter().next()
}

/// 裸代码里前 n 个关键字（字符串 / 注释里的字不算）。
/// ALTER TABLE / COMMENT ON COLUMN 要看第二、第三个词，不能只看句首。
pub(crate) fn first_keywords(sql: &str, n: usize) -> Vec<String> {
    if n == 0 {
        return Vec::new();
    }
    let mask = code_mask(sql);
    let mut word = String::new();
    let mut out = Vec::new();
    let flush = |word: &mut String, out: &mut Vec<String>| {
        if word.is_empty() || out.len() >= n {
            word.clear();
            return;
        }
        out.push(word.to_ascii_uppercase());
        word.clear();
    };
    for (i, c) in sql.char_indices() {
        if out.len() >= n {
            break;
        }
        if i >= mask.len() || !mask[i] {
            flush(&mut word, &mut out);
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            word.push(c);
            continue;
        }
        flush(&mut word, &mut out);
    }
    flush(&mut word, &mut out);
    out
}

fn first_write_verb(sql: &str) -> Option<String> {
    let mask = code_mask(sql);
    let mut word = String::new();
    for (i, c) in sql.char_indices() {
        if i >= mask.len() || !mask[i] {
            if let Some(hit) = take_write(&mut word) {
                return Some(hit);
            }
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            word.push(c);
            continue;
        }
        if let Some(hit) = take_write(&mut word) {
            return Some(hit);
        }
    }
    take_write(&mut word)
}

fn take_write(word: &mut String) -> Option<String> {
    if word.is_empty() {
        return None;
    }
    let u = word.to_ascii_uppercase();
    word.clear();
    if WRITE.contains(&u.as_str()) {
        Some(u)
    } else {
        None
    }
}

pub(crate) fn has_second_statement(sql: &str) -> bool {
    let mask = code_mask(sql);
    let mut saw_semi = false;
    for (i, c) in sql.char_indices() {
        if i >= mask.len() || !mask[i] {
            continue;
        }
        if c == ';' {
            saw_semi = true;
            continue;
        }
        if saw_semi && !c.is_whitespace() {
            return true;
        }
    }
    false
}

/// 与前端 `codeMask` 同口径的精简版：字符串和注释里的字不当关键字。
pub(crate) fn code_mask(sql: &str) -> Vec<bool> {
    let bytes: Vec<char> = sql.chars().collect();
    let n = bytes.len();
    let mut mask = vec![false; sql.len()];
    let mut quote = '\0';
    let mut line_comment = false;
    let mut block_comment = false;
    let mut byte_i = 0usize;
    let mut i = 0usize;
    while i < n {
        let c = bytes[i];
        let next = bytes.get(i + 1).copied();
        let clen = c.len_utf8();
        if line_comment {
            if c == '\n' {
                line_comment = false;
            }
            byte_i += clen;
            i += 1;
            continue;
        }
        if block_comment {
            if c == '*' && next == Some('/') {
                block_comment = false;
                byte_i += clen + 1;
                i += 2;
                continue;
            }
            byte_i += clen;
            i += 1;
            continue;
        }
        if quote != '\0' {
            if c == quote {
                if next == Some(quote) {
                    byte_i += clen * 2;
                    i += 2;
                    continue;
                }
                quote = '\0';
            }
            byte_i += clen;
            i += 1;
            continue;
        }
        if c == '-' && next == Some('-') {
            line_comment = true;
            byte_i += 2;
            i += 2;
            continue;
        }
        if c == '/' && next == Some('*') {
            block_comment = true;
            byte_i += 2;
            i += 2;
            continue;
        }
        if c == '\'' || c == '"' || c == '`' {
            quote = c;
            byte_i += clen;
            i += 1;
            continue;
        }
        for k in 0..clen {
            if byte_i + k < mask.len() {
                mask[byte_i + k] = true;
            }
        }
        byte_i += clen;
        i += 1;
    }
    mask
}

#[cfg(test)]
mod tests {
    use super::{assert_readonly_select, row_cap, ROW_CAP, ROW_CAP_ALL};

    #[test]
    fn select_放行() {
        assert!(assert_readonly_select("SELECT 1 FROM dual").is_ok());
        assert!(assert_readonly_select("with a as (select 1 x from dual) select * from a").is_ok());
        assert!(assert_readonly_select("SHOW TABLES").is_ok());
        assert!(assert_readonly_select("SHOW CREATE TABLE user").is_ok());
    }

    #[test]
    fn 写操作拒() {
        assert!(assert_readonly_select("INSERT INTO t VALUES (1)").is_err());
        assert!(assert_readonly_select("DELETE FROM t").is_err());
        assert!(assert_readonly_select("SELECT 1; DELETE FROM t").is_err());
    }

    #[test]
    fn 字符串里的分号不算第二段() {
        assert!(assert_readonly_select("SELECT 'a;b' FROM dual").is_ok());
    }

    #[test]
    fn with_后接_insert_和_for_update_拒() {
        assert!(assert_readonly_select(
            "WITH a AS (SELECT 1 x FROM dual) INSERT INTO t SELECT * FROM a"
        )
        .is_err());
        assert!(assert_readonly_select("SELECT id FROM t FOR UPDATE").is_err());
        assert!(assert_readonly_select("SELECT 'INSERT INTO t' FROM dual").is_ok());
    }

    #[test]
    fn 加载全部封顶一万() {
        assert_eq!(row_cap(false), ROW_CAP);
        assert_eq!(row_cap(true), ROW_CAP_ALL);
        assert!(ROW_CAP_ALL > ROW_CAP);
    }
}
