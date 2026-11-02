//! Windows 集成：全局快捷键 + 托盘（PRD §8）。
//!
//! - Ctrl+Shift+D：有窗则藏、藏着则拉到前台（最小化也算「藏着」）
//! - 点关闭：藏到托盘，不退出。托盘「退出」才真关
//! 右键「在资源管理器里查看表」和开机自启另做，这里不碰。

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, Runtime,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub fn toggle_main<R: Runtime>(app: &AppHandle<R>) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let visible = win.is_visible().unwrap_or(false);
    let minimized = win.is_minimized().unwrap_or(false);
    if visible && !minimized {
        let _ = win.hide();
        return;
    }
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

pub fn install(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();

    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("码上 CodeNow · Ctrl+Shift+D 呼出")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => toggle_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    let _ = tray.build(app)?;

    // 注册失败别让整个应用起不来——被别的软件占了键就只是没有全局呼出。
    let hotkey = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyD);
    if let Err(e) = app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }
                if shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyD) {
                    toggle_main(app);
                }
            })
            .build(),
    ) {
        log::warn!("全局快捷键插件没挂上：{e}");
        return Ok(());
    }
    if let Err(e) = handle.global_shortcut().register(hotkey) {
        log::warn!("Ctrl+Shift+D 注册失败（可能被占用）：{e}");
    }

    Ok(())
}
