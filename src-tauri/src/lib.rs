mod api;
mod local_text;
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
    /// `volc` / `local`（Qwen3）/ `cosyvoice`（通义）。
    #[serde(default = "default_realtime_backend")]
    realtime_backend: String,
    /// CosyVoice 复刻音色 id（`cosyvoice-…`），仅 `realtimeBackend=cosyvoice` 时用。
    #[serde(default)]
    cosyvoice_voice: String,
    /// CosyVoice 模型，默认 `cosyvoice-v3.5-flash`（支持 instruction）。
    #[serde(default)]
    cosyvoice_model: String,
    /// 本地零样本克隆参考音频路径（Qwen3 共用）。
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
    /// 文字服务商：`deepseek`（在线）/ `local`（本地 Ollama，离线可用）。
    #[serde(default = "default_text_provider")]
    text_provider: String,
    /// 本地文字模型 tag（Ollama），空则用推荐默认 `qwen3:14b`。
    #[serde(default)]
    local_text_model: String,
    /// 本地看图 VL 模型 tag（Ollama），空则用推荐默认 `minicpm-v:8b`。
    #[serde(default)]
    local_vl_model: String,
    /// 视觉模型服务商：`qwen`（在线通义千问）/ `local`（本地 Ollama VL）。
    #[serde(default = "default_vl_provider")]
    vl_provider: String,
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

    // ---- 人设卡 ----
    /// 当前加载的人格卡 ID（对应 persona-cards/<id>/ 目录）。
    /// 空字符串表示使用编译期嵌入的默认人设。
    #[serde(default)]
    persona_card_id: String,

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

fn default_text_provider() -> String {
    "deepseek".into()
}

fn default_vl_provider() -> String {
    "qwen".into()
}

fn default_voice_volume() -> u32 {
    100
}

/// 本地语音服务端口（scripts/local-realtime/）：WS 通话 + HTTP 朗读（port+100）。
/// 端口选择 19876-19877（>15000）以避开 Windows 动态端口范围（1024-15000），
/// 避免与系统临时客户端端口（如 RabbitMQ）冲突导致 WinError 10013。
const LOCAL_REALTIME_PORT: u16 = 19876; // Qwen3-TTS
const COSYVOICE_REALTIME_PORT: u16 = 19877; // CosyVoice 通义 API
const LOCAL_TTS_HTTP_PORT: u16 = LOCAL_REALTIME_PORT + 100;
const COSYVOICE_TTS_HTTP_PORT: u16 = COSYVOICE_REALTIME_PORT + 100;
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
            local_ref_wav: String::new(),
            local_ref_text: String::new(),
            voice_volume: default_voice_volume(),
            show_chat_debug: false,
            text_model: String::new(),
            text_provider: default_text_provider(),
            local_text_model: String::new(),
            local_vl_model: String::new(),
            vl_provider: default_vl_provider(),
            thinking: false,
            temperature: default_temperature(),
            user_name: String::new(),
            pat_text: String::new(),
            persona_relationship: String::new(),
            persona_facts: String::new(),
            persona_jokes: String::new(),
            persona_treat_as: String::new(),
            load_persona: true,
            persona_card_id: String::new(),
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

/// 持有托盘图标引用，防止 setup 结束后被 drop 移除。
#[allow(dead_code)]
struct TrayHolder(tauri::tray::TrayIcon<Wry>);

/// 供本地 HTTP 代理按需读取的 AI 配置快照。
pub(crate) struct AiConfig {
    pub deepseek_key: String,
    pub qwen_vl_key: String,
    pub text_model: String,
    /// 文字服务商：`deepseek` / `local`（Ollama）。
    pub text_provider: String,
    /// 本地文字模型 tag（Ollama），空则由 api.rs 兜底 `local_text::DEFAULT_MODEL`。
    pub local_text_model: String,
    /// 本地看图 VL 模型 tag（Ollama），空则由 api.rs 兜底默认 `minicpm-v:8b`。
    pub local_vl_model: String,
    /// 视觉模型服务商：`qwen`（在线）/ `local`（本地 Ollama VL）。
    pub vl_provider: String,
    pub thinking_default: bool,
    /// 语音后端：`volc` / `local` / `cosyvoice`。
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
        "volc" => "volc".into(),
        _ => String::new(),
    };
    AiConfig {
        deepseek_key: s.deepseek_key,
        qwen_vl_key: s.qwen_vl_key,
        text_model: s.text_model,
        text_provider: s.text_provider,
        local_text_model: s.local_text_model,
        local_vl_model: s.local_vl_model,
        vl_provider: s.vl_provider,
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

    // 始终保留「所在屏幕」子菜单：单屏时仍可显式选择「自动」；
    // 多屏时按 position().x 排序展示（1-based 序号 + 物理分辨率 + OS 内部名）。
    // 菜单项 ID 仍为 `monitor:{raw_name}`，与 `handle_menu_event` / `resolve_monitor` 兼容。
    let monitor_menu = if !monitors.is_empty() {
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
            // raw_name 为 None 或为空时（极少数 Windows / Linux 情况），
            // 退化为纯索引 id，仅本机有效，重启失效——但至少菜单可见可选。
            let raw_name = m
                .name()
                .filter(|n| !n.is_empty())
                .cloned()
                .unwrap_or_else(|| format!("__kxyy_no_name_{i}"));
            let size = m.size();
            let label = format!("显示器 {} ({}×{})", i + 1, size.width, size.height);
            let checked = s.monitor_id.as_deref() == Some(raw_name.as_str());
            let item = CheckMenuItem::with_id(
                app,
                format!("monitor:{raw_name}"),
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

fn install_tray(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle().clone();
    let menu = build_tray_menu(&handle)?;
    let icon = app
        .default_window_icon()
        .cloned()
        .unwrap_or_else(|| tauri::include_image!("icons/32x32.png"));
    let builder = TrayIconBuilder::with_id("main")
        .tooltip("元元桌宠")
        .menu(&menu)
        .icon(icon)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| handle_menu_event(app, event.id.as_ref()));
    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(false);
    let tray = builder.build(app)?;
    app.manage(TrayHolder(tray));
    Ok(())
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

/// 把 `Monitor::work_area()` 还原成「与 webview 一致」的逻辑坐标。
///
/// 跨平台 tauri/tao 实现对 work_area 的单位处理不一致（实测见
/// `tao-0.35.3/platform_impl/{windows,macos}/monitor.rs`）：
/// - **Windows**：`size()` / `work_area()` 直接是物理像素，`scale_factor = dpi / 96`。
///   物理 / sf = 与 webview CSS 像素一致的逻辑值（但 `apply_monitor_to_window` 已改走物理
///   直传，本函数实际不被 Windows 调用，保留 cfg gate 仅供文档/回退）。
/// - **macOS**：`size()` 内部把 `CGDisplay::pixels_wide() * scale_factor` 再返回，
///   且 `scale_factor()` 在 `ns_screen()` 不可用时回退 1.0。work_area 是「物理 × sf」，
///   用 monitor.sf 除回来才能拿到与 webview 一致的值。
/// - **Linux**：依赖 WM，未实测，保守跟随 macOS 逻辑。
///
/// 共享规则：统一用 `monitor.scale_factor()` 把 work_area 换算成 webview 的逻辑坐标；
/// set_position / set_size 用 `LogicalPosition/LogicalSize`（tauri 会再用窗口真实 sf 渲染）。
#[cfg(not(windows))]
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

/// 把主窗口铺满目标显示器的工作区（排除任务栏），并打一行诊断日志到
/// `%APPDATA%\com.aaronfang.kxyydesktoppet\stage.log`，便于跨平台核对
/// tauri 实际报上来的 sf / work_area 数值（与 webview `window.innerWidth/innerHeight`
/// 对照可一眼看出 1/4 area / 偏位之类问题的根因）。
fn debug_log_stage(monitor: &Monitor, lw: f64, lh: f64, sf: f64) {
    #[cfg(windows)]
    let path = std::env::var("APPDATA")
        .ok()
        .map(|p| std::path::PathBuf::from(p).join("com.aaronfang.kxyydesktoppet").join("stage.log"));
    #[cfg(not(windows))]
    let path: Option<std::path::PathBuf> = None;
    let Some(path) = path else { return };
    let wa = monitor.work_area();
    let line = format!(
        "[stage] name={:?} sf={} wa_phys=({},{},{}x{}) -> logical=({:.0},{:.0},{:.0}x{:.0})\n",
        monitor.name(),
        sf,
        wa.position.x,
        wa.position.y,
        wa.size.width,
        wa.size.height,
        0.0,
        0.0,
        lw,
        lh,
    );
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// 将主窗口铺满目标显示器的工作区（排除任务栏）。
/// 桌宠活动范围 = 该窗口客户区。
///
/// 平台分流（实测 tao 0.35.3 `platform_impl/{windows,macos}/monitor.rs`）：
/// - **Windows**：`Monitor::work_area()` 直接是物理像素；
///   `set_position/set_size` 用 `PhysicalPosition/PhysicalSize`，让 tauri 用窗口
///   真实 sf 转给 webview，避免再除一次 sf 导致 1/2 ~ 1/4 area。
/// - **macOS / Linux**：`work_area` 可能被 tauri 内部乘过 sf（macOS 已知 bug），
///   用 `work_area_logical` 转回与 webview 一致的逻辑坐标。
fn apply_monitor_to_window(app: &AppHandle, monitor_id: &Option<String>) {
    if let Some(win) = app.get_webview_window("main") {
        if let Some(monitor) = resolve_monitor(&win, monitor_id) {
            // 避免 min/max 约束把尺寸锁在初始 800×600。
            let _ = win.set_min_size(None::<tauri::PhysicalSize<u32>>);
            let _ = win.set_max_size(None::<tauri::PhysicalSize<u32>>);
            let sf = monitor.scale_factor().max(0.1);
            #[cfg(windows)]
            {
                let wa = monitor.work_area();
                // Windows: work_area 已是物理像素，直接 set。
                let _ = win.set_position(tauri::PhysicalPosition::new(wa.position.x, wa.position.y));
                let _ = win.set_size(tauri::PhysicalSize::new(wa.size.width, wa.size.height));
                debug_log_stage(&monitor, wa.size.width as f64 / sf, wa.size.height as f64 / sf, sf);
            }
            #[cfg(not(windows))]
            {
                // macOS / Linux: work_area 单位与 sf 不一致，统一按 monitor.sf 还原逻辑坐标。
                let (lx, ly, lw, lh) = work_area_logical(&monitor);
                let _ = win.set_position(tauri::LogicalPosition::new(lx, ly));
                let _ = win.set_size(tauri::LogicalSize::new(lw, lh));
                debug_log_stage(&monitor, lw, lh, sf);
            }
            let _ = app.emit("stage-resized", ());
        }
    }
}

/// 把聊天窗口按设置的尺寸定位到目标显示器工作区的「底部居中」。
///
/// 与 `apply_monitor_to_window` 保持平台分流：Windows 直接用物理像素，
/// macOS / Linux 走 `work_area_logical`。
fn position_chat_window(app: &AppHandle) {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    if let Some(win) = app.get_webview_window("chat") {
        if let Some(monitor) = resolve_monitor(&win, &s.monitor_id) {
            let w_logical = s.chat_width as f64;
            let h_logical = s.chat_height as f64;
            let offset_logical = s.chat_bottom_offset as f64;
            #[cfg(windows)]
            {
                let wa = monitor.work_area();
                let sf = monitor.scale_factor().max(0.1);
                let win_sf = win.scale_factor().unwrap_or(sf).max(0.1);
                // work_area 物理像素；窗口 sf 把 logical 尺寸转成物理。
                let lx = wa.position.x as f64;
                let ly = wa.position.y as f64;
                let lw = wa.size.width as f64;
                let lh = wa.size.height as f64;
                let w_phys = (w_logical * win_sf) as u32;
                let h_phys = (h_logical * win_sf) as u32;
                let x_phys = (lx + (lw - w_phys as f64) / 2.0) as i32;
                let y_phys = (ly + lh - h_phys as f64 - offset_logical * win_sf) as i32;
                let _ = win.set_size(tauri::PhysicalSize::new(w_phys, h_phys));
                let _ = win.set_position(tauri::PhysicalPosition::new(x_phys, y_phys));
            }
            #[cfg(not(windows))]
            {
                let (lx, ly, lw, lh) = work_area_logical(&monitor);
                let x = lx + (lw - w_logical) / 2.0;
                let y = ly + lh - h_logical - offset_logical;
                let _ = win.set_size(tauri::LogicalSize::new(w_logical, h_logical));
                let _ = win.set_position(tauri::LogicalPosition::new(x, y));
            }
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
    // NOTE: 此处**不**重复加载人设卡（persona card）。
    // DYNAMIC_CARD 在 setup() 阶段已根据 settings.persona_card_id 加载，
    // 此后只在 set_ai_settings / set_persona_card 中随用户显式操作更新。
    // 若 get_settings 也参与加载，一旦 resource_dir() 解析异常（如 Windows
    // 安装路径含中文时 unwrap_or_default 落入空 PathBuf），会静默失败并导致
    // 聊天窗口 fetch /api/assets 回退到编译期嵌入的 kxyy 默认人设，
    // 且 reloadAssetsWithMatchingCard 的重试也无法修复（因为 retry 只是
    // 重新 fetch /api/assets，不会触发 load_card_from_file）。
    state.settings.lock().unwrap().clone()
}

/// 扫描 persona-cards/ 目录，返回所有可用人格卡的 card_id 列表。
#[tauri::command]
fn list_persona_cards(app: AppHandle) -> Result<Vec<String>, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法获取资源目录: {e}"))?;
    crate::persona_assets::list_cards(&resource_dir)
}

/// 列出所有卡片（本地 + 注册表），含元数据（id, name, description, category, source, isLocal）。
#[tauri::command]
fn list_all_cards(app: AppHandle) -> Result<Vec<crate::persona_assets::CardMeta>, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法获取资源目录: {e}"))?;
    crate::persona_assets::list_all_cards(&resource_dir)
}

/// 从 persona-cards/<card_id>/persona-card.json 加载人格卡并设为当前活跃。
/// card_id 为空字符串时恢复编译期嵌入的默认人设。
/// 如果卡片仅存在于注册表（非本地），则自动生成桩文件后再加载。
#[tauri::command]
fn set_persona_card(app: AppHandle, card_id: String) -> Result<(), String> {
    if card_id.is_empty() {
        crate::persona_assets::reset_to_default();
        return Ok(());
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法获取资源目录: {e}"))?;

    crate::persona_assets::load_card_from_file(&card_id, &resource_dir)
}

/// 删除指定本地人格卡。
#[tauri::command]
fn delete_persona_card(app: AppHandle, card_id: String) -> Result<(), String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法获取资源目录: {e}"))?;
    crate::persona_assets::delete_card(&card_id, &resource_dir)
}

/// 导出指定人格卡的 JSON 内容。
#[tauri::command]
fn export_persona_card(app: AppHandle, card_id: String) -> Result<String, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法获取资源目录: {e}"))?;
    crate::persona_assets::export_card_json(&card_id, &resource_dir)
}

/// 导入人格卡（card_id + JSON 内容）。
#[tauri::command]
fn import_persona_card(app: AppHandle, card_id: String, json_content: String) -> Result<String, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法获取资源目录: {e}"))?;
    crate::persona_assets::import_card_json(&card_id, &json_content, &resource_dir)
}

/// 读取入设卡内置的头像（来自 persona-card.json 的 avatar 字段）。
#[tauri::command]
fn get_card_avatar(app: AppHandle, card_id: String) -> Result<String, String> {
    if card_id.is_empty() {
        return Ok(String::new());
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法获取资源目录: {e}"))?;
    crate::persona_assets::get_card_avatar(&card_id, &resource_dir)
}

/// 读取入设卡显示名称。
#[tauri::command]
fn get_card_display_name(app: AppHandle, card_id: String) -> Result<String, String> {
    if card_id.is_empty() {
        return Ok(String::new());
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法获取资源目录: {e}"))?;
    crate::persona_assets::get_card_display_name(&card_id, &resource_dir)
}

/// 写出 UTF-8 文本（人设卡导出等本机文件写入）。
#[tauri::command]
fn write_utf8_file(path: String, contents: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err("路径为空".into());
    }
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }
    fs::write(&p, contents).map_err(|e| format!("写入失败: {e}"))
}

/// 读取 UTF-8 文本（人设卡导入等本机文件读取）。
#[tauri::command]
fn read_utf8_file(path: String) -> Result<String, String> {
    let p = std::path::PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err("路径为空".into());
    }
    fs::read_to_string(&p).map_err(|e| format!("读取失败: {e}"))
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

/// 在光标处（相对主窗口）弹出托盘菜单；失败则打开设置窗口。
fn popup_tray_menu_at_cursor(app: &AppHandle) {
    let Ok(menu) = build_tray_menu(app) else {
        open_settings_window(app);
        return;
    };
    let Some(win) = app.get_webview_window("main") else {
        open_settings_window(app);
        return;
    };
    if let Ok(pos) = win.cursor_position() {
        if win.popup_menu_at(&menu, pos).is_ok() {
            return;
        }
    }
    let _ = win.popup_menu(&menu);
}

/// dev 模式 Dock 点击：菜单栏托盘在 macOS 26+ dev 常不可见，于主窗口中央弹出托盘菜单。
#[cfg(all(target_os = "macos", debug_assertions))]
fn popup_tray_menu_centered(app: &AppHandle) {
    let Ok(menu) = build_tray_menu(app) else {
        open_settings_window(app);
        return;
    };
    let Some(win) = app.get_webview_window("main") else {
        open_settings_window(app);
        return;
    };
    if !win.is_visible().unwrap_or(false) {
        open_settings_window(app);
        return;
    }
    if let Ok(size) = win.inner_size() {
        let _ = win.popup_menu_at(
            &menu,
            tauri::Position::Logical(tauri::LogicalPosition {
                x: (size.width / 2) as f64,
                y: (size.height / 2) as f64,
            }),
        );
        return;
    }
    let _ = win.popup_menu(&menu);
}

/// dev 模式 Dock 图标点击：macOS 26+ 上菜单栏托盘常不可见，Dock 作为备用入口。
/// Reopen 在 AppKit 委托回调里同步执行；若在此栈上立刻 `popUpMenu`（模态跟踪环），
/// 会与当前事件派发嵌套冲突导致整 app 卡死。须先结束本回调，再在下一轮主线程任务里弹菜单。
#[cfg(all(target_os = "macos", debug_assertions))]
fn handle_macos_dock_reopen(app: &AppHandle) {
    let app2 = app.clone();
    std::thread::spawn(move || {
        let app3 = app2.clone();
        let _ = app2.run_on_main_thread(move || {
            let _ = app3.show();
            popup_tray_menu_centered(&app3);
        });
    });
}

/// 右键桌宠时在光标处弹出上下文菜单（须在主线程执行）。
#[tauri::command]
fn show_menu(app: AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        popup_tray_menu_at_cursor(&handle);
    });
}

/// 返回本地 AI 代理的基址，前端聊天页据此发起 /api/chat 请求。
#[tauri::command]
fn get_api_base(state: tauri::State<AppState>) -> String {
    format!("http://127.0.0.1:{}", state.api_port)
}

/// 查询当前语音后端服务就绪状态，供前端在聊天窗口打开时主动探测
/// （`voice-service-status` 事件是 push 式，窗口打开前的事件会被丢失）。
#[tauri::command]
fn check_voice_service(state: tauri::State<AppState>) -> serde_json::Value {
    let backend = state
        .settings
        .lock()
        .unwrap()
        .realtime_backend
        .trim()
        .to_ascii_lowercase();
    let normalized = voice_service::normalize_backend(&backend);
    if normalized.is_empty() {
        return serde_json::json!({
            "backend": "",
            "state": "stopped",
            "message": "语音已关闭"
        });
    }
    if normalized == "volc" {
        return serde_json::json!({
            "backend": "volc",
            "state": "running",
            "message": "火山云端，无需本地服务"
        });
    }
    let port = voice_service::port_for(&normalized);
    let running = voice_service::service_running(port);
    serde_json::json!({
        "backend": normalized,
        "state": if running { "running" } else { "unknown" },
        "message": if running { format!("已在运行（:{}）", port) } else { "未检测到运行中服务".into() },
        "port": port,
    })
}

/// 探测任意语音后端状态（不启动服务），供设置页切换下拉时立即反馈。
/// 返回值 state 可能为：running / ready / stopped / failed / warning。
#[tauri::command]
fn probe_voice_backend(backend: String) -> serde_json::Value {
    let backend = voice_service::normalize_backend(&backend);

    // volc / cosyvoice 云端后端始终视为就绪
    if backend == "volc" {
        return serde_json::json!({
            "backend": "volc",
            "state": "ready",
            "message": "云端服务，无需本地启动"
        });
    }
    if backend == "cosyvoice" {
        let port = voice_service::port_for(&backend);
        let running = voice_service::service_running(port);
        if running {
            return serde_json::json!({
                "backend": "cosyvoice",
                "state": "running",
                "message": format!("已在运行（:{}）", port),
                "port": port,
            });
        }
        // 检查通义 Key 是否已配置（从持久化 settings 读取）
        let has_key = !voice_service::read_setting_str("qwenVlKey").trim().is_empty();
        return serde_json::json!({
            "backend": "cosyvoice",
            "state": if has_key { "ready" } else { "warning" },
            "message": if has_key { "已配置，保存后启动" } else { "需填写通义 Key" },
            "port": port,
        });
    }

    // 本地后端：先看端口是否已有服务在跑
    let port = voice_service::port_for(&backend);
    if voice_service::service_running(port) {
        return serde_json::json!({
            "backend": backend,
            "state": "running",
            "message": format!("已在运行（:{}）", port),
            "port": port,
        });
    }


    serde_json::json!({
        "backend": backend,
        "state": "stopped",
        "message": "未启动，保存后自动启动",
        "port": port,
    })
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
        "volc" if state.realtime_port != 0 => format!("ws://127.0.0.1:{}", state.realtime_port),
        _ => String::new(), // 关或未初始化
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
    local_ref_wav: String,
    #[serde(default)]
    local_ref_text: String,
    #[serde(default = "default_voice_volume")]
    voice_volume: u32,
    #[serde(default = "default_true")]
    show_chat_debug: bool,
    text_model: String,
    #[serde(default = "default_text_provider")]
    text_provider: String,
    #[serde(default)]
    local_text_model: String,
    #[serde(default)]
    local_vl_model: String,
    #[serde(default = "default_vl_provider")]
    vl_provider: String,
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
    #[serde(default)]
    persona_card_id: String,
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
    // 先加载人设卡到 DYNAMIC_CARD（必须在 commit_settings emit apply-settings 之前），
    // 确保聊天窗口收到事件后 fetch /api/assets 拿到的是新人格而非旧缓存。
    let card_id = settings.persona_card_id.trim().to_string();
    {
        let resource_dir = app.path().resource_dir().unwrap_or_default();
        if card_id.is_empty() {
            crate::persona_assets::reset_to_default();
        } else {
            let _ = crate::persona_assets::load_card_from_file(&card_id, &resource_dir);
        }
    }
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
            "volc" => "volc".into(),
            _ => String::new(), // 空=关闭语音
        };
        s.cosyvoice_voice = settings.cosyvoice_voice.trim().to_string();
        s.cosyvoice_model = settings.cosyvoice_model.trim().to_string();
        s.local_ref_wav = settings.local_ref_wav.trim().to_string();
        s.local_ref_text = settings.local_ref_text.trim().to_string();
        s.voice_volume = settings.voice_volume.min(200);
        s.show_chat_debug = settings.show_chat_debug;
        s.text_model = settings.text_model.trim().to_string();
        s.text_provider = match settings.text_provider.trim().to_ascii_lowercase().as_str() {
            "local" => "local".into(),
            _ => "deepseek".into(),
        };
        s.local_text_model = settings.local_text_model.trim().to_string();
        s.local_vl_model = settings.local_vl_model.trim().to_string();
        s.vl_provider = match settings.vl_provider.trim().to_ascii_lowercase().as_str() {
            "local" => "local".into(),
            _ => "qwen".into(),
        };
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
        s.persona_card_id = card_id;
    });
    re_register_hotkey(&app);
    position_chat_window(&app);
    // 按所选语音后端自动拉起 / 切换本地 Python 服务。
    let backend;
    let voice_fp;
    {
        let state = app.state::<AppState>();
        let guard = state.settings.lock().unwrap();
        backend = guard.realtime_backend.clone();
        voice_fp = format!(
            "{}|{}|{}|{}",
            guard.persona_card_id.trim(),
            guard.local_ref_wav.trim(),
            guard.local_ref_text.trim(),
            voice_service::builtin_ref_stamp(&guard.persona_card_id)
        );
    }
    voice_service::ensure(&app, &backend, &voice_fp);
    // 按所选文字服务商自动探测 / 拉起本地 Ollama（非 local 时函数内部直接返回）。
    let text_provider;
    let local_text_model;
    {
        let state = app.state::<AppState>();
        let guard = state.settings.lock().unwrap();
        text_provider = guard.text_provider.clone();
        local_text_model = guard.local_text_model.clone();
    }
    local_text::ensure(&app, &text_provider, &local_text_model);
}

/// 只读探测本地文字模型（Ollama）状态，不改变系统状态。
#[tauri::command]
fn probe_local_text_backend() -> local_text::LocalTextStatus {
    local_text::probe()
}

/// 列出本地已装模型（Ollama 未运行时返回空数组）。
#[tauri::command]
fn list_local_text_models() -> Vec<local_text::ModelInfo> {
    local_text::list_models().unwrap_or_default()
}

/// 触发一次模型下载/更新（Ollama `POST /api/pull`）；立即返回，进度经
/// `local-text-pull-progress` 事件推送。
#[tauri::command]
fn pull_local_text_model(app: AppHandle, model: String) {
    let model = model.trim().to_string();
    let model = if model.is_empty() {
        local_text::DEFAULT_MODEL.to_string()
    } else {
        model
    };
    local_text::pull_model(app, model);
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
            // macOS：正式包隐藏 Dock，仅保留菜单栏托盘。
            // dev 裸二进制在 macOS 26+ 上常不显示菜单栏图标，开发模式保留 Dock 入口。
            #[cfg(target_os = "macos")]
            {
                #[cfg(debug_assertions)]
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
                #[cfg(not(debug_assertions))]
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            let handle = app.handle().clone();
            let settings = load_settings(&handle);

            // 必须先激活已保存的人格，再启动本地代理；否则聊天窗口可能先拿到编译期默认人设并缓存。
            if settings.persona_card_id.is_empty() {
                eprintln!("[setup] persona_card_id 为空，使用编译期默认人设");
            } else {
                eprintln!("[setup] 加载人设卡 '{}'", settings.persona_card_id);
                let resource_dir = app
                    .path()
                    .resource_dir()
                    .unwrap_or_default();
                eprintln!("[setup] resource_dir: {:?}", resource_dir);
                match crate::persona_assets::load_card_from_file(
                    &settings.persona_card_id,
                    &resource_dir,
                ) {
                    Ok(()) => eprintln!(
                        "[setup] 人格卡 '{}' 加载成功",
                        settings.persona_card_id
                    ),
                    Err(e) => {
                        eprintln!(
                            "[setup] 人格卡 '{}' 加载失败: {e}（resource_dir={:?}）",
                            settings.persona_card_id, resource_dir
                        );
                        // 兜底：windows 下 resource_dir 解析异常时（如路径含中文），
                        // 尝试用当前 exe 所在目录作为备选 resource_dir。
                        #[cfg(target_os = "windows")]
                        {
                            if let Ok(exe_path) = std::env::current_exe() {
                                if let Some(exe_dir) = exe_path.parent() {
                                    let fallback = exe_dir.to_path_buf();
                                    eprintln!(
                                        "[setup] Windows 备选 resource_dir 尝试: {:?}",
                                        fallback
                                    );
                                    if let Err(e2) =
                                        crate::persona_assets::load_card_from_file(
                                            &settings.persona_card_id,
                                            &fallback,
                                        )
                                    {
                                        eprintln!(
                                            "[setup] Windows 备选路径也失败: {e2}"
                                        );
                                    } else {
                                        eprintln!(
                                            "[setup] Windows 备选路径加载成功"
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }

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
            // 尽早创建托盘，避免语音服务等后台任务拖慢菜单栏图标出现。
            install_tray(app)?;

            // 兜底清理：托盘「退出」走 app.exit() → tauri::RunEvent::Exit（见 run() 尾部），
            // 但那套机制依赖事件循环正常收到并处理该事件。若进程被外部信号强杀
            // （开发时 Ctrl+C / 终止终端，或 Windows 下关闭控制台/注销/关机），事件循环
            // 会被直接打断，RunEvent::Exit 不一定来得及触发，本地语音子进程（server.py，
            // 因 process_group(0) 独立于本进程组）就会变成孤儿常驻在后台。这里单独注册
            // 系统级信号/控制台事件处理器，收到即同步 kill 掉托管子进程再退出，双重兜底。
            {
                let sig_handle = handle.clone();
                let _ = ctrlc::set_handler(move || {
                    eprintln!("[lib] 收到终止信号，清理本地语音子进程后退出…");
                    voice_service::stop(&sig_handle);
                    std::process::exit(0);
                });
            }

            // 启动时按已保存的语音后端自动拉起本地服务。
            let voice_fp = format!(
                "{}|{}|{}|{}",
                settings.persona_card_id.trim(),
                settings.local_ref_wav.trim(),
                settings.local_ref_text.trim(),
                voice_service::builtin_ref_stamp(&settings.persona_card_id)
            );
            voice_service::ensure(&handle, &settings.realtime_backend, &voice_fp);
            // 启动时按已保存的文字服务商自动探测 / 拉起本地 Ollama（非 local 时内部直接返回）。
            local_text::ensure(&handle, &settings.text_provider, &settings.local_text_model);

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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            list_persona_cards,
            list_all_cards,
            set_persona_card,
            get_card_avatar,
            get_card_display_name,
            delete_persona_card,
            export_persona_card,
            import_persona_card,
            write_utf8_file,
            read_utf8_file,
            set_ignore_cursor,
            cursor_pos,
            show_menu,
            get_api_base,
            get_realtime_base,
            check_voice_service,
            probe_voice_backend,
            toggle_chat_window,
            hide_chat,
            open_settings,
            set_ai_settings,
            get_platform,
            memory_flushed,
            probe_local_text_backend,
            list_local_text_models,
            pull_local_text_model
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                tauri::RunEvent::Exit => voice_service::stop(app),
                #[cfg(all(target_os = "macos", debug_assertions))]
                tauri::RunEvent::Reopen { .. } => handle_macos_dock_reopen(app),
                _ => {}
            }
        });
}
