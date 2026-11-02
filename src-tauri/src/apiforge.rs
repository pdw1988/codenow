//! APIForge 的源码扫描命令，PRD v0.3 模块 4.1 / 技术方案 §2.1。
//!
//! Rust 只做两件事：把独立 Java 扫描器进程跑起来、把 stdout 原样交回；
//! 顺带把 stderr 上带 `PROG `/`ERR ` 前缀的进度行转发成 `apiforge-scan-log`
//! 事件（解析流水）。业务解析全在前端 lib/apiforge/scan/normalize.ts。

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// 扫描上限：大目录多工程留给 Java 侧的 MAX_FILES 兜底，这里只防进程卡死。
const SCAN_TIMEOUT: Duration = Duration::from_secs(180);

/// 当前扫描器进程号：apiforge_scan_stop 靠它终止用户点错的扫描。
static SCAN_PID: Mutex<Option<u32>> = Mutex::new(None);
/// 用户点了停止：stdout 收尾时用它区分「没输出」和「被停止」。
static SCAN_STOPPED: AtomicBool = AtomicBool::new(false);

/// 按 PID 杀进程树（扫描器是 java -jar，没有子进程要保）。页面测试关浏览器也用它。
pub(crate) fn kill_pid(pid: u32) {
    #[cfg(windows)]
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F", "/T"])
        .output();
    #[cfg(not(windows))]
    let _ = Command::new("kill").arg("-9").arg(pid.to_string()).output();
}

/// 找 spring-scanner.jar。两处候选按序试：打包资源、开发目录（都由 `pnpm scanner:sync` 写）。
/// 找不到要给中文报错 —— PRD 的纪律是「无 JDK / 无扫描器：UI 明确报错，不静默」。
///
/// **不要退回 `parsers/spring-scanner/target/spring-scanner.jar`**（曾经有这一条）。
/// 那是 Maven 直接构建出来的产物，退到它等于把「你忘了 scanner:sync」变成静默跑另一个
/// jar：用户改了 Java、`mvn package` 过，跑的却可能是 resources 里那份旧的，或者反过来，
/// 而界面上看不出在跑哪一个。两份 jar 谁新谁旧没人说得清 —— 只认 sync 写下的副本，
/// 缺了就报错让用户去 sync。
fn scanner_jar(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = app.path().resolve("resources/spring-scanner.jar", tauri::path::BaseDirectory::Resource) {
        if p.exists() {
            return Ok(p);
        }
    }
    // 开发模式：资源目录不在 target 旁边，直接用源码树里的副本
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/spring-scanner.jar");
    if dev.exists() {
        return Ok(dev);
    }
    Err("找不到扫描器 spring-scanner.jar。安装包不完整或还没同步：先 cd parsers/spring-scanner && mvn package -DskipTests，再跑 pnpm scanner:sync。".to_string())
}

/// 执行 java -jar。带超时：扫描器理论上会自己退出，但用户目录里有
/// 网络盘/死循环软链这类意外时，不能让 IPC 永远挂着。
fn scan_blocking(app: &tauri::AppHandle, root: String) -> Result<String, String> {
    use std::io::{BufRead, BufReader, Read};
    use std::process::Stdio;

    let jar = scanner_jar(app)?;
    let mut child = Command::new("java")
        .args(["-Dfile.encoding=UTF-8", "-jar"])
        .arg(&jar)
        .args(["--root", &root])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "本机没有可用的 java 命令。APIForge 扫描 Spring Boot 源码需要 JDK/JRE 8 及以上，请安装后重试。".to_string()
            } else {
                format!("启动扫描器失败: {e}")
            }
        })?;
    let pid = child.id();
    *SCAN_PID.lock().unwrap() = Some(pid);
    SCAN_STOPPED.store(false, Ordering::Relaxed);

    // stderr 进度流：逐行读，只转发带前缀的行。单独线程，
    // 否则 stderr 管道写满会反过来堵死扫描器（经典死锁）
    let stderr = child.stderr.take();
    let emitter = app.clone();
    let err_thread = std::thread::spawn(move || {
        if let Some(stderr) = stderr {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if line.starts_with("PROG ") || line.starts_with("ERR ") {
                    let _ = emitter.emit("apiforge-scan-log", line);
                }
            }
        }
    });

    // stdout 在另一个线程收整份 JSON，超时控制只等它
    let stdout = child.stdout.take();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(stdout) = stdout {
            let _ = BufReader::new(stdout).read_to_string(&mut buf);
        }
        let _ = tx.send(buf);
    });

    match rx.recv_timeout(SCAN_TIMEOUT) {
        Ok(stdout) => {
            if stdout.trim().is_empty() {
                let _ = child.kill();
                *SCAN_PID.lock().unwrap() = None;
                if SCAN_STOPPED.load(Ordering::Relaxed) {
                    return Err("已手动停止扫描".to_string());
                }
                return Err("扫描器没有输出。多半是 JVM 启动失败，见日志。".to_string());
            }
            let _ = child.wait();
            let _ = err_thread.join();
            *SCAN_PID.lock().unwrap() = None;
            Ok(stdout)
        }
        Err(_) => {
            // 超时杀进程。wait_with_output 那边拿不到输出就让它自己收尾
            let _ = child.kill();
            kill_pid(pid);
            *SCAN_PID.lock().unwrap() = None;
            Err("扫描超时（180 秒）。工程太大就选更精确的目录再试。".to_string())
        }
    }
}

/// 用户点「停止扫描」：杀掉当前扫描器进程。下一次扫描开始时状态会重置。
#[tauri::command]
pub async fn apiforge_scan_stop() -> Result<(), String> {
    let pid = SCAN_PID.lock().unwrap().take();
    match pid {
        Some(pid) => {
            SCAN_STOPPED.store(true, Ordering::Relaxed);
            kill_pid(pid);
            Ok(())
        }
        None => Err("当前没有正在进行的扫描".to_string()),
    }
}

#[tauri::command]
pub async fn apiforge_scan(app: tauri::AppHandle, root: String) -> Result<String, String> {
    // 扫描可能跑几十秒，丢进 blocking 线程池，别堵 async 运行时
    tauri::async_runtime::spawn_blocking(move || scan_blocking(&app, root))
        .await
        .map_err(|e| format!("扫描任务调度失败: {e}"))?
}
