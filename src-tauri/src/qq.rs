//! Owner-only OneBot v11 transport. Protocol content never enters logs.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub enabled: bool,
    pub ws_url: String,
    pub owner_id: String,
    pub bot_id: String,
    pub card_id: String,
    pub nickname: String,
    #[serde(default)]
    pub token: String,
    #[serde(default = "text_reply_mode")]
    pub reply_mode: String,
    #[serde(default)]
    pub voice_input: bool,
    #[serde(default)]
    pub phone_enabled: bool,
}
fn text_reply_mode() -> String {
    "text".into()
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            ws_url: String::new(),
            owner_id: String::new(),
            bot_id: String::new(),
            card_id: String::new(),
            nickname: String::new(),
            token: String::new(),
            reply_mode: text_reply_mode(),
            voice_input: false,
            phone_enabled: false,
        }
    }
}
impl Config {
    /// The desktop scope is authoritative, including after restart. Legacy QQ
    /// binding fields are only a compatibility mirror, never a second identity.
    fn follow_settings(&self, settings: &crate::Settings) -> Self {
        let mut current = self.clone();
        current.card_id = settings.persona_card_id.trim().into();
        current.nickname = settings.user_name.trim().into();
        // Mirror resolveUserProfile/getEffectiveName: only kxyy has a default.
        if current.nickname.is_empty()
            && (current.card_id.is_empty() || current.card_id.starts_with("kxyy"))
        {
            current.nickname = "元宝".into();
        }
        current
    }
    fn validate(&self) -> Result<(), String> {
        if !["text", "voice"].contains(&self.reply_mode.as_str())
            || self.ws_url.len() > 200
            || self.owner_id.len() > 12
            || self.bot_id.len() > 12
            || self.nickname.chars().count() > 80
            || self.card_id.chars().count() > 120
            || self.token.len() > 256
            || self.token.chars().any(char::is_control)
        {
            return Err("QQ配置字段超长或无效".into());
        }
        if !self.enabled {
            return Ok(());
        }
        let url = reqwest::Url::parse(&self.ws_url).map_err(|_| "OneBot地址无效")?;
        if url.scheme() != "ws"
            || url.host_str() != Some("127.0.0.1")
            || url.port().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || self.ws_url.len() > 200
        {
            return Err("仅允许带端口的 ws://127.0.0.1 地址，无认证参数或查询串".into());
        }
        if !qq_id(&self.owner_id)
            || !qq_id(&self.bot_id)
            || self.owner_id == self.bot_id
            || self.nickname.trim().is_empty()
            || self.nickname.chars().count() > 80
            || self.card_id.chars().count() > 120
            || self.token.is_empty()
            || self.token.len() > 256
            || self.token.chars().any(char::is_control)
        {
            return Err("需要不同的主人/机器人QQ号、明确昵称与OneBot access token".into());
        }
        Ok(())
    }
}
fn qq_id(id: &str) -> bool {
    (5..=12).contains(&id.len()) && !id.starts_with('0') && id.bytes().all(|c| c.is_ascii_digit())
}
fn id_text(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    if text.is_empty()
        || text.len() > 40
        || !text
            .bytes()
            .enumerate()
            .all(|(i, c)| c.is_ascii_digit() || i == 0 && c == b'-')
    {
        return None;
    }
    Some(text)
}
fn owner_text(config: &Config, event: &Value, now: i64) -> Option<(String, String)> {
    if event.get("post_type")?.as_str()? != "message"
        || event.get("message_type")?.as_str()? != "private"
        || event.get("sub_type")?.as_str()? != "friend"
        || id_text(event.get("self_id")?)? != config.bot_id
        || id_text(event.get("user_id")?)? != config.owner_id
    {
        return None;
    }
    if let Some(sender) = event.get("sender").and_then(|v| v.get("user_id")) {
        if id_text(sender)? != config.owner_id {
            return None;
        }
    }
    let at = event.get("time")?.as_i64()?;
    if at < now - 300 || at > now + 30 {
        return None;
    }
    let id = id_text(event.get("message_id")?)?;
    let message = event.get("message")?;
    let text = if let Some(text) = message.as_str() {
        text.to_owned()
    } else {
        let parts = message.as_array()?;
        if parts.len() > 32 {
            return None;
        }
        let mut text = String::new();
        for part in parts {
            if part.get("type")?.as_str()? != "text" {
                return None;
            }
            text.push_str(part.get("data")?.get("text")?.as_str()?);
            if text.len() > 8000 {
                return None;
            }
        }
        text
    };
    let text = text.trim();
    if text.is_empty()
        || text.chars().count() > 2000
        || text.contains("[CQ:")
        || text
            .chars()
            .any(|c| c.is_control() && !['\n', '\t', '\r'].contains(&c))
    {
        return None;
    }
    Some((id, text.to_owned()))
}

fn owner_record(config: &Config, event: &Value, now: i64) -> Option<String> {
    if !config.voice_input {
        return None;
    }
    let parts = event.get("message")?.as_array()?;
    if parts.len() != 1
        || parts[0].get("type")?.as_str()? != "record"
        || !parts[0].get("data")?.is_object()
    {
        return None;
    }
    // Reuse the full owner/friend/time/id validation without trusting media paths.
    let mut validated = event.clone();
    validated["message"] = json!("voice");
    owner_text(config, &validated, now).map(|(id, _)| id)
}
fn transcript_text(value: &Value) -> Option<String> {
    if value.get("status")?.as_str()? != "ok" || value.get("retcode")?.as_i64()? != 0 {
        return None;
    }
    let text = value.get("data")?.get("text")?.as_str()?.trim();
    if text.is_empty()
        || text.chars().count() > 2000
        || text.contains("[CQ:")
        || text
            .chars()
            .any(|c| c.is_control() && !['\n', '\r', '\t'].contains(&c))
    {
        return None;
    }
    Some(text.into())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Incoming {
    nonce: String,
    text: String,
    card_id: String,
    nickname: String,
    reply_mode: String,
    voice_input: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct SeenEntry {
    key: String,
    at: i64,
}
struct DeliveryEvidence {
    input: Incoming,
    reply: String,
    lease: String,
    revision: u64,
}
#[derive(Default)]
struct Core {
    revision: u64,
    seen: std::collections::VecDeque<SeenEntry>,
    pending: Option<(String, i64)>,
    last_admitted: Option<i64>,
    delivery: Option<Incoming>,
    claimed: bool,
    memory_lease: Option<String>,
    explicit_attempt: bool,
    sent_draft: Option<String>,
}
impl Core {
    fn begin_voice(&mut self, config: &Config, event: &Value, now: i64) -> Option<Incoming> {
        owner_record(config, event, now)?;
        let mut copy = event.clone();
        copy["message"] = json!("voice");
        let mut incoming = self.accept(config, &copy, now)?;
        incoming.text.clear();
        self.delivery = None;
        Some(incoming)
    }
    fn finish_voice(&mut self, input: &Incoming, text: &str, at: i64) -> Option<Incoming> {
        if self.claimed
            || self.delivery.is_some()
            || !self
                .pending
                .as_ref()
                .is_some_and(|(n, t)| n == &input.nonce && at - *t <= 35)
        {
            return None;
        }
        let text = transcript_text(&json!({"status":"ok","retcode":0,"data":{"text":text}}))?;
        let mut ready = input.clone();
        ready.text = text;
        self.pending = Some((ready.nonce.clone(), at));
        self.delivery = Some(ready.clone());
        Some(ready)
    }
    fn accept(&mut self, config: &Config, event: &Value, now: i64) -> Option<Incoming> {
        let (id, text) = owner_text(config, event, now)?;
        let key = format!("{}:{}:{}", config.bot_id, config.owner_id, id);
        if self.seen.iter().any(|entry| entry.key == key) {
            return None;
        }
        self.pending = None;
        self.delivery = None;
        self.claimed = false;
        self.memory_lease = None;
        self.explicit_attempt = false;
        self.sent_draft = None;
        // Keep every id throughout the five-minute replay window. Capacity exhaustion
        // fails closed instead of evicting a still-fresh id and replying twice.
        self.seen.retain(|entry| now - entry.at <= 330);
        if self.seen.len() >= 512 {
            return None;
        }
        self.seen.push_back(SeenEntry { key, at: now });
        if self.last_admitted.is_some_and(|at| now - at < 2) {
            return None;
        }
        self.last_admitted = Some(now);
        let nonce = uuid::Uuid::new_v4().to_string();
        self.pending = Some((nonce.clone(), now));
        let incoming = Incoming {
            nonce,
            text,
            card_id: config.card_id.clone(),
            nickname: config.nickname.clone(),
            reply_mode: config.reply_mode.clone(),
            voice_input: config.voice_input,
        };
        self.delivery = Some(incoming.clone());
        Some(incoming)
    }
    fn unclaimed(&self, now: i64) -> Option<Incoming> {
        let (_, at) = self.pending.as_ref()?;
        if self.claimed || now - *at > 45 {
            return None;
        }
        self.delivery.clone()
    }
    fn claim(&mut self, nonce: &str, now: i64) -> bool {
        if !self.unclaimed(now).is_some_and(|e| e.nonce == nonce) {
            return false;
        }
        self.claimed = true;
        true
    }
    fn cancel(&mut self) {
        self.revision = self.revision.wrapping_add(1);
        self.pending = None;
        self.delivery = None;
        self.sent_draft = None;
        self.memory_lease = None;
    }
    fn remember(
        &mut self,
        conn: &mut rusqlite::Connection,
        nonce: &str,
        lease: &str,
        at: i64,
    ) -> Result<crate::memory::experience::RememberReceipt, String> {
        if !self.claimed
            || self.memory_lease.as_deref() != Some(lease)
            || !self
                .pending
                .as_ref()
                .is_some_and(|(n, t)| n == nonce && at - *t <= 180)
        {
            return Err("stale".into());
        }
        let incoming = self
            .delivery
            .as_ref()
            .filter(|e| e.nonce == nonce)
            .ok_or("stale")?;
        self.explicit_attempt = true;
        if crate::memory::qq_private_text(&incoming.text) {
            return Err("not-saved".into());
        }
        crate::memory::experience::remember(
            conn,
            &crate::memory::experience::RememberRequest {
                card_id: incoming.card_id.clone(),
                nickname: incoming.nickname.clone(),
                message_id: format!("qq:{nonce}"),
                message: incoming.text.clone(),
                lease: lease.into(),
            },
        )
    }
    fn delivery_evidence(&self) -> Option<DeliveryEvidence> {
        if !self.claimed || self.pending.is_some() || self.explicit_attempt {
            return None;
        }
        Some(DeliveryEvidence {
            input: self.delivery.clone()?,
            reply: self.sent_draft.clone()?,
            lease: self.memory_lease.clone()?,
            revision: self.revision,
        })
    }
    fn record_evidence(
        &self,
        conn: &mut rusqlite::Connection,
        evidence: DeliveryEvidence,
        lease: &str,
        outcome: &str,
    ) -> Option<Result<crate::memory::MemoryEnqueueResponse, String>> {
        if outcome != "sent" || evidence.revision != self.revision || evidence.lease != lease {
            return None;
        }
        let input = evidence.input;
        let nonce = input.nonce;
        Some(crate::memory::enqueue_qq_exchange(
            conn,
            crate::memory::MemoryEnqueueRequest {
                card_id: input.card_id,
                nickname: input.nickname,
                session_id: format!("qq:{nonce}"),
                batch_start: 0,
                batch_end: 2,
                messages: vec![
                    crate::memory::MemoryMessage {
                        id: format!("{nonce}:user"),
                        role: "user".into(),
                        content: input.text,
                        image_caption: "".into(),
                        do_not_remember: false,
                    },
                    crate::memory::MemoryMessage {
                        id: format!("{nonce}:assistant"),
                        role: "assistant".into(),
                        content: evidence.reply,
                        image_caption: "".into(),
                        do_not_remember: false,
                    },
                ],
            },
        ))
    }
    #[cfg(test)]
    fn record_exchange(
        &mut self,
        conn: &mut rusqlite::Connection,
        nonce: &str,
        reply: &str,
        lease: &str,
        outcome: &str,
    ) -> Option<Result<crate::memory::MemoryEnqueueResponse, String>> {
        let evidence = self.delivery_evidence()?;
        if evidence.input.nonce != nonce || evidence.reply != reply.trim() {
            return None;
        }
        let result = self.record_evidence(conn, evidence, lease, outcome);
        if result.is_some() {
            self.delivery = None;
            self.sent_draft = None;
        }
        result
    }
    fn take_draft(&mut self, nonce: &str, text: &str, now: i64) -> Result<Value, String> {
        let Some((current, at)) = &self.pending else {
            return Err("stale".into());
        };
        if !self.claimed
            || nonce != current
            || now - *at > 180
            || text.trim().is_empty()
            || text.chars().count() > 2000
        {
            return Err("stale-or-invalid".into());
        }
        self.pending = None;
        self.sent_draft = Some(text.trim().into());
        Ok(json!([{ "type":"text","data":{"text":text.trim()}}]))
    }
}

use futures_util::{SinkExt, StreamExt};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio_tungstenite::{
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
    MaybeTlsStream, WebSocketStream,
};
type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

pub struct QqState {
    config: Mutex<Config>,
    pub(crate) phone: crate::qq_phone::PhoneState,
    lifecycle: Mutex<()>,
    shutting_down: AtomicBool,
    service: crate::qq_service::Service,
    service_error: Mutex<Option<String>>,
    core: Mutex<Core>,
    status: Mutex<String>,
    media_status: Mutex<String>,
    synthesis: tokio::sync::Semaphore,
    path: PathBuf,
    outbound: Mutex<Option<mpsc::Sender<SendCommand>>>,
    epoch: AtomicU64,
    notify: Notify,
}
struct SendCommand {
    nonce: String,
    text: String,
    done: oneshot::Sender<String>,
    audio: Option<crate::qq_media::PreparedAudio>,
}
// QQ may acknowledge translatePtt2Text before the cloud text is readable.
// Retry only this owner's validated message id, with fresh echoes and one deadline.
struct Transcription {
    echo: String,
    input: Incoming,
    at: tokio::time::Instant,
    message_id: String,
    attempts: u8,
    retry_at: Option<tokio::time::Instant>,
}
enum TranscriptionResult {
    Waiting,
    Ready(Incoming),
    Failed,
}
impl Transcription {
    fn new(input: Incoming, message_id: String) -> Self {
        Self { echo: String::new(), input, at: tokio::time::Instant::now(), message_id,
            attempts: 0, retry_at: None }
    }
    fn request(&mut self) -> Value {
        self.attempts += 1;
        self.echo = uuid::Uuid::new_v4().to_string();
        self.retry_at = None;
        json!({"action":"fetch_ptt_text","params":{"message_id":self.message_id},"echo":self.echo})
    }
    fn current(&self, core: &Core) -> bool {
        !core.claimed && core.delivery.is_none()
            && core.pending.as_ref().is_some_and(|(nonce,_)|nonce==&self.input.nonce)
    }
    fn matches(&self, value: &Value) -> bool {
        self.retry_at.is_none() && value.get("echo").and_then(Value::as_str)==Some(&self.echo)
    }
    fn response(&mut self, value: &Value, core: &mut Core, wall_at: i64,
        at: tokio::time::Instant) -> TranscriptionResult {
        if !self.current(core) || at.duration_since(self.at) >= Duration::from_secs(30) {
            return TranscriptionResult::Failed;
        }
        if let Some(text) = transcript_text(value) {
            return match core.finish_voice(&self.input, &text, wall_at) {
                Some(ready) => TranscriptionResult::Ready(ready),
                None => TranscriptionResult::Failed,
            };
        }
        if self.attempts < 3 {
            self.retry_at = Some(at + Duration::from_secs(self.attempts as u64));
            TranscriptionResult::Waiting
        } else { TranscriptionResult::Failed }
    }
    fn poll_request(&mut self, core: &mut Core, at: tokio::time::Instant) -> Result<Option<Value>, ()> {
        if !self.current(core) { return Err(()); }
        if at.duration_since(self.at) >= Duration::from_secs(30) {
            core.cancel();
            return Err(());
        }
        if self.retry_at.is_some_and(|due|at>=due) { Ok(Some(self.request())) }
        else { Ok(None) }
    }
}
struct DeliveryAck {
    evidence: Option<DeliveryEvidence>,
    echo: String,
    done: oneshot::Sender<String>,
    at: tokio::time::Instant,
    nonce: String,
    text: String,
    lease: String,
    audio: Option<crate::qq_media::PreparedAudio>,
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
fn write_local(path: &Path, value: &impl Serialize) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "local-storage")?;
    }
    let raw = serde_json::to_vec(value).map_err(|_| "local-storage")?;
    let temp = path.with_extension("tmp");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    use std::io::Write;
    let mut file = opts.open(&temp).map_err(|_| "local-storage")?;
    file.write_all(&raw)
        .and_then(|_| file.sync_all())
        .map_err(|_| "local-storage")?;
    std::fs::rename(&temp, path).map_err(|_| "local-storage".to_string())
}
fn read_local<T: serde::de::DeserializeOwned>(path: &Path, max: u64) -> Option<T> {
    if std::fs::metadata(path).ok()?.len() > max {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}
impl QqState {
    pub fn open(app: &AppHandle, settings: &crate::Settings) -> Result<Self, String> {
        if let Ok(root) = app.path().app_cache_dir() {
            crate::qq_media::cleanup(&root.join("qq-audio"));
        }
        let root = app
            .path()
            .app_config_dir()
            .map_err(|_| "QQ本地配置目录不可用")?;
        let path = root.join("qq-onebot-v1.json");
        let mut config = read_local::<Config>(&path, 16384)
            .unwrap_or_default()
            .follow_settings(settings);
        if config.validate().is_err() {
            config.enabled = false;
        }
        let mut core = Core::default();
        let seen: Vec<SeenEntry> =
            read_local(&root.join("qq-seen-v1.json"), 65536).unwrap_or_default();
        core.seen = seen
            .into_iter()
            .filter(|v| v.key.len() <= 80 && now() - v.at <= 330)
            .take(512)
            .collect();
        Ok(Self {
            config: Mutex::new(config),
            phone: crate::qq_phone::PhoneState::default(),
            lifecycle: Mutex::new(()),
            shutting_down: AtomicBool::new(false),
            service: crate::qq_service::Service::default(),
            service_error: Mutex::new(None),
            core: Mutex::new(core),
            status: Mutex::new("disabled".into()),
            media_status: Mutex::new("ready".into()),
            synthesis: tokio::sync::Semaphore::new(1),
            path,
            outbound: Mutex::new(None),
            epoch: AtomicU64::new(0),
            notify: Notify::new(),
        })
    }
    fn publish_config(&self, app: &AppHandle, request: Config) {
        *self.service_error.lock().unwrap() = None;
        *self.config.lock().unwrap() = request;
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.cancel();
        self.outbound.lock().unwrap().take();
        self.notify.notify_one();
        let _ = app.emit("qq-invalidated", ());
    }
    pub fn shutdown(&self) {
        let _guard = self.lifecycle.lock().unwrap();
        self.shutting_down.store(true, Ordering::SeqCst);
        self.cancel();
        let _ = self.service.stop();
        self.phone.stop();
    }
    pub fn cancel(&self) {
        self.phone.invalidate();
        self.core.lock().unwrap().cancel();
    }
    pub(crate) fn phone_config(&self) -> Option<Config> {
        let cfg=self.config.lock().unwrap().clone();
        (cfg.enabled && cfg.phone_enabled && !self.shutting_down.load(Ordering::SeqCst)).then_some(cfg)
    }
    fn ensure_service(&self, app:&AppHandle, cfg:&Config)->Result<(),String> {
        if cfg.phone_enabled {
            match self.phone.launch(app,cfg,&self.service) {
                Ok(())=>return Ok(()),
                Err(reason)=>self.phone.set_status(app,&reason),
            }
        } else if self.phone.running() {
            self.service.stop()?;self.phone.stop();
        }
        self.service.start(&cfg.bot_id).map(|_|())
    }
    fn set_status(&self, value: &str) {
        *self.status.lock().unwrap() = value.into();
    }
}
#[tauri::command]
pub async fn qq_get_config(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<QqState>();
        let service = state.service.status();
        let settings = app.state::<crate::AppState>().settings.lock().unwrap().clone();
        let cfg = state.config.lock().unwrap().follow_settings(&settings);
        let status = state.status.lock().unwrap().clone();
        let login = if cfg.enabled && status != "connected" {
            crate::qq_service::login_status()
        } else { crate::qq_service::LoginStatus::default() };
        let binding_matches = !cfg.nickname.is_empty();
        Ok(json!({"enabled":cfg.enabled,"wsUrl":cfg.ws_url,"ownerId":cfg.owner_id,"botId":cfg.bot_id,
            "replyMode":cfg.reply_mode,"voiceInput":cfg.voice_input,"phoneEnabled":cfg.phone_enabled,"phoneStatus":state.phone.status(),"mediaStatus":state.media_status.lock().unwrap().clone(),
            "cardId":cfg.card_id,"nickname":cfg.nickname,"hasToken":!cfg.token.is_empty(),"status":status,
            "service":service,"managedLaunchSupported":cfg!(target_os="macos"),"login":login.state,
            "qrDataUrl":login.qr_data_url,"bindingMatches":binding_matches,
            "serviceError":state.service_error.lock().unwrap().clone()}))
    }).await.map_err(|_| "service-unavailable")?
}
#[tauri::command]
pub async fn qq_refresh_login(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<QqState>();
        let _guard = state.lifecycle.lock().unwrap();
        if !state.config.lock().unwrap().enabled {
            return Err("disabled".into());
        }
        crate::qq_service::refresh_login()
    })
    .await
    .map_err(|_| "service-unavailable")?
}
#[tauri::command]
pub async fn qq_save_config(
    app: AppHandle,
    mut request: Config,
    clear_token: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<QqState>();
        let _guard = state.lifecycle.lock().unwrap();
        if state.shutting_down.load(Ordering::SeqCst) {
            return Err("shutting-down".into());
        }
        if clear_token {
            request.token.clear();
        } else if request.token.is_empty() {
            request.token = state.config.lock().unwrap().token.clone();
        }
        // Ignore stale/read-only form bindings; saved desktop settings win.
        request = request.follow_settings(&app.state::<crate::AppState>().settings.lock().unwrap());
        request.validate().map_err(|_| "invalid-config")?;
        let previous = state.config.lock().unwrap().clone();
        if request.enabled {
            state.ensure_service(&app,&request)?;
        }
        if let Err(error) = write_local(&state.path, &request) {
            // Restore the prior desired lifecycle if starting the new runtime outlived a failed save.
            let _ = state.service.stop();
            state.phone.stop();
            if previous.enabled {let _ = state.ensure_service(&app,&previous);}
            return Err(error);
        }
        let enabled = request.enabled;
        state.publish_config(&app, request);
        if !enabled {
            state.service.stop()?;
            state.phone.stop();
        }
        Ok(())
    })
    .await
    .map_err(|_| "service-unavailable")?
}
#[tauri::command]
pub fn qq_open_login(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    // Fixed local WebUI only; no token in the URL or in the WebView.
    app.opener()
        .open_url("http://127.0.0.1:6099", None::<&str>)
        .map_err(|_| "login-unavailable".into())
}
#[tauri::command]
pub async fn qq_stop_service(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<QqState>();
        let _guard = state.lifecycle.lock().unwrap();
        let mut cfg = state.config.lock().unwrap().clone();
        cfg.enabled = false;
        let saved = write_local(&state.path, &cfg);
        // Stop replies even if disk storage failed. Keep the error visible for the next launch.
        state.publish_config(&app, cfg);
        state.service.stop()?;
        state.phone.stop();
        saved.map_err(|_| "stop-storage-failed".into())
    })
    .await
    .map_err(|_| "service-unavailable")?
}
#[tauri::command]
pub fn qq_receiver_ready(state: State<'_, QqState>) -> Option<Value> {
    state
        .core
        .lock()
        .unwrap()
        .unclaimed(now())
        .and_then(|e| serde_json::to_value(e).ok())
}
#[tauri::command]
pub fn qq_claim_message(
    state: State<'_, QqState>,
    memory: State<'_, crate::memory::MemoryState>,
    nonce: String,
) -> Result<Option<String>, String> {
    crate::memory::with_qq_memory_lease(&memory, None, |lease| {
        let mut core = state.core.lock().unwrap();
        if !core.unclaimed(now()).is_some_and(|e| e.nonce == nonce) {
            return Ok(None);
        }
        let seen: Vec<SeenEntry> = core.seen.iter().cloned().collect();
        if write_local(&state.path.with_file_name("qq-seen-v1.json"), &seen).is_err() {
            core.cancel();
            return Err("local-storage".into());
        }
        if !core.claim(&nonce, now()) {
            return Ok(None);
        }
        core.memory_lease = Some(lease.clone());
        Ok(Some(lease))
    })
    .unwrap_or_else(|| Err("memory-unavailable".into()))
}

#[tauri::command]
pub fn qq_remember_message(
    state: State<'_, QqState>,
    memory: State<'_, crate::memory::MemoryState>,
    nonce: String,
) -> Result<crate::memory::experience::RememberReceipt, String> {
    if nonce.len() > 80 {
        return Err("invalid-request".into());
    }
    crate::memory::with_qq_memory_db(&memory, None, |conn, lease| {
        state
            .core
            .lock()
            .unwrap()
            .remember(conn, &nonce, &lease, now())
    })
    .unwrap_or_else(|| Err("memory-unavailable".into()))
    .map_err(|_| "not-saved".into())
}

#[tauri::command]
pub fn qq_cancel_pending(app: AppHandle, state: State<'_, QqState>) {
    state.cancel();
    let _ = app.emit("qq-invalidated", ());
}
#[tauri::command]
pub fn qq_cancel_draft(state: State<'_, QqState>, nonce: String) {
    let mut core = state.core.lock().unwrap();
    if core.delivery.as_ref().is_some_and(|e| e.nonce == nonce)
        || core.pending.as_ref().is_some_and(|(n, _)| n == &nonce)
    {
        core.cancel();
    }
}
#[tauri::command]
pub async fn qq_send_draft(
    app: AppHandle,
    state: State<'_, QqState>,
    nonce: String,
    text: String,
) -> Result<String, String> {
    if nonce.len() > 80 || text.chars().count() > 2000 {
        return Err("invalid-draft".into());
    }
    let sender = state
        .outbound
        .lock()
        .unwrap()
        .clone()
        .ok_or("disconnected")?;
    let epoch = state.epoch.load(Ordering::SeqCst);
    let voice = state.config.lock().unwrap().reply_mode == "voice";
    let mut audio = None;
    if voice {
        if let Ok(_permit) = state.synthesis.try_acquire() {
            *state.media_status.lock().unwrap() = "synthesizing".into();
            if let (Some(base), Ok(root)) =
                (crate::local_api_base(&app), app.path().app_cache_dir())
            {
                audio = crate::qq_media::synthesize(&base, &root.join("qq-audio"), &text)
                    .await
                    .ok();
            }
            *state.media_status.lock().unwrap() = if audio.is_some() {
                "ready"
            } else {
                "voice-fallback"
            }
            .into();
        } else {
            *state.media_status.lock().unwrap() = "voice-fallback".into();
        }
    }
    if epoch != state.epoch.load(Ordering::SeqCst) {
        return Ok("cancelled".into());
    }
    let wait = if audio.is_some() { 140 } else { 12 };
    let (done, receipt) = oneshot::channel();
    sender
        .try_send(SendCommand {
            nonce,
            text,
            done,
            audio,
        })
        .map_err(|_| "busy")?;
    match tokio::time::timeout(Duration::from_secs(wait), receipt).await {
        Ok(Ok(outcome)) => Ok(outcome),
        _ => Ok("unknown".into()),
    }
}

async fn connect_verified(cfg: &Config) -> Result<(Socket, Option<Value>), String> {
    cfg.validate()?;
    let mut request = cfg
        .ws_url
        .clone()
        .into_client_request()
        .map_err(|_| "connect")?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", cfg.token)
            .parse()
            .map_err(|_| "config")?,
    );
    let wire = WebSocketConfig {
        max_message_size: Some(65536),
        max_frame_size: Some(65536),
        ..WebSocketConfig::default()
    };
    let (mut socket, _) = tokio_tungstenite::connect_async_with_config(request, Some(wire), false)
        .await
        .map_err(|_| "connect")?;
    let echo = uuid::Uuid::new_v4().to_string();
    socket
        .send(Message::Text(
            json!({"action":"get_login_info","params":{},"echo":echo}).to_string(),
        ))
        .await
        .map_err(|_| "handshake")?;
    let mut early_message = None;
    tokio::time::timeout(Duration::from_secs(5), async {
        for _ in 0..32 {
            match socket.next().await {
                Some(Ok(Message::Text(raw))) => {
                    let value: Value = serde_json::from_str(&raw).map_err(|_| "handshake")?;
                    if value.get("echo").and_then(Value::as_str) != Some(&echo) {
                        if owner_text(cfg, &value, now()).is_some()
                            || owner_record(cfg, &value, now()).is_some()
                        {
                            early_message = Some(value);
                        }
                        continue;
                    }
                    if value.get("status").and_then(Value::as_str) != Some("ok")
                        || value.get("retcode").and_then(Value::as_i64) != Some(0)
                        || value
                            .get("data")
                            .and_then(|d| d.get("user_id"))
                            .and_then(id_text)
                            .as_deref()
                            != Some(&cfg.bot_id)
                    {
                        return Err("identity");
                    }
                    return Ok(());
                }
                Some(Ok(Message::Ping(bytes))) => {
                    socket
                        .send(Message::Pong(bytes))
                        .await
                        .map_err(|_| "handshake")?;
                }
                _ => return Err("handshake"),
            }
        }
        Err("handshake")
    })
    .await
    .map_err(|_| "handshake-timeout")?
    .map_err(str::to_string)?;
    Ok((socket, early_message))
}
fn send_action(cfg: &Config, message: Value, echo: &str) -> String {
    json!({"action":"send_private_msg","params":{"user_id":cfg.owner_id.parse::<u64>().unwrap_or(0),"message":message},"echo":echo}).to_string()
}
fn ack_outcome(value: &Value, echo: &str) -> Option<&'static str> {
    if value.get("echo").and_then(Value::as_str) != Some(echo) {
        return None;
    }
    Some(
        if value.get("status").and_then(Value::as_str) == Some("ok")
            && value.get("retcode").and_then(Value::as_i64) == Some(0)
            && value
                .get("data")
                .and_then(|v| v.get("message_id"))
                .and_then(id_text)
                .is_some()
        {
            "sent"
        } else {
            "failed"
        },
    )
}
pub fn invalidate_memory(app: &AppHandle) {
    app.state::<QqState>().cancel();
    let _ = app.emit("qq-invalidated", ());
}
fn admit_event(app: &AppHandle, state: &QqState, cfg: &Config, value: &Value) {
    // Read on every admission: an existing socket must follow hot settings too.
    let cfg = cfg.follow_settings(&app.state::<crate::AppState>().settings.lock().unwrap());
    if cfg.nickname.is_empty()
        || cfg.nickname.chars().count() > 80
        || cfg.card_id.chars().count() > 120
    {
        return;
    }
    let (event, changed) = {
        let mut core = state.core.lock().unwrap();
        let before = core.seen.len();
        let pending = core.pending.clone();
        let old = core.seen.back().cloned();
        let event = core.accept(&cfg, value, now());
        (
            event,
            before != core.seen.len()
                || old != core.seen.back().cloned()
                || pending != core.pending,
        )
    };
    if changed {
        let _ = app.emit("qq-invalidated", json!({"clearHistory":false}));
    }
    if let Some(event) = event {
        let _ = app.emit("qq-owner-message", event);
    }
}
pub fn start(app: AppHandle) {
    crate::qq_phone::start(app.clone());
    tauri::async_runtime::spawn(async move {
        let startup = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let state = startup.state::<QqState>();
            let _guard = state.lifecycle.lock().unwrap();
            let cfg = state.config.lock().unwrap().clone();
            if cfg.enabled && !state.shutting_down.load(Ordering::SeqCst) {
                if let Err(error) = state.ensure_service(&startup,&cfg) {
                    *state.service_error.lock().unwrap() = Some(error);
                }
            }
        })
        .await;
        worker(app).await;
    });
}
async fn worker(app: AppHandle) {
    loop {
        let state = app.state::<QqState>();
        let epoch = state.epoch.load(Ordering::SeqCst);
        let cfg = state.config.lock().unwrap().clone();
        if !cfg.enabled {
            state.set_status("disabled");
            state.notify.notified().await;
            continue;
        }
        state.set_status("connecting");
        let connection = tokio::select! {biased; _=state.notify.notified()=>continue,
        result=tokio::time::timeout(Duration::from_secs(8),connect_verified(&cfg))=>result};
        let (mut socket, early_message) = match connection {
            Ok(Ok(socket)) => socket,
            _ => {
                state.set_status("connection-or-identity-failed");
                tokio::select! {_=state.notify.notified()=>{},_=tokio::time::sleep(Duration::from_secs(5))=>{}};
                continue;
            }
        };
        if state.epoch.load(Ordering::SeqCst) != epoch {
            continue;
        }
        state.set_status("connected");
        let (sender, mut commands) = mpsc::channel::<SendCommand>(1);
        *state.outbound.lock().unwrap() = Some(sender);
        let mut early_message = early_message;
        let mut transcription: Option<Transcription> = None;
        let mut acknowledgement: Option<DeliveryAck> = None;
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {biased;
                _=state.notify.notified()=>break,
                _=tick.tick()=>{
                    if let Some(t)=transcription.as_mut() {
                        let next=t.poll_request(&mut state.core.lock().unwrap(),tokio::time::Instant::now());
                        match next {
                            Ok(Some(request))=>{
                                if !matches!(tokio::time::timeout(Duration::from_secs(5),socket.send(Message::Text(request.to_string()))).await,Ok(Ok(()))) {break;}
                            },
                            Err(())=>{transcription.take();*state.media_status.lock().unwrap()="transcription-failed".into();},
                            Ok(None)=>{},
                        }
                    }
                    if acknowledgement.as_ref().is_some_and(|a|a.at.elapsed()>=Duration::from_secs(if a.audio.is_some(){130}else{10})) {
                        if let Some(a)=acknowledgement.take(){let _=a.done.send("unknown".into());state.set_status("send-unknown");}
                    }
                },
                incoming=async { if let Some(value)=early_message.take() { Some(Ok(Message::Text(value.to_string()))) } else {socket.next().await} }=>{
                    match incoming {
                        Some(Ok(Message::Ping(bytes)))=>{if !matches!(tokio::time::timeout(Duration::from_secs(5),socket.send(Message::Pong(bytes))).await,Ok(Ok(()))){break;}},
                        Some(Ok(Message::Text(raw)))=>{
                            let Ok(value)=serde_json::from_str::<Value>(&raw) else{continue;};
                            let outcome=acknowledgement.as_ref().and_then(|a|ack_outcome(&value,&a.echo));
                            if let Some(outcome)=outcome {
                                if let Some(mut a)=acknowledgement.take(){
                                    // A negative record ACK establishes failure; unknown delivery never retries.
                                    if outcome=="failed" && a.audio.take().is_some() && state.core.lock().unwrap().delivery.as_ref().is_some_and(|e|e.nonce==a.nonce) {
                                        a.echo=uuid::Uuid::new_v4().to_string();a.at=tokio::time::Instant::now();
                                        let message=json!([{"type":"text","data":{"text":a.text}}]);
                                        if !matches!(tokio::time::timeout(Duration::from_secs(5),socket.send(Message::Text(send_action(&cfg,message,&a.echo)))).await,Ok(Ok(()))){let _=a.done.send("unknown".into());break;}
                                        *state.media_status.lock().unwrap()="voice-fallback".into();acknowledgement=Some(a);continue;
                                    }
                                    let queued=crate::memory::with_qq_memory_db(&app.state::<crate::memory::MemoryState>(),Some(&a.lease),|conn,lease|a.evidence.take().and_then(|e|state.core.lock().unwrap().record_evidence(conn,e,&lease,outcome)));
                                    if matches!(queued,Some(Some(Ok(ref result))) if result.accepted) {crate::memory::trigger_worker(&app);}
                                    let _=a.done.send(outcome.into());state.set_status(if outcome=="sent"{"connected"}else{"send-failed"});
                                }continue;
                            }
                            if transcription.as_ref().is_some_and(|t|t.matches(&value)) {
                                let result=transcription.as_mut().unwrap().response(&value,&mut state.core.lock().unwrap(),now(),tokio::time::Instant::now());
                                match result {
                                    TranscriptionResult::Ready(ready)=>{
                                        transcription.take();
                                        *state.media_status.lock().unwrap()="ready".into();let _=app.emit("qq-owner-message",ready);
                                    },
                                    TranscriptionResult::Failed=>{transcription.take();*state.media_status.lock().unwrap()="transcription-failed".into();},
                                    TranscriptionResult::Waiting=>{},
                                }
                                continue;
                            }
                            let current=cfg.follow_settings(&app.state::<crate::AppState>().settings.lock().unwrap());
                            if owner_record(&current,&value,now()).is_some() {
                                if transcription.is_some() {continue;}
                                let pending=state.core.lock().unwrap().begin_voice(&current,&value,now());
                                if let Some(input)=pending {
                                    let seen:Vec<SeenEntry>=state.core.lock().unwrap().seen.iter().cloned().collect();
                                    if write_local(&state.path.with_file_name("qq-seen-v1.json"),&seen).is_err() {state.cancel();state.set_status("storage-failed");continue;}
                                    let _=app.emit("qq-invalidated",json!({"clearHistory":false}));
                                    let mut t=Transcription::new(input,id_text(&value["message_id"]).unwrap_or_default());
                                    let request=t.request();
                                    if !matches!(tokio::time::timeout(Duration::from_secs(5),socket.send(Message::Text(request.to_string()))).await,Ok(Ok(()))) {break;}
                                    transcription=Some(t);
                                    *state.media_status.lock().unwrap()="transcribing".into();
                                }
                            } else { admit_event(&app,&state,&cfg,&value); }
                        },
                        _=>break,
                    }
                },
                command=commands.recv()=>{
                    let Some(command)=command else{break;};
                    if acknowledgement.is_some() || state.epoch.load(Ordering::SeqCst)!=epoch {let _=command.done.send("cancelled".into());continue;}
                    let lease=state.core.lock().unwrap().memory_lease.clone();
                    let message=lease.as_deref().and_then(|lease|crate::memory::with_qq_memory_lease(&app.state::<crate::memory::MemoryState>(),Some(lease),|_|state.core.lock().unwrap().take_draft(&command.nonce,&command.text,now())));
                    let Some(Ok(text_message))=message else{let _=command.done.send("cancelled".into());continue;};
                    let message=command.audio.as_ref().map(|a|a.message()).unwrap_or(text_message);
                    let echo=uuid::Uuid::new_v4().to_string();
                    // Once admitted to the socket, cancellation cannot establish non-delivery.
                    if !matches!(tokio::time::timeout(Duration::from_secs(5),socket.send(Message::Text(send_action(&cfg,message,&echo)))).await,Ok(Ok(()))){let _=command.done.send("unknown".into());break;}
                    let evidence=state.core.lock().unwrap().delivery_evidence();
                    acknowledgement=Some(DeliveryAck{evidence,echo,done:command.done,at:tokio::time::Instant::now(),nonce:command.nonce,text:command.text,lease:lease.unwrap_or_default(),audio:command.audio});
                }
            }
        }
        if let Some(a) = acknowledgement.take() {
            let _ = a.done.send("unknown".into());
        }
        state.outbound.lock().unwrap().take();
        state.cancel();
        let _ = app.emit("qq-invalidated", ());
        state.set_status("reconnecting");
        tokio::select! {_=state.notify.notified()=>{},_=tokio::time::sleep(Duration::from_secs(3))=>{}}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        Config {
            enabled: true,
            ws_url: "ws://127.0.0.1:3001".into(),
            owner_id: "12345678".into(),
            bot_id: "87654321".into(),
            nickname: "主人".into(),
            token: "local-secret".into(),
            ..Config::default()
        }
    }
    fn event() -> Value {
        json!({"post_type":"message","message_type":"private","sub_type":"friend","self_id":87654321u64,"user_id":12345678u64,"message_id":42,"time":1000,"message":[{"type":"text","data":{"text":"你好元元"}}]})
    }
    #[test]
    fn incoming_capabilities_follow_saved_config_not_owner_supplied_fields() {
        let mut cfg = config();
        cfg.reply_mode = "voice".into();
        cfg.voice_input = true;
        let mut message = event();
        message["replyMode"] = json!("text");
        message["voiceInput"] = json!(false);
        let incoming = Core::default().accept(&cfg, &message, 1001).unwrap();
        let serialized = serde_json::to_value(incoming).unwrap();
        assert_eq!(serialized["replyMode"], "voice");
        assert_eq!(serialized["voiceInput"], true);
        cfg.reply_mode = "text".into();
        cfg.voice_input = false;
        let incoming = Core::default().accept(&cfg, &message, 1001).unwrap();
        let serialized = serde_json::to_value(incoming).unwrap();
        assert_eq!(serialized["replyMode"], "text");
        assert_eq!(serialized["voiceInput"], false);
    }
    #[test]
    fn owner_voice_waits_for_cloud_text_after_an_early_unsuccessful_reply() {
        let mut cfg = config();
        cfg.voice_input = true;
        let mut voice = event();
        voice["message"] = json!([{"type":"record","data":{}}]);
        let mut core = Core::default();
        let input = core.begin_voice(&cfg, &voice, 1001).unwrap();
        let mut t = Transcription::new(input, "42".into());
        let first_request=t.request();
        let at=t.at;
        let first = json!({"status":"failed","retcode":1200,"echo":first_request["echo"]});
        assert!(matches!(t.response(&first, &mut core, 1001, at), TranscriptionResult::Waiting),
            "a premature cloud transcription result must retain the pending owner voice for bounded retry");
        assert!(t.poll_request(&mut core,at+Duration::from_millis(999)).unwrap().is_none());
        let retry=t.poll_request(&mut core,at+Duration::from_secs(1)).unwrap().unwrap();
        assert_eq!(retry["params"],json!({"message_id":"42"}));
        assert_ne!(retry["echo"],first_request["echo"]);
        assert!(!t.matches(&first));
        let later = json!({"status":"ok","retcode":0,"data":{"text":"元元听得到吗"},"echo":retry["echo"]});
        let TranscriptionResult::Ready(ready) = t.response(&later, &mut core, 1003, at+Duration::from_secs(2)) else {panic!("cloud text must reach the normal owner pipeline")};
        assert_eq!(ready.text, "元元听得到吗");
        assert!(core.claim(&ready.nonce, 1003));
    }

    #[test]
    fn cloud_transcription_retry_keeps_one_deadline_and_cannot_outlive_cancellation() {
        fn pending() -> (Core, Transcription) {
            let mut cfg = config(); cfg.voice_input = true;
            let mut voice = event(); voice["message"] = json!([{"type":"record","data":{}}]);
            let mut core = Core::default();
            let input = core.begin_voice(&cfg,&voice,1001).unwrap();
            let mut t = Transcription::new(input,"42".into()); t.request(); (core,t)
        }
        let failed=json!({"status":"ok","retcode":0,"data":{"text":""}});
        let (mut core,mut t)=pending(); let at=t.at;
        assert!(matches!(t.response(&failed,&mut core,1001,at),TranscriptionResult::Waiting));
        t.poll_request(&mut core,at+Duration::from_secs(1)).unwrap().unwrap();
        assert!(matches!(t.response(&failed,&mut core,1002,at+Duration::from_secs(1)),TranscriptionResult::Waiting));
        assert!(t.poll_request(&mut core,at+Duration::from_secs(2)).unwrap().is_none());
        t.poll_request(&mut core,at+Duration::from_secs(3)).unwrap().unwrap();
        assert!(matches!(t.response(&failed,&mut core,1004,at+Duration::from_secs(3)),TranscriptionResult::Failed));
        assert_eq!(t.attempts,3);
        assert!(core.unclaimed(1004).is_none());
        assert!(t.poll_request(&mut core,at+Duration::from_secs(30)).is_err());
        assert!(core.pending.is_none());
        for cancel in [true,false] {
            let (mut core,mut t)=pending();let at=t.at;
            assert!(matches!(t.response(&failed,&mut core,1001,at),TranscriptionResult::Waiting));
            let newer=if cancel {core.cancel();None} else {
                let mut e=event();e["message_id"]=json!(43);e["time"]=json!(1003);
                Some(core.accept(&config(),&e,1003).unwrap())
            };
            assert!(t.poll_request(&mut core,at+Duration::from_secs(3)).is_err());
            let late=json!({"status":"ok","retcode":0,"data":{"text":"旧语音不进入下一轮"}});
            assert!(matches!(t.response(&late,&mut core,1004,at+Duration::from_secs(4)),TranscriptionResult::Failed));
            if let Some(newer)=newer {assert!(core.claim(&newer.nonce,1004));}
        }
    }

    #[tokio::test]
    async fn loopback_cloud_transcription_retries_empty_result_and_ignores_old_echo() {
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut cfg=config();cfg.voice_input=true;cfg.ws_url=format!("ws://{}",listener.local_addr().unwrap());
        let peer=tokio::spawn(async move {
            let (stream,_)=listener.accept().await.unwrap();
            let mut ws=tokio_tungstenite::accept_async(stream).await.unwrap();
            let login:Value=serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            ws.send(Message::Text(json!({"status":"ok","retcode":0,"data":{"user_id":87654321},"echo":login["echo"]}).to_string())).await.unwrap();
            let mut voice=event();voice["message"]=json!([{"type":"record","data":{"url":"https://untrusted.invalid/never-fetched"}}]);
            ws.send(Message::Text(voice.to_string())).await.unwrap();
            let first:Value=serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(first["action"],"fetch_ptt_text");assert_eq!(first["params"],json!({"message_id":"42"}));
            let empty=json!({"status":"ok","retcode":0,"data":{"text":""},"echo":first["echo"]});
            ws.send(Message::Text(empty.to_string())).await.unwrap();
            let second:Value=serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(second["params"],first["params"]);assert_ne!(second["echo"],first["echo"]);
            ws.send(Message::Text(empty.to_string())).await.unwrap();
            ws.send(Message::Text(json!({"status":"ok","retcode":0,"data":{"text":"请帮我记住，我喜欢乌龙茶"},"echo":second["echo"]}).to_string())).await.unwrap();
        });
        tokio::time::timeout(Duration::from_secs(3),async {
            let (mut ws,early)=connect_verified(&cfg).await.unwrap();assert!(early.is_none());
            let voice:Value=serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            let mut core=Core::default();let input=core.begin_voice(&cfg,&voice,1001).unwrap();
            let mut t=Transcription::new(input,owner_record(&cfg,&voice,1001).unwrap());let at=t.at;
            ws.send(Message::Text(t.request().to_string())).await.unwrap();
            let first:Value=serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert!(t.matches(&first));assert!(matches!(t.response(&first,&mut core,1001,at),TranscriptionResult::Waiting));
            assert!(core.unclaimed(1001).is_none());
            ws.send(Message::Text(t.poll_request(&mut core,at+Duration::from_secs(1)).unwrap().unwrap().to_string())).await.unwrap();
            let old:Value=serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();assert!(!t.matches(&old));
            let final_reply:Value=serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();assert!(t.matches(&final_reply));
            let TranscriptionResult::Ready(ready)=t.response(&final_reply,&mut core,1003,at+Duration::from_secs(2)) else {panic!("final cloud text missing")};
            assert!(core.claim(&ready.nonce,1003));core.memory_lease=Some("test-lease".into());
            let mut db=crate::memory::qq_test_connection();assert!(core.remember(&mut db,&ready.nonce,"test-lease",1003).unwrap().stored);
            assert_eq!(recalled(&mut db,"主人").len(),1);
        }).await.unwrap();peer.await.unwrap();
    }

    #[test]
    fn owner_voice_waits_for_final_transcript_and_uses_existing_memory_scope() {
        let mut cfg = config();
        cfg.voice_input = true;
        let mut voice = event();
        voice["message"] = json!([{"type":"record","data":{"file":"untrusted-file","url":"http://untrusted.invalid"}}]);
        assert_eq!(owner_record(&cfg, &voice, 1001), Some("42".into()));
        let mut core = Core::default();
        let pending = core.begin_voice(&cfg, &voice, 1001).unwrap();
        assert!(core.unclaimed(1001).is_none());
        assert!(core.finish_voice(&pending, "", 1002).is_none());
        let ready = core.finish_voice(&pending, "我喜欢乌龙茶", 1002).unwrap();
        assert_eq!(ready.nickname, "主人");
        assert_eq!(ready.text, "我喜欢乌龙茶");
        assert!(core.claim(&ready.nonce, 1002));
        core.memory_lease = Some("test-lease".into());
        core.take_draft(&ready.nonce, "我记着了", 1002).unwrap();
        let mut conn = crate::memory::qq_test_connection();
        assert!(
            core.record_exchange(&mut conn, &ready.nonce, "我记着了", "test-lease", "sent")
                .unwrap()
                .unwrap()
                .accepted
        );
        assert!(core.begin_voice(&cfg, &voice, 1003).is_none());
        for key in ["user_id", "self_id"] {
            let mut other = voice.clone();
            other[key] = json!(99999999);
            assert!(owner_record(&cfg, &other, 1001).is_none());
        }
        cfg.voice_input = false;
        assert!(owner_record(&cfg, &voice, 1001).is_none());
    }
    #[test]
    fn voice_input_rejects_mixed_stale_failed_and_cancelled_results() {
        let mut cfg = config();
        cfg.voice_input = true;
        let mut voice = event();
        voice["message"] = json!([{"type":"record","data":{}}]);
        for (key, value) in [
            ("message_type", json!("group")),
            ("sub_type", json!("other")),
            ("time", json!(1)),
            (
                "message",
                json!([{"type":"record","data":{}},{"type":"text","data":{"text":"x"}}]),
            ),
        ] {
            let mut bad = voice.clone();
            bad[key] = value;
            assert!(owner_record(&cfg, &bad, 1001).is_none());
        }
        for value in [
            json!({"status":"failed","retcode":1,"data":{"text":"词"}}),
            json!({"status":"ok","retcode":0,"data":{"text":"[CQ:record]"}}),
            json!({"status":"ok","retcode":0,"data":{"text":"字".repeat(2001)}}),
        ] {
            assert!(transcript_text(&value).is_none());
        }
        let mut core = Core::default();
        let pending = core.begin_voice(&cfg, &voice, 1001).unwrap();
        assert!(core.finish_voice(&pending, "过期", 1037).is_none());
        core.cancel();
        assert!(core.finish_voice(&pending, "迟到", 1003).is_none());
        voice["message_id"] = json!(43);
        voice["time"] = json!(1004);
        let pending = core.begin_voice(&cfg, &voice, 1004).unwrap();
        let mut next = event();
        next["message_id"] = json!(44);
        next["time"] = json!(1007);
        core.accept(&cfg, &next, 1007).unwrap();
        assert!(core.finish_voice(&pending, "旧语音", 1008).is_none());
        assert_eq!(core.unclaimed(1008).unwrap().text, "你好元元");
    }
    #[test]
    fn media_config_roundtrip_defaults_and_rejects_unknown_modes() {
        let old = serde_json::to_value(config()).unwrap();
        let mut legacy = old.clone();
        legacy.as_object_mut().unwrap().remove("replyMode");
        legacy.as_object_mut().unwrap().remove("voiceInput");
        let defaults: Config = serde_json::from_value(legacy).unwrap();
        assert_eq!(defaults.reply_mode, "text");
        assert!(!defaults.voice_input);
        let mut voice = old;
        voice["replyMode"] = json!("voice");
        voice["voiceInput"] = json!(true);
        let loaded: Config = serde_json::from_value(voice.clone()).unwrap();
        assert!(loaded.validate().is_ok());
        assert_eq!(loaded.reply_mode, "voice");
        assert!(loaded.voice_input);
        voice["replyMode"] = json!("arbitrary");
        assert!(serde_json::from_value::<Config>(voice)
            .unwrap()
            .validate()
            .is_err());
    }
    #[test]
    fn claimed_owner_text_survives_claim_until_send_or_cancel() {
        let mut core = Core::default();
        let incoming = core.accept(&config(), &event(), 1001).unwrap();
        assert!(core.claim(&incoming.nonce, 1001));
        assert_eq!(
            core.delivery.as_ref().map(|e| e.text.as_str()),
            Some("你好元元")
        );
        assert!(core.unclaimed(1001).is_none());
        core.cancel();
        assert!(core.delivery.is_none());
    }
    fn claimed(text: &str) -> (Core, Incoming, rusqlite::Connection) {
        let mut core = Core::default();
        let mut input = event();
        input["message"] = json!(text);
        let incoming = core.accept(&config(), &input, 1001).unwrap();
        assert!(core.claim(&incoming.nonce, 1001));
        core.memory_lease = Some("test-lease".into());
        (core, incoming, crate::memory::qq_test_connection())
    }
    fn recalled(
        conn: &mut rusqlite::Connection,
        nickname: &str,
    ) -> Vec<crate::memory::MemoryRecallItem> {
        crate::memory::recall_memory(
            conn,
            &crate::memory::MemoryRecallRequest {
                card_id: "".into(),
                nickname: nickname.into(),
                query: "乌龙茶".into(),
                reason: "".into(),
                image_caption: "".into(),
                max_items: Some(6),
            },
        )
        .unwrap()
        .items
    }
    #[test]
    fn qq_explicit_save_reads_back_in_desktop_scope_and_deduplicates() {
        let (mut core, input, mut conn) = claimed("请记住：我喜欢乌龙茶");
        assert!(core
            .remember(&mut conn, "forged", "test-lease", 1001)
            .is_err());
        assert!(core
            .remember(&mut conn, &input.nonce, "old-lease", 1001)
            .is_err());
        let receipt = core
            .remember(&mut conn, &input.nonce, "test-lease", 1001)
            .unwrap();
        assert!(receipt.stored);
        assert!(!receipt.duplicate);
        assert!(
            core.remember(&mut conn, &input.nonce, "test-lease", 1001)
                .unwrap()
                .duplicate
        );
        assert_eq!(recalled(&mut conn, "主人").len(), 1);
        assert!(recalled(&mut conn, "别人").is_empty());
        core.cancel();
        assert!(core
            .remember(&mut conn, &input.nonce, "test-lease", 1001)
            .is_err());
    }
    #[test]
    fn qq_exchange_enters_memory_only_after_confirmed_delivery() {
        let (mut core, input, mut conn) = claimed("我喜欢乌龙茶");
        // Generation alone must not become evidence.
        assert!(core
            .record_exchange(&mut conn, &input.nonce, "回复", "test-lease", "sent")
            .is_none());
        core.take_draft(&input.nonce, "回复", 1001).unwrap();
        assert!(core
            .record_exchange(&mut conn, &input.nonce, "回复", "test-lease", "unknown")
            .is_none());
        assert!(core
            .record_exchange(&mut conn, &input.nonce, "回复", "test-lease", "failed")
            .is_none());
        let queued = core
            .record_exchange(&mut conn, &input.nonce, "回复", "test-lease", "sent")
            .unwrap()
            .unwrap();
        assert!(queued.accepted);
        assert!(core
            .record_exchange(&mut conn, &input.nonce, "回复", "test-lease", "sent")
            .is_none());
    }
    #[test]
    fn sent_voice_memory_survives_new_input_but_not_explicit_cancellation() {
        let (mut core, input, mut conn) = claimed("我喜欢乌龙茶");
        core.take_draft(&input.nonce, "回复", 1001).unwrap();
        let evidence = core.delivery_evidence().unwrap();
        let mut next = event();
        next["message_id"] = json!(43);
        next["time"] = json!(1004);
        core.accept(&config(), &next, 1004).unwrap();
        assert!(
            core.record_evidence(&mut conn, evidence, "test-lease", "sent")
                .unwrap()
                .unwrap()
                .accepted
        );
        let (mut core, input, mut conn) = claimed("我喜欢乌龙茶");
        core.take_draft(&input.nonce, "回复", 1001).unwrap();
        let evidence = core.delivery_evidence().unwrap();
        core.cancel();
        assert!(core
            .record_evidence(&mut conn, evidence, "test-lease", "sent")
            .is_none());
    }
    #[test]
    fn qq_explicit_save_respects_a_no_save_request_inside_the_message() {
        let (mut core, input, mut conn) = claimed("请记住：不要保存这段乌龙茶测试");
        assert!(core
            .remember(&mut conn, &input.nonce, "test-lease", 1001)
            .is_err());
        assert!(recalled(&mut conn, "主人").is_empty());
    }
    #[test]
    fn qq_private_sensitive_explicit_and_cancelled_exchanges_never_queue() {
        for text in [
            "不要保存这段",
            "临时口令是青柠47，只在本次聊天里用",
            "我的密码是123",
            "请记住：我喜欢乌龙茶",
            "请帮我记住，我喜欢乌龙茶",
        ] {
            let (mut core, input, mut conn) = claimed(text);
            core.take_draft(&input.nonce, "回复", 1001).unwrap();
            assert!(
                !core
                    .record_exchange(&mut conn, &input.nonce, "回复", "test-lease", "sent")
                    .unwrap()
                    .unwrap()
                    .accepted
            );
        }
        let (mut core, input, mut conn) = claimed("我喜欢乌龙茶");
        core.take_draft(&input.nonce, "回复", 1001).unwrap();
        core.cancel();
        assert!(core
            .record_exchange(&mut conn, &input.nonce, "回复", "test-lease", "sent")
            .is_none());
        let (mut core, input, mut conn) = claimed("请记住：我喜欢乌龙茶");
        core.remember(&mut conn, &input.nonce, "test-lease", 1001)
            .unwrap();
        core.take_draft(&input.nonce, "已保存", 1001).unwrap();
        assert!(core
            .record_exchange(&mut conn, &input.nonce, "已保存", "test-lease", "sent")
            .is_none());
        // Database failure produces no false explicit-save success.
        let (mut core, input, mut conn) = claimed("请记住：我喜欢乌龙茶");
        conn.execute_batch("PRAGMA query_only=ON").unwrap();
        assert!(core
            .remember(&mut conn, &input.nonce, "test-lease", 1001)
            .is_err());
    }
    #[test]
    fn saved_desktop_identity_overrides_old_qq_binding_for_incoming_messages() {
        let mut desktop = crate::Settings::defaults();
        let old = Config {
            nickname: "ππ".into(),
            card_id: "old-card".into(),
            ..config()
        };
        // Reproduce an old persisted binding surviving a desktop nickname/mode save.
        let old: Config = serde_json::from_value(serde_json::to_value(old).unwrap()).unwrap();
        desktop.user_name = " 元宝 ".into();
        desktop.online_prompt_mode = "original".into();
        let current = old.follow_settings(&desktop);
        let incoming = Core::default().accept(&current, &event(), 1001).unwrap();
        assert_eq!(incoming.nickname, "元宝");
        assert_eq!(incoming.card_id, desktop.persona_card_id);
        assert_eq!(current.owner_id, old.owner_id);
        assert_eq!(current.bot_id, old.bot_id);
        assert_eq!(current.token, old.token);
        desktop.persona_card_id = "custom-card".into();
        desktop.user_name = "新昵称".into();
        let incoming = Core::default()
            .accept(&old.follow_settings(&desktop), &event(), 1001)
            .unwrap();
        assert_eq!(incoming.nickname, "新昵称");
        assert_eq!(incoming.card_id, "custom-card");
    }
    #[test]
    fn desktop_default_qq_name_matches_persona_scope_without_reusing_old_identity() {
        let mut desktop = crate::Settings::defaults();
        desktop.user_name = " ".into();
        for card in ["", "kxyy-yuanyuan", "kxyy-custom"] {
            desktop.persona_card_id = card.into();
            assert_eq!(config().follow_settings(&desktop).nickname, "元宝");
        }
        desktop.persona_card_id = "custom-card".into();
        assert_eq!(config().follow_settings(&desktop).nickname, "");
        assert!(config().follow_settings(&desktop).validate().is_err());
    }
    #[tokio::test]
    async fn loopback_onebot_auth_identity_text_and_ack_contract() {
        use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut cfg = config();
        cfg.ws_url = format!("ws://{}", listener.local_addr().unwrap());
        let peer = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws =
                tokio_tungstenite::accept_hdr_async(stream, |r: &Request, response: Response| {
                    assert_eq!(
                        r.headers().get("authorization").unwrap(),
                        "Bearer local-secret"
                    );
                    Ok(response)
                })
                .await
                .unwrap();
            let request: Value =
                serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(request["action"], "get_login_info");
            ws.send(Message::Text(json!({"status":"ok","retcode":0,"data":{"user_id":87654321},"echo":request["echo"]}).to_string())).await.unwrap();
            ws.send(Message::Text(event().to_string())).await.unwrap();
            let request: Value =
                serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(request["action"], "send_private_msg");
            assert_eq!(request["params"]["user_id"], 12345678);
            assert_eq!(request["params"]["message"][0]["type"], "text");
            assert_eq!(request["params"]["message"][0]["data"]["text"], "你好呀");
            ws.send(Message::Text(
                json!({"status":"ok","retcode":0,"data":{"message_id":77},"echo":request["echo"]})
                    .to_string(),
            ))
            .await
            .unwrap();
        });
        tokio::time::timeout(Duration::from_secs(3), async {
            let (mut socket, early) = connect_verified(&cfg).await.unwrap();
            assert!(early.is_none());
            let received: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            let mut core = Core::default();
            let incoming = core.accept(&cfg, &received, 1001).unwrap();
            assert!(core.claim(&incoming.nonce, 1001));
            let message = core.take_draft(&incoming.nonce, "你好呀", 1001).unwrap();
            socket
                .send(Message::Text(send_action(&cfg, message, "draft-1")))
                .await
                .unwrap();
            let ack: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            assert_eq!(ack_outcome(&ack, "draft-1"), Some("sent"));
            assert_eq!(ack_outcome(&ack, "wrong"), None);
            assert_eq!(
                ack_outcome(
                    &json!({"echo":"draft-1","status":"failed","retcode":1}),
                    "draft-1"
                ),
                Some("failed")
            );
            assert!(core.take_draft(&incoming.nonce, "retry", 1002).is_err());
            peer.await.unwrap();
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn wrong_bot_identity_never_opens_transport() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut cfg = config();
        cfg.ws_url = format!("ws://{}", listener.local_addr().unwrap());
        let peer = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let request: Value =
                serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            ws.send(Message::Text(
                json!({"status":"ok","retcode":0,"data":{"user_id":99999},"echo":request["echo"]})
                    .to_string(),
            ))
            .await
            .unwrap();
        });
        assert!(
            tokio::time::timeout(Duration::from_secs(3), connect_verified(&cfg))
                .await
                .unwrap()
                .is_err()
        );
        peer.await.unwrap();
    }
    #[test]
    fn local_state_is_replaced_and_reloaded_without_text() {
        let path = std::env::temp_dir().join(format!("qq-test-{}.json", uuid::Uuid::new_v4()));
        write_local(&path, &vec!["bot:owner:42"]).unwrap();
        write_local(&path, &vec!["bot:owner:43"]).unwrap();
        assert_eq!(
            read_local::<Vec<String>>(&path, 1000).unwrap(),
            vec!["bot:owner:43"]
        );
        assert!(read_local::<Vec<String>>(&path, 1).is_none());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn unready_consumer_can_claim_one_bounded_pending_message_once() {
        let mut core = Core::default();
        let cfg = config();
        let incoming = core.accept(&cfg, &event(), 1001).unwrap();
        assert!(core.take_draft(&incoming.nonce, "premature", 1001).is_err());
        assert_eq!(core.unclaimed(1002).unwrap().text, "你好元元");
        assert!(!core.claim("wrong", 1002));
        assert!(core.claim(&incoming.nonce, 1002));
        assert!(core.unclaimed(1002).is_none());
        assert!(!core.claim(&incoming.nonce, 1002));
        assert!(core.take_draft(&incoming.nonce, "回复", 1002).is_ok());
        let mut later = event();
        later["message_id"] = json!(43);
        later["time"] = json!(1004);
        core.accept(&cfg, &later, 1004).unwrap();
        assert!(core.unclaimed(1050).is_none());
    }
    #[tokio::test]
    async fn login_handshake_preserves_latest_owner_message() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut cfg = config();
        cfg.ws_url = format!("ws://{}", listener.local_addr().unwrap());
        let peer = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let request: Value =
                serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            let mut incoming = event();
            incoming["time"] = json!(now());
            ws.send(Message::Text(incoming.to_string())).await.unwrap();
            ws.send(Message::Text(json!({"status":"ok","retcode":0,"data":{"user_id":87654321},"echo":request["echo"]}).to_string())).await.unwrap();
        });
        let (_, pending) = tokio::time::timeout(Duration::from_secs(3), connect_verified(&cfg))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            owner_text(&cfg, &pending.unwrap(), now()).unwrap().1,
            "你好元元"
        );
        peer.await.unwrap();
    }
    #[test]
    fn fresh_dedupe_capacity_fails_closed_and_recovers_after_replay_window() {
        let cfg = config();
        let mut core = Core::default();
        for i in 0..512 {
            let mut e = event();
            e["message_id"] = json!(i);
            core.accept(&cfg, &e, 1001);
        }
        let mut e = event();
        e["message_id"] = json!(9999);
        assert!(core.accept(&cfg, &e, 1004).is_none());
        e["message_id"] = json!(0);
        assert!(core.accept(&cfg, &e, 1005).is_none());
        assert_eq!(core.seen.len(), 512);
        e["message_id"] = json!(9999);
        e["time"] = json!(1333);
        assert!(core.accept(&cfg, &e, 1333).is_some());
        assert_eq!(core.seen.len(), 1);
    }
    #[test]
    fn synchronous_invalidation_rejects_a_queued_draft_without_frontend_event() {
        let cfg = config();
        let mut core = Core::default();
        let incoming = core.accept(&cfg, &event(), 1001).unwrap();
        assert!(core.claim(&incoming.nonce, 1001));
        core.cancel();
        assert!(core
            .take_draft(&incoming.nonce, "已删除的记忆", 1002)
            .is_err());
        assert!(core.unclaimed(1002).is_none());
    }
    #[test]
    fn disabled_config_is_still_bounded() {
        assert!(Config {
            token: "x".repeat(257),
            ..Config::default()
        }
        .validate()
        .is_err());
        assert!(Config {
            ws_url: "x".repeat(201),
            ..Config::default()
        }
        .validate()
        .is_err());
        assert!(Config::default().validate().is_ok());
    }
    #[test]
    fn config_is_loopback_only_and_owner_bound() {
        assert!(config().validate().is_ok());
        for url in [
            "ws://evil.test:3001",
            "ws://127.0.0.1.evil.test:3001",
            "wss://127.0.0.1:3001",
            "ws://user:pass@127.0.0.1:3001",
            "ws://127.0.0.1:3001/?token=secret",
        ] {
            assert!(Config {
                ws_url: url.into(),
                ..config()
            }
            .validate()
            .is_err());
        }
        assert!(Config {
            owner_id: "87654321".into(),
            ..config()
        }
        .validate()
        .is_err());
        assert!(Config {
            nickname: "".into(),
            ..config()
        }
        .validate()
        .is_err());
    }
    #[test]
    fn only_fresh_owner_friend_private_text_is_admitted() {
        assert_eq!(
            owner_text(&config(), &event(), 1001),
            Some(("42".into(), "你好元元".into()))
        );
        for (field, value) in [
            ("user_id", json!(99999)),
            ("self_id", json!(99999)),
            ("message_type", json!("group")),
            ("sub_type", json!("group")),
            ("time", json!(1)),
            ("message", json!([{ "type":"image","data":{"file":"x"}}])),
            ("message", json!("[CQ:image,file=x]")),
            ("message", json!("x".repeat(2001))),
        ] {
            let mut e = event();
            e[field] = value;
            assert!(owner_text(&config(), &e, 1001).is_none(), "{field}");
        }
        let mut mixed = event();
        mixed["message"] =
            json!([{"type":"text","data":{"text":"hi"}},{"type":"image","data":{"file":"x"}}]);
        assert!(owner_text(&config(), &mixed, 1001).is_none());
    }
    #[test]
    fn new_owner_message_invalidates_draft_and_reconnect_deduplicates() {
        let mut core = Core::default();
        let cfg = config();
        let first = core.accept(&cfg, &event(), 1001).unwrap();
        assert!(core.accept(&cfg, &event(), 1001).is_none());
        assert!(core.take_draft("wrong", "hi", 1001).is_err());
        let mut second = event();
        second["message_id"] = json!(43);
        second["time"] = json!(1004);
        let next = core.accept(&cfg, &second, 1004).unwrap();
        assert!(core.take_draft(&first.nonce, "old", 1004).is_err());
        assert!(core.claim(&next.nonce, 1004));
        let message = core
            .take_draft(&next.nonce, "[CQ:at,qq=all]", 1004)
            .unwrap();
        assert_eq!(
            message,
            json!([{ "type":"text","data":{"text":"[CQ:at,qq=all]"}}])
        );
        assert!(core.take_draft(&next.nonce, "duplicate", 1004).is_err());
        assert!(core.accept(&cfg, &second, 1005).is_none());
    }
    #[test]
    fn throttle_and_deadline_fail_closed_with_bounded_dedupe() {
        let mut core = Core::default();
        let cfg = config();
        let first = core.accept(&cfg, &event(), 1001).unwrap();
        let mut second = event();
        second["message_id"] = json!(43);
        assert!(core.accept(&cfg, &second, 1001).is_none());
        assert!(core.take_draft(&first.nonce, "stale", 1002).is_err());
        for i in 1..600 {
            let mut e = event();
            e["message_id"] = json!(i + 100);
            e["time"] = json!(1001 + i * 3);
            core.accept(&cfg, &e, 1001 + i * 3);
        }
        assert!(core.seen.len() <= 512);
        let (nonce, at) = core.pending.clone().unwrap();
        assert!(core.take_draft(&nonce, "late", at + 46).is_err());
    }
}
