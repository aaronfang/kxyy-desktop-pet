//! 人设语料：编译期嵌入 XOR 密文作为默认，运行时支持从 persona-cards/ 动态加载覆盖。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use base64::Engine as _;

const ENCRYPTED: &[u8] = include_bytes!("../assets/persona-assets.enc");
const XOR_KEY: &[u8] = b"kxyy-prompt-v1";

/// 运行时动态加载的人格卡 JSON（覆盖编译期嵌入的默认值）。
static DYNAMIC_CARD: Mutex<Option<String>> = Mutex::new(None);

/// 定位 persona-cards 目录。
/// 优先用项目根（dev 模式，可直接编辑），
/// 其次回退到 resource_dir（打包模式下资源被复制到这里）。
pub fn find_persona_cards_dir(resource_dir: &PathBuf) -> Option<PathBuf> {
    // dev 模式优先：CARGO_MANIFEST_DIR = src-tauri/，上一级 = 项目根
    let manifest_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("persona-cards"));
    if let Some(ref dev) = manifest_root {
        if dev.is_dir() {
            return Some(dev.clone());
        }
    }
    // 打包模式兜底：resource_dir 下的 persona-cards
    let cards_dir = resource_dir.join("persona-cards");
    if cards_dir.is_dir() {
        return Some(cards_dir);
    }
    None
}

// ============ 注册表（registry）相关 ============

/// 注册表中单条记录的前端表示。
#[derive(serde::Serialize, Clone)]
pub struct CardMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub source: String,
    pub is_local: bool,
}



/// 列出所有本地已安装的人设卡（不含 kxyy-yuanyuan 默认卡）。
pub fn list_all_cards(resource_dir: &PathBuf) -> Result<Vec<CardMeta>, String> {
    let local_ids = list_cards(resource_dir).unwrap_or_default();

    let mut result = Vec::new();

    for lid in &local_ids {
        if lid == "kxyy-yuanyuan" {
            continue; // 等同于默认，不重复列出
        }
        let display_name = get_card_display_name(lid, resource_dir).unwrap_or_else(|_| lid.clone());
        let desc = read_card_description(lid, resource_dir).unwrap_or_default();
        result.push(CardMeta {
            id: lid.clone(),
            name: display_name,
            description: desc,
            category: String::new(),
            source: String::new(),
            is_local: true,
        });
    }

    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

/// 从 persona-card.json 读取 description 字段。
fn read_card_description(card_id: &str, resource_dir: &PathBuf) -> Result<String, String> {
    let cards_dir = find_persona_cards_dir(resource_dir).ok_or("未找到 persona-cards 目录")?;
    let card_path = cards_dir.join(card_id).join("persona-card.json");
    let raw = fs::read_to_string(&card_path)
        .map_err(|e| format!("无法读取人格卡 {card_id}: {e}"))?;
    let card: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("JSON 解析失败: {e}"))?;
    Ok(card
        .get("meta")
        .and_then(|v| v.get("description"))
        .or_else(|| card.get("identity").and_then(|v| v.get("description")))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

// ============ 卡片管理 ============

/// 删除指定本地人格卡。
pub fn delete_card(card_id: &str, resource_dir: &PathBuf) -> Result<(), String> {
    if card_id.is_empty() || card_id == "kxyy-yuanyuan" {
        return Err("不能删除默认人设卡".into());
    }
    let cards_dir = find_persona_cards_dir(resource_dir).ok_or("未找到 persona-cards 目录")?;
    let card_dir = cards_dir.join(card_id);
    if !card_dir.is_dir() {
        return Err(format!("卡片不存在: {card_id}"));
    }
    fs::remove_dir_all(&card_dir)
        .map_err(|e| format!("删除失败: {e}"))?;
    // 如果当前活跃卡就是被删除的卡，重置为默认
    if let Ok(mut guard) = DYNAMIC_CARD.lock() {
        if let Some(ref card_json) = *guard {
            if card_json.contains(&format!("\"_dynamic_card_id\":\"{card_id}\"")) {
                *guard = None;
            }
        }
    }
    Ok(())
}

/// 导出指定人格卡的 persona-card.json 内容（字符串）。
pub fn export_card_json(card_id: &str, resource_dir: &PathBuf) -> Result<String, String> {
    let cards_dir = find_persona_cards_dir(resource_dir).ok_or("未找到 persona-cards 目录")?;
    let card_path = cards_dir.join(card_id).join("persona-card.json");
    fs::read_to_string(&card_path)
        .map_err(|e| format!("读取失败: {e}"))
}

/// 导入人格卡：将 JSON 字符串写入 persona-cards/<card_id>/persona-card.json。
pub fn import_card_json(card_id: &str, json_content: &str, resource_dir: &PathBuf) -> Result<String, String> {
    // 基础校验：JSON 合法且包含必要字段
    let card: serde_json::Value = serde_json::from_str(json_content)
        .map_err(|e| format!("JSON 格式无效: {e}"))?;
    let has_identity = card.get("identity").is_some();
    let has_system = card.get("system_prompt").is_some();
    if !has_identity && !has_system {
        return Err("JSON 缺少 identity 或 system_prompt 字段".into());
    }

    let cards_dir = find_persona_cards_dir(resource_dir).ok_or("未找到 persona-cards 目录")?;
    let card_dir = cards_dir.join(card_id);
    fs::create_dir_all(&card_dir)
        .map_err(|e| format!("创建目录失败: {e}"))?;
    fs::write(card_dir.join("persona-card.json"), json_content)
        .map_err(|e| format!("写入失败: {e}"))?;

    // 返回显示名
    let display_name = card
        .get("identity").and_then(|v| v.get("name"))
        .or_else(|| card.get("meta").and_then(|v| v.get("name")))
        .and_then(|v| v.as_str())
        .unwrap_or(card_id);
    Ok(display_name.to_string())
}

fn xor_decrypt(data: &[u8]) -> Vec<u8> {
    data.iter()
        .enumerate()
        .map(|(i, b)| b ^ XOR_KEY[i % XOR_KEY.len()])
        .collect()
}

/// 解密并返回 JSON 字符串（优先动态加载，其次编译期嵌入）。
pub fn decrypted_json() -> Result<String, String> {
    if let Ok(guard) = DYNAMIC_CARD.lock() {
        if let Some(ref card) = *guard {
            return Ok(card.clone());
        }
    }
    let plain = xor_decrypt(ENCRYPTED);
    String::from_utf8(plain).map_err(|e| format!("语料解密失败: {e}"))
}

/// 从 persona-cards/<card_id>/persona-card.json 加载人格卡并转为 assets 格式。
/// 转换规则：system_prompt→systemPrompt, few_shot→fewShot, 保留 lore/corrections/personality_dimensions。
pub fn load_card_from_file(card_id: &str, resource_dir: &PathBuf) -> Result<(), String> {
    let cards_dir = find_persona_cards_dir(resource_dir).ok_or("未找到 persona-cards 目录")?;
    let card_path = cards_dir.join(card_id).join("persona-card.json");

    let raw = fs::read_to_string(&card_path)
        .map_err(|e| format!("无法读取人格卡 {}: {e}", card_path.display()))?;

    let card: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("人格卡 JSON 解析失败: {e}"))?;

    // 用户画像与卡绑定：每张卡自带 user_profile，未定义则留空。
    let user_profile = card.get("user_profile").cloned().unwrap_or(serde_json::json!({}));

    // 提取卡名（优先 identity.name，其次 meta.name，最后用 card_id）
    let display_name = card
        .get("identity")
        .and_then(|v| v.get("name"))
        .or_else(|| card.get("meta").and_then(|v| v.get("name")))
        .and_then(|v| v.as_str())
        .unwrap_or(card_id);

    // 卡可附带头像 data-url（可选）。
    let avatar = card.get("avatar").and_then(|v| v.as_str()).unwrap_or("");

    // 转为前端 loadAssets() 期望的格式
    let assets = serde_json::json!({
        "systemPrompt": card.get("system_prompt").and_then(|v| v.as_str()).unwrap_or(""),
        "fewShot": card.get("few_shot").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
        "userProfile": user_profile,
        "lore": card.get("lore").unwrap_or(&serde_json::json!({})),
        "corrections": card.get("corrections").unwrap_or(&serde_json::json!({})),
        "personality_dimensions": card.get("personality_dimensions").unwrap_or(&serde_json::Value::Null),
        "_dynamic_card_id": card_id,
        "displayName": display_name,
        "avatar": avatar,
        "tts": card.get("tts").cloned().unwrap_or(serde_json::Value::Null),
    });

    let json = serde_json::to_string(&assets)
        .map_err(|e| format!("序列化 assets 失败: {e}"))?;

    if let Ok(mut guard) = DYNAMIC_CARD.lock() {
        *guard = Some(json);
    }
    Ok(())
}  

/// 列出 persona-cards/ 下所有含 persona-card.json 的子目录名（card_id）。
pub fn list_cards(resource_dir: &PathBuf) -> Result<Vec<String>, String> {
    let cards_dir = match find_persona_cards_dir(resource_dir) {
        Some(d) => d,
        None => return Ok(vec![]),
    };
    let mut cards = Vec::new();
    let entries = fs::read_dir(&cards_dir)
        .map_err(|e| format!("无法读取 persona-cards 目录: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("目录遍历错误: {e}"))?;
        let path = entry.path();
        if path.is_dir() {
            let card_file = path.join("persona-card.json");
            if card_file.exists() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    cards.push(name.to_string());
                }
            }
        }
    }
    cards.sort();
    Ok(cards)
}

/// 清除动态加载的卡片，回退到编译期嵌入的默认值。
pub fn reset_to_default() {
    if let Ok(mut guard) = DYNAMIC_CARD.lock() {
        *guard = None;
    }
}

/// 读取 persona-cards/<card_id>/persona-card.json 中的 avatar 字段。
/// 如果 avatar 是文件名（无协议头），则从卡目录读取文件并转为 data: URL；
/// 如果已经是 data: URL 则直接返回；空串则返回空。
pub fn get_card_avatar(card_id: &str, resource_dir: &PathBuf) -> Result<String, String> {
    let cards_dir = find_persona_cards_dir(resource_dir).ok_or("未找到 persona-cards 目录")?;
    let card_path = cards_dir.join(card_id).join("persona-card.json");
    let raw = fs::read_to_string(&card_path)
        .map_err(|e| format!("无法读取人格卡 {card_id}: {e}"))?;
    let card: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("人格卡 JSON 解析失败: {e}"))?;
    let avatar_raw = card.get("avatar").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if avatar_raw.is_empty() {
        return Ok(String::new());
    }
    // 如果已经是 data: URL，直接返回
    if avatar_raw.starts_with("data:") {
        return Ok(avatar_raw);
    }
    // 尝试作为卡目录下的文件名读取并转 data: URL
    let img_path = cards_dir.join(card_id).join(&avatar_raw);
    match fs::read(&img_path) {
        Ok(bytes) => {
            let mime = mime_guess::from_path(&img_path).first_or_octet_stream();
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            Ok(format!("data:{};base64,{}", mime, b64))
        }
        Err(_) => Ok(avatar_raw), // 文件不存在，返回原始值（前端自己处理）
    }
}

/// 读取 persona-cards/<card_id>/persona-card.json 中的 identity.name 字段。
pub fn get_card_display_name(card_id: &str, resource_dir: &PathBuf) -> Result<String, String> {
    let cards_dir = find_persona_cards_dir(resource_dir).ok_or("未找到 persona-cards 目录")?;
    let card_path = cards_dir.join(card_id).join("persona-card.json");
    let raw = fs::read_to_string(&card_path)
        .map_err(|e| format!("无法读取人格卡 {card_id}: {e}"))?;
    let card: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("人格卡 JSON 解析失败: {e}"))?;
    Ok(card
        .get("identity")
        .and_then(|v| v.get("name"))
        .or_else(|| card.get("meta").and_then(|v| v.get("name")))
        .and_then(|v| v.as_str())
        .unwrap_or(card_id)
        .to_string())
}

