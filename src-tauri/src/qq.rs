//! Owner-only OneBot v11 transport. Protocol content never enters logs.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
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
}
impl Config {
    fn validate(&self) -> Result<(), String> {
        if self.ws_url.len() > 200
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Incoming {
    nonce: String,
    text: String,
    card_id: String,
    nickname: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct SeenEntry {
    key: String,
    at: i64,
}
#[derive(Default)]
struct Core {
    seen: std::collections::VecDeque<SeenEntry>,
    pending: Option<(String, i64)>,
    last_admitted: Option<i64>,
    delivery: Option<Incoming>,
    claimed: bool,
    memory_lease: Option<String>,
}
impl Core {
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
        self.delivery = None;
        true
    }
    fn cancel(&mut self) {
        self.pending = None;
        self.delivery = None;
    }
    fn take_draft(&mut self, nonce: &str, text: &str, now: i64) -> Result<Value, String> {
        let Some((current, at)) = &self.pending else {
            return Err("stale".into());
        };
        if !self.claimed
            || nonce != current
            || now - *at > 45
            || text.trim().is_empty()
            || text.chars().count() > 2000
        {
            return Err("stale-or-invalid".into());
        }
        self.pending = None;
        Ok(json!([{ "type":"text","data":{"text":text.trim()}}]))
    }
}

use futures_util::{SinkExt, StreamExt};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
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
    core: Mutex<Core>,
    status: Mutex<String>,
    path: PathBuf,
    outbound: Mutex<Option<mpsc::Sender<SendCommand>>>,
    epoch: AtomicU64,
    notify: Notify,
}
struct SendCommand {
    nonce: String,
    text: String,
    done: oneshot::Sender<String>,
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
    pub fn open(app: &AppHandle) -> Result<Self, String> {
        let root = app
            .path()
            .app_config_dir()
            .map_err(|_| "QQ本地配置目录不可用")?;
        let path = root.join("qq-onebot-v1.json");
        let mut config: Config = read_local(&path, 16384).unwrap_or_default();
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
            core: Mutex::new(core),
            status: Mutex::new("disabled".into()),
            path,
            outbound: Mutex::new(None),
            epoch: AtomicU64::new(0),
            notify: Notify::new(),
        })
    }
    pub fn cancel(&self) {
        self.core.lock().unwrap().cancel();
    }
    fn set_status(&self, value: &str) {
        *self.status.lock().unwrap() = value.into();
    }
}
#[tauri::command]
pub fn qq_get_config(state: State<'_, QqState>) -> Value {
    let cfg = state.config.lock().unwrap();
    json!({"enabled":cfg.enabled,"wsUrl":cfg.ws_url,"ownerId":cfg.owner_id,"botId":cfg.bot_id,
        "cardId":cfg.card_id,"nickname":cfg.nickname,"hasToken":!cfg.token.is_empty(),"status":*state.status.lock().unwrap()})
}
#[tauri::command]
pub fn qq_save_config(
    app: AppHandle,
    state: State<'_, QqState>,
    mut request: Config,
    clear_token: bool,
) -> Result<(), String> {
    // Serialize config mutation with cancellation; token is never returned to the WebView.
    let mut cfg = state.config.lock().unwrap();
    if clear_token {
        request.token.clear();
    }
    if request.token.is_empty() && !clear_token {
        request.token = cfg.token.clone();
    }
    request.validate()?;
    write_local(&state.path, &request)?;
    *cfg = request;
    state.epoch.fetch_add(1, Ordering::SeqCst);
    state.cancel();
    state.outbound.lock().unwrap().take();
    state.notify.notify_one();
    let _ = app.emit("qq-invalidated", ());
    Ok(())
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
pub fn qq_cancel_pending(app: AppHandle, state: State<'_, QqState>) {
    state.cancel();
    let _ = app.emit("qq-invalidated", ());
}
#[tauri::command]
pub async fn qq_send_draft(
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
    let (done, receipt) = oneshot::channel();
    sender
        .try_send(SendCommand { nonce, text, done })
        .map_err(|_| "busy")?;
    match tokio::time::timeout(Duration::from_secs(12), receipt).await {
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
                        if owner_text(cfg, &value, now()).is_some() {
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
    let (event, changed) = {
        let mut core = state.core.lock().unwrap();
        let before = core.seen.len();
        let pending = core.pending.clone();
        let old = core.seen.back().cloned();
        let event = core.accept(cfg, value, now());
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
    tauri::async_runtime::spawn(async move {
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
        if let Some(event) = early_message {
            admit_event(&app, &state, &cfg, &event);
        }
        let mut acknowledgement: Option<(String, oneshot::Sender<String>, tokio::time::Instant)> =
            None;
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {biased;
                _=state.notify.notified()=>break,
                _=tick.tick()=>{
                    if acknowledgement.as_ref().is_some_and(|(_,_,at)|at.elapsed()>=Duration::from_secs(10)) {
                        if let Some((_,done,_))=acknowledgement.take(){let _=done.send("unknown".into());state.set_status("send-unknown");}
                    }
                },
                incoming=socket.next()=>{
                    match incoming {
                        Some(Ok(Message::Ping(bytes)))=>{if !matches!(tokio::time::timeout(Duration::from_secs(5),socket.send(Message::Pong(bytes))).await,Ok(Ok(()))){break;}},
                        Some(Ok(Message::Text(raw)))=>{
                            let Ok(value)=serde_json::from_str::<Value>(&raw) else{continue;};
                            let outcome=acknowledgement.as_ref().and_then(|(echo,_,_)|ack_outcome(&value,echo));
                            if let Some(outcome)=outcome {if let Some((_,done,_))=acknowledgement.take(){let _=done.send(outcome.into());state.set_status(if outcome=="sent"{"connected"}else{"send-failed"});}continue;}
                            admit_event(&app,&state,&cfg,&value);
                        },
                        _=>break,
                    }
                },
                command=commands.recv()=>{
                    let Some(command)=command else{break;};
                    if acknowledgement.is_some() || state.epoch.load(Ordering::SeqCst)!=epoch {let _=command.done.send("cancelled".into());continue;}
                    let lease=state.core.lock().unwrap().memory_lease.clone();
                    let message=lease.as_deref().and_then(|lease|crate::memory::with_qq_memory_lease(&app.state::<crate::memory::MemoryState>(),Some(lease),|_|state.core.lock().unwrap().take_draft(&command.nonce,&command.text,now())));
                    let Some(Ok(message))=message else{let _=command.done.send("cancelled".into());continue;};
                    let echo=uuid::Uuid::new_v4().to_string();
                    // Once admitted to the socket, cancellation cannot establish non-delivery.
                    if !matches!(tokio::time::timeout(Duration::from_secs(5),socket.send(Message::Text(send_action(&cfg,message,&echo)))).await,Ok(Ok(()))){let _=command.done.send("unknown".into());break;}
                    acknowledgement=Some((echo,command.done,tokio::time::Instant::now()));
                }
            }
        }
        if let Some((_, done, _)) = acknowledgement.take() {
            let _ = done.send("unknown".into());
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
