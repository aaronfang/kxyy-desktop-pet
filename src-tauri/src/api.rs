//! 本地回环 HTTP 代理：把 kxyy_ai_clone 的 `/api/chat` 契约在桌面端等价实现。
//! 聊天窗口前端仍按原样 `fetch(<apiBase>/api/chat)`（SSE 流式），
//! 由本服务读取本地设置里的 Key、转发到 DeepSeek / 通义千问(VL) 并把上游流原样透传回来。
//!
//! 只做「薄代理」：不落地、不缓存、不改协议——上游改了契约时改这里即可，改动面小。

use std::io::{BufRead, BufReader, Read};

use tauri::AppHandle;
use tiny_http::{Header, Method, Response, Server, StatusCode};

const TEXT_BASE_URL: &str = "https://api.deepseek.com";
const DEEPSEEK_FLASH_MODEL: &str = "deepseek-v4-flash";
const DEEPSEEK_PRO_MODEL: &str = "deepseek-v4-pro";
const QWEN_VL_BASE_URL: &str = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const QWEN_VL_MODEL: &str = "qwen3-vl-plus";
const DEEPSEEK_VISION_MODEL: &str = "deepseek-v4-flash-vision-exp";
// 本地文字模型：Ollama 的 OpenAI 兼容端点，无需 Key（Authorization 头会被忽略）。
const OLLAMA_CHAT_BASE_URL: &str = "http://127.0.0.1:11434/v1";
const OLLAMA_NATIVE_CHAT_URL: &str = "http://127.0.0.1:11434/api/chat";
// 仅受托管本地语音子进程携带；普通 WebView 请求不得用它绕过 Windows SSE 缓冲路径。
const INTERNAL_SECRET_HEADER: &str = "X-Kxyy-Internal-Secret";
const TAVILY_SEARCH_URL: &str = "https://api.tavily.com/search";
const WEB_QUERY_MAX_CHARS: usize = 300;
const WEB_RESPONSE_MAX_BYTES: u64 = 256 * 1024;
const WEB_RESULT_MAX_ITEMS: usize = 4;
const WEB_RESULT_TEXT_MAX_CHARS: usize = 700;

/// DeepSeek 只接受当前公开模型名。旧设置和未知持久化值在本地迁移，绝不原样上送。
fn normalize_deepseek_model(configured: &str) -> &'static str {
    match configured.trim() {
        "deepseek-v4-flash" | "deepseek-chat" => DEEPSEEK_FLASH_MODEL,
        "deepseek-v4-pro" | "deepseek-reasoner" => DEEPSEEK_PRO_MODEL,
        "deepseek-v4-flash-vision-exp" => DEEPSEEK_VISION_MODEL,
        _ => DEEPSEEK_FLASH_MODEL,
    }
}

/// 在线视觉模型只允许已审核的固定端点和模型名，未知设置回退到既有 Qwen 路径。
fn online_vision_route(provider: &str) -> (&'static str, &'static str, &'static str) {
    if provider == "deepseek" {
        (TEXT_BASE_URL, DEEPSEEK_VISION_MODEL, "DeepSeek 看图")
    } else {
        (QWEN_VL_BASE_URL, QWEN_VL_MODEL, "通义千问")
    }
}

fn apply_deepseek_generation_options(
    payload: &mut serde_json::Value,
    thinking: bool,
    temperature: f64,
) {
    payload["thinking"] = serde_json::json!({
        "type": if thinking { "enabled" } else { "disabled" }
    });
    if !thinking {
        payload["temperature"] = serde_json::json!(temperature);
    }
}

fn apply_selected_deepseek_generation_options(
    payload: &mut serde_json::Value,
    model: &str,
    thinking: bool,
    temperature: f64,
) {
    if model == DEEPSEEK_VISION_MODEL {
        payload["temperature"] = serde_json::json!(temperature);
    } else {
        apply_deepseek_generation_options(payload, thinking, temperature);
    }
}

/// 把 Ollama 的 400（尤其是超上下文）翻译成用户能看懂的中文。
fn local_ollama_error_message(status: u16, detail: &str) -> String {
    let lower = detail.to_ascii_lowercase();
    if lower.contains("exceed_context_size")
        || lower.contains("exceeds the available context")
        || (lower.contains("n_prompt_tokens") && lower.contains("n_ctx"))
    {
        // 尽量抠出具体数字
        let prompt = extract_jsonish_u64(detail, "n_prompt_tokens");
        let ctx = extract_jsonish_u64(detail, "n_ctx");
        return match (prompt, ctx) {
            (Some(p), Some(c)) => format!(
                "本地模型上下文不够（本次约 {p} tokens，上限 {c}）。请清空一部分聊天后重试，或换更短的回复。"
            ),
            _ => "本地模型上下文不够（对话+人设超窗）。请清空一部分聊天后重试。".into(),
        };
    }
    format!("本地模型 错误 {status}")
}

fn extract_jsonish_u64(hay: &str, key: &str) -> Option<u64> {
    let needle = format!("\"{key}\"");
    let i = hay.find(&needle)?;
    let after = &hay[i + needle.len()..];
    let colon = after.find(':')?;
    let rest = after[colon + 1..].trim_start();
    let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    num.parse().ok()
}

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
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);

    std::thread::spawn(move || {
        // 关键：禁用空闲连接池复用（pool_max_idle_per_host=0）。
        // 流式(SSE)响应被 tiny_http 透传后，若前端中途收起窗口导致上游流未读尽，
        // 该连接会以「半损坏」状态回到连接池；下一次请求复用它就会报
        // "error sending request for url ..."。每次都用全新连接可彻底规避。
        // 同时加连接超时，避免冷启动握手偶发卡死表现为"回复为空"。
        let client = reqwest::blocking::Client::builder()
            .pool_max_idle_per_host(0)
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(600))
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
            "X-Tts-Usage-Characters, X-Tts-Usage-Provider, X-Kxyy-Text-Provider",
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
    let resp = Response::new(
        StatusCode(status),
        headers,
        body.as_bytes(),
        Some(body.len()),
        None,
    );
    let _ = request.respond(resp);
}

fn respond_json_with_text_provider(
    request: tiny_http::Request,
    body: String,
    provider: &'static str,
) {
    let mut headers = cors_headers();
    headers.push(header("Content-Type", "application/json; charset=utf-8"));
    headers.push(header("Cache-Control", "no-store"));
    headers.push(header("X-Kxyy-Text-Provider", provider));
    let len = body.len();
    let resp = Response::new(StatusCode(200), headers, body.as_bytes(), Some(len), None);
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
            // 本地 Ollama 无需 Key；仅 DeepSeek 分支需要检查是否已配置。
            let has_server_key = cfg.text_provider == "local" || !cfg.deepseek_key.is_empty();
            let body = serde_json::json!({
                "ok": true,
                "hasServerKey": has_server_key
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
        (Method::Post, "/api/web-observations") => {
            proxy_web_observations(app, client, request);
        }
        // 阶段 2·D：火山引擎语音合成，前端 tts.js POST 文本，回 audio/mpeg。
        (Method::Post, "/api/tts") => {
            proxy_tts(app, client, request);
        }
        (Method::Get, "/api/assets") => match crate::persona_assets::decrypted_json() {
            Ok(body) => respond_json(request, 200, body),
            Err(e) => error_json(request, 500, &e),
        },
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
                        parts
                            .iter()
                            .any(|p| p.get("type").and_then(|t| t.as_str()) == Some("image_url"))
                    })
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Extract the assistant text from either shape: native `/api/chat` returns
/// `message.content`, the OpenAI-compatible endpoint returns `choices[0].message.content`.
fn memory_completion_content(data: &serde_json::Value) -> Option<String> {
    data.get("message")
        .or_else(|| {
            data.get("choices")
                .and_then(|choices| choices.get(0))
                .and_then(|choice| choice.get("message"))
        })
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .map(str::to_string)
        .filter(|text| !text.trim().is_empty())
}

/// Memory v3 后台巩固使用的非流式文字补全。
/// 在线复用当前规范化后的 DeepSeek 非思考模型；本地复用当前 Ollama 模型并关闭思考，
/// 避免维护任务抢占过多 token。该函数不开放新的 HTTP 路由，只供 Rust 内部调用。
pub(crate) fn complete_memory_json(
    app: &AppHandle,
    system: &str,
    user: &str,
) -> Result<String, String> {
    let cfg = crate::ai_config(app);
    let is_local = cfg.text_provider == "local";
    let (url, model, api_key, provider) = if is_local {
        let model = if cfg.local_text_model.trim().is_empty() {
            crate::local_text::DEFAULT_MODEL.to_string()
        } else {
            cfg.local_text_model.clone()
        };
        (
            // Native, not `/v1`: the OpenAI-compatible endpoint ignores num_ctx, so a
            // consolidation there runs at the server default while realtime voice runs
            // at LOCAL_NUM_CTX. Ollama evicts and reloads the model between two context
            // sizes, which showed up as multi-second load_duration at the start of a
            // call. Same endpoint and same num_ctx keeps one resident instance.
            OLLAMA_NATIVE_CHAT_URL.to_string(),
            model,
            "ollama".to_string(),
            "本地模型",
        )
    } else {
        if cfg.deepseek_key.trim().is_empty() {
            return Err("未配置 DeepSeek API Key，记忆已留在待处理队列".into());
        }
        (
            format!("{TEXT_BASE_URL}/chat/completions"),
            normalize_deepseek_model("").to_string(),
            cfg.deepseek_key.clone(),
            "DeepSeek",
        )
    };
    let payload = if is_local {
        serde_json::json!({
            "model": model,
            "messages": [
                {"role":"system","content":system},
                {"role":"user","content":user}
            ],
            "stream": false,
            "think": false,
            "format": "json",
            "keep_alive": crate::local_text::KEEP_ALIVE,
            "options": {
                "num_ctx": crate::local_text::LOCAL_NUM_CTX,
                "num_predict": 1800,
                "temperature": 0.1,
            },
        })
    } else {
        let mut payload = serde_json::json!({
            "model": model,
            "messages": [
                {"role":"system","content":system},
                {"role":"user","content":user}
            ],
            "stream": false,
            "temperature": 0.1,
            "max_tokens": 1400
        });
        apply_deepseek_generation_options(&mut payload, false, 0.1);
        payload["response_format"] = serde_json::json!({"type":"json_object"});
        payload
    };
    let mut last_error = String::new();
    for attempt in 0..3 {
        let client = reqwest::blocking::Client::builder()
            .pool_max_idle_per_host(0)
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(180))
            .tcp_nodelay(true)
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client
            .post(&url)
            .header("Authorization", format!("Bearer {api_key}"))
            .json(&payload)
            .send()
        {
            Ok(response) => {
                let status = response.status();
                let raw = response.text().unwrap_or_default();
                if !status.is_success() {
                    return Err(if is_local {
                        local_ollama_error_message(status.as_u16(), &raw)
                    } else {
                        format!("{provider} 错误 {}", status.as_u16())
                    });
                }
                if is_local {
                    crate::local_text::touch_keep_alive(&model);
                }
                let data: serde_json::Value = serde_json::from_str(&raw)
                    .map_err(|e| format!("{provider} 返回非 JSON：{e}"))?;
                return memory_completion_content(&data)
                    .ok_or_else(|| format!("{provider} 返回了空的记忆整理结果"));
            }
            Err(e) => {
                last_error = e.to_string();
                std::thread::sleep(std::time::Duration::from_millis(200 * (attempt + 1)));
            }
        }
    }
    Err(format!("连接{provider}失败：{last_error}"))
}

/// Adapter that keeps the memory domain independent from provider/config types.
pub(crate) struct ApiMemoryCompletionProvider {
    app: AppHandle,
}

impl ApiMemoryCompletionProvider {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl crate::memory_core::MemoryCompletionProvider for ApiMemoryCompletionProvider {
    fn complete_memory_batch(
        &self,
        request: crate::memory_core::MemoryCompletionRequest,
    ) -> Result<crate::memory_core::MemoryCompletionResult, crate::memory_core::MemoryProviderError>
    {
        let started = std::time::Instant::now();
        let json = complete_memory_json(&self.app, &request.system, &request.input)
            .map_err(crate::memory_core::MemoryProviderError::Request)?;
        Ok(crate::memory_core::MemoryCompletionResult {
            json,
            provider: if crate::ai_config(&self.app).text_provider == "local" {
                "ollama".into()
            } else {
                "deepseek".into()
            },
            elapsed_ms: started.elapsed().as_millis(),
        })
    }
}

fn proxy_chat(
    app: &AppHandle,
    client: &reqwest::blocking::Client,
    mut request: tiny_http::Request,
) {
    let trusted_internal_request = internal_secret_matches(
        req_header(&request, INTERNAL_SECRET_HEADER),
        crate::voice_service::tts_secret(),
    );
    let mut raw = String::new();
    if request.as_reader().read_to_string(&mut raw).is_err() {
        return error_json(request, 400, "读取请求体失败");
    }
    let body: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return error_json(request, 400, "请求体不是合法 JSON"),
    };

    let messages = body
        .get("messages")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
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
    // 模型档位与 reasoning 独立：自动模型始终使用成本较低的 Flash，
    // thinking 只通过下方 thinking.type 控制；Pro 仅由显式配置选择。
    let normalized_text_model = normalize_deepseek_model(&cfg.text_model);

    let is_local_text = !use_vision && cfg.text_provider == "local";
    let is_local_vl = use_vision && cfg.vl_provider == "local";
    let is_deepseek_multimodal_text =
        !use_vision && !is_local_text && normalized_text_model == DEEPSEEK_VISION_MODEL;

    let (base_url, model, api_key, provider_name) = if is_local_vl {
        let model = if !cfg.local_vl_model.is_empty() {
            cfg.local_vl_model.clone()
        } else {
            "minicpm-v:8b".to_string()
        };
        (
            OLLAMA_CHAT_BASE_URL.to_string(),
            model,
            "ollama".to_string(),
            "本地看图",
        )
    } else if use_vision {
        let (base_url, model, provider_name) = online_vision_route(&cfg.vl_provider);
        let api_key = if cfg.vl_provider == "deepseek" {
            cfg.deepseek_key.clone()
        } else {
            cfg.qwen_vl_key.clone()
        };
        (
            base_url.to_string(),
            model.to_string(),
            api_key,
            provider_name,
        )
    } else if is_local_text {
        let model = if !cfg.local_text_model.is_empty() {
            cfg.local_text_model.clone()
        } else {
            crate::local_text::DEFAULT_MODEL.to_string()
        };
        // Ollama 忽略 Authorization 头，占位值即可，避免下面的空 Key 检查误判。
        (
            OLLAMA_CHAT_BASE_URL.to_string(),
            model,
            "ollama".to_string(),
            "本地模型",
        )
    } else {
        (
            TEXT_BASE_URL.to_string(),
            normalized_text_model.to_string(),
            cfg.deepseek_key.clone(),
            "DeepSeek",
        )
    };

    if api_key.is_empty() && !is_local_vl {
        let msg = if use_vision && cfg.vl_provider == "deepseek" {
            "未配置 DeepSeek API Key，无法使用 DeepSeek 看图"
        } else if use_vision {
            "未配置通义千问(看图) API Key，请在设置里填写"
        } else {
            "未配置 DeepSeek API Key，请在设置里填写"
        };
        return error_json(request, 401, msg);
    }

    let deepseek_thinking =
        !use_vision && !is_local_text && !is_deepseek_multimodal_text && thinking;
    let reasoning_enabled = deepseek_thinking || (is_local_text && thinking);
    let temperature = body
        .get("temperature")
        .and_then(|v| v.as_f64())
        .unwrap_or(cfg.temperature_default)
        .clamp(0.0, 2.0);
    let max_tokens_in = body
        .get("max_tokens")
        .and_then(|v| v.as_i64())
        .unwrap_or(400);
    // 预算：
    // - DeepSeek / 本地开启思考：思考链占用同一 max_tokens，需大幅放大，避免正文被截空。
    // - 本地关闭思考：保留小幅余量即可（前端 normal≈800）；过大的硬下限会拖慢本地生成。
    let max_tokens = if reasoning_enabled {
        (max_tokens_in * 6).max(4096)
    } else if is_local_text {
        max_tokens_in.max(512)
    } else {
        max_tokens_in
    };
    let stream = body.get("stream").and_then(|v| v.as_bool()).unwrap_or(true);
    let passthrough_internal_sse =
        should_passthrough_internal_sse(stream, force, use_vision, trusted_internal_request);
    let native_ollama_realtime =
        should_use_native_ollama_realtime(is_local_text, passthrough_internal_sse, thinking);

    let mut payload = if native_ollama_realtime {
        build_native_ollama_realtime_payload(&model, messages, max_tokens, temperature)
    } else {
        serde_json::json!({
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "stream": stream,
        })
    };
    // 流式默认不带 usage；打开后最后一帧会带 prompt/completion/total tokens。
    if stream && !native_ollama_realtime {
        payload["stream_options"] = serde_json::json!({ "include_usage": true });
    }
    // 思考模式由当前 DeepSeek API 的 thinking.type 显式控制；思考时不下发 temperature。
    if !use_vision && !is_local_text {
        apply_selected_deepseek_generation_options(
            &mut payload,
            normalized_text_model,
            deepseek_thinking,
            temperature,
        );
    } else if !reasoning_enabled {
        payload["temperature"] = serde_json::json!(temperature);
    }
    // 本地 Qwen3 等思考模型：OpenAI 兼容端点用 reasoning_effort 控制开关
    //（不传时 Ollama 会默认开思考；native `think` 字段在 /v1 上不可靠）。
    // 注意：`/v1` 会忽略 keep_alive / num_ctx；常驻与上下文扩容由 warmup + touch_keep_alive
    // 走 native `/api/chat` 完成。
    // 注意：local VL 模型（minicpm-v 等）不支持思考模式，仅 local_text 下发 reasoning 控制。
    if is_local_text && !native_ollama_realtime {
        payload["reasoning_effort"] = serde_json::json!(if thinking { "medium" } else { "none" });
        payload["think"] = serde_json::json!(thinking);
    }

    // 传输层重试：`error sending request for url ...` 属于连接被复用到「半损坏」状态或
    // 瞬时网络抖动导致的**发送失败**（非上游业务错误）。此类错误一旦发生，前端会把本轮标记为
    // error 且不会自动重试，用户便看到「连发几条都出错」。这里对纯传输失败最多重试 3 次，
    // 且从第 2 次起改用一次性全新 Client（连接池彻底隔离），规避残留的坏连接。
    let url = if native_ollama_realtime {
        OLLAMA_NATIVE_CHAT_URL.to_string()
    } else {
        format!("{base_url}/chat/completions")
    };
    let mut last_err = String::new();
    let mut upstream_opt = None;
    // Started before the first send so transport retries stay inside the measured
    // window; a retry that masks a stalled model must not read as a fast turn.
    let upstream_started = std::time::Instant::now();
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
            return error_json(
                request,
                502,
                &format!("连接{provider_name}失败：{last_err}"),
            );
        }
    };

    let status = upstream.status();
    if !status.is_success() {
        let detail = upstream.text().unwrap_or_default();
        let friendly = if is_local_text || is_local_vl {
            local_ollama_error_message(status.as_u16(), &detail)
        } else {
            format!("{provider_name} 错误 {}", status.as_u16())
        };
        let body = if is_local_text || is_local_vl {
            serde_json::json!({
                "error": friendly,
                "detail": detail.chars().take(500).collect::<String>(),
            })
        } else {
            // 远端原始错误不进入 WebView/console；普通 UI 只接收固定 provider + status。
            serde_json::json!({ "error": friendly })
        }
        .to_string();
        return respond_json(request, status.as_u16(), body);
    }

    if !stream {
        let text = upstream.text().unwrap_or_default();
        // Only refresh residency after the real request has drained. Starting a
        // second Ollama request while generation is still running competes for
        // the same local model and increases first-token latency.
        if is_local_text || is_local_vl {
            crate::local_text::touch_keep_alive(&model);
        }
        let provider = if is_local_text { "Ollama" } else { "DeepSeek" };
        return respond_json_with_text_provider(request, text, provider);
    }

    // 托管的本地实时语音服务需要逐 token 消费上游 SSE，才能在完整回复结束前把稳定句送入
    // TTS。共享 secret 由桌面进程在拉起 Python 时注入；普通 WebView 即便请求 stream=true
    // 仍继续走下方带 Content-Length 的缓冲兼容路径，避免重新引入 Windows WebView2 空回复。
    // Response 的长度留空，由 tiny_http 使用 chunked；不解析或记录正文。
    if passthrough_internal_sse {
        let provider = if is_local_text { "Ollama" } else { "DeepSeek" };
        let mut headers = cors_headers();
        headers.push(header("Content-Type", "text/event-stream; charset=utf-8"));
        headers.push(header("Cache-Control", "no-cache, no-transform"));
        headers.push(header("X-Kxyy-Text-Provider", provider));
        headers.push(header(
            "X-Kxyy-Thinking",
            if reasoning_enabled { "1" } else { "0" },
        ));
        if native_ollama_realtime {
            let resp = Response::new(
                StatusCode(200),
                headers,
                adapt_ollama_native_stream(upstream, upstream_started),
                None,
                None,
            );
            let _ = request.respond(resp);
        } else {
            let resp = Response::new(StatusCode(200), headers, upstream, None, None);
            let _ = request.respond(resp);
        }
        return;
    }

    // 流式：原先把上游 Response 当 Read 直接透传给 tiny_http 走 chunked（无 Content-Length）。
    // 但 Windows 的 WebView2 对 127.0.0.1 的「chunked 流式 fetch + getReader()」读取存在
    // 兼容问题：常常一个数据块都读不到，前端遂判定「回复为空」（且时好时坏，取决于时序）。
    // 改为：Rust 侧把整段上游 SSE 读完，带 Content-Length 一次性回给前端——WebView2 对
    // 「有明确长度的响应」读取稳定。代价是失去打字机逐字效果（整条回复一次性出现），
    // 但先保证「能出字」；后续若要恢复流式再针对 WebView2 专门处理。
    let mut body = match upstream.text() {
        Ok(t) => t,
        Err(e) => return error_json(request, 502, &format!("读取{provider_name}响应失败：{e}")),
    };
    // The buffered WebView path has fully consumed the model response here;
    // refresh Ollama residency only now, never concurrently with generation.
    if is_local_text || is_local_vl {
        crate::local_text::touch_keep_alive(&model);
    }
    // 本地模型安全网：若模型忽略 think: false 仍把所有内容放入 reasoning_content，
    // 则把 reasoning_content 复制到 content，避免前端收到空内容 → "回复为空"。
    if is_local_text && !thinking && !body.is_empty() {
        body = rewrite_reasoning_to_content(&body);
    }
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
    )
    // tiny_http 默认在 >=32KiB 时即使已知长度也改用 chunked；显式关闭该阈值，
    // 保证普通 WebView2 始终收到稳定的 Content-Length 缓冲响应。
    .with_chunked_threshold(usize::MAX);
    let _ = request.respond(resp);
}

/// 本地模型安全网：当 `think: false` 被 qwen3 等模型忽略时，
/// 它们会把所有输出塞进 `reasoning_content` 而非 `content`。
/// 此函数遍历 SSE 行，若某 chunk 的 `content` 为空但有 `reasoning_content`，
/// 则把 reasoning 复制到 content 并删除原 reasoning 字段，
/// 避免前端解析到空内容 → "回复为空"。
fn rewrite_reasoning_to_content(sse: &str) -> String {
    let mut out = String::with_capacity(sse.len());
    for line in sse.lines() {
        let payload = match line.strip_prefix("data: ") {
            Some(p) => p,
            None => {
                out.push_str(line);
                out.push('\n');
                continue;
            }
        };
        if payload == "[DONE]" {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        // 尝试解析 JSON 并重写
        match serde_json::from_str::<serde_json::Value>(payload) {
            Ok(mut v) => {
                if let Some(choices) = v.get_mut("choices").and_then(|c| c.as_array_mut()) {
                    for choice in choices {
                        if let Some(delta) = choice.get_mut("delta").and_then(|d| d.as_object_mut())
                        {
                            let content_empty = delta
                                .get("content")
                                .map(|v| v.is_null() || v.as_str().map_or(false, |s| s.is_empty()))
                                .unwrap_or(true);
                            if content_empty {
                                if let Some(rc) = delta.remove("reasoning_content") {
                                    delta.insert("content".to_string(), rc);
                                }
                                // 也清理 reasoning 短字段
                                delta.remove("reasoning");
                            }
                        }
                    }
                }
                out.push_str("data: ");
                if let Ok(json) = serde_json::to_string(&v) {
                    out.push_str(&json);
                } else {
                    out.push_str(payload);
                }
                out.push('\n');
            }
            Err(_) => {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    out
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

fn internal_secret_matches(provided: Option<&str>, expected: &str) -> bool {
    !expected.is_empty() && provided == Some(expected)
}

fn should_passthrough_internal_sse(
    stream: bool,
    force: Option<&str>,
    use_vision: bool,
    trusted: bool,
) -> bool {
    stream && force == Some("text") && !use_vision && trusted
}

fn should_use_native_ollama_realtime(
    is_local_text: bool,
    passthrough_internal_sse: bool,
    thinking: bool,
) -> bool {
    is_local_text && passthrough_internal_sse && !thinking
}

fn build_native_ollama_realtime_payload(
    model: &str,
    messages: serde_json::Value,
    max_tokens: i64,
    temperature: f64,
) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": true,
        "think": false,
        "keep_alive": crate::local_text::KEEP_ALIVE,
        "options": {
            "num_ctx": crate::local_text::LOCAL_NUM_CTX,
            "num_predict": max_tokens,
            "temperature": temperature,
        },
    })
}

struct OllamaNativeSse<R: BufRead> {
    upstream: R,
    pending: Vec<u8>,
    offset: usize,
    finished: bool,
    // Wall clock from just before the upstream request was sent. Ollama's own
    // prompt_eval_duration excludes time spent queued behind another request on
    // the shared model, so only a proxy-side clock can expose that wait.
    started: std::time::Instant,
    first_token_ms: Option<u64>,
}

const TINY_HTTP_STREAM_FLUSH_BYTES: usize = 8193;

fn pad_local_sse_flush_boundary(bytes: &mut Vec<u8>) {
    if bytes.len() >= TINY_HTTP_STREAM_FLUSH_BYTES {
        return;
    }
    let spaces = TINY_HTTP_STREAM_FLUSH_BYTES - bytes.len() - 3;
    bytes.push(b':');
    bytes.extend(std::iter::repeat_n(b' ', spaces));
    bytes.extend_from_slice(b"\n\n");
}

fn adapt_ollama_native_stream<R: Read>(
    reader: R,
    started: std::time::Instant,
) -> OllamaNativeSse<BufReader<R>> {
    OllamaNativeSse {
        upstream: BufReader::new(reader),
        pending: Vec::new(),
        offset: 0,
        finished: false,
        started,
        first_token_ms: None,
    }
}

impl<R: BufRead> OllamaNativeSse<R> {
    fn fill_pending(&mut self) -> std::io::Result<()> {
        while self.pending.is_empty() && !self.finished {
            let mut line = String::new();
            if self.upstream.read_line(&mut line)? == 0 {
                self.pending = b"data: [DONE]\n\n".to_vec();
                self.finished = true;
                break;
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let value: serde_json::Value = serde_json::from_str(trimmed).map_err(|_| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Ollama returned invalid NDJSON",
                )
            })?;
            if value.get("error").is_some() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "Ollama stream failed",
                ));
            }

            let content = value
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(|content| content.as_str())
                .unwrap_or_default();
            if !content.is_empty() {
                if self.first_token_ms.is_none() {
                    self.first_token_ms = Some(self.started.elapsed().as_millis() as u64);
                }
                let chunk = serde_json::json!({
                    "choices": [{
                        "delta": {"content": content},
                        "finish_reason": serde_json::Value::Null,
                    }]
                });
                self.pending
                    .extend_from_slice(format!("data: {chunk}\n\n").as_bytes());
                pad_local_sse_flush_boundary(&mut self.pending);
            } else if value
                .get("message")
                .and_then(|message| message.get("thinking"))
                .and_then(|thinking| thinking.as_str())
                .is_some_and(|thinking| !thinking.is_empty())
            {
                // Keep cancellation observable without forwarding hidden reasoning.
                self.pending.extend_from_slice(b": kxyy-progress\n\n");
                pad_local_sse_flush_boundary(&mut self.pending);
            }

            if value.get("done").and_then(|done| done.as_bool()) == Some(true) {
                let prompt = value
                    .get("prompt_eval_count")
                    .and_then(|count| count.as_u64())
                    .unwrap_or(0);
                let completion = value
                    .get("eval_count")
                    .and_then(|count| count.as_u64())
                    .unwrap_or(0);
                let finish_reason =
                    match value.get("done_reason").and_then(|reason| reason.as_str()) {
                        Some("length") => "length",
                        _ => "stop",
                    };
                // Prefill/decode durations are the only signal that distinguishes a
                // prefix-KV-cache hit from a full recompute; token counts alone cannot.
                // Nanoseconds are provider-native; convert once here so consumers stay
                // unit-agnostic. Both are timings, never text.
                let prompt_ms = value
                    .get("prompt_eval_duration")
                    .and_then(|value| value.as_u64())
                    .map(|nanos| nanos / 1_000_000);
                let completion_ms = value
                    .get("eval_duration")
                    .and_then(|value| value.as_u64())
                    .map(|nanos| nanos / 1_000_000);
                // Model swap-in cost, reported separately from prefill by Ollama.
                let load_ms = value
                    .get("load_duration")
                    .and_then(|value| value.as_u64())
                    .map(|nanos| nanos / 1_000_000);
                let mut usage = serde_json::json!({
                    "prompt_tokens": prompt,
                    "completion_tokens": completion,
                    "total_tokens": prompt.saturating_add(completion),
                });
                if let Some(ms) = prompt_ms {
                    usage["prompt_eval_ms"] = serde_json::json!(ms);
                }
                if let Some(ms) = completion_ms {
                    usage["eval_ms"] = serde_json::json!(ms);
                }
                if let Some(ms) = load_ms {
                    usage["load_ms"] = serde_json::json!(ms);
                }
                // Proxy-side wall clock to the first visible token. Subtracting the
                // provider's own load+prefill leaves the time this request spent
                // waiting for the shared model, which Ollama never reports.
                if let Some(ms) = self.first_token_ms {
                    usage["first_token_wall_ms"] = serde_json::json!(ms);
                }
                let final_chunk = serde_json::json!({
                    "choices": [{"delta": {}, "finish_reason": finish_reason}],
                    "usage": usage,
                });
                self.pending.extend_from_slice(
                    format!("data: {final_chunk}\n\ndata: [DONE]\n\n").as_bytes(),
                );
                self.finished = true;
            }
        }
        Ok(())
    }
}

impl<R: BufRead> Read for OllamaNativeSse<R> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        if self.offset >= self.pending.len() {
            self.pending.clear();
            self.offset = 0;
            self.fill_pending()?;
        }
        if self.pending.is_empty() {
            return Ok(0);
        }
        let count = output.len().min(self.pending.len() - self.offset);
        output[..count].copy_from_slice(&self.pending[self.offset..self.offset + count]);
        self.offset += count;
        Ok(count)
    }
}

fn web_observation_status(enabled: bool, provider: &str, has_key: bool) -> &'static str {
    if !enabled {
        "disabled"
    } else if !provider.trim().eq_ignore_ascii_case("tavily") || !has_key {
        "unconfigured"
    } else {
        "ready"
    }
}

fn web_observation_json(status: &str, provider: &str, items: serde_json::Value) -> String {
    serde_json::json!({
        "status": status,
        "provider": provider,
        "items": items,
    })
    .to_string()
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn normalize_web_text(value: &str, max_chars: usize) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(compact.trim(), max_chars)
}

fn safe_web_source_url(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    if url.as_str().chars().count() > 512 {
        return None;
    }
    Some(url.into())
}

fn normalize_tavily_items(payload: &serde_json::Value, fetched_at: &str) -> serde_json::Value {
    let mut items = Vec::new();
    for result in payload
        .get("results")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .take(WEB_RESULT_MAX_ITEMS)
    {
        let title = result
            .get("title")
            .and_then(|value| value.as_str())
            .map(|value| normalize_web_text(value, 120))
            .unwrap_or_default();
        let text = result
            .get("content")
            .and_then(|value| value.as_str())
            .map(|value| normalize_web_text(value, WEB_RESULT_TEXT_MAX_CHARS))
            .unwrap_or_default();
        let source_url = result
            .get("url")
            .and_then(|value| value.as_str())
            .and_then(safe_web_source_url);
        if title.is_empty() || text.is_empty() || source_url.is_none() {
            continue;
        }
        items.push(serde_json::json!({
            "title": title,
            "sourceUrl": source_url.unwrap_or_default(),
            "fetchedAt": fetched_at,
            "text": text,
        }));
    }
    serde_json::Value::Array(items)
}

fn proxy_web_observations(
    app: &AppHandle,
    client: &reqwest::blocking::Client,
    mut request: tiny_http::Request,
) {
    let cfg = crate::ai_config(app);
    let status = web_observation_status(
        cfg.web_grounding_enabled,
        &cfg.web_grounding_provider,
        !cfg.tavily_api_key.is_empty(),
    );
    if status != "ready" {
        return respond_json(
            request,
            200,
            web_observation_json(status, "none", serde_json::json!([])),
        );
    }

    // 回环端点仍按不可信输入处理，限制请求体，且绝不接受任意上游 URL。
    let mut raw = String::new();
    if request
        .as_reader()
        .take(4097)
        .read_to_string(&mut raw)
        .is_err()
        || raw.len() > 4096
    {
        return error_json(request, 400, "网页观察请求过大");
    }
    let body: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => return error_json(request, 400, "网页观察请求不是合法 JSON"),
    };
    if body.get("provider").and_then(|value| value.as_str()) != Some("tavily") {
        return error_json(request, 400, "网页观察服务不匹配");
    }
    let query = body
        .get("query")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .unwrap_or("");
    if query.is_empty() {
        return error_json(request, 400, "网页观察查询不能为空");
    }
    let query = truncate_chars(query, WEB_QUERY_MAX_CHARS);
    let upstream = client
        .post(TAVILY_SEARCH_URL)
        .timeout(std::time::Duration::from_secs(4))
        .bearer_auth(&cfg.tavily_api_key)
        .json(&serde_json::json!({
            "query": query,
            "topic": "general",
            "search_depth": "basic",
            "max_results": WEB_RESULT_MAX_ITEMS,
            "include_answer": false,
            "include_raw_content": false,
            "include_images": false,
        }))
        .send();
    let response = match upstream {
        Ok(response) => response,
        Err(_) => {
            return respond_json(
                request,
                200,
                web_observation_json("provider_error", "tavily", serde_json::json!([])),
            )
        }
    };
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|len| len > WEB_RESPONSE_MAX_BYTES)
    {
        return respond_json(
            request,
            200,
            web_observation_json("provider_error", "tavily", serde_json::json!([])),
        );
    }
    let mut response_body = String::new();
    if response
        .take(WEB_RESPONSE_MAX_BYTES + 1)
        .read_to_string(&mut response_body)
        .is_err()
        || response_body.len() as u64 > WEB_RESPONSE_MAX_BYTES
    {
        return respond_json(
            request,
            200,
            web_observation_json("provider_error", "tavily", serde_json::json!([])),
        );
    }
    let payload: serde_json::Value = match serde_json::from_str(&response_body) {
        Ok(value) => value,
        Err(_) => {
            return respond_json(
                request,
                200,
                web_observation_json("provider_error", "tavily", serde_json::json!([])),
            )
        }
    };
    let fetched_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let items = normalize_tavily_items(&payload, &fetched_at);
    respond_json(request, 200, web_observation_json("ok", "tavily", items));
}

#[cfg(test)]
mod tests {
    use super::{
        adapt_ollama_native_stream, apply_deepseek_generation_options,
        apply_selected_deepseek_generation_options, build_native_ollama_realtime_payload, header,
        internal_secret_matches, normalize_deepseek_model, normalize_tavily_items,
        memory_completion_content, online_vision_route, req_header, safe_web_source_url,
        should_passthrough_internal_sse,
        should_use_native_ollama_realtime, web_observation_status, DEEPSEEK_FLASH_MODEL,
        DEEPSEEK_PRO_MODEL, DEEPSEEK_VISION_MODEL, QWEN_VL_BASE_URL, QWEN_VL_MODEL, TEXT_BASE_URL,
    };
    use std::io::{Cursor, Read};
    use tiny_http::{HTTPVersion, Response, StatusCode, TestRequest};

    #[test]
    fn internal_stream_secret_requires_an_exact_non_empty_match() {
        assert!(internal_secret_matches(
            Some("managed-secret"),
            "managed-secret"
        ));
        assert!(!internal_secret_matches(Some("wrong"), "managed-secret"));
        assert!(!internal_secret_matches(None, "managed-secret"));
        assert!(!internal_secret_matches(Some(""), ""));
    }

    #[test]
    fn internal_sse_gate_requires_every_trusted_text_stream_condition() {
        assert!(should_passthrough_internal_sse(
            true,
            Some("text"),
            false,
            true
        ));
        assert!(!should_passthrough_internal_sse(
            false,
            Some("text"),
            false,
            true
        ));
        assert!(!should_passthrough_internal_sse(true, None, false, true));
        assert!(!should_passthrough_internal_sse(
            true,
            Some("vl"),
            true,
            true
        ));
        assert!(!should_passthrough_internal_sse(
            true,
            Some("text"),
            false,
            false
        ));
    }

    #[test]
    fn native_ollama_is_limited_to_trusted_non_thinking_realtime_text() {
        assert!(should_use_native_ollama_realtime(true, true, false));
        assert!(!should_use_native_ollama_realtime(false, true, false));
        assert!(!should_use_native_ollama_realtime(true, false, false));
        assert!(!should_use_native_ollama_realtime(true, true, true));
    }

    #[test]
    fn native_ollama_realtime_payload_disables_thinking_and_bounds_generation() {
        let messages = serde_json::json!([
            {"role": "system", "content": "persona"},
            {"role": "user", "content": "hello"}
        ]);
        let payload =
            build_native_ollama_realtime_payload("ornith-1.5:9b", messages.clone(), 512, 0.7);

        assert_eq!(payload["model"], "ornith-1.5:9b");
        assert_eq!(payload["messages"], messages);
        assert_eq!(payload["stream"], true);
        assert_eq!(payload["think"], false);
        assert_eq!(payload["keep_alive"], crate::local_text::KEEP_ALIVE);
        assert_eq!(
            payload["options"]["num_ctx"],
            crate::local_text::LOCAL_NUM_CTX
        );
        assert_eq!(payload["options"]["num_predict"], 512);
        assert_eq!(payload["options"]["temperature"], 0.7);
        assert!(payload.get("reasoning_effort").is_none());
    }

    #[test]
    fn native_ollama_ndjson_adapts_to_content_only_openai_sse() {
        let native = concat!(
            "{\"message\":{\"role\":\"assistant\",\"thinking\":\"hidden\",\"content\":\"\"},\"done\":false}\n",
            "{\"message\":{\"role\":\"assistant\",\"content\":\"你好\"},\"done\":false}\n",
            "{\"message\":{\"role\":\"assistant\",\"content\":\"呀\"},\"done\":false}\n",
            "{\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,\"done_reason\":\"stop\",\"prompt_eval_count\":41,\"eval_count\":3}\n"
        );
        let mut adapted = adapt_ollama_native_stream(Cursor::new(native.as_bytes()), std::time::Instant::now());
        let mut sse = String::new();
        adapted.read_to_string(&mut sse).unwrap();

        assert!(!sse.contains("hidden"));
        assert!(!sse.contains("thinking"));
        assert!(sse.contains("\"content\":\"你好\""));
        assert!(sse.contains("\"content\":\"呀\""));
        assert!(sse.contains("\"finish_reason\":\"stop\""));
        assert!(sse.contains("\"prompt_tokens\":41"));
        assert!(sse.contains("\"completion_tokens\":3"));
        assert!(sse.contains("\"total_tokens\":44"));
        assert!(sse.ends_with("data: [DONE]\n\n"));
    }

    #[test]
    fn memory_completion_reads_native_and_openai_response_shapes() {
        let native = serde_json::json!({
            "message": {"role": "assistant", "content": "{\"facts\":[]}"},
            "done": true
        });
        assert_eq!(
            memory_completion_content(&native).as_deref(),
            Some("{\"facts\":[]}")
        );

        let openai = serde_json::json!({
            "choices": [{"message": {"role": "assistant", "content": "{\"facts\":[1]}"}}]
        });
        assert_eq!(
            memory_completion_content(&openai).as_deref(),
            Some("{\"facts\":[1]}")
        );

        // Blank and shapeless replies must not pass as a successful extraction.
        let blank = serde_json::json!({"message": {"content": "   "}});
        assert!(memory_completion_content(&blank).is_none());
        assert!(memory_completion_content(&serde_json::json!({})).is_none());
    }

    #[test]
    fn native_ollama_done_frame_forwards_prefill_and_decode_timings() {
        let native = concat!(
            "{\"message\":{\"role\":\"assistant\",\"content\":\"嗯\"},\"done\":false}\n",
            "{\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,",
            "\"done_reason\":\"stop\",\"prompt_eval_count\":1010,",
            "\"prompt_eval_duration\":2820000000,\"eval_count\":47,",
            "\"eval_duration\":1420000000}\n"
        );
        let mut adapted = adapt_ollama_native_stream(Cursor::new(native.as_bytes()), std::time::Instant::now());
        let mut sse = String::new();
        adapted.read_to_string(&mut sse).unwrap();

        // Nanoseconds are converted to milliseconds exactly once, at this boundary.
        assert!(sse.contains("\"prompt_eval_ms\":2820"));
        assert!(sse.contains("\"eval_ms\":1420"));
        assert!(sse.contains("\"prompt_tokens\":1010"));
    }

    #[test]
    fn native_ollama_done_frame_omits_timings_when_provider_reports_none() {
        let native = concat!(
            "{\"message\":{\"role\":\"assistant\",\"content\":\"嗯\"},\"done\":false}\n",
            "{\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,",
            "\"prompt_eval_count\":41,\"eval_count\":3}\n"
        );
        let mut adapted = adapt_ollama_native_stream(Cursor::new(native.as_bytes()), std::time::Instant::now());
        let mut sse = String::new();
        adapted.read_to_string(&mut sse).unwrap();

        assert!(!sse.contains("prompt_eval_ms"));
        assert!(!sse.contains("eval_ms"));
        assert!(sse.contains("\"prompt_tokens\":41"));
    }

    #[test]
    fn native_ollama_first_delta_crosses_tiny_http_flush_boundary() {
        let native = concat!(
            "{\"message\":{\"role\":\"assistant\",\"content\":\"第一块\"},\"done\":false}\n",
            "{\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,\"eval_count\":2}\n"
        );
        let mut adapted = adapt_ollama_native_stream(Cursor::new(native.as_bytes()), std::time::Instant::now());
        let mut output = vec![0_u8; 9000];
        let first_len = adapted.read(&mut output).unwrap();
        let first = String::from_utf8_lossy(&output[..first_len]);

        assert!(first_len > 8192);
        assert!(first.contains("\"content\":\"第一块\""));
        assert!(!first.contains("[DONE]"));
    }

    #[test]
    fn web_observations_fail_closed_without_a_configured_adapter() {
        assert_eq!(web_observation_status(false, "none", false), "disabled");
        assert_eq!(web_observation_status(true, "", true), "unconfigured");
        assert_eq!(web_observation_status(true, "none", true), "unconfigured");
        assert_eq!(
            web_observation_status(true, "future-provider", true),
            "unconfigured"
        );
        assert_eq!(
            web_observation_status(true, "tavily", false),
            "unconfigured"
        );
        assert_eq!(web_observation_status(true, "tavily", true), "ready");
    }

    #[test]
    fn tavily_results_are_bounded_and_drop_unsafe_urls() {
        let payload = serde_json::json!({
            "results": [
                {"title": "  Example   News ", "url": "https://example.com/latest", "content": "fresh   summary"},
                {"title": "Local", "url": "file:///etc/passwd", "content": "must drop"},
                {"title": "Credentials", "url": "https://user:pass@example.com/", "content": "must drop"}
            ]
        });
        let items = normalize_tavily_items(&payload, "2026-07-30T12:00:00.000Z");
        let items = items.as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["title"], "Example News");
        assert_eq!(items[0]["text"], "fresh summary");
        assert_eq!(items[0]["sourceUrl"], "https://example.com/latest");
        assert!(safe_web_source_url("http://example.com/x").is_some());
        assert!(safe_web_source_url("data:text/plain,no").is_none());
    }

    #[test]
    fn deepseek_models_are_allowlisted_and_legacy_values_migrate() {
        assert_eq!(
            normalize_deepseek_model("deepseek-v4-flash"),
            DEEPSEEK_FLASH_MODEL
        );
        assert_eq!(
            normalize_deepseek_model("deepseek-v4-pro"),
            DEEPSEEK_PRO_MODEL
        );
        assert_eq!(
            normalize_deepseek_model("deepseek-chat"),
            DEEPSEEK_FLASH_MODEL
        );
        assert_eq!(
            normalize_deepseek_model("deepseek-reasoner"),
            DEEPSEEK_PRO_MODEL
        );
        assert_eq!(
            normalize_deepseek_model("deepseek-v4-flash-vision-exp"),
            DEEPSEEK_VISION_MODEL
        );
        assert_eq!(normalize_deepseek_model(""), DEEPSEEK_FLASH_MODEL);
        assert_eq!(normalize_deepseek_model("qwen3:8b"), DEEPSEEK_FLASH_MODEL);
        assert_eq!(normalize_deepseek_model("unreviewed"), DEEPSEEK_FLASH_MODEL);
    }

    #[test]
    fn online_vision_models_are_fixed_and_unknown_providers_fall_back_to_qwen() {
        assert_eq!(
            online_vision_route("deepseek"),
            (TEXT_BASE_URL, DEEPSEEK_VISION_MODEL, "DeepSeek 看图")
        );
        assert_eq!(
            online_vision_route("qwen"),
            (QWEN_VL_BASE_URL, QWEN_VL_MODEL, "通义千问")
        );
        assert_eq!(online_vision_route("unknown"), online_vision_route("qwen"));
    }

    #[test]
    fn deepseek_thinking_uses_current_fixed_shape_and_omits_temperature() {
        let mut enabled = serde_json::json!({});
        apply_deepseek_generation_options(&mut enabled, true, 0.8);
        assert_eq!(enabled["thinking"]["type"], "enabled");
        assert!(enabled.get("temperature").is_none());

        let mut disabled = serde_json::json!({});
        apply_deepseek_generation_options(&mut disabled, false, 0.7);
        assert_eq!(disabled["thinking"]["type"], "disabled");
        assert_eq!(disabled["temperature"], 0.7);

        let mut vision = serde_json::json!({});
        apply_selected_deepseek_generation_options(&mut vision, DEEPSEEK_VISION_MODEL, true, 0.2);
        assert!(vision.get("thinking").is_none());
        assert_eq!(vision["temperature"], 0.2);
    }

    #[test]
    fn internal_secret_header_lookup_is_case_insensitive() {
        let request = TestRequest::new()
            .with_header(header("x-kXyY-iNtErNaL-sEcReT", "managed-secret"))
            .into();
        assert_eq!(
            req_header(&request, "X-Kxyy-Internal-Secret"),
            Some("managed-secret")
        );
    }

    fn raw_headers(response: Response<Cursor<Vec<u8>>>) -> String {
        let mut output = Vec::new();
        response
            .raw_print(&mut output, HTTPVersion(1, 1), &[], true, None)
            .expect("response should serialize");
        String::from_utf8(output).expect("headers should be utf-8")
    }

    #[test]
    fn internal_stream_is_chunked_but_large_webview_buffer_keeps_content_length() {
        let body = vec![0_u8; 40 * 1024];
        let streamed = raw_headers(Response::new(
            StatusCode(200),
            vec![],
            Cursor::new(body.clone()),
            None,
            None,
        ));
        assert!(streamed.contains("Transfer-Encoding: chunked\r\n"));
        assert!(!streamed.contains("Content-Length:"));

        let len = body.len();
        let buffered = raw_headers(
            Response::new(StatusCode(200), vec![], Cursor::new(body), Some(len), None)
                .with_chunked_threshold(usize::MAX),
        );
        assert!(buffered.contains(&format!("Content-Length: {len}\r\n")));
        assert!(!buffered.contains("Transfer-Encoding:"));
    }
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

/// 根据 TTS 文本长度动态计算超时时间。
/// IndexTTS-2 在本机 GPU 上的实测速度约为 13~15s/汉字；
/// 最小 5 分钟，按 15s/字估算。
fn tts_timeout_from_text(body: &str) -> std::time::Duration {
    let char_count: usize = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("text")
                .and_then(|t| t.as_str())
                .map(|s| s.chars().count())
        })
        .unwrap_or(0);
    let seconds = (char_count as u64).saturating_mul(15).max(300);
    std::time::Duration::from_secs(seconds)
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
    let data: serde_json::Value = resp.json().map_err(|e| {
        (
            None,
            format!("火山返回非 JSON（HTTP {}）：{e}", status.as_u16()),
        )
    })?;

    let code = data.get("code").and_then(|v| v.as_i64());
    let audio_b64 = data.get("data").and_then(|v| v.as_str());
    if code != Some(3000) || audio_b64.is_none() {
        let msg = data
            .get("message")
            .or_else(|| data.get("Message"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        return Err((
            code,
            format!("code={} {msg}", code.unwrap_or(0))
                .trim()
                .to_string(),
        ));
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
            headers.push(header("X-Tts-Usage-Characters", &u.characters.to_string()));
            headers.push(header("X-Tts-Usage-Provider", u.provider));
        }
    }
    let len = bytes.len();
    let resp = Response::new(
        StatusCode(200),
        headers,
        std::io::Cursor::new(bytes),
        Some(len),
        None,
    );
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
        .timeout(tts_timeout_from_text(body_raw))
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
    let body_voice = body
        .get("voice")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let voice = if body_voice.starts_with("S_") {
        body_voice.to_string()
    } else {
        cfg.tts_voice.trim().to_string()
    };
    if voice.is_empty() {
        return error_json(
            request,
            400,
            "未配置朗读音色（voice_id），请在设置里填写 S_ 开头的火山音色",
        );
    }
    if !voice.starts_with("S_") {
        return error_json(request, 400, "火山后端需 S_ 开头的复刻音色");
    }

    let text = body
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
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
        match volc_tts_once(
            client,
            &volc_key,
            cluster,
            &voice,
            &text_trunc,
            speed,
            pitch,
            emotion,
        ) {
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
        if let Ok(ok) = volc_tts_once(
            client,
            &volc_key,
            cluster,
            &voice,
            &text_trunc,
            speed,
            pitch,
            "",
        ) {
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
