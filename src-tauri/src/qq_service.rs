//! Lifecycle for QQ processes started by the desktop app, never unrelated QQ instances.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct Service {
    child: Mutex<Option<Child>>,
}
impl Service {
    pub(crate) fn start_command(&self, mut command: Command) -> Result<&'static str, String> {
        let mut slot = self.child.lock().unwrap();
        if let Some(child) = slot.as_mut() {
            if child.try_wait().map_err(|_| "process-status")?.is_none() {
                return Ok("managed");
            }
            signal_group(child.id(), "-KILL");
            *slot = None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        *slot = Some(
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| "launch-failed")?,
        );
        Ok("managed")
    }
    pub(crate) fn is_alive(&self) -> bool {
        self.managed_status() == "managed"
    }
    fn managed_status(&self) -> &'static str {
        let mut slot = self.child.lock().unwrap();
        match slot.as_mut().map(Child::try_wait) {
            Some(Ok(None)) => "managed",
            Some(Ok(Some(_))) => {
                if let Some(child) = slot.as_ref() {
                    signal_group(child.id(), "-KILL");
                }
                *slot = None;
                "exited"
            }
            Some(Err(_)) => "process-status",
            None => "stopped",
        }
    }
    pub fn status(&self) -> &'static str {
        let managed = self.managed_status();
        if managed != "stopped" {
            return managed;
        }
        #[cfg(target_os = "macos")]
        {
            return match external_qq_running() {
                Ok(true) => "external",
                Ok(false) => "stopped",
                Err(_) => "process-status",
            };
        }
        #[cfg(not(target_os = "macos"))]
        {
            "manual"
        }
    }
    pub fn start(&self, bot_id: &str) -> Result<&'static str, String> {
        if !(5..=12).contains(&bot_id.len())
            || bot_id.starts_with('0')
            || !bot_id.bytes().all(|c| c.is_ascii_digit())
        {
            return Err("invalid-config".into());
        }
        if self.managed_status() == "managed" {
            return Ok("managed");
        }
        #[cfg(target_os = "macos")]
        {
            let home = std::env::var_os("HOME").ok_or("napcat-missing")?;
            let documents = std::path::PathBuf::from(home)
                .join("Library/Containers/com.tencent.qq/Data/Documents");
            let app = std::path::Path::new("/Applications/QQ.app/Contents/Resources/app");
            validate_install(app, &documents)?;
            let instances = qq_instances()?;
            if instances.len() > 1 {
                return Err("qq-restart-required".into());
            }
            if let Some(pid) = instances.first() {
                let args = Command::new("/bin/ps")
                    .args(["-p", &pid.to_string(), "-o", "args="])
                    .output()
                    .map_err(|_| "process-status")?;
                if String::from_utf8_lossy(&args.stdout)
                    .split_whitespace()
                    .any(|v| v == "--no-sandbox")
                {
                    // An external NapCat-capable instance is reused, never acquired or killed.
                    return Ok("external");
                }
                quit_external(*pid, "/Applications/QQ.app/Contents/MacOS/QQ")?;
            }
            let mut command = Command::new("/Applications/QQ.app/Contents/MacOS/QQ");
            command
                .args(["--no-sandbox", "-q", bot_id])
                .env_remove("KXYY_QQ_PHONE_ROLE");
            self.start_command(command)
        }
        #[cfg(not(target_os = "macos"))]
        {
            Ok("manual")
        }
    }
    pub(crate) fn start_phone_host(
        &self,
        root: &std::path::Path,
        bot_id: &str,
    ) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        if !qq_instances()?.is_empty() {
            return Err("phone-external-qq".into());
        }
        self.start_command(phone_qq_command(root, bot_id, true))
            .map(|_| ())
    }
    pub(crate) fn start_phone(
        &self,
        root: &std::path::Path,
        bot_id: &str,
        host: &Service,
    ) -> Result<(), String> {
        let host_pid = {
            let mut slot = host.child.lock().unwrap();
            let child = slot.as_mut().ok_or("phone-connection-failed")?;
            if !matches!(child.try_wait(), Ok(None)) {
                return Err("phone-connection-failed".into());
            }
            child.id()
        };
        #[cfg(target_os = "macos")]
        if !phone_instances_allowed(&qq_instances()?, host_pid) {
            return Err("phone-external-qq".into());
        }
        #[cfg(not(target_os = "macos"))]
        let _ = host_pid;
        self.start_command(phone_qq_command(root, bot_id, false))
            .map(|_| ())
    }
    pub fn stop(&self) -> Result<(), String> {
        let mut slot = self.child.lock().unwrap();
        let Some(child) = slot.as_mut() else {
            return Ok(());
        };
        signal_group(child.id(), "-TERM");
        #[cfg(not(unix))]
        child.kill().map_err(|_| "stop-failed")?;
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => {
                    #[cfg(unix)]
                    while Instant::now() < deadline && group_running(child.id()) {
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    signal_group(child.id(), "-KILL");
                    *slot = None;
                    return Ok(());
                }
                Err(_) => return Err("stop-failed".into()),
                Ok(None) if Instant::now() >= deadline => {
                    signal_group(child.id(), "-KILL");
                    child.kill().map_err(|_| "stop-failed")?;
                    child.wait().map_err(|_| "stop-failed")?;
                    *slot = None;
                    return Ok(());
                }
                _ => std::thread::sleep(Duration::from_millis(25)),
            }
        }
    }
}
#[cfg(unix)]
fn group_running(id: u32) -> bool {
    Command::new("/bin/kill")
        .args(["-0", "--", &format!("-{id}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}
// Only isolated process groups created by this manager, never process-name matches.
fn signal_group(id: u32, signal: &str) {
    #[cfg(unix)]
    {
        let _ = Command::new("/bin/kill")
            .args([signal, "--", &format!("-{id}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(unix))]
    {
        let _ = (id, signal);
    }
}
#[cfg(any(target_os = "macos", test))]
fn phone_instances_allowed(instances: &[u32], host: u32) -> bool {
    instances.iter().all(|pid| *pid == host)
}
impl Drop for Service {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn phone_qq_command(root: &std::path::Path, bot_id: &str, host: bool) -> Command {
    // Keep Tencent's executable signature and application-group identity. A re-signed
    // copy cannot claim the original protected containers on macOS.
    let mut command = Command::new("/Applications/QQ.app/Contents/MacOS/QQ");
    command.arg("--no-sandbox").arg(format!(
        "--user-data-dir={}",
        root.join("runtime")
            .join(if host {
                "host-profile"
            } else {
                "account-profile"
            })
            .display()
    ));
    command
        .env_remove("ELECTRON_RUN_AS_NODE")
        .env("KXYY_QQ_PHONE_ROLE", if host { "host" } else { "account" })
        .env("KOISHI_RTC_QQ_AUDIO_ROUTE_PROFILE", "kxyy-coreaudio-v2")
        .env("KOISHI_RTC_QQ_AUDIO_INPUT_NAME", crate::qq_audio::INPUT_NAME)
        .env("KOISHI_RTC_QQ_AUDIO_OUTPUT_NAME", crate::qq_audio::OUTPUT_NAME)
        // CoreAudio IDs can differ across processes. The SDK must resolve its
        // own IDs from unique exact aggregate names and confirm selection.
        .env_remove("KOISHI_RTC_QQ_AUDIO_INPUT_ID")
        .env_remove("KOISHI_RTC_QQ_AUDIO_OUTPUT_ID")
        .env("KOISHI_RTC_QQ_BRIDGE_DIR", root.join("bridge/qq"))
        .env("KOISHI_RTC_QQ_QQ_DIR", "/Applications/QQ.app/Contents")
        .env(
            "KOISHI_RTC_QQ_AVSDK_PATH",
            "/Applications/QQ.app/Contents/Resources/app/avsdk/libAVSDKPlugin.dylib",
        )
        .env(
            "KOISHI_RTC_QQ_BRIDGE_TOKEN_FILE",
            root.join("runtime/control.token"),
        )
        .env("KOISHI_RTC_QQ_BRIDGE_PORT", "6110")
        .env("KOISHI_RTC_QQ_AV_HOST_PORT", "6111")
        .env("KOISHI_RTC_QQ_AV_HOST", if host { "1" } else { "0" })
        .env("KOISHI_RTC_QQ_LOAD_NAPCAT", if host { "0" } else { "1" })
        .env("KOISHI_RTC_QQ_MEDIA_ENABLED", if host { "0" } else { "1" });
    if !host {
        command
            .args(["-q", bot_id])
            .env("NAPCAT_WORKDIR", root.join("napcat"));
    }
    command
}

pub(crate) struct PhoneLauncher {
    loader: std::path::PathBuf,
    original: Vec<u8>,
    installed: Vec<u8>,
}
impl Drop for PhoneLauncher {
    fn drop(&mut self) {
        // Never overwrite a loader edited by the user or an installer while running.
        if read_launcher(&self.loader).ok().as_ref() == Some(&self.installed) {
            let _ = atomic_private_write(&self.loader, &self.original);
        }
    }
}
fn read_launcher(path: &std::path::Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| "phone-setup-required")?;
    if !meta.is_file() || meta.len() > 65536 {
        return Err("phone-setup-required".into());
    }
    std::fs::read(path).map_err(|_| "phone-setup-required".into())
}
fn atomic_private_write(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(data)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result.map_err(|_| "phone-setup-required".into())
}
pub(crate) fn prepare_phone_launcher(documents: &std::path::Path) -> Result<PhoneLauncher, String> {
    let root = documents.join("KxyyRTCQQ");
    for p in [
        root.join("bridge/qq/macos/host.cjs"),
        root.join("napcat/koishi-rtc-loader.cjs"),
    ] {
        if !p.is_file() {
            return Err("phone-setup-required".into());
        }
    }
    let loader = documents.join("loadNapCat.js");
    let current = read_launcher(&loader)?;
    let backup = root.join("runtime/kxyy-phone-original.js");
    const MARKER: &str = "// kxyy-phone-launcher-v1\n";
    let original = if backup.exists() {
        read_launcher(&backup)?
    } else {
        if current.starts_with(MARKER.as_bytes()) {
            return Err("phone-setup-required".into());
        }
        std::fs::create_dir_all(backup.parent().unwrap()).map_err(|_| "phone-setup-required")?;
        atomic_private_write(&backup, &current)?;
        current.clone()
    };
    let source = std::str::from_utf8(&original).map_err(|_| "phone-setup-required")?;
    let installed = format!("{MARKER}if (process.env.KXYY_QQ_PHONE_ROLE === 'host') {{\n  require(require('node:path').join(__dirname, 'KxyyRTCQQ/bridge/qq/macos/host.cjs'));\n}} else if (process.env.KXYY_QQ_PHONE_ROLE === 'account') {{\n  require(require('node:path').join(__dirname, 'KxyyRTCQQ/napcat/koishi-rtc-loader.cjs'));\n}} else {{\n{source}\n}}\n").into_bytes();
    if installed.len() > 65536 {
        return Err("phone-setup-required".into());
    }
    // A crash may leave our own exact wrapper behind; recover it from the private
    // backup. Any unrelated change fails closed before touching the entrypoint.
    if current != original && current != installed {
        return Err("phone-setup-required".into());
    }
    atomic_private_write(&loader, &installed)?;
    Ok(PhoneLauncher {
        loader,
        original,
        installed,
    })
}
#[cfg(target_os = "macos")]
fn qq_instances() -> Result<Vec<u32>, String> {
    let output = Command::new("/usr/bin/pgrep")
        .args(["-x", "QQ"])
        .output()
        .map_err(|_| "process-status")?;
    if output.status.code() == Some(1) {
        return Ok(vec![]);
    }
    if !output.status.success() {
        return Err("process-status".into());
    }
    let mut result = Vec::new();
    for value in String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .take(32)
    {
        let pid = value.parse().map_err(|_| "process-status")?;
        if executable(pid).as_deref() == Some("/Applications/QQ.app/Contents/MacOS/QQ") {
            result.push(pid);
        }
    }
    Ok(result)
}
#[cfg(target_os = "macos")]
fn external_qq_running() -> Result<bool, String> {
    Ok(!qq_instances()?.is_empty())
}
#[cfg(target_os = "macos")]
fn executable(pid: u32) -> Option<String> {
    let output = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}
#[cfg(target_os = "macos")]
fn quit_external(pid: u32, expected: &str) -> Result<(), String> {
    // Never signal a process by name or its group. Refuse an ambiguous/replaced PID.
    if executable(pid).as_deref() != Some(expected) {
        return Err("qq-restart-required".into());
    }
    let result = Command::new("/bin/kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .map_err(|_| "qq-restart-required")?;
    if !result.success() {
        return Err("qq-restart-required".into());
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while executable(pid).as_deref() == Some(expected) {
        if Instant::now() >= deadline {
            return Err("qq-restart-required".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}
pub(crate) fn validate_install(
    app: &std::path::Path,
    documents: &std::path::Path,
) -> Result<(), String> {
    let manifest = app.join("package.json");
    if std::fs::metadata(&manifest)
        .map_err(|_| "qq-missing")?
        .len()
        > 65536
    {
        return Err("napcat-missing".into());
    }
    let raw = std::fs::read(&manifest).map_err(|_| "qq-missing")?;
    let package: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| "napcat-missing")?;
    let main = package
        .get("main")
        .and_then(|v| v.as_str())
        .ok_or("napcat-missing")?;
    let loader = documents
        .join("loadNapCat.js")
        .canonicalize()
        .map_err(|_| "napcat-missing")?;
    if app.join(main).canonicalize().ok().as_ref() != Some(&loader)
        || !documents.join("napcat/napcat.mjs").is_file()
    {
        return Err("napcat-missing".into());
    }
    Ok(())
}

/// Only fixed login state and a local QR image cross into the Settings WebView.
#[derive(Default)]
pub struct LoginStatus {
    pub state: &'static str,
    pub qr_data_url: String,
}
impl LoginStatus {
    fn from_data(data: &serde_json::Value) -> Self {
        if data.get("isLogin").and_then(|v| v.as_bool()) == Some(true)
            && data.get("coreReady").and_then(|v| v.as_bool()) == Some(true)
        {
            return Self {
                state: "logged-in",
                qr_data_url: String::new(),
            };
        }
        if data.get("qrLoginAccepted").and_then(|v| v.as_bool()) == Some(true)
            || matches!(
                data.get("loginPhase").and_then(|v| v.as_str()),
                Some("initializing" | "qrcode_scanned")
            )
        {
            return Self {
                state: "initializing",
                qr_data_url: String::new(),
            };
        }
        let qr = data.get("qrcodeurl").and_then(|v| v.as_str()).unwrap_or("");
        let qr_data_url = encode_login_qr(qr).unwrap_or_default();
        let state = if !qr_data_url.is_empty()
            || data.get("loginPhase").and_then(|v| v.as_str()) == Some("waiting_qrcode")
        {
            "waiting-login"
        } else {
            "unavailable"
        };
        Self { state, qr_data_url }
    }
}
fn encode_login_qr(value: &str) -> Option<String> {
    if value.len() > 4096 || value.chars().any(char::is_control) {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(
            url.host_str(),
            Some(
                "nt.qq.com"
                    | "ssl.ptlogin2.qq.com"
                    | "xui.ptlogin2.qq.com"
                    | "ptlogin2.qq.com"
                    | "qq.com"
            )
        )
    {
        return None;
    }
    let qr = qrcode::QrCode::new(value.as_bytes()).ok()?;
    let svg = qr
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .build();
    use base64::Engine;
    Some(format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(svg.as_bytes())
    ))
}
fn post_webui(
    client: &reqwest::blocking::Client,
    base: &str,
    path: &str,
    body: &serde_json::Value,
    credential: Option<&str>,
) -> Result<serde_json::Value, String> {
    use std::io::Read;
    let mut request = client.post(format!("{base}/api/{path}")).json(body);
    if let Some(credential) = credential {
        request = request.bearer_auth(credential);
    }
    let response = request.send().map_err(|_| "login-unavailable")?;
    if !response.status().is_success() {
        return Err("login-unavailable".into());
    }
    let mut bytes = Vec::new();
    response
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| "login-unavailable")?;
    if bytes.len() > 65536 {
        return Err("login-unavailable".into());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "login-unavailable")?;
    if value.get("code").and_then(|v| v.as_i64()) != Some(0) {
        return Err("login-unavailable".into());
    }
    value
        .get("data")
        .cloned()
        .ok_or_else(|| "login-unavailable".into())
}
fn query_login(base: &str, token: &str, refresh: bool) -> Result<LoginStatus, String> {
    use sha2::{Digest, Sha256};
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(900))
        .build()
        .map_err(|_| "login-unavailable")?;
    let hash = format!("{:x}", Sha256::digest(format!("{token}.napcat").as_bytes()));
    let auth = post_webui(
        &client,
        base,
        "auth/login",
        &serde_json::json!({"hash":hash}),
        None,
    )?;
    let credential = auth
        .get("Credential")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty() && v.len() <= 8192)
        .ok_or("login-unavailable")?;
    if refresh {
        post_webui(
            &client,
            base,
            "QQLogin/RefreshQRcode",
            &serde_json::json!({}),
            Some(credential),
        )?;
    }
    let data = post_webui(
        &client,
        base,
        "QQLogin/CheckLoginStatus",
        &serde_json::json!({}),
        Some(credential),
    )?;
    Ok(LoginStatus::from_data(&data))
}
#[cfg(target_os = "macos")]
fn local_login(refresh: bool) -> Result<LoginStatus, String> {
    let home = std::env::var_os("HOME").ok_or("login-unavailable")?;
    let path = std::path::PathBuf::from(home)
        .join("Library/Containers/com.tencent.qq/Data/Documents/napcat/config/webui.json");
    if std::fs::metadata(&path)
        .map_err(|_| "login-unavailable")?
        .len()
        > 65536
    {
        return Err("login-unavailable".into());
    }
    let config: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).map_err(|_| "login-unavailable")?)
            .map_err(|_| "login-unavailable")?;
    let token = config
        .get("token")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty() && v.len() <= 1024)
        .ok_or("login-unavailable")?;
    // Fixed loopback destination only; credentials never appear in browser URLs or settings.
    query_login("http://127.0.0.1:6099", token, refresh)
}
pub fn login_status() -> LoginStatus {
    #[cfg(target_os = "macos")]
    {
        return local_login(false).unwrap_or(LoginStatus {
            state: "unavailable",
            qr_data_url: String::new(),
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        LoginStatus::default()
    }
}
pub fn refresh_login() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return local_login(true).map(|_| ());
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("login-unavailable".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn phone_launcher_preserves_ordinary_entry_and_restores_after_stop() {
        let documents =
            std::env::temp_dir().join(format!("qq-phone-loader-{}", uuid::Uuid::new_v4()));
        let root = documents.join("KxyyRTCQQ");
        for (path, content) in [
            ("bridge/qq/macos/host.cjs", "process.stdout.write('host');"),
            (
                "napcat/koishi-rtc-loader.cjs",
                "process.stdout.write('account');",
            ),
        ] {
            let target = root.join(path);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(target, content).unwrap();
        }
        let loader = documents.join("loadNapCat.js");
        let original = "// fixture with no trailing newline\nprocess.stdout.write('ordinary');";
        std::fs::write(&loader, original).unwrap();
        {
            let _lease = prepare_phone_launcher(&documents).unwrap();
            for (role, expected) in [
                ("", "ordinary"),
                ("host", "host"),
                ("account", "account"),
                ("unknown", "ordinary"),
            ] {
                let output = Command::new("node")
                    .arg(&loader)
                    .env("KXYY_QQ_PHONE_ROLE", role)
                    .output()
                    .unwrap();
                assert!(output.status.success());
                assert_eq!(String::from_utf8(output.stdout).unwrap(), expected);
            }
        }
        assert_eq!(std::fs::read_to_string(&loader).unwrap(), original);
        std::fs::remove_dir_all(documents).unwrap();
    }
    #[test]
    fn phone_launcher_recovers_its_crash_but_preserves_unknown_edits() {
        let documents =
            std::env::temp_dir().join(format!("qq-phone-recover-{}", uuid::Uuid::new_v4()));
        let root = documents.join("KxyyRTCQQ");
        std::fs::create_dir_all(root.join("bridge/qq/macos")).unwrap();
        std::fs::create_dir_all(root.join("napcat")).unwrap();
        std::fs::write(root.join("bridge/qq/macos/host.cjs"), "fixture").unwrap();
        std::fs::write(root.join("napcat/koishi-rtc-loader.cjs"), "fixture").unwrap();
        let loader = documents.join("loadNapCat.js");
        std::fs::write(&loader, "// ordinary fixture").unwrap();
        let lease = prepare_phone_launcher(&documents).unwrap();
        std::mem::forget(lease); // Simulate process death before Drop can restore.
        let lease = prepare_phone_launcher(&documents).unwrap();
        drop(lease);
        assert_eq!(
            std::fs::read_to_string(&loader).unwrap(),
            "// ordinary fixture"
        );
        let lease = prepare_phone_launcher(&documents).unwrap();
        std::fs::write(&loader, "// updated by another installer").unwrap();
        drop(lease);
        assert_eq!(
            std::fs::read_to_string(&loader).unwrap(),
            "// updated by another installer"
        );
        assert!(prepare_phone_launcher(&documents).is_err());
        assert_eq!(
            std::fs::read_to_string(&loader).unwrap(),
            "// updated by another installer"
        );
        std::fs::remove_file(root.join("bridge/qq/macos/host.cjs")).unwrap();
        assert!(prepare_phone_launcher(&documents).is_err());
        std::fs::remove_dir_all(documents).unwrap();
    }
    #[test]
    fn phone_allows_only_its_owned_host_before_starting_the_account() {
        assert!(phone_instances_allowed(&[], 17));
        assert!(phone_instances_allowed(&[17], 17));
        assert!(!phone_instances_allowed(&[19], 17));
        assert!(!phone_instances_allowed(&[17, 19], 17));
    }
    #[cfg(unix)]
    #[test]
    fn phone_launcher_refuses_symlinks_and_oversized_sources() {
        let root = std::env::temp_dir().join(format!("qq-phone-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("original.js");
        std::fs::write(&target, "// original").unwrap();
        let link = root.join("link.js");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(read_launcher(&link).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "// original");
        std::fs::write(&target, vec![b'x'; 65537]).unwrap();
        assert!(read_launcher(&target).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn phone_restore_preserves_replaced_symlink_and_refuses_oversized_wrapper() {
        let documents =
            std::env::temp_dir().join(format!("qq-phone-restore-{}", uuid::Uuid::new_v4()));
        let root = documents.join("KxyyRTCQQ");
        for relative in ["bridge/qq/macos/host.cjs", "napcat/koishi-rtc-loader.cjs"] {
            let p = root.join(relative);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "fixture").unwrap();
        }
        let loader = documents.join("loadNapCat.js");
        std::fs::write(&loader, "// ordinary").unwrap();
        let lease = prepare_phone_launcher(&documents).unwrap();
        let alternate = documents.join("alternate.js");
        std::fs::rename(&loader, &alternate).unwrap();
        std::os::unix::fs::symlink(&alternate, &loader).unwrap();
        drop(lease);
        assert!(std::fs::symlink_metadata(&loader)
            .unwrap()
            .file_type()
            .is_symlink());
        std::fs::remove_file(&loader).unwrap();
        std::fs::remove_file(root.join("runtime/kxyy-phone-original.js")).unwrap();
        let source = vec![b' '; 65536];
        std::fs::write(&loader, &source).unwrap();
        assert!(prepare_phone_launcher(&documents).is_err());
        assert_eq!(std::fs::read(&loader).unwrap(), source);
        std::fs::remove_dir_all(documents).unwrap();
    }
    #[test]
    fn phone_process_uses_vendor_qq_and_separate_fixed_roles() {
        let root = std::path::Path::new("/fixture/KxyyRTCQQ");
        for host in [true, false] {
            let command = phone_qq_command(root, "12345678", host);
            assert_eq!(
                command.get_program(),
                "/Applications/QQ.app/Contents/MacOS/QQ"
            );
            let args: Vec<_> = command
                .get_args()
                .map(|s| s.to_string_lossy().into_owned())
                .collect();
            assert!(args.contains(&"--no-sandbox".to_string()));
            assert!(args.contains(&format!(
                "--user-data-dir=/fixture/KxyyRTCQQ/runtime/{}-profile",
                if host { "host" } else { "account" }
            )));
            assert_eq!(args.contains(&"12345678".to_string()), !host);
            let env: std::collections::HashMap<_, _> = command
                .get_envs()
                .map(|(k, v)| {
                    (
                        k.to_string_lossy().into_owned(),
                        v.map(|v| v.to_string_lossy().into_owned()),
                    )
                })
                .collect();
            assert_eq!(
                env["KXYY_QQ_PHONE_ROLE"].as_deref(),
                Some(if host { "host" } else { "account" })
            );
            assert_eq!(env["ELECTRON_RUN_AS_NODE"], None);
            assert_eq!(env.get("KOISHI_RTC_QQ_AUDIO_ROUTE_PROFILE").and_then(|v|v.as_deref()), Some("kxyy-coreaudio-v2"));
            assert_eq!(env["KOISHI_RTC_QQ_AUDIO_INPUT_NAME"].as_deref(), Some("KXYY QQ TX"));
            assert_eq!(env["KOISHI_RTC_QQ_AUDIO_OUTPUT_NAME"].as_deref(), Some("KXYY QQ RX"));
            assert_eq!(env["KOISHI_RTC_QQ_AUDIO_INPUT_ID"], None, "never inherit creator-process IDs");
            assert_eq!(env["KOISHI_RTC_QQ_AUDIO_OUTPUT_ID"], None, "select only IDs observed by the SDK");
            assert_eq!(
                env["KOISHI_RTC_QQ_QQ_DIR"].as_deref(),
                Some("/Applications/QQ.app/Contents")
            );
            if !host {
                assert_eq!(
                    env["NAPCAT_WORKDIR"].as_deref(),
                    Some("/fixture/KxyyRTCQQ/napcat")
                );
            }
        }
    }
    #[test]
    fn local_webui_contract_authenticates_without_exposing_credentials_to_settings() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr());
        let peer = std::thread::spawn(move || {
            let mut login = server
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
                .unwrap();
            assert_eq!(login.url(), "/api/auth/login");
            let mut body = String::new();
            login.as_reader().read_to_string(&mut body).unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&body).unwrap()["hash"],
                "a3962ceb4f67505942d9b8dba8915ff72a61ddc731d3fcae0b5eddce5f2ea5f5"
            );
            login
                .respond(tiny_http::Response::from_string(
                    r#"{"code":0,"data":{"Credential":"fixture-credential"}}"#,
                ))
                .unwrap();
            let status = server
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
                .unwrap();
            assert_eq!(status.url(), "/api/QQLogin/CheckLoginStatus");
            assert_eq!(
                status
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Authorization"))
                    .unwrap()
                    .value
                    .as_str(),
                "Bearer fixture-credential"
            );
            status.respond(tiny_http::Response::from_string(r#"{"code":0,"data":{"isLogin":true,"coreReady":true,"loginError":"private detail"}}"#)).unwrap();
        });
        let status = query_login(&base, "fixture-token", false).unwrap();
        assert_eq!(status.state, "logged-in");
        assert!(status.qr_data_url.is_empty());
        peer.join().unwrap();
    }
    #[test]
    fn webui_failure_redirect_and_oversized_responses_fail_closed() {
        for (code, body) in [
            (200, r#"{"code":1,"message":"private error"}"#.to_string()),
            (302, r#"{"code":0,"data":{}}"#.to_string()),
            (200, "x".repeat(65537)),
        ] {
            let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
            let base = format!("http://{}", server.server_addr());
            let peer = std::thread::spawn(move || {
                let request = server
                    .recv_timeout(Duration::from_secs(3))
                    .unwrap()
                    .unwrap();
                request
                    .respond(tiny_http::Response::from_string(body).with_status_code(code))
                    .unwrap();
            });
            assert_eq!(
                query_login(&base, "fixture-token", false).err().unwrap(),
                "login-unavailable"
            );
            peer.join().unwrap();
        }
    }
    #[test]
    fn login_status_exposes_only_fixed_state_and_locally_encoded_qr() {
        let waiting = LoginStatus::from_data(&serde_json::json!({
            "isLogin":false,"loginPhase":"waiting_qrcode",
            "qrcodeurl":"https://nt.qq.com/qrlogin?token=local-qr-test","loginError":"private detail"}));
        assert_eq!(waiting.state, "waiting-login");
        assert!(waiting
            .qr_data_url
            .starts_with("data:image/svg+xml;base64,"));
        assert!(!waiting.qr_data_url.contains("local-qr-test"));
        let logged = LoginStatus::from_data(
            &serde_json::json!({"isLogin":true,"coreReady":true,"qrcodeurl":"stale"}),
        );
        assert_eq!(logged.state, "logged-in");
        assert!(logged.qr_data_url.is_empty());
        for bad in [
            serde_json::json!({"isLogin":false,"qrcodeurl":"javascript:private"}),
            serde_json::json!({"isLogin":false,"qrcodeurl":"x".repeat(4097)}),
            serde_json::json!({"loginError":"private detail"}),
        ] {
            let status = LoginStatus::from_data(&bad);
            assert!(status.qr_data_url.is_empty());
            assert!(["unavailable", "initializing", "waiting-login"].contains(&status.state));
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn ordinary_qq_restart_only_terminates_the_verified_executable() {
        let mut target = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let mut unrelated = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        assert_eq!(
            quit_external(target.id(), "/not-the-same-app").unwrap_err(),
            "qq-restart-required"
        );
        assert!(target.try_wait().unwrap().is_none());
        quit_external(target.id(), "/bin/sleep").unwrap();
        assert!(target.wait().unwrap().code().is_none());
        assert!(unrelated.try_wait().unwrap().is_none());
        unrelated.kill().unwrap();
        unrelated.wait().unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn managed_start_is_idempotent_and_stop_reaps_only_its_child() {
        let service = Service::default();
        let mut unrelated = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let mut command = Command::new("/bin/sleep");
        command.arg("30");
        assert_eq!(service.start_command(command).unwrap(), "managed");
        let mut second = Command::new("/bin/sleep");
        second.arg("30");
        assert_eq!(service.start_command(second).unwrap(), "managed");
        assert_eq!(service.status(), "managed");
        service.stop().unwrap();
        assert_eq!(service.managed_status(), "stopped");
        service.stop().unwrap();
        assert!(unrelated.try_wait().unwrap().is_none());
        unrelated.kill().unwrap();
        unrelated.wait().unwrap();
    }
    #[test]
    fn invalid_account_never_launches_qq() {
        let service = Service::default();
        for id in ["", "0123456", "1234", "12345;touch", "1234567890123"] {
            assert_eq!(service.start(id).unwrap_err(), "invalid-config");
        }
        assert_eq!(service.managed_status(), "stopped");
    }
    #[cfg(unix)]
    #[test]
    fn spawn_failure_exit_and_retry_remain_recoverable() {
        let service = Service::default();
        assert_eq!(
            service
                .start_command(Command::new("/no-such-qq-test-binary"))
                .unwrap_err(),
            "launch-failed"
        );
        assert_eq!(service.managed_status(), "stopped");
        service
            .start_command(Command::new("/usr/bin/true"))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while service.managed_status() == "managed" {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        let mut command = Command::new("/bin/sleep");
        command.arg("30");
        service.start_command(command).unwrap();
        assert_eq!(service.managed_status(), "managed");
        service.stop().unwrap();
    }
    #[test]
    fn install_requires_both_the_patched_entrypoint_and_napcat() {
        let root = std::env::temp_dir().join(format!("qq-install-test-{}", uuid::Uuid::new_v4()));
        let app = root.join("app");
        let documents = root.join("documents");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::create_dir_all(documents.join("napcat")).unwrap();
        assert_eq!(
            validate_install(&app, &documents).unwrap_err(),
            "qq-missing"
        );
        std::fs::write(documents.join("loadNapCat.js"), "fixture").unwrap();
        std::fs::write(app.join("package.json"), r#"{"main":"index.js"}"#).unwrap();
        assert_eq!(
            validate_install(&app, &documents).unwrap_err(),
            "napcat-missing"
        );
        std::fs::write(
            app.join("package.json"),
            serde_json::to_vec(&serde_json::json!({"main":documents.join("loadNapCat.js")}))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            validate_install(&app, &documents).unwrap_err(),
            "napcat-missing"
        );
        std::fs::write(documents.join("napcat/napcat.mjs"), "fixture").unwrap();
        validate_install(&app, &documents).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn stop_and_drop_terminate_helpers_in_the_owned_group() {
        let root = std::env::temp_dir().join(format!("qq-helper-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let marker = root.join("stopped");
        let ready = root.join("ready");
        let service = Service::default();
        let mut command = Command::new("/bin/sh");
        // The helper proves it received the group signal, independently of its parent.
        command.args(["-c", r#"/bin/sh -c "$HELPER" & wait"#])
            .env("HELPER",r#"trap 'echo stopped > "$MARKER"; exit 0' TERM; echo ready > "$READY"; while :; do sleep 0.05; done"#)
            .env("MARKER",&marker).env("READY",&ready);
        service.start_command(command).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while !ready.exists() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        drop(service);
        assert_eq!(std::fs::read_to_string(&marker).unwrap().trim(), "stopped");
        std::fs::remove_dir_all(root).unwrap();
    }
}
