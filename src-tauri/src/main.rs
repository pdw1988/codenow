// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // SSH_ASKPASS 模式：码上追连服务器拉日志时，ssh 弹不出密码框，会拿
  // SSH_ASKPASS 指到的程序要密码——那个程序就是我们自己（log_ssh.rs 设的）。
  // 此时只把内存环境变量里的密码打到 stdout 立即退出，界面完全不启动，
  // 密码也不落盘。正常双击启动没有这个变量，走下面的完整应用。
  if std::env::var("CODENOW_ASKPASS").as_deref() == Ok("1") {
    use std::io::Write;
    if let Ok(pw) = std::env::var("CODENOW_SSH_SECRET") {
      print!("{pw}");
      let _ = std::io::stdout().flush();
    }
    return;
  }
  devtools_lib::run();
}
