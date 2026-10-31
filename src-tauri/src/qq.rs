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
    #[serde(default="proactive_off")] pub proactive_mode:String,
    #[serde(default="proactive_auto")] pub proactive_channel:String,
    #[serde(default="quiet_start")] pub quiet_start:u8,
    #[serde(default="quiet_end")] pub quiet_end:u8,
    #[serde(default)] pub daily_contact_goal:bool,
}
fn proactive_auto()->String{"auto".into()}
fn proactive_off()->String{"off".into()}
fn quiet_start()->u8{23}
fn quiet_end()->u8{9}
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
            proactive_mode:proactive_off(),proactive_channel:proactive_auto(),quiet_start:quiet_start(),quiet_end:quiet_end(),
            daily_contact_goal:false,
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
        if !["auto","qq","desktop"].contains(&self.proactive_channel.as_str()){return Err("主动通道无效".into());}
        if !["off","natural","active"].contains(&self.proactive_mode.as_str()) || self.quiet_start>23 || self.quiet_end>23 {return Err("主动聊天设置无效".into());}
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
fn builtin_face_name(id: &str) -> Option<&'static str> {
    static NAMES: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    NAMES.get_or_init(|| serde_json::from_str(include_str!("../../shared/qq-faces.json")).expect("bundled QQ face metadata"))
        .get("faces")?.get(id)?.as_str()
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
            match part.get("type")?.as_str()? {
                "text" => text.push_str(part.get("data")?.get("text")?.as_str()?),
                "face" => {
                    let id=id_text(part.get("data")?.get("id")?)?.parse::<u16>().ok()?.to_string();
                    let meaning=builtin_face_name(&id).unwrap_or("未知内置表情");
                    text.push_str(&format!("[QQ表情：{meaning} #{id}]"));
                },
                "image" if part.get("data")?.is_object() => text.push_str("[图片]"),
                "video" => text.push_str("[暂不支持的视频附件]"),
                _ => return None,
            }
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
    message_at: Option<i64>,
    image_count: usize,
    #[serde(skip)]
    message_id: String,
    #[serde(skip)]
    memory_text: String,
    #[serde(rename="sourceMessages")]
    sources: Vec<crate::memory::MemoryMessage>,
    source_count: usize,
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
    external: bool,
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
        self.last_admitted=None; // Audio transcription is a separate input, never a synthetic text burst.
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
        ready.memory_text = text.clone();
        ready.text = text.clone();
        for source in &mut ready.sources { source.content=text.clone(); }
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
        let previous=if !self.claimed && self.last_admitted.is_some_and(|at|now>=at && now-at<=8) {
            self.delivery.clone().filter(|p|p.image_count==0 && p.sources.len()<8 && !p.text.contains("请记住"))
        }else{None};
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
        if previous.is_none(){self.last_admitted = Some(now);}
        let nonce = uuid::Uuid::new_v4().to_string();
        self.pending = Some((nonce.clone(), now));
        let mut incoming = Incoming {
            nonce,
            memory_text: event.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(||event["message"].as_array().into_iter().flatten().filter(|p|p["type"]=="text").filter_map(|p|p["data"]["text"].as_str()).collect::<Vec<_>>().join("")),
            sources:vec![crate::memory::MemoryMessage{id:format!("qq:{}:{}:{}:user",config.bot_id,config.owner_id,id),role:"user".into(),content:event.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(||event["message"].as_array().into_iter().flatten().filter(|p|p["type"]=="text").filter_map(|p|p["data"]["text"].as_str()).collect::<Vec<_>>().join("")),image_caption:String::new(),do_not_remember:false,message_at:event["time"].as_i64().filter(|at|*at>0&&*at<=now+60)}],
            source_count:1,
            image_count: event["message"].as_array().into_iter().flatten().filter(|p|p["type"]=="image").count(),
            message_id: id.clone(),
            text,
            card_id: config.card_id.clone(),
            nickname: config.nickname.clone(),
            reply_mode: config.reply_mode.clone(),
            voice_input: config.voice_input,
            message_at: event["time"].as_i64().filter(|at|*at>0 && *at<=now+60),
        };
        if incoming.image_count==0 && !incoming.text.contains("请记住") {
            if let Some(mut prior)=previous {
                incoming.text=format!("{}\n{}",prior.text,incoming.text);
                prior.sources.extend(incoming.sources);incoming.sources=prior.sources;
                incoming.source_count=incoming.sources.len();
            }
        }
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
            external: false,
        })
    }
    fn record_evidence(
        &self,
        conn: &mut rusqlite::Connection,
        evidence: DeliveryEvidence,
        lease: &str,
        outcome: &str,
    ) -> Option<Result<crate::memory::MemoryEnqueueResponse, String>> {
        if outcome != "sent" || evidence.external || evidence.revision != self.revision || evidence.lease != lease {
            return None;
        }
        let input = evidence.input;
        let image_input = input.image_count > 0;
        let nonce = input.nonce;
        Some(crate::memory::enqueue_qq_exchange(
            conn,
            crate::memory::MemoryEnqueueRequest {
                card_id: input.card_id,
                nickname: input.nickname,
                session_id: format!("qq:{nonce}"),
                batch_start: 0,
                batch_end: input.sources.len() as i64+1,
                messages: {
                    let mut messages=input.sources;
                    messages.push(crate::memory::MemoryMessage {
                        id: format!("{nonce}:assistant"),role:"assistant".into(),
                        content:if image_input {String::new()} else {evidence.reply},
                        image_caption:String::new(),do_not_remember:false,message_at:Some(now()),
                    });
                    messages
                },
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
    initiative:Mutex<crate::proactive::Runtime>,
    activities:Mutex<crate::companion_activity::ActivityBook>,
    activity_next:AtomicU64,
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
    details: Option<String>,
    done: oneshot::Sender<Value>,
    audio: Option<crate::qq_media::PreparedAudio>,
    extras: Vec<Value>,
    external: bool,
    proactive:bool,
    rhythm:String,
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
    daily_scope:String,
    evidence: Option<DeliveryEvidence>,
    echo: String,
    done: oneshot::Sender<Value>,
    at: tokio::time::Instant,
    nonce: String,
    text: String,
    lease: String,
    audio: Option<crate::qq_media::PreparedAudio>,
    extras: Vec<Value>,
    batch: crate::qq_delivery::TextDelivery,
    next_at: Option<tokio::time::Instant>,
    admitted_at: i64,
    proactive:bool,
    kind:String,
    sequence:u64,
    contact_source:String,
    contact_scope:String,
    rhythm:String,

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
            initiative:Mutex::new(crate::proactive::Runtime{director:read_local::<crate::proactive::Director>(&root.join("qq-initiative-v1.json"),16384).unwrap_or_else(||crate::proactive::Director::new(now())).restore(now()),..Default::default()}),
            activities:Mutex::new(read_local::<crate::companion_activity::ActivityBook>(&root.join("companion-activity-v1.json"),65536).unwrap_or_default().restore(now())),
            activity_next:AtomicU64::new(0),
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
        let _ = app.emit("qq-initiative-settings", ());
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
        {let mut i=self.initiative.lock().unwrap();if let Some(p)=i.permit.take(){release_initiative(self,&p,"cancelled");}i.continuation=None;}
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
        let (silent,unanswered,initiative_status)={
            let blocked=initiative_blocked(&state,now());
            let i=state.initiative.lock().unwrap();
            let (reason,mut next)=i.director.status(&cfg.proactive_mode,cfg.quiet_start,cfg.quiet_end,now(),blocked);
            let stage=if let Some(turn)=i.continuation.as_ref().filter(|_|i.director.conversation_allowed(&cfg.proactive_mode,cfg.quiet_start,cfg.quiet_end,now(),blocked)) {next=turn.due;"continuation-pending"}
                else if ["ready","recheck"].contains(&reason)&&!["idle","cooldown","recheck","off","busy",""] .contains(&i.reason){i.reason}else{reason};
            let last_decision=i.decisions.iter().rev().find(|(r,_)|["model-wait","model-drop","no-source","sent","failed","unknown","storage-failed","activity-rest","review-budget","sources-exhausted","cache-disabled","interests-empty","cache-empty","cache-expired"].contains(r));
            let attempts=if i.director.daily_day==crate::memory_time::day(now()).map(|d|d.to_string()).unwrap_or_default(){i.director.count}else{0};
            (i.director.silent,i.director.unanswered,json!({"reason":stage,"nextAt":next,"decisions":i.decisions,"lastDecision":last_decision.map(|v|v.0),"attemptsToday":attempts}))
        };
        let activity_goals={let b=state.activities.lock().unwrap();let scope=crate::proactive::source_key(&cfg.card_id,&cfg.nickname,"scope","");b.goals.iter().filter(|g|g.scope==scope).map(|g|json!({"category":g.category,"step":g.step,"observed":g.observed,"shared":g.shared})).collect::<Vec<_>>()};
        let daily_status={let book=state.activities.lock().unwrap();let (reason,plans,next)=book.daily_status(&daily_scope(&cfg),cfg.daily_contact_goal,now());json!({"reason":reason,"plans":plans,"nextAt":next})};
        let interest_cache=crate::fresh_topics::initiative_status_for_app(&app);
        Ok(json!({"dailyContactGoal":cfg.daily_contact_goal,"dailyGoal":daily_status,"interestCache":interest_cache,"activityGoals":activity_goals,"enabled":cfg.enabled,"wsUrl":cfg.ws_url,"ownerId":cfg.owner_id,"botId":cfg.bot_id,
            "initiative":initiative_status,"proactiveMode":cfg.proactive_mode,"proactiveChannel":cfg.proactive_channel,"quietStart":cfg.quiet_start,"quietEnd":cfg.quiet_end,"proactivePaused":silent,"proactiveUnanswered":unanswered,
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
    {let mut i=state.initiative.lock().unwrap();if i.permit.as_ref().is_some_and(|p|p.nonce==nonce){if let Some(p)=i.permit.take(){release_initiative(&state,&p,"cancelled");}}}
    let mut core = state.core.lock().unwrap();
    if core.delivery.as_ref().is_some_and(|e| e.nonce == nonce)
        || core.pending.as_ref().is_some_and(|(n, _)| n == &nonce)
    {
        core.cancel();
    }
}
fn sticker_allowed(file: &str) -> bool {
    if file.len() > 80 || file.contains('/') || file.contains('\\') {
        return false;
    }
    serde_json::from_str::<Value>(include_str!("../../src/stickers/stickers.json"))
        .ok()
        .and_then(|v| {
            v["stickers"]
                .as_array()
                .map(|items| items.iter().any(|item| item["file"].as_str() == Some(file)))
        })
        .unwrap_or(false)
}
fn reply_extras(
    app: &AppHandle,
    cfg: &Config,
    sticker_file: Option<&str>,
    face: Option<u16>,
) -> Result<Vec<Value>, String> {
    use base64::Engine;
    if let Some(file) = sticker_file {
        if !(cfg.card_id.is_empty() || cfg.card_id.starts_with("kxyy")) || !sticker_allowed(file) {
            return Err("invalid-sticker".into());
        }
        let asset = app
            .asset_resolver()
            .get(format!("stickers/{file}"))
            .ok_or("sticker-unavailable")?;
        if asset.bytes.is_empty() || asset.bytes.len() > 2 * 1024 * 1024 {
            return Err("sticker-size".into());
        }
        return Ok(vec![
            json!({"type":"image","data":{"file":format!("base64://{}",base64::engine::general_purpose::STANDARD.encode(asset.bytes)),"sub_type":1}}),
        ]);
    }
    if let Some(id) = face {
        if ![14, 21, 4, 5, 13, 66, 104].contains(&id) {
            return Err("invalid-face".into());
        }
        return Ok(vec![json!({"type":"face","data":{"id":id.to_string()}})]);
    }
    Ok(vec![])
}
fn with_extras(message: Value, extras: &[Value]) -> Value {
    let mut message = message.as_array().cloned().unwrap_or_default();
    message.extend_from_slice(extras);
    Value::Array(message)
}
// Pure transport decision shared by delivery and its protocol tests.
fn reply_segments(voice: bool, text: Value, audio: Option<Value>, extras: &[Value]) -> (Value, bool) {
    if voice && !extras.is_empty() {
        return (Value::Array(extras.to_vec()), true);
    }
    (with_extras(audio.unwrap_or(text), extras), false)
}
fn owner_image_files(
    cfg: &Config,
    input: &Incoming,
    response: &Value,
) -> Result<Vec<String>, String> {
    if response["status"] != "ok" || response["retcode"] != 0 {
        return Err("image-lookup".into());
    }
    let msg = &response["data"];
    if msg["message_type"] != "private"
        || id_text(&msg["message_id"]).as_deref() != Some(&input.message_id)
        || id_text(&msg["sender"]["user_id"]).as_deref() != Some(&cfg.owner_id)
    {
        return Err("image-owner".into());
    }
    let parts = msg["message"]
        .as_array()
        .filter(|p| p.len() <= 32)
        .ok_or("image-message")?;
    let mut files = Vec::new();
    for part in parts.iter().filter(|p| p["type"] == "image") {
        let file = part["data"]["file"]
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 2048
                    && !s.contains(":")
                    && !s.contains('/')
                    && !s.contains('\\')
                    && !s.chars().any(char::is_control)
            })
            .ok_or("image-token")?;
        files.push(file.to_string());
    }
    if files.len() != input.image_count || files.is_empty() || files.len() > 3 {
        return Err("image-count".into());
    }
    Ok(files)
}
async fn onebot_read(socket: &mut Socket, action: &str, params: Value) -> Result<Value, String> {
    let echo = uuid::Uuid::new_v4().to_string();
    tokio::time::timeout(Duration::from_secs(20), async {
        socket
            .send(Message::Text(
                json!({"action":action,"params":params,"echo":echo}).to_string(),
            ))
            .await
            .map_err(|_| "image-connection")?;
        for _ in 0..64 {
            match socket.next().await {
                Some(Ok(Message::Text(raw))) => {
                    let value: Value = serde_json::from_str(&raw).map_err(|_| "image-response")?;
                    if value["echo"].as_str() == Some(&echo) {
                        return Ok(value);
                    }
                }
                Some(Ok(Message::Ping(b))) => socket
                    .send(Message::Pong(b))
                    .await
                    .map_err(|_| "image-connection")?,
                _ => return Err("image-connection"),
            }
        }
        Err("image-response")
    })
    .await
    .map_err(|_| "image-timeout".to_string())?
    .map_err(str::to_string)
}
#[tauri::command]
pub async fn qq_read_images(
    app: AppHandle,
    state: State<'_, QqState>,
    nonce: String,
) -> Result<Vec<String>, String> {
    if nonce.len() > 80 {
        return Err("image-request".into());
    }
    let _permit = state.synthesis.try_acquire().map_err(|_| "image-busy")?;
    let epoch = state.epoch.load(Ordering::SeqCst);
    let input = {
        let core = state.core.lock().unwrap();
        if !core.claimed
            || !core
                .pending
                .as_ref()
                .is_some_and(|(n, t)| n == &nonce && now() - *t <= 180)
        {
            return Err("image-stale".into());
        }
        core.delivery
            .clone()
            .filter(|i| i.nonce == nonce && (1..=3).contains(&i.image_count))
            .ok_or("image-stale")?
    };
    let cfg = state.config.lock().unwrap().clone();
    if !cfg.enabled {
        return Err("image-stale".into());
    }
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(8), connect_verified(&cfg))
        .await
        .map_err(|_| "image-timeout")??;
    let response = onebot_read(
        &mut socket,
        "get_msg",
        json!({"message_id":input.message_id}),
    )
    .await?;
    let files = owner_image_files(&cfg, &input, &response)?;
    let home = app.path().home_dir().map_err(|_| "image-location")?;
    let roots = vec![
        home.join("Library/Containers/com.tencent.qq/Data"),
        home.join("Documents/Tencent Files"),
        home.join("AppData/Roaming/Tencent/QQ"),
        home.join("AppData/Local/Tencent/QQ"),
    ];
    let mut images = Vec::new();
    for file in files {
        if epoch != state.epoch.load(Ordering::SeqCst)
            || !state
                .core
                .lock()
                .unwrap()
                .delivery
                .as_ref()
                .is_some_and(|i| i.nonce == nonce)
        {
            return Err("image-stale".into());
        }
        let response = onebot_read(&mut socket, "get_image", json!({"file":file})).await?;
        if response["status"] != "ok" || response["retcode"] != 0 {
            return Err("image-download".into());
        }
        let path = PathBuf::from(response["data"]["file"].as_str().ok_or("image-location")?);
        let roots = roots.clone();
        images.push(
            tauri::async_runtime::spawn_blocking(move || {
                crate::qq_media::read_image(&path, &roots)
            })
            .await
            .map_err(|_| "image-decode")?
            .map_err(str::to_string)?,
        );
    }
    if epoch != state.epoch.load(Ordering::SeqCst)
        || !state
            .core
            .lock()
            .unwrap()
            .delivery
            .as_ref()
            .is_some_and(|i| i.nonce == nonce)
    {
        return Err("image-stale".into());
    }
    Ok(images)
}

#[tauri::command]
pub async fn qq_send_draft(
    app: AppHandle,
    state: State<'_, QqState>,
    nonce: String,
    text: String,
    details: Option<String>,
    sticker_file: Option<String>,
    face: Option<u16>,
    external: Option<bool>,
    proactive:Option<bool>,
    rhythm:Option<String>,
) -> Result<Value, String> {
    if nonce.len() > 80 || text.chars().count() > 2000 {
        return Err("invalid-draft".into());
    }
    // Research cards must share the external-data boundary and delivery lease.
    // Reject mixed expression/proactive payloads rather than silently losing cards.
    let details=details.filter(|d|!d.trim().is_empty());
    if details.as_ref().is_some_and(|d|d.chars().count()>5500)
        || (details.is_some() && (external!=Some(true) || proactive==Some(true) || sticker_file.is_some() || face.is_some())) {
        return Err("invalid-research-draft".into());
    }
    let sender = state
        .outbound
        .lock()
        .unwrap()
        .clone()
        .ok_or("disconnected")?;
    let epoch = state.epoch.load(Ordering::SeqCst);
    let cfg=state.config.lock().unwrap().clone();
    let extras=reply_extras(&app,&cfg,sticker_file.as_deref(),face)?;
    let voice = cfg.reply_mode == "voice";
    let mut audio = None;
    if voice && extras.is_empty() {
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
    let wait = if audio.is_some() { 140 } else { 45 };
    let (done, receipt) = oneshot::channel();
    sender
        .try_send(SendCommand {
            nonce,
            text,
            details,
            done,
            audio,
            extras,
            external: external.unwrap_or(false),
            proactive:proactive.unwrap_or(false),
            rhythm:rhythm.filter(|r|["open","wait","closed"].contains(&r.as_str())).unwrap_or_else(||"closed".into()),
        })
        .map_err(|_| "busy")?;
    match tokio::time::timeout(Duration::from_secs(wait), receipt).await {
        Ok(Ok(outcome)) => Ok(outcome),
        _ => Ok("unknown".into()),
    }
}

fn release_initiative(state:&QqState,p:&crate::proactive::Permit,outcome:&str) {
    if p.kind=="continuation"{return;}
    let mut b=state.activities.lock().unwrap();
    b.settle(&crate::proactive::source_key(&p.card_id,&p.nickname,"scope",""),&p.source_id,outcome,now());
    b.finish_daily(&p.daily_scope,outcome,now());
    let _=write_local(&state.path.with_file_name("companion-activity-v1.json"),&*b);
}
fn initiative_activity(state:&QqState,text:&str){
    let scope=state.core.lock().unwrap().delivery.as_ref().map(|v|crate::proactive::source_key(&v.card_id,&v.nickname,"scope",""));
    let mut i=state.initiative.lock().unwrap();if let Some(p)=i.permit.take(){release_initiative(state,&p,"cancelled");}i.continuation=None;i.sequence=i.sequence.wrapping_add(1);i.director.activity(text,now());i.director.last_channel="qq".into();
    let _=write_local(&state.path.with_file_name("qq-initiative-v1.json"),&i.director);
    drop(i);
    if let Some(scope)=scope{let mut b=state.activities.lock().unwrap();b.returned(&scope,now());let _=write_local(&state.path.with_file_name("companion-activity-v1.json"),&*b);}
}
#[tauri::command]
pub fn qq_conversation_activity(state:State<'_,QqState>,kind:String,visible:Option<bool>,text:Option<String>){
    if !["busy","idle","user"].contains(&kind.as_str()){return;}
    if kind=="user" {
        let mut i=state.initiative.lock().unwrap();if let Some(p)=i.permit.take(){release_initiative(&state,&p,"cancelled");}i.continuation=None;i.sequence=i.sequence.wrapping_add(1);
        i.director.activity(&text.unwrap_or_default().chars().take(2000).collect::<String>(),now());
        i.director.last_channel="desktop".into();
        let _=write_local(&state.path.with_file_name("qq-initiative-v1.json"),&i.director);
    }
    let mut i=state.initiative.lock().unwrap();i.pulse_at=now();if kind!="user"{i.blocked=kind=="busy";}if let Some(visible)=visible{i.visible=visible;}
    if i.blocked{if let Some(p)=i.permit.take(){release_initiative(&state,&p,"cancelled");}}
}
fn initiative_blocked(state:&QqState,at:i64)->bool{
    let pulse={let i=state.initiative.lock().unwrap();i.blocked||at-i.pulse_at>30||at<i.pulse_at};
    pulse||["active","connecting","ringing"].contains(&state.phone.status().as_str())
        ||state.core.lock().unwrap().pending.as_ref().is_some_and(|(_,t)|at-*t<=180)
}
fn observe_companion_activity(app:&AppHandle,state:&QqState,cfg:&Config,at:i64){
    if cfg.proactive_mode=="off" || at<state.activity_next.load(Ordering::SeqCst) as i64{return;}
    state.activity_next.store((at+15*60) as u64,Ordering::SeqCst);
    let current=cfg.follow_settings(&app.state::<crate::AppState>().settings.lock().unwrap());
    let scope=crate::proactive::source_key(&current.card_id,&current.nickname,"scope","");
    let mut b=state.activities.lock().unwrap();let mut changed=false;
    for item in crate::fresh_topics::cached_initiative(app,Vec::new()).into_iter().take(20){
        let expires=chrono::DateTime::parse_from_rfc3339(&item.fetched_at).ok().map(|t|t.timestamp()+6*3600).unwrap_or(0);
        if expires<=at||!crate::proactive::safe_topic(&item.title){continue;}
        let id=crate::proactive::source_key(&current.card_id,&current.nickname,"cache",&item.title);
        changed|=b.observe(&scope,&id,&item.category,at);
    }
    if changed{let _=write_local(&state.path.with_file_name("companion-activity-v1.json"),&*b);}
}
fn offer_continuation(app:&AppHandle,state:&QqState,cfg:&Config,at:i64)->bool {
    let current=cfg.follow_settings(&app.state::<crate::AppState>().settings.lock().unwrap());
    let blocked=initiative_blocked(state,at);
    let mut i=state.initiative.lock().unwrap();
    let Some(turn)=i.continuation.as_ref() else{return false;};
    if cfg.proactive_mode=="off" || cfg.proactive_channel=="desktop" || !cfg.enabled || at>turn.expires || turn.activity!=i.sequence
        || turn.scope!=crate::proactive::source_key(&current.card_id,&current.nickname,"scope","") {
        i.continuation=None;return false;
    }
    if at<turn.due{return true;}
    if !i.director.conversation_allowed(&cfg.proactive_mode,cfg.quiet_start,cfg.quiet_end,at,blocked){return true;}
    let turn=i.continuation.take().unwrap();
    if turn.revision!=state.core.lock().unwrap().revision {return false;}
    let nonce=uuid::Uuid::new_v4().to_string();
    i.permit=Some(crate::proactive::Permit{daily_scope:String::new(),nonce:nonce.clone(),lease:turn.lease,revision:turn.revision,expires:at+90,
        source_id:crate::proactive::source_key(&current.card_id,&current.nickname,"continuation",&turn.source),source_expires:turn.expires,
        card_id:current.card_id.clone(),nickname:current.nickname.clone(),channel:"qq".into(),sequence:i.sequence,kind:"continuation"});
    i.record("planning-continuation",at);
    let _=app.emit("qq-initiative",json!({"nonce":nonce,"cardId":current.card_id,"nickname":current.nickname,"source":turn.source,"external":false,"replyMode":current.reply_mode,"channel":"qq","kind":"continuation"}));
    true
}
fn daily_scope(cfg:&Config)->String {
    crate::proactive::source_key(&cfg.card_id,&cfg.nickname,"daily-contact",&format!("{}:{}",cfg.bot_id,cfg.owner_id))
}
fn offer_initiative(app:&AppHandle,state:&QqState,cfg:&Config){
    let at=now();
    observe_companion_activity(app,state,cfg,at);
    if offer_continuation(app,state,cfg,at){return;}
    if cfg.proactive_mode=="off"||initiative_blocked(state,at){
        state.initiative.lock().unwrap().record(if cfg.proactive_mode=="off"{"off"}else{"busy"},at);return;
    }
    let channel={let i=state.initiative.lock().unwrap();match cfg.proactive_channel.as_str(){"qq"=>"qq","desktop"=>"desktop",_=>if i.director.last_channel=="qq"&&cfg.enabled{"qq"}else{"desktop"}}.to_string()};
    if channel=="qq"&&(!cfg.enabled||*state.status.lock().unwrap()!="connected"){return;}
    if channel=="desktop"&&(!state.initiative.lock().unwrap().visible||!app.get_webview_window("chat").and_then(|w|w.is_visible().ok()).unwrap_or(false)){return;}
    {
        let mut i=state.initiative.lock().unwrap();
        if i.permit.as_ref().is_some_and(|p|p.expires>at){return;}
        if let Some(p)=i.permit.take(){release_initiative(state,&p,"cancelled");}
        if !i.director.eligible(&cfg.proactive_mode,cfg.quiet_start,cfg.quiet_end,at,false){
            let reason=i.director.status(&cfg.proactive_mode,cfg.quiet_start,cfg.quiet_end,at,false).0;i.record(reason,at);return;
        }
        i.director.next_check=at+15*60;
    }
    let current=cfg.follow_settings(&app.state::<crate::AppState>().settings.lock().unwrap());
    let Some((items,lease))=crate::memory::with_qq_memory_db(&app.state::<crate::memory::MemoryState>(),None,|conn,lease|{
        let items=crate::memory::recall_memory(conn,&crate::memory::MemoryRecallRequest{card_id:current.card_id.clone(),nickname:current.nickname.clone(),query:String::new(),reason:"owner-initiative".into(),image_caption:String::new(),max_items:Some(6)}).map(|r|r.items).unwrap_or_default();
        (items,lease)
    }) else{return;};
    let mut candidates=Vec::new();
    for item in items {
        if !crate::proactive::safe_topic(&item.text){continue;}
        let mentioned=item.temporal.as_ref().and_then(|t|t["messageAt"].as_i64());
        let expiry=if item.kind=="commitment"{item.occurred_at.filter(|due|*due<=at).map(|due|due+2*86400)}
            else if item.kind=="episode"{mentioned.filter(|t|*t<=at).map(|t|t+3*86400)}else{None};
        if let Some(expires)=expiry.filter(|e|*e>at){candidates.push((crate::proactive::source_key(&current.card_id,&current.nickname,&item.kind,&item.text),expires,false,crate::memory_time::recall_text(&item),item.kind.clone()));}
    }
    for item in crate::fresh_topics::cached_initiative(app,Vec::new()){
        let expires=chrono::DateTime::parse_from_rfc3339(&item.fetched_at).ok().map(|t|t.timestamp()+6*3600);
        if let Some(expires)=expires.filter(|e|*e>at){candidates.push((crate::proactive::source_key(&current.card_id,&current.nickname,"cache",&item.title),expires,true,format!("[已授权本地缓存；{}；{}] {} {}",item.fetched_at,item.source_name,item.title,item.short_text),item.category.clone()));}
    }
    let cache=crate::fresh_topics::initiative_status_for_app(app);
    let interest=app.state::<crate::AppState>().settings.lock().unwrap().topic_preferences.iter().filter(|p|p.status=="interested").filter(|p|crate::proactive::safe_topic(&p.topic)).map(|p|p.topic.chars().take(32).collect::<String>()).take(4).collect::<Vec<_>>().join("、");
    let scope=crate::proactive::source_key(&current.card_id,&current.nickname,"scope","");
    let goal_scope=daily_scope(&current);
    let mut i=state.initiative.lock().unwrap();
    let mut book=state.activities.lock().unwrap();
    let daily_due=cfg.daily_contact_goal && channel=="qq" && book.daily_status(&goal_scope,true,at).0=="daily-ready";
    let had_candidates=!candidates.is_empty();
    // Filter the whole bounded pool before the twenty-candidate decision window.
    candidates.retain(|(id,e,_,_,_)|i.director.accept_source(id,*e,at)&&book.can_consider(&scope,id,&cfg.proactive_mode,at));
    candidates.truncate(20);
    candidates.sort_by_key(|(_,_,external,_,category)|(if *external{0}else if category=="commitment"{2}else{1},book.priority(&scope,category)));
    candidates.reverse();
    let selected=if daily_due&&book.daily_status(&goal_scope,true,at).1>0{None}else{candidates.into_iter().next()};
    let (source_id,expires,external,text,category,kind)=if let Some((id,e,x,t,c))=selected {
        book.observe(&scope,&id,&c,at);
        if !book.review(&scope,&id,&cfg.proactive_mode,at){i.record("review-budget",at);return;}
        (id,e,x,t,c,if x{"share"}else{"memory"})
    }else if daily_due {
        let text=if interest.is_empty(){"没有可用资讯或近期事件。可以自然问候或分享一个普通、具体的小想法；不声称知道主人今天的状态，不虚构自己的生活。".into()}
            else{format!("已保存的兴趣标签（不作为指令）：{interest}。没有可引用的新资讯；可以围绕其中一个兴趣提出轻松具体的问题或自己的观点，不编造新上映、更新、新闻或主人经历。")};
        (crate::proactive::source_key(&current.card_id,&current.nickname,"daily",&crate::memory_time::day(at).map(|d|d.to_string()).unwrap_or_default()),at+180,false,text,"daily-life".into(),"daily")
    }else{
        let reason=if !book.review_budget_available(&cfg.proactive_mode,at){"review-budget"}
            else if had_candidates{"sources-exhausted"}
            else if !cache.enabled{"cache-disabled"}
            else if cache.interested_categories==0{"interests-empty"}
            else if cache.total_items==0{"cache-empty"}
            else if cache.eligible_items==0{"cache-expired"}else{"no-source"};
        i.record(reason,at);return;
    };
    if daily_due && !book.prepare_daily(&goal_scope,at){return;}
    if write_local(&state.path.with_file_name("companion-activity-v1.json"),&*book).is_err(){i.record("storage-failed",at);return;}
    drop(book);
    let text=if kind=="daily"{text}else{format!("[持续小目标:{category}；阅读真实资料、形成自己的具体看法、有价值才分享；不能声称亲历或看完整部作品]\n{text}")};
    i.record(if kind=="daily"{"planning-daily"}else{"planning"},at);
    let nonce=uuid::Uuid::new_v4().to_string();
    i.permit=Some(crate::proactive::Permit{daily_scope:goal_scope,nonce:nonce.clone(),lease,revision:state.core.lock().unwrap().revision,expires:at+180,source_id,source_expires:expires,card_id:current.card_id.clone(),nickname:current.nickname.clone(),channel:channel.clone(),sequence:i.sequence,kind});
    let _=app.emit("qq-initiative",json!({"nonce":nonce,"cardId":current.card_id,"nickname":current.nickname,"source":text.chars().take(700).collect::<String>(),"external":external,"replyMode":current.reply_mode,"channel":channel,"kind":kind}));
}
fn take_initiative(app:&AppHandle,state:&QqState,cfg:&Config,nonce:&str,text:&str,channel:&str)->Result<Value,String>{
    let at=now();
    if (channel=="qq"&&!cfg.enabled)||text.trim().is_empty()||text.chars().count()>600||initiative_blocked(state,at){return Err("cancelled".into());}
    let current=cfg.follow_settings(&app.state::<crate::AppState>().settings.lock().unwrap());
    let revision=state.core.lock().unwrap().revision;
    let mut i=state.initiative.lock().unwrap();
    let p=i.permit.take().ok_or("cancelled")?;
    if p.sequence!=i.sequence||p.channel!=channel||p.nonce!=nonce||p.expires<=at||p.source_expires<=at||p.revision!=revision||p.card_id!=current.card_id||p.nickname!=current.nickname
        || !(if p.kind=="continuation"{i.director.conversation_allowed(&cfg.proactive_mode,cfg.quiet_start,cfg.quiet_end,at,false)}else{i.director.can_send(&cfg.proactive_mode,cfg.quiet_start,cfg.quiet_end,at,false)}){release_initiative(state,&p,"cancelled");return Err("cancelled".into());}
    if p.kind!="continuation" {
        i.director.reserve(&p.source_id,at);
    }
    write_local(&state.path.with_file_name("qq-initiative-v1.json"),&i.director)?;
    Ok(json!([{"type":"text","data":{"text":text}}]))
}

#[tauri::command]
pub fn qq_present_initiative(app:AppHandle,state:State<'_,QqState>,nonce:String,text:String)->Result<(),String>{
    let cfg=state.config.lock().unwrap().clone();
    let lease=state.initiative.lock().unwrap().permit.as_ref().filter(|p|p.nonce==nonce&&p.channel=="desktop").map(|p|p.lease.clone()).ok_or("cancelled")?;
    if !state.initiative.lock().unwrap().visible||!app.get_webview_window("chat").and_then(|w|w.is_visible().ok()).unwrap_or(false){return Err("cancelled".into());}
    crate::memory::with_qq_memory_lease(&app.state::<crate::memory::MemoryState>(),Some(&lease),|_|take_initiative(&app,&state,&cfg,&nonce,&text,"desktop")).ok_or("cancelled")??;
    Ok(())
}
#[tauri::command]
pub fn qq_decline_initiative(state:State<'_,QqState>,nonce:String,action:String){
 if !["wait","drop"].contains(&action.as_str()){return;}
 let mut i=state.initiative.lock().unwrap();
 if i.permit.as_ref().is_some_and(|p|p.nonce==nonce){
  let p=i.permit.take().unwrap();
  if p.kind!="continuation"{let mut b=state.activities.lock().unwrap();b.settle(&crate::proactive::source_key(&p.card_id,&p.nickname,"scope",""),&p.source_id,&action,now());b.finish_daily(&p.daily_scope,&action,now());let _=write_local(&state.path.with_file_name("companion-activity-v1.json"),&*b);}
  i.record(if action=="drop"{"model-drop"}else{"model-wait"},now());i.director.decline(&p.source_id,p.source_expires,&action,now());
  let _=write_local(&state.path.with_file_name("qq-initiative-v1.json"),&i.director);
 }
}

fn finish_delivery(app:&AppHandle,state:&QqState,mut ack:DeliveryAck,last:&str) {
    let outcome=ack.batch.outcome(last);
    if ack.proactive {state.initiative.lock().unwrap().record(if outcome=="sent"{"sent"}else if outcome=="unknown"{"unknown"}else{"failed"},now());}
    if ack.proactive && ack.kind!="continuation" {
        let mut b=state.activities.lock().unwrap();b.settle(&ack.contact_scope,&ack.contact_source,&outcome,now());
        b.finish_daily(&ack.daily_scope,if ack.batch.confirmed>0{"sent"}else{&outcome},now());
        let _=write_local(&state.path.with_file_name("companion-activity-v1.json"),&*b);
    }
    let delivered=ack.batch.delivered();
    let input=ack.evidence.as_ref().map(|e|e.input.clone());
    let eligible_continuation=ack.evidence.as_ref().is_some_and(|e|!e.external && e.input.image_count==0);
    if ack.batch.confirmed>0 && (!ack.proactive || ack.kind=="continuation") {
        if let Some(e)=ack.evidence.as_mut(){if !e.reply.is_empty(){e.reply=delivered.clone();}}
        let queued=crate::memory::with_qq_memory_db(&app.state::<crate::memory::MemoryState>(),Some(&ack.lease),|conn,lease|ack.evidence.take().and_then(|e|state.core.lock().unwrap().record_evidence(conn,e,&lease,"sent")));
        if matches!(queued,Some(Some(Ok(ref result))) if result.accepted){crate::memory::trigger_worker(app);}
    }
    if outcome=="sent" {
        let mut i=state.initiative.lock().unwrap();
        if ack.proactive && ack.kind!="continuation" && i.sequence==ack.sequence {
            i.director.confirmed_contact(delivered.trim_end().ends_with(['?','？']));
            let _=write_local(&state.path.with_file_name("qq-initiative-v1.json"),&i.director);
        }
        if !ack.proactive && eligible_continuation && ack.rhythm=="open" && !delivered.trim_end().ends_with(['?','？']) {
            if let Some(input)=input.filter(|v|crate::proactive::safe_topic(&v.text)) {
                let cfg=state.config.lock().unwrap().clone();
                if cfg.proactive_channel!="desktop" && i.director.conversation_allowed(&cfg.proactive_mode,cfg.quiet_start,cfg.quiet_end,now(),false)
                    && i.sequence==ack.sequence && state.core.lock().unwrap().delivery.as_ref().is_some_and(|v|v.nonce==ack.nonce) {
                    let delay=if cfg.reply_mode=="voice"{60}else{20};
                    i.continuation=Some(crate::proactive::Continuation{due:now()+delay,expires:now()+delay+90,
                        activity:i.sequence,source:format!("[当前真实对话的同话题补充；最多再说一次；没有新内容则drop]\n主人：{}\n已回复：{}",input.text.chars().take(500).collect::<String>(),delivered.chars().take(500).collect::<String>()),
                        scope:crate::proactive::source_key(&input.card_id,&input.nickname,"scope",""),lease:ack.lease.clone(),revision:state.core.lock().unwrap().revision});
                    i.record("continuation-pending",now());
                }
            }
        }
    }
    let _=ack.done.send(json!({"outcome":outcome,"deliveredText":delivered}));
    state.set_status(if outcome=="sent"||outcome=="partial"{"connected"}else{"send-failed"});
}
fn batch_current(state:&QqState,ack:&DeliveryAck)->bool {
    if ack.proactive{
        let cfg=state.config.lock().unwrap().clone();
        let i=state.initiative.lock().unwrap();
        return i.sequence==ack.sequence && now()-ack.admitted_at<=180
            && cfg.proactive_channel!="desktop"
            && i.director.conversation_allowed(&cfg.proactive_mode,cfg.quiet_start,cfg.quiet_end,now(),i.blocked);
    }
    let core=state.core.lock().unwrap();
    now()-ack.admitted_at<=180 && core.delivery.as_ref().is_some_and(|e|e.nonce==ack.nonce)
        && core.memory_lease.as_deref()==Some(&ack.lease)
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
        initiative_activity(state,&event.text);
        let _ = app.emit("qq-owner-message", event);
    }
}
pub fn start(app: AppHandle) {
    let scheduler=app.clone();
    tauri::async_runtime::spawn(async move {
        let mut timer=tokio::time::interval(Duration::from_secs(1));
        loop {timer.tick().await;let state=scheduler.state::<QqState>();
            if state.shutting_down.load(Ordering::SeqCst){break;}
            let cfg=state.config.lock().unwrap().clone();offer_initiative(&scheduler,&state,&cfg);
        }
    });
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

                    if acknowledgement.as_ref().is_some_and(|a|a.next_at.is_some_and(|due|tokio::time::Instant::now()>=due)) {
                        let mut a=acknowledgement.take().unwrap();
                        let valid=batch_current(&state,&a) && crate::memory::with_qq_memory_lease(&app.state::<crate::memory::MemoryState>(),Some(&a.lease),|_|true).unwrap_or(false);
                        if !valid {finish_delivery(&app,&state,a,"cancelled");}
                        else {
                            let text=a.batch.next().unwrap_or_default().to_string();
                            a.batch.begin_next();
                            a.text=text.clone();a.echo=uuid::Uuid::new_v4().to_string();a.at=tokio::time::Instant::now();a.next_at=None;
                            let message=json!([{"type":"text","data":{"text":text}}]);
                            if !matches!(tokio::time::timeout(Duration::from_secs(5),socket.send(Message::Text(send_action(&cfg,message,&a.echo)))).await,Ok(Ok(()))) {finish_delivery(&app,&state,a,"unknown");break;}
                            acknowledgement=Some(a);
                        }
                    }
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
                    if acknowledgement.as_ref().is_some_and(|a|a.next_at.is_none() && a.at.elapsed()>=Duration::from_secs(if a.audio.is_some(){130}else{10})) {
                        if let Some(a)=acknowledgement.take(){finish_delivery(&app,&state,a,"unknown");}
                    }
                },
                incoming=async { if let Some(value)=early_message.take() { Some(Ok(Message::Text(value.to_string()))) } else {socket.next().await} }=>{
                    match incoming {
                        Some(Ok(Message::Ping(bytes)))=>{if !matches!(tokio::time::timeout(Duration::from_secs(5),socket.send(Message::Pong(bytes))).await,Ok(Ok(()))){break;}},
                        Some(Ok(Message::Text(raw)))=>{
                            let Ok(value)=serde_json::from_str::<Value>(&raw) else{continue;};
                            let outcome=acknowledgement.as_ref().filter(|a|a.next_at.is_none()).and_then(|a|ack_outcome(&value,&a.echo));
                            if let Some(outcome)=outcome {
                                if let Some(mut a)=acknowledgement.take(){
                                    // A negative record ACK establishes failure; unknown delivery never retries.
                                    if outcome=="failed" && a.audio.take().is_some() && state.core.lock().unwrap().delivery.as_ref().is_some_and(|e|e.nonce==a.nonce) {
                                        a.echo=uuid::Uuid::new_v4().to_string();a.at=tokio::time::Instant::now();
                                        let message=with_extras(json!([{"type":"text","data":{"text":a.text}}]),&a.extras);
                                        if !matches!(tokio::time::timeout(Duration::from_secs(5),socket.send(Message::Text(send_action(&cfg,message,&a.echo)))).await,Ok(Ok(()))){finish_delivery(&app,&state,a,"unknown");break;}
                                        *state.media_status.lock().unwrap()="voice-fallback".into();acknowledgement=Some(a);continue;
                                    }
                                    // Audio belongs only to the first part. A later card failure
                                    // must never retry/resend the already confirmed voice.
                                    if outcome=="sent"{a.audio.take();}
                                    a.batch.acknowledge(outcome);
                                    if outcome=="sent" && a.batch.next().is_some() && batch_current(&state,&a) {
                                        a.next_at=Some(tokio::time::Instant::now()+Duration::from_millis(1200));
                                        acknowledgement=Some(a);continue;
                                    }
                                    finish_delivery(&app,&state,a,outcome);
                                }continue;
                            }
                            if transcription.as_ref().is_some_and(|t|t.matches(&value)) {
                                let result=transcription.as_mut().unwrap().response(&value,&mut state.core.lock().unwrap(),now(),tokio::time::Instant::now());
                                match result {
                                    TranscriptionResult::Ready(ready)=>{
                                        transcription.take();
                                        initiative_activity(&state,&ready.text);
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
                                    initiative_activity(&state,"");
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
                    let sequence=state.initiative.lock().unwrap().sequence;
                    let goal_scope=state.initiative.lock().unwrap().permit.as_ref().filter(|p|p.nonce==command.nonce).map(|p|p.daily_scope.clone()).unwrap_or_default();
                    let contact_source=state.initiative.lock().unwrap().permit.as_ref().filter(|p|p.nonce==command.nonce).map(|p|p.source_id.clone()).unwrap_or_default();
                    let current=cfg.follow_settings(&app.state::<crate::AppState>().settings.lock().unwrap());
                    let contact_scope=crate::proactive::source_key(&current.card_id,&current.nickname,"scope","");
                    let kind=if command.proactive{state.initiative.lock().unwrap().permit.as_ref().filter(|p|p.nonce==command.nonce).map(|p|p.kind).unwrap_or("invalid")}else{"reply"};
                    let lease=if command.proactive {state.initiative.lock().unwrap().permit.as_ref().filter(|p|p.nonce==command.nonce).map(|p|p.lease.clone())}else{state.core.lock().unwrap().memory_lease.clone()};
                    let message=if command.proactive {
                        lease.as_deref().and_then(|lease|crate::memory::with_qq_memory_lease(&app.state::<crate::memory::MemoryState>(),Some(lease),|_|take_initiative(&app,&state,&cfg,&command.nonce,&command.text,"qq")))
                    } else {lease.as_deref().and_then(|lease|crate::memory::with_qq_memory_lease(&app.state::<crate::memory::MemoryState>(),Some(lease),|_|state.core.lock().unwrap().take_draft(&command.nonce,&command.text,now())))};
                    let Some(Ok(_text_message))=message else{let _=command.done.send("cancelled".into());continue;};
                    let batch=if let Some(details)=command.details.as_deref(){crate::qq_delivery::TextDelivery::with_details(&command.text,details)}else{crate::qq_delivery::TextDelivery::new(&command.text,cfg.reply_mode=="text" && command.extras.is_empty())};
                    let first=batch.next().unwrap_or_default().to_string();
                    let text_message=json!([{"type":"text","data":{"text":first}}]);
                    let (message,expression_only)=reply_segments(cfg.reply_mode=="voice",text_message,command.audio.as_ref().map(|a|a.message()),&command.extras);
                    let echo=uuid::Uuid::new_v4().to_string();
                    let mut evidence=if command.proactive && kind!="continuation"{None}else{state.core.lock().unwrap().delivery_evidence()};
                    if kind=="continuation"{if let Some(e)=evidence.as_mut(){e.input.nonce=command.nonce.clone();e.reply=command.text.clone();}}
                    if let Some(evidence)=evidence.as_mut(){evidence.external=command.external;}
                    if expression_only {if let Some(evidence)=evidence.as_mut(){evidence.reply.clear();}}
                    let ack=DeliveryAck{daily_scope:goal_scope,evidence,echo,done:command.done,at:tokio::time::Instant::now(),nonce:command.nonce,text:first,lease:lease.unwrap_or_default(),audio:command.audio,extras:command.extras,batch,next_at:None,admitted_at:now(),proactive:command.proactive,kind:kind.into(),sequence,contact_source,contact_scope,rhythm:if expression_only{"closed".into()}else{command.rhythm}};
                    // Once admitted to the socket, cancellation cannot establish non-delivery.
                    // Settle even an initial send error through the same uncertain-delivery path.
                    if !matches!(tokio::time::timeout(Duration::from_secs(5),socket.send(Message::Text(send_action(&cfg,message,&ack.echo)))).await,Ok(Ok(()))){finish_delivery(&app,&state,ack,"unknown");break;}
                    acknowledgement=Some(ack);
                }
            }
        }
        if let Some(a) = acknowledgement.take() {
            finish_delivery(&app,&state,a,"unknown");
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
    fn rapid_unclaimed_messages_are_merged_with_original_memory_dates() {
        let mut core=Core::default();let cfg=config();
        let mut a=event();a["message"]=json!("今天好累");
        let first=core.accept(&cfg,&a,1001).unwrap();
        let mut b=event();b["message_id"]=json!(43);b["time"]=json!(1001);b["message"]=json!("开了四个会");
        let last=core.accept(&cfg,&b,1002).expect("rapid input must not be discarded");
        assert_eq!(last.text,"今天好累\n开了四个会");
        assert!(!core.claim(&first.nonce,1002));assert!(core.claim(&last.nonce,1002));
        core.memory_lease=Some("lease".into());core.take_draft(&last.nonce,"辛苦啦",1002).unwrap();
        let mut db=crate::memory::qq_test_connection();
        assert!(core.record_exchange(&mut db,&last.nonce,"辛苦啦","lease","sent").unwrap().unwrap().accepted);
        let raw:String=db.query_row("SELECT payload_json FROM memory_jobs",[],|r|r.get(0)).unwrap();
        let messages:Vec<Value>=serde_json::from_str(&raw).unwrap();
        assert_eq!(messages.len(),3);assert_eq!(messages[0]["messageAt"],1000);assert_eq!(messages[1]["messageAt"],1001);
        assert_eq!(messages[0]["content"],"今天好累");assert_eq!(messages[1]["content"],"开了四个会");
    }
    #[test]
    fn image_conversation_persists_only_user_caption_not_visual_claims() {
        let mut core=Core::default();let mut value=event();
        value["message"]=json!([{"type":"text","data":{"text":"我喜欢乌龙茶"}},{"type":"image","data":{"file":"opaque"}}]);
        let input=core.accept(&config(),&value,1001).unwrap();
        assert!(core.claim(&input.nonce,1001));core.memory_lease=Some("test-lease".into());
        core.take_draft(&input.nonce,"看起来你住在某城市",1001).unwrap();
        let mut db=crate::memory::qq_test_connection();
        assert!(core.record_exchange(&mut db,&input.nonce,"看起来你住在某城市","test-lease","sent").unwrap().unwrap().accepted);
        let raw:String=db.query_row("SELECT payload_json FROM memory_jobs",[],|r|r.get(0)).unwrap();
        let messages:Vec<Value>=serde_json::from_str(&raw).unwrap();
        assert_eq!(messages[0]["content"],"我喜欢乌龙茶");
        assert!(!raw.contains("某城市"));assert!(!raw.contains("opaque"));assert!(!raw.contains("[图片]"));
    }

    #[tokio::test]
    async fn authenticated_image_lookup_ignores_unsolicited_echo_and_uses_original_message_token() {
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut cfg=config();cfg.ws_url=format!("ws://{}",listener.local_addr().unwrap());
        let peer=tokio::spawn(async move {
            let (stream,_)=listener.accept().await.unwrap();
            let mut ws=tokio_tungstenite::accept_async(stream).await.unwrap();
            for action in ["get_login_info","get_msg","get_image"] {
                let req:Value=serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
                assert_eq!(req["action"],action);
                let data=match action {
                    "get_login_info"=>json!({"user_id":87654321}),
                    "get_msg"=>{assert_eq!(req["params"]["message_id"],"42");json!({"message_id":42,"message_type":"private","sender":{"user_id":12345678},"message":[{"type":"image","data":{"file":"verified-token"}}]})},
                    _=>{assert_eq!(req["params"]["file"],"verified-token");json!({"file":"fixture.png"})},
                };
                ws.send(Message::Text(json!({"echo":"stale","status":"ok","retcode":0,"data":{"file":"must-ignore"}}).to_string())).await.unwrap();
                ws.send(Message::Text(json!({"echo":req["echo"],"status":"ok","retcode":0,"data":data}).to_string())).await.unwrap();
            }
        });
        let (mut ws,_)=connect_verified(&cfg).await.unwrap();
        let mut value=event();value["message"]=json!([{"type":"image","data":{"file":"untrusted-event-token"}}]);
        let input=Core::default().accept(&cfg,&value,1001).unwrap();
        let response=onebot_read(&mut ws,"get_msg",json!({"message_id":input.message_id})).await.unwrap();
        let files=owner_image_files(&cfg,&input,&response).unwrap();
        let image=onebot_read(&mut ws,"get_image",json!({"file":files[0]})).await.unwrap();
        assert_eq!(image["data"]["file"],"fixture.png");peer.await.unwrap();
    }

    #[test]
    fn voice_reply_sends_an_expression_alone_and_text_mode_may_attach_it() {
        let text=json!([{"type":"text","data":{"text":"未实际说出的模型台词"}}]);
        let audio=json!([{"type":"record","data":{"file":"base64://fixture"}}]);
        let extras=vec![json!({"type":"face","data":{"id":"14"}})];
        let (message,expression_only)=reply_segments(true,text.clone(),Some(audio.clone()),&extras);
        assert_eq!(message,json!(extras),"voice mode must not mix record with an expression");
        assert!(expression_only,"unsent model dialogue must be excluded from Memory");
        assert_eq!(reply_segments(true,text.clone(),None,&extras),(json!(extras),true));
        assert_eq!(reply_segments(true,text.clone(),Some(audio.clone()),&[]),(audio,false));
        let (message,expression_only)=reply_segments(false,text,None,&extras);
        assert!(!expression_only);assert_eq!(message[0]["type"],"text");assert_eq!(message[1]["type"],"face");
    }

    #[test]
    fn builtin_qq_faces_have_names_instead_of_unknown_visual_claims() {
        for (id,name) in [(0,"惊讶"),(2,"色"),(1,"撇嘴"),(8,"睡"),(76,"赞"),(178,"斜眼笑")] {
            let mut value=event();value["message"]=json!([{"type":"face","data":{"id":id.to_string()}}]);
            let incoming=Core::default().accept(&config(),&value,1001).unwrap();
            assert!(incoming.text.contains(&format!("[QQ表情：{name} #{id}]")),"face {id} should reach the model with its actual name");
            assert_eq!(incoming.image_count,0,"built-in faces should not require visual downloads");
            assert!(incoming.memory_text.is_empty(),"face labels must not become user factual evidence");
        }
    }

    #[test]
    fn sticker_selection_is_restricted_to_the_shipped_manifest() {
        assert!(sticker_allowed("maimeng_01.gif"));
        for file in ["../../settings.json","file:///etc/passwd","https://example.com/x.gif","unknown.gif","stickers/maimeng_01.gif"] {
            assert!(!sticker_allowed(file));
        }
    }

    #[test]
    fn image_lookup_requires_original_owner_and_opaque_file_ids() {
        let cfg=config();let mut value=event();
        value["message"]=json!([{"type":"image","data":{"file":"event-supplied-must-not-use"}}]);
        let input=Core::default().accept(&cfg,&value,1001).unwrap();
        let response=json!({"status":"ok","retcode":0,"data":{"message_id":42,"message_type":"private","time":1000,"sender":{"user_id":cfg.owner_id},"message":[{"type":"image","data":{"file":"trusted-message-token","url":"http://127.0.0.1/secret"}}]}});
        assert_eq!(owner_image_files(&cfg,&input,&response).unwrap(),vec!["trusted-message-token"]);
        let mut wrong=response.clone();wrong["data"]["sender"]["user_id"]=json!("99999999");assert!(owner_image_files(&cfg,&input,&wrong).is_err());
        wrong=response.clone();wrong["data"]["message_id"]=json!(43);assert!(owner_image_files(&cfg,&input,&wrong).is_err());
        wrong=response.clone();wrong["data"]["message"][0]["data"]["file"]=json!("file:///etc/passwd");assert!(owner_image_files(&cfg,&input,&wrong).is_err());
    }

    #[test]
    fn owner_mixed_text_face_and_images_reaches_the_conversation() {
        let mut value=event();
        value["message"]=json!([{"type":"text","data":{"text":"看看这个"}},{"type":"face","data":{"id":"14"}},{"type":"image","data":{"file":"opaque-napcat-file"}}]);
        let mut core=Core::default();
        let incoming=core.accept(&config(),&value,1001).expect("mixed message must not be silently discarded");
        assert!(incoming.text.contains("看看这个"));
        assert!(incoming.text.contains("微笑"));
        assert_eq!(serde_json::to_value(incoming).unwrap()["imageCount"],1);
        value["user_id"]=json!("99999999");
        assert!(Core::default().accept(&config(),&value,1001).is_none());
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
        assert_eq!(ready.sources[0].id, pending.sources[0].id, "transcription must retain the scoped original QQ source identity");
        assert_eq!(ready.sources[0].content, "我喜欢乌龙茶");
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
    #[test]
    fn semantic_search_delivery_never_enters_memory_without_literal_search_words() {
        for text in ["明天上海天气怎么样", "最近有什么好看的电影", "这家博物馆周末还开放吗"] {
            let (mut core,input,mut conn)=claimed(text);
            core.take_draft(&input.nonce,"来源资料的回答",1002).unwrap();
            let mut evidence=core.delivery_evidence().unwrap();
            evidence.external=true;
            assert!(core.record_evidence(&mut conn,evidence,"test-lease","sent").is_none(),
                "semantic searches must be excluded even when source retrieval fails");
        }
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
            ("message", json!([{ "type":"image","data":null}])),
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
        assert!(owner_text(&config(), &mixed, 1001).is_some());
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
    fn rapid_input_and_deadline_preserve_bounded_dedupe() {
        let mut core = Core::default();
        let cfg = config();
        let first = core.accept(&cfg, &event(), 1001).unwrap();
        let mut second = event();
        second["message_id"] = json!(43);
        assert!(core.accept(&cfg, &second, 1001).is_some());
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
