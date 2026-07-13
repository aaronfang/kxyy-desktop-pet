//! 从 GitHub raw 拉取 persona-distill skill 仓库内容，构建 persona-card.json。
//!
//! 流程：
//! 1. 从 _registry.json 根据 card_id 找到 source URL
//! 2. 解析 GitHub owner/repo
//! 3. 拉取 SKILL.md、prompts/manifest.json → prompts/*.md、package.json
//! 4. 组装 persona-card.json
//! 5. 写入 persona-cards/<card_id>/

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use reqwest::blocking::Client;

// ── 表格型结构 ──────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct ImportResult {
    pub card_id: String,
    pub name: String,
    pub system_prompt_len: usize,
    pub prompt_files: usize,
    pub message: String,
}

#[derive(serde::Deserialize)]
struct Manifest {
    entries: Option<Vec<ManifestEntry>>,
}

#[derive(serde::Deserialize)]
struct ManifestEntry {
    file: String,
}

// ── 工具函数 ──────────────────────────────────────────────────────────────

/// 从 GitHub URL 提取 owner/repo slug
fn parse_github_slug(source_url: &str) -> Option<String> {
    let url = source_url.trim();
    let slug = if url.starts_with("https://github.com/") {
        url.strip_prefix("https://github.com/")?
    } else if url.starts_with("http://github.com/") {
        url.strip_prefix("http://github.com/")?
    } else {
        return None;
    };
    // 去除尾部斜杠和 .git
    let slug = slug.trim_end_matches('/').trim_end_matches(".git");
    if slug.is_empty() {
        return None;
    }
    Some(slug.to_string())
}

/// 创建 HTTP 客户端（带超时）
fn http_client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("kxyy-desktop-pet/0.2")
        .build()
        .expect("failed to create HTTP client")
}

/// 从 GitHub raw 拉取文件内容。先试 main 分支，再试 master。
fn fetch_github_raw(client: &Client, slug: &str, file_path: &str) -> Option<String> {
    for branch in &["main", "master"] {
        let url = format!(
            "https://raw.githubusercontent.com/{}/{}/{}",
            slug, branch, file_path
        );
        match client.get(&url).send() {
            Ok(resp) if resp.status().is_success() => {
                return resp.text().ok();
            }
            _ => continue,
        }
    }
    None
}

/// 解析 YAML frontmatter（简化版，仅处理 key: value 和 | 多行值）
fn parse_frontmatter(md: &str) -> HashMap<String, String> {
    let mut fm = HashMap::new();
    let body = match md.strip_prefix("---") {
        Some(rest) => rest,
        None => return fm,
    };
    let end = match body.find("\n---") {
        Some(i) => i,
        None => return fm,
    };
    let yaml_block = &body[..end];
    let lines: Vec<&str> = yaml_block.lines().collect();

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim();
        if line.is_empty() {
            i += 1;
            continue;
        }
        let colon_idx = match line.find(':') {
            Some(idx) => idx,
            None => {
                i += 1;
                continue;
            }
        };
        let key = line[..colon_idx].trim().to_string();
        let value_part = line[colon_idx + 1..].trim().to_string();

        // YAML 多行标记（|, |-, >, >-）
        if value_part == "|" || value_part == "|-" || value_part == ">" || value_part == ">-" {
            let mut continuation = Vec::new();
            let mut j = i + 1;
            while j < lines.len() {
                let next = lines[j];
                if next.starts_with("  ") || next.starts_with('\t') {
                    continuation.push(next.trim().to_string());
                    j += 1;
                } else if next.is_empty() {
                    j += 1; // 跳过空行
                } else {
                    break;
                }
            }
            let value = continuation.join("\n");
            if !value.is_empty() {
                fm.insert(key, value);
            }
            i = j;
        } else {
            // 去掉引号
            let value = value_part
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
            fm.insert(key, value);
            i += 1;
        }
    }

    fm
}

/// 去掉 markdown 的 frontmatter 部分
fn strip_frontmatter(md: &str) -> String {
    if !md.starts_with("---") {
        return md.to_string();
    }
    let body = &md[3..];
    if let Some(end) = body.find("\n---") {
        // 跳过 closing --- 及后续空行
        let after = &body[end + 4..];
        after.trim_start().to_string()
    } else {
        md.to_string()
    }
}

/// 从 SKILL.md 提取结构化的核心内容（去掉技术细节）
fn extract_skill_structure(skill_md: &str) -> String {
    let body = strip_frontmatter(skill_md);
    // 移除代码块
    let cleaned = regex_replace_code_blocks(&body);
    cleaned.trim().to_string()
}

/// 简单的代码块替换
fn regex_replace_code_blocks(text: &str) -> String {
    let mut result = String::new();
    let mut in_code_block = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            if !in_code_block {
                // 进入代码块
                if !trimmed.contains("```") || trimmed.len() == 3 {
                    in_code_block = true;
                    result.push_str("[代码示例略]\n");
                    continue;
                }
            }
            in_code_block = false;
            continue;
        }
        if !in_code_block {
            result.push_str(line);
            result.push('\n');
        }
    }
    result.trim_end().to_string()
}

// ── system_prompt 组装 ─────────────────────────────────────────────────────

fn assemble_system_prompt(
    prompts: &HashMap<String, String>,
    fm: &HashMap<String, String>,
    registry_name: &str,
    registry_desc: &str,
) -> String {
    let name = if !registry_name.is_empty() {
        registry_name
    } else {
        fm.get("name").map(|s| s.as_str()).unwrap_or("未知技能")
    };
    let desc = if !registry_desc.is_empty() {
        registry_desc
    } else {
        fm.get("description").map(|s| s.as_str()).unwrap_or("")
    };
    let desc = desc.replace('\n', " ");

    let mut parts = Vec::new();

    // Part 0: 身份定义
    parts.push(format!("# 身份\n你是「{name}」技能助手。{desc}"));

    // Part 1: SKILL.md 核心
    if let Some(skill_md) = prompts.get("skill_md") {
        let structure = extract_skill_structure(skill_md);
        if !structure.is_empty() {
            parts.push(format!("\n# 核心能力与工作流\n{structure}"));
        }
    }

    // Part 2: 对话规则
    if let Some(chat_base) = prompts.get("chat_base") {
        let body = strip_headings(chat_base);
        if !body.is_empty() {
            parts.push(format!("\n# 对话规则\n{body}"));
        }
    }

    // Part 3: 分析模式
    if let Some(cheat_mode) = prompts.get("cheat_mode") {
        let body = strip_headings(cheat_mode);
        if !body.is_empty() {
            parts.push(format!("\n# 深度分析模式\n{body}"));
        }
    }

    // Part 4: 人格创建
    if let Some(create_persona) = prompts.get("create_persona") {
        let body = strip_headings(create_persona);
        if !body.is_empty() {
            parts.push(format!("\n# 人格创建流程\n{body}"));
        }
    }

    // Part 5: 关系分析
    if let Some(compat) = prompts.get("compat_guidance") {
        let body = strip_headings(compat);
        if !body.is_empty() {
            parts.push(format!("\n# 关系分析\n{body}"));
        }
    }

    // Part 6: 记忆管理
    if let Some(memory) = prompts.get("memory_builder") {
        let body = strip_headings(memory);
        if !body.is_empty() {
            parts.push(format!("\n# 记忆管理\n{body}"));
        }
    }

    // 如果有额外的 prompt 文件（不在标准列表中的）
    for key in &[
        "chat", "system", "role", "persona",
    ] {
        if let Some(content) = prompts.get(*key) {
            let name = match *key {
                "chat" => "对话",
                "system" => "系统",
                "role" => "角色",
                "persona" => "人设",
                _ => key,
            };
            parts.push(format!("\n# {name}\n{}", content.trim()));
        }
    }

    parts.join("\n\n")
}

/// 去掉 markdown 标题行（# 开头），保留正文
fn strip_headings(md: &str) -> String {
    let mut result = String::new();
    for line in md.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            continue;
        }
        result.push_str(line);
        result.push('\n');
    }
    result.trim().to_string()
}

// ── lore 组装 ───────────────────────────────────────────────────────────────

fn assemble_lore(prompts: &HashMap<String, String>) -> serde_json::Value {
    if let Some(knowledge) = prompts.get("knowledge") {
        // 截断到 50000 字符
        let truncated = if knowledge.len() > 50000 {
            &knowledge[..50000]
        } else {
            knowledge
        };
        serde_json::json!({
            "_type": "imported_skill_knowledge",
            "_source": "knowledge.md from source repo",
            "raw_knowledge": truncated,
        })
    } else {
        serde_json::json!({})
    }
}

// ── 名称/描述选择 ──────────────────────────────────────────────────────────

fn pick_best_name(
    registry_name: &str,
    fm: &HashMap<String, String>,
    pkg: &Option<serde_json::Value>,
    card_id: &str,
) -> String {
    if !registry_name.is_empty() && registry_name != card_id {
        return registry_name.to_string();
    }
    if let Some(fm_name) = fm.get("name") {
        if fm_name != card_id && !fm_name.starts_with("bazi") {
            return fm_name.to_string();
        }
    }
    if let Some(p) = pkg {
        if let Some(n) = p.get("name").and_then(|v| v.as_str()) {
            return n.to_string();
        }
    }
    if !registry_name.is_empty() {
        return registry_name.to_string();
    }
    card_id.to_string()
}

fn pick_best_desc(
    registry_desc: &str,
    fm: &HashMap<String, String>,
    pkg: &Option<serde_json::Value>,
) -> String {
    if !registry_desc.is_empty() {
        return registry_desc.to_string();
    }
    if let Some(fm_desc) = fm.get("description") {
        if fm_desc.len() > 5 {
            return fm_desc.to_string();
        }
    }
    if let Some(p) = pkg {
        if let Some(d) = p.get("description").and_then(|v| v.as_str()) {
            return d.to_string();
        }
    }
    String::new()
}

// ── 主函数 ─────────────────────────────────────────────────────────────────

/// 从 GitHub 导入指定 skill 并生成 persona-card.json。
/// 返回 ImportResult 供前端展示。
pub fn import_skill_from_github(
    card_id: &str,
    resource_dir: &PathBuf,
) -> Result<ImportResult, String> {
    // 1. 读取 _registry.json 找到对应的条目
    let cards_dir = crate::persona_assets::find_persona_cards_dir(resource_dir)
        .ok_or("未找到 persona-cards 目录")?;
    let reg_path = cards_dir.join("_registry.json");
    let reg_raw = fs::read_to_string(&reg_path)
        .map_err(|_| "无法读取 _registry.json".to_string())?;
    let root: serde_json::Value = serde_json::from_str(&reg_raw)
        .map_err(|e| format!("_registry.json JSON 解析失败: {e}"))?;
    let registry: Vec<serde_json::Value> = root
        .get("registry")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let entry = registry
        .iter()
        .find(|e| e.get("id").and_then(|v| v.as_str()) == Some(card_id))
        .ok_or_else(|| format!("注册表中未找到卡片: {card_id}"))?;

    let registry_name = entry
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(card_id);
    let registry_desc = entry
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let source_url = entry
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let tags: Vec<String> = entry
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str()).map(String::from).collect())
        .unwrap_or_default();

    if source_url.is_empty() {
        return Err(format!("注册表条目 {card_id} 没有 source URL"));
    }

    let slug = parse_github_slug(source_url)
        .ok_or_else(|| format!("无法解析 source URL: {source_url}"))?;

    // 2. 在后台线程中执行 HTTP 请求（block_in_place 告知 tokio 当前任务会阻塞，允许内部 reqwest blocking 创建独立 runtime）
    let (skill_md, pkg_raw, prompts, fetched_count) = tokio::task::block_in_place(|| {
        let client = http_client();

        // 拉取核心文件
        let skill_md = fetch_github_raw(&client, &slug, "SKILL.md");
        let pkg_raw = fetch_github_raw(&client, &slug, "package.json");

        // 拉取 manifest.json 确定 prompt 文件列表
        let manifest_raw = fetch_github_raw(&client, &slug, "prompts/manifest.json");
        let manifest_entries: Vec<String> = if let Some(m) = &manifest_raw {
            serde_json::from_str::<Manifest>(m)
                .ok()
                .and_then(|mf| mf.entries)
                .map(|entries| entries.into_iter().map(|e| e.file).collect())
                .unwrap_or_default()
        } else {
            vec![]
        };

        let files_to_fetch: Vec<String> = if !manifest_entries.is_empty() {
            manifest_entries
        } else {
            vec![
                "chat_base.md", "cheat_mode.md", "create_persona.md",
                "knowledge.md", "memory_builder.md", "compat_guidance.md",
                "chat.md", "system.md", "role.md", "persona.md",
            ].into_iter().map(String::from).collect()
        };

        // 拉取所有 prompt 文件
        let mut prompts: HashMap<String, String> = HashMap::new();
        if let Some(ref sm) = skill_md {
            prompts.insert("skill_md".to_string(), sm.clone());
        }

        let mut fetched = 0;
        for file in &files_to_fetch {
            if let Some(content) = fetch_github_raw(&client, &slug, &format!("prompts/{}", file)) {
                let key = file.trim_end_matches(".md").to_string();
                prompts.insert(key, content);
                fetched += 1;
            }
        }

        // 额外拉取 knowledge.md
        if !prompts.contains_key("knowledge") {
            if let Some(k) = fetch_github_raw(&client, &slug, "prompts/knowledge.md") {
                prompts.insert("knowledge".to_string(), k);
                fetched += 1;
            }
        }

        (skill_md, pkg_raw, prompts, fetched)
    });

    // 3. 解析 package.json
    let pkg_json: Option<serde_json::Value> = pkg_raw
        .as_ref()
        .and_then(|raw| serde_json::from_str(raw).ok());

    // 4. 解析 SKILL.md frontmatter
    let fm = skill_md
        .as_ref()
        .map(|sm| parse_frontmatter(sm))
        .unwrap_or_default();

    // 5. 组装 persona-card.json
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let display_name = pick_best_name(registry_name, &fm, &pkg_json, card_id);
    let display_desc = pick_best_desc(registry_desc, &fm, &pkg_json);
    let version = pkg_json
        .as_ref()
        .and_then(|p| p.get("version"))
        .and_then(|v| v.as_str())
        .unwrap_or(
            fm.get("version")
                .map(|s| s.as_str())
                .unwrap_or("1.0.0"),
        );
    let author = pkg_json
        .as_ref()
        .and_then(|p| p.get("author"))
        .and_then(|v| {
            if let Some(s) = v.as_str() {
                Some(s.to_string())
            } else if let Some(o) = v.as_object() {
                o.get("name").and_then(|n| n.as_str()).map(String::from)
            } else {
                None
            }
        })
        .unwrap_or_else(|| fm.get("author").cloned().unwrap_or_default());
    let license = pkg_json
        .as_ref()
        .and_then(|p| p.get("license"))
        .and_then(|v| v.as_str())
        .unwrap_or(
            fm.get("license")
                .map(|s| s.as_str())
                .unwrap_or("unknown"),
        );

    let system_prompt = assemble_system_prompt(&prompts, &fm, registry_name, registry_desc);
    let lore = assemble_lore(&prompts);

    let mut all_tags: Vec<String> = tags;
    all_tags.push("imported-skill".to_string());
    if let Some(p) = &pkg_json {
        if let Some(kw) = p.get("keywords").and_then(|v| v.as_array()) {
            for k in kw {
                if let Some(s) = k.as_str() {
                    all_tags.push(s.to_string());
                }
            }
        }
    }

    let card = serde_json::json!({
        "meta": {
            "card_id": card_id,
            "name": display_name,
            "schema_version": "1.0",
            "version": version,
            "created": today,
            "source": "imported-skill",
            "origin": source_url,
            "author": author,
            "description": display_desc,
            "tags": all_tags,
            "language": "zh-CN",
            "license": license,
        },
        "identity": {
            "name": registry_name,
            "description": registry_desc,
            "gender": "非二元",
            "persona_type": "other",
            "personality_tags": [],
        },
        "system_prompt": system_prompt,
        "few_shot": [],
        "lore": lore,
        "corrections": {},
        "source_materials": [{
            "type": "other",
            "path": source_url,
            "description": format!("从 {} 的 SKILL.md + prompts/*.md + package.json 导入", source_url),
        }],
        "user_profile": {},
    });

    // 6. 写入文件
    let card_dir = cards_dir.join(card_id);
    fs::create_dir_all(&card_dir)
        .map_err(|e| format!("创建卡片目录失败: {e}"))?;

    let card_path = card_dir.join("persona-card.json");

    // 备份旧文件
    if card_path.exists() {
        let backup_path = card_dir.join("persona-card.json.bak");
        let _ = fs::copy(&card_path, &backup_path);
    }

    let json_str = serde_json::to_string_pretty(&card)
        .map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&card_path, &json_str)
        .map_err(|e| format!("写入 persona-card.json 失败: {e}"))?;

    // 保存原始文件
    if let Some(sm) = &skill_md {
        let _ = fs::write(card_dir.join("SKILL.md"), sm);
    }
    for (key, content) in &prompts {
        if key == "skill_md" {
            continue;
        }
        let ext = if key == "manifest" { "json" } else { "md" };
        let _ = fs::write(card_dir.join(format!("{}.{}", key, ext)), content);
    }

    let sp_len = card["system_prompt"].as_str().map(|s| s.len()).unwrap_or(0);

    Ok(ImportResult {
        card_id: card_id.to_string(),
        name: registry_name.to_string(),
        system_prompt_len: sp_len,
        prompt_files: fetched_count,
        message: format!("✅ {} 已导入（{} 条 prompt，system_prompt {} 字符）",
            registry_name, fetched_count, sp_len),
    })
}
