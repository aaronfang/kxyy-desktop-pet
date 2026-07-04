//! 本地回环 HTTP 代理：把 kxyy_ai_clone 的 `/api/chat` 契约在桌面端等价实现。
//! 聊天窗口前端仍按原样 `fetch(<apiBase>/api/chat)`（SSE 流式），
//! 由本服务读取本地设置里的 Key、转发到 DeepSeek / 通义千问(VL) 并把上游流原样透传回来。
//!
//! 只做「薄代理」：不落地、不缓存、不改协议——上游改了契约时改这里即可，改动面小。

use tauri::AppHandle;
use tiny_http::{Header, Method, Response, Server, StatusCode};

const TEXT_BASE_URL: &str = "https://api.deepseek.com";
const VL_BASE_URL: &str = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const VL_MODEL: &str = "qwen3-vl-plus";

// 火山引擎（豆包）声音复刻 TTS：HTTP 一次性合成，voice_id 以 S_ 开头。
// 本地 / CosyVoice 后端则转发到 scripts/local-realtime 的 HTTP /tts（WS 端口 +100）。
const VOLC_TTS_URL: &str = "https://openspeech.bytedance.com/api/v1/tts";
const VOLC_DEFAULT_CLUSTER: &str = "volcano_icl";
const TTS_MAX_CHARS: usize = 2000;
// 火山「瞬时/可重试」错误码（官方建议同参数换 reqid 重试）。
const VOLC_RETRIABLE: [i64; 6] = [3003, 3005, 3030, 3031, 3032, 3040];

/// 启动本地代理，返回实际监听端口（127.0.0.1，随机端口，避免冲突）。
pub fn start(app: AppHandle) -> std::io::Result<u16> {
    let server = Server::http("127.0.0.1:0")
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .unwrap_or(0);

    std::thread::spawn(move || {
        // 关键：禁用空闲连接池复用（pool_max_idle_per_host=0）。
        // 流式(SSE)响应被 tiny_http 透传后，若前端中途收起窗口导致上游流未读尽，
        // 该连接会以「半损坏」状态回到连接池；下一次请求复用它就会报
        // "error sending request for url ..."。每次都用全新连接可彻底规避。
        // 同时加连接超时，避免冷启动握手偶发卡死表现为"回复为空"。
        let client = reqwest::blocking::Client::builder()
            .pool_max_idle_per_host(0)
            .connect_timeout(std::time::Duration::from_secs(20))
            .tcp_nodelay(true)
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        for request in server.incoming_requests() {
            let app = app.clone();
            let client = client.clone();
            // 每个请求独立线程：一条聊天在长时间流式时不阻塞其它探针请求。
            std::thread::spawn(move || {
                handle(&app, &client, request);
            });
        }
    });

    Ok(port)
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes())
        .unwrap_or_else(|_| Header::from_bytes(&b"X-Ignore"[..], &b"1"[..]).unwrap())
}

/// 跨域头：聊天窗口来源是 tauri://localhost，请求本地 127.0.0.1 属跨域，需放行。
fn cors_headers() -> Vec<Header> {
    vec![
        header("Access-Control-Allow-Origin", "*"),
        header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
        header(
            "Access-Control-Allow-Headers",
            "Content-Type, x-api-key, x-vl-api-key, x-volc-tts-api-key, x-access-code",
        ),
        // 前端需读 TTS 计费字符头（CosyVoice / 火山）。
        header(
            "Access-Control-Expose-Headers",
            "X-Tts-Usage-Characters, X-Tts-Usage-Provider",
        ),
    ]
}

/// TTS 单次计费用量（按字符，非 LLM token）。
struct TtsUsage {
    characters: u64,
    provider: &'static str,
}

fn respond_json(request: tiny_http::Request, status: u16, body: String) {
    let mut headers = cors_headers();
    headers.push(header("Content-Type", "application/json; charset=utf-8"));
    headers.push(header("Cache-Control", "no-store"));
    let resp = Response::new(StatusCode(status), headers, body.as_bytes(), Some(body.len()), None);
    let _ = request.respond(resp);
}

fn error_json(request: tiny_http::Request, status: u16, msg: &str) {
    let body = serde_json::json!({ "error": msg }).to_string();
    respond_json(request, status, body);
}

fn handle(app: &AppHandle, client: &reqwest::blocking::Client, request: tiny_http::Request) {
    let method = request.method().clone();
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or("").to_string();

    // CORS 预检
    if method == Method::Options {
        let mut resp = Response::empty(StatusCode(204));
        for h in cors_headers() {
            resp.add_header(h);
        }
        let _ = request.respond(resp);
        return;
    }

    match (&method, path.as_str()) {
        // GET 探针：只回传服务端是否已配文字 Key，不触发上游、零费用。
        (Method::Get, "/api/chat") => {
            let cfg = crate::ai_config(app);
            let body = serde_json::json!({
                "ok": true,
                "hasServerKey": !cfg.deepseek_key.is_empty()
            })
            .to_string();
            respond_json(request, 200, body);
        }
        // DeepSeek 账户余额（金额，非剩余 token）。通义千问无对等接口。
        (Method::Get, "/api/balance") => {
            proxy_balance(app, client, request);
        }
        (Method::Post, "/api/chat") => {
            proxy_chat(app, client, request);
        }
        // 阶段 2·D：火山引擎语音合成，前端 tts.js POST 文本，回 audio/mpeg。
        (Method::Post, "/api/tts") => {
            proxy_tts(app, client, request);
        }
        (Method::Get, "/api/assets") => {
            match crate::persona_assets::decrypted_json() {
                Ok(body) => respond_json(request, 200, body),
                Err(e) => error_json(request, 500, &e),
            }
        }
        _ => {
            error_json(request, 404, "Not Found");
        }
    }
}

/// 查询 DeepSeek 账户余额，供 debug 面板展示「剩余额度」。
fn proxy_balance(app: &AppHandle, client: &reqwest::blocking::Client, request: tiny_http::Request) {
    let cfg = crate::ai_config(app);
    if cfg.deepseek_key.is_empty() {
        return error_json(request, 401, "未配置 DeepSeek API Key");
    }
    let resp = match client
        .get(format!("{TEXT_BASE_URL}/user/balance"))
        .header("Authorization", format!("Bearer {}", cfg.deepseek_key))
        .send()
    {
        Ok(r) => r,
        Err(e) => return error_json(request, 502, &format!("查询余额失败：{e}")),
    };
    let status = resp.status().as_u16();
    let text = resp.text().unwrap_or_default();
    if !(200..300).contains(&status) {
        let body = serde_json::json!({
            "error": format!("DeepSeek 余额查询错误 {status}"),
            "detail": text.chars().take(300).collect::<String>(),
        })
        .to_string();
        return respond_json(request, status, body);
    }
    let data: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return error_json(request, 502, "余额响应不是合法 JSON"),
    };
    // 优先 CNY，否则取第一条。
    let infos = data
        .get("balance_infos")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let info = infos
        .iter()
        .find(|i| i.get("currency").and_then(|c| c.as_str()) == Some("CNY"))
        .or_else(|| infos.first());
    let body = serde_json::json!({
        "provider": "DeepSeek",
        "isAvailable": data.get("is_available").and_then(|v| v.as_bool()).unwrap_or(false),
        "currency": info.and_then(|i| i.get("currency")).cloned().unwrap_or(serde_json::Value::Null),
        "totalBalance": info.and_then(|i| i.get("total_balance")).cloned().unwrap_or(serde_json::Value::Null),
        "grantedBalance": info.and_then(|i| i.get("granted_balance")).cloned().unwrap_or(serde_json::Value::Null),
        "toppedUpBalance": info.and_then(|i| i.get("topped_up_balance")).cloned().unwrap_or(serde_json::Value::Null),
    })
    .to_string();
    respond_json(request, 200, body);
}

fn messages_have_image(messages: &serde_json::Value) -> bool {
    messages
        .as_array()
        .map(|arr| {
            arr.iter().any(|m| {
                m.get("content")
                    .and_then(|c| c.as_array())
                    .map(|parts| {
                        parts.iter().any(|p| {
                            p.get("type").and_then(|t| t.as_str()) == Some("image_url")
                        })
                    })
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn proxy_chat(app: &AppHandle, client: &reqwest::blocking::Client, mut request: tiny_http::Request) {
    let mut raw = String::new();
    if request.as_reader().read_to_string(&mut raw).is_err() {
        return error_json(request, 400, "读取请求体失败");
    }
    let body: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return error_json(request, 400, "请求体不是合法 JSON"),
    };

    let messages = body.get("messages").cloned().unwrap_or(serde_json::Value::Null);
    if !messages.is_array() || messages.as_array().map(|a| a.is_empty()).unwrap_or(true) {
        return error_json(request, 400, "messages 不能为空");
    }

    let force = body.get("provider").and_then(|v| v.as_str());
    let use_vision = match force {
        Some("vl") => true,
        Some("text") => false,
        _ => messages_have_image(&messages),
    };

    let cfg = crate::ai_config(app);
    let thinking = body
        .get("thinking")
        .and_then(|v| v.as_bool())
        .unwrap_or(cfg.thinking_default);

    let (base_url, model, api_key, provider_name) = if use_vision {
        (
            VL_BASE_URL.to_string(),
            VL_MODEL.to_string(),
            cfg.qwen_vl_key.clone(),
            "通义千问",
        )
    } else {
        let model = if !cfg.text_model.is_empty() {
            cfg.text_model.clone()
        } else if thinking {
            "deepseek-reasoner".to_string()
        } else {
            "deepseek-chat".to_string()
        };
        (TEXT_BASE_URL.to_string(), model, cfg.deepseek_key.clone(), "DeepSeek")
    };

    if api_key.is_empty() {
        let msg = if use_vision {
            "未配置通义千问(看图) API Key，请在设置里填写"
        } else {
            "未配置 DeepSeek API Key，请在设置里填写"
        };
        return error_json(request, 401, msg);
    }

    let is_reasoner = model.to_lowercase().contains("reasoner");
    let temperature = body
        .get("temperature")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.8);
    let max_tokens_in = body
        .get("max_tokens")
        .and_then(|v| v.as_i64())
        .unwrap_or(400);
    // reasoner 的 max_tokens 含思考链，需放大预算。
    let max_tokens = if is_reasoner {
        (max_tokens_in * 4).max(2048)
    } else {
        max_tokens_in
    };
    let stream = body.get("stream").and_then(|v| v.as_bool()).unwrap_or(true);

    let mut payload = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": stream,
    });
    // 流式默认不带 usage；打开后最后一帧会带 prompt/completion/total tokens。
    if stream {
        payload["stream_options"] = serde_json::json!({ "include_usage": true });
    }
    // deepseek-reasoner 会忽略 temperature，非 reasoner 时照常下发。
    if !is_reasoner {
        payload["temperature"] = serde_json::json!(temperature);
    }

    // 传输层重试：`error sending request for url ...` 属于连接被复用到「半损坏」状态或
    // 瞬时网络抖动导致的**发送失败**（非上游业务错误）。此类错误一旦发生，前端会把本轮标记为
    // error 且不会自动重试，用户便看到「连发几条都出错」。这里对纯传输失败最多重试 3 次，
    // 且从第 2 次起改用一次性全新 Client（连接池彻底隔离），规避残留的坏连接。
    let url = format!("{base_url}/chat/completions");
    let mut last_err = String::new();
    let mut upstream_opt = None;
    for attempt in 0..3 {
        let this_client: reqwest::blocking::Client;
        let cli: &reqwest::blocking::Client = if attempt == 0 {
            client
        } else {
            this_client = reqwest::blocking::Client::builder()
                .pool_max_idle_per_host(0)
                .connect_timeout(std::time::Duration::from_secs(20))
                .tcp_nodelay(true)
                .build()
                .unwrap_or_else(|_| reqwest::blocking::Client::new());
            &this_client
        };
        match cli
            .post(&url)
            .header("Authorization", format!("Bearer {api_key}"))
            .json(&payload)
            .send()
        {
            Ok(r) => {
                upstream_opt = Some(r);
                break;
            }
            Err(e) => {
                last_err = e.to_string();
                std::thread::sleep(std::time::Duration::from_millis(200 * (attempt + 1)));
            }
        }
    }

    let upstream = match upstream_opt {
        Some(r) => r,
        None => {
            return error_json(request, 502, &format!("连接{provider_name}失败：{last_err}"));
        }
    };

    let status = upstream.status();
    if !status.is_success() {
        let detail = upstream.text().unwrap_or_default();
        let body = serde_json::json!({
            "error": format!("{provider_name} 错误 {}", status.as_u16()),
            "detail": detail.chars().take(500).collect::<String>(),
        })
        .to_string();
        return respond_json(request, status.as_u16(), body);
    }

    if !stream {
        let text = upstream.text().unwrap_or_default();
        return respond_json(request, 200, text);
    }

    // 流式：原先把上游 Response 当 Read 直接透传给 tiny_http 走 chunked（无 Content-Length）。
    // 但 Windows 的 WebView2 对 127.0.0.1 的「chunked 流式 fetch + getReader()」读取存在
    // 兼容问题：常常一个数据块都读不到，前端遂判定「回复为空」（且时好时坏，取决于时序）。
    // 改为：Rust 侧把整段上游 SSE 读完，带 Content-Length 一次性回给前端——WebView2 对
    // 「有明确长度的响应」读取稳定。代价是失去打字机逐字效果（整条回复一次性出现），
    // 但先保证「能出字」；后续若要恢复流式再针对 WebView2 专门处理。
    let body = match upstream.text() {
        Ok(t) => t,
        Err(e) => return error_json(request, 502, &format!("读取{provider_name}响应失败：{e}")),
    };
    let bytes = body.into_bytes();
    let len = bytes.len();
    let mut headers = cors_headers();
    headers.push(header("Content-Type", "text/event-stream; charset=utf-8"));
    headers.push(header("Cache-Control", "no-cache, no-transform"));
    let resp = Response::new(
        StatusCode(200),
        headers,
        std::io::Cursor::new(bytes),
        Some(len),
        None,
    );
    let _ = request.respond(resp);
}

// ============ 阶段 2·D：火山引擎（豆包）声音复刻 TTS ============

/// 读取请求头（大小写不敏感），返回其值。
fn req_header<'a>(request: &'a tiny_http::Request, name: &str) -> Option<&'a str> {
    request.headers().iter().find_map(|h| {
        if h.field.as_str().as_str().eq_ignore_ascii_case(name) {
            Some(h.value.as_str())
        } else {
            None
        }
    })
}

/// 标准 base64 解码（火山返回的整段 mp3 以 base64 放在 data 字段）。无外部依赖，
/// 忽略填充/空白；遇到非法字符返回 None。
fn b64_decode(input: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for &c in input.as_bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' || c == b' ' || c == b'\t' {
            continue;
        }
        buf = (buf << 6) | val(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

/// 生成一个够用的 reqid（火山只要求本次请求内唯一即可）。
fn tts_reqid() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("kxyy-{n:x}")
}

/// 从火山 JSON 响应里抠计费字符；V1 常不带 usage，则按原文 Unicode 字数估算。
fn volc_usage_chars(data: &serde_json::Value, text: &str) -> u64 {
    let from_usage = data
        .get("usage")
        .and_then(|u| {
            u.get("text_words")
                .or_else(|| u.get("characters"))
                .or_else(|| u.get("text_length"))
        })
        .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|n| n.max(0) as u64)));
    if let Some(n) = from_usage.filter(|n| *n > 0) {
        return n;
    }
    let from_addition = data
        .get("addition")
        .and_then(|a| a.get("text_words").or_else(|| a.get("characters")))
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_i64().map(|n| n.max(0) as u64))
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        });
    if let Some(n) = from_addition.filter(|n| *n > 0) {
        return n;
    }
    // 声音复刻 HTTP V1 通常不回 usage；按字计费，用原文长度作近似。
    text.chars().count() as u64
}

/// 一次火山 HTTP 合成：成功返回 (mp3, 计费字符)，失败返回 (火山错误码, 说明)。
fn volc_tts_once(
    client: &reqwest::blocking::Client,
    api_key: &str,
    cluster: &str,
    voice: &str,
    text: &str,
    speed: Option<f64>,
    pitch: Option<f64>,
    emotion: &str,
) -> Result<(Vec<u8>, u64), (Option<i64>, String)> {
    let mut audio = serde_json::json!({
        "voice_type": voice,
        "encoding": "mp3",
    });
    if let Some(s) = speed {
        audio["speed_ratio"] = serde_json::json!(s);
    }
    if let Some(p) = pitch {
        audio["pitch_ratio"] = serde_json::json!(p);
    }
    if !emotion.is_empty() {
        audio["emotion"] = serde_json::json!(emotion);
    }
    let payload = serde_json::json!({
        "app": { "cluster": cluster },
        "user": { "uid": "kxyy" },
        "audio": audio,
        "request": { "reqid": tts_reqid(), "text": text, "operation": "query" },
    });

    let resp = client
        .post(VOLC_TTS_URL)
        .header("Content-Type", "application/json")
        .header("x-api-key", api_key)
        // V3 流式接口靠此头回 usage；V1 若支持则一并带上。
        .header("X-Control-Require-Usage-Tokens-Return", "true")
        .json(&payload)
        .send()
        .map_err(|e| (None, e.to_string()))?;

    let status = resp.status();
    let data: serde_json::Value = resp
        .json()
        .map_err(|e| (None, format!("火山返回非 JSON（HTTP {}）：{e}", status.as_u16())))?;

    let code = data.get("code").and_then(|v| v.as_i64());
    let audio_b64 = data.get("data").and_then(|v| v.as_str());
    if code != Some(3000) || audio_b64.is_none() {
        let msg = data
            .get("message")
            .or_else(|| data.get("Message"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        return Err((code, format!("code={} {msg}", code.unwrap_or(0)).trim().to_string()));
    }

    let bytes = b64_decode(audio_b64.unwrap()).ok_or((code, "base64 解码失败".to_string()))?;
    if bytes.is_empty() {
        return Err((code, "合成结果为空".to_string()));
    }
    let chars = volc_usage_chars(&data, text);
    Ok((bytes, chars))
}

fn respond_audio(
    request: tiny_http::Request,
    bytes: Vec<u8>,
    content_type: &str,
    usage: Option<TtsUsage>,
) {
    let mut headers = cors_headers();
    headers.push(header("Content-Type", content_type));
    headers.push(header("Cache-Control", "no-store"));
    if let Some(u) = usage {
        if u.characters > 0 {
            headers.push(header(
                "X-Tts-Usage-Characters",
                &u.characters.to_string(),
            ));
            headers.push(header("X-Tts-Usage-Provider", u.provider));
        }
    }
    let len = bytes.len();
    let resp = Response::new(StatusCode(200), headers, std::io::Cursor::new(bytes), Some(len), None);
    let _ = request.respond(resp);
}

fn proxy_tts(app: &AppHandle, client: &reqwest::blocking::Client, mut request: tiny_http::Request) {
    let mut raw = String::new();
    if request.as_reader().read_to_string(&mut raw).is_err() {
        return error_json(request, 400, "读取请求体失败");
    }
    let body: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return error_json(request, 400, "请求体不是合法 JSON"),
    };

    let cfg = crate::ai_config(app);
    // 本地 / CosyVoice：转发到本机 Python 服务，不走火山。
    if let Some(port) = crate::local_tts_http_port(&cfg.voice_backend) {
        return proxy_local_tts(client, request, port, &raw);
    }
    proxy_volc_tts(client, request, &cfg, &body);
}

/// 本地语音后端朗读：POST http://127.0.0.1:{port}/tts → audio/wav。
fn proxy_local_tts(
    client: &reqwest::blocking::Client,
    request: tiny_http::Request,
    port: u16,
    body_raw: &str,
) {
    let url = format!("http://127.0.0.1:{port}/tts");
    let resp = match client
        .post(&url)
        .header("Content-Type", "application/json")
        // 与本地 TTS 服务约定的共享 secret，避免其它本机进程直接调用刷云端计费。
        .header("X-Tts-Secret", crate::voice_service::tts_secret())
        .body(body_raw.to_string())
        .timeout(std::time::Duration::from_secs(60))
        .send()
    {
        Ok(r) => r,
        Err(e) => {
            return error_json(
                request,
                503,
                &format!("本地语音服务未启动或不可达（{url}）：{e}"),
            );
        }
    };
    let status = resp.status().as_u16();
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("audio/wav")
        .to_string();
    // CosyVoice 等云端后端会在本地 Python 服务上挂计费字符头。
    let usage_chars = resp
        .headers()
        .get("x-tts-usage-characters")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let usage_provider = resp
        .headers()
        .get("x-tts-usage-provider")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = match resp.bytes() {
        Ok(b) => b.to_vec(),
        Err(e) => return error_json(request, 502, &format!("读取本地 TTS 响应失败：{e}")),
    };
    if !(200..300).contains(&status) {
        let detail = String::from_utf8_lossy(&bytes);
        let body = serde_json::json!({
            "error": "TTS 合成失败（本地服务）",
            "detail": detail.chars().take(300).collect::<String>(),
        })
        .to_string();
        return respond_json(request, if status == 0 { 502 } else { status }, body);
    }
    let usage = if usage_chars > 0 {
        // provider 字符串来自本地服务；仅 CosyVoice 会带，用静态标签即可。
        let provider: &'static str = if usage_provider.eq_ignore_ascii_case("cosyvoice") {
            "CosyVoice"
        } else if !usage_provider.is_empty() {
            "TTS"
        } else {
            "CosyVoice"
        };
        Some(TtsUsage {
            characters: usage_chars,
            provider,
        })
    } else {
        None
    };
    respond_audio(request, bytes, &ct, usage);
}

fn proxy_volc_tts(
    client: &reqwest::blocking::Client,
    request: tiny_http::Request,
    cfg: &crate::AiConfig,
    body: &serde_json::Value,
) {
    // 音色：前端传入的合法火山音色（S_ 开头）> 设置里的默认音色。
    let body_voice = body.get("voice").and_then(|v| v.as_str()).unwrap_or("").trim();
    let voice = if body_voice.starts_with("S_") {
        body_voice.to_string()
    } else {
        cfg.tts_voice.trim().to_string()
    };
    if voice.is_empty() {
        return error_json(request, 400, "未配置朗读音色（voice_id），请在设置里填写 S_ 开头的火山音色");
    }
    if !voice.starts_with("S_") {
        return error_json(request, 400, "火山后端需 S_ 开头的复刻音色");
    }

    let text = body.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
    if text.is_empty() {
        return error_json(request, 400, "text 不能为空");
    }
    let text_trunc: String = text.chars().take(TTS_MAX_CHARS).collect();

    // Key：前端头 x-volc-tts-api-key > 设置里的火山 Key。
    let volc_key = req_header(&request, "x-volc-tts-api-key")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| cfg.volc_tts_key.trim().to_string());
    if volc_key.is_empty() {
        return error_json(request, 401, "未配置火山 TTS Key，请在设置里填写");
    }

    // 情绪：前端桶（excited/angry/sad/shy/gentle/neutral）→ 火山 emotion 枚举。
    let emotion = match body.get("emotion").and_then(|v| v.as_str()).unwrap_or("") {
        "excited" => "happy",
        "angry" => "angry",
        "sad" => "sad",
        "shy" => "shy",
        "gentle" => "tender",
        "neutral" => "neutral",
        _ => "",
    };

    // 语气参数：rate→speed_ratio、pitch→pitch_ratio，仅在 [0.5,2] 内下发。
    let clamp = |key: &str| {
        body.get("params")
            .and_then(|p| p.get(key))
            .and_then(|v| v.as_f64())
            .filter(|n| *n >= 0.5 && *n <= 2.0)
    };
    let speed = clamp("rate");
    let pitch = clamp("pitch");

    let cluster = VOLC_DEFAULT_CLUSTER;
    // 带重试：瞬时错误码同参数换 reqid 重试；最终仍失败且带情绪则去掉 emotion 兜底一次。
    let mut result: Result<(Vec<u8>, u64), (Option<i64>, String)> =
        Err((None, "未执行".to_string()));
    for i in 0..3 {
        match volc_tts_once(client, &volc_key, cluster, &voice, &text_trunc, speed, pitch, emotion) {
            Ok(ok) => {
                result = Ok(ok);
                break;
            }
            Err((code, msg)) => {
                let retriable = code.map(|c| VOLC_RETRIABLE.contains(&c)).unwrap_or(false);
                result = Err((code, msg));
                if !retriable {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(300 * (i + 1)));
            }
        }
    }
    if result.is_err() && !emotion.is_empty() {
        if let Ok(ok) = volc_tts_once(client, &volc_key, cluster, &voice, &text_trunc, speed, pitch, "") {
            result = Ok(ok);
        }
    }

    match result {
        Ok((bytes, chars)) => respond_audio(
            request,
            bytes,
            "audio/mpeg",
            Some(TtsUsage {
                characters: chars,
                provider: "火山引擎",
            }),
        ),
        Err((_, detail)) => {
            let body = serde_json::json!({
                "error": "TTS 合成失败（火山引擎）",
                "detail": detail.chars().take(300).collect::<String>(),
            })
            .to_string();
            respond_json(request, 502, body);
        }
    }
}
