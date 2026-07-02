use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Wry,
};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

// 角色清单在编译期嵌入，主进程托盘与前端共用同一份数据。
const ROSTER_JSON: &str = include_str!("../../shared/roster.json");

const SIZE_PRESETS: &[(u32, &str)] = &[
    (100, "小 (100%)"),
    (125, "中 (125%)"),
    (150, "大 (150%)"),
    (200, "超大 (200%)"),
];

#[derive(Debug, Clone, Deserialize)]
struct Pet {
    id: String,
    label: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Roster {
    default_pet_id: String,
    pets: Vec<Pet>,
}

fn roster() -> Roster {
    serde_json::from_str(ROSTER_JSON).expect("invalid roster.json")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    pet_id: String,
    size_percent: u32,
    hidden: bool,
}

impl Settings {
    fn defaults() -> Self {
        let r = roster();
        Settings {
            pet_id: r.default_pet_id,
            size_percent: 150,
            hidden: false,
        }
    }
}

struct AppState {
    settings: Mutex<Settings>,
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    if let Some(p) = settings_path(app) {
        if let Ok(raw) = fs::read_to_string(&p) {
            if let Ok(s) = serde_json::from_str::<Settings>(&raw) {
                return s;
            }
        }
    }
    Settings::defaults()
}

fn save_settings(app: &AppHandle, s: &Settings) {
    if let Some(p) = settings_path(app) {
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(s) {
            let _ = fs::write(p, json);
        }
    }
}

fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    let r = roster();

    let toggle = MenuItem::with_id(
        app,
        "toggle_hidden",
        if s.hidden { "显示桌宠" } else { "隐藏桌宠" },
        true,
        None::<&str>,
    )?;

    let pet_menu = Submenu::new(app, "选择形象", true)?;
    for p in &r.pets {
        let item = CheckMenuItem::with_id(
            app,
            format!("pet:{}", p.id),
            &p.label,
            true,
            p.id == s.pet_id,
            None::<&str>,
        )?;
        pet_menu.append(&item)?;
    }

    let size_menu = Submenu::new(app, "大小", true)?;
    for (val, label) in SIZE_PRESETS {
        let item = CheckMenuItem::with_id(
            app,
            format!("size:{}", val),
            *label,
            true,
            *val == s.size_percent,
            None::<&str>,
        )?;
        size_menu.append(&item)?;
    }

    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自启",
        true,
        autostart_enabled,
        None::<&str>,
    )?;

    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::new(app)?;
    menu.append(&toggle)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&pet_menu)?;
    menu.append(&size_menu)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&autostart)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&quit)?;
    Ok(menu)
}

fn rebuild_tray(app: &AppHandle) {
    if let Ok(menu) = build_tray_menu(app) {
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

fn apply_hidden_to_window(app: &AppHandle, hidden: bool) {
    if let Some(win) = app.get_webview_window("main") {
        if hidden {
            let _ = win.hide();
        } else {
            let _ = win.show();
        }
    }
}

fn commit_settings<F: FnOnce(&mut Settings)>(app: &AppHandle, f: F) {
    let snapshot = {
        let state = app.state::<AppState>();
        let mut s = state.settings.lock().unwrap();
        f(&mut s);
        s.clone()
    };
    save_settings(app, &snapshot);
    let _ = app.emit("apply-settings", &snapshot);
    apply_hidden_to_window(app, snapshot.hidden);
    rebuild_tray(app);
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "quit" => app.exit(0),
        "toggle_hidden" => commit_settings(app, |s| s.hidden = !s.hidden),
        "autostart" => {
            let mgr = app.autolaunch();
            if mgr.is_enabled().unwrap_or(false) {
                let _ = mgr.disable();
            } else {
                let _ = mgr.enable();
            }
            rebuild_tray(app);
        }
        other => {
            if let Some(pet_id) = other.strip_prefix("pet:") {
                let pet_id = pet_id.to_string();
                commit_settings(app, move |s| s.pet_id = pet_id);
            } else if let Some(size) = other.strip_prefix("size:") {
                if let Ok(v) = size.parse::<u32>() {
                    commit_settings(app, move |s| s.size_percent = v);
                }
            }
        }
    }
}

// ---- IPC 命令 ----

#[tauri::command]
fn get_settings(state: tauri::State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn set_ignore_cursor(window: tauri::WebviewWindow, ignore: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|e| e.to_string())
}

/// 返回光标相对本窗口内容区左上角的逻辑坐标（CSS 像素），供前端在穿透态做命中判定。
#[tauri::command]
fn cursor_pos(window: tauri::WebviewWindow) -> Result<(f64, f64), String> {
    let cur = window.cursor_position().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let sf = window.scale_factor().map_err(|e| e.to_string())?;
    Ok(((cur.x - pos.x as f64) / sf, (cur.y - pos.y as f64) / sf))
}

/// 右键桌宠时在光标处弹出上下文菜单（须在主线程执行）。
#[tauri::command]
fn show_menu(app: AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(win) = handle.get_webview_window("main") {
            if let Ok(menu) = build_tray_menu(&handle) {
                let _ = win.popup_menu(&menu);
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebView2（Windows）额外启动参数：本应用是单页、可信的本地内容，
    // 关闭站点隔离与多余后台服务可显著减少子进程数与内存占用（保留 GPU 以保证透明合成）。
    #[cfg(windows)]
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,IsolateOrigins,site-per-process,Translate,BackForwardCache,AutofillServerCommunication --disable-site-isolation-trials --renderer-process-limit=1 --disable-background-networking --disable-component-update --disable-breakpad --no-first-run --js-flags=--optimize-for-size",
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = load_settings(&handle);
            app.manage(AppState {
                settings: Mutex::new(settings.clone()),
            });

            if let Some(win) = app.get_webview_window("main") {
                // 先显示以获取显示器信息，再铺满工作区（排除任务栏）。
                win.show()?;
                if let Ok(Some(monitor)) = win.current_monitor() {
                    let wa = monitor.work_area();
                    win.set_position(PhysicalPosition::new(wa.position.x, wa.position.y))?;
                    win.set_size(PhysicalSize::new(wa.size.width, wa.size.height))?;
                }
                win.set_always_on_top(true)?;
                win.set_ignore_cursor_events(true)?;
                if settings.hidden {
                    win.hide()?;
                }
            }

            let menu = build_tray_menu(&handle)?;
            let mut builder = TrayIconBuilder::with_id("main")
                .tooltip("元元桌宠")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| handle_menu_event(app, event.id.as_ref()));
            if let Some(icon) = app.default_window_icon() {
                builder = builder.icon(icon.clone());
            }
            let _tray = builder.build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_ignore_cursor,
            cursor_pos,
            show_menu
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
