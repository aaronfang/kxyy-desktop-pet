//! 按设置自动拉起 / 切换本地语音 Python 服务（Qwen3 / CosyVoice 云桥 / CosyVoice3 开源）。
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
/// 端口就绪等待上限（秒）；模型加载可能较久（本地 Qwen / CosyVoice3）。
const START_TIMEOUT_SECS: u64 = 180;

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
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
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
}

struct Inner {
    /// 当前由本进程托管的后端（空 = 未托管）。
    backend: String,
    child: Option<Child>,
    /// 子进程最近日志（失败时带回设置页）。
    recent_logs: Arc<Mutex<VecDeque<String>>>,
    /// 正在跑自动配置脚本（macOS Qwen3 / Windows GPU）
    setup_running: bool,
}

impl VoiceServiceManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                backend: String::new(),
                child: None,
                recent_logs: Arc::new(Mutex::new(VecDeque::new())),
                setup_running: false,
            }),
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
fn read_child_lines<R: std::io::Read>(
    reader: R,
    tag: &str,
    logs: &Arc<Mutex<VecDeque<String>>>,
) {
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
        important.into_iter().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect()
    } else {
        q.iter().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect()
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
        "cosyvoice3" | "cosyvoice3-local" | "cv3" => "cosyvoice3".into(),
        "indextts2" | "index-tts2" | "itts2" => "indextts2".into(),
        _ => "volc".into(),
    }
}

/// Qwen3-TTS 跨平台（macOS mlx-audio / Windows+Linux PyTorch qwen-tts）；
/// GPU 大模型（IndexTTS-2 / CosyVoice3）仅面向 Windows(+NVIDIA)，macOS 不可用。
fn is_gpu_local_backend(backend: &str) -> bool {
    matches!(backend, "cosyvoice3" | "indextts2")
}

pub fn gpu_backends_supported() -> bool {
    // 安装器只在 Windows 提供配置向导；Linux 也可手动跑，macOS 禁用自动拉起。
    !cfg!(target_os = "macos")
}

pub fn port_for(backend: &str) -> u16 {
    match backend {
        "local" => 9876,
        "cosyvoice" => 9877,
        "cosyvoice3" => 9878,
        "indextts2" => 9879,
        _ => 0,
    }
}

fn script_for(backend: &str) -> Option<&'static str> {
    match backend {
        "local" => Some("server.py"),
        "cosyvoice" => Some("server_cosyvoice.py"),
        "cosyvoice3" => Some("server_cosyvoice3_local.py"),
        "indextts2" => Some("server_indextts2.py"),
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
    // 注意：`-tiTCP:9876` 必须写成「一个」参数（含冒号）。若拆成 `-tiTCP` + `9876`，
    // macOS/BSD lsof 会把 `9876` 当成文件名，清理永远失败，残留 server.py 就会报
    // Address already in use。
    let selector = format!("-tiTCP:{port}");
    for bin in ["/usr/sbin/lsof", "/usr/bin/lsof", "lsof"] {
        let Ok(output) = Command::new(bin)
            .args([&selector, "-sTCP:LISTEN"])
            .output()
        else {
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
        let Some(pid) = line.split_whitespace().last().and_then(|s| s.parse::<u32>().ok()) else {
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
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status();
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
    eprintln!(
        "[voice-service] :{ws_port} 被占用但健康检查未通过，清理残留进程后重试…"
    );
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
    if backend == "cosyvoice3" {
        list.push(repo.join("scripts/local-realtime/CosyVoice/.venv/bin/python"));
        list.push(repo.join("scripts/local-realtime/CosyVoice/.venv/Scripts/python.exe"));
        list.push(repo.join("scripts/local-realtime/.venv-cv3/bin/python"));
        list.push(repo.join("scripts/local-realtime/.venv-cv3/Scripts/python.exe"));
    }
    if backend == "indextts2" {
        list.push(repo.join("scripts/local-realtime/index-tts/.venv/bin/python"));
        list.push(repo.join("scripts/local-realtime/index-tts/.venv/Scripts/python.exe"));
        list.push(repo.join("scripts/local-realtime/.venv-itts2/bin/python"));
        list.push(repo.join("scripts/local-realtime/.venv-itts2/Scripts/python.exe"));
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
                    PathBuf::from(&local)
                        .join(format!("Programs/Python/Python{ver}/python.exe")),
                );
            }
        }
        if let Ok(pf) = std::env::var("PROGRAMFILES") {
            for ver in &["314", "313", "312", "311", "310", "39"] {
                list.push(
                    PathBuf::from(&pf).join(format!("Python{ver}/python.exe")),
                );
            }
        }
        if let Ok(pf86) = std::env::var("PROGRAMFILES(x86)") {
            for ver in &["314", "313", "312", "311", "310", "39"] {
                list.push(
                    PathBuf::from(&pf86).join(format!("Python{ver}/python.exe")),
                );
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
        let candidates: [PathBuf; 2] = [
            dir.join(name),
            dir.join(format!("{}.exe", name.display())),
        ];
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
    if let Ok(mut q) = inner.recent_logs.lock() {
        q.clear();
    }
}

/// CosyVoice3：启动前检查源码/权重是否就绪，避免只看到「进程已退出」。
///
/// 返回值是"激活的 repo 根"——若源码/权重实际位于 install 目录（NSIS 默认位置），
/// 会返回 install 根；否则返回原 repo。调用方应用这个根去生成 venv / 脚本路径。
pub fn preflight_cosyvoice3(repo: &Path) -> Result<PathBuf, String> {
    let model_dir_s = read_setting_str("cosyvoice3ModelDir");
    let repo_dir_s = read_setting_str("cosyvoice3RepoDir");

    let active = pick_active_root(repo, &repo_dir_s, "scripts/local-realtime/CosyVoice");
    let cv_repo = if repo_dir_s.trim().is_empty() {
        active.join("scripts/local-realtime/CosyVoice")
    } else {
        resolve_user_path(&active, &repo_dir_s, "scripts/local-realtime/CosyVoice")
    };
    let model_dir = resolve_user_path(
        &active,
        &model_dir_s,
        "scripts/local-realtime/pretrained_models/Fun-CosyVoice3-0.5B",
    );

    if !cv_repo.is_dir() {
        return Err(format!(
            "未找到 CosyVoice 源码。请先：git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git {}",
            active.join("scripts/local-realtime/CosyVoice").display()
        ));
    }
    if !model_dir.is_dir() {
        return Err(format!(
            "未找到权重目录 {}。请下载 FunAudioLLM/Fun-CosyVoice3-0.5B-2512 到该路径。",
            model_dir.display()
        ));
    }
    let has_weight = model_dir
        .read_dir()
        .map(|rd| {
            rd.flatten().any(|e| {
                let n = e.file_name().to_string_lossy().to_ascii_lowercase();
                n.contains("config")
                    || n.ends_with(".pt")
                    || n.ends_with(".pth")
                    || n.ends_with(".safetensors")
                    || n.ends_with(".onnx")
                    || e.path().is_dir()
            })
        })
        .unwrap_or(false);
    if !has_weight {
        return Err(format!(
            "权重目录为空：{}。请放入 Fun-CosyVoice3-0.5B 模型文件。",
            model_dir.display()
        ));
    }
    Ok(active)
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
        Some(
            PathBuf::from(home)
                .join(".config/com.aaronfang.kxyydesktoppet/settings.json"),
        )
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
        if c.file_name().map(|n| n == "local-realtime").unwrap_or(false) {
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

/// HF 镜像站点：默认用 hf-mirror.com（国内可用），可通过 settings.json 的 hfEndpoint 覆盖。
fn hf_mirror() -> String {
    let custom = read_setting_str("hfEndpoint");
    if !custom.is_empty() {
        return custom;
    }
    // 检查环境变量 HOSTNAME / 网络
    std::env::var("HF_ENDPOINT")
        .unwrap_or_else(|_| "https://hf-mirror.com".into())
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
            if i < chars.len() { i += 1; } // 跳过结尾字母
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
    if line.chars().all(|c| c.is_whitespace() || c == '[' || c == ']') {
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

    let status = child
        .wait()
        .map_err(|e| format!("等待配置脚本失败：{e}"))?;
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

/// 运行 Windows GPU 后端自动配置 PowerShell 脚本（阻塞，可能数分钟）；逐行 emit 进度。
#[cfg(target_os = "windows")]
fn run_gpu_auto_setup(app: &AppHandle, repo: &Path, backend: &str) -> Result<(), String> {
    let setup = repo.join("scripts/windows/setup-gpu-voice.ps1");
    if !setup.is_file() {
        return Err(format!(
            "缺少配置脚本：{}。请确认安装包完整。",
            setup.display()
        ));
    }
    let port = port_for(backend);

    emit(
        app,
        VoiceServiceStatus {
            backend: backend.into(),
            state: "starting".into(),
            message: format!("首次使用 {}：正在自动配置（git clone + 下载权重 + 安装依赖，可能数分钟）…", backend_label(backend)),
            port,
        },
    );

    let mut child = Command::new("powershell")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&setup)
        .arg("-NonInteractive")
        .arg("-Backend")
        .arg(backend)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动配置脚本 powershell：{e}"))?;

    let last_lines = Arc::new(Mutex::new(VecDeque::<String>::new()));
    let bk = backend.to_string();

    let mut handles = vec![];
    if let Some(out) = child.stdout.take() {
        let app2 = app.clone();
        let lines = Arc::clone(&last_lines);
        let bk2 = bk.clone();
        handles.push(std::thread::spawn(move || {
            for line in BufReader::new(out).lines().flatten() {
                if let Some(msg) = format_setup_line(&line) {
                    emit_setup_progress(&app2, msg, &lines, &bk2, port);
                }
            }
        }));
    }
    if let Some(err) = child.stderr.take() {
        let app2 = app.clone();
        let lines = Arc::clone(&last_lines);
        let bk3 = bk.clone();
        handles.push(std::thread::spawn(move || {
            for line in BufReader::new(err).lines().flatten() {
                if let Some(msg) = format_setup_line(&line) {
                    emit_setup_progress(&app2, msg, &lines, &bk3, port);
                }
            }
        }));
    }

    let status = child
        .wait()
        .map_err(|e| format!("等待配置脚本失败：{e}"))?;
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
            format!("{} 自动配置失败（exit {status}）", backend_label(backend))
        } else {
            detail
        });
    }
    Ok(())
}

#[cfg(windows)]
fn backend_label(backend: &str) -> String {
    match backend {
        "local" => "Qwen3-TTS".into(),
        "cosyvoice" => "CosyVoice".into(),
        "cosyvoice3" => "CosyVoice3".into(),
        "indextts2" => "IndexTTS-2".into(),
        "volc" => "火山引擎".into(),
        _ => backend.to_string(),
    }
}




/// IndexTTS-2：启动前检查源码/权重是否就绪，避免只看到「进程已退出」。
///
/// 返回值是"激活的 repo 根"——若源码/权重实际位于 install 目录（NSIS 默认位置），
/// 会返回 install 根；否则返回原 repo。调用方应用这个根去生成 venv / 脚本路径。
pub fn preflight_indextts2(repo: &Path) -> Result<PathBuf, String> {
    let model_dir_s = read_setting_str("indexTts2ModelDir");
    let repo_dir_s = read_setting_str("indexTts2RepoDir");

    let active = pick_active_root(repo, &repo_dir_s, "scripts/local-realtime/index-tts");
    let it_repo = if repo_dir_s.trim().is_empty() {
        active.join("scripts/local-realtime/index-tts")
    } else {
        resolve_user_path(&active, &repo_dir_s, "scripts/local-realtime/index-tts")
    };
    let model_dir = resolve_user_path(
        &active,
        &model_dir_s,
        "scripts/local-realtime/pretrained_models/IndexTTS-2",
    );
    if !it_repo.is_dir() {
        return Err(format!(
            "未找到 IndexTTS-2 源码。请先：git clone --recursive https://github.com/index-tts/index-tts.git {}",
            active.join("scripts/local-realtime/index-tts").display()
        ));
    }
    let cfg = model_dir.join("config.yaml");
    if !model_dir.is_dir() || !cfg.is_file() {
        return Err(format!(
            "未找到 IndexTTS-2 权重（需含 config.yaml）：{}。可用安装程序配置或手动下载 checkpoints。",
            model_dir.display()
        ));
    }
    Ok(active)
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

/// 按当前语音后端确保服务在跑（volc 则停掉托管进程）。
pub fn ensure(app: &AppHandle, backend_raw: &str) {
    let backend = normalize_backend(backend_raw);
    let port = port_for(&backend);

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

    if is_gpu_local_backend(&backend) && !gpu_backends_supported() {
        stop(app);
        emit(
            app,
            VoiceServiceStatus {
                backend: backend.clone(),
                state: "failed".into(),
                message: "macOS 不支持 GPU 本地模型（IndexTTS-2 / CosyVoice3）；请改用 Qwen3-TTS 本地后端（macOS / Windows / Linux 均可用）".into(),
                port: port_for(&backend),
            },
        );
        return;
    }

    let Some(script_name) = script_for(&backend) else {
        return;
    };

    // 端口已通且健康检查通过：外部或先前实例已在跑，不重复拉起。
    if service_running(port) {
        if let Ok(mut inner) = app.state::<VoiceServiceManager>().inner.lock() {
            // 若托管的是别的后端，先清掉记录（端口被占用说明目标服务已在）
            if inner.backend != backend {
                stop_inner(&mut inner);
            }
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
                        // 进程还在，但端口被占且不健康 → 冲突/僵尸，停掉后重拉。
                        if port_listener_busy(port) && !service_running(port) {
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
                message: "找不到 scripts/local-realtime。开发模式请从仓库运行；或设置 KXYY_REPO_ROOT。".into(),
                port,
            },
        );
        return;
    };

    // preflight 返回"激活的 repo 根"——若源码/权重实际位于 install 目录（NSIS 默认
    // 位置），返回 install 根，后续 python_candidates / spawn 走该路径。
    let mut repo = repo;
    #[cfg(windows)]
    if gpu_backends_supported() && (backend == "cosyvoice3" || backend == "indextts2") {
        let preflight_result = if backend == "cosyvoice3" {
            preflight_cosyvoice3(&repo).map(|active| active).map_err(|e| e)
        } else {
            preflight_indextts2(&repo).map(|active| active).map_err(|e| e)
        };
        match preflight_result {
            Ok(active) => repo = active,
            Err(_msg) => {
                // 预检查失败：启动自动配置（git clone + 下载权重 + venv）
                emit(
                    app,
                    VoiceServiceStatus {
                        backend: backend.clone(),
                        state: "starting".into(),
                        message: format!("首次使用 {}：正在自动配置环境（需网络，可能数分钟）…", backend_label(&backend)),
                        port,
                    },
                );
                let app2 = app.clone();
                let repo2 = repo.clone();
                let backend2 = backend.clone();
                std::thread::spawn(move || {
                    let result = run_gpu_auto_setup(&app2, &repo2, &backend2);
                    if let Ok(mut inner) = app2.state::<VoiceServiceManager>().inner.lock() {
                        inner.setup_running = false;
                    }
                    match result {
                        Ok(()) => {
                            emit(
                                &app2,
                                VoiceServiceStatus {
                                    backend: backend2.clone(),
                                    state: "starting".into(),
                                    message: "配置完成，正在启动语音服务…".into(),
                                    port: port_for(&backend2),
                                },
                            );
                            ensure(&app2, &backend2);
                        }
                        Err(err_msg) => {
                            emit(
                                &app2,
                                VoiceServiceStatus {
                                    backend: backend2.clone(),
                                    state: "failed".into(),
                                    message: err_msg,
                                    port: port_for(&backend2),
                                },
                            );
                        }
                    }
                });
                return;
            }
        }
    }
    #[cfg(not(windows))]
    {
        if backend == "cosyvoice3" {
            match preflight_cosyvoice3(&repo) {
                Ok(active) => repo = active,
                Err(msg) => {
                    emit(
                        app,
                        VoiceServiceStatus {
                            backend: backend.clone(),
                            state: "failed".into(),
                            message: msg,
                            port,
                        },
                    );
                    return;
                }
            }
        }
        if backend == "indextts2" {
            match preflight_indextts2(&repo) {
                Ok(active) => repo = active,
                Err(msg) => {
                    emit(
                        app,
                        VoiceServiceStatus {
                            backend: backend.clone(),
                            state: "failed".into(),
                            message: msg,
                            port,
                        },
                    );
                    return;
                }
            }
        }
    }

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
                        let was = inner.setup_running;
                        if !was {
                            inner.setup_running = true;
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
                    if let Ok(mut inner) = app2.state::<VoiceServiceManager>().inner.lock() {
                        inner.setup_running = false;
                    }
                    match result {
                        Ok(()) => {
                            emit(
                                &app2,
                                VoiceServiceStatus {
                                    backend: "local".into(),
                                    state: "starting".into(),
                                    message: "配置完成，正在启动语音服务…".into(),
                                    port: 9876,
                                },
                            );
                            ensure(&app2, "local");
                        }
                        Err(msg) => {
                            emit(
                                &app2,
                                VoiceServiceStatus {
                                    backend: "local".into(),
                                    state: "failed".into(),
                                    message: msg,
                                    port: 9876,
                                },
                            );
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
                    "找不到 Python。请安装 Python 3.10+（Apple Silicon），将自动创建语音运行时。".into()
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
        // HuggingFace 国内镜像（IndexTTS-2/CosyVoice3 需下载模型）;
        // 已在 pip 里配过镜像的可通过 settings.json 的 hfEndpoint 覆盖。
        .env("HF_ENDPOINT", hf_mirror())
        // IndexTTS-2 自带网络探测（TCP 443 握手）可能在墙内误判为"可直连"，
        // 导致 huggingface_hub.hf_hub_download 直连 HF 超时崩溃。
        // 强制 USE_MODELSCOPE=true 让其走 ModelScope → hf-mirror 回退链。
        .env("USE_MODELSCOPE", "true")
        .env("PATH", augmented_tool_path());
    // macOS 打包运行时：把可写目录传给 Python（参考音 / 缓存路径）
    if let Some(rt) = macos_voice_runtime() {
        cmd.env("KXYY_VOICE_RUNTIME", &rt);
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
        inner.child = Some(child);
    }

    // 后台等端口就绪或进程退出
    let app2 = app.clone();
    let backend2 = backend.clone();
    let logs2 = Arc::clone(&logs);
    std::thread::spawn(move || {
        // 给日志线程一点时间读完短错误输出
        std::thread::sleep(Duration::from_millis(80));
        // 模型加载可能较久（本地 Qwen / CosyVoice3）
        for _ in 0..START_TIMEOUT_SECS {
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
            std::thread::sleep(Duration::from_secs(1));
        }
        if service_running(port) {
            emit(
                &app2,
                VoiceServiceStatus {
                    backend: backend2,
                    state: "running".into(),
                    message: format!("已启动（:{port}）"),
                    port,
                },
            );
        } else {
            emit(
                &app2,
                VoiceServiceStatus {
                    backend: backend2,
                    state: "failed".into(),
                    message: format!(
                        "启动超时（{} 秒内端口未就绪），进程可能仍在加载模型",
                        START_TIMEOUT_SECS
                    ),
                    port,
                },
            );
        }
    });
}
