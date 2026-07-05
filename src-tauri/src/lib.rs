mod api;
mod persona_assets;
mod realtime;
mod voice_service;

use std::fs;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    window::Monitor,
    AppHandle, Emitter, Manager, WindowEvent, Wry,
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

    // ---- 实时语音通话（火山端到端实时语音大模型 / RealtimeDialog）----
    /// 实时语音 App ID（火山「语音技术」应用 ID；与 TTS 的 x-api-key 不同）。
    #[serde(default)]
    realtime_app_id: String,
    /// 实时语音 Access Key（Access Token）。
    #[serde(default)]
    realtime_access_key: String,
    /// 旧版「通话音色」字段；已与 `tts_voice` 合并，读入时迁移后清空。
    #[serde(default)]
    realtime_voice: String,
    /// 语音后端（朗读 + 实时通话共用）：
    /// `volc` / `local`（Qwen3）/ `cosyvoice`（通义）/
    /// `cosyvoice3` / `indextts2`（Windows+NVIDIA 本地开源）。
    #[serde(default = "default_realtime_backend")]
    realtime_backend: String,
    /// CosyVoice 复刻音色 id（`cosyvoice-…`），仅 `realtimeBackend=cosyvoice` 时用。
    #[serde(default)]
    cosyvoice_voice: String,
    /// CosyVoice 模型，默认 `cosyvoice-v3.5-flash`（支持 instruction）。
    #[serde(default)]
    cosyvoice_model: String,
    /// Fun-CosyVoice3 本地权重目录。
    #[serde(default)]
    cosyvoice3_model_dir: String,
    /// FunAudioLLM/CosyVoice 源码目录（含 cosyvoice 包）。
    #[serde(default)]
    cosyvoice3_repo_dir: String,
    /// IndexTTS-2 本地权重目录（含 config.yaml）。
    #[serde(default)]
    index_tts2_model_dir: String,
    /// index-tts 源码目录。
    #[serde(default)]
    index_tts2_repo_dir: String,
    /// 本地零样本克隆参考音频路径（Qwen3 / CosyVoice3 / IndexTTS-2 共用）。
    #[serde(default)]
    local_ref_wav: String,
    /// 参考音频对应文案（可留空）。
    #[serde(default)]
    local_ref_text: String,
    /// AI 语音播放音量（0–200，100 = 原音量）；作用于朗读与实时通话下行。
    #[serde(default = "default_voice_volume")]
    voice_volume: u32,
    /// 是否在聊天 UI 显示语音调试信息（后端 / 合成进度）。
    #[serde(default = "default_true")]
    show_chat_debug: bool,
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
    /// 拍一拍提示文案；可用 {name}、{ai} 占位，空则用默认「{name}拍了拍{ai}」。
    #[serde(default)]
    pat_text: String,

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

fn default_realtime_backend() -> String {
    "volc".into()
}

fn default_voice_volume() -> u32 {
    100
}

/// 本地语音服务端口（scripts/local-realtime/）：WS 通话 + HTTP 朗读（port+100）。
const LOCAL_REALTIME_PORT: u16 = 9876; // Qwen3-TTS
const COSYVOICE_REALTIME_PORT: u16 = 9877; // CosyVoice 通义 API
const COSYVOICE3_REALTIME_PORT: u16 = 9878; // Fun-CosyVoice3 本地开源
const INDEXTTS2_REALTIME_PORT: u16 = 9879; // IndexTTS-2 本地开源
const LOCAL_TTS_HTTP_PORT: u16 = LOCAL_REALTIME_PORT + 100;
const COSYVOICE_TTS_HTTP_PORT: u16 = COSYVOICE_REALTIME_PORT + 100;
const COSYVOICE3_TTS_HTTP_PORT: u16 = COSYVOICE3_REALTIME_PORT + 100;
const INDEXTTS2_TTS_HTTP_PORT: u16 = INDEXTTS2_REALTIME_PORT + 100;
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
            realtime_app_id: String::new(),
            realtime_access_key: String::new(),
            realtime_voice: String::new(),
            realtime_backend: default_realtime_backend(),
            cosyvoice_voice: String::new(),
            cosyvoice_model: String::new(),
            cosyvoice3_model_dir: String::new(),
            cosyvoice3_repo_dir: String::new(),
            index_tts2_model_dir: String::new(),
            index_tts2_repo_dir: String::new(),
            local_ref_wav: String::new(),
            local_ref_text: String::new(),
            voice_volume: default_voice_volume(),
            show_chat_debug: true,
            text_model: String::new(),
            thinking: false,
            temperature: default_temperature(),
            user_name: String::new(),
            pat_text: String::new(),
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
    /// 本地实时语音 WS 桥接监听端口（0 表示未启动）。
    realtime_port: u16,
    /// 正在走「先刷长期记忆再退出」流程，避免托盘连点重复触发。
    quitting: AtomicBool,
}

/// 供本地 HTTP 代理按需读取的 AI 配置快照。
pub(crate) struct AiConfig {
    pub deepseek_key: String,
    pub qwen_vl_key: String,
    pub text_model: String,
    pub thinking_default: bool,
    /// 语音后端：`volc` / `local` / `cosyvoice` / `cosyvoice3` / `indextts2`。
    pub voice_backend: String,
    /// 火山 TTS Key（仅 volc）。
    pub volc_tts_key: String,
    /// 火山复刻音色（朗读与通话共用，S_ 开头）。
    pub tts_voice: String,
}

pub(crate) fn ai_config(app: &AppHandle) -> AiConfig {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    let backend = s.realtime_backend.trim().to_ascii_lowercase();
    let voice_backend = match backend.as_str() {
        "local" => "local".into(),
        "cosyvoice" | "cosy" => "cosyvoice".into(),
        "cosyvoice3" | "cosyvoice3-local" | "cv3" => "cosyvoice3".into(),
        "indextts2" | "index-tts2" | "itts2" => "indextts2".into(),
        _ => "volc".into(),
    };
    AiConfig {
        deepseek_key: s.deepseek_key,
        qwen_vl_key: s.qwen_vl_key,
        text_model: s.text_model,
        thinking_default: s.thinking,
        voice_backend,
        volc_tts_key: s.volc_tts_key,
        tts_voice: s.tts_voice,
    }
}

/// 本地语音后端的朗读 HTTP 端口（WS 端口 + 100）。
pub(crate) fn local_tts_http_port(backend: &str) -> Option<u16> {
    match backend.trim().to_ascii_lowercase().as_str() {
        "local" => Some(LOCAL_TTS_HTTP_PORT),
        "cosyvoice" | "cosy" => Some(COSYVOICE_TTS_HTTP_PORT),
        "cosyvoice3" | "cosyvoice3-local" | "cv3" => Some(COSYVOICE3_TTS_HTTP_PORT),
        "indextts2" | "index-tts2" | "itts2" => Some(INDEXTTS2_TTS_HTTP_PORT),
        _ => None,
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
            if let Ok(mut s) = serde_json::from_str::<Settings>(&raw) {
                // 旧版通话音色合并进朗读音色。
                if s.tts_voice.trim().is_empty() && !s.realtime_voice.trim().is_empty() {
                    s.tts_voice = s.realtime_voice.trim().to_string();
                }
                s.realtime_voice.clear();
                // macOS：GPU 本地后端回退到 Qwen3。
                #[cfg(target_os = "macos")]
                if matches!(s.realtime_backend.as_str(), "cosyvoice3" | "indextts2") {
                    s.realtime_backend = "local".into();
                }
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

/// 根据用户选择的显示器标识解析出目标 Monitor。
/// 未选择或选择的显示器已不存在时，依次回退：窗口当前屏 → 主屏 → 任一可用屏。
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
    win.current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten())
        .or_else(|| {
            win.available_monitors()
                .ok()
                .and_then(|ms| ms.into_iter().next())
        })
}

/// 把 Monitor::work_area（标注为物理像素）还原成逻辑坐标。
///
/// 必须用 **monitor.scale_factor()**（生成 work_area 时的同一个因子），不能用
/// window.scale_factor()。在部分 macOS Retina 上 monitor.scale_factor() 会误报为 1.0，
/// 此时 work_area 数值其实已是逻辑点；若再按窗口真实 sf=2 去除，舞台会被缩成半屏，
/// 桌宠看起来就像只在左上角活动。
fn work_area_logical(monitor: &Monitor) -> (f64, f64, f64, f64) {
    let wa = monitor.work_area();
    let sf = monitor.scale_factor().max(0.1);
    (
        wa.position.x as f64 / sf,
        wa.position.y as f64 / sf,
        wa.size.width as f64 / sf,
        wa.size.height as f64 / sf,
    )
}

/// 将主窗口铺满目标显示器的工作区（排除任务栏）。
/// 桌宠活动范围 = 该窗口客户区。
fn apply_monitor_to_window(app: &AppHandle, monitor_id: &Option<String>) {
    if let Some(win) = app.get_webview_window("main") {
        if let Some(monitor) = resolve_monitor(&win, monitor_id) {
            let (lx, ly, lw, lh) = work_area_logical(&monitor);
            // 避免 min/max 约束把尺寸锁在初始 800×600。
            let _ = win.set_min_size(None::<tauri::LogicalSize<f64>>);
            let _ = win.set_max_size(None::<tauri::LogicalSize<f64>>);
            let _ = win.set_position(tauri::LogicalPosition::new(lx, ly));
            let _ = win.set_size(tauri::LogicalSize::new(lw, lh));
            let _ = app.emit("stage-resized", ());
        }
    }
}

/// 把聊天窗口按设置的尺寸定位到目标显示器工作区的「底部居中」。
fn position_chat_window(app: &AppHandle) {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    if let Some(win) = app.get_webview_window("chat") {
        if let Some(monitor) = resolve_monitor(&win, &s.monitor_id) {
            let (lx, ly, lw, lh) = work_area_logical(&monitor);
            let w = s.chat_width as f64;
            let h = s.chat_height as f64;
            let offset = s.chat_bottom_offset as f64;
            let x = lx + (lw - w) / 2.0;
            let y = ly + lh - h - offset;
            let _ = win.set_size(tauri::LogicalSize::new(w, h));
            let _ = win.set_position(tauri::LogicalPosition::new(x, y));
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

/// 托盘「退出」：先通知 chat 窗口把未落盘的对话总结进长期记忆，再退出。
/// chat 完成后会 invoke `memory_flushed`；超时兜底，避免总结卡住导致退不出。
fn request_quit_with_memory_flush(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = app.emit("flush-memory-before-quit", ());
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(12));
        app2.exit(0);
    });
}

#[tauri::command]
fn memory_flushed(app: AppHandle) {
    if app.state::<AppState>().quitting.load(Ordering::SeqCst) {
        app.exit(0);
    }
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "quit" => request_quit_with_memory_flush(app),
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

/// 返回实时语音 WS 基址（ws://）。
/// `local` / `cosyvoice` 直连本机 Python 服务；否则走火山桥接端口。
#[tauri::command]
fn get_realtime_base(state: tauri::State<AppState>) -> String {
    let backend = state
        .settings
        .lock()
        .unwrap()
        .realtime_backend
        .trim()
        .to_ascii_lowercase();
    match backend.as_str() {
        "local" => format!("ws://127.0.0.1:{LOCAL_REALTIME_PORT}"),
        "cosyvoice" | "cosy" => format!("ws://127.0.0.1:{COSYVOICE_REALTIME_PORT}"),
        "cosyvoice3" | "cosyvoice3-local" | "cv3" => {
            format!("ws://127.0.0.1:{COSYVOICE3_REALTIME_PORT}")
        }
        "indextts2" | "index-tts2" | "itts2" => {
            format!("ws://127.0.0.1:{INDEXTTS2_REALTIME_PORT}")
        }
        _ if state.realtime_port == 0 => String::new(),
        _ => format!("ws://127.0.0.1:{}", state.realtime_port),
    }
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
    #[serde(default)]
    realtime_app_id: String,
    #[serde(default)]
    realtime_access_key: String,
    #[serde(default)]
    realtime_voice: String,
    #[serde(default = "default_realtime_backend")]
    realtime_backend: String,
    #[serde(default)]
    cosyvoice_voice: String,
    #[serde(default)]
    cosyvoice_model: String,
    #[serde(default)]
    cosyvoice3_model_dir: String,
    #[serde(default)]
    cosyvoice3_repo_dir: String,
    #[serde(default)]
    index_tts2_model_dir: String,
    #[serde(default)]
    index_tts2_repo_dir: String,
    #[serde(default)]
    local_ref_wav: String,
    #[serde(default)]
    local_ref_text: String,
    #[serde(default = "default_voice_volume")]
    voice_volume: u32,
    #[serde(default = "default_true")]
    show_chat_debug: bool,
    text_model: String,
    thinking: bool,
    temperature: f64,
    user_name: String,
    #[serde(default)]
    pat_text: String,
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

/// 前端用于按平台显示语音后端选项（macos / windows / linux）。
#[tauri::command]
fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

/// 保存 AI / 聊天设置：持久化 + 通知聊天窗口热更新 + 重注册快捷键 + 重定位聊天窗口。
#[tauri::command]
fn set_ai_settings(app: AppHandle, settings: AiSettingsInput) {
    commit_settings(&app, |s| {
        s.deepseek_key = settings.deepseek_key.trim().to_string();
        s.qwen_vl_key = settings.qwen_vl_key.trim().to_string();
        s.volc_tts_key = settings.volc_tts_key.trim().to_string();
        s.auto_speak = settings.auto_speak;
        // 朗读与通话共用音色；兼容旧配置里单独的 realtimeVoice。
        let mut voice = settings.tts_voice.trim().to_string();
        if voice.is_empty() {
            voice = settings.realtime_voice.trim().to_string();
        }
        s.tts_voice = voice;
        s.realtime_voice = String::new();
        s.realtime_app_id = settings.realtime_app_id.trim().to_string();
        s.realtime_access_key = settings.realtime_access_key.trim().to_string();
        let backend = settings.realtime_backend.trim().to_ascii_lowercase();
        s.realtime_backend = match backend.as_str() {
            "local" => "local".into(),
            "cosyvoice" | "cosy" => "cosyvoice".into(),
            "cosyvoice3" | "cosyvoice3-local" | "cv3" => "cosyvoice3".into(),
            "indextts2" | "index-tts2" | "itts2" => "indextts2".into(),
            _ => "volc".into(),
        };
        // macOS：不允许保存 GPU 本地后端，回退到 Qwen3。
        #[cfg(target_os = "macos")]
        if matches!(s.realtime_backend.as_str(), "cosyvoice3" | "indextts2") {
            s.realtime_backend = "local".into();
        }
        s.cosyvoice_voice = settings.cosyvoice_voice.trim().to_string();
        s.cosyvoice_model = settings.cosyvoice_model.trim().to_string();
        s.cosyvoice3_model_dir = settings.cosyvoice3_model_dir.trim().to_string();
        s.cosyvoice3_repo_dir = settings.cosyvoice3_repo_dir.trim().to_string();
        s.index_tts2_model_dir = settings.index_tts2_model_dir.trim().to_string();
        s.index_tts2_repo_dir = settings.index_tts2_repo_dir.trim().to_string();
        s.local_ref_wav = settings.local_ref_wav.trim().to_string();
        s.local_ref_text = settings.local_ref_text.trim().to_string();
        s.voice_volume = settings.voice_volume.min(200);
        s.show_chat_debug = settings.show_chat_debug;
        s.text_model = settings.text_model.trim().to_string();
        s.thinking = settings.thinking;
        s.temperature = settings.temperature;
        s.user_name = settings.user_name.trim().to_string();
        s.pat_text = settings.pat_text.trim().to_string();
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
    // 按所选语音后端自动拉起 / 切换本地 Python 服务。
    let backend = app
        .state::<AppState>()
        .settings
        .lock()
        .unwrap()
        .realtime_backend
        .clone();
    voice_service::ensure(&app, &backend);
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
        .plugin(tauri_plugin_dialog::init())
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
            // macOS：桌宠应用隐藏 Dock 图标，仅保留菜单栏托盘图标。
            // Accessory 策略在 dev 模式下同样生效，弥补 Info.plist(LSUIElement) 仅对打包产物生效的问题。
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let handle = app.handle().clone();
            let settings = load_settings(&handle);

            // 先启动本地 AI 代理，拿到端口后随设置一起纳入全局状态。
            let api_port = api::start(handle.clone()).unwrap_or(0);
            // 启动本地实时语音 WS 桥接：只提供密钥/音色，人设 system_role 由前端 start 消息带入。
            // 非火山后端时直接 Err，拒绝建连，确保不会消耗火山 token。
            let realtime_provider: realtime::ConfigProvider = std::sync::Arc::new(|app: &AppHandle| {
                let s = app.state::<AppState>().settings.lock().unwrap().clone();
                let backend = s.realtime_backend.trim().to_ascii_lowercase();
                if backend != "volc" {
                    return Err(
                        "当前语音后端为本地服务，不会连接火山（无 token 消耗）".into(),
                    );
                }
                // 朗读与通话共用 tts_voice。
                let speaker = s.tts_voice.trim().to_string();
                let app_id = s.realtime_app_id.trim().to_string();
                let access_key = s.realtime_access_key.trim().to_string();
                if app_id.is_empty() || access_key.is_empty() || !speaker.starts_with("S_") {
                    return Err(
                        "未配置火山语音（需 App ID、Access Key 与 S_ 开头的复刻音色）".into(),
                    );
                }
                Ok(realtime::RealtimeConfig {
                    app_id,
                    access_key,
                    speaker,
                })
            });
            let realtime_port = realtime::start(handle.clone(), realtime_provider).unwrap_or(0);
            app.manage(voice_service::VoiceServiceManager::new());
            app.manage(AppState {
                settings: Mutex::new(settings.clone()),
                api_port,
                realtime_port,
                quitting: AtomicBool::new(false),
            });
            // 启动时按已保存的语音后端自动拉起本地服务。
            voice_service::ensure(&handle, &settings.realtime_backend);

            if let Some(win) = app.get_webview_window("main") {
                // 先显示以获取显示器信息，再根据设置定位到目标屏幕，铺满其工作区（排除任务栏）。
                win.show()?;
                apply_monitor_to_window(&handle, &settings.monitor_id);
                // 尺寸异步落地后再次通知前端刷新边界（与 apply_monitor 内的即时 emit 互补）。
                let resized_handle = handle.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::Resized(_) = event {
                        let _ = resized_handle.emit("stage-resized", ());
                    }
                });
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
            get_realtime_base,
            toggle_chat_window,
            hide_chat,
            open_settings,
            set_ai_settings,
            get_platform,
            memory_flushed
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                voice_service::stop(app);
            }
        });
}
