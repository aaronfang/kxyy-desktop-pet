use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use crate::shared_experience_visual::{
    valid_visual_frame_window, AdaptiveVisualSampler, VisualFrame, VisualFramePayload,
};

const OBSERVER_BASE: &str = "http://127.0.0.1:7861";
const FRAME_STREAM_INTERVAL_MS: u64 = 500;
const MAX_FRAME_EVENT_BYTES: usize = 2 * 1024 * 1024;
const FRAME_OBSERVATION_PROMPT: &str = "请只用一句话（最多60字）描述视频区域内最重要、明确可见的人物、动作或场景；忽略浏览器边框、调试提示、地址栏、工具栏和推荐区，不描述这些界面。不要列清单。不要猜测作品名或角色名，即使你觉得认识；除非视频画面文字清楚显示名字，否则人物只用外观或身份代称。不确定就少说。";

fn observer_start_failure(incompatible: bool) -> String {
    if incompatible {
        "Mage-VL 多帧观察需要 mlx-vlm 0.7.1 或更高版本".to_string()
    } else {
        "Mage-VL observer 启动超时".to_string()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedWindow {
    pub id: u32,
    pub owner: String,
    pub title: String,
}

pub struct SharedExperienceManager {
    child: Mutex<Option<Child>>,
    frame_stream: Mutex<Option<FrameStreamProcess>>,
    visual_sampler: Arc<Mutex<AdaptiveVisualSampler>>,
}

struct FrameStreamProcess {
    child: Child,
    reader: Option<JoinHandle<()>>,
    window_id: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrameStreamEvent {
    captured_at_ms: i64,
    image_base64: String,
    change_score: f64,
}

impl SharedExperienceManager {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            frame_stream: Mutex::new(None),
            visual_sampler: Arc::new(Mutex::new(AdaptiveVisualSampler::new())),
        }
    }
    fn health() -> bool {
        reqwest::blocking::Client::new()
            .get(format!("{OBSERVER_BASE}/health"))
            .timeout(Duration::from_secs(2))
            .send()
            .ok()
            .and_then(|response| response.json::<serde_json::Value>().ok())
            .and_then(|value| {
                value
                    .get("status")
                    .and_then(|status| status.as_str())
                    .map(|status| status == "ok")
            })
            .unwrap_or(false)
    }
    fn frame_windows_ready() -> bool {
        reqwest::blocking::Client::new()
            .get(format!("{OBSERVER_BASE}/health"))
            .timeout(Duration::from_secs(2))
            .send()
            .ok()
            .and_then(|response| response.json::<serde_json::Value>().ok())
            .and_then(|value| value.get("frameWindows").and_then(|ready| ready.as_bool()))
            .unwrap_or(false)
    }
    pub fn start(&self, app: &AppHandle) -> Result<String, String> {
        if Self::health() {
            return if Self::frame_windows_ready() {
                Ok(OBSERVER_BASE.to_string())
            } else {
                Err("Mage-VL 多帧观察需要 mlx-vlm 0.7.1 或更高版本".into())
            };
        }
        let script = app
            .path()
            .resource_dir()
            .ok()
            .map(|root| root.join("scripts/mage-vl/server.py"))
            .filter(|path| path.exists())
            .or_else(|| {
                Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/mage-vl/server.py"))
            })
            .filter(|path| path.exists())
            .ok_or_else(|| "Mage-VL observer 脚本不存在".to_string())?;
        let python = if Command::new("python3").arg("--version").output().is_ok() {
            "python3"
        } else {
            "python"
        };
        let child = Command::new(python)
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("无法启动 Mage-VL observer：{error}"))?;
        *self
            .child
            .lock()
            .map_err(|_| "视觉服务状态锁损坏".to_string())? = Some(child);
        let mut incompatible = false;
        for _ in 0..30 {
            if Self::health() {
                if Self::frame_windows_ready() {
                    return Ok(OBSERVER_BASE.to_string());
                }
                incompatible = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut process) = guard.take() {
                let _ = process.kill();
                let _ = process.wait();
            }
        }
        Err(observer_start_failure(incompatible))
    }
    fn frame_helper_source(app: &AppHandle) -> PathBuf {
        app.path()
            .resource_dir()
            .ok()
            .map(|root| root.join("scripts/mage-vl/capture_frames.swift"))
            .filter(|path| path.exists())
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../scripts/mage-vl/capture_frames.swift")
            })
    }

    #[cfg(target_os = "macos")]
    fn build_frame_helper(app: &AppHandle) -> Result<PathBuf, String> {
        let source = Self::frame_helper_source(app);
        if !source.exists() {
            return Err("窗口画面采集 helper 不存在".into());
        }
        let cache = app
            .path()
            .cache_dir()
            .map_err(|error| format!("无法创建视觉缓存目录：{error}"))?;
        fs::create_dir_all(&cache).map_err(|error| format!("无法创建视觉缓存目录：{error}"))?;
        let helper = cache.join("kxyy-shared-capture-frames-v1");
        let source_modified = fs::metadata(&source).and_then(|meta| meta.modified()).ok();
        let helper_modified = fs::metadata(&helper).and_then(|meta| meta.modified()).ok();
        let needs_build = !helper.exists()
            || source_modified
                .zip(helper_modified)
                .is_some_and(|(source_time, helper_time)| source_time > helper_time);
        if needs_build {
            let status = Command::new("swiftc")
                .args([
                    "-O",
                    "-framework",
                    "AppKit",
                    "-framework",
                    "ScreenCaptureKit",
                    "-framework",
                    "CoreMedia",
                    "-framework",
                    "CoreImage",
                ])
                .arg(&source)
                .arg("-o")
                .arg(&helper)
                .status()
                .map_err(|error| format!("无法编译窗口画面采集 helper：{error}"))?;
            if !status.success() {
                return Err("窗口画面采集 helper 编译失败".into());
            }
        }
        Ok(helper)
    }

    #[cfg(target_os = "macos")]
    fn ensure_frame_stream(&self, app: &AppHandle, window_id: u32) -> Result<(), String> {
        let running = {
            let mut guard = self
                .frame_stream
                .lock()
                .map_err(|_| "窗口画面采集状态锁损坏".to_string())?;
            guard.as_mut().is_some_and(|stream| {
                stream.window_id == window_id && stream.child.try_wait().ok().flatten().is_none()
            })
        };
        if running {
            return Ok(());
        }
        self.stop_frame_stream();
        let helper = Self::build_frame_helper(app)?;
        let mut child = Command::new("/usr/bin/nice")
            .args(["-n", "10"])
            .arg(helper)
            .args([
                "--window-id",
                &window_id.to_string(),
                "--interval-ms",
                &FRAME_STREAM_INTERVAL_MS.to_string(),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("无法启动窗口画面采集：{error}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法读取窗口画面采集输出".to_string())?;
        let sampler = Arc::clone(&self.visual_sampler);
        let reader = std::thread::Builder::new()
            .name("shared-experience-frames".into())
            .spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if line.len() > MAX_FRAME_EVENT_BYTES {
                        continue;
                    }
                    let Ok(event) = serde_json::from_str::<FrameStreamEvent>(&line) else {
                        continue;
                    };
                    if event.image_base64.is_empty()
                        || event.image_base64.len() > MAX_FRAME_EVENT_BYTES
                    {
                        continue;
                    }
                    if let Ok(mut sampler) = sampler.lock() {
                        sampler.push(VisualFrame {
                            captured_at_ms: event.captured_at_ms,
                            image_data_url: format!(
                                "data:image/jpeg;base64,{}",
                                event.image_base64
                            ),
                            change_score: event.change_score,
                        });
                    }
                }
            })
            .map_err(|error| format!("无法启动窗口画面读取线程：{error}"))?;
        *self
            .frame_stream
            .lock()
            .map_err(|_| "窗口画面采集状态锁损坏".to_string())? = Some(FrameStreamProcess {
            child,
            reader: Some(reader),
            window_id,
        });
        Ok(())
    }

    fn stop_frame_stream(&self) {
        let stream = self
            .frame_stream
            .lock()
            .ok()
            .and_then(|mut guard| guard.take());
        if let Some(mut stream) = stream {
            let _ = stream.child.kill();
            let _ = stream.child.wait();
            if let Some(reader) = stream.reader.take() {
                let _ = reader.join();
            }
        }
        if let Ok(mut sampler) = self.visual_sampler.lock() {
            sampler.clear();
        }
    }

    pub fn stop(&self) {
        self.stop_frame_stream();
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut process) = child.take() {
                let _ = process.kill();
                let _ = process.wait();
            }
        }
    }
}

#[tauri::command]
pub async fn list_shared_experience_windows(app: AppHandle) -> Result<Vec<SharedWindow>, String> {
    #[cfg(target_os = "macos")]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            let script = app
                .path()
                .resource_dir()
                .ok()
                .map(|root| root.join("scripts/mage-vl/list_windows.swift"))
                .filter(|path| path.exists())
                .unwrap_or_else(|| {
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("../scripts/mage-vl/list_windows.swift")
                });
            let output = Command::new("swift")
                .arg(script)
                .output()
                .map_err(|error| format!("无法读取窗口列表：{error}"))?;
            if !output.status.success() {
                return Err("macOS 窗口列表读取失败，请检查屏幕录制权限".into());
            }
            serde_json::from_slice(&output.stdout)
                .map_err(|error| format!("窗口列表格式错误：{error}"))
        })
        .await
        .map_err(|_| "窗口列表任务失败".to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("共同体验窗口选择目前只支持 macOS 原型".into())
    }
}

#[tauri::command]
pub fn start_shared_experience(app: AppHandle) -> Result<String, String> {
    app.state::<SharedExperienceManager>().start(&app)
}

#[tauri::command]
pub fn stop_shared_experience(app: AppHandle) -> Result<(), String> {
    app.state::<SharedExperienceManager>().stop();
    Ok(())
}

#[tauri::command]
pub fn stop_shared_experience_frame_stream(app: AppHandle) -> Result<(), String> {
    app.state::<SharedExperienceManager>().stop_frame_stream();
    Ok(())
}

#[cfg(target_os = "macos")]
fn capture_window_image(app: &AppHandle, window_id: u32) -> Result<String, String> {
    let root = app
        .path()
        .cache_dir()
        .map_err(|error| format!("无法创建视觉缓存目录：{error}"))?;
    fs::create_dir_all(&root).map_err(|error| format!("无法创建视觉缓存目录：{error}"))?;
    let path = root.join(format!("kxyy-shared-{}.jpg", uuid::Uuid::new_v4()));
    let result = (|| {
        let status = Command::new("/usr/bin/nice")
            .args([
                "-n",
                "10",
                "/usr/sbin/screencapture",
                "-l",
                &window_id.to_string(),
                "-x",
                "-t",
                "jpg",
            ])
            .arg(&path)
            .status()
            .map_err(|error| format!("抓取指定窗口失败：{error}"))?;
        if !status.success() || !path.exists() {
            return Err("指定窗口不可用或屏幕录制权限被拒绝".to_string());
        }
        let image = fs::read(&path).map_err(|error| format!("读取窗口截图失败：{error}"))?;
        Ok(format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(image)
        ))
    })();
    let _ = fs::remove_file(path);
    result
}

#[cfg(target_os = "macos")]
fn capture_window_audio(
    app: &AppHandle,
    window_id: u32,
    duration_ms: u64,
) -> Result<String, String> {
    let resource_script = app
        .path()
        .resource_dir()
        .ok()
        .map(|root| root.join("scripts/mage-vl/capture_audio.swift"))
        .filter(|path| path.exists())
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/mage-vl/capture_audio.swift")
        });
    if !resource_script.exists() {
        return Err("媒体音频采集 helper 不存在".into());
    }
    let cache = app
        .path()
        .cache_dir()
        .map_err(|error| format!("无法创建音频缓存目录：{error}"))?;
    fs::create_dir_all(&cache).map_err(|error| format!("无法创建音频缓存目录：{error}"))?;
    let helper = cache.join("kxyy-shared-capture-audio-v2");
    if !helper.exists() {
        let status = Command::new("swiftc")
            .args([
                "-O",
                "-framework",
                "AppKit",
                "-framework",
                "ScreenCaptureKit",
                "-framework",
                "CoreMedia",
                "-framework",
                "AudioToolbox",
            ])
            .arg(&resource_script)
            .arg("-o")
            .arg(&helper)
            .status()
            .map_err(|error| format!("无法编译媒体音频采集 helper：{error}"))?;
        if !status.success() {
            return Err("媒体音频采集 helper 编译失败".into());
        }
    }
    let output = cache.join(format!("kxyy-shared-audio-{}.wav", uuid::Uuid::new_v4()));
    let status = Command::new("/usr/bin/nice")
        .args([
            "-n",
            "10",
            helper.to_string_lossy().as_ref(),
            "--window-id",
            &window_id.to_string(),
            "--duration-ms",
            &duration_ms.clamp(1000, 10_000).to_string(),
            "--output",
        ])
        .arg(&output)
        .status()
        .map_err(|error| format!("启动媒体音频采集失败：{error}"))?;
    let result = if !status.success() || !output.exists() {
        Err("指定窗口没有可用媒体音频，或系统音频权限被拒绝".to_string())
    } else {
        let wav = fs::read(&output).map_err(|error| format!("读取媒体音频失败：{error}"))?;
        Ok(base64::engine::general_purpose::STANDARD.encode(wav))
    };
    let _ = fs::remove_file(output);
    result
}

#[tauri::command]
pub async fn capture_shared_experience_frame(
    app: AppHandle,
    window_id: u32,
) -> Result<serde_json::Value, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window_id);
        return Err("共同体验窗口采集目前只支持 macOS 原型".into());
    }
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let manager = app.state::<SharedExperienceManager>();
            manager.ensure_frame_stream(&app, window_id)?;
            let first_window = manager.visual_sampler.lock().ok().is_some_and(|sampler| {
                sampler
                    .snapshot(chrono::Utc::now().timestamp_millis())
                    .emitted_windows
                    == 0
            });
            let deadline =
                Instant::now() + Duration::from_millis(if first_window { 1_500 } else { 0 });
            loop {
                let now_ms = chrono::Utc::now().timestamp_millis();
                let result = manager
                    .visual_sampler
                    .lock()
                    .map_err(|_| "视觉采样状态锁损坏".to_string())
                    .map(|mut sampler| {
                        let window = sampler.take_window(now_ms);
                        let diagnostics = sampler.snapshot(now_ms);
                        (window, diagnostics)
                    })?;
                if let Some(window) = result.0 {
                    return Ok(serde_json::json!({
                        "status": "ok",
                        "window": window,
                        "diagnostics": result.1,
                    }));
                }
                if Instant::now() >= deadline {
                    return Ok(serde_json::json!({
                        "status": "pending",
                        "diagnostics": result.1,
                    }));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        })
        .await
        .map_err(|_| "窗口截图任务失败".to_string())?
    }
}

#[tauri::command]
pub async fn observe_shared_experience_frame(
    app: AppHandle,
    image_data_url: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<SharedExperienceManager>().start(&app)?;
        let body = serde_json::json!({
            "imageDataUrl": image_data_url,
            "question": FRAME_OBSERVATION_PROMPT
        });
        reqwest::blocking::Client::new()
            .post(format!("{OBSERVER_BASE}/observe"))
            .timeout(Duration::from_secs(120))
            .json(&body)
            .send()
            .map_err(|error| format!("视觉服务请求失败：{error}"))?
            .json::<serde_json::Value>()
            .map_err(|error| format!("视觉服务响应无效：{error}"))
    })
    .await
    .map_err(|_| "视觉服务任务失败".to_string())?
}

#[tauri::command]
pub async fn observe_shared_experience_frames(
    app: AppHandle,
    frames: Vec<VisualFramePayload>,
) -> Result<serde_json::Value, String> {
    if !valid_visual_frame_window(&frames) {
        return Err("视觉帧窗口必须包含 2 到 4 张按时间递增的 JPEG".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<SharedExperienceManager>().start(&app)?;
        let body = serde_json::json!({
            "frames": frames,
            "question": "请比较这些按时间排列的视频画面，只用一句话（最多100字）描述视频区域内最重要且明确可见的保持、出现、消失、动作变化或场景切换；忽略浏览器边框、调试提示、地址栏、工具栏和推荐区。不要猜测作品名、角色名、声音、动机或剧情因果；不确定就明确少说。"
        });
        reqwest::blocking::Client::new()
            .post(format!("{OBSERVER_BASE}/observe-frames"))
            .timeout(Duration::from_secs(120))
            .json(&body)
            .send()
            .map_err(|error| format!("视觉服务请求失败：{error}"))?
            .json::<serde_json::Value>()
            .map_err(|error| format!("视觉服务响应无效：{error}"))
    })
    .await
    .map_err(|_| "视觉服务任务失败".to_string())?
}

#[tauri::command]
pub async fn transcribe_shared_experience_audio(
    app: AppHandle,
    wav_base64: String,
) -> Result<serde_json::Value, String> {
    if wav_base64.is_empty() || wav_base64.len() > 5_000_000 {
        return Err("音频片段过大或为空".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let backend = app
            .state::<crate::AppState>()
            .settings
            .lock()
            .map_err(|_| "语音设置锁不可用".to_string())?
            .realtime_backend
            .clone();
        let backend = crate::voice_service::normalize_backend(&backend);
        let port = crate::voice_service::port_for(&backend);
        if port == 0 || backend == "volc" {
            return Err("当前语音后端没有本地 SenseVoice 服务".into());
        }
        let body = serde_json::json!({"wavBase64": wav_base64});
        reqwest::blocking::Client::new()
            .post(format!("http://127.0.0.1:{}/asr", port + 100))
            .header("X-Tts-Secret", crate::voice_service::tts_secret())
            .timeout(Duration::from_secs(70))
            .json(&body)
            .send()
            .map_err(|error| format!("SenseVoice 服务请求失败：{error}"))?
            .json::<serde_json::Value>()
            .map_err(|error| format!("SenseVoice 响应无效：{error}"))
    })
    .await
    .map_err(|_| "SenseVoice 任务失败".to_string())?
}

#[tauri::command]
pub async fn capture_shared_experience_audio(
    app: AppHandle,
    window_id: u32,
    duration_ms: Option<u64>,
) -> Result<serde_json::Value, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window_id, duration_ms);
        return Err("媒体音频采集目前只支持 macOS".into());
    }
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let duration = duration_ms.unwrap_or(10_000).clamp(1000, 10_000);
            let wav_base64 = capture_window_audio(&app, window_id, duration)?;
            // End minus the bounded recording duration approximates source time,
            // rather than placing the whole clip after it has already finished.
            Ok(serde_json::json!({
                "status": "ok",
                "wavBase64": wav_base64,
                "capturedAtMs": chrono::Utc::now().timestamp_millis() - duration as i64,
                "durationMs": duration,
            }))
        })
        .await
        .map_err(|_| "媒体音频采集任务失败".to_string())?
    }
}

#[tauri::command]
pub async fn observe_shared_experience(
    app: AppHandle,
    window_id: u32,
) -> Result<serde_json::Value, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window_id;
        return Err("共同体验窗口观察目前只支持 macOS 原型".into());
    }
    #[cfg(target_os = "macos")]
    {
        let capture_app = app.clone();
        let image_data_url = tauri::async_runtime::spawn_blocking(move || {
            capture_window_image(&capture_app, window_id)
        })
        .await
        .map_err(|_| "窗口截图任务失败".to_string())??;
        observe_shared_experience_frame(app, image_data_url).await
    }
}

#[cfg(test)]
mod tests {
    use super::{observer_start_failure, FRAME_OBSERVATION_PROMPT};

    #[test]
    fn frame_prompt_forbids_guessing_work_or_character_names() {
        assert!(FRAME_OBSERVATION_PROMPT.contains("不要猜测作品名或角色名"));
        assert!(FRAME_OBSERVATION_PROMPT.contains("忽略浏览器边框、调试提示"));
        assert!(FRAME_OBSERVATION_PROMPT.contains("画面文字清楚显示"));
        assert!(FRAME_OBSERVATION_PROMPT.contains("外观或身份代称"));
    }

    #[test]
    fn incompatible_observer_keeps_the_actionable_startup_error() {
        assert!(observer_start_failure(true).contains("mlx-vlm 0.7.1"));
        assert!(observer_start_failure(false).contains("启动超时"));
    }
}
