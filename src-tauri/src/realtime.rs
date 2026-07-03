//! 本地 WebSocket 桥接：前端聊天窗口 ↔ 火山「端到端实时语音大模型」(RealtimeDialog)。
//!
//! 为什么要这层 Rust 桥接（而不是前端直连火山 wss）：
//!   1. 浏览器 WebSocket 无法设置自定义鉴权头（X-Api-*），而火山实时语音要求带头鉴权；
//!   2. 二进制帧封装 / gzip / **人设语料解密注入** / 密钥都留在 Rust，与本工程
//!      「密钥与语料不出本机」的现有哲学一致（参见 persona_assets.rs、api.rs）。
//!
//! 数据流：
//!   [前端 realtime.js]                         [本模块]                       [火山 wss]
//!     mic PCM16 16k (binary)  ──▶  ws://127.0.0.1  ──▶  帧封装+鉴权+system_role/speaker  ──▶
//!     播放 PCM 24k (binary)   ◀──                  ◀──  解析 AUDIO_ONLY_SERVER            ◀──
//!     ASR/回复/状态 (text json) ◀──                ◀──  解析 FULL_SERVER_RESPONSE 事件     ◀──
//!
//! 前端↔本模块的「本地私有协议」（刻意做薄）：
//!   前端 → Rust：binary = 原始上行 PCM16 mono 16k；text = 控制 JSON，如 {"type":"hangup"}。
//!   Rust → 前端：binary = 下行播放 PCM 24k；text = 事件 JSON（见 to_frontend_* ）。

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tauri::AppHandle;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

/// ============================================================================
/// 火山「端到端实时语音大模型」协议常量
/// ----------------------------------------------------------------------------
/// ⚠️ 重要：以下常量取自火山端到端实时语音大模型 (RealtimeDialog) 的公开协议约定，
///    但**务必对照你火山账号「语音技术 → 实时对话」控制台的官方文档核对**
///    （endpoint / Resource-Id / App-Key / 事件码 / speaker 是否可用）。
///    协议若有出入，只需改本模块，前端与 lib.rs 无需变动。
/// ============================================================================
mod protocol {
    #![allow(dead_code)] // 部分事件码/常量保留作协议文档，暂未在解析路径用到。
    /// wss 接入点。官方文档路径：/api/v3/realtime/dialogue。
    pub const ENDPOINT: &str = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue";
    /// 资源标识：端到端实时语音大模型固定为 volc.speech.dialog。
    pub const RESOURCE_ID: &str = "volc.speech.dialog";
    /// 固定 App-Key（官方文档 2.1 明确为固定值 PlgvMymc7f3tQnJ6）。
    pub const APP_KEY: &str = "PlgvMymc7f3tQnJ6";
    /// StartSession 的 dialog.extra.model：端到端模型版本（必传）。
    /// "1.2.1.1"=O2.0，"2.2.0.0"=SC2.0；S_ 复刻音色须走 2.0 链路。按 O2.0 默认。
    pub const MODEL_VERSION: &str = "1.2.1.1";

    // ---- 二进制帧头（4 字节）----
    // byte0: (version<<4)|header_size  → version=1, header_size=1(即 4 字节) = 0x11
    // byte1: (message_type<<4)|flags
    // byte2: (serialization<<4)|compression
    // byte3: 保留 0x00
    pub const HEADER_BYTE0: u8 = 0x11;

    // message_type（高 4 位）
    pub const MT_FULL_CLIENT: u8 = 0b0001; // 客户端完整请求（JSON，如 StartSession）
    pub const MT_AUDIO_CLIENT: u8 = 0b0010; // 客户端纯音频（上行 PCM）
    pub const MT_FULL_SERVER: u8 = 0b1001; // 服务端完整响应（事件 JSON）
    pub const MT_AUDIO_SERVER: u8 = 0b1011; // 服务端纯音频（下行 PCM）
    pub const MT_ERROR: u8 = 0b1111; // 服务端错误帧

    // flags（低 4 位）：带 event 号
    pub const FLAG_WITH_EVENT: u8 = 0b0100;

    // serialization（高 4 位）/ compression（低 4 位）
    pub const SER_JSON: u8 = 0b0001;
    pub const SER_RAW: u8 = 0b0000;
    pub const COMP_GZIP: u8 = 0b0001;
    pub const COMP_NONE: u8 = 0b0000;

    // ---- 事件码（int32 大端）----
    // 客户端 → 服务端
    pub const EV_START_CONNECTION: i32 = 1;
    pub const EV_FINISH_CONNECTION: i32 = 2;
    pub const EV_START_SESSION: i32 = 100;
    pub const EV_FINISH_SESSION: i32 = 102;
    pub const EV_TASK_REQUEST: i32 = 200; // 上行音频

    // 服务端 → 客户端
    pub const EV_CONNECTION_STARTED: i32 = 50;
    pub const EV_CONNECTION_FAILED: i32 = 51;
    pub const EV_SESSION_STARTED: i32 = 150;
    pub const EV_SESSION_FINISHED: i32 = 152;
    pub const EV_SESSION_FAILED: i32 = 153;
    pub const EV_TTS_SENTENCE_START: i32 = 350;
    pub const EV_TTS_RESPONSE: i32 = 352; // 下行音频（也可能走 AUDIO_ONLY_SERVER 帧）
    pub const EV_TTS_ENDED: i32 = 359;
    pub const EV_ASR_INFO: i32 = 450;
    pub const EV_ASR_RESPONSE: i32 = 451; // 用户语音的识别文本
    pub const EV_ASR_ENDED: i32 = 459;
    pub const EV_CHAT_RESPONSE: i32 = 550; // 助手回复文本
    pub const EV_CHAT_ENDED: i32 = 559;

    // 上行音频格式（前端重采样后送来的）
    pub const INPUT_SAMPLE_RATE: i32 = 16000;
    // 下行音频格式（送火山的 tts.audio_config，前端据此播放）
    pub const OUTPUT_SAMPLE_RATE: i32 = 24000;
}

/// 从 lib.rs 注入的一次会话所需**密钥/音色**快照（人设 system_role 由前端 start 消息带入，
/// 以复用前端既有的 buildSystemPrompt 逻辑，避免在 Rust 里重复拼装并与之漂移）。
pub struct RealtimeConfig {
    pub app_id: String,
    pub access_key: String,
    /// 复刻音色 voice_id（S_ 开头）。
    pub speaker: String,
}

/// 供 lib.rs 实现：读取设置，产出本次实时会话的密钥/音色。
/// 返回 None 表示未配置（缺 App ID / Access Key / 音色），前端会收到错误提示。
pub type ConfigProvider = Arc<dyn Fn(&AppHandle) -> Option<RealtimeConfig> + Send + Sync>;

/// 启动本地实时语音 WS 桥接服务，返回监听端口（127.0.0.1 随机口）。
/// 在独立线程里跑一个多线程 tokio 运行时（Tauri 主流程本身非 async）。
pub fn start(app: AppHandle, provider: ConfigProvider) -> std::io::Result<u16> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;

    // 先同步绑定拿到端口，再把 listener 交给运行时 accept 循环。
    let (tx, rx) = std::sync::mpsc::channel::<std::io::Result<u16>>();
    std::thread::spawn(move || {
        rt.block_on(async move {
            let listener = match TcpListener::bind("127.0.0.1:0").await {
                Ok(l) => l,
                Err(e) => {
                    let _ = tx.send(Err(e));
                    return;
                }
            };
            let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
            let _ = tx.send(Ok(port));

            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        let app = app.clone();
                        let provider = provider.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_frontend(stream, app, provider).await {
                                eprintln!("[realtime] 会话结束/出错: {e}");
                            }
                        });
                    }
                    Err(e) => {
                        eprintln!("[realtime] accept 失败: {e}");
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    }
                }
            }
        });
    });

    rx.recv()
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "realtime 端口初始化失败"))?
}

/// 处理一路前端连接：升级为 WS → 连火山 → 双向泵送。
async fn handle_frontend(
    stream: tokio::net::TcpStream,
    app: AppHandle,
    provider: ConfigProvider,
) -> Result<(), String> {
    let _ = stream.set_nodelay(true);
    let front_ws = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|e| format!("前端 WS 握手失败: {e}"))?;
    let (mut front_tx, mut front_rx) = front_ws.split();

    // 读取密钥/音色（缺失则告知前端并结束）。
    let cfg = match provider(&app) {
        Some(c) if !c.app_id.is_empty() && !c.access_key.is_empty() && c.speaker.starts_with("S_") => c,
        _ => {
            let _ = front_tx
                .send(Message::Text(
                    to_frontend_error("未配置实时语音（需 App ID、Access Key 与 S_ 开头的复刻音色）")
                        .to_string(),
                ))
                .await;
            return Ok(());
        }
    };

    // 等待前端的 start 控制消息，取出人设 system_role 与 bot_name（复用前端 buildSystemPrompt）。
    // 前端连上后必须先发一条：{"type":"start","systemRole":"...","botName":"元元"}。
    let (system_role, bot_name) = loop {
        match front_rx.next().await {
            Some(Ok(Message::Text(t))) => {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap_or(serde_json::Value::Null);
                if v.get("type").and_then(|x| x.as_str()) == Some("start") {
                    let sr = v.get("systemRole").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let bn = v
                        .get("botName")
                        .and_then(|x| x.as_str())
                        .filter(|s| !s.is_empty())
                        .unwrap_or("元元")
                        .to_string();
                    break (sr, bn);
                }
            }
            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return Ok(()),
            _ => {}
        }
    };

    // 连接火山 wss（带自定义鉴权头）。
    let volc_ws = match connect_volc(&cfg).await {
        Ok(ws) => ws,
        Err(e) => {
            let _ = front_tx
                .send(Message::Text(to_frontend_error(&format!("连接火山失败：{e}")).to_string()))
                .await;
            return Ok(());
        }
    };
    let (mut volc_tx, mut volc_rx) = volc_ws.split();

    let session_id = uuid::Uuid::new_v4().to_string();

    // StartConnection → StartSession（注入人设 system_role 与复刻音色 speaker）。
    volc_tx
        .send(Message::Binary(build_start_connection()))
        .await
        .map_err(|e| format!("发送 StartConnection 失败: {e}"))?;
    volc_tx
        .send(Message::Binary(build_start_session(&session_id, &cfg, &system_role, &bot_name)))
        .await
        .map_err(|e| format!("发送 StartSession 失败: {e}"))?;

    // 用 mpsc 把「发往火山」的帧汇聚到单一写端，避免两个任务同时借用 volc_tx。
    let (to_volc_tx, mut to_volc_rx) = mpsc::unbounded_channel::<Message>();

    // 任务 A：前端 → 火山。
    let a_session = session_id.clone();
    let to_volc_a = to_volc_tx.clone();
    let front_to_volc = async move {
        while let Some(msg) = front_rx.next().await {
            let msg = match msg {
                Ok(m) => m,
                Err(_) => break,
            };
            match msg {
                Message::Binary(pcm) => {
                    // 上行音频帧（TaskRequest）。
                    if to_volc_a.send(Message::Binary(build_audio_request(&a_session, &pcm))).is_err() {
                        break;
                    }
                }
                Message::Text(t) => {
                    // 控制指令：目前仅 hangup（结束会话）。
                    if t.contains("hangup") {
                        let _ = to_volc_a.send(Message::Binary(build_finish_session(&a_session)));
                        break;
                    }
                }
                Message::Close(_) => {
                    let _ = to_volc_a.send(Message::Binary(build_finish_session(&a_session)));
                    break;
                }
                _ => {}
            }
        }
    };

    // 任务 B：火山 → 前端（解析二进制事件）。
    let volc_to_front = async move {
        while let Some(msg) = volc_rx.next().await {
            let data = match msg {
                Ok(Message::Binary(b)) => b,
                Ok(Message::Close(_)) | Err(_) => break,
                _ => continue,
            };
            match parse_server_frame(&data) {
                Some(ServerFrame::Audio(pcm)) => {
                    if front_tx.send(Message::Binary(pcm)).await.is_err() {
                        break;
                    }
                }
                Some(ServerFrame::Event { event, payload }) => {
                    if let Some(text) = server_event_to_frontend(event, &payload) {
                        if front_tx.send(Message::Text(text)).await.is_err() {
                            break;
                        }
                    }
                    if event == protocol::EV_SESSION_FINISHED
                        || event == protocol::EV_SESSION_FAILED
                        || event == protocol::EV_CONNECTION_FAILED
                    {
                        let _ = front_tx.send(Message::Text(to_frontend_session("ended").to_string())).await;
                        break;
                    }
                }
                None => {}
            }
        }
        let _ = front_tx.send(Message::Close(None)).await;
    };

    // 写端泵：把汇聚的帧顺序写给火山。
    let pump_to_volc = async move {
        while let Some(m) = to_volc_rx.recv().await {
            if volc_tx.send(m).await.is_err() {
                break;
            }
        }
        let _ = volc_tx.close().await;
    };

    // 任一方向结束即收尾（select 后其余任务随连接关闭自然退出）。
    tokio::select! {
        _ = front_to_volc => {}
        _ = volc_to_front => {}
        _ = pump_to_volc => {}
    }
    Ok(())
}

/// 连接火山 wss，带鉴权头。
async fn connect_volc(
    cfg: &RealtimeConfig,
) -> Result<
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    String,
> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut req = protocol::ENDPOINT
        .into_client_request()
        .map_err(|e| e.to_string())?;
    let h = req.headers_mut();
    let put = |h: &mut tokio_tungstenite::tungstenite::http::HeaderMap, k: &'static str, v: &str| {
        if let Ok(val) = v.parse() {
            h.insert(k, val);
        }
    };
    put(h, "X-Api-App-ID", &cfg.app_id);
    put(h, "X-Api-Access-Key", &cfg.access_key);
    put(h, "X-Api-Resource-Id", protocol::RESOURCE_ID);
    put(h, "X-Api-App-Key", protocol::APP_KEY);
    put(h, "X-Api-Connect-Id", &uuid::Uuid::new_v4().to_string());

    let (ws, _resp) = tokio_tungstenite::connect_async(req)
        .await
        .map_err(|e| e.to_string())?;
    Ok(ws)
}

// ============================ 帧封装（客户端 → 服务端）============================

/// 组装一个「完整客户端请求」二进制帧：header(4) + event(4) + [session_id] + payload(4+n)。
/// with_session=false 用于 StartConnection（连接级，无 session_id）。
fn build_full_client(event: i32, session_id: Option<&str>, json: &serde_json::Value) -> Vec<u8> {
    // 官方字节示例客户端帧为 JSON + 无压缩（byte2=0x10），且文档标注无压缩【推荐】。
    let payload = serde_json::to_vec(json).unwrap_or_default();
    let mut buf = Vec::with_capacity(16 + payload.len());
    buf.push(protocol::HEADER_BYTE0);
    buf.push((protocol::MT_FULL_CLIENT << 4) | protocol::FLAG_WITH_EVENT);
    buf.push((protocol::SER_JSON << 4) | protocol::COMP_NONE);
    buf.push(0x00);
    buf.extend_from_slice(&event.to_be_bytes());
    if let Some(sid) = session_id {
        let sb = sid.as_bytes();
        buf.extend_from_slice(&(sb.len() as u32).to_be_bytes());
        buf.extend_from_slice(sb);
    }
    buf.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    buf.extend_from_slice(&payload);
    buf
}

fn build_start_connection() -> Vec<u8> {
    build_full_client(protocol::EV_START_CONNECTION, None, &serde_json::json!({}))
}

fn build_start_session(
    session_id: &str,
    cfg: &RealtimeConfig,
    system_role: &str,
    bot_name: &str,
) -> Vec<u8> {
    // 热词：bot_name 本身 + 常见简称「元元」，降低被识别成「圆圆」等同音字的概率。
    // enable_asr_twopass 开启后 context.hotwords / correct_words 才生效。
    let mut hotwords = vec![serde_json::json!({ "word": "元元" })];
    let bn = bot_name.trim();
    if !bn.is_empty() && bn != "元元" {
        hotwords.push(serde_json::json!({ "word": bn }));
    }
    let payload = serde_json::json!({
        "tts": {
            "audio_config": {
                "channel": 1,
                // 前端 _enqueuePcm 按 Int16Array(16bit s16le) 解码，故必须请求 pcm_s16le；
                // "pcm" 是 24k **32bit float**，前端会解成噪声。
                "format": "pcm_s16le",
                "sample_rate": protocol::OUTPUT_SAMPLE_RATE,
            },
            "speaker": cfg.speaker,
        },
        "asr": {
            "extra": {
                "enable_asr_twopass": true,
                "context": {
                    "hotwords": hotwords,
                    // 常见同音误识别 → 元元（服务端替换规则）。
                    "correct_words": {
                        "圆圆": "元元",
                        "原原": "元元",
                        "源源": "元元",
                        "袁袁": "元元",
                        "园园": "元元",
                    },
                },
            },
        },
        "dialog": {
            "bot_name": bot_name,
            // 人设语料（前端 buildSystemPrompt 拼装、含解密语料与观众画像）注入系统角色。
            "system_role": system_role,
            "extra": {
                // 合法值仅 keep_alive/push_to_talk/text/audio_file（无 "audio"）。
                // 桌宠为持续麦克风流式，用 keep_alive 兼顾静音保活，避免 52000042 音频空闲超时。
                "input_mod": "keep_alive",
                // 【必传】端到端模型版本。S_ 复刻音色需 2.0 链路：
                //   "1.2.1.1"=O2.0（支持精品音色+S_复刻2.0），"2.2.0.0"=SC2.0（角色扮演+S_复刻）。
                // 默认按 O2.0；若你的 S_ 音色是在 SC2.0 商品下注册，请改成 "2.2.0.0"。
                "model": protocol::MODEL_VERSION,
            },
        },
    });
    build_full_client(protocol::EV_START_SESSION, Some(session_id), &payload)
}

fn build_finish_session(session_id: &str) -> Vec<u8> {
    build_full_client(protocol::EV_FINISH_SESSION, Some(session_id), &serde_json::json!({}))
}

/// 上行音频帧：AUDIO_ONLY_CLIENT + TaskRequest 事件，payload 为原始 PCM（不压缩）。
fn build_audio_request(session_id: &str, pcm: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(16 + pcm.len());
    buf.push(protocol::HEADER_BYTE0);
    buf.push((protocol::MT_AUDIO_CLIENT << 4) | protocol::FLAG_WITH_EVENT);
    buf.push((protocol::SER_RAW << 4) | protocol::COMP_NONE);
    buf.push(0x00);
    buf.extend_from_slice(&protocol::EV_TASK_REQUEST.to_be_bytes());
    let sb = session_id.as_bytes();
    buf.extend_from_slice(&(sb.len() as u32).to_be_bytes());
    buf.extend_from_slice(sb);
    buf.extend_from_slice(&(pcm.len() as u32).to_be_bytes());
    buf.extend_from_slice(pcm);
    buf
}

// ============================ 帧解析（服务端 → 客户端）============================

enum ServerFrame {
    Audio(Vec<u8>),
    Event { event: i32, payload: Vec<u8> },
}

/// 解析服务端二进制帧。容错：字段不全时返回 None（跳过该帧）。
fn parse_server_frame(data: &[u8]) -> Option<ServerFrame> {
    if data.len() < 4 {
        return None;
    }
    let header_size = (data[0] & 0x0f) as usize * 4;
    let message_type = data[1] >> 4;
    let flags = data[1] & 0x0f;
    let compression = data[2] & 0x0f;
    let mut pos = header_size.max(4);

    // 带 event 号时先读 4 字节 event。
    let mut event = 0i32;
    if flags & protocol::FLAG_WITH_EVENT != 0 {
        if data.len() < pos + 4 {
            return None;
        }
        event = i32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
        pos += 4;
        // 官方所有服务端事件（含 AUDIO_ONLY_RESPONSE 如 TTSResponse）在 event 之后都携带
        // session_id（长度前缀 + 内容），对照文档 TTSResponse 字节示例
        // [17 180 0 0 | event(4) | 0 0 0 36 | <36B sid> | size(4) | payload]。
        // 与官方 demo parse_response 一致：只要带 event 就统一读掉 session_id。
        {
            if data.len() < pos + 4 {
                return None;
            }
            let sid_len =
                u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;
            pos += 4;
            if data.len() < pos + sid_len {
                return None;
            }
            pos += sid_len;
        }
    }

    // payload：4 字节长度 + 内容。
    if data.len() < pos + 4 {
        return None;
    }
    let plen = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;
    pos += 4;
    if data.len() < pos + plen {
        return None;
    }
    let raw = &data[pos..pos + plen];
    let payload = if compression == protocol::COMP_GZIP {
        gunzip(raw).unwrap_or_default()
    } else {
        raw.to_vec()
    };

    match message_type {
        protocol::MT_AUDIO_SERVER => Some(ServerFrame::Audio(payload)),
        protocol::MT_FULL_SERVER | protocol::MT_ERROR => Some(ServerFrame::Event { event, payload }),
        _ => None,
    }
}

/// 把服务端事件转成给前端的精简 JSON（None 表示无需转发）。
///
/// 前端按「一轮一气泡」聚合：
///   asr_start → asr(text,interim)… → asr_end
///   assistant(text delta)… → assistant_end
fn server_event_to_frontend(event: i32, payload: &[u8]) -> Option<String> {
    let json: serde_json::Value = serde_json::from_slice(payload).unwrap_or(serde_json::Value::Null);
    match event {
        // 只在 SessionStarted 通知前端「已接通」，避免 ConnectionStarted 再弹一次。
        protocol::EV_SESSION_STARTED => Some(to_frontend_session("started").to_string()),
        protocol::EV_CONNECTION_STARTED => None,
        // 首字：仅用于打断播报，不带文本。
        protocol::EV_ASR_INFO => Some(serde_json::json!({ "type": "asr_start" }).to_string()),
        protocol::EV_ASR_RESPONSE => {
            let (text, interim) = extract_asr(&json);
            let text = correct_yuan_name(&text);
            if text.is_empty() {
                None
            } else {
                Some(serde_json::json!({ "type": "asr", "text": text, "interim": interim }).to_string())
            }
        }
        protocol::EV_ASR_ENDED => Some(serde_json::json!({ "type": "asr_end" }).to_string()),
        protocol::EV_CHAT_RESPONSE => {
            let text = extract_text(&json);
            if text.is_empty() {
                None
            } else {
                Some(serde_json::json!({ "type": "assistant", "text": text }).to_string())
            }
        }
        protocol::EV_CHAT_ENDED => Some(serde_json::json!({ "type": "assistant_end" }).to_string()),
        protocol::EV_TTS_SENTENCE_START => Some(serde_json::json!({ "type": "speaking" }).to_string()),
        protocol::EV_TTS_ENDED => None,
        _ => {
            // 错误帧（含 error 字段）也带给前端便于定位。
            if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
                Some(to_frontend_error(err).to_string())
            } else if let Some(msg) = json.get("message").and_then(|v| v.as_str()) {
                Some(to_frontend_error(msg).to_string())
            } else {
                None
            }
        }
    }
}

/// ASRResponse(451)：{"results":[{"text":..,"is_interim":..}]}。
/// 返回 (全文, 是否中间态)；中间态时前端只更新同一气泡，终态/asr_end 再定稿。
fn extract_asr(json: &serde_json::Value) -> (String, bool) {
    if let Some(arr) = json.get("results").and_then(|v| v.as_array()) {
        let mut s = String::new();
        let mut interim = false;
        for it in arr {
            if let Some(t) = it.get("text").and_then(|v| v.as_str()) {
                s.push_str(t);
            }
            if it.get("is_interim").and_then(|v| v.as_bool()) == Some(true) {
                interim = true;
            }
        }
        return (s.trim().to_string(), interim);
    }
    (extract_text(json), true)
}

/// 兜底：把「元元」的常见同音误识别替换回来（服务端 correct_words 之外再保险一层）。
fn correct_yuan_name(text: &str) -> String {
    text.replace("圆圆", "元元")
        .replace("原原", "元元")
        .replace("源源", "元元")
        .replace("袁袁", "元元")
        .replace("园园", "元元")
}

/// 从事件 payload 里尽量取出文本（不同事件字段名可能不同，做多路兜底）。
fn extract_text(json: &serde_json::Value) -> String {
    for key in ["text", "content", "result", "transcript"] {
        if let Some(s) = json.get(key).and_then(|v| v.as_str()) {
            if !s.trim().is_empty() {
                return s.trim().to_string();
            }
        }
    }
    String::new()
}

fn to_frontend_error(msg: &str) -> serde_json::Value {
    serde_json::json!({ "type": "error", "message": msg })
}

fn to_frontend_session(state: &str) -> serde_json::Value {
    serde_json::json!({ "type": "session", "state": state })
}

// ============================ gzip 工具 ============================

#[allow(dead_code)] // 客户端已改无压缩；保留以备协议需要 gzip 上行时启用。
fn gzip(data: &[u8]) -> Vec<u8> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    let _ = enc.write_all(data);
    enc.finish().unwrap_or_default()
}

fn gunzip(data: &[u8]) -> Option<Vec<u8>> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    let mut dec = GzDecoder::new(data);
    let mut out = Vec::new();
    dec.read_to_end(&mut out).ok()?;
    Some(out)
}
