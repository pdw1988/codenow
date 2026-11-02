use std::path::Path;

fn main() {
  // 有 pro/src-tauri 就编专业版（跟前端 vite.config.ts 同一套判断）：开源仓库 clone 下来直接能编，
  // 官方包不用额外开关。CODENOW_FREE=1 强制按开源版编，用来验证。
  println!("cargo::rustc-check-cfg=cfg(pro)");
  println!("cargo::rerun-if-changed=../pro/src-tauri");
  println!("cargo::rerun-if-env-changed=CODENOW_FREE");
  if Path::new("../pro/src-tauri").is_dir() && std::env::var_os("CODENOW_FREE").is_none() {
    println!("cargo::rustc-cfg=pro");
  }
  tauri_build::build()
}
