//! Oracle 连库：拉数据字典进缓存；连上后可跑 SELECT，以及勾选行按主键 DELETE / UPDATE、插入一行。
//!
//! 不用 `tauri-plugin-sql` 去连用户的库——那条 `sql:allow-execute` 是给本地
//! `cache.db` 的。查询面只有 SELECT；写路径是独立命令：
//! `oracle_delete_rows` 只放行带 WHERE 的 DELETE，
//! `oracle_update_rows` 只放行带 SET + WHERE 的 UPDATE，
//! `oracle_insert_rows` 只放行带 VALUES 的 INSERT（不跑 INSERT … SELECT）。
//! `oracle_exec_ddl` 放行 ALTER TABLE / COMMENT ON / CREATE INDEX / ANALYZE、
//! 带 WHERE 的 UPDATE / DELETE、INSERT INTO、CREATE TABLE … AS SELECT——查询框
//! 按内容分流后都从这条走（白名单在 sql_write::assert_alter_script）。
//!
//! 两路驱动：
//! 1. 官方 `oracledb`（纯 Rust，免 Instant Client）——只认协议 12.1+（TNS 315）
//! 2. `oracle` crate + Instant Client——11g 也能连。含客户端安装包把 19c Basic 打进去；
//!    普通包用本机 PATH / OCI_LIB_DIR。DBeaver 走 JDBC 所以它能连 11g，跟 VPN 无关。

use crate::sql_readonly::{assert_readonly_select, row_cap, QueryGrid};
use crate::sql_write::{
    assert_alter_script, assert_gen_script, assert_pk_delete, assert_pk_update, assert_row_insert,
    DeleteResult, ExecResult,
};
use ::oracle as oci;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;

const CALL_TIMEOUT_SECS: u64 = 30;

const MSG_NEED_CLIENT: &str = "这台库低于 Oracle 12.1（多半是 11g）。DBeaver 用 JDBC 所以能连，跟 VPN 无关。\
免客户端驱动只认 12.1+。请改用下载页的「含 Oracle 11g 客户端」安装包，本机就不用再装 Instant Client。\
已经装过 Instant Client / PL/SQL 的，用普通安装包即可：把含 oci.dll 的目录加到 PATH，或设 OCI_LIB_DIR，然后重开窗口。";

/// 含客户端安装包卸到这里，普通包自动更新不会覆盖。NSIS 钩子也会拷一份过来。
fn persistent_oci_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("CHUJU-SQL-oracle-client"))
}

fn exe_parent() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

fn bundled_oci_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(dir) = exe_parent() {
        out.push(dir.join("instantclient"));
        out.push(dir.join("resources").join("instantclient"));
    }
    out
}

fn copy_dir(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)? {
        let e = e?;
        let to = dst.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &to)?;
        } else {
            let _ = std::fs::copy(e.path(), to);
        }
    }
    Ok(())
}

/// 安装目录里的 Instant Client 拷到用户目录，避免以后自动更新（普通包）把 11g 客户端冲掉。
fn persist_bundled_oci(from: &std::path::Path) {
    let Some(dest) = persistent_oci_dir() else {
        return;
    };
    if has_oci(&dest) {
        return;
    }
    let Some(exe) = exe_parent() else {
        return;
    };
    if !from.starts_with(&exe) {
        return;
    }
    let _ = copy_dir(from, &dest);
}

fn has_oci(dir: &std::path::Path) -> bool {
    dir.join("oci.dll").is_file()
}

fn find_oci_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("OCI_LIB_DIR") {
        let p = PathBuf::from(d);
        if has_oci(&p) {
            return Some(p);
        }
    }
    for p in bundled_oci_dirs() {
        if has_oci(&p) {
            persist_bundled_oci(&p);
            return Some(p);
        }
    }
    if let Some(p) = persistent_oci_dir() {
        if has_oci(&p) {
            return Some(p);
        }
    }
    if let Ok(h) = std::env::var("ORACLE_HOME") {
        let p = PathBuf::from(h).join("bin");
        if has_oci(&p) {
            return Some(p);
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for p in std::env::split_paths(&paths) {
            if has_oci(&p) {
                return Some(p);
            }
        }
    }
    if let Ok(rd) = std::fs::read_dir(r"C:\oracle") {
        for e in rd.flatten() {
            let p = e.path();
            if has_oci(&p) {
                return Some(p);
            }
        }
    }
    None
}

enum Backend {
    Thin(oracledb::Connection),
    Thick(oci::Connection),
}

pub struct OracleState {
    conn: Arc<Mutex<Option<Backend>>>,
}

impl OracleState {
    pub fn new() -> Self {
        Self {
            conn: Arc::new(Mutex::new(None)),
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
    pub dtype: Option<String>,
    pub dlen: Option<String>,
    pub dprec: Option<String>,
    pub dscale: Option<String>,
    pub clen: Option<String>,
    pub cused: Option<String>,
    pub cnull: Option<String>,
    pub cdef: Option<String>,
    pub ccmt: Option<String>,
    pub ident: Option<String>,
    pub pk: Option<String>,
    pub uniq: Option<String>,
    pub idx: Option<String>,
}

fn map_err(e: impl std::fmt::Display) -> String {
    let s = e.to_string();
    if s.contains("connections to this database server are not supported") {
        return MSG_NEED_CLIENT.into();
    }
    if s.contains("DPI-1047")
        || (s.to_lowercase().contains("cannot locate") && s.to_lowercase().contains("oracle client"))
    {
        return MSG_NEED_CLIENT.into();
    }
    if s.contains("ORA-01017") {
        return "用户名或密码不对（ORA-01017）".into();
    }
    if s.contains("ORA-12514") || s.contains("ORA-12505") || s.contains("ORA-12541") {
        return format!("服务名 / SID / 监听对不上：{s}");
    }
    if s.contains("ORA-12170") || s.to_lowercase().contains("timed out") {
        return format!("连不上主机（超时）：{s}");
    }
    if s.contains("no configuration directory specified") {
        return MSG_NO_TNS.into();
    }
    s
}

const MSG_NO_TNS: &str = "连接串被当成 tnsnames 别名，本机没有 TNS_ADMIN。\
请填主机 + 服务名（如 ORCLPDB1）；只有 SID 写成 :ORCL。\
不要只填 DBeaver 里的 TNS 名字。";

fn is_thin_version_rejected(err: &str) -> bool {
    err.contains("connections to this database server are not supported")
        || err.contains("这台库低于 Oracle 12.1")
}

/// 薄驱动没把串认成 Easy Connect / 描述符时，会去找 tnsnames；11g 也会在这里被拒。
/// 这两种都该再试 Instant Client，否则 SID 写法永远到不了厚驱动。
fn should_try_thick(err: &str) -> bool {
    is_thin_version_rejected(err)
        || err.contains("no configuration directory specified")
        || err.contains("tnsnames")
}

fn lock(slot: &Mutex<Option<Backend>>) -> Result<std::sync::MutexGuard<'_, Option<Backend>>, String> {
    slot.lock().map_err(|_| "内部锁失效，请重新连接".to_string())
}

fn close_backend(old: Backend) {
    match old {
        Backend::Thin(mut c) => {
            let _ = c.close();
        }
        Backend::Thick(c) => {
            let _ = c.close();
        }
    }
}

/// 跟 `src/lib/oracleMeta.ts` 的 `buildOracleConnectString` 必须逐条相同。
///
/// SID 不能写成 `host:port:sid`：官方薄驱动不认这种老写法，会当成 tnsnames
/// 别名去查，没设 TNS_ADMIN 就报 “no configuration directory specified”。
/// 改成 DESCRIPTION + CONNECT_DATA=(SID=…)，两路驱动都认。
fn connect_string(host: &str, port: &str, service: &str) -> String {
    let h = host.trim();
    let p = port.trim();
    let svc = service.trim();
    if svc.starts_with('(') || svc.contains('/') {
        return svc.to_string();
    }
    if let Some((h2, p2, sid)) = parse_host_port_sid(svc) {
        return sid_descriptor(&h2, &p2, &sid);
    }
    if svc.starts_with(':') {
        return sid_descriptor(h, p, svc.trim_start_matches(':'));
    }
    if looks_like_hostport(svc) {
        return svc.to_string();
    }
    format!("{h}:{p}/{svc}")
}

fn sid_descriptor(host: &str, port: &str, sid: &str) -> String {
    format!(
        "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST={host})(PORT={port}))(CONNECT_DATA=(SID={sid})))"
    )
}

/// `host:port:sid`，正好两段冒号且端口是数字。IPv6 不走这条。
fn parse_host_port_sid(s: &str) -> Option<(String, String, String)> {
    let mut it = s.split(':');
    let h = it.next()?;
    let p = it.next()?;
    let sid = it.next()?;
    if it.next().is_some() || h.is_empty() || sid.is_empty() {
        return None;
    }
    if p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((h.to_string(), p.to_string(), sid.to_string()))
}

fn looks_like_hostport(svc: &str) -> bool {
    let Some((head, rest)) = svc.split_once(':') else {
        return false;
    };
    !head.is_empty()
        && !rest.is_empty()
        && rest.chars().all(|c| c.is_ascii_digit())
}

fn trim_cell(v: Option<String>) -> Option<String> {
    v.and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    })
}

fn thin_cell(row: &oracledb::Row, i: usize) -> Option<String> {
    match row.get::<Option<String>>(i) {
        Ok(v) => trim_cell(v),
        Err(_) => trim_cell(row.get::<String>(i).ok()),
    }
}

fn thick_cell(row: &oci::Row, i: usize) -> Option<String> {
    match row.get::<usize, Option<String>>(i) {
        Ok(v) => trim_cell(v),
        Err(_) => trim_cell(row.get::<usize, String>(i).ok()),
    }
}

fn yn(flag: bool) -> Option<String> {
    Some(if flag { "Y".into() } else { "N".into() })
}

const SQL_TABLES: &str = "SELECT t.table_name AS tname, c.comments AS tcmt \
     FROM user_tables t \
     LEFT JOIN user_tab_comments c ON c.table_name = t.table_name \
     WHERE NVL(t.dropped, 'NO') = 'NO' \
     ORDER BY t.table_name";

const SQL_TABLES_BASIC: &str = "SELECT t.table_name AS tname, c.comments AS tcmt \
     FROM user_tables t \
     LEFT JOIN user_tab_comments c ON c.table_name = t.table_name \
     ORDER BY t.table_name";

const SQL_COUNTS: &str = "SELECT table_name AS tname, TO_CHAR(COUNT(*)) AS n \
     FROM user_tab_columns GROUP BY table_name";

const SQL_FKS: &str = "SELECT c.constraint_name AS cname, \
            cc.table_name AS ftbl, cc.column_name AS fcol, \
            rc.table_name AS ttbl, rcc.column_name AS tcol \
     FROM user_constraints c \
     JOIN user_cons_columns cc ON cc.constraint_name = c.constraint_name \
     JOIN user_constraints rc ON rc.constraint_name = c.r_constraint_name \
     JOIN user_cons_columns rcc \
       ON rcc.constraint_name = rc.constraint_name AND rcc.position = cc.position \
     WHERE c.constraint_type = 'R' \
     ORDER BY cc.table_name, c.constraint_name, cc.position";

const SQL_IDENTITY: &str = "SELECT column_name FROM user_tab_identity_cols WHERE table_name = :t";

const SQL_KEYS: &str = "SELECT cc.column_name, c.constraint_type, c.constraint_name \
     FROM user_constraints c \
     JOIN user_cons_columns cc ON cc.constraint_name = c.constraint_name \
     WHERE c.table_name = :t AND c.constraint_type IN ('P', 'U')";

// 单列非唯一普通索引。复合索引不往单列上打标（跟 UNIQUE 同一口径）。
const SQL_IDX: &str = "SELECT ic.column_name, i.index_name \
     FROM user_indexes i \
     JOIN user_ind_columns ic ON ic.index_name = i.index_name AND ic.table_name = i.table_name \
     WHERE i.table_name = :t AND i.uniqueness = 'NONUNIQUE' AND i.index_type = 'NORMAL'";

const SQL_COLS_12C: &str = "SELECT col.column_name, col.data_type, \
            TO_CHAR(col.data_length), TO_CHAR(col.data_precision), \
            TO_CHAR(col.data_scale), TO_CHAR(col.char_length), \
            col.char_used, col.nullable, tc.data_default_vc, com.comments \
     FROM user_tab_columns col \
     LEFT JOIN user_tab_cols tc \
       ON tc.table_name = col.table_name AND tc.column_name = col.column_name \
      AND tc.hidden_column = 'NO' \
     LEFT JOIN user_col_comments com \
       ON com.table_name = col.table_name AND com.column_name = col.column_name \
     WHERE col.table_name = :t \
     ORDER BY col.column_id";

const SQL_COLS_11G: &str = "SELECT col.column_name, col.data_type, \
            TO_CHAR(col.data_length), TO_CHAR(col.data_precision), \
            TO_CHAR(col.data_scale), TO_CHAR(col.char_length), \
            col.char_used, col.nullable, NULL, com.comments \
     FROM user_tab_columns col \
     LEFT JOIN user_col_comments com \
       ON com.table_name = col.table_name AND com.column_name = col.column_name \
     WHERE col.table_name = :t \
     ORDER BY col.column_id";

/* —— 跨方案兜底：user_* 只看自己的对象，别的 schema 的表靠同义词 / 授权
   查询跑得通（SELECT 不报 ORA-00942）、列却查不到——UPDATE/INSERT 因此
   报「除主键外没有可改的字段」。all_* 字典 + owner 解析补上这一截。 —— */

const SQL_OWNER_PRIVATE_SYN: &str =
    "SELECT table_owner FROM user_synonyms WHERE table_name = :t AND table_owner IS NOT NULL";

const SQL_OWNER_PUBLIC_SYN: &str =
    "SELECT table_owner FROM all_synonyms WHERE owner = 'PUBLIC' AND table_name = :t \
     AND table_owner IS NOT NULL";

/** 没有同义词指向时的最后手段：同名表只有一个 owner 才可信；多个时取字典序
   （确定性；真撞名又没同义词的场景，用户看到的表名本来也不带 owner 前缀） */
const SQL_OWNER_DISTINCT: &str = "SELECT DISTINCT owner FROM all_tab_columns WHERE table_name = :t";

const SQL_IDENTITY_ALL: &str =
    "SELECT column_name FROM all_tab_identity_cols WHERE owner = :o AND table_name = :t";

const SQL_KEYS_ALL: &str = "SELECT cc.column_name, c.constraint_type, c.constraint_name \
     FROM all_constraints c \
     JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name \
     WHERE c.owner = :o AND c.table_name = :t AND c.constraint_type IN ('P', 'U')";

const SQL_IDX_ALL: &str = "SELECT ic.column_name, i.index_name \
     FROM all_indexes i \
     JOIN all_ind_columns ic \
       ON ic.index_owner = i.owner AND ic.index_name = i.index_name AND ic.table_name = i.table_name \
     WHERE i.owner = :o AND i.table_name = :t AND i.uniqueness = 'NONUNIQUE' AND i.index_type = 'NORMAL'";

const SQL_COLS_ALL_12C: &str = "SELECT col.column_name, col.data_type, \
            TO_CHAR(col.data_length), TO_CHAR(col.data_precision), \
            TO_CHAR(col.data_scale), TO_CHAR(col.char_length), \
            col.char_used, col.nullable, tc.data_default_vc, com.comments \
     FROM all_tab_columns col \
     LEFT JOIN all_tab_cols tc \
       ON tc.owner = col.owner AND tc.table_name = col.table_name \
      AND tc.column_name = col.column_name AND tc.hidden_column = 'NO' \
     LEFT JOIN all_col_comments com \
       ON com.owner = col.owner AND com.table_name = col.table_name \
      AND com.column_name = col.column_name \
     WHERE col.owner = :o AND col.table_name = :t \
     ORDER BY col.column_id";

const SQL_COLS_ALL_11G: &str = "SELECT col.column_name, col.data_type, \
            TO_CHAR(col.data_length), TO_CHAR(col.data_precision), \
            TO_CHAR(col.data_scale), TO_CHAR(col.char_length), \
            col.char_used, col.nullable, NULL, com.comments \
     FROM all_tab_columns col \
     LEFT JOIN all_col_comments com \
       ON com.owner = col.owner AND com.table_name = col.table_name \
      AND com.column_name = col.column_name \
     WHERE col.owner = :o AND col.table_name = :t \
     ORDER BY col.column_id";

/// 统一成「行列字符串」，两路驱动各实现一遍取单元格。
fn thin_rows(conn: &oracledb::Connection, sql: &str, ncols: usize) -> Result<Vec<Vec<Option<String>>>, String> {
    let cursor = conn.query(sql, &[]).map_err(map_err)?;
    let mut out = Vec::new();
    for row in cursor {
        let row = row.map_err(map_err)?;
        out.push((0..ncols).map(|i| thin_cell(&row, i)).collect());
    }
    Ok(out)
}

fn thin_rows_named(
    conn: &oracledb::Connection,
    sql: &str,
    val: &str,
    ncols: usize,
) -> Result<Vec<Vec<Option<String>>>, String> {
    let t = val.to_string();
    let cursor = conn.query_named(sql, &[("t", &t)]).map_err(map_err)?;
    let mut out = Vec::new();
    for row in cursor {
        let row = row.map_err(map_err)?;
        out.push((0..ncols).map(|i| thin_cell(&row, i)).collect());
    }
    Ok(out)
}

/// 双绑定版（:o = owner，:t = table）。跨方案 all_* 字典查询要用。
fn thin_rows_named2(
    conn: &oracledb::Connection,
    sql: &str,
    owner: &str,
    table: &str,
    ncols: usize,
) -> Result<Vec<Vec<Option<String>>>, String> {
    let (o, t) = (owner.to_string(), table.to_string());
    let cursor = conn.query_named(sql, &[("o", &o), ("t", &t)]).map_err(map_err)?;
    let mut out = Vec::new();
    for row in cursor {
        let row = row.map_err(map_err)?;
        out.push((0..ncols).map(|i| thin_cell(&row, i)).collect());
    }
    Ok(out)
}

fn thick_rows(conn: &oci::Connection, sql: &str, ncols: usize) -> Result<Vec<Vec<Option<String>>>, String> {
    let rows = conn.query(sql, &[]).map_err(map_err)?;
    let mut out = Vec::new();
    for row in rows {
        let row = row.map_err(map_err)?;
        out.push((0..ncols).map(|i| thick_cell(&row, i)).collect());
    }
    Ok(out)
}

fn thick_rows_named(
    conn: &oci::Connection,
    sql: &str,
    val: &str,
    ncols: usize,
) -> Result<Vec<Vec<Option<String>>>, String> {
    let t = val.to_string();
    let rows = conn.query_named(sql, &[("t", &t)]).map_err(map_err)?;
    let mut out = Vec::new();
    for row in rows {
        let row = row.map_err(map_err)?;
        out.push((0..ncols).map(|i| thick_cell(&row, i)).collect());
    }
    Ok(out)
}

fn thick_rows_named2(
    conn: &oci::Connection,
    sql: &str,
    owner: &str,
    table: &str,
    ncols: usize,
) -> Result<Vec<Vec<Option<String>>>, String> {
    let (o, t) = (owner.to_string(), table.to_string());
    let rows = conn.query_named(sql, &[("o", &o), ("t", &t)]).map_err(map_err)?;
    let mut out = Vec::new();
    for row in rows {
        let row = row.map_err(map_err)?;
        out.push((0..ncols).map(|i| thick_cell(&row, i)).collect());
    }
    Ok(out)
}

impl Backend {
    fn rows(&self, sql: &str, ncols: usize) -> Result<Vec<Vec<Option<String>>>, String> {
        match self {
            Backend::Thin(c) => thin_rows(c, sql, ncols),
            Backend::Thick(c) => thick_rows(c, sql, ncols),
        }
    }

    fn rows_named(&self, sql: &str, val: &str, ncols: usize) -> Result<Vec<Vec<Option<String>>>, String> {
        match self {
            Backend::Thin(c) => thin_rows_named(c, sql, val, ncols),
            Backend::Thick(c) => thick_rows_named(c, sql, val, ncols),
        }
    }

    fn rows_named2(&self, sql: &str, owner: &str, table: &str, ncols: usize) -> Result<Vec<Vec<Option<String>>>, String> {
        match self {
            Backend::Thin(c) => thin_rows_named2(c, sql, owner, table, ncols),
            Backend::Thick(c) => thick_rows_named2(c, sql, owner, table, ncols),
        }
    }

    fn version(&self) -> String {
        match self {
            Backend::Thin(c) => c.version().map(|v| format!("{v}")).unwrap_or_else(|_| "?".into()),
            Backend::Thick(c) => c
                .server_version()
                .map(|(v, _)| v.to_string())
                .unwrap_or_else(|_| "?".into()),
        }
    }
}

fn query_tables(conn: &Backend) -> Result<Vec<TableRow>, String> {
    let raw = match conn.rows(SQL_TABLES, 2) {
        Ok(r) => r,
        Err(_) => conn.rows(SQL_TABLES_BASIC, 2)?,
    };
    Ok(raw
        .into_iter()
        .map(|r| TableRow {
            tname: r.first().cloned().flatten(),
            tcmt: r.get(1).cloned().flatten(),
        })
        .collect())
}

fn query_counts(conn: &Backend) -> Result<Vec<CountRow>, String> {
    Ok(conn
        .rows(SQL_COUNTS, 2)?
        .into_iter()
        .map(|r| CountRow {
            tname: r.first().cloned().flatten(),
            n: r.get(1).cloned().flatten(),
        })
        .collect())
}

fn query_fks(conn: &Backend) -> Result<Vec<FkRow>, String> {
    Ok(conn
        .rows(SQL_FKS, 5)?
        .into_iter()
        .map(|r| FkRow {
            cname: r.first().cloned().flatten(),
            ftbl: r.get(1).cloned().flatten(),
            fcol: r.get(2).cloned().flatten(),
            ttbl: r.get(3).cloned().flatten(),
            tcol: r.get(4).cloned().flatten(),
        })
        .collect())
}

fn query_identity(conn: &Backend, table: &str) -> HashSet<String> {
    let Ok(raw) = conn.rows_named(SQL_IDENTITY, table, 1) else {
        return HashSet::new();
    };
    raw.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect()
}

#[derive(Default)]
struct KeyFlags {
    pk: HashSet<String>,
    uniq: HashSet<String>,
    idx: HashSet<String>,
}

/// 约束 / 索引行 → 主键、单列唯一键、单列普通索引三个集合。
/// user_* 和 all_* 两路查询共用这套解析。
fn parse_keys(raw: Vec<Vec<Option<String>>>, idx_raw: Option<Vec<Vec<Option<String>>>>) -> KeyFlags {
    let mut pk = HashSet::new();
    let mut uniq_cols: HashMap<String, Vec<String>> = HashMap::new();
    for r in raw {
        let col = r.first().cloned().flatten();
        let Some(col) = col else { continue };
        let kind = r.get(1).cloned().flatten().unwrap_or_default();
        let cname = r.get(2).cloned().flatten().unwrap_or_default();
        if kind == "P" {
            pk.insert(col);
        } else if kind == "U" {
            uniq_cols.entry(cname).or_default().push(col);
        }
    }
    let mut uniq = HashSet::new();
    for cols in uniq_cols.into_values() {
        if cols.len() == 1 {
            if let Some(c) = cols.into_iter().next() {
                if !pk.contains(&c) {
                    uniq.insert(c);
                }
            }
        }
    }

    // 普通索引单独查；失败不挡拉列（老库/权限不够时索引只是排序提示）
    let mut idx = HashSet::new();
    if let Some(raw) = idx_raw {
        let mut by_index: HashMap<String, Vec<String>> = HashMap::new();
        for r in raw {
            let col = r.first().cloned().flatten();
            let Some(col) = col else { continue };
            let iname = r.get(1).cloned().flatten().unwrap_or_default();
            by_index.entry(iname).or_default().push(col);
        }
        for cols in by_index.into_values() {
            if cols.len() == 1 {
                if let Some(c) = cols.into_iter().next() {
                    if !pk.contains(&c) && !uniq.contains(&c) {
                        idx.insert(c);
                    }
                }
            }
        }
    }

    KeyFlags { pk, uniq, idx }
}

fn query_keys(conn: &Backend, table: &str) -> Result<KeyFlags, String> {
    let raw = conn.rows_named(SQL_KEYS, table, 3)?;
    let idx_raw = conn.rows_named(SQL_IDX, table, 2).ok();
    Ok(parse_keys(raw, idx_raw))
}

fn fetch_catalog(conn: &Backend) -> Result<Catalog, String> {
    Ok(Catalog {
        version: conn.version(),
        tables: query_tables(conn)?,
        counts: query_counts(conn)?,
        fks: query_fks(conn)?,
    })
}

/// 列字典行 + 主键/唯一/索引/自增集合 → ColRow。user_* / all_* 两路共用。
fn build_col_rows(
    raw: Vec<Vec<Option<String>>>,
    ident: &HashSet<String>,
    keys: &KeyFlags,
) -> Vec<ColRow> {
    raw.into_iter()
        .map(|r| {
            let cname = r.first().cloned().flatten();
            let ident_flag = cname.as_ref().is_some_and(|c| ident.contains(c));
            let pk_flag = cname.as_ref().is_some_and(|c| keys.pk.contains(c));
            let uniq_flag = cname.as_ref().is_some_and(|c| keys.uniq.contains(c));
            let idx_flag = cname.as_ref().is_some_and(|c| keys.idx.contains(c));
            ColRow {
                cname,
                dtype: r.get(1).cloned().flatten(),
                dlen: r.get(2).cloned().flatten(),
                dprec: r.get(3).cloned().flatten(),
                dscale: r.get(4).cloned().flatten(),
                clen: r.get(5).cloned().flatten(),
                cused: r.get(6).cloned().flatten(),
                cnull: r.get(7).cloned().flatten(),
                cdef: r.get(8).cloned().flatten(),
                ccmt: r.get(9).cloned().flatten(),
                ident: yn(ident_flag),
                pk: yn(pk_flag),
                uniq: yn(uniq_flag),
                idx: yn(idx_flag),
            }
        })
        .collect()
}

fn fetch_columns(conn: &Backend, table: &str) -> Result<Vec<ColRow>, String> {
    let ident = query_identity(conn, table);
    let keys = query_keys(conn, table)?;
    let raw = match conn.rows_named(SQL_COLS_12C, table, 10) {
        Ok(rows) => rows,
        Err(_) => conn.rows_named(SQL_COLS_11G, table, 10)?,
    };
    let out = build_col_rows(raw, &ident, &keys);
    if !out.is_empty() {
        return Ok(out);
    }
    // 当前用户 schema 里没有这张表的列定义，但 SELECT 又跑得通——表在别的
    // 方案里，靠同义词 / 授权可见。user_* 字典永远查不到它，改走 all_*。
    fetch_columns_other_schema(conn, table)
}

/// 解析跨方案表的 owner：私有同义词 → PUBLIC 同义词 → all_tab_columns 唯一 owner。
fn resolve_owner(conn: &Backend, table: &str) -> Option<String> {
    for sql in [SQL_OWNER_PRIVATE_SYN, SQL_OWNER_PUBLIC_SYN, SQL_OWNER_DISTINCT] {
        let Ok(rows) = conn.rows_named(sql, table, 1) else { continue };
        let owners: Vec<String> = rows
            .into_iter()
            .filter_map(|r| r.into_iter().next().flatten())
            .collect();
        if let Some(o) = owners.into_iter().min() {
            return Some(o);
        }
    }
    None
}

fn fetch_columns_other_schema(conn: &Backend, table: &str) -> Result<Vec<ColRow>, String> {
    let Some(owner) = resolve_owner(conn, table) else {
        return Ok(Vec::new());
    };
    let ident: HashSet<String> = conn
        .rows_named2(SQL_IDENTITY_ALL, &owner, table, 1)
        .map(|raw| raw.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect())
        .unwrap_or_default();
    let keys_raw = conn.rows_named2(SQL_KEYS_ALL, &owner, table, 3)?;
    let idx_raw = conn.rows_named2(SQL_IDX_ALL, &owner, table, 2).ok();
    let keys = parse_keys(keys_raw, idx_raw);
    let raw = match conn.rows_named2(SQL_COLS_ALL_12C, &owner, table, 10) {
        Ok(rows) => rows,
        Err(_) => conn.rows_named2(SQL_COLS_ALL_11G, &owner, table, 10)?,
    };
    Ok(build_col_rows(raw, &ident, &keys))
}

fn init_thick() -> Result<(), String> {
    if oci::InitParams::is_initialized() {
        return Ok(());
    }
    let mut p = oci::InitParams::new();
    if let Some(dir) = find_oci_dir() {
        p.oracle_client_lib_dir(&dir).map_err(map_err)?;
        let admin = dir.join("network").join("admin");
        if admin.is_dir() {
            let _ = p.oracle_client_config_dir(admin);
        }
    }
    if let Ok(tns) = std::env::var("TNS_ADMIN") {
        if !tns.is_empty() {
            let _ = p.oracle_client_config_dir(tns);
        }
    }
    p.init().map(|_| ()).map_err(map_err)
}

fn open_thin(host: &str, port: &str, user: &str, password: &str, service: &str) -> Result<oracledb::Connection, String> {
    let ez = connect_string(host, port, service);
    let config = oracledb::Config::default()
        .set_credentials(user.trim(), password)
        .set_connect_string(&ez)
        .map_err(map_err)?
        .set_driver_name("CHUJU SQL");
    let conn = oracledb::connect(config).map_err(map_err)?;
    let _ = conn.set_call_timeout(Some(Duration::from_secs(CALL_TIMEOUT_SECS)));
    Ok(conn)
}

fn open_thick(host: &str, port: &str, user: &str, password: &str, service: &str) -> Result<oci::Connection, String> {
    init_thick()?;
    let ez = connect_string(host, port, service);
    oci::Connection::connect(user.trim(), password, &ez).map_err(map_err)
}

fn open_conn(host: &str, port: &str, user: &str, password: &str, service: &str) -> Result<Backend, String> {
    let svc = service.trim();
    let needs_host = !svc.starts_with('(') && !svc.contains('/');
    if host.trim().is_empty() && needs_host {
        return Err(
            "请填写主机。服务名填 SERVICE_NAME（如 ORCLPDB1）；只有 SID 写成 :ORCL。DBeaver 的 TNS 别名不能单独填。"
                .into(),
        );
    }
    match open_thin(host, port, user, password, service) {
        Ok(c) => Ok(Backend::Thin(c)),
        Err(e) if should_try_thick(&e) => match open_thick(host, port, user, password, service) {
            Ok(c) => Ok(Backend::Thick(c)),
            Err(_) if is_thin_version_rejected(&e) => Err(MSG_NEED_CLIENT.into()),
            Err(thick) => Err(thick),
        },
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn oracle_connect(
    state: State<'_, OracleState>,
    host: String,
    port: String,
    user: String,
    password: String,
    service: String,
) -> Result<Catalog, String> {
    let slot = Arc::clone(&state.conn);
    tauri::async_runtime::spawn_blocking(move || {
        let new_conn = open_conn(&host, &port, &user, &password, &service)?;
        let catalog = fetch_catalog(&new_conn)?;
        let mut guard = lock(&slot)?;
        if let Some(old) = guard.take() {
            close_backend(old);
        }
        *guard = Some(new_conn);
        Ok(catalog)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn oracle_columns(state: State<'_, OracleState>, table: String) -> Result<Vec<ColRow>, String> {
    let slot = Arc::clone(&state.conn);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock(&slot)?;
        let conn = guard
            .as_ref()
            .ok_or_else(|| "尚未连接，请先点「连接并读取」".to_string())?;
        fetch_columns(conn, table.trim())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn thin_query(conn: &oracledb::Connection, sql: &str, cap: usize) -> Result<QueryGrid, String> {
    let cursor = conn.query(sql, &[]).map_err(map_err)?;
    let columns: Vec<String> = cursor.columns().iter().map(|c| c.name().to_string()).collect();
    let ncols = columns.len();
    let mut rows = Vec::new();
    let mut truncated = false;
    for row in cursor {
        if rows.len() >= cap {
            truncated = true;
            break;
        }
        let row = row.map_err(map_err)?;
        rows.push((0..ncols).map(|i| thin_cell(&row, i).unwrap_or_default()).collect());
    }
    Ok(QueryGrid {
        columns,
        rows,
        truncated,
        cap,
    })
}

fn thick_query(conn: &oci::Connection, sql: &str, cap: usize) -> Result<QueryGrid, String> {
    let result = conn.query(sql, &[]).map_err(map_err)?;
    let columns: Vec<String> = result.column_info().iter().map(|c| c.name().to_string()).collect();
    let ncols = columns.len();
    let mut rows = Vec::new();
    let mut truncated = false;
    for row in result {
        if rows.len() >= cap {
            truncated = true;
            break;
        }
        let row = row.map_err(map_err)?;
        rows.push((0..ncols).map(|i| thick_cell(&row, i).unwrap_or_default()).collect());
    }
    Ok(QueryGrid {
        columns,
        rows,
        truncated,
        cap,
    })
}

#[tauri::command]
pub async fn oracle_query(
    state: State<'_, OracleState>,
    sql: String,
    load_all: bool,
) -> Result<QueryGrid, String> {
    assert_readonly_select(&sql)?;
    let cap = row_cap(load_all);
    let slot = Arc::clone(&state.conn);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock(&slot)?;
        match guard.as_ref() {
            Some(Backend::Thin(c)) => thin_query(c, sql.trim(), cap),
            Some(Backend::Thick(c)) => thick_query(c, sql.trim(), cap),
            None => Err("尚未连接，请先点「连接并读取」".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn thin_dml(conn: &oracledb::Connection, sql: &str) -> Result<u64, String> {
    let n = conn.execute(sql, &[]).map_err(map_err)?.rows_affected();
    conn.commit().map_err(map_err)?;
    Ok(n)
}

fn thick_dml(conn: &oci::Connection, sql: &str) -> Result<u64, String> {
    let stmt = conn.execute(sql, &[]).map_err(map_err)?;
    let n = stmt.row_count().map_err(map_err)?;
    conn.commit().map_err(map_err)?;
    Ok(n)
}

#[tauri::command]
pub async fn oracle_delete_rows(
    state: State<'_, OracleState>,
    sql: String,
) -> Result<DeleteResult, String> {
    assert_pk_delete(&sql)?;
    let slot = Arc::clone(&state.conn);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock(&slot)?;
        let n = match guard.as_ref() {
            Some(Backend::Thin(c)) => thin_dml(c, sql.trim())?,
            Some(Backend::Thick(c)) => thick_dml(c, sql.trim())?,
            None => return Err("尚未连接，请先点「连接并读取」".into()),
        };
        Ok(DeleteResult { affected: n })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn oracle_update_rows(
    state: State<'_, OracleState>,
    sql: String,
) -> Result<DeleteResult, String> {
    assert_pk_update(&sql)?;
    let slot = Arc::clone(&state.conn);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock(&slot)?;
        let n = match guard.as_ref() {
            Some(Backend::Thin(c)) => thin_dml(c, sql.trim())?,
            Some(Backend::Thick(c)) => thick_dml(c, sql.trim())?,
            None => return Err("尚未连接，请先点「连接并读取」".into()),
        };
        Ok(DeleteResult { affected: n })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn oracle_insert_rows(
    state: State<'_, OracleState>,
    sql: String,
) -> Result<DeleteResult, String> {
    assert_row_insert(&sql)?;
    let slot = Arc::clone(&state.conn);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock(&slot)?;
        let n = match guard.as_ref() {
            Some(Backend::Thin(c)) => thin_dml(c, sql.trim())?,
            Some(Backend::Thick(c)) => thick_dml(c, sql.trim())?,
            None => return Err("尚未连接，请先点「连接并读取」".into()),
        };
        Ok(DeleteResult { affected: n })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn oracle_exec_sql(
    state: State<'_, OracleState>,
    statements: Vec<String>,
) -> Result<ExecResult, String> {
    assert_gen_script(&statements)?;
    let slot = Arc::clone(&state.conn);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock(&slot)?;
        let mut affected = 0u64;
        let mut ran = 0u32;
        for (i, sql) in statements.iter().enumerate() {
            let n = match guard.as_ref() {
                Some(Backend::Thin(c)) => thin_dml(c, sql.trim()),
                Some(Backend::Thick(c)) => thick_dml(c, sql.trim()),
                None => return Err("尚未连接，请先点「连接并读取」".into()),
            };
            match n {
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
pub async fn oracle_exec_ddl(
    state: State<'_, OracleState>,
    statements: Vec<String>,
) -> Result<ExecResult, String> {
    assert_alter_script(&statements)?;
    let slot = Arc::clone(&state.conn);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock(&slot)?;
        let mut affected = 0u64;
        let mut ran = 0u32;
        for (i, sql) in statements.iter().enumerate() {
            let n = match guard.as_ref() {
                Some(Backend::Thin(c)) => thin_dml(c, sql.trim()),
                Some(Backend::Thick(c)) => thick_dml(c, sql.trim()),
                None => return Err("尚未连接，请先点「连接并读取」".into()),
            };
            match n {
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
pub async fn oracle_disconnect(state: State<'_, OracleState>) -> Result<(), String> {
    let slot = Arc::clone(&state.conn);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = lock(&slot)?;
        if let Some(old) = guard.take() {
            close_backend(old);
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{KeyFlags, build_col_rows, connect_string, parse_keys};
    use std::collections::HashSet;

    #[test]
    fn easy_connect_服务名() {
        assert_eq!(
            connect_string("10.0.0.8", "1521", "ORCLPDB1"),
            "10.0.0.8:1521/ORCLPDB1"
        );
    }

    #[test]
    fn sid_写成描述符_薄驱动才认() {
        let want = "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=10.0.0.8)(PORT=1521))(CONNECT_DATA=(SID=ORCL)))";
        assert_eq!(connect_string("10.0.0.8", "1521", ":ORCL"), want);
        assert_eq!(connect_string("ignored", "1521", "10.0.0.8:1521:ORCL"), want);
    }

    #[test]
    fn easy_connect_整段不包一层() {
        assert_eq!(
            connect_string("ignored", "1521", "db.corp.local:1521/prod"),
            "db.corp.local:1521/prod"
        );
        assert_eq!(
            connect_string(
                "localhost",
                "1521",
                "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=x)(PORT=1521)))"
            ),
            "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=x)(PORT=1521)))"
        );
    }

    #[test]
    fn 约束解析_主键单列唯一才打标() {
        let keys_raw = vec![
            vec![Some("ID".into()), Some("P".into()), Some("PK_T".into())],
            vec![Some("CODE".into()), Some("U".into()), Some("UK1".into())],
            vec![Some("NAME".into()), Some("U".into()), Some("UK2".into())],
            vec![Some("ADDR".into()), Some("U".into()), Some("UK2".into())],
        ];
        let idx_raw = vec![
            vec![Some("ADDR".into()), Some("IX_ADDR".into())],
            vec![Some("A".into()), Some("IX_AB".into())],
            vec![Some("B".into()), Some("IX_AB".into())],
        ];
        let k = parse_keys(keys_raw, Some(idx_raw));
        assert!(k.pk.contains("ID"));
        // 单列唯一键打标；UK2 是 NAME+ADDR 复合唯一，不打
        assert!(k.uniq.contains("CODE"));
        assert!(!k.uniq.contains("NAME") && !k.uniq.contains("ADDR"));
        // 单列普通索引打标；复合索引和已被唯一键占的列不打
        assert!(k.idx.contains("ADDR"));
        assert!(!k.idx.contains("A") && !k.idx.contains("B") && !k.idx.contains("CODE"));
    }

    #[test]
    fn 列行构建_标志位_与索引缺失的行() {
        let mut keys = KeyFlags::default();
        keys.pk.insert("ID".into());
        let raw = vec![
            vec![
                Some("ID".into()),
                Some("NUMBER".into()),
                Some("19".into()),
                None,
                None,
                None,
                None,
                Some("N".into()),
                None,
                Some("主键".into()),
            ],
            vec![Some("NOTE".into()), Some("VARCHAR2".into())], // 尾列缺失不炸
        ];
        let ident = HashSet::new();
        let rows = build_col_rows(raw, &ident, &keys);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].pk.as_deref(), Some("Y"));
        assert_eq!(rows[1].pk.as_deref(), Some("N"));
        assert_eq!(rows[1].dtype.as_deref(), Some("VARCHAR2"));
        assert_eq!(rows[1].ccmt, None);
    }
}
