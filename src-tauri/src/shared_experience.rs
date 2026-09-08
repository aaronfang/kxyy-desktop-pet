use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const OBSERVER_BASE: &str = "http://127.0.0.1:7861";
const FRAME_OBSERVATION_PROMPT: &str = "请只用一句话（最多60字）描述视频区域内最重要、明确可见的人物、动作或场景；忽略浏览器边框、调试提示、地址栏、工具栏和推荐区，不描述这些界面。不要列清单。不要猜测作品名或角色名，即使你觉得认识；除非视频画面文字清楚显示名字，否则人物只用外观或身份代称。不确定就少说。";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedWindow {
    pub id: u32,
    pub owner: String,
    pub title: String,
}

pub struct SharedExperienceManager {
    child: Mutex<Option<Child>>,
}

impl SharedExperienceManager {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
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
    pub fn start(&self, app: &AppHandle) -> Result<String, String> {
        if Self::health() {
            return Ok(OBSERVER_BASE.to_string());
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
        for _ in 0..30 {
            if Self::health() {
                return Ok(OBSERVER_BASE.to_string());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut process) = guard.take() {
                let _ = process.kill();
                let _ = process.wait();
            }
        }
        Err("Mage-VL observer 启动超时".to_string())
    }
    pub fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut process) = child.take() {
                let _ = process.kill();
                let _ = process.wait();
            }
        }
    }
}

#[tauri::command]
pub fn list_shared_experience_windows(app: AppHandle) -> Result<Vec<SharedWindow>, String> {
    #[cfg(target_os = "macos")]
    {
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
        return serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("窗口列表格式错误：{error}"));
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

#[cfg(target_os = "macos")]
fn capture_window_image(app: &AppHandle, window_id: u32) -> Result<String, String> {
    let root = app
        .path()
        .cache_dir()
        .map_err(|error| format!("无法创建视觉缓存目录：{error}"))?;
    fs::create_dir_all(&root).map_err(|error| format!("无法创建视觉缓存目录：{error}"))?;
    let path = root.join(format!("kxyy-shared-{}.jpg", uuid::Uuid::new_v4()));
    let result = (|| {
        let status = Command::new("/usr/sbin/screencapture")
            .args(["-l", &window_id.to_string(), "-x", "-t", "jpg"])
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
    let status = Command::new(&helper)
        .args([
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
pub fn capture_shared_experience_frame(
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
        let image_data_url = capture_window_image(&app, window_id)?;
        Ok(serde_json::json!({
            "status": "ok",
            "imageDataUrl": image_data_url,
            "capturedAtMs": chrono::Utc::now().timestamp_millis(),
        }))
    }
}

#[tauri::command]
pub fn observe_shared_experience_frame(
    app: AppHandle,
    image_data_url: String,
) -> Result<serde_json::Value, String> {
    let manager = app.state::<SharedExperienceManager>();
    manager.start(&app)?;
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
}

#[tauri::command]
pub fn transcribe_shared_experience_audio(
    app: AppHandle,
    wav_base64: String,
) -> Result<serde_json::Value, String> {
    if wav_base64.is_empty() || wav_base64.len() > 5_000_000 {
        return Err("音频片段过大或为空".into());
    }
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
pub fn observe_shared_experience(
    app: AppHandle,
    window_id: u32,
) -> Result<serde_json::Value, String> {
    let manager = app.state::<SharedExperienceManager>();
    manager.start(&app)?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window_id;
        return Err("共同体验窗口观察目前只支持 macOS 原型".into());
    }
    #[cfg(target_os = "macos")]
    {
        let image_data_url = capture_window_image(&app, window_id)?;
        observe_shared_experience_frame(app, image_data_url)
    }
}

#[cfg(test)]
mod tests {
    use super::FRAME_OBSERVATION_PROMPT;

    #[test]
    fn frame_prompt_forbids_guessing_work_or_character_names() {
        assert!(FRAME_OBSERVATION_PROMPT.contains("不要猜测作品名或角色名"));
        assert!(FRAME_OBSERVATION_PROMPT.contains("忽略浏览器边框、调试提示"));
        assert!(FRAME_OBSERVATION_PROMPT.contains("画面文字清楚显示"));
        assert!(FRAME_OBSERVATION_PROMPT.contains("外观或身份代称"));
    }
}
