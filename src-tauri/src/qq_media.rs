//! QQ-owned media only: no event/model supplied file paths, URLs or diagnostics.
use serde_json::{json, Value};
use base64::Engine;
use std::{
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
const MAX_AUDIO: usize = 8 * 1024 * 1024;
pub struct PreparedAudio {
    path: PathBuf,
    encoded: String,
}
impl PreparedAudio {
    pub fn message(&self) -> Value {
        // QQ's App Sandbox cannot read the desktop app's private cache. Transfer
        // bounded owned bytes through OneBot; never expand QQ filesystem access.
        json!([{"type":"record","data":{"file":format!("base64://{}", self.encoded)}}])
    }
}
impl Drop for PreparedAudio {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
// Called once before the transport starts. Crash leftovers never become future messages.
pub fn cleanup(root: &Path) {
    if root
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let owned = matches!(
            path.extension().and_then(|s| s.to_str()),
            Some("wav" | "mp3")
        ) && path
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok());
        if owned {
            let _ = std::fs::remove_file(path);
        }
    }
}
pub async fn synthesize(
    base: &str,
    root: &Path,
    text: &str,
) -> Result<PreparedAudio, &'static str> {
    if text.trim().is_empty() || text.chars().count() > 500 {
        return Err("voice-text-limit");
    }
    let url = reqwest::Url::parse(base).map_err(|_| "tts-unavailable")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("tts-unavailable");
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(100))
        .build()
        .map_err(|_| "tts-unavailable")?;
    let mut response = client
        .post(format!("{}/api/tts", base.trim_end_matches('/')))
        .json(&json!({"text":text}))
        .send()
        .await
        .map_err(|_| "tts-unavailable")?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|n| n > MAX_AUDIO as u64)
    {
        return Err("tts-unavailable");
    }
    let kind = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("");
    let extension = match kind {
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mpeg" => "mp3",
        _ => return Err("invalid-audio"),
    };
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "tts-unavailable")? {
        if bytes.len() + chunk.len() > MAX_AUDIO {
            return Err("audio-too-large");
        }
        bytes.extend_from_slice(&chunk);
    }
    let valid = if extension == "wav" {
        bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE"
    } else {
        bytes.starts_with(b"ID3") || bytes.len() > 2 && bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0
    };
    if !valid {
        return Err("invalid-audio");
    }
    std::fs::create_dir_all(root).map_err(|_| "media-storage")?;
    let path = root
        .canonicalize()
        .map_err(|_| "media-storage")?
        .join(format!("{}.{}", uuid::Uuid::new_v4(), extension));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&path).map_err(|_| "media-storage")?;
    let audio = PreparedAudio { path, encoded: base64::engine::general_purpose::STANDARD.encode(&bytes) };
    file.write_all(&bytes).map_err(|_| "media-storage")?;
    Ok(audio)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn record_handoff_does_not_require_qq_to_read_the_desktop_cache() {
        use base64::Engine;
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr());
        let wav = b"RIFF\x24\x00\x00\x00WAVEfmt ";
        let peer = std::thread::spawn(move || {
            server.recv().unwrap().respond(tiny_http::Response::from_data(wav.to_vec())
                .with_header(tiny_http::Header::from_bytes("Content-Type", "audio/wav").unwrap())).unwrap();
        });
        let root = std::env::temp_dir().join(format!("qq-handoff-{}", uuid::Uuid::new_v4()));
        let media = synthesize(&base, &root, "语音测试").await.unwrap();
        let message = media.message();
        let file = message[0]["data"]["file"].as_str().unwrap();
        assert!(file.starts_with("base64://"), "QQ must not need a path outside its sandbox");
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(&file[9..]).unwrap(), wav);
        drop(media);
        if root.exists() { std::fs::remove_dir(root).unwrap(); }
        peer.join().unwrap();
    }
    #[tokio::test]
    async fn synthesis_produces_private_record_file_and_removes_it_after_delivery() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr());
        let peer = std::thread::spawn(move || {
            let mut request = server.recv().unwrap();
            assert_eq!(request.url(), "/api/tts");
            let mut raw = String::new();
            request.as_reader().read_to_string(&mut raw).unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&raw).unwrap()["text"],
                "你好元宝"
            );
            let wav = b"RIFF\x24\x00\x00\x00WAVEfmt ";
            request
                .respond(tiny_http::Response::from_data(wav.to_vec()).with_header(
                    tiny_http::Header::from_bytes("Content-Type", "audio/wav").unwrap(),
                ))
                .unwrap();
        });
        let root = std::env::temp_dir().join(format!("qq-audio-test-{}", uuid::Uuid::new_v4()));
        let media = synthesize(&base, &root, "你好元宝").await.unwrap();
        let message = media.message();
        assert_eq!(message[0]["type"], "record");
        assert!(message[0]["data"]["file"].as_str().unwrap().starts_with("base64://"));
        let path = media.path.clone();
        assert!(path.starts_with(root.canonicalize().unwrap()));
        assert!(path.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(media);
        assert!(!path.exists());
        std::fs::remove_dir(root).unwrap();
        peer.join().unwrap();
    }
    #[tokio::test]
    async fn redirects_and_non_audio_never_create_a_record_file() {
        for (status, headers, body) in [
            (
                302,
                vec![("Location", "http://127.0.0.1:1/private")],
                b"".as_slice(),
            ),
            (
                200,
                vec![("Content-Type", "text/html")],
                b"RIFF0000WAVE".as_slice(),
            ),
            (
                200,
                vec![("Content-Type", "audio/wav")],
                b"not audio".as_slice(),
            ),
            (
                500,
                vec![("Content-Type", "audio/wav")],
                b"RIFF0000WAVE".as_slice(),
            ),
        ] {
            let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
            let base = format!("http://{}", server.server_addr());
            let peer = std::thread::spawn(move || {
                let request = server.recv().unwrap();
                let mut response =
                    tiny_http::Response::from_data(body.to_vec()).with_status_code(status);
                for (k, v) in headers {
                    response.add_header(tiny_http::Header::from_bytes(k, v).unwrap());
                }
                request.respond(response).unwrap();
            });
            let root =
                std::env::temp_dir().join(format!("qq-invalid-media-{}", uuid::Uuid::new_v4()));
            let result = synthesize(&base, &root, "测试").await;
            if status == 302 {
                assert!(matches!(result, Err("tts-unavailable")));
            } else {
                assert!(result.is_err());
            }
            assert!(!root.exists());
            peer.join().unwrap();
        }
        assert!(matches!(
            synthesize("https://example.com", Path::new("/unused"), "你好").await,
            Err("tts-unavailable")
        ));
        assert!(matches!(
            synthesize(
                "http://127.0.0.1:1",
                Path::new("/unused"),
                &"字".repeat(501)
            )
            .await,
            Err("voice-text-limit")
        ));
    }

    #[tokio::test]
    async fn synthesis_does_not_follow_redirect_even_to_loopback() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr());
        let redirect = format!("{base}/other");
        let peer = std::thread::spawn(move || {
            server
                .recv()
                .unwrap()
                .respond(
                    tiny_http::Response::empty(302)
                        .with_header(tiny_http::Header::from_bytes("Location", redirect).unwrap()),
                )
                .unwrap();
            if let Some(request) = server.recv_timeout(Duration::from_millis(100)).unwrap() {
                request
                    .respond(
                        tiny_http::Response::from_data(b"RIFF0000WAVE".to_vec()).with_header(
                            tiny_http::Header::from_bytes("Content-Type", "audio/wav").unwrap(),
                        ),
                    )
                    .unwrap();
                return true;
            }
            false
        });
        let root = std::env::temp_dir().join(format!("qq-redirect-{}", uuid::Uuid::new_v4()));
        let result = synthesize(&base, &root, "测试").await;
        let followed = peer.join().unwrap();
        drop(result);
        let _ = std::fs::remove_dir(&root);
        assert!(!followed, "synthesis must stay on the app TTS route");
    }

    #[test]
    fn startup_cleanup_only_removes_owned_audio_files() {
        let root = std::env::temp_dir().join(format!("qq-clean-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let owned = root.join(format!("{}.wav", uuid::Uuid::new_v4()));
        std::fs::write(&owned, b"audio").unwrap();
        let other = root.join("keep.txt");
        std::fs::write(&other, b"keep").unwrap();
        cleanup(&root);
        assert!(!owned.exists());
        assert!(other.exists());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
