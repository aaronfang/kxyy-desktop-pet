//! 按设置自动拉起 / 切换本地语音 Python 服务（Qwen3 / CosyVoice 云桥 / CosyVoice3 开源）。
//! 火山后端不启 Python；若端口已被占用则视为外部已启动，不再重复拉起。

use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

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
    /// macOS 正在跑 setup-qwen3-tts.sh
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
        while q.len() > 30 {
            q.pop_front();
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

fn emit(app: &AppHandle, status: VoiceServiceStatus) {
    let _ = app.emit("voice-service-status", &status);
    eprintln!(
        "[voice-service] {} {} — {}",
        status.backend, status.state, status.message
    );
}

fn normalize_backend(backend: &str) -> String {
    match backend.trim().to_ascii_lowercase().as_str() {
        "local" => "local".into(),
        "cosyvoice" | "cosy" => "cosyvoice".into(),
        "cosyvoice3" | "cosyvoice3-local" | "cv3" => "cosyvoice3".into(),
        "indextts2" | "index-tts2" | "itts2" => "indextts2".into(),
        _ => "volc".into(),
    }
}

/// macOS 本地模型仅 Qwen3-TTS；GPU 大模型（IndexTTS-2 / CosyVoice3）面向 Windows(+NVIDIA)。
fn is_gpu_local_backend(backend: &str) -> bool {
    matches!(backend, "cosyvoice3" | "indextts2")
}

fn gpu_backends_supported() -> bool {
    // 安装器只在 Windows 提供配置向导；Linux 也可手动跑，macOS 禁用自动拉起。
    !cfg!(target_os = "macos")
}

fn port_for(backend: &str) -> u16 {
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

fn port_open(port: u16) -> bool {
    if port == 0 {
        return false;
    }
    let addr = format!("127.0.0.1:{port}");
    TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_millis(200)).is_ok()
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
    // PATH 里的解释器
    list.push(PathBuf::from("python3"));
    list.push(PathBuf::from("python"));
    list
}

fn resolve_python(repo: &Path, backend: &str) -> Option<PathBuf> {
    for p in python_candidates(repo, backend) {
        if p.components().count() == 1 {
            // bare name — 交给系统 PATH
            return Some(p);
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
fn preflight_cosyvoice3(repo: &Path) -> Result<(), String> {
    let model_dir_s = read_setting_str("cosyvoice3ModelDir");
    let repo_dir_s = read_setting_str("cosyvoice3RepoDir");

    let cv_repo = resolve_user_path(repo, &repo_dir_s, "scripts/local-realtime/CosyVoice");
    let model_dir = resolve_user_path(
        repo,
        &model_dir_s,
        "scripts/local-realtime/pretrained_models/Fun-CosyVoice3-0.5B",
    );

    if !cv_repo.is_dir() {
        return Err(format!(
            "未找到 CosyVoice 源码。请先：git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git {}",
            repo.join("scripts/local-realtime/CosyVoice").display()
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
    Ok(())
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

fn read_setting_str(key: &str) -> String {
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

fn emit_setup_progress(app: &AppHandle, line: String, lines: &Arc<Mutex<VecDeque<String>>>) {
    eprintln!("[setup-qwen3] {line}");
    if let Ok(mut q) = lines.lock() {
        q.push_back(line.clone());
        while q.len() > 40 {
            q.pop_front();
        }
    }
    emit(
        app,
        VoiceServiceStatus {
            backend: "local".into(),
            state: "starting".into(),
            message: line,
            port: 9876,
        },
    );
}

/// 清洗脚本输出，供设置页展示。
fn format_setup_line(raw: &str) -> Option<String> {
    let line = raw.trim();
    if line.is_empty() {
        return None;
    }
    // 去掉前缀，避免 UI 重复
    let line = line
        .strip_prefix("[setup-qwen3] ")
        .or_else(|| line.strip_prefix("[setup-qwen3]"))
        .unwrap_or(line)
        .trim();
    if line.is_empty() {
        return None;
    }
    // pip / hf 进度条里的纯控制字符行跳过
    if line.chars().all(|c| c.is_whitespace() || c == '\u{1b}' || c == '[') {
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

    let mut handles = vec![];
    if let Some(out) = child.stdout.take() {
        let app2 = app.clone();
        let lines = Arc::clone(&last_lines);
        handles.push(std::thread::spawn(move || {
            for line in BufReader::new(out).lines().flatten() {
                if let Some(msg) = format_setup_line(&line) {
                    emit_setup_progress(&app2, msg, &lines);
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
                    emit_setup_progress(&app2, msg, &lines);
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

#[cfg(not(target_os = "macos"))]
fn run_macos_qwen3_setup(
    _app: &AppHandle,
    _repo: &Path,
    _runtime: &Path,
) -> Result<(), String> {
    Ok(())
}

fn preflight_indextts2(repo: &Path) -> Result<(), String> {
    let model_dir_s = read_setting_str("indexTts2ModelDir");
    let repo_dir_s = read_setting_str("indexTts2RepoDir");
    let it_repo = resolve_user_path(repo, &repo_dir_s, "scripts/local-realtime/index-tts");
    let model_dir = resolve_user_path(
        repo,
        &model_dir_s,
        "scripts/local-realtime/pretrained_models/IndexTTS-2",
    );
    if !it_repo.is_dir() {
        return Err(format!(
            "未找到 IndexTTS-2 源码。请先：git clone --recursive https://github.com/index-tts/index-tts.git {}",
            repo.join("scripts/local-realtime/index-tts").display()
        ));
    }
    let cfg = model_dir.join("config.yaml");
    if !model_dir.is_dir() || !cfg.is_file() {
        return Err(format!(
            "未找到 IndexTTS-2 权重（需含 config.yaml）：{}。可用安装程序配置或手动下载 checkpoints。",
            model_dir.display()
        ));
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
                message: "macOS 本地模型仅支持 Qwen3-TTS；IndexTTS-2 / CosyVoice3 请在 Windows+NVIDIA 上使用".into(),
                port: port_for(&backend),
            },
        );
        return;
    }

    let Some(script_name) = script_for(&backend) else {
        return;
    };

    // 端口已通：外部或先前实例已在跑，不重复拉起。
    if port_open(port) {
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

    // 已托管同一后端且进程仍在
    if let Ok(mut inner) = app.state::<VoiceServiceManager>().inner.lock() {
        if inner.backend == backend {
            if let Some(child) = inner.child.as_mut() {
                match child.try_wait() {
                    Ok(None) => {
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

    if backend == "cosyvoice3" {
        if let Err(msg) = preflight_cosyvoice3(&repo) {
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
    if backend == "indextts2" {
        if let Err(msg) = preflight_indextts2(&repo) {
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

    // macOS：首次使用本地 Qwen3 时自动创建 venv、装依赖、预热模型。
    #[cfg(target_os = "macos")]
    if backend == "local" {
        if let Some(rt) = macos_voice_runtime() {
            let marker = rt.join(".qwen3-ready");
            let py = rt.join(".venv/bin/python");
            if !(marker.is_file() && py.is_file()) {
                let already = app
                    .state::<VoiceServiceManager>()
                    .inner
                    .lock()
                    .map(|i| i.setup_running)
                    .unwrap_or(false);
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
                if let Ok(mut inner) = app.state::<VoiceServiceManager>().inner.lock() {
                    inner.setup_running = true;
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
                } else {
                    "找不到 Python。请先创建 scripts/voice-ab/.venv 并安装依赖。".into()
                },
                port,
            },
        );
        return;
    };

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
        .stderr(Stdio::piped());
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

    let logs = {
        let state = app.state::<VoiceServiceManager>();
        let inner = state.inner.lock().unwrap();
        if let Ok(mut q) = inner.recent_logs.lock() {
            q.clear();
        }
        Arc::clone(&inner.recent_logs)
    };

    // 把子进程日志打到桌宠 stderr，并缓存最近行供失败提示。
    if let Some(out) = child.stdout.take() {
        let logs = Arc::clone(&logs);
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().flatten() {
                eprintln!("[voice-service:out] {line}");
                push_log(&logs, line);
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let logs = Arc::clone(&logs);
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().flatten() {
                eprintln!("[voice-service:err] {line}");
                push_log(&logs, line);
            }
        });
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
        for _ in 0..180 {
            if port_open(port) {
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
                if !port_open(port) {
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
        if port_open(port) {
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
                    message: "启动超时（3 分钟内端口未就绪），进程可能仍在加载模型".into(),
                    port,
                },
            );
        }
    });
}
