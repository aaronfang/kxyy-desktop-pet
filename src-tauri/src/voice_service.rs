//! 按设置自动拉起 / 切换本地语音 Python 服务（Qwen3 / CosyVoice 云桥）。
//! 火山后端不启 Python；若端口健康检查通过则视为已就绪；若端口被占但检查失败则自动清理残留进程后重拉。

use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// 子进程最近日志缓存上限（失败时回带设置页）。
const RECENT_LOG_MAX_LINES: usize = 30;
/// 自动配置脚本进度缓存上限（macOS/Windows 共用）。
const SETUP_LOG_MAX_LINES: usize = 40;
/// 启动超过该时间仍未就绪时更新一次进度；子进程存活期间继续探测，不误报失败。
const STARTUP_SLOW_NOTICE_SECS: u64 = 180;
const SENSEVOICE_PROGRESS_PREFIX: &str = "KXYY_SENSEVOICE_PROGRESS ";

/// 进程级共享 secret：拉起本地 TTS 服务时经环境变量 KXYY_TTS_SECRET 注入，
/// 代理转发 /tts 时带同值 X-Tts-Secret 头，阻止任意本机进程直接刷云端计费。
///
/// 持久化到用户配置目录，跨启动/跨进程保持一致——避免上一轮遗留的孤儿服务
/// 因 secret 变化而返回 401。
pub fn tts_secret() -> &'static str {
    static SECRET: OnceLock<String> = OnceLock::new();
    SECRET.get_or_init(|| {
        let path = dirs_settings_path().map(|p| p.with_file_name("voice-tts.secret"));
        if let Some(p) = &path {
            if let Ok(s) = std::fs::read_to_string(p) {
                let s = s.trim().to_string();
                if !s.is_empty() {
                    return s;
                }
            }
        }
        use std::time::{SystemTime, UNIX_EPOCH};
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        // 仅用于同机进程隔离，无需密码学强随机：纳秒时钟 + pid 混合即足够。
        let secret = format!(
            "{:x}-{:x}-{:x}",
            now.as_nanos(),
            std::process::id(),
            now.subsec_nanos()
        );
        if let Some(p) = &path {
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(p, &secret);
        }
        secret
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceServiceStatus {
    pub backend: String,
    /// starting | running | stopped | failed | skipped
    pub state: String,
    pub message: String,
    pub port: u16,
}

pub struct VoiceServiceManager {
    inner: Mutex<Inner>,
    lifecycle: Mutex<()>,
}

struct Inner {
    /// 当前由本进程托管的后端（空 = 未托管）。
    backend: String,
    /// 不透明语音配置指纹；变化时重启以应用本地参考音或 CosyVoice 凭据/音色。
    voice_fingerprint: String,
    child: Option<Child>,
    /// 子进程最近日志（失败时带回设置页）。
    recent_logs: Arc<Mutex<VecDeque<String>>>,
    /// 正在跑 Qwen 自动配置脚本；不得与 VAD 安装 admission 混为同一状态。
    qwen_setup_running: bool,
    /// VAD runtime 安装目标；同后端 ensure 必须等待，避免重新占用 ORT DLL。
    vad_install_backend: String,
    /// SenseVoice runtime 安装目标；与 Qwen/VAD 安装共享 lifecycle admission。
    sensevoice_install_backend: String,
    sensevoice_install_provider: String,
    sensevoice_install_fingerprint: String,
    /// 最近一次 settings-driven ensure 的目标；后台完成回调只能服从它。
    desired_backend: String,
    desired_asr_provider: String,
    desired_fingerprint: String,
    desired_epoch: u64,
}

impl VoiceServiceManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                backend: String::new(),
                voice_fingerprint: String::new(),
                child: None,
                recent_logs: Arc::new(Mutex::new(VecDeque::new())),
                qwen_setup_running: false,
                vad_install_backend: String::new(),
                sensevoice_install_backend: String::new(),
                sensevoice_install_provider: String::new(),
                sensevoice_install_fingerprint: String::new(),
                desired_backend: String::new(),
                desired_asr_provider: "whisper".into(),
                desired_fingerprint: String::new(),
                desired_epoch: 0,
            }),
            lifecycle: Mutex::new(()),
        }
    }
}

fn push_log(logs: &Arc<Mutex<VecDeque<String>>>, line: String) {
    if let Ok(mut q) = logs.lock() {
        q.push_back(line);
        while q.len() > RECENT_LOG_MAX_LINES {
            q.pop_front();
        }
    }
}

/// 逐行读取子进程输出并缓存。按字节 `read_until('\n')` + lossy 解码，
/// 兼容非 UTF-8 输出（Windows GBK 等）——避免中文报错行被整行丢弃。
fn read_child_lines<R: std::io::Read>(reader: R, tag: &str, logs: &Arc<Mutex<VecDeque<String>>>) {
    let mut br = BufReader::new(reader);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        match br.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {
                while matches!(buf.last(), Some(b'\n') | Some(b'\r')) {
                    buf.pop();
                }
                let line = String::from_utf8_lossy(&buf).into_owned();
                eprintln!("[voice-service:{tag}] {line}");
                push_log(logs, line);
            }
            Err(_) => break,
        }
    }
}

fn take_log_summary(logs: &Arc<Mutex<VecDeque<String>>>) -> String {
    let Ok(q) = logs.lock() else {
        return String::new();
    };
    // 优先找「未找到 / Error / 失败」类行，否则取最后几行。
    let important: Vec<&String> = q
        .iter()
        .filter(|l| {
            let s = l.to_ascii_lowercase();
            s.contains("未找到")
                || s.contains("error")
                || s.contains("失败")
                || s.contains("traceback")
                || s.contains("modulenotfound")
                || s.contains("systemexit")
        })
        .collect();
    let lines: Vec<&String> = if !important.is_empty() {
        important
            .into_iter()
            .rev()
            .take(3)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    } else {
        q.iter()
            .rev()
            .take(3)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    };
    let mut msg = lines
        .iter()
        .map(|s| s.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    // 设置页单行展示，截断过长内容。
    if msg.chars().count() > 160 {
        msg = msg.chars().take(157).collect::<String>() + "…";
    }
    msg
}

fn parse_sensevoice_install_progress(line: &str) -> Option<serde_json::Value> {
    let raw = line.strip_prefix(SENSEVOICE_PROGRESS_PREFIX)?;
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let object = value.as_object()?;
    let state = object.get("state")?.as_str()?;
    let phase = object.get("phase")?.as_str()?;
    let message = object.get("message")?.as_str()?;
    if !matches!(state, "installing" | "ready" | "failed")
        || !matches!(
            phase,
            "downloading" | "installing" | "extracting" | "verifying" | "complete" | "failed"
        )
        || message.is_empty()
        || message.chars().count() > 120
        || message.contains(['\n', '\r', '\\'])
        || message.contains("/private/")
        || message.contains("/Users/")
        || message.to_ascii_lowercase().contains("://")
    {
        return None;
    }
    let completed_bytes = object
        .get("completedBytes")
        .and_then(|item| item.as_u64())
        .unwrap_or(0)
        .min(1_000_000_000);
    let total_bytes = object
        .get("totalBytes")
        .and_then(|item| item.as_u64())
        .unwrap_or(0)
        .min(1_000_000_000);
    let raw_reason = object.get("reason").and_then(|item| item.as_str());
    if raw_reason.is_some_and(|reason| {
        !matches!(
            reason,
            "runtime-root-unavailable"
                | "download-failed"
                | "download-integrity-failed"
                | "install-busy"
                | "subprocess-failed"
                | "model-archive-invalid"
                | "model-integrity-failed"
                | "unsupported-python"
                | "unsupported-arch"
                | "unsupported-os"
                | "install-failed"
        )
    }) {
        return None;
    }
    let reason = raw_reason.unwrap_or("");
    Some(serde_json::json!({
        "state": state,
        "phase": phase,
        "message": message,
        "completedBytes": completed_bytes,
        "totalBytes": total_bytes,
        "reason": reason,
    }))
}

/// macOS 从 Finder 启动时 PATH 常不含 Homebrew；本地语音 ASR（mlx-whisper）依赖 ffmpeg CLI。
pub(crate) fn augmented_tool_path() -> std::ffi::OsString {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let cur = current.to_string_lossy();
    #[cfg(target_os = "macos")]
    let extras = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
    #[cfg(all(unix, not(target_os = "macos")))]
    let extras = ["/usr/local/bin", "/snap/bin"];
    #[cfg(windows)]
    let extras: [&str; 0] = [];
    let prepend: Vec<&str> = extras
        .iter()
        .copied()
        .filter(|p| !cur.split(':').any(|part| part == *p))
        .collect();
    if prepend.is_empty() {
        return current;
    }
    let joined = prepend.join(":");
    if cur.is_empty() {
        std::ffi::OsString::from(joined)
    } else {
        std::ffi::OsString::from(format!("{joined}:{cur}"))
    }
}

fn emit(app: &AppHandle, status: VoiceServiceStatus) {
    let _ = app.emit("voice-service-status", &status);
    eprintln!(
        "[voice-service] {} {} — {}",
        status.backend, status.state, status.message
    );
}

pub fn normalize_backend(backend: &str) -> String {
    match backend.trim().to_ascii_lowercase().as_str() {
        "local" => "local".into(),
        "cosyvoice" | "cosy" => "cosyvoice".into(),
        "volc" => "volc".into(),
        _ => String::new(), // 空/其他=关闭
    }
}

pub fn normalize_asr_provider(provider: &str) -> String {
    match provider.trim().to_ascii_lowercase().as_str() {
        "sensevoice" => "sensevoice".into(),
        _ => "whisper".into(),
    }
}

fn normalize_turn_pause_tolerance(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        "fast" => "fast",
        "long" => "long",
        _ => "standard",
    }
}

fn should_restart_for_fingerprint(backend: &str, previous: &str, next: &str) -> bool {
    matches!(backend, "local" | "cosyvoice") && !next.is_empty() && previous != next
}

fn startup_slow_message(backend: &str, elapsed_secs: u64) -> Option<&'static str> {
    if elapsed_secs != STARTUP_SLOW_NOTICE_SECS {
        return None;
    }
    Some(if backend == "local" {
        "首次使用可能正在下载数 GB 模型；语音服务仍在下载或加载，完成后将自动恢复"
    } else {
        "语音服务仍在加载本地模型，完成后将自动恢复"
    })
}

#[cfg(test)]
mod fingerprint_tests {
    use super::{
        backend_still_selected, begin_sensevoice_runtime_install, begin_vad_runtime_install,
        finish_sensevoice_runtime_install, finish_vad_runtime_install, normalize_asr_provider,
        normalize_turn_pause_tolerance, parse_sensevoice_install_progress,
        record_desired_voice_config, resolve_hf_endpoint, sensevoice_install_matches_target,
        should_defer_for_vad_install, should_restart_for_fingerprint, startup_slow_message,
        supports_vad_runtime_install, voice_target_still_selected, VoiceServiceManager,
        DEFAULT_HF_ENDPOINT,
    };

    #[test]
    fn restarts_managed_voice_backends_only_for_nonempty_changes() {
        for backend in ["local", "cosyvoice"] {
            assert!(should_restart_for_fingerprint(backend, "old", "new"));
            assert!(!should_restart_for_fingerprint(backend, "same", "same"));
            assert!(!should_restart_for_fingerprint(backend, "old", ""));
        }
        assert!(!should_restart_for_fingerprint("volc", "old", "new"));
        assert!(!should_restart_for_fingerprint("", "old", "new"));
    }

    #[test]
    fn turn_pause_tolerance_accepts_only_fixed_presets() {
        assert_eq!(normalize_turn_pause_tolerance("fast"), "fast");
        assert_eq!(normalize_turn_pause_tolerance(" LONG "), "long");
        for value in ["", "standard", "custom", "2250"] {
            assert_eq!(normalize_turn_pause_tolerance(value), "standard");
        }
    }

    #[test]
    fn hugging_face_endpoint_defaults_official_and_keeps_explicit_overrides() {
        assert_eq!(resolve_hf_endpoint("", None), DEFAULT_HF_ENDPOINT);
        assert_eq!(
            resolve_hf_endpoint("", Some(" https://private-mirror.example/ ")),
            "https://private-mirror.example"
        );
        assert_eq!(
            resolve_hf_endpoint(" https://settings-mirror.example/ ", Some("ignored")),
            "https://settings-mirror.example"
        );
    }

    #[test]
    fn slow_model_startup_stays_in_progress_until_the_child_exits_or_becomes_ready() {
        assert_eq!(startup_slow_message("local", 179), None);
        assert_eq!(
            startup_slow_message("local", 180),
            Some("首次使用可能正在下载数 GB 模型；语音服务仍在下载或加载，完成后将自动恢复")
        );
        assert_eq!(startup_slow_message("local", 181), None);
        assert_eq!(
            startup_slow_message("cosyvoice", 180),
            Some("语音服务仍在加载本地模型，完成后将自动恢复")
        );
    }

    #[test]
    fn vad_runtime_installer_accepts_only_managed_voice_backends() {
        assert!(supports_vad_runtime_install("local"));
        assert!(supports_vad_runtime_install("cosyvoice"));
        for backend in ["volc", "", "unknown"] {
            assert!(!supports_vad_runtime_install(backend));
        }
    }

    #[test]
    fn vad_install_admission_clears_after_every_child_outcome() {
        let manager = VoiceServiceManager::new();
        let mut inner = manager.inner.lock().unwrap();
        inner.qwen_setup_running = true;
        assert!(!begin_vad_runtime_install(&mut inner, "cosyvoice"));
        inner.qwen_setup_running = false;
        assert!(begin_vad_runtime_install(&mut inner, "local"));
        assert!(!begin_vad_runtime_install(&mut inner, "local"));
        assert!(!begin_vad_runtime_install(&mut inner, "cosyvoice"));
        assert!(!inner.qwen_setup_running);
        assert_eq!(inner.vad_install_backend, "local");

        // Both a zero and non-zero child status use this same unconditional cleanup.
        finish_vad_runtime_install(&mut inner, "local");
        assert!(!inner.qwen_setup_running);
        assert!(inner.vad_install_backend.is_empty());
        assert!(begin_vad_runtime_install(&mut inner, "cosyvoice"));
    }

    #[test]
    fn vad_install_defers_only_same_backend_and_restarts_only_if_still_selected() {
        assert!(should_defer_for_vad_install("local", "local"));
        assert!(!should_defer_for_vad_install("cosyvoice", "local"));
        assert!(!should_defer_for_vad_install("", "local"));

        let manager = VoiceServiceManager::new();
        let mut inner = manager.inner.lock().unwrap();
        record_desired_voice_config(&mut inner, "local", "whisper", "fp-1");
        assert!(backend_still_selected(&inner, "local"));
        let first_epoch = inner.desired_epoch;
        record_desired_voice_config(&mut inner, "cosyvoice", "sensevoice", "fp-2");
        assert!(!backend_still_selected(&inner, "local"));
        assert_eq!(inner.desired_backend, "cosyvoice");
        assert_eq!(inner.desired_asr_provider, "sensevoice");
        assert_eq!(inner.desired_fingerprint, "fp-2");
        assert!(inner.desired_epoch > first_epoch);
    }

    #[test]
    fn sensevoice_install_is_serialized_and_completion_matches_full_target() {
        assert_eq!(normalize_asr_provider("sensevoice"), "sensevoice");
        assert_eq!(normalize_asr_provider("unknown"), "whisper");

        let manager = VoiceServiceManager::new();
        let mut inner = manager.inner.lock().unwrap();
        record_desired_voice_config(&mut inner, "local", "sensevoice", "fp-1");
        assert!(begin_sensevoice_runtime_install(
            &mut inner,
            "local",
            "sensevoice",
            "fp-1"
        ));
        assert!(!begin_vad_runtime_install(&mut inner, "local"));
        assert!(sensevoice_install_matches_target(
            &inner,
            "local",
            "sensevoice",
            "fp-1"
        ));
        assert!(!sensevoice_install_matches_target(
            &inner, "local", "whisper", "fp-1"
        ));
        assert!(voice_target_still_selected(
            &inner,
            "local",
            "sensevoice",
            "fp-1"
        ));
        assert!(!voice_target_still_selected(
            &inner, "local", "whisper", "fp-1"
        ));
        record_desired_voice_config(&mut inner, "local", "sensevoice", "fp-2");
        assert!(!voice_target_still_selected(
            &inner,
            "local",
            "sensevoice",
            "fp-1"
        ));
        finish_sensevoice_runtime_install(&mut inner, "local");
        assert!(inner.sensevoice_install_backend.is_empty());
        assert!(begin_vad_runtime_install(&mut inner, "local"));
    }

    #[test]
    fn sensevoice_install_progress_accepts_only_bounded_fixed_shape_messages() {
        let valid = parse_sensevoice_install_progress(
            "KXYY_SENSEVOICE_PROGRESS {\"state\":\"installing\",\"phase\":\"downloading\",\"message\":\"正在下载 SenseVoice 模型（3/3，总进度 80%）…\",\"completedBytes\":800,\"totalBytes\":1000}",
        )
        .unwrap();
        assert_eq!(valid["completedBytes"], 800);
        assert_eq!(valid["totalBytes"], 1000);
        assert_eq!(valid["reason"], "");

        let failed = parse_sensevoice_install_progress(
            "KXYY_SENSEVOICE_PROGRESS {\"state\":\"failed\",\"phase\":\"failed\",\"message\":\"SenseVoice runtime 安装失败：下载失败，请检查网络后重试。\",\"reason\":\"download-failed\"}",
        )
        .unwrap();
        assert_eq!(failed["reason"], "download-failed");

        assert!(parse_sensevoice_install_progress("untrusted output").is_none());
        assert!(parse_sensevoice_install_progress(
            "KXYY_SENSEVOICE_PROGRESS {\"state\":\"failed\",\"phase\":\"failed\",\"message\":\"泄露 /private/path\",\"reason\":\"future-reason\"}"
        )
        .is_none());
    }
}

pub fn port_for(backend: &str) -> u16 {
    match backend {
        "local" => 19876,
        "cosyvoice" => 19877,
        _ => 0,
    }
}

fn script_for(backend: &str) -> Option<&'static str> {
    match backend {
        "local" => Some("server.py"),
        "cosyvoice" => Some("server_cosyvoice.py"),
        _ => None,
    }
}

/// 对本地 TTS HTTP 服务（WS 端口 + 100）做 `GET /health`，确认是「本项目的服务」而非
/// 随机占用同端口的无关程序。仅裸 TCP connect 成功会误判，导致后续 TTS 转发失败却不再自启。
pub fn service_running(ws_port: u16) -> bool {
    use std::io::{Read, Write};
    if ws_port == 0 {
        return false;
    }
    let http_port = ws_port + 100;
    let Ok(addr) = format!("127.0.0.1:{http_port}").parse::<std::net::SocketAddr>() else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
    if stream
        .write_all(b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = Vec::new();
    let mut chunk = [0u8; 512];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > 4096 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&buf);
    text.contains("200 OK") && text.contains("kxyy-voice")
}

/// 127.0.0.1 上是否已有进程在监听该端口。
fn port_listener_busy(port: u16) -> bool {
    if port == 0 {
        return false;
    }
    std::net::TcpListener::bind(("127.0.0.1", port)).is_err()
}

#[cfg(unix)]
fn pids_listening_on_port(port: u16) -> Vec<u32> {
    // 注意：`-tiTCP:19876` 必须写成「一个」参数（含冒号）。若拆成 `-tiTCP` + `19876`，
    // macOS/BSD lsof 会把 `9876` 当成文件名，清理永远失败，残留 server.py 就会报
    // Address already in use。
    let selector = format!("-tiTCP:{port}");
    for bin in ["/usr/sbin/lsof", "/usr/bin/lsof", "lsof"] {
        let Ok(output) = Command::new(bin).args([&selector, "-sTCP:LISTEN"]).output() else {
            continue;
        };
        let text = String::from_utf8_lossy(&output.stdout);
        if text.trim().is_empty() {
            continue;
        }
        let self_pid = std::process::id();
        let mut pids: Vec<u32> = text
            .split_whitespace()
            .filter_map(|s| s.parse().ok())
            .filter(|pid| *pid != self_pid)
            .collect();
        pids.sort_unstable();
        pids.dedup();
        return pids;
    }
    Vec::new()
}

#[cfg(windows)]
fn pids_listening_on_port(port: u16) -> Vec<u32> {
    let Ok(output) = Command::new("netstat").args(["-ano", "-p", "tcp"]).output() else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let needle = format!(":{port}");
    let self_pid = std::process::id();
    let mut pids = Vec::new();
    for line in text.lines() {
        if !line.contains("LISTENING") || !line.contains(&needle) {
            continue;
        }
        let Some(pid) = line
            .split_whitespace()
            .last()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        if pid != 0 && pid != self_pid {
            pids.push(pid);
        }
    }
    pids.sort_unstable();
    pids.dedup();
    pids
}

#[cfg(unix)]
fn kill_process(pid: u32, force: bool) {
    if force {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
    } else {
        let _ = Command::new("kill").arg(pid.to_string()).status();
    }
}

#[cfg(windows)]
fn kill_process(pid: u32, _force: bool) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .status();
}

/// 清理占用语音后端 WS/HTTP 端口的残留进程（上次崩溃或重复拉起留下的孤儿）。
fn clear_stale_voice_listeners(ws_port: u16) -> bool {
    let mut killed = false;
    for port in [ws_port, ws_port.saturating_add(100)] {
        for pid in pids_listening_on_port(port) {
            eprintln!("[voice-service] 清理占用 :{port} 的进程 pid={pid}");
            kill_process(pid, false);
            killed = true;
        }
    }
    if !killed {
        // bind 显示忙但 lsof 没列出 PID 时，仍当作失败（调用方决定是否继续 spawn）。
        return !port_listener_busy(ws_port) && !port_listener_busy(ws_port.saturating_add(100));
    }
    std::thread::sleep(Duration::from_millis(400));
    for port in [ws_port, ws_port.saturating_add(100)] {
        for pid in pids_listening_on_port(port) {
            eprintln!("[voice-service] 强制结束 pid={pid}（:{port}）");
            kill_process(pid, true);
        }
    }
    // TIME_WAIT / 进程退出后再给一点时间，避免立刻 bind 仍 EADDRINUSE。
    std::thread::sleep(Duration::from_millis(350));
    !port_listener_busy(ws_port) && !port_listener_busy(ws_port.saturating_add(100))
}

/// 端口被占但健康检查未通过时，清理残留监听进程；成功清理返回 true。
fn reclaim_voice_ports_if_stale(ws_port: u16) -> bool {
    if service_running(ws_port) {
        return false;
    }
    if !port_listener_busy(ws_port) && !port_listener_busy(ws_port.saturating_add(100)) {
        return false;
    }
    eprintln!("[voice-service] :{ws_port} 被占用但健康检查未通过，清理残留进程后重试…");
    clear_stale_voice_listeners(ws_port)
}

/// 定位含 `scripts/local-realtime` 的根目录（开发仓库或安装目录）。
pub fn repo_root() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("KXYY_REPO_ROOT") {
        let p = PathBuf::from(p);
        if p.join("scripts/local-realtime").is_dir()
            || p.join("scripts/local-realtime").join("server.py").is_file()
        {
            return Some(p);
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(dev) = manifest.parent() {
        if dev.join("scripts/local-realtime").is_dir() {
            return Some(dev.to_path_buf());
        }
    }
    if let Ok(mut exe) = std::env::current_exe() {
        let _ = exe.pop();
        for _ in 0..8 {
            if exe.join("scripts/local-realtime").is_dir()
                || exe
                    .join("scripts/local-realtime")
                    .join("server.py")
                    .is_file()
            {
                return Some(exe);
            }
            if !exe.pop() {
                break;
            }
        }
    }
    None
}

/// 内置参考音文件指纹（size+mtime）。替换 assets/<card>/ref.* 后保存设置可触发本地 TTS 重启。
pub fn builtin_ref_stamp(persona_card_id: &str) -> String {
    let Some(repo) = repo_root() else {
        return String::new();
    };
    let card = {
        let t = persona_card_id.trim();
        if t.is_empty() {
            "kxyy-yuanyuan"
        } else {
            t
        }
    };
    let dir = repo.join("scripts/local-realtime/assets").join(card);
    for name in ["ref.wav", "ref.mp3", "ref.m4a", "ref.flac", "ref.ogg"] {
        let p = dir.join(name);
        if let Ok(meta) = p.metadata() {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            return format!("{}:{}:{}", name, meta.len(), mtime);
        }
    }
    String::new()
}

/// 打包后资源可能在 resource_dir；优先仓库/安装根，其次 resource_dir。
fn scripts_root(app: &AppHandle) -> Option<PathBuf> {
    if let Some(r) = repo_root() {
        return Some(r);
    }
    if let Ok(dir) = app.path().resource_dir() {
        if dir.join("scripts/local-realtime").is_dir()
            || dir
                .join("scripts/local-realtime")
                .join("server.py")
                .is_file()
        {
            return Some(dir);
        }
        // 有的布局是 resource_dir 本身即 scripts 的父级
        if dir.join("local-realtime").is_dir() {
            return dir.parent().map(|p| p.to_path_buf());
        }
    }
    None
}

/// macOS 打包后 Qwen3 运行时（venv / 参考音），可写目录。
#[cfg(target_os = "macos")]
fn macos_voice_runtime() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        PathBuf::from(home)
            .join("Library/Application Support/com.aaronfang.kxyydesktoppet/voice-runtime"),
    )
}

#[cfg(not(target_os = "macos"))]
fn macos_voice_runtime() -> Option<PathBuf> {
    None
}

fn python_candidates(repo: &Path, backend: &str) -> Vec<PathBuf> {
    let mut list = Vec::new();
    // macOS：优先使用自动配置的 Application Support venv
    if backend == "local" {
        if let Some(rt) = macos_voice_runtime() {
            list.push(rt.join(".venv/bin/python"));
        }
        // Windows / Linux：本地 Qwen3-TTS 走官方 PyTorch 包（qwen-tts），
        // 用独立环境 .venv-qwen3（由 scripts/windows/setup-qwen3-tts.ps1 创建）。
        list.push(repo.join("scripts/local-realtime/.venv-qwen3/bin/python"));
        list.push(repo.join("scripts/local-realtime/.venv-qwen3/Scripts/python.exe"));
    }
    // GPU 后端优先用各自独立环境
    if backend == "cosyvoice" {
        list.push(repo.join("scripts/local-realtime/.venv-cosy/bin/python"));
        list.push(repo.join("scripts/local-realtime/.venv-cosy/Scripts/python.exe"));
    }
    list.push(repo.join("scripts/voice-ab/.venv/bin/python"));
    list.push(repo.join("scripts/voice-ab/.venv/Scripts/python.exe"));
    list.push(repo.join("scripts/local-realtime/.venv/bin/python"));
    list.push(repo.join("scripts/local-realtime/.venv/Scripts/python.exe"));
    // Windows：显式探测已知 Python 安装位置（绝对路径）。
    // GUI 进程从 explorer 启动时继承的 PATH 常**不包含**用户 shell 的 PATH，
    // 容易落到 `WindowsApps\python.exe`（0 字节 App Execution Alias → 跳 Store）。
    // 提前探测这些已知位置，绕开 PATH 搜索。
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            // Python Launcher（Windows 官方，会自动选最高版本）
            list.push(PathBuf::from(&local).join("Programs/Python/Launcher/py.exe"));
            // 用户级 Python 安装（python.org 安装器默认位置）
            for ver in &["314", "313", "312", "311", "310", "39"] {
                list.push(
                    PathBuf::from(&local).join(format!("Programs/Python/Python{ver}/python.exe")),
                );
            }
        }
        if let Ok(pf) = std::env::var("PROGRAMFILES") {
            for ver in &["314", "313", "312", "311", "310", "39"] {
                list.push(PathBuf::from(&pf).join(format!("Python{ver}/python.exe")));
            }
        }
        if let Ok(pf86) = std::env::var("PROGRAMFILES(x86)") {
            for ver in &["314", "313", "312", "311", "310", "39"] {
                list.push(PathBuf::from(&pf86).join(format!("Python{ver}/python.exe")));
            }
        }
    }
    // PATH 里的解释器
    list.push(PathBuf::from("python3"));
    list.push(PathBuf::from("python"));
    list
}

/// 在 PATH 中查找裸命令名，返回首个可执行文件路径（Windows 兼容 .exe）。
///
/// Windows 上会跳过 0 字节文件——`C:\Users\<u>\AppData\Local\Microsoft\WindowsApps\python.exe`
/// 是 App Execution Alias（reparse point + 0 字节），spawn 它会跳 Microsoft Store，
/// 触发 "Python was not found; run without arguments to install from the Microsoft Store" 误报。
pub(crate) fn which_in_path(name: &Path) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        // 先尝试原名（含 .exe / 无后缀），再尝试 Windows 下追加 .exe
        #[cfg(windows)]
        let candidates: [PathBuf; 2] =
            [dir.join(name), dir.join(format!("{}.exe", name.display()))];
        #[cfg(not(windows))]
        let candidates: [PathBuf; 2] = [dir.join(name), dir.join(name)];
        for cand in &candidates {
            match std::fs::metadata(cand) {
                Ok(md) if md.is_file() => {
                    // Windows App Execution Alias 是 0 字节 + reparse point；
                    // 这里用长度过滤避免命中 Store 跳转器。
                    if cfg!(windows) && md.len() == 0 {
                        continue;
                    }
                    return Some(cand.clone());
                }
                _ => {}
            }
        }
    }
    None
}

fn resolve_python(repo: &Path, backend: &str) -> Option<PathBuf> {
    for p in python_candidates(repo, backend) {
        if p.components().count() == 1 {
            // 裸名：确认 PATH 中确实存在再返回，否则继续下一候选。
            // 否则几乎总返回 Some，系统真无 Python 时会误报「启动失败」而非「找不到 Python」。
            if which_in_path(&p).is_some() {
                return Some(p);
            }
            continue;
        }
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn stop_inner(inner: &mut Inner) {
    if let Some(mut child) = inner.child.take() {
        let pid = child.id();
        let _ = child.kill();
        let _ = child.wait();
        eprintln!("[voice-service] 已停止托管进程 pid={pid}");
    }
    inner.backend.clear();
    inner.voice_fingerprint.clear();
    if let Ok(mut q) = inner.recent_logs.lock() {
        q.clear();
    }
}

fn dirs_settings_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        return Some(
            PathBuf::from(home)
                .join("Library/Application Support/com.aaronfang.kxyydesktoppet/settings.json"),
        );
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA")?;
        return Some(
            PathBuf::from(appdata)
                .join("com.aaronfang.kxyydesktoppet")
                .join("settings.json"),
        );
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let home = std::env::var_os("HOME")?;
        Some(PathBuf::from(home).join(".config/com.aaronfang.kxyydesktoppet/settings.json"))
    }
}

fn resolve_user_path(repo: &Path, configured: &str, default_rel: &str) -> PathBuf {
    let p = configured.trim();
    if p.is_empty() {
        return repo.join(default_rel);
    }
    let path = PathBuf::from(p);
    if path.is_absolute() {
        path
    } else {
        repo.join(path)
    }
}

/// Windows：NSIS 安装默认根目录。
/// 多数情况下就是 `%LOCALAPPDATA%\元元桌宠`；老版本可能是 `Programs\元元桌宠`。
fn install_roots() -> Vec<PathBuf> {
    let mut list = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        list.push(PathBuf::from(&local).join("元元桌宠"));
        list.push(PathBuf::from(&local).join("Programs").join("元元桌宠"));
    }
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        list.push(
            PathBuf::from(&userprofile)
                .join("AppData")
                .join("Local")
                .join("元元桌宠"),
        );
    }
    list
}

/// 解析"实际包含目标子目录"的根目录（repo 概念上的根 = scripts 的父级）。
///
/// - 用户未配置：先看 `repo/<sub>`，存在则用 repo；否则依次试 install 根。
///   都没有则返回 repo（保留原错误信息，UI 表现不变）。
/// - 用户显式配置了相对路径：拼到 repo 后用 repo 作 root。
/// - 用户显式配置了绝对路径：尝试把 path 解析为"scripts/local-realtime/..."的某层；
///   是的话往上回溯到"scripts 的父级"；否则直接用 path 自身作 root（保守兜底）。
fn pick_active_root(repo: &Path, configured: &str, sub: &str) -> PathBuf {
    let p = configured.trim();
    if p.is_empty() {
        let primary = repo.join(sub);
        if primary.is_dir() {
            return repo.to_path_buf();
        }
        for r in install_roots() {
            if r.join(sub).is_dir() {
                return r;
            }
        }
        return repo.to_path_buf();
    }
    let path = PathBuf::from(p);
    if !path.is_absolute() {
        return repo.to_path_buf();
    }
    // 绝对路径：探测是否形如 <root>/scripts/local-realtime/<...> 或
    // <root>/scripts/local-realtime/pretrained_models/<...>。是的话回溯到 root。
    let mut cur: Option<&Path> = Some(path.as_path());
    while let Some(c) = cur {
        if c.file_name()
            .map(|n| n == "local-realtime")
            .unwrap_or(false)
        {
            if let Some(scripts) = c.parent() {
                if scripts.file_name().map(|n| n == "scripts").unwrap_or(false) {
                    if let Some(root) = scripts.parent() {
                        return root.to_path_buf();
                    }
                }
            }
        }
        cur = c.parent();
    }
    path
}

pub fn read_setting_str(key: &str) -> String {
    let Some(p) = dirs_settings_path() else {
        return String::new();
    };
    let Ok(raw) = std::fs::read_to_string(p) else {
        return String::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return String::new();
    };
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn read_setting_bool(key: &str) -> bool {
    let Some(p) = dirs_settings_path() else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(p) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(false)
}

fn vad_runtime_root() -> Option<PathBuf> {
    Some(dirs_settings_path()?.parent()?.join("vad-runtime"))
}

fn sensevoice_runtime_root() -> Option<PathBuf> {
    Some(
        dirs_settings_path()?
            .parent()?
            .join("sensevoice-asr-runtime"),
    )
}

fn supports_vad_runtime_install(backend: &str) -> bool {
    matches!(backend, "local" | "cosyvoice")
}

fn begin_vad_runtime_install(inner: &mut Inner, backend: &str) -> bool {
    if inner.qwen_setup_running
        || !inner.vad_install_backend.is_empty()
        || !inner.sensevoice_install_backend.is_empty()
    {
        return false;
    }
    inner.vad_install_backend = backend.to_string();
    true
}

fn begin_sensevoice_runtime_install(
    inner: &mut Inner,
    backend: &str,
    asr_provider: &str,
    fingerprint: &str,
) -> bool {
    if inner.qwen_setup_running
        || !inner.vad_install_backend.is_empty()
        || !inner.sensevoice_install_backend.is_empty()
    {
        return false;
    }
    inner.sensevoice_install_backend = backend.to_string();
    inner.sensevoice_install_provider = normalize_asr_provider(asr_provider);
    inner.sensevoice_install_fingerprint = fingerprint.to_string();
    true
}

fn finish_sensevoice_runtime_install(inner: &mut Inner, backend: &str) {
    if inner.sensevoice_install_backend == backend {
        inner.sensevoice_install_backend.clear();
        inner.sensevoice_install_provider.clear();
        inner.sensevoice_install_fingerprint.clear();
    }
}

fn sensevoice_install_matches_target(
    inner: &Inner,
    backend: &str,
    asr_provider: &str,
    fingerprint: &str,
) -> bool {
    inner.sensevoice_install_backend == backend
        && inner.sensevoice_install_provider == normalize_asr_provider(asr_provider)
        && inner.sensevoice_install_fingerprint == fingerprint
}

fn finish_vad_runtime_install(inner: &mut Inner, backend: &str) {
    if inner.vad_install_backend == backend {
        inner.vad_install_backend.clear();
    }
}

fn should_defer_for_vad_install(requested_backend: &str, installing_backend: &str) -> bool {
    !installing_backend.is_empty() && requested_backend == installing_backend
}

fn record_desired_voice_config(
    inner: &mut Inner,
    backend: &str,
    asr_provider: &str,
    fingerprint: &str,
) {
    inner.desired_backend = backend.to_string();
    inner.desired_asr_provider = normalize_asr_provider(asr_provider);
    inner.desired_fingerprint = fingerprint.to_string();
    inner.desired_epoch = inner.desired_epoch.saturating_add(1);
}

fn voice_target_still_selected(
    inner: &Inner,
    backend: &str,
    asr_provider: &str,
    fingerprint: &str,
) -> bool {
    inner.desired_backend == backend
        && inner.desired_asr_provider == normalize_asr_provider(asr_provider)
        && inner.desired_fingerprint == fingerprint
}

fn backend_still_selected(inner: &Inner, completed_backend: &str) -> bool {
    inner.desired_backend == completed_backend
}

pub fn install_vad_shadow_runtime(app: &AppHandle, backend_raw: &str) -> Result<(), String> {
    let backend = normalize_backend(backend_raw);
    if !supports_vad_runtime_install(&backend) {
        return Err("请先选择本地 Qwen3-TTS 或 CosyVoice 后端".into());
    }
    let repo = scripts_root(app).ok_or_else(|| "找不到随包语音资源".to_string())?;
    let script = repo
        .join("scripts/local-realtime")
        .join("install_vad_runtime.py");
    if !script.is_file() {
        return Err("安装脚本未随应用提供".into());
    }
    let python = resolve_python(&repo, &backend)
        .ok_or_else(|| "当前语音后端的 Python 运行时尚未就绪".to_string())?;
    let runtime_root = vad_runtime_root().ok_or_else(|| "无法定位 App 数据目录".to_string())?;

    let manager = app.state::<VoiceServiceManager>();
    let lifecycle = manager.lifecycle.lock().map_err(|_| "语音服务状态不可用")?;
    let should_stop = {
        let mut inner = manager.inner.lock().map_err(|_| "语音服务状态不可用")?;
        if !begin_vad_runtime_install(&mut inner, &backend) {
            return Err("已有语音运行时安装任务正在进行".into());
        }
        backend_still_selected(&inner, &backend)
    };

    // 安装器可能修复已存在的 target；先停掉当前相同后端，避免 Windows
    // 在 Python worker 持有 ORT DLL 时尝试目录交换。失败后也会恢复 RMS 服务。
    if should_stop {
        stop(app);
    }
    drop(lifecycle);

    let app2 = app.clone();
    std::thread::spawn(move || {
        let _ = app2.emit(
            "vad-shadow-install-status",
            serde_json::json!({"state":"installing","message":"正在安装实验性 VAD runtime…"}),
        );
        let mut cmd = Command::new(&python);
        cmd.arg(&script)
            .current_dir(script.parent().unwrap_or(Path::new(".")))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env("KXYY_VAD_RUNTIME_ROOT", &runtime_root)
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .env("PATH", augmented_tool_path());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let success = cmd.status().map(|status| status.success()).unwrap_or(false);
        let manager = app2.state::<VoiceServiceManager>();
        let Ok(_lifecycle) = manager.lifecycle.lock() else {
            return;
        };
        let (still_selected, current_backend, current_fp) = match manager.inner.lock() {
            Ok(mut inner) => {
                finish_vad_runtime_install(&mut inner, &backend);
                (
                    backend_still_selected(&inner, &backend),
                    inner.desired_backend.clone(),
                    inner.desired_fingerprint.clone(),
                )
            }
            Err(_) => return,
        };
        if success {
            if still_selected {
                let _ = app2.emit(
                    "vad-shadow-install-status",
                    serde_json::json!({"state":"ready","message":"VAD runtime 已就绪，正在重启当前语音服务…"}),
                );
                ensure_impl(&app2, current_backend, current_fp);
            } else {
                let _ = app2.emit(
                    "vad-shadow-install-status",
                    serde_json::json!({"state":"ready","message":"VAD runtime 已就绪；当前语音后端已改变，未重启服务"}),
                );
            }
        } else {
            if still_selected {
                let _ = app2.emit(
                    "vad-shadow-install-status",
                    serde_json::json!({"state":"failed","message":"VAD runtime 安装失败；正在恢复原 RMS 语音服务"}),
                );
                ensure_impl(&app2, current_backend, current_fp);
            } else {
                let _ = app2.emit(
                    "vad-shadow-install-status",
                    serde_json::json!({"state":"failed","message":"VAD runtime 安装失败；当前语音后端已改变，未重启服务"}),
                );
            }
        }
    });
    Ok(())
}

/// 显式安装可选 SenseVoice final ASR runtime。安装器只接收独立 App-data 根目录；
/// 完成回调必须仍匹配 backend + provider + fingerprint，避免旧任务复活新设置。
pub fn install_sensevoice_runtime(app: &AppHandle, backend_raw: &str) -> Result<(), String> {
    let backend = normalize_backend(backend_raw);
    if !supports_vad_runtime_install(&backend) {
        return Err("请先选择本地 Qwen3-TTS 或 CosyVoice 后端".into());
    }
    let asr_provider = normalize_asr_provider(&read_setting_str("asrProvider"));
    if asr_provider != "sensevoice" {
        return Err("请先选择 SenseVoice 并保存设置".into());
    }
    let repo = scripts_root(app).ok_or_else(|| "找不到随包语音资源".to_string())?;
    let script = repo
        .join("scripts/local-realtime")
        .join("install_sensevoice_runtime.py");
    if !script.is_file() {
        return Err("SenseVoice 安装脚本未随应用提供".into());
    }
    let python = resolve_python(&repo, &backend)
        .ok_or_else(|| "当前语音后端的 Python 运行时尚未就绪".to_string())?;
    let runtime_root =
        sensevoice_runtime_root().ok_or_else(|| "无法定位 App 数据目录".to_string())?;

    let manager = app.state::<VoiceServiceManager>();
    let lifecycle = manager.lifecycle.lock().map_err(|_| "语音服务状态不可用")?;
    let install_fingerprint = {
        let mut inner = manager.inner.lock().map_err(|_| "语音服务状态不可用")?;
        let fingerprint = inner.desired_fingerprint.clone();
        if !begin_sensevoice_runtime_install(&mut inner, &backend, &asr_provider, &fingerprint) {
            return Err("已有语音运行时安装任务正在进行".into());
        }
        fingerprint
    };
    stop(app);
    drop(lifecycle);

    let app2 = app.clone();
    std::thread::spawn(move || {
        let _ = app2.emit(
            "sensevoice-runtime-install-progress",
            serde_json::json!({"state":"installing","message":"正在安装可选 SenseVoice runtime…"}),
        );
        let mut cmd = Command::new(&python);
        cmd.arg(&script)
            .current_dir(script.parent().unwrap_or(Path::new(".")))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env("KXYY_ASR_RUNTIME_ROOT", &runtime_root)
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .env("PATH", augmented_tool_path());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut failure_detail = None;
        let success = match cmd.spawn() {
            Ok(mut child) => {
                if let Some(stdout) = child.stdout.take() {
                    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                        let Some(payload) = parse_sensevoice_install_progress(&line) else {
                            continue;
                        };
                        if payload.get("state").and_then(|value| value.as_str()) == Some("failed") {
                            failure_detail = payload
                                .get("message")
                                .and_then(|value| value.as_str())
                                .map(ToOwned::to_owned);
                        }
                        let _ = app2.emit("sensevoice-runtime-install-progress", payload);
                    }
                }
                child.wait().map(|status| status.success()).unwrap_or(false)
            }
            Err(_) => false,
        };
        let manager = app2.state::<VoiceServiceManager>();
        let Ok(_lifecycle) = manager.lifecycle.lock() else {
            return;
        };
        let (still_selected, current_backend, current_fp) = match manager.inner.lock() {
            Ok(mut inner) => {
                finish_sensevoice_runtime_install(&mut inner, &backend);
                (
                    voice_target_still_selected(
                        &inner,
                        &backend,
                        &asr_provider,
                        &install_fingerprint,
                    ),
                    inner.desired_backend.clone(),
                    inner.desired_fingerprint.clone(),
                )
            }
            Err(_) => return,
        };
        let (state, message) = match (success, still_selected) {
            (true, true) => (
                "ready",
                "SenseVoice runtime 已就绪，正在重启当前语音服务…".to_string(),
            ),
            (true, false) => (
                "ready",
                "SenseVoice runtime 已就绪；当前语音设置已改变，未重启服务".to_string(),
            ),
            (false, true) => {
                let detail = failure_detail
                    .as_deref()
                    .unwrap_or("SenseVoice runtime 安装失败");
                ("failed", format!("{detail}；正在恢复当前语音服务"))
            }
            (false, false) => {
                let detail = failure_detail
                    .as_deref()
                    .unwrap_or("SenseVoice runtime 安装失败");
                (
                    "failed",
                    format!("{detail}；当前语音设置已改变，未重启服务"),
                )
            }
        };
        let _ = app2.emit(
            "sensevoice-runtime-install-progress",
            serde_json::json!({"state":state,"message":message}),
        );
        if still_selected {
            ensure_impl(&app2, current_backend, current_fp);
        }
    });
    Ok(())
}

const DEFAULT_HF_ENDPOINT: &str = "https://huggingface.co";

/// Hugging Face endpoint：显式 settings/env 优先，默认使用官方站点。
///
/// 旧默认 `hf-mirror.com` 属于非官方单点依赖；已有模型缓存会掩盖其故障，
/// 新模型首次下载时则直接导致语音服务无法启动。需要镜像的用户仍可通过
/// settings.json 的 `hfEndpoint` 或父进程 `HF_ENDPOINT` 明确覆盖。
fn resolve_hf_endpoint(custom: &str, inherited: Option<&str>) -> String {
    let custom = custom.trim();
    if !custom.is_empty() {
        return custom.trim_end_matches('/').to_string();
    }

    let inherited = inherited.unwrap_or_default().trim();
    if !inherited.is_empty() {
        return inherited.trim_end_matches('/').to_string();
    }
    DEFAULT_HF_ENDPOINT.into()
}

fn hf_endpoint() -> String {
    let custom = read_setting_str("hfEndpoint");
    let inherited = std::env::var("HF_ENDPOINT").ok();
    resolve_hf_endpoint(&custom, inherited.as_deref())
}

fn emit_setup_progress(
    app: &AppHandle,
    line: String,
    lines: &Arc<Mutex<VecDeque<String>>>,
    backend: &str,
    port: u16,
) {
    eprintln!("[setup-{backend}] {line}");
    if let Ok(mut q) = lines.lock() {
        q.push_back(line.clone());
        while q.len() > SETUP_LOG_MAX_LINES {
            q.pop_front();
        }
    }
    emit(
        app,
        VoiceServiceStatus {
            backend: backend.into(),
            state: "starting".into(),
            message: line,
            port,
        },
    );
}

/// 清洗脚本输出，供设置页展示。
fn format_setup_line(raw: &str) -> Option<String> {
    let line = raw.trim();
    if line.is_empty() {
        return None;
    }
    // 去掉 ANSI 转义序列（颜色/光标控制）
    let mut cleaned = String::new();
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\u{1b}' && i + 1 < chars.len() && chars[i + 1] == '[' {
            // 跳过 CSI 序列直到字母
            i += 2;
            while i < chars.len() && !chars[i].is_alphabetic() {
                i += 1;
            }
            if i < chars.len() {
                i += 1;
            } // 跳过结尾字母
            continue;
        }
        cleaned.push(chars[i]);
        i += 1;
    }
    let line = cleaned.trim();
    if line.is_empty() {
        return None;
    }
    // 纯控制字符行跳过
    if line
        .chars()
        .all(|c| c.is_whitespace() || c == '[' || c == ']')
    {
        return None;
    }
    Some(line.to_string())
}

/// 运行 macOS Qwen3 自动配置脚本（阻塞，可能数分钟）；逐行 emit 进度。
#[cfg(target_os = "macos")]
fn run_macos_qwen3_setup(app: &AppHandle, repo: &Path, runtime: &Path) -> Result<(), String> {
    let setup = repo.join("scripts/macos/setup-qwen3-tts.sh");
    if !setup.is_file() {
        return Err(format!(
            "缺少配置脚本：{}。请确认安装包包含 scripts/macos。",
            setup.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&setup) {
            let mut perms = meta.permissions();
            perms.set_mode(perms.mode() | 0o755);
            let _ = std::fs::set_permissions(&setup, perms);
        }
    }

    let mut child = Command::new("bash")
        .arg(&setup)
        .env("KXYY_VOICE_RUNTIME", runtime)
        .env("KXYY_VOICE_RESOURCES", repo)
        .env("PYTHONUNBUFFERED", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动配置脚本：{e}"))?;

    let last_lines = Arc::new(Mutex::new(VecDeque::<String>::new()));
    let backend_port = port_for("local");

    let mut handles = vec![];
    if let Some(out) = child.stdout.take() {
        let app2 = app.clone();
        let lines = Arc::clone(&last_lines);
        handles.push(std::thread::spawn(move || {
            for line in BufReader::new(out).lines().flatten() {
                if let Some(msg) = format_setup_line(&line) {
                    emit_setup_progress(&app2, msg, &lines, "local", backend_port);
                }
            }
        }));
    }
    if let Some(err) = child.stderr.take() {
        let app2 = app.clone();
        let lines = Arc::clone(&last_lines);
        handles.push(std::thread::spawn(move || {
            for line in BufReader::new(err).lines().flatten() {
                if let Some(msg) = format_setup_line(&line) {
                    emit_setup_progress(&app2, msg, &lines, "local", backend_port);
                }
            }
        }));
    }

    let status = child.wait().map_err(|e| format!("等待配置脚本失败：{e}"))?;
    for h in handles {
        let _ = h.join();
    }

    if !status.success() {
        let detail = last_lines
            .lock()
            .ok()
            .map(|q| {
                q.iter()
                    .rev()
                    .take(3)
                    .cloned()
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join(" · ")
            })
            .unwrap_or_default();
        return Err(if detail.is_empty() {
            format!("Qwen3-TTS 自动配置失败（exit {status}）")
        } else {
            detail
        });
    }
    let marker = runtime.join(".qwen3-ready");
    let py = runtime.join(".venv/bin/python");
    if !(marker.is_file() && py.is_file()) {
        return Err("配置脚本已结束，但未生成 voice-runtime/.qwen3-ready".into());
    }
    Ok(())
}

/// 停止本应用托管的本地语音服务。
pub fn stop(app: &AppHandle) {
    if let Ok(mut inner) = app.state::<VoiceServiceManager>().inner.lock() {
        stop_inner(&mut inner);
    }
    emit(
        app,
        VoiceServiceStatus {
            backend: String::new(),
            state: "stopped".into(),
            message: "本地语音服务已停止".into(),
            port: 0,
        },
    );
}

/// 按当前语音后端确保服务在跑（volc 则停掉托管进程；空=关闭则不启动）。
/// `voice_fingerprint`：调用方生成的不透明配置指纹；不得包含可供日志展开的原值。
pub fn ensure(app: &AppHandle, backend_raw: &str, voice_fingerprint: &str) {
    let backend = normalize_backend(backend_raw);
    let asr_provider = normalize_asr_provider(&read_setting_str("asrProvider"));
    let fp = voice_fingerprint.trim().to_string();
    let manager = app.state::<VoiceServiceManager>();
    let Ok(_lifecycle) = manager.lifecycle.lock() else {
        return;
    };
    if let Ok(mut inner) = manager.inner.lock() {
        record_desired_voice_config(&mut inner, &backend, &asr_provider, &fp);
    }
    ensure_impl(app, backend, fp);
}

fn ensure_impl(app: &AppHandle, backend: String, fp: String) {
    let port = port_for(&backend);

    let current_asr_provider = normalize_asr_provider(&read_setting_str("asrProvider"));
    let (vad_installing_backend, defer_for_sensevoice_install) = app
        .state::<VoiceServiceManager>()
        .inner
        .lock()
        .ok()
        .map(|inner| {
            (
                inner.vad_install_backend.clone(),
                sensevoice_install_matches_target(&inner, &backend, &current_asr_provider, &fp),
            )
        })
        .unwrap_or_default();
    if should_defer_for_vad_install(&backend, &vad_installing_backend)
        || defer_for_sensevoice_install
    {
        emit(
            app,
            VoiceServiceStatus {
                backend,
                state: "starting".into(),
                message: "正在安装可选语音运行时；语音服务将在完成后恢复".into(),
                port,
            },
        );
        return;
    }

    // 关闭语音：停服务、不启动
    if backend.is_empty() {
        stop(app);
        emit(
            app,
            VoiceServiceStatus {
                backend: String::new(),
                state: "stopped".into(),
                message: "语音已关闭".into(),
                port: 0,
            },
        );
        return;
    }

    if backend == "volc" {
        stop(app);
        emit(
            app,
            VoiceServiceStatus {
                backend: "volc".into(),
                state: "skipped".into(),
                message: "火山后端无需本地 Python 服务".into(),
                port: 0,
            },
        );
        return;
    }

    let Some(script_name) = script_for(&backend) else {
        return;
    };

    // 本地参考音或 CosyVoice Key/音色/模型变化时必须重启，否则 Python 仍用旧配置。
    let prev_fp = app
        .state::<VoiceServiceManager>()
        .inner
        .lock()
        .ok()
        .map(|inner| inner.voice_fingerprint.clone())
        .unwrap_or_default();
    if should_restart_for_fingerprint(&backend, &prev_fp, &fp) && service_running(port) {
        eprintln!("[voice-service] 语音配置已变更，重启当前 TTS 服务");
        stop(app);
        let _ = clear_stale_voice_listeners(port);
    }

    // 端口已通且健康检查通过：外部或先前实例已在跑，不重复拉起。
    if service_running(port) {
        if let Ok(mut inner) = app.state::<VoiceServiceManager>().inner.lock() {
            // 若托管的是别的后端，先清掉记录（端口被占用说明目标服务已在）
            if inner.backend != backend {
                stop_inner(&mut inner);
            } else {
                // 同后端已在跑：刷新指纹后返回（未发生 need_ref_restart 的情况）
                if !fp.is_empty() {
                    inner.voice_fingerprint = fp.clone();
                }
                emit(
                    app,
                    VoiceServiceStatus {
                        backend: backend.clone(),
                        state: "running".into(),
                        message: format!("已在运行（:{port}）"),
                        port,
                    },
                );
                return;
            }
        } else {
            emit(
                app,
                VoiceServiceStatus {
                    backend: backend.clone(),
                    state: "running".into(),
                    message: format!("已在运行（:{port}）"),
                    port,
                },
            );
            return;
        }
        // backend mismatch 清掉后若端口仍被旧服务占用，下面会 reclaim / 拉起
        if service_running(port) {
            emit(
                app,
                VoiceServiceStatus {
                    backend: backend.clone(),
                    state: "running".into(),
                    message: format!("已在运行（:{port}）"),
                    port,
                },
            );
            return;
        }
    }

    // 端口被占但健康检查失败：优先清理残留（必须在 child_starting 之前，否则永远卡在「正在启动」）。
    if reclaim_voice_ports_if_stale(port) {
        if service_running(port) {
            emit(
                app,
                VoiceServiceStatus {
                    backend: backend.clone(),
                    state: "running".into(),
                    message: format!("已恢复（:{port}）"),
                    port,
                },
            );
            return;
        }
    }

    // 已托管同一后端且进程仍在
    if let Ok(mut inner) = app.state::<VoiceServiceManager>().inner.lock() {
        if inner.backend == backend {
            if let Some(child) = inner.child.as_mut() {
                match child.try_wait() {
                    Ok(None) => {
                        // 启动期保存新配置也必须立即重拉，不能等旧进程健康后继续使用旧 Key/音色。
                        if should_restart_for_fingerprint(&backend, &inner.voice_fingerprint, &fp) {
                            eprintln!("[voice-service] 启动期间语音配置已变更，重启当前 TTS 服务");
                            stop_inner(&mut inner);
                            // 进程还在，但端口被占且不健康 → 冲突/僵尸，停掉后重拉。
                        } else if port_listener_busy(port) && !service_running(port) {
                            stop_inner(&mut inner);
                        } else {
                            emit(
                                app,
                                VoiceServiceStatus {
                                    backend: backend.clone(),
                                    state: "starting".into(),
                                    message: "正在启动（加载模型中）…".into(),
                                    port,
                                },
                            );
                            return;
                        }
                    }
                    _ => {
                        let _ = inner.child.take();
                        inner.backend.clear();
                    }
                }
            }
        } else {
            stop_inner(&mut inner);
        }
    }

    let Some(repo) = scripts_root(app) else {
        emit(
            app,
            VoiceServiceStatus {
                backend: backend.clone(),
                state: "failed".into(),
                message:
                    "找不到 scripts/local-realtime。开发模式请从仓库运行；或设置 KXYY_REPO_ROOT。"
                        .into(),
                port,
            },
        );
        return;
    };

    // macOS：首次使用本地 Qwen3 时自动创建 venv、装依赖、预热模型。
    #[cfg(target_os = "macos")]
    if backend == "local" {
        if let Some(rt) = macos_voice_runtime() {
            let marker = rt.join(".qwen3-ready");
            let py = rt.join(".venv/bin/python");
            if !(marker.is_file() && py.is_file()) {
                // 在同一锁作用域内 check-and-set，避免两次 ensure 并发都读到 false 而重复拉起配置脚本。
                let already = match app.state::<VoiceServiceManager>().inner.lock() {
                    Ok(mut inner) => {
                        let was = inner.qwen_setup_running;
                        if !was {
                            inner.qwen_setup_running = true;
                        }
                        was
                    }
                    Err(_) => false,
                };
                if already {
                    emit(
                        app,
                        VoiceServiceStatus {
                            backend: backend.clone(),
                            state: "starting".into(),
                            message: "正在自动配置 Qwen3-TTS（安装依赖 / 下载模型）…".into(),
                            port,
                        },
                    );
                    return;
                }
                emit(
                    app,
                    VoiceServiceStatus {
                        backend: backend.clone(),
                        state: "starting".into(),
                        message: "首次使用：正在自动配置 Qwen3-TTS（需网络，可能数分钟）…".into(),
                        port,
                    },
                );
                let app2 = app.clone();
                let repo2 = repo.clone();
                let rt2 = rt.clone();
                std::thread::spawn(move || {
                    let result = run_macos_qwen3_setup(&app2, &repo2, &rt2);
                    let manager = app2.state::<VoiceServiceManager>();
                    let Ok(_lifecycle) = manager.lifecycle.lock() else {
                        return;
                    };
                    let (still_selected, current_fp) = match manager.inner.lock() {
                        Ok(mut inner) => {
                            inner.qwen_setup_running = false;
                            (
                                backend_still_selected(&inner, "local"),
                                inner.desired_fingerprint.clone(),
                            )
                        }
                        Err(_) => return,
                    };
                    match result {
                        Ok(()) => {
                            if still_selected {
                                emit(
                                    &app2,
                                    VoiceServiceStatus {
                                        backend: "local".into(),
                                        state: "starting".into(),
                                        message: "配置完成，正在启动语音服务…".into(),
                                        port: 19876,
                                    },
                                );
                                ensure_impl(&app2, "local".into(), current_fp);
                            }
                        }
                        Err(msg) => {
                            if still_selected {
                                emit(
                                    &app2,
                                    VoiceServiceStatus {
                                        backend: "local".into(),
                                        state: "failed".into(),
                                        message: msg,
                                        port: 19876,
                                    },
                                );
                            }
                        }
                    }
                });
                return;
            }
        }
    }

    let work_dir = repo.join("scripts/local-realtime");
    let script = work_dir.join(script_name);
    if !script.is_file() {
        emit(
            app,
            VoiceServiceStatus {
                backend: backend.clone(),
                state: "failed".into(),
                message: format!("脚本不存在：{}", script.display()),
                port,
            },
        );
        return;
    }

    let Some(python) = resolve_python(&repo, &backend) else {
        emit(
            app,
            VoiceServiceStatus {
                backend: backend.clone(),
                state: "failed".into(),
                message: if cfg!(target_os = "macos") {
                    "找不到 Python。请安装 Python 3.10+（Apple Silicon），将自动创建语音运行时。"
                        .into()
                } else if backend == "local" {
                    "找不到本地 Qwen3-TTS 运行环境。请运行 scripts/windows/setup-qwen3-tts.cmd 自动配置（创建 .venv-qwen3 并安装 qwen-tts）。".into()
                } else {
                    "找不到 Python。请先创建 scripts/voice-ab/.venv 并安装依赖。".into()
                },
                port,
            },
        );
        return;
    };

    // 拉起前再清一次，避免与外部残留 server.py 抢端口。
    let _ = reclaim_voice_ports_if_stale(port);

    emit(
        app,
        VoiceServiceStatus {
            backend: backend.clone(),
            state: "starting".into(),
            message: format!("正在启动 {} …", script_name),
            port,
        },
    );

    let mut cmd = Command::new(&python);
    cmd.arg(&script)
        .current_dir(&work_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // 共享 secret：本服务的 /tts 将据此校验请求，阻止任意本机进程刷云端计费。
        .env("KXYY_TTS_SECRET", tts_secret())
        // 强制子进程用 UTF-8 写 stdout/stderr。否则 Windows 上 Python 默认按系统代码页
        // （如 GBK）输出，我们的中文错误（SystemExit 提示等）会成为非法 UTF-8 字节，
        // 下方按行读取时被丢弃，导致设置页只看到空的「进程已退出」兜底文案。
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        // 默认使用 Hugging Face 官方站点；需要镜像时可通过 settings.json 的
        // hfEndpoint 或父进程 HF_ENDPOINT 显式覆盖。
        .env("HF_ENDPOINT", hf_endpoint())
        // IndexTTS-2 自带网络探测（TCP 443 握手）可能在墙内误判为"可直连"，
        // 导致 huggingface_hub.hf_hub_download 直连 HF 超时崩溃。
        // 强制 USE_MODELSCOPE=true 让其走 ModelScope → hf-mirror 回退链。
        .env("USE_MODELSCOPE", "true")
        .env("PATH", augmented_tool_path());
    // 本地实时语音的 LLM 统一走桌面 `/api/chat` 代理：provider/model/thinking
    // 与文字聊天共用当前设置，DeepSeek Key 不进入 Python 子进程环境。
    if let Some(base) = crate::local_api_base(app) {
        cmd.env("KXYY_AI_PROXY_BASE", base);
    }
    // macOS 打包运行时：把可写目录传给 Python（参考音 / 缓存路径）
    if let Some(rt) = macos_voice_runtime() {
        cmd.env("KXYY_VOICE_RUNTIME", &rt);
    }
    // Final ASR provider 只接受固定枚举；SenseVoice 使用独立 App-data runtime，
    // 不把模型或第三方依赖写入 Qwen/CosyVoice 自身环境。
    let asr_provider = normalize_asr_provider(&read_setting_str("asrProvider"));
    cmd.env("KXYY_ASR_PROVIDER", asr_provider);
    let turn_pause_tolerance =
        normalize_turn_pause_tolerance(&read_setting_str("turnPauseTolerance"));
    cmd.env("KXYY_TURN_PAUSE_TOLERANCE", turn_pause_tolerance);
    if let Some(root) = sensevoice_runtime_root() {
        cmd.env("KXYY_ASR_RUNTIME_ROOT", root);
    }
    if read_setting_bool("vadShadowEnabled") {
        if let Some(root) = vad_runtime_root() {
            cmd.env("KXYY_VAD_SHADOW", "1")
                .env("KXYY_VAD_RUNTIME_ROOT", root);
        }
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 独立进程组，退出时便于整体杀掉
        cmd.process_group(0);
    }

    // Windows：python.exe 是控制台程序，默认 spawn 会弹出黑色 cmd 窗口。
    // CREATE_NO_WINDOW 让子进程不分配控制台窗口（stdout/stderr 仍走管道，
    // 日志读取与上面的按行解析完全不受影响）。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit(
                app,
                VoiceServiceStatus {
                    backend: backend.clone(),
                    state: "failed".into(),
                    message: format!("启动失败：{e}（python={}）", python.display()),
                    port,
                },
            );
            return;
        }
    };

    let logs = match app.state::<VoiceServiceManager>().inner.lock() {
        Ok(inner) => {
            if let Ok(mut q) = inner.recent_logs.lock() {
                q.clear();
            }
            Arc::clone(&inner.recent_logs)
        }
        // 锁 poison 时不 panic，退化为独立缓冲（仅日志汇总丢失，不影响主流程）。
        Err(_) => Arc::new(Mutex::new(VecDeque::new())),
    };

    // 把子进程日志打到桌宠 stderr，并缓存最近行供失败提示。
    // 注意：用按字节读取 + lossy 解码，而非 BufReader::lines()。后者要求每行是合法
    // UTF-8，否则返回 Err 被 .flatten() 静默丢弃——Windows 下子进程若输出非 UTF-8
    // （中文报错等）会导致日志缓存为空，设置页只能显示兜底文案。
    if let Some(out) = child.stdout.take() {
        let logs = Arc::clone(&logs);
        std::thread::spawn(move || read_child_lines(out, "out", &logs));
    }
    if let Some(err) = child.stderr.take() {
        let logs = Arc::clone(&logs);
        std::thread::spawn(move || read_child_lines(err, "err", &logs));
    }

    let pid = child.id();
    if let Ok(mut inner) = app.state::<VoiceServiceManager>().inner.lock() {
        inner.backend = backend.clone();
        if !fp.is_empty() {
            inner.voice_fingerprint = fp.clone();
        }
        inner.child = Some(child);
    }

    // 后台等端口就绪或进程退出
    let app2 = app.clone();
    let backend2 = backend.clone();
    let logs2 = Arc::clone(&logs);
    std::thread::spawn(move || {
        // 给日志线程一点时间读完短错误输出
        std::thread::sleep(Duration::from_millis(80));
        // 首次下载可能远超 180 秒。只要受托管子进程仍存活，就继续探测；固定时限
        // 只能作为进度提示，不能把仍在下载/加载的健康进程误报为失败。
        for elapsed_secs in 0_u64.. {
            if service_running(port) {
                emit(
                    &app2,
                    VoiceServiceStatus {
                        backend: backend2.clone(),
                        state: "running".into(),
                        message: format!("已启动（:{port}，pid={pid}）"),
                        port,
                    },
                );
                return;
            }
            let exited = match app2.state::<VoiceServiceManager>().inner.lock() {
                Ok(mut inner) => {
                    let Some(child) = inner.child.as_mut() else {
                        // 已被新的 ensure 替换或 stop
                        return;
                    };
                    if child.id() != pid {
                        return;
                    }
                    match child.try_wait() {
                        Ok(Some(_)) => {
                            inner.child = None;
                            inner.backend.clear();
                            true
                        }
                        Ok(None) => false,
                        Err(_) => true,
                    }
                }
                Err(_) => return,
            };
            if exited {
                if !service_running(port) {
                    // 等日志线程刷完
                    std::thread::sleep(Duration::from_millis(150));
                    let detail = take_log_summary(&logs2);
                    let message = if detail.is_empty() {
                        "进程已退出，请查看终端日志（模型/依赖是否就绪）".into()
                    } else {
                        detail
                    };
                    emit(
                        &app2,
                        VoiceServiceStatus {
                            backend: backend2.clone(),
                            state: "failed".into(),
                            message,
                            port,
                        },
                    );
                }
                return;
            }
            if let Some(message) = startup_slow_message(&backend2, elapsed_secs) {
                emit(
                    &app2,
                    VoiceServiceStatus {
                        backend: backend2.clone(),
                        state: "starting".into(),
                        message: message.into(),
                        port,
                    },
                );
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}
