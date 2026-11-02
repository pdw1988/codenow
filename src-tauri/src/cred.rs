//! 连接密码跨天保存。不进「我的连接」JSON，不进 cache.db。
//!
//! Windows：DPAPI 加密后写在 AppData（`db-pass.dpapi.json`），绑当前 Windows 用户。
//! 关进程、重启应用都还在。别人拷走文件解不开。
//! macOS：系统钥匙串（keyring）。
//! 生产连接前端不准调用 set。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const FILE: &str = "db-pass.dpapi.json";

#[derive(Serialize, Deserialize, Default)]
struct Store {
    v: u8,
    items: BTreeMap<String, String>,
}

fn check_target(target: &str) -> Result<&str, String> {
    let t = target.trim();
    if t.is_empty() || t.len() > 400 {
        return Err("凭据键不合法".into());
    }
    if t.bytes().any(|b| b < 32) {
        return Err("凭据键不合法".into());
    }
    Ok(t)
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(FILE))
}

fn load_store(app: &AppHandle) -> Result<Store, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(Store { v: 1, items: BTreeMap::new() });
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("凭据档损坏：{e}"))
}

fn save_store(app: &AppHandle, store: &Store) -> Result<(), String> {
    let path = store_path(app)?;
    let raw = serde_json::to_string(store).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

#[cfg(windows)]
mod protect {
    use std::ptr;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            data_in: *const DataBlob,
            descr: *const u16,
            optional_entropy: *const DataBlob,
            reserved: *mut core::ffi::c_void,
            prompt: *mut core::ffi::c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            data_in: *const DataBlob,
            descr: *mut *mut u16,
            optional_entropy: *const DataBlob,
            reserved: *mut core::ffi::c_void,
            prompt: *mut core::ffi::c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(h: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
    }

    pub fn seal(plain: &[u8]) -> Result<Vec<u8>, String> {
        let input = DataBlob {
            cb_data: plain.len() as u32,
            pb_data: plain.as_ptr() as *mut u8,
        };
        let mut output = DataBlob {
            cb_data: 0,
            pb_data: ptr::null_mut(),
        };
        let ok = unsafe {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("本机加密失败".into());
        }
        let out = unsafe { std::slice::from_raw_parts(output.pb_data, output.cb_data as usize) }.to_vec();
        unsafe {
            LocalFree(output.pb_data.cast());
        }
        Ok(out)
    }

    pub fn open(blob: &[u8]) -> Result<Vec<u8>, String> {
        let input = DataBlob {
            cb_data: blob.len() as u32,
            pb_data: blob.as_ptr() as *mut u8,
        };
        let mut output = DataBlob {
            cb_data: 0,
            pb_data: ptr::null_mut(),
        };
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("本机解密失败（换过 Windows 用户？）".into());
        }
        let out = unsafe { std::slice::from_raw_parts(output.pb_data, output.cb_data as usize) }.to_vec();
        unsafe {
            LocalFree(output.pb_data.cast());
        }
        Ok(out)
    }
}

#[cfg(not(windows))]
mod protect {
    use keyring::Entry;

    const SERVICE: &str = "chuju-sql";

    #[allow(dead_code)]
    pub fn seal(plain: &[u8]) -> Result<Vec<u8>, String> {
        // 非 Windows 不走 DPAPI 文件：钥匙串按条存，这里不该被调用。
        let _ = (plain, SERVICE);
        Err("请用钥匙串读写".into())
    }

    #[allow(dead_code)]
    pub fn open(blob: &[u8]) -> Result<Vec<u8>, String> {
        let _ = blob;
        Err("请用钥匙串读写".into())
    }

    pub fn keyring_get(target: &str) -> Result<Option<String>, String> {
        match Entry::new(SERVICE, target).map_err(|e| e.to_string())?.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn keyring_set(target: &str, password: &str) -> Result<(), String> {
        Entry::new(SERVICE, target)
            .map_err(|e| e.to_string())?
            .set_password(password)
            .map_err(|e| e.to_string())
    }

    pub fn keyring_delete(target: &str) -> Result<(), String> {
        match Entry::new(SERVICE, target)
            .map_err(|e| e.to_string())?
            .delete_credential()
        {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[tauri::command]
pub fn cred_get(app: AppHandle, target: String) -> Result<String, String> {
    let t = check_target(&target)?;
    #[cfg(not(windows))]
    {
        let _ = app;
        return Ok(protect::keyring_get(t)?.unwrap_or_default());
    }
    #[cfg(windows)]
    {
        let store = load_store(&app)?;
        let Some(b64) = store.items.get(t) else {
            return Ok(String::new());
        };
        let blob = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64)
            .map_err(|e| e.to_string())?;
        let plain = protect::open(&blob)?;
        String::from_utf8(plain).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn cred_set(app: AppHandle, target: String, password: String) -> Result<(), String> {
    let t = check_target(&target)?;
    let p = password.trim();
    if p.is_empty() {
        return Err("密码是空的".into());
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        return protect::keyring_set(t, p);
    }
    #[cfg(windows)]
    {
        let sealed = protect::seal(p.as_bytes())?;
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, sealed);
        let mut store = load_store(&app)?;
        store.v = 1;
        store.items.insert(t.to_string(), b64);
        save_store(&app, &store)
    }
}

#[tauri::command]
pub fn cred_delete(app: AppHandle, target: String) -> Result<(), String> {
    let t = check_target(&target)?;
    #[cfg(not(windows))]
    {
        let _ = app;
        return protect::keyring_delete(t);
    }
    #[cfg(windows)]
    {
        let mut store = load_store(&app)?;
        store.items.remove(t);
        save_store(&app, &store)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::protect;

    #[test]
    fn dpapi_roundtrip() {
        let sealed = protect::seal(b"chuju-test").expect("seal");
        let plain = protect::open(&sealed).expect("open");
        assert_eq!(plain, b"chuju-test");
    }
}
