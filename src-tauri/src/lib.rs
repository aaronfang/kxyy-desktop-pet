mod api;

use std::fs;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    window::Monitor,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WindowEvent, Wry,
};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

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
    /// 目标显示器标识（Monitor::name()）。为 None 时表示"自动"，即跟随当前所在屏幕。
    #[serde(default)]
    monitor_id: Option<String>,

    // ---- AI 聊天相关（阶段 1）----
    /// DeepSeek 文字模型 Key。
    #[serde(default)]
    deepseek_key: String,
    /// 通义千问 VL（看图）Key。
    #[serde(default)]
    qwen_vl_key: String,
    /// 火山引擎（豆包）声音复刻 TTS Key（阶段 2·D：朗读）。
    #[serde(default)]
    volc_tts_key: String,
    /// 是否自动朗读元元的回复（阶段 2·D）。
    #[serde(default)]
    auto_speak: bool,
    /// 朗读音色 voice_id（火山复刻音色，S_ 开头）；空则无法朗读。
    #[serde(default)]
    tts_voice: String,
    /// 文字模型；空串表示自动（按 thinking 选 deepseek-chat / deepseek-reasoner）。
    #[serde(default)]
    text_model: String,
    /// 思考模式（deepseek-reasoner）。
    #[serde(default)]
    thinking: bool,
    /// 采样温度。
    #[serde(default = "default_temperature")]
    temperature: f64,
    /// 观众昵称（元元如何称呼你），空则默认「元宝」。
    #[serde(default)]
    user_name: String,

    // ---- 观众画像（每位用户自填，影响元元如何对待你）----
    /// 你和元元的关系。
    #[serde(default)]
    persona_relationship: String,
    /// 想让元元记住的事（多行，每行一条）。
    #[serde(default)]
    persona_facts: String,
    /// 你俩的暗号 / 梗（多行，每行一条）。
    #[serde(default)]
    persona_jokes: String,
    /// 希望元元怎么对待你。
    #[serde(default)]
    persona_treat_as: String,
    /// 对话时是否加载观众画像（把上面这些注入 system prompt）。
    #[serde(default = "default_true")]
    load_persona: bool,

    // ---- 头像与外观 ----
    /// AI（元元）头像 data URL；空则用内置默认。
    #[serde(default)]
    ai_avatar: String,
    /// 我的头像 data URL；空则用内置默认。
    #[serde(default)]
    user_avatar: String,
    /// 聊天气泡字号(px)。
    #[serde(default = "default_font_size")]
    chat_font_size: u32,

    /// 全局快捷键（toggle 聊天窗口）。
    #[serde(default = "default_hotkey")]
    hotkey: String,
    /// 聊天气泡窗口逻辑宽度(px)。
    #[serde(default = "default_chat_width")]
    chat_width: u32,
    /// 聊天气泡窗口逻辑高度(px)。
    #[serde(default = "default_chat_height")]
    chat_height: u32,
    /// 聊天窗口距工作区底部的逻辑偏移(px)。
    #[serde(default = "default_chat_bottom_offset")]
    chat_bottom_offset: u32,
}

fn default_temperature() -> f64 {
    0.8
}
fn default_true() -> bool {
    true
}
fn default_font_size() -> u32 {
    14
}
fn default_hotkey() -> String {
    "Ctrl+Shift+Space".to_string()
}
fn default_chat_width() -> u32 {
    420
}
fn default_chat_height() -> u32 {
    340
}
fn default_chat_bottom_offset() -> u32 {
    96
}

impl Settings {
    fn defaults() -> Self {
        let r = roster();
        Settings {
            pet_id: r.default_pet_id,
            size_percent: 150,
            hidden: false,
            monitor_id: None,
            deepseek_key: String::new(),
            qwen_vl_key: String::new(),
            volc_tts_key: String::new(),
            auto_speak: false,
            tts_voice: String::new(),
            text_model: String::new(),
            thinking: false,
            temperature: default_temperature(),
            user_name: String::new(),
            persona_relationship: String::new(),
            persona_facts: String::new(),
            persona_jokes: String::new(),
            persona_treat_as: String::new(),
            load_persona: true,
            ai_avatar: String::new(),
            user_avatar: String::new(),
            chat_font_size: default_font_size(),
            hotkey: default_hotkey(),
            chat_width: default_chat_width(),
            chat_height: default_chat_height(),
            chat_bottom_offset: default_chat_bottom_offset(),
        }
    }
}

struct AppState {
    settings: Mutex<Settings>,
    /// 本地 AI 代理监听端口。
    api_port: u16,
}

/// 供本地 HTTP 代理按需读取的 AI 配置快照。
pub(crate) struct AiConfig {
    pub deepseek_key: String,
    pub qwen_vl_key: String,
    pub text_model: String,
    pub thinking_default: bool,
    /// 火山 TTS Key（/api/tts 用）。
    pub volc_tts_key: String,
    /// 默认朗读音色（前端未显式指定 voice 时的兜底）。
    pub tts_voice: String,
}

pub(crate) fn ai_config(app: &AppHandle) -> AiConfig {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    AiConfig {
        deepseek_key: s.deepseek_key,
        qwen_vl_key: s.qwen_vl_key,
        text_model: s.text_model,
        thinking_default: s.thinking,
        volc_tts_key: s.volc_tts_key,
        tts_voice: s.tts_voice,
    }
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

    let chat_item = MenuItem::with_id(
        app,
        "toggle_chat",
        "聊天（Ctrl+Shift+Space）",
        true,
        None::<&str>,
    )?;
    let settings_item = MenuItem::with_id(app, "open_settings", "设置…", true, None::<&str>)?;

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

    let mut monitors = app
        .get_webview_window("main")
        .and_then(|w| w.available_monitors().ok())
        .unwrap_or_default();
    monitors.sort_by_key(|m| m.position().x);

    let monitor_menu = if monitors.len() > 1 {
        let menu = Submenu::new(app, "所在屏幕", true)?;
        let auto_item = CheckMenuItem::with_id(
            app,
            "monitor:auto",
            "自动（当前屏幕）",
            true,
            s.monitor_id.is_none(),
            None::<&str>,
        )?;
        menu.append(&auto_item)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        for (i, m) in monitors.iter().enumerate() {
            let name = match m.name() {
                Some(n) => n.clone(),
                None => continue,
            };
            let size = m.size();
            let label = format!("显示器 {} ({}×{})", i + 1, size.width, size.height);
            let checked = s.monitor_id.as_deref() == Some(name.as_str());
            let item = CheckMenuItem::with_id(
                app,
                format!("monitor:{name}"),
                &label,
                true,
                checked,
                None::<&str>,
            )?;
            menu.append(&item)?;
        }
        Some(menu)
    } else {
        None
    };

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
    menu.append(&chat_item)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&pet_menu)?;
    menu.append(&size_menu)?;
    if let Some(mm) = &monitor_menu {
        menu.append(mm)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&settings_item)?;
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

/// 根据用户选择的显示器标识解析出目标 Monitor；未选择或选择的显示器已不存在时，回退到当前所在屏幕。
fn resolve_monitor(win: &tauri::WebviewWindow, monitor_id: &Option<String>) -> Option<Monitor> {
    if let Some(id) = monitor_id {
        if let Ok(monitors) = win.available_monitors() {
            if let Some(m) = monitors
                .into_iter()
                .find(|m| m.name().map(|n| n == id).unwrap_or(false))
            {
                return Some(m);
            }
        }
    }
    win.current_monitor().ok().flatten()
}

/// 将主窗口铺满目标显示器的工作区（排除任务栏）。
fn apply_monitor_to_window(app: &AppHandle, monitor_id: &Option<String>) {
    if let Some(win) = app.get_webview_window("main") {
        if let Some(monitor) = resolve_monitor(&win, monitor_id) {
            let wa = monitor.work_area();
            let _ = win.set_position(PhysicalPosition::new(wa.position.x, wa.position.y));
            let _ = win.set_size(PhysicalSize::new(wa.size.width, wa.size.height));
        }
    }
}

/// 把聊天窗口按设置的尺寸定位到目标显示器工作区的「底部居中」。
fn position_chat_window(app: &AppHandle) {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    if let Some(win) = app.get_webview_window("chat") {
        if let Some(monitor) = resolve_monitor(&win, &s.monitor_id) {
            let wa = monitor.work_area();
            let sf = monitor.scale_factor();
            let w = (s.chat_width as f64 * sf).round() as u32;
            let h = (s.chat_height as f64 * sf).round() as u32;
            let offset = (s.chat_bottom_offset as f64 * sf).round() as i32;
            let x = wa.position.x + ((wa.size.width as i32 - w as i32) / 2);
            let y = wa.position.y + wa.size.height as i32 - h as i32 - offset;
            let _ = win.set_size(PhysicalSize::new(w, h));
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }
}

/// 切换聊天窗口显隐（全局快捷键与托盘共用）。
fn toggle_chat(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("chat") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            position_chat_window(app);
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

/// 打开（或聚焦）设置窗口。
fn open_settings_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 按当前设置里的快捷键重新注册全局热键（先全部注销再注册）。
fn re_register_hotkey(app: &AppHandle) {
    let hotkey = app.state::<AppState>().settings.lock().unwrap().hotkey.clone();
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    if let Ok(sc) = Shortcut::from_str(&hotkey) {
        let _ = gs.register(sc);
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
    apply_monitor_to_window(app, &snapshot.monitor_id);
    rebuild_tray(app);
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "quit" => app.exit(0),
        "toggle_hidden" => commit_settings(app, |s| s.hidden = !s.hidden),
        "toggle_chat" => toggle_chat(app),
        "open_settings" => open_settings_window(app),
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
            } else if let Some(mon) = other.strip_prefix("monitor:") {
                let monitor_id = if mon == "auto" {
                    None
                } else {
                    Some(mon.to_string())
                };
                commit_settings(app, move |s| s.monitor_id = monitor_id);
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

/// 返回本地 AI 代理的基址，前端聊天页据此发起 /api/chat 请求。
#[tauri::command]
fn get_api_base(state: tauri::State<AppState>) -> String {
    format!("http://127.0.0.1:{}", state.api_port)
}

#[tauri::command]
fn toggle_chat_window(app: AppHandle) {
    toggle_chat(&app);
}

#[tauri::command]
fn hide_chat(app: AppHandle) {
    if let Some(win) = app.get_webview_window("chat") {
        let _ = win.hide();
    }
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    open_settings_window(&app);
}

/// 设置页保存的 AI / 聊天相关配置。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSettingsInput {
    deepseek_key: String,
    qwen_vl_key: String,
    #[serde(default)]
    volc_tts_key: String,
    #[serde(default)]
    auto_speak: bool,
    #[serde(default)]
    tts_voice: String,
    text_model: String,
    thinking: bool,
    temperature: f64,
    user_name: String,
    #[serde(default)]
    persona_relationship: String,
    #[serde(default)]
    persona_facts: String,
    #[serde(default)]
    persona_jokes: String,
    #[serde(default)]
    persona_treat_as: String,
    #[serde(default = "default_true")]
    load_persona: bool,
    #[serde(default)]
    ai_avatar: String,
    #[serde(default)]
    user_avatar: String,
    #[serde(default = "default_font_size")]
    chat_font_size: u32,
    hotkey: String,
    chat_width: u32,
    chat_height: u32,
    chat_bottom_offset: u32,
}

/// 保存 AI / 聊天设置：持久化 + 通知聊天窗口热更新 + 重注册快捷键 + 重定位聊天窗口。
#[tauri::command]
fn set_ai_settings(app: AppHandle, settings: AiSettingsInput) {
    commit_settings(&app, |s| {
        s.deepseek_key = settings.deepseek_key.trim().to_string();
        s.qwen_vl_key = settings.qwen_vl_key.trim().to_string();
        s.volc_tts_key = settings.volc_tts_key.trim().to_string();
        s.auto_speak = settings.auto_speak;
        s.tts_voice = settings.tts_voice.trim().to_string();
        s.text_model = settings.text_model.trim().to_string();
        s.thinking = settings.thinking;
        s.temperature = settings.temperature;
        s.user_name = settings.user_name.trim().to_string();
        s.persona_relationship = settings.persona_relationship.trim().to_string();
        s.persona_facts = settings.persona_facts.trim().to_string();
        s.persona_jokes = settings.persona_jokes.trim().to_string();
        s.persona_treat_as = settings.persona_treat_as.trim().to_string();
        s.load_persona = settings.load_persona;
        s.ai_avatar = settings.ai_avatar;
        s.user_avatar = settings.user_avatar;
        s.chat_font_size = settings.chat_font_size.clamp(12, 22);
        let hk = settings.hotkey.trim();
        s.hotkey = if hk.is_empty() { default_hotkey() } else { hk.to_string() };
        s.chat_width = settings.chat_width.clamp(240, 900);
        s.chat_height = settings.chat_height.clamp(200, 900);
        s.chat_bottom_offset = settings.chat_bottom_offset.min(1200);
    });
    re_register_hotkey(&app);
    position_chat_window(&app);
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
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // 仅注册了聊天热键这一个，按下即 toggle 聊天窗口。
                    if event.state() == ShortcutState::Pressed {
                        toggle_chat(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = load_settings(&handle);

            // 先启动本地 AI 代理，拿到端口后随设置一起纳入全局状态。
            let api_port = api::start(handle.clone()).unwrap_or(0);
            app.manage(AppState {
                settings: Mutex::new(settings.clone()),
                api_port,
            });

            if let Some(win) = app.get_webview_window("main") {
                // 先显示以获取显示器信息，再根据设置定位到目标屏幕，铺满其工作区（排除任务栏）。
                win.show()?;
                apply_monitor_to_window(&handle, &settings.monitor_id);
                win.set_always_on_top(true)?;
                win.set_ignore_cursor_events(true)?;
                if settings.hidden {
                    win.hide()?;
                }
            }

            // 注册全局快捷键（toggle 聊天窗口）。
            re_register_hotkey(&handle);

            // 设置窗口默认点「关闭」按钮会销毁窗口，导致 get_webview_window("settings")
            // 返回 None、再次点「设置…」打不开。拦截关闭请求改为隐藏，保证可反复打开。
            if let Some(settings_win) = app.get_webview_window("settings") {
                let w = settings_win.clone();
                settings_win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
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
            show_menu,
            get_api_base,
            toggle_chat_window,
            hide_chat,
            open_settings,
            set_ai_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
