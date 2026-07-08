//! 本地文字模型（Ollama）生命周期管理：探测 / 拉起 / 列模型 / 拉取进度。
//!
//! 与 `voice_service.rs` 管理的本地语音子进程不同，Ollama 是用户机器上的**共享系统服务**
//! （很可能被其它工具同时使用），因此本模块只在探测到「未运行」时才尝试拉起，
//! **不**在本 App 退出时杀掉它，也不像语音那样把 child 句柄纳入独占托管。

use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::voice_service::{augmented_tool_path, which_in_path};

const OLLAMA_HOST: &str = "http://127.0.0.1:11434";
/// 默认推荐模型：双平台（Win RTX 5080 / macOS M4 Pro）均衡档。
pub const DEFAULT_MODEL: &str = "qwen3:14b";
/// 模型常驻显存时长：避免闲置后下次冷加载又卡 30s+。
/// 注意：`/v1` OpenAI 兼容层会忽略 `keep_alive`，必须走 native `/api/chat`。
pub const KEEP_ALIVE: &str = "30m";
/// 本地默认上下文；人设已占 ~5k tokens，8k 容易 400。
pub const LOCAL_NUM_CTX: u32 = 16384;
const HEALTH_TIMEOUT_MS: u64 = 800;
/// 拉起 `ollama serve` 后等待端口就绪的上限（秒）；本地首次加载模型可能较久，
/// 但 serve 本身通常几秒内就会监听端口，这里只等「进程起来」，不等模型加载。
const START_TIMEOUT_SECS: u64 = 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTextStatus {
    /// running | stopped | starting | failed
    pub state: String,
    pub message: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ModelInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(HEALTH_TIMEOUT_MS))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
}

/// `GET /api/tags` 成功即视为 Ollama 正在运行；顺带解析已装模型列表。
fn fetch_tags() -> Result<Vec<ModelInfo>, String> {
    let resp = client()
        .get(format!("{OLLAMA_HOST}/api/tags"))
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let data: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    let models = data
        .get("models")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let name = m.get("name").and_then(|n| n.as_str())?.to_string();
                    let size = m.get("size").and_then(|s| s.as_u64());
                    Some(ModelInfo { name, size })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(models)
}

pub fn is_running() -> bool {
    fetch_tags().is_ok()
}

/// 已装模型列表（`GET /api/tags`）；Ollama 未运行时返回 Err。
pub fn list_models() -> Result<Vec<ModelInfo>, String> {
    fetch_tags()
}

/// 在 PATH 与已知安装目录里找 `ollama` 可执行文件。
fn find_ollama_binary() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/usr/local/bin/ollama"));
        candidates.push(PathBuf::from("/opt/homebrew/bin/ollama"));
        candidates.push(PathBuf::from(
            "/Applications/Ollama.app/Contents/Resources/ollama",
        ));
    }
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            candidates.push(PathBuf::from(&local).join("Programs/Ollama/ollama.exe"));
        }
    }
    for c in &candidates {
        if c.is_file() {
            return Some(c.clone());
        }
    }
    // PATH 里的裸命令名（跨平台，自动补 .exe）。
    which_in_path(&PathBuf::from("ollama"))
}

/// 只读状态探测：不启动、不改变系统状态，供设置页切换 provider / 打开设置时立即反馈。
pub fn probe() -> LocalTextStatus {
    match fetch_tags() {
        Ok(models) => LocalTextStatus {
            state: "running".into(),
            message: format!("运行中，已装模型 {} 个", models.len()),
            models,
        },
        Err(_) => {
            if find_ollama_binary().is_some() {
                LocalTextStatus {
                    state: "stopped".into(),
                    message: "未运行，保存后自动尝试启动".into(),
                    models: Vec::new(),
                }
            } else {
                LocalTextStatus {
                    state: "failed".into(),
                    message: "未检测到 Ollama，请先安装：https://ollama.com/download".into(),
                    models: Vec::new(),
                }
            }
        }
    }
}

fn emit(app: &AppHandle, status: LocalTextStatus) {
    eprintln!("[local-text] {} — {}", status.state, status.message);
    let _ = app.emit("local-text-status", &status);
}

/// 按当前设置确保 Ollama 在跑；`provider != "local"` 时直接返回（不做任何事，也不停止 Ollama——
/// 它是用户机器上的共享服务，不归本 App 独占管理）。
/// `preferred_model`：设置里的 `localTextModel`；空则用 [`DEFAULT_MODEL`]。
pub fn ensure(app: &AppHandle, provider: &str, preferred_model: &str) {
    if !provider.trim().eq_ignore_ascii_case("local") {
        return;
    }

    let model = {
        let t = preferred_model.trim();
        if t.is_empty() {
            DEFAULT_MODEL.to_string()
        } else {
            t.to_string()
        }
    };

    if is_running() {
        let models = fetch_tags().unwrap_or_default();
        emit(
            app,
            LocalTextStatus {
                state: "running".into(),
                message: format!("已在运行，已装模型 {} 个", models.len()),
                models,
            },
        );
        spawn_warmup(app.clone(), model);
        return;
    }

    let Some(bin) = find_ollama_binary() else {
        emit(
            app,
            LocalTextStatus {
                state: "failed".into(),
                message: "未检测到 Ollama，请先安装：https://ollama.com/download".into(),
                models: Vec::new(),
            },
        );
        return;
    };

    emit(
        app,
        LocalTextStatus {
            state: "starting".into(),
            message: "正在启动 Ollama 服务…".into(),
            models: Vec::new(),
        },
    );

    let mut cmd = Command::new(&bin);
    cmd.arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("PATH", augmented_tool_path());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // 有意不保留 Child 句柄：拉起后即与本 App 生命周期解耦，`ollama serve` 作为
    // 用户机器上的常驻服务持续运行，App 退出不应把它杀掉。
    if let Err(e) = cmd.spawn() {
        emit(
            app,
            LocalTextStatus {
                state: "failed".into(),
                message: format!("启动失败：{e}（{}）", bin.display()),
                models: Vec::new(),
            },
        );
        return;
    }

    let app2 = app.clone();
    let model2 = model.clone();
    std::thread::spawn(move || {
        for _ in 0..START_TIMEOUT_SECS {
            if is_running() {
                let models = fetch_tags().unwrap_or_default();
                emit(
                    &app2,
                    LocalTextStatus {
                        state: "running".into(),
                        message: format!("已启动，已装模型 {} 个", models.len()),
                        models,
                    },
                );
                spawn_warmup(app2, model2);
                return;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        emit(
            &app2,
            LocalTextStatus {
                state: "failed".into(),
                message: format!("启动超时（{START_TIMEOUT_SECS} 秒内端口未就绪）"),
                models: Vec::new(),
            },
        );
    });
}

/// 后台把模型 + 人设 system prompt 预热进 GPU，避免首条聊天卡在 30s+ 冷预填。
/// 走 native `/api/chat`：才能真正设置 `keep_alive` / `num_ctx`（`/v1` 会忽略）。
fn spawn_warmup(app: AppHandle, model: String) {
    std::thread::spawn(move || {
        let system = match crate::persona_assets::decrypted_json() {
            Ok(raw) => serde_json::from_str::<serde_json::Value>(&raw)
                .ok()
                .and_then(|v| {
                    v.get("systemPrompt")
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string())
                })
                .unwrap_or_else(|| "你是开心元元。".into()),
            Err(_) => "你是开心元元。".into(),
        };
        // 冷加载可要半分钟；单独超时。
        let client = match reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(180))
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };
        let body = serde_json::json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": "在" },
            ],
            "stream": false,
            "think": false,
            "keep_alive": KEEP_ALIVE,
            "options": {
                "num_predict": 8,
                "temperature": 0.2,
                "num_ctx": LOCAL_NUM_CTX,
            },
        });
        let t0 = std::time::Instant::now();
        match client
            .post(format!("{OLLAMA_HOST}/api/chat"))
            .json(&body)
            .send()
        {
            Ok(resp) if resp.status().is_success() => {
                eprintln!(
                    "[local-text] warmup ok — {model} {:.1}s (keep_alive={KEEP_ALIVE}, num_ctx={LOCAL_NUM_CTX})",
                    t0.elapsed().as_secs_f32()
                );
                let _ = app.emit(
                    "local-text-status",
                    &LocalTextStatus {
                        state: "running".into(),
                        message: format!("模型已预热（{model}）"),
                        models: fetch_tags().unwrap_or_default(),
                    },
                );
            }
            Ok(resp) => {
                let code = resp.status().as_u16();
                let detail = resp.text().unwrap_or_default();
                eprintln!(
                    "[local-text] warmup failed HTTP {code}: {}",
                    detail.chars().take(200).collect::<String>()
                );
            }
            Err(e) => eprintln!("[local-text] warmup error: {e}"),
        }
    });
}

/// 续命：用 native `/api/chat` 空跑一把，刷新 `keep_alive`（`/v1` 请求不续命）。
pub fn touch_keep_alive(model: &str) {
    let model = model.to_string();
    std::thread::spawn(move || {
        let client = match reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };
        let body = serde_json::json!({
            "model": model,
            "messages": [{ "role": "user", "content": "." }],
            "stream": false,
            "think": false,
            "keep_alive": KEEP_ALIVE,
            "options": { "num_predict": 1, "num_ctx": LOCAL_NUM_CTX },
        });
        let _ = client
            .post(format!("{OLLAMA_HOST}/api/chat"))
            .json(&body)
            .send();
    });
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullProgress {
    pub model: String,
    pub status: String,
    /// 0~100；无法计算（如 total 未知）时为 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn emit_pull(app: &AppHandle, progress: PullProgress) {
    let _ = app.emit("local-text-pull-progress", &progress);
}

/// 后台拉取模型（`POST /api/pull`），逐行解析 Ollama 返回的 NDJSON 进度并 emit。
/// 立即返回；调用方通过 `local-text-pull-progress` 事件观察进度。
pub fn pull_model(app: AppHandle, model: String) {
    std::thread::spawn(move || {
        let model_label = model.clone();
        let client = reqwest::blocking::Client::builder()
            // 拉取模型可能持续数分钟，不能用健康检查那种短超时。
            .timeout(None)
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());

        let resp = match client
            .post(format!("{OLLAMA_HOST}/api/pull"))
            .json(&serde_json::json!({ "model": model_label, "stream": true }))
            .send()
        {
            Ok(r) => r,
            Err(e) => {
                emit_pull(
                    &app,
                    PullProgress {
                        model: model_label,
                        status: "请求失败".into(),
                        percent: None,
                        done: true,
                        error: Some(e.to_string()),
                    },
                );
                return;
            }
        };

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let detail = resp.text().unwrap_or_default();
            emit_pull(
                &app,
                PullProgress {
                    model: model_label,
                    status: format!("HTTP {status}"),
                    percent: None,
                    done: true,
                    error: Some(detail.chars().take(300).collect()),
                },
            );
            return;
        }

        let mut reader = BufReader::new(resp);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match read_line(&mut reader, &mut buf) {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf);
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                        continue;
                    };
                    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                        emit_pull(
                            &app,
                            PullProgress {
                                model: model_label.clone(),
                                status: "失败".into(),
                                percent: None,
                                done: true,
                                error: Some(err.to_string()),
                            },
                        );
                        return;
                    }
                    let status = v
                        .get("status")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string();
                    let total = v.get("total").and_then(|t| t.as_u64());
                    let completed = v.get("completed").and_then(|c| c.as_u64());
                    let percent = match (total, completed) {
                        (Some(t), Some(c)) if t > 0 => Some((c as f64 / t as f64) * 100.0),
                        _ => None,
                    };
                    let done = status.eq_ignore_ascii_case("success");
                    emit_pull(
                        &app,
                        PullProgress {
                            model: model_label.clone(),
                            status,
                            percent,
                            done,
                            error: None,
                        },
                    );
                    if done {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        // 流正常结束但未见到显式 success：多数情况下也已经完成（部分版本最后一行即 success），
        // 保守起见补发一条 done，避免前端进度条卡住。
        emit_pull(
            &app,
            PullProgress {
                model: model_label,
                status: "完成".into(),
                percent: Some(100.0),
                done: true,
                error: None,
            },
        );
    });
}

/// 逐字节读到 `\n`（含）为止；兼容非 UTF-8 片段（用 lossy 解码显示）。
fn read_line<R: Read>(r: &mut BufReader<R>, buf: &mut Vec<u8>) -> std::io::Result<usize> {
    r.read_until(b'\n', buf)
}
