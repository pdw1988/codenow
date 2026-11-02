mod apiforge;
#[cfg(pro)]
#[path = "../../pro/src-tauri/apiforge_vue.rs"]
mod apiforge_vue;
#[cfg(pro)]
#[path = "../../pro/src-tauri/apiforge_bench.rs"]
mod apiforge_bench;
mod apiforge_http;
mod cred;
#[cfg(desktop)]
mod desktop;
mod license;
mod log_file;
// 专业版模块在仓库根的 pro/（将来是私有子模块），有 pro/ 时才编译（build.rs 设 cfg(pro)）。
// 用 #[path] 引进来是为了 crate::log_ssh 这类路径不变。
#[cfg(pro)]
#[path = "../../pro/src-tauri/log_ssh.rs"]
mod log_ssh;
mod mysql;
#[cfg(pro)]
#[path = "../../pro/src-tauri/page_browser.rs"]
mod page_browser;
mod oracle;
mod postgres;
mod redis_client;
mod sqlite;
mod sql_readonly;
mod sql_write;
#[cfg(pro)]
#[path = "../../pro/src-tauri/sftp.rs"]
mod sftp;
#[cfg(pro)]
#[path = "../../pro/src-tauri/ssh_tunnel.rs"]
mod ssh_tunnel;
#[cfg(not(pro))]
#[path = "ssh_tunnel_free.rs"]
mod ssh_tunnel;
#[cfg(pro)]
#[path = "../../pro/src-tauri/terminal.rs"]
mod terminal;

/// 命令清单：有 pro/ 才把专业版命令接在后面。generate_handler! 里不能写 cfg，只好套一层宏。
#[cfg(pro)]
macro_rules! handlers {
    ($($free:tt)*) => {
        tauri::generate_handler![
            $($free)*
            log_ssh::log_ssh_start,
            log_ssh::log_ssh_read,
            log_ssh::log_ssh_finish,
            log_ssh::log_ssh_abort,
            terminal::terminal_start,
            terminal::terminal_read,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            sftp::sftp_start,
            sftp::sftp_check,
            sftp::sftp_cancel,
            apiforge_bench::apiforge_bench_start,
            apiforge_bench::apiforge_bench_stop,
            page_browser::page_browser_launch,
            page_browser::page_browser_close,
            apiforge_vue::apiforge_scan_vue,
        ]
    };
}
#[cfg(not(pro))]
macro_rules! handlers {
    ($($free:tt)*) => {
        tauri::generate_handler![$($free)*]
    };
}

use tauri_plugin_sql::{Migration, MigrationKind};

/// 缓存库的建表脚本，对应 PRD 6.3。
///
/// 与 PRD 的两处有意偏差，都是为了让骨架先跑通：
/// 1. cached_tables 的唯一键用 table_name 而非 (table_name, data_source)。
///    前端的 getTable(name) / deleteTable(name) 是按表名寻址的，允许同名表
///    来自两个数据源会让「查 user 表」变成一个有歧义的问题。等真有跨库同名
///    表的需求时，再把数据源引入寻址路径。
/// 2. 暂不建 FTS5 虚表。搜索目前在内存里做（见 src/lib/search.ts），50~100
///    张表规模下线性扫描是微秒级；等表数上千再引 FTS5，届时还要确认打包的
///    SQLite 是否启用了 fts5 编译选项。
const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS cached_tables (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name    TEXT NOT NULL UNIQUE,
  table_comment TEXT,
  java_class    TEXT,
  data_source   TEXT NOT NULL DEFAULT 'sql',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cached_columns (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id          INTEGER NOT NULL,
  ordinal           INTEGER NOT NULL,
  column_name       TEXT NOT NULL,
  column_type       TEXT NOT NULL,
  nullable          INTEGER NOT NULL DEFAULT 1,
  is_primary_key    INTEGER NOT NULL DEFAULT 0,
  is_auto_increment INTEGER NOT NULL DEFAULT 0,
  default_value     TEXT,
  column_comment    TEXT,
  java_field        TEXT,
  java_type         TEXT,
  FOREIGN KEY (table_id) REFERENCES cached_tables(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cached_foreign_keys (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_table      TEXT NOT NULL,
  from_column     TEXT NOT NULL,
  to_table        TEXT NOT NULL,
  to_column       TEXT NOT NULL,
  constraint_name TEXT,
  confidence      TEXT NOT NULL DEFAULT 'constraint',
  UNIQUE(from_table, from_column, to_table, to_column)
);

CREATE TABLE IF NOT EXISTS cache_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ordinal 决定字段展示顺序，按 table_id 查询后要保序，建复合索引
CREATE INDEX IF NOT EXISTS idx_columns_table ON cached_columns(table_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_fk_from ON cached_foreign_keys(from_table);
CREATE INDEX IF NOT EXISTS idx_fk_to ON cached_foreign_keys(to_table);
"#;

fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create schema cache tables",
            sql: SCHEMA_V1,
            kind: MigrationKind::Up,
        },
        // 老用户的 cache.db 已经按 v1 建好，不能改 SCHEMA_V1。单列 UNIQUE 标记
        // 给批量 INSERT 用：这类列必须连号，散列自动值会撞约束。
        Migration {
            version: 2,
            description: "cached_columns is_unique",
            sql: "ALTER TABLE cached_columns ADD COLUMN is_unique INTEGER NOT NULL DEFAULT 0;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "cached_columns is_indexed",
            sql: "ALTER TABLE cached_columns ADD COLUMN is_indexed INTEGER NOT NULL DEFAULT 0;",
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 自动更新（端点/公钥在 tauri.conf.json 的 plugins.updater）：
        // 检查和下载由前端发起，这里只负责把插件挂上；重启要靠 process 插件
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                // 路径不带盘符时，插件会落到 $APPDATA/<identifier>/ 下，
                // 即 PRD 要求的 %AppData%\DevTools\cache.db，用户无感知
                .add_migrations("sqlite:cache.db", migrations())
                .build(),
        )
        .manage(oracle::OracleState::new())
        .manage(mysql::MysqlState::new())
        .manage(postgres::PostgresState::new())
        .manage(sqlite::SqliteState::new())
        .manage(redis_client::RedisState::new())
        .invoke_handler(handlers![
            oracle::oracle_connect,
            oracle::oracle_disconnect,
            oracle::oracle_columns,
            oracle::oracle_query,
            oracle::oracle_delete_rows,
            oracle::oracle_update_rows,
            oracle::oracle_insert_rows,
            oracle::oracle_exec_sql,
            oracle::oracle_exec_ddl,
            mysql::mysql_connect,
            mysql::mysql_disconnect,
            mysql::mysql_columns,
            mysql::mysql_query,
            mysql::mysql_delete_rows,
            mysql::mysql_update_rows,
            mysql::mysql_insert_rows,
            mysql::mysql_exec_sql,
            mysql::mysql_exec_ddl,
            postgres::postgres_connect,
            postgres::postgres_disconnect,
            postgres::postgres_columns,
            postgres::postgres_query,
            postgres::postgres_delete_rows,
            postgres::postgres_update_rows,
            postgres::postgres_insert_rows,
            postgres::postgres_exec_sql,
            postgres::postgres_exec_ddl,
            sqlite::sqlite_connect,
            sqlite::sqlite_disconnect,
            sqlite::sqlite_columns,
            sqlite::sqlite_indexes,
            sqlite::sqlite_query,
            sqlite::sqlite_delete_rows,
            sqlite::sqlite_update_rows,
            sqlite::sqlite_insert_rows,
            sqlite::sqlite_exec_sql,
            sqlite::sqlite_exec_ddl,
            redis_client::redis_connect,
            redis_client::redis_disconnect,
            redis_client::redis_select,
            redis_client::redis_dbs,
            redis_client::redis_set_writable,
            redis_client::redis_scan,
            redis_client::redis_exec,
            redis_client::redis_delete_matching,
            license::license_verify,
            license::license_code_load,
            license::license_code_save,
            license::license_trial,
            apiforge::apiforge_scan,
            apiforge::apiforge_scan_stop,
            apiforge_http::apiforge_http,
            cred::cred_get,
            cred::cred_set,
            cred::cred_delete,
            log_file::log_file_scan,
            log_file::log_file_slice,
            log_file::log_file_close,
        ])
        .on_window_event(|window, event| {
            // 关主窗口 → 藏托盘。真正退出走托盘菜单「退出」。
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            #[cfg(desktop)]
            desktop::install(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
