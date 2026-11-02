//! 连用户本机 SQLite 文件。不走 plugin-sql（那条 ACL 只给 cache.db）。
//!
//! 字典靠 `sqlite_master` + `PRAGMA table_info` / `foreign_key_list`；
//! 行别名与 MySQL 那套一致，前端共用 mapMeta*。

use crate::sql_readonly::{assert_readonly_select, row_cap, QueryGrid};
use crate::sql_write::{
    assert_alter_script, assert_gen_script, assert_pk_delete, assert_pk_update, assert_row_insert,
    DeleteResult, ExecResult,
};
use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde::Serialize;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::State;

struct SqliteInner {
    conn: Connection,
}

pub struct SqliteState {
    inner: Arc<Mutex<Option<SqliteInner>>>,
}

impl SqliteState {
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

/// 索引元数据，一行 = 索引的一列。前端按 iname 分组、iseq 排序还原复合索引结构。
/// SQL 体检（sqladvise）靠这个拿最左前缀 / JOIN 列覆盖。
#[derive(Serialize)]
pub struct IdxRow {
    pub itbl: Option<String>,
    pub iname: Option<String>,
    /// 1 = 唯一索引
    pub iuniq: Option<i64>,
    /// 'c' 普通 / 'u' 唯一约束 / 'pk' 主键（来自 PRAGMA index_list.origin）
    pub iorigin: Option<String>,
    /// 列在索引内的序号，从 0 起
    pub iseq: Option<i64>,
    /// 表达式索引（索引列不是裸列名）时为 None，前端跳过该列
    pub icol: Option<String>,
}

fn map_err(e: impl std::fmt::Display) -> String {
    let s = e.to_string();
    let low = s.to_lowercase();
    if low.contains("unable to open") || low.contains("cannot open") {
        return format!("打不开数据库文件：{s}");
    }
    if low.contains("no such table") {
        return format!("表不存在：{s}");
    }
    s
}

fn lock(
    slot: &Mutex<Option<SqliteInner>>,
) -> Result<std::sync::MutexGuard<'_, Option<SqliteInner>>, String> {
    slot.lock().map_err(|_| "内部锁失效，请重新连接".to_string())
}

fn open_db(path: &str) -> Result<Connection, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("请填写数据库文件路径".into());
    }
    if !Path::new(p).is_file() {
        return Err(format!("文件不存在：{p}"));
    }
    let conn = Connection::open_with_flags(
        p,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(map_err)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(map_err)?;
    Ok(conn)
}

fn fetch_catalog(conn: &Connection) -> Result<Catalog, String> {
    let version: String = conn
        .query_row("SELECT sqlite_version()", [], |r| r.get(0))
        .map_err(map_err)?;

    let mut tables = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master \
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
                 ORDER BY name",
            )
            .map_err(map_err)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(map_err)?;
        for row in rows {
            let name = row.map_err(map_err)?;
            tables.push(TableRow {
                tname: Some(name),
                tcmt: None,
            });
        }
    }

    let mut counts = Vec::new();
    let mut fks = Vec::new();
    for t in &tables {
        let name = t.tname.as_deref().unwrap_or("");
        if name.is_empty() {
            continue;
        }
        let n = table_col_count(conn, name)?;
        counts.push(CountRow {
            tname: Some(name.to_string()),
            n: Some(n.to_string()),
        });
        fks.extend(table_fks(conn, name)?);
    }

    Ok(Catalog {
        version,
        tables,
        counts,
        fks,
    })
}

fn table_col_count(conn: &Connection, table: &str) -> Result<usize, String> {
    let sql = format!("PRAGMA table_info({})", quote_ident(table));
    let mut stmt = conn.prepare(&sql).map_err(map_err)?;
    let rows = stmt.query_map([], |_| Ok(())).map_err(map_err)?;
    Ok(rows.count())
}

fn table_fks(conn: &Connection, table: &str) -> Result<Vec<FkRow>, String> {
    let sql = format!("PRAGMA foreign_key_list({})", quote_ident(table));
    let mut stmt = conn.prepare(&sql).map_err(map_err)?;
    // id, seq, table, from, to, on_update, on_delete, match
    let rows = stmt
        .query_map([], |r| {
            Ok(FkRow {
                cname: Some(format!("fk_{}", r.get::<_, i64>(0).unwrap_or(0))),
                ftbl: Some(table.to_string()),
                fcol: r.get::<_, Option<String>>(3)?,
                ttbl: r.get::<_, Option<String>>(2)?,
                tcol: r.get::<_, Option<String>>(4)?,
            })
        })
        .map_err(map_err)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(map_err)?);
    }
    Ok(out)
}

fn fetch_columns(conn: &Connection, table: &str) -> Result<Vec<ColRow>, String> {
    let sql = format!("PRAGMA table_info({})", quote_ident(table));
    let mut stmt = conn.prepare(&sql).map_err(map_err)?;
    // cid, name, type, notnull, dflt_value, pk
    let rows = stmt
        .query_map([], |r| {
            let name: String = r.get(1)?;
            let ctype: String = r.get::<_, Option<String>>(2)?.unwrap_or_default();
            let notnull: i64 = r.get(3)?;
            let dflt: Option<String> = r.get(4)?;
            let pk: i64 = r.get(5)?;
            let is_pk = pk > 0;
            // INTEGER PRIMARY KEY 在 SQLite 里就是自增 rowid 别名
            let auto = is_pk && ctype.to_uppercase().contains("INT");
            Ok(ColRow {
                cname: Some(name),
                ctype: Some(if ctype.is_empty() { "ANY".into() } else { ctype }),
                cnull: Some(if notnull != 0 { "NO".into() } else { "YES".into() }),
                cdef: dflt,
                ccmt: None,
                ckey: Some(if is_pk { "PRI".into() } else { "".into() }),
                cextra: Some(if auto { "auto_increment".into() } else { "".into() }),
            })
        })
        .map_err(map_err)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(map_err)?);
    }
    Ok(out)
}

/// PRAGMA 的表名不能参数化；双引号转义，防注入。
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// 一张表的全部索引（含复合索引的列顺序）。走 PRAGMA index_list + index_info：
/// index_list 给唯一性 / 来源，index_info 按序号给列名。
/// INTEGER PRIMARY KEY（rowid 别名）不会出现在 index_list 里——
/// 它本身就是 rowid，前端把主键列视作天然有索引。
fn fetch_indexes(conn: &Connection, table: &str) -> Result<Vec<IdxRow>, String> {
    let list_sql = format!("PRAGMA index_list({})", quote_ident(table));
    let mut stmt = conn.prepare(&list_sql).map_err(map_err)?;
    // seq, name, unique, origin, partial
    let indexes: Vec<(String, i64, Option<String>)> = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(map_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(map_err)?;
    drop(stmt);

    let mut out = Vec::new();
    for (name, uniq, origin) in indexes {
        let info_sql = format!("PRAGMA index_info({})", quote_ident(&name));
        let mut stmt = conn.prepare(&info_sql).map_err(map_err)?;
        // seqno, cid, name —— name 在表达式索引下为 NULL
        let rows = stmt
            .query_map([], |r| {
                Ok(IdxRow {
                    itbl: Some(table.to_string()),
                    iname: Some(name.clone()),
                    iuniq: Some(uniq),
                    iorigin: origin.clone(),
                    iseq: r.get::<_, Option<i64>>(0)?,
                    icol: r.get::<_, Option<String>>(2)?,
                })
            })
            .map_err(map_err)?;
        for row in rows {
            out.push(row.map_err(map_err)?);
        }
    }
    Ok(out)
}

fn value_to_string(v: ValueRef<'_>) -> String {
    match v {
        ValueRef::Null => String::new(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => {
            let s = f.to_string();
            if s == "NaN" || s.contains("inf") {
                String::new()
            } else {
                s
            }
        }
        ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
        ValueRef::Blob(_) => "<blob>".into(),
    }
}

fn run_query(conn: &Connection, sql: &str, cap: usize) -> Result<QueryGrid, String> {
    let mut stmt = conn.prepare(sql).map_err(map_err)?;
    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let ncols = columns.len();
    let mut rows = Vec::new();
    let mut truncated = false;
    let mut q = stmt.query([]).map_err(map_err)?;
    while let Some(row) = q.next().map_err(map_err)? {
        if rows.len() >= cap {
            truncated = true;
            break;
        }
        let mut cells = Vec::with_capacity(ncols);
        for i in 0..ncols {
            cells.push(value_to_string(row.get_ref(i).map_err(map_err)?));
        }
        rows.push(cells);
    }
    Ok(QueryGrid {
        columns,
        rows,
        truncated,
        cap,
    })
}

fn run_dml(conn: &Connection, sql: &str) -> Result<u64, String> {
    conn.execute(sql, []).map_err(map_err)?;
    Ok(conn.changes())
}

#[tauri::command]
pub async fn sqlite_connect(
    state: State<'_, SqliteState>,
    host: String,
    port: String,
    user: String,
    password: String,
    db: String,
) -> Result<Catalog, String> {
    let _ = (host, port, user, password);
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let path = db.trim().to_string();
        let conn = open_db(&path)?;
        let catalog = fetch_catalog(&conn)?;
        let mut guard = lock(&slot)?;
        *guard = Some(SqliteInner { conn });
        Ok(catalog)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sqlite_columns(
    state: State<'_, SqliteState>,
    table: String,
) -> Result<Vec<ColRow>, String> {
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock(&slot)?;
        let inner = guard
            .as_ref()
            .ok_or_else(|| "尚未连接，请先点「连接并读取」".to_string())?;
        fetch_columns(&inner.conn, table.trim())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sqlite_indexes(
    state: State<'_, SqliteState>,
    table: String,
) -> Result<Vec<IdxRow>, String> {
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock(&slot)?;
        let inner = guard
            .as_ref()
            .ok_or_else(|| "尚未连接，请先点「连接并读取」".to_string())?;
        fetch_indexes(&inner.conn, table.trim())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sqlite_query(
    state: State<'_, SqliteState>,
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
        run_query(&inner.conn, sql.trim(), cap)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sqlite_delete_rows(
    state: State<'_, SqliteState>,
    sql: String,
) -> Result<DeleteResult, String> {
    assert_pk_delete(&sql)?;
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock(&slot)?;
        let inner = guard
            .as_ref()
            .ok_or_else(|| "尚未连接，请先点「连接并读取」".to_string())?;
        let n = run_dml(&inner.conn, sql.trim())?;
        Ok(DeleteResult { affected: n })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sqlite_update_rows(
    state: State<'_, SqliteState>,
    sql: String,
) -> Result<DeleteResult, String> {
    assert_pk_update(&sql)?;
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock(&slot)?;
        let inner = guard
            .as_ref()
            .ok_or_else(|| "尚未连接，请先点「连接并读取」".to_string())?;
        let n = run_dml(&inner.conn, sql.trim())?;
        Ok(DeleteResult { affected: n })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sqlite_insert_rows(
    state: State<'_, SqliteState>,
    sql: String,
) -> Result<DeleteResult, String> {
    assert_row_insert(&sql)?;
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock(&slot)?;
        let inner = guard
            .as_ref()
            .ok_or_else(|| "尚未连接，请先点「连接并读取」".to_string())?;
        let n = run_dml(&inner.conn, sql.trim())?;
        Ok(DeleteResult { affected: n })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sqlite_exec_sql(
    state: State<'_, SqliteState>,
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
            match run_dml(&inner.conn, sql.trim()) {
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
pub async fn sqlite_exec_ddl(
    state: State<'_, SqliteState>,
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
            match run_dml(&inner.conn, sql.trim()) {
                Ok(k) => {
                    affected += k;
                    ran += 1;
                }
                Err(e) => {
                    return Err(format!(
                        "第 {} 条失败（已执行 {ran} 条）：{e}",
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
pub async fn sqlite_disconnect(state: State<'_, SqliteState>) -> Result<(), String> {
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = lock(&slot)?;
        *guard = None;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
