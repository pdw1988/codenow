//! 开源版的许可防护占位。专业版的实现在 pro/src-tauri/license_guard.rs，接口一样。
//! 开源版没有专业版命令，也就没什么可拦；许可码一律验不过。

use tauri::{AppHandle, Runtime};

#[derive(Default)]
pub struct Gate;

pub const DENIED: &str = "";

pub fn pubkey() -> Option<[u8; 32]> {
    None
}

pub fn mirror_read<R: Runtime>(_app: &AppHandle<R>) -> Vec<String> {
    Vec::new()
}

pub fn mirror_write<R: Runtime>(_app: &AppHandle<R>, _json: &str) {}

pub fn set_licensed<R: Runtime>(_app: &AppHandle<R>, _on: bool) {}

pub fn set_trial<R: Runtime>(_app: &AppHandle<R>, _on: bool) {}

pub fn deny<R: Runtime>(_invoke: &tauri::ipc::Invoke<R>) -> bool {
    false
}
