//! 码上追的日志文件读取：Rust 只做字节级的活——开文件时一遍扫出「每行起始字节
//! 偏移」的索引，之后任意行区间按偏移 seek 直读原始字节。解码（UTF-8/GBK）交给
//! 前端 TextDecoder，Rust 不引编码库。大文件铁律：索引只存偏移，内容永不进内存。

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;

/// 本进程扫描过的日志文件。fileId 由这里发号，前端拿它读区间——路径只进不出，
/// 前端传不存在的 fileId 直接报错，拿任意路径来读是不可能的
static LOG_FILES: Mutex<Option<HashMap<u32, Arc<LogFileState>>>> = Mutex::new(None);

/// 下一个要发的 fileId。从 1 起，0 留着当「没打开」的哨兵
static NEXT_ID: Mutex<u32> = Mutex::new(1);

struct LogFileState {
    path: PathBuf,
    /// 每行起始字节偏移，升序；offsets[0] 恒为 0，末条是 EOF（文件长度）
    offsets: Vec<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFileMeta {
    pub file_id: u32,
    pub size_bytes: u64,
    pub total_lines: u64,
    /// 前端 TextDecoder 用：utf-8 / gbk
    pub encoding: String,
}

/// 编码采样判定：BOM 优先；没 BOM 拿首 64KB 试 UTF-8 合法性——合法按 utf-8，
/// 不合法十有八九是 GBK（政企老系统的中文日志）。采样尾部可能切在多字节字符中间，
/// 只是「尾巴不完整」的不算不合法
fn detect_encoding(path: &PathBuf) -> &'static str {
    let Ok(mut f) = File::open(path) else {
        return "utf-8";
    };
    let mut buf = vec![0u8; 64 * 1024];
    let Ok(n) = f.read(&mut buf) else {
        return "utf-8";
    };
    if n >= 3 && buf[0] == 0xEF && buf[1] == 0xBB && buf[2] == 0xBF {
        return "utf-8";
    }
    match std::str::from_utf8(&buf[..n]) {
        Ok(_) => "utf-8",
        // error_len() == None：只是尾部字符被采样边界截断，前面都合法
        Err(e) if e.error_len().is_none() => "utf-8",
        Err(_) => "gbk",
    }
}

fn scan_blocking(path: PathBuf) -> Result<LogFileMeta, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("打不开日志文件：{e}"))?;
    if !meta.is_file() {
        return Err("这不是一个普通文件（目录？）".to_string());
    }
    let encoding = detect_encoding(&path).to_string();
    let f = File::open(&path).map_err(|e| format!("打不开日志文件：{e}"))?;
    let mut reader = BufReader::with_capacity(1024 * 1024, f);
    // 按估算行数预留：GB 级文件千万行，反复扩容会把时间花在拷贝上
    let mut offsets: Vec<u64> = Vec::with_capacity((meta.len() / 120) as usize + 16);
    offsets.push(0);
    let mut pos: u64 = 0;
    // 整块找 \n，不逐行 read_until：那样每行一次堆分配，千万行就是千万次
    loop {
        let chunk = reader.fill_buf().map_err(|e| format!("读日志失败：{e}"))?;
        if chunk.is_empty() {
            break;
        }
        for (i, &b) in chunk.iter().enumerate() {
            if b == b'\n' {
                offsets.push(pos + i as u64 + 1);
            }
        }
        let n = chunk.len();
        pos += n as u64;
        reader.consume(n);
    }
    // 最后一行没有换行符也算一行
    if *offsets.last().unwrap_or(&0) != pos {
        offsets.push(pos);
    }
    offsets.shrink_to_fit();
    // offsets = [0, 行0 末, 行1 末, …, EOF]；行数 = len - 1。空文件 = [0] → 0 行
    let total_lines = (offsets.len() as u64).saturating_sub(1);
    let file_id = {
        let mut next = NEXT_ID.lock().map_err(|_| "发号器被占用".to_string())?;
        let id = *next;
        *next = next.wrapping_add(1).max(1);
        id
    };
    let mut guard = LOG_FILES.lock().map_err(|_| "日志表被占用".to_string())?;
    guard
        .get_or_insert_with(HashMap::new)
        .insert(file_id, Arc::new(LogFileState { path, offsets }));
    Ok(LogFileMeta { file_id, size_bytes: pos, total_lines, encoding })
}

fn slice_blocking(file_id: u32, start_line: u64, line_count: u32) -> Result<Vec<u8>, String> {
    // 只在拿引用时加锁，读盘在锁外：另一份文件的扫描 / 读取不用排队
    let st = {
        let guard = LOG_FILES.lock().map_err(|_| "日志表被占用".to_string())?;
        let map = guard.as_ref().ok_or("还没有打开过的日志文件")?;
        map.get(&file_id)
            .cloned()
            .ok_or("这份日志没打开过（或已关闭），重新打开一次")?
    };
    let lines_total = st.offsets.len() as u64 - 1;
    if start_line >= lines_total {
        return Ok(vec![]);
    }
    let end_line = std::cmp::min(start_line + line_count as u64, lines_total);
    let from = st.offsets[start_line as usize];
    let to = st.offsets[end_line as usize];
    let mut f = File::open(&st.path).map_err(|e| format!("重新打开日志失败：{e}"))?;
    f.seek(SeekFrom::Start(from)).map_err(|e| format!("定位日志失败：{e}"))?;
    let mut bytes = vec![0u8; (to - from) as usize];
    // 文件在扫描后被截断（日志轮转）时 read_exact 会报错：说人话让用户重开
    f.read_exact(&mut bytes)
        .map_err(|_| "文件在打开后被截断或轮转了，关掉重新打开一次".to_string())?;
    Ok(bytes)
}

#[tauri::command]
pub async fn log_file_scan(path: String) -> Result<LogFileMeta, String> {
    tauri::async_runtime::spawn_blocking(move || scan_blocking(PathBuf::from(path)))
        .await
        .map_err(|e| format!("任务调度失败：{e}"))?
}

/// 回原始字节（前端拿到 ArrayBuffer）。不走 JSON：Vec<u8> 序列化成数字数组体积
/// 翻三四倍，前端还要再拷一遍。行数 / 是否到头前端按 totalLines 自己算
#[tauri::command]
pub async fn log_file_slice(file_id: u32, start_line: u64, line_count: u32) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || slice_blocking(file_id, start_line, line_count))
        .await
        .map_err(|e| format!("任务调度失败：{e}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 关掉一份日志：释放行偏移索引（千万行就是 80MB）。不存在的 id 静默成功
#[tauri::command]
pub fn log_file_close(file_id: u32) -> Result<(), String> {
    let mut guard = LOG_FILES.lock().map_err(|_| "日志表被占用".to_string())?;
    if let Some(map) = guard.as_mut() {
        map.remove(&file_id);
    }
    Ok(())
}
