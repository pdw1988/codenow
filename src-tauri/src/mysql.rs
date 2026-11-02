//! MySQL 连库：拉 information_schema 进缓存；连上后可跑 SELECT，以及勾选行按主键 DELETE / UPDATE。
//!
//! 和 Oracle 同一条边界：不用 `tauri-plugin-sql` 连用户的库——
//! `sql:allow-execute` 是给本地 `cache.db` 的。查询面只有 SELECT；
//! 写路径是独立的 `mysql_delete_rows` / `mysql_update_rows` / `mysql_insert_rows` / `mysql_exec_ddl`。SQL 框不能跑写语句。
//!
//! 语句跟 `src/lib/dbmeta.ts` 那几条常量必须一致；行别名 tname/cname/…
//! 才能继续走共用的 mapMetaTables / mapMetaColumns / mapMetaForeignKeys。

use crate::sql_readonly::{assert_readonly_select, row_cap, QueryGrid};
use crate::sql_write::{
    assert_alter_script, assert_gen_script, assert_pk_delete, assert_pk_update, assert_row_insert,
    DeleteResult, ExecResult,
};
use mysql::prelude::*;
use mysql::{OptsBuilder, Pool, Row};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;

const CALL_TIMEOUT_SECS: u64 = 30;

struct MysqlInner {
    pool: Pool,
    db: String,
}

pub struct MysqlState {
    inner: Arc<Mutex<Option<MysqlInner>>>,
}

impl MysqlState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }
}

#[derive(Serialize)]
pub struct Catalog {
    pub version: String,
    pub tables: Vec<TableRow>,
    pub counts: Vec<CountRow>,
    pub fks: Vec<FkRow>,
}

#[derive(Serialize)]
pub struct TableRow {
    pub tname: Option<String>,
    pub tcmt: Option<String>,
}

#[derive(Serialize)]
pub struct CountRow {
    pub tname: Option<String>,
    pub n: Option<String>,
}

#[derive(Serialize)]
pub struct FkRow {
    pub cname: Option<String>,
    pub ftbl: Option<String>,
    pub fcol: Option<String>,
    pub ttbl: Option<String>,
    pub tcol: Option<String>,
}

#[derive(Serialize)]
pub struct ColRow {
    pub cname: Option<String>,
    pub ctype: Option<String>,
    pub cnull: Option<String>,
    pub cdef: Option<String>,
    pub ccmt: Option<String>,
    pub ckey: Option<String>,
    pub cextra: Option<String>,
}

fn map_err(e: impl std::fmt::Display) -> String {
    let s = e.to_string();
    let low = s.to_lowercase();
    if s.contains("1045") || low.contains("access denied") {
        return "用户名或密码不对（1045）".into();
    }
    if s.contains("1049") || low.contains("unknown database") {
        return format!("数据库不存在：{s}");
    }
    if s.contains("2003") || low.contains("can't connect") || low.contains("timed out") {
        return format!("连不上主机：{s}");
    }
    s
}

fn lock(
    slot: &Mutex<Option<MysqlInner>>,
) -> Result<std::sync::MutexGuard<'_, Option<MysqlInner>>, String> {
    slot.lock().map_err(|_| "内部锁失效，请重新连接".to_string())
}

fn cell(v: Option<String>) -> Option<String> {
    v.and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    })
}

fn opt_from_row(row: &Row, i: usize) -> Option<String> {
    match row.get_opt::<Option<String>, _>(i) {
        Some(Ok(v)) => cell(v),
        _ => match row.get_opt::<String, _>(i) {
            Some(Ok(v)) => cell(Some(v)),
            _ => match row.get_opt::<i64, _>(i) {
                Some(Ok(n)) => Some(n.to_string()),
                _ => match row.get_opt::<u64, _>(i) {
                    Some(Ok(n)) => Some(n.to_string()),
                    _ => None,
                },
            },
        },
    }
}

const SQL_VERSION: &str = "SELECT VERSION() AS v";

const SQL_TABLES: &str = "SELECT TABLE_NAME AS tname, TABLE_COMMENT AS tcmt \
     FROM information_schema.TABLES \
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME";

const SQL_COUNTS: &str = "SELECT TABLE_NAME AS tname, COUNT(*) AS n \
     FROM information_schema.COLUMNS \
     WHERE TABLE_SCHEMA = ? GROUP BY TABLE_NAME";

const SQL_FKS: &str = "SELECT CONSTRAINT_NAME AS cname, TABLE_NAME AS ftbl, COLUMN_NAME AS fcol, \
     REFERENCED_TABLE_NAME AS ttbl, REFERENCED_COLUMN_NAME AS tcol \
     FROM information_schema.KEY_COLUMN_USAGE \
     WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL \
     ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION";

const SQL_COLS: &str = "SELECT COLUMN_NAME AS cname, COLUMN_TYPE AS ctype, IS_NULLABLE AS cnull, \
     COLUMN_DEFAULT AS cdef, COLUMN_COMMENT AS ccmt, COLUMN_KEY AS ckey, EXTRA AS cextra \
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
     ORDER BY ORDINAL_POSITION";

fn open_pool(host: &str, port: &str, user: &str, password: &str, db: &str) -> Result<Pool, String> {
    let port_n: u16 = port.trim().parse().map_err(|_| format!("端口不是数字：{}", port.trim()))?;
    let opts = OptsBuilder::new()
        .ip_or_hostname(Some(host.trim()))
        .tcp_port(port_n)
        .user(Some(user.trim()))
        .pass(Some(password))
        .db_name(Some(db.trim()))
        .tcp_connect_timeout(Some(Duration::from_secs(CALL_TIMEOUT_SECS)));
    Pool::new(opts).map_err(map_err)
}

fn query_version(conn: &mut mysql::PooledConn) -> String {
    match conn.query_first::<Option<String>, _>(SQL_VERSION) {
        Ok(Some(Some(v))) => {
            let t = v.trim();
            if t.is_empty() {
                "?".into()
            } else {
                t.to_string()
            }
        }
        Ok(Some(None)) | Ok(None) => "?".into(),
        Err(_) => match conn.query_first::<String, _>(SQL_VERSION) {
            Ok(Some(v)) => {
                let t = v.trim();
                if t.is_empty() {
                    "?".into()
                } else {
                    t.to_string()
                }
            }
            _ => "?".into(),
        },
    }
}

fn query_tables(conn: &mut mysql::PooledConn, db: &str) -> Result<Vec<TableRow>, String> {
    let rows: Vec<Row> = conn.exec(SQL_TABLES, (db,)).map_err(map_err)?;
    Ok(rows
        .iter()
        .map(|r| TableRow {
            tname: opt_from_row(r, 0),
            tcmt: opt_from_row(r, 1),
        })
        .collect())
}

fn query_counts(conn: &mut mysql::PooledConn, db: &str) -> Result<Vec<CountRow>, String> {
    let rows: Vec<Row> = conn.exec(SQL_COUNTS, (db,)).map_err(map_err)?;
    Ok(rows
        .iter()
        .map(|r| CountRow {
            tname: opt_from_row(r, 0),
            n: opt_from_row(r, 1),
        })
        .collect())
}

fn query_fks(conn: &mut mysql::PooledConn, db: &str) -> Result<Vec<FkRow>, String> {
    let rows: Vec<Row> = conn.exec(SQL_FKS, (db,)).map_err(map_err)?;
    Ok(rows
        .iter()
        .map(|r| FkRow {
            cname: opt_from_row(r, 0),
            ftbl: opt_from_row(r, 1),
            fcol: opt_from_row(r, 2),
            ttbl: opt_from_row(r, 3),
            tcol: opt_from_row(r, 4),
        })
        .collect())
}

fn fetch_catalog(pool: &Pool, db: &str) -> Result<Catalog, String> {
    let mut conn = pool.get_conn().map_err(map_err)?;
    Ok(Catalog {
        version: query_version(&mut conn),
        tables: query_tables(&mut conn, db)?,
        counts: query_counts(&mut conn, db)?,
        fks: query_fks(&mut conn, db)?,
    })
}

fn fetch_columns(pool: &Pool, db: &str, table: &str) -> Result<Vec<ColRow>, String> {
    let mut conn = pool.get_conn().map_err(map_err)?;
    let rows: Vec<Row> = conn.exec(SQL_COLS, (db, table)).map_err(map_err)?;
    Ok(rows
        .iter()
        .map(|r| ColRow {
            cname: opt_from_row(r, 0),
            ctype: opt_from_row(r, 1),
            cnull: opt_from_row(r, 2),
            cdef: opt_from_row(r, 3),
            ccmt: opt_from_row(r, 4),
            ckey: opt_from_row(r, 5),
            cextra: opt_from_row(r, 6),
        })
        .collect())
}

#[tauri::command]
pub async fn mysql_connect(
    state: State<'_, MysqlState>,
    host: String,
    port: String,
    user: String,
    password: String,
    db: String,
) -> Result<Catalog, String> {
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let db = db.trim().to_string();
        let pool = open_pool(&host, &port, &user, &password, &db)?;
        let catalog = fetch_catalog(&pool, &db)?;
        let mut guard = lock(&slot)?;
        *guard = Some(MysqlInner { pool, db });
        Ok(catalog)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mysql_columns(state: State<'_, MysqlState>, table: String) -> Result<Vec<ColRow>, String> {
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock(&slot)?;
        let inner = guard
            .as_ref()
            .ok_or_else(|| "尚未连接，请先点「连接并读取」".to_string())?;
        fetch_columns(&inner.pool, &inner.db, table.trim())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn run_query(pool: &Pool, sql: &str, cap: usize) -> Result<QueryGrid, String> {
    let mut conn = pool.get_conn().map_err(map_err)?;
    let result = conn.query_iter(sql).map_err(map_err)?;
    let columns: Vec<String> = result
        .columns()
        .as_ref()
        .iter()
        .map(|c| c.name_str().to_string())
        .collect();
    let ncols = columns.len();
    let mut rows = Vec::new();
    let mut truncated = false;
    for row in result {
        if rows.len() >= cap {
            truncated = true;
            break;
        }
        let row = row.map_err(map_err)?;
        rows.push((0..ncols).map(|i| opt_from_row(&row, i).unwrap_or_default()).collect());
    }
    Ok(QueryGrid {
        columns,
        rows,
        truncated,
        cap,
    })
}

#[tauri::command]
pub async fn mysql_query(
    state: State<'_, MysqlState>,
    sql: String,
    load_all: bool,
) -> Result<QueryGrid, String> {
    assert_readonly_select(&sql)?;
    let cap = row_cap(load_all);
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock(&slot)?;
        let inner = guard
            .as_ref()
            .ok_or_else(|| "尚未连接，请先点「连接并读取」".to_string())?;
        run_query(&inner.pool, sql.trim(), cap)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn run_dml(pool: &Pool, sql: &str) -> Result<u64, String> {
    let mut conn = pool.get_conn().map_err(map_err)?;
    conn.query_drop(sql).map_err(map_err)?;
    Ok(conn.affected_rows())
}

#[tauri::command]
pub async fn mysql_delete_rows(
    state: State<'_, MysqlState>,
    sql: String,
) -> Result<DeleteResult, String> {
    assert_pk_delete(&sql)?;
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock(&slot)?;
        let inner = guard
            .as_ref()
            .ok_or_else(|| "尚未连接，请先点「连接并读取」".to_string())?;
        let n = run_dml(&inner.pool, sql.trim())?;
        Ok(DeleteResult { affected: n })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mysql_update_rows(
    state: State<'_, MysqlState>,
    sql: String,
) -> Result<DeleteResult, String> {
    assert_pk_update(&sql)?;
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock(&slot)?;
        let inner = guard
            .as_ref()
            .ok_or_else(|| "尚未连接，请先点「连接并读取」".to_string())?;
        let n = run_dml(&inner.pool, sql.trim())?;
        Ok(DeleteResult { affected: n })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mysql_insert_rows(
    state: State<'_, MysqlState>,
    sql: String,
) -> Result<DeleteResult, String> {
    assert_row_insert(&sql)?;
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock(&slot)?;
        let inner = guard
            .as_ref()
            .ok_or_else(|| "尚未连接，请先点「连接并读取」".to_string())?;
        let n = run_dml(&inner.pool, sql.trim())?;
        Ok(DeleteResult { affected: n })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mysql_exec_sql(
    state: State<'_, MysqlState>,
    statements: Vec<String>,
) -> Result<ExecResult, String> {
    assert_gen_script(&statements)?;
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock(&slot)?;
        let inner = guard
            .as_ref()
            .ok_or_else(|| "尚未连接，请先点「连接并读取」".to_string())?;
        let mut affected = 0u64;
        let mut ran = 0u32;
        for (i, sql) in statements.iter().enumerate() {
            match run_dml(&inner.pool, sql.trim()) {
                Ok(k) => {
                    affected += k;
                    ran += 1;
                }
                Err(e) => {
                    return Err(format!(
                        "第 {} 条失败（已执行 {ran} 条，影响 {affected} 行）：{e}",
                        i + 1
                    ))
                }
            }
        }
        Ok(ExecResult { affected, ran })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mysql_exec_ddl(
    state: State<'_, MysqlState>,
    statements: Vec<String>,
) -> Result<ExecResult, String> {
    assert_alter_script(&statements)?;
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock(&slot)?;
        let inner = guard
            .as_ref()
            .ok_or_else(|| "尚未连接，请先点「连接并读取」".to_string())?;
        let mut affected = 0u64;
        let mut ran = 0u32;
        for (i, sql) in statements.iter().enumerate() {
            match run_dml(&inner.pool, sql.trim()) {
                Ok(k) => {
                    affected += k;
                    ran += 1;
                }
                Err(e) => {
                    return Err(format!(
                        "第 {} 条失败（已执行 {ran} 条，影响 {affected} 行）：{e}",
                        i + 1
                    ))
                }
            }
        }
        Ok(ExecResult { affected, ran })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mysql_disconnect(state: State<'_, MysqlState>) -> Result<(), String> {
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = lock(&slot)?;
        *guard = None;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
