//! PostgreSQL 连库：拉 pg_catalog 进缓存；连上后可跑 SELECT，以及勾选行按主键 DELETE / UPDATE。
//!
//! 和 Oracle / MySQL 同一条边界：不用 `tauri-plugin-sql` 连用户的库——
//! `sql:allow-execute` 是给本地 `cache.db` 的。查询面只有 SELECT；
//! 写路径是独立的 `postgres_delete_rows` / `postgres_update_rows` / `postgres_insert_rows` / `postgres_exec_ddl`。SQL 框不能跑写语句。
//!
//! 行别名 tname/cname/… 跟 `src/lib/dbmeta.ts` 那一套对齐，字段类型文本
//! 由 `format_type` 给出，前端 `formatPgType` 再收成用户会写的 DDL 词。

use crate::sql_readonly::{assert_readonly_select, row_cap, QueryGrid};
use crate::sql_write::{
    assert_alter_script, assert_gen_script, assert_pk_delete, assert_pk_update, assert_row_insert,
    DeleteResult, ExecResult,
};
use native_tls::TlsConnector;
use postgres::types::ToSql;
use postgres::{Client, Config, NoTls, Row, SimpleQueryMessage};
use postgres_native_tls::MakeTlsConnector;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;

const CALL_TIMEOUT_SECS: u64 = 30;

struct PgInner {
    client: Client,
}

pub struct PostgresState {
    inner: Arc<Mutex<Option<PgInner>>>,
}

impl PostgresState {
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
    if low.contains("password authentication failed") || low.contains("28p01") {
        return "用户名或密码不对".into();
    }
    if low.contains("does not exist") && (low.contains("database") || low.contains("3d000")) {
        return format!("数据库不存在：{s}");
    }
    if low.contains("could not connect")
        || low.contains("connection refused")
        || low.contains("timed out")
        || low.contains("timeout")
        || low.contains("failed to lookup")
    {
        return format!("连不上主机：{s}");
    }
    s
}

fn lock(
    slot: &Mutex<Option<PgInner>>,
) -> Result<std::sync::MutexGuard<'_, Option<PgInner>>, String> {
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
    match row.try_get::<_, Option<String>>(i) {
        Ok(v) => cell(v),
        Err(_) => match row.try_get::<_, String>(i) {
            Ok(v) => cell(Some(v)),
            Err(_) => match row.try_get::<_, i64>(i) {
                Ok(n) => Some(n.to_string()),
                Err(_) => None,
            },
        },
    }
}

/// public 下的表不带 schema；别的用户 schema 写成 schema.table。
/// 系统目录不列。点表名填 SELECT 时，带点的名字由前端按段加引号。
pub fn display_table(schema: &str, table: &str) -> String {
    if schema == "public" {
        table.to_string()
    } else {
        format!("{schema}.{table}")
    }
}

/// 点表拉字段：没写 schema 就当 public。
pub fn split_table(name: &str) -> (String, String) {
    match name.split_once('.') {
        Some((schema, table)) if !schema.is_empty() && !table.is_empty() && !table.contains('.') => {
            (schema.to_string(), table.to_string())
        }
        _ => ("public".into(), name.to_string()),
    }
}

const SQL_VERSION: &str = "SELECT version()::text";

const SQL_TABLES: &str = "\
SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS tname, \
       obj_description(c.oid, 'pg_class') AS tcmt \
  FROM pg_class c \
  JOIN pg_namespace n ON n.oid = c.relnamespace \
 WHERE c.relkind IN ('r', 'p') \
   AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') \
   AND n.nspname NOT LIKE 'pg_temp_%' \
   AND n.nspname NOT LIKE 'pg_toast_temp_%' \
 ORDER BY 1";

const SQL_COUNTS: &str = "\
SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS tname, \
       COUNT(*)::text AS n \
  FROM pg_attribute a \
  JOIN pg_class c ON c.oid = a.attrelid \
  JOIN pg_namespace n ON n.oid = c.relnamespace \
 WHERE a.attnum > 0 AND NOT a.attisdropped \
   AND c.relkind IN ('r', 'p') \
   AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') \
   AND n.nspname NOT LIKE 'pg_temp_%' \
   AND n.nspname NOT LIKE 'pg_toast_temp_%' \
 GROUP BY 1";

const SQL_FKS: &str = "\
SELECT con.conname::text AS cname, \
       CASE WHEN nfs.nspname = 'public' THEN clf.relname ELSE nfs.nspname || '.' || clf.relname END AS ftbl, \
       af.attname AS fcol, \
       CASE WHEN ntt.nspname = 'public' THEN clt.relname ELSE ntt.nspname || '.' || clt.relname END AS ttbl, \
       at.attname AS tcol \
  FROM pg_constraint con \
  JOIN pg_class clf ON clf.oid = con.conrelid \
  JOIN pg_namespace nfs ON nfs.oid = clf.relnamespace \
  JOIN pg_class clt ON clt.oid = con.confrelid \
  JOIN pg_namespace ntt ON ntt.oid = clt.relnamespace \
  JOIN unnest(con.conkey) WITH ORDINALITY AS src(attnum, ord) ON TRUE \
  JOIN unnest(con.confkey) WITH ORDINALITY AS dst(attnum, ord) ON dst.ord = src.ord \
  JOIN pg_attribute af ON af.attrelid = con.conrelid AND af.attnum = src.attnum \
  JOIN pg_attribute at ON at.attrelid = con.confrelid AND at.attnum = dst.attnum \
 WHERE con.contype = 'f' \
   AND nfs.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') \
 ORDER BY 2, 1, src.ord";

const SQL_COLS: &str = "\
SELECT a.attname AS cname, \
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS ctype, \
       CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS cnull, \
       pg_get_expr(ad.adbin, ad.adrelid) AS cdef, \
       col_description(a.attrelid, a.attnum) AS ccmt, \
       CASE WHEN EXISTS ( \
              SELECT 1 FROM pg_index i \
               WHERE i.indrelid = a.attrelid AND a.attnum = ANY (i.indkey) AND i.indisprimary \
            ) THEN 'PRI' \
            WHEN EXISTS ( \
              SELECT 1 FROM pg_index i \
               WHERE i.indrelid = a.attrelid AND i.indisunique AND NOT i.indisprimary \
                 AND array_length(i.indkey, 1) = 1 AND a.attnum = ANY (i.indkey) \
            ) THEN 'UNI' \
            WHEN EXISTS ( \
              SELECT 1 FROM pg_index i \
               WHERE i.indrelid = a.attrelid AND NOT i.indisunique AND NOT i.indisprimary \
                 AND array_length(i.indkey, 1) = 1 AND a.attnum = ANY (i.indkey) \
            ) THEN 'MUL' \
            ELSE '' END AS ckey, \
       CASE WHEN a.attidentity IN ('a', 'd') THEN 'auto_increment' \
            WHEN pg_get_expr(ad.adbin, ad.adrelid) LIKE 'nextval(%' THEN 'auto_increment' \
            ELSE '' END AS cextra \
  FROM pg_attribute a \
  JOIN pg_class c ON c.oid = a.attrelid \
  JOIN pg_namespace n ON n.oid = c.relnamespace \
  LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
 WHERE n.nspname = $1 AND c.relname = $2 \
   AND a.attnum > 0 AND NOT a.attisdropped \
 ORDER BY a.attnum";

fn build_config(host: &str, port: &str, user: &str, password: &str, db: &str) -> Result<Config, String> {
    let port_n: u16 = port.trim().parse().map_err(|_| format!("端口不是数字：{}", port.trim()))?;
    let mut cfg = Config::new();
    cfg.host(host.trim());
    cfg.port(port_n);
    cfg.user(user.trim());
    cfg.password(password);
    cfg.dbname(db.trim());
    cfg.connect_timeout(Duration::from_secs(CALL_TIMEOUT_SECS));
    cfg.application_name("CHUJU SQL");
    Ok(cfg)
}

fn wants_ssl(e: &postgres::Error) -> bool {
    let s = e.to_string().to_lowercase();
    s.contains("ssl") || s.contains("tls") || s.contains("encrypt")
}

fn connect_tls(cfg: &Config) -> Result<Client, String> {
    let connector = TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
        .map_err(|e| format!("TLS 初始化失败：{e}"))?;
    cfg.connect(MakeTlsConnector::new(connector)).map_err(map_err)
}

fn open_client(host: &str, port: &str, user: &str, password: &str, db: &str) -> Result<Client, String> {
    let cfg = build_config(host, port, user, password, db)?;
    match cfg.connect(NoTls) {
        Ok(c) => Ok(c),
        Err(e) if wants_ssl(&e) => connect_tls(&cfg),
        Err(e) => Err(map_err(e)),
    }
}

fn query_version(client: &mut Client) -> String {
    match client.query_one(SQL_VERSION, &[]) {
        Ok(row) => opt_from_row(&row, 0).unwrap_or_else(|| "?".into()),
        Err(_) => "?".into(),
    }
}

fn query_tables(client: &mut Client) -> Result<Vec<TableRow>, String> {
    let rows = client.query(SQL_TABLES, &[]).map_err(map_err)?;
    Ok(rows
        .iter()
        .map(|r| TableRow {
            tname: opt_from_row(r, 0),
            tcmt: opt_from_row(r, 1),
        })
        .collect())
}

fn query_counts(client: &mut Client) -> Result<Vec<CountRow>, String> {
    let rows = client.query(SQL_COUNTS, &[]).map_err(map_err)?;
    Ok(rows
        .iter()
        .map(|r| CountRow {
            tname: opt_from_row(r, 0),
            n: opt_from_row(r, 1),
        })
        .collect())
}

fn query_fks(client: &mut Client) -> Result<Vec<FkRow>, String> {
    let rows = client.query(SQL_FKS, &[]).map_err(map_err)?;
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

fn fetch_catalog(client: &mut Client) -> Result<Catalog, String> {
    Ok(Catalog {
        version: query_version(client),
        tables: query_tables(client)?,
        counts: query_counts(client)?,
        fks: query_fks(client)?,
    })
}

fn fetch_columns(client: &mut Client, table: &str) -> Result<Vec<ColRow>, String> {
    let (schema, name) = split_table(table.trim());
    let params: [&(dyn ToSql + Sync); 2] = [&schema, &name];
    let rows = client.query(SQL_COLS, &params).map_err(map_err)?;
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

fn run_query(client: &mut Client, sql: &str, cap: usize) -> Result<QueryGrid, String> {
    // simple_query 走文本协议，NUMERIC / 数组 / JSON 都是 psql 那套字面量，
    // 不必自己解二进制。空结果没有行时列名也拿不到——空表就空网格。
    let messages = client.simple_query(sql).map_err(map_err)?;
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut truncated = false;
    for msg in messages {
        let SimpleQueryMessage::Row(row) = msg else {
            continue;
        };
        if columns.is_empty() {
            columns = row.columns().iter().map(|c| c.name().to_string()).collect();
        }
        if rows.len() >= cap {
            truncated = true;
            continue;
        }
        let n = columns.len();
        rows.push((0..n).map(|i| row.get(i).unwrap_or("").to_string()).collect());
    }
    Ok(QueryGrid {
        columns,
        rows,
        truncated,
        cap,
    })
}

#[tauri::command]
pub async fn postgres_connect(
    state: State<'_, PostgresState>,
    host: String,
    port: String,
    user: String,
    password: String,
    db: String,
) -> Result<Catalog, String> {
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let mut client = open_client(&host, &port, &user, &password, &db)?;
        let catalog = fetch_catalog(&mut client)?;
        let mut guard = lock(&slot)?;
        *guard = Some(PgInner { client });
        Ok(catalog)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn postgres_columns(
    state: State<'_, PostgresState>,
    table: String,
) -> Result<Vec<ColRow>, String> {
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = lock(&slot)?;
        let inner = guard
            .as_mut()
            .ok_or_else(|| "尚未连接，请先点「连接并读取」".to_string())?;
        fetch_columns(&mut inner.client, table.trim())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn postgres_query(
    state: State<'_, PostgresState>,
    sql: String,
    load_all: bool,
) -> Result<QueryGrid, String> {
    assert_readonly_select(&sql)?;
    let cap = row_cap(load_all);
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = lock(&slot)?;
        let inner = guard
            .as_mut()
            .ok_or_else(|| "尚未连接，请先点「连接并读取」".to_string())?;
        run_query(&mut inner.client, sql.trim(), cap)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn run_dml(client: &mut Client, sql: &str) -> Result<u64, String> {
    client.execute(sql, &[]).map_err(map_err)
}

#[tauri::command]
pub async fn postgres_delete_rows(
    state: State<'_, PostgresState>,
    sql: String,
) -> Result<DeleteResult, String> {
    assert_pk_delete(&sql)?;
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = lock(&slot)?;
        let inner = guard
            .as_mut()
            .ok_or_else(|| "尚未连接，请先点「连接并读取」".to_string())?;
        let n = run_dml(&mut inner.client, sql.trim())?;
        Ok(DeleteResult { affected: n })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn postgres_update_rows(
    state: State<'_, PostgresState>,
    sql: String,
) -> Result<DeleteResult, String> {
    assert_pk_update(&sql)?;
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = lock(&slot)?;
        let inner = guard
            .as_mut()
            .ok_or_else(|| "尚未连接，请先点「连接并读取」".to_string())?;
        let n = run_dml(&mut inner.client, sql.trim())?;
        Ok(DeleteResult { affected: n })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn postgres_insert_rows(
    state: State<'_, PostgresState>,
    sql: String,
) -> Result<DeleteResult, String> {
    assert_row_insert(&sql)?;
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = lock(&slot)?;
        let inner = guard
            .as_mut()
            .ok_or_else(|| "尚未连接，请先点「连接并读取」".to_string())?;
        let n = run_dml(&mut inner.client, sql.trim())?;
        Ok(DeleteResult { affected: n })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn postgres_exec_sql(
    state: State<'_, PostgresState>,
    statements: Vec<String>,
) -> Result<ExecResult, String> {
    assert_gen_script(&statements)?;
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = lock(&slot)?;
        let inner = guard
            .as_mut()
            .ok_or_else(|| "尚未连接，请先点「连接并读取」".to_string())?;
        let mut affected = 0u64;
        let mut ran = 0u32;
        for (i, sql) in statements.iter().enumerate() {
            match run_dml(&mut inner.client, sql.trim()) {
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
pub async fn postgres_exec_ddl(
    state: State<'_, PostgresState>,
    statements: Vec<String>,
) -> Result<ExecResult, String> {
    assert_alter_script(&statements)?;
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = lock(&slot)?;
        let inner = guard
            .as_mut()
            .ok_or_else(|| "尚未连接，请先点「连接并读取」".to_string())?;
        let mut affected = 0u64;
        let mut ran = 0u32;
        for (i, sql) in statements.iter().enumerate() {
            match run_dml(&mut inner.client, sql.trim()) {
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
pub async fn postgres_disconnect(state: State<'_, PostgresState>) -> Result<(), String> {
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = lock(&slot)?;
        *guard = None;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{display_table, split_table};

    #[test]
    fn public_表不带_schema() {
        assert_eq!(display_table("public", "users"), "users");
        assert_eq!(split_table("users"), ("public".into(), "users".into()));
    }

    #[test]
    fn 其它_schema_写成限定名() {
        assert_eq!(display_table("audit", "logs"), "audit.logs");
        assert_eq!(split_table("audit.logs"), ("audit".into(), "logs".into()));
    }

    #[test]
    fn 限定名拆不开就当_public() {
        assert_eq!(split_table("a.b.c"), ("public".into(), "a.b.c".into()));
        assert_eq!(split_table(".users"), ("public".into(), ".users".into()));
    }
}
