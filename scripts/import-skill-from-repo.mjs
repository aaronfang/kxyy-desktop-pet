/**
 * import-skill-from-repo.mjs
 *
 * 从 GitHub raw 拉取一个 persona-distill skill 仓库的实际内容，
 * 解析 SKILL.md、prompts/*.md、package.json，转化为 kxyy 的 persona-card.json。
 *
 * 解决之前 generate_card_from_registry 只根据 _registry.json 的一行简介
 * 生成空壳卡片的问题。
 *
 * 用法：
 *   node scripts/import-skill-from-repo.mjs --repo https://github.com/cantian-ai/bazi-persona-skill
 *   node scripts/import-skill-from-repo.mjs --repo cantian-ai/bazi-persona-skill --id bazi-persona
 *   node scripts/import-skill-from-repo.mjs --registry  # 批量导入 _registry.json 中的所有条目
 *
 * 环境变量：
 *   GITHUB_TOKEN  可选，避免 API 限流
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CARDS_DIR = path.join(ROOT, "persona-cards");
const REGISTRY_PATH = path.join(CARDS_DIR, "_registry.json");

// ── 工具函数 ──────────────────────────────────────────────────────────────

async function githubRaw(repo, filePath, { token } = {}) {
  // repo 格式: "owner/name" 或 "https://github.com/owner/name"
  let slug = repo;
  if (slug.startsWith("https://github.com/")) {
    slug = slug.replace("https://github.com/", "").replace(/\/$/, "");
  }
  // 去掉可能的 .git 后缀
  slug = slug.replace(/\.git$/, "");

  const url = `https://raw.githubusercontent.com/${slug}/main/${filePath}`;
  const headers = {};
  if (token) headers["Authorization"] = `token ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    // 尝试 master 分支
    const masterUrl = `https://raw.githubusercontent.com/${slug}/master/${filePath}`;
    const masterRes = await fetch(masterUrl, { headers });
    if (!masterRes.ok) {
      console.warn(`  [SKIP] ${filePath}: ${res.status} ${res.statusText}`);
      return null;
    }
    return await masterRes.text();
  }
  return await res.text();
}

async function githubApiListDir(repo, dirPath, { token } = {}) {
  let slug = repo;
  if (slug.startsWith("https://github.com/")) {
    slug = slug.replace("https://github.com/", "").replace(/\/$/, "");
  }
  slug = slug.replace(/\.git$/, "");

  const url = `https://api.github.com/repos/${slug}/contents/${dirPath}`;
  const headers = { Accept: "application/vnd.github.v3+json" };
  if (token) headers["Authorization"] = `token ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) return [];
  const items = await res.json();
  if (!Array.isArray(items)) return [];
  return items.map((i) => i.name);
}

function parseFrontmatter(md) {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  const lines = match[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // 去掉引号
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // 处理 YAML 多行标记 (|, |-, >)
    if (value === "|" || value === "|-" || value === ">" || value === ">-") {
      // 收集后续缩进行作为多行值
      const continuation = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].startsWith("  ") || lines[j].startsWith("\t"))) {
        continuation.push(lines[j].trim());
        j++;
      }
      value = continuation.join("\n").trim();
      i = j - 1; // 跳过已处理的行
    }

    fm[key] = value;
  }
  return fm;
}

function stripFrontmatter(md) {
  return md.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
}

// ── 内容提取与映射 ────────────────────────────────────────────────────────

/**
 * 从 SKILL.md 提取工作流描述作为 system_prompt 的核心框架。
 * 提取所有 # heading 下的内容，保留结构。
 */
function extractSkillStructure(skillMd) {
  const body = stripFrontmatter(skillMd);
  // 移除 "## 1.2) 命令行运行方式" 这类技术细节
  const cleaned = body
    .replace(/##\s*1\.2\).*?(?=##|\Z)/s, "")
    .replace(/```[\s\S]*?```/g, "[代码示例略]");
  return cleaned.trim();
}

/**
 * 从 prompts/*.md 合并为 system_prompt 的各个部分。
 */
function assembleSystemPrompt(prompts, fm, registryEntry) {
  const name = registryEntry?.name || fm.name || "未知技能";
  const desc = (registryEntry?.description || fm.description || "").replace(/\n\s*/g, " ").trim();

  let parts = [];

  // Part 0: 身份定义
  parts.push(`# 身份\n你是「${name}」技能助手。${desc}`);

  // Part 1: SKILL.md 核心（如果有）
  if (prompts.skill_md) {
    parts.push(`\n# 核心能力与工作流\n${extractSkillStructure(prompts.skill_md)}`);
  }

  // Part 2: 聊天基础规则
  if (prompts.chat_base) {
    parts.push(`\n# 对话规则\n${prompts.chat_base.replace(/^#.*\n/gm, "").trim()}`);
  }

  // Part 3: 分析模式（如 cheat_mode）
  if (prompts.cheat_mode) {
    parts.push(`\n# 深度分析模式\n${prompts.cheat_mode.replace(/^#.*\n/gm, "").trim()}`);
  }

  // Part 4: 人格创建
  if (prompts.create_persona) {
    parts.push(`\n# 人格创建流程\n${prompts.create_persona.replace(/^#.*\n/gm, "").trim()}`);
  }

  // Part 5: 特殊功能
  if (prompts.compat_guidance) {
    parts.push(`\n# 关系分析\n${prompts.compat_guidance.replace(/^#.*\n/gm, "").trim()}`);
  }

  if (prompts.memory_builder) {
    parts.push(`\n# 记忆管理\n${prompts.memory_builder.replace(/^#.*\n/gm, "").trim()}`);
  }

  return parts.join("\n\n");
}

/**
 * 从 knowledge.md 提取结构化的知识库作为 lore
 */
function assembleLore(prompts) {
  if (!prompts.knowledge) return {};
  // knowledge.md 本身就是结构化的知识内容
  return {
    _type: "imported_skill_knowledge",
    _source: "knowledge.md from source repo",
    raw_knowledge: prompts.knowledge.slice(0, 50000), // 限制大小
  };
}

/**
 * 从 SKILL.md + package.json 提取 meta
 */
function buildMeta(fm, pkgJson, repo, cardId, registryEntry) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    card_id: cardId,
    name: pickBestName(registryEntry, fm, pkgJson, cardId),
    schema_version: "1.0",
    version: pkgJson?.version || fm.version || "1.0.0",
    created: today,
    source: "imported-skill",
    origin: repo,
    author: pkgJson?.author || fm.author || "",
    description: pickBestDesc(registryEntry, fm, pkgJson),
    tags: [
      ...(registryEntry?.tags || []),
      "imported-skill",
      ...(pkgJson?.keywords || []),
    ],
    language: "zh-CN",
    license: pkgJson?.license || fm.license || "unknown",
  };
}

function pickBestName(registryEntry, fm, pkgJson, cardId) {
  // 优先用注册表中的中文显示名
  if (registryEntry?.name && registryEntry.name !== cardId) return registryEntry.name;
  // 其次用 SKILL.md 的 description 第一句（有时比 name 更友好）
  // 然后才用 fm.name
  if (fm.name && fm.name !== "bazi-persona" && !fm.name.startsWith("bazi")) return fm.name;
  // 回到 registry 的 name 或 cardId
  return registryEntry?.name || pkgJson?.name || cardId;
}

function pickBestDesc(registryEntry, fm, pkgJson) {
  if (registryEntry?.description) return registryEntry.description;
  if (fm.description && fm.description.length > 5) return fm.description;
  return pkgJson?.description || "";
}

/**
 * 从 SKILL.md 提取 identity
 */
function buildIdentity(fm, registryEntry) {
  return {
    name: registryEntry?.name || fm.name || "未知技能",
    description: registryEntry?.description || fm.description || "",
    gender: "非二元",
    persona_type: "other",
    personality_tags: [],
  };
}

// ── 主逻辑 ────────────────────────────────────────────────────────────────

async function importSkill(repo, cardId, options = {}) {
  let { token, registryEntry } = options;

  // 如果没有显式传入 registryEntry，尝试从 _registry.json 查找
  if (!registryEntry) {
    try {
      const regRaw = fs.readFileSync(REGISTRY_PATH, "utf-8");
      const reg = JSON.parse(regRaw);
      registryEntry = (reg.registry || []).find((e) => e.id === cardId);
    } catch { /* ignore */ }
  }

  console.log(`\n[import] ${cardId} ← ${repo}`);

  // 1. 并行拉取核心文件
  console.log(`  [1/5] 拉取 skill 文件...`);
  const [skillMd, pkgRaw] = await Promise.all([
    githubRaw(repo, "SKILL.md", { token }),
    githubRaw(repo, "package.json", { token }),
  ]);

  // 2. 通过 manifest.json 确定要拉哪些 prompt 文件
  const prompts = {};
  if (skillMd) prompts.skill_md = skillMd;

  // 先尝试拉 manifest.json，失败则用已知常见文件名
  const manifestRaw = await githubRaw(repo, "prompts/manifest.json", { token });
  let manifestEntries = [];
  if (manifestRaw) {
    try {
      const manifest = JSON.parse(manifestRaw);
      manifestEntries = manifest.entries || [];
    } catch { /* ignore */ }
  }

  // 决定要拉取的 prompt 文件列表
  let filesToFetch;
  if (manifestEntries.length > 0) {
    filesToFetch = manifestEntries.map((e) => e.file);
  } else {
    // 无 manifest.json 时，尝试常见 prompt 文件名
    const commonNames = [
      "chat_base.md", "cheat_mode.md", "create_persona.md",
      "knowledge.md", "memory_builder.md", "compat_guidance.md",
      "chat.md", "system.md", "role.md", "persona.md",
    ];
    filesToFetch = commonNames;
  }

  console.log(`     manifest 条目: ${manifestEntries.length}, 尝试拉取: ${filesToFetch.length} 个文件`);

  // 并行拉取所有 prompt 文件（静默跳过 404）
  const promptContents = await Promise.all(
    filesToFetch.map(async (f) => {
      const content = await githubRaw(repo, `prompts/${f}`, { token });
      const key = f.replace(/\.md$/, "");
      return { key, fetch: f, content };
    })
  );

  let fetchedCount = 0;
  for (const { key, content } of promptContents) {
    if (content) {
      prompts[key] = content;
      fetchedCount++;
    }
  }

  // 额外拉取 knowledge.md（通常不在 manifest.json 中，但很重要）
  if (!prompts.knowledge) {
    const knowledgeRaw = await githubRaw(repo, "prompts/knowledge.md", { token });
    if (knowledgeRaw) {
      prompts.knowledge = knowledgeRaw;
      fetchedCount++;
    }
  }

  console.log(`  [2/5] 成功拉取 ${fetchedCount} 个文件（含 knowledge.md）`);

  // 3. 解析 package.json
  let pkgJson = null;
  if (pkgRaw) {
    try {
      pkgJson = JSON.parse(pkgRaw);
    } catch {
      console.warn("  [WARN] package.json 解析失败");
    }
  }

  // 4. 解析 SKILL.md frontmatter
  const fm = skillMd ? parseFrontmatter(skillMd) : {};

  // 5. 组装 persona-card.json
  console.log(`  [3/5] 组装 persona-card...`);
  const card = {
    meta: buildMeta(fm, pkgJson, repo, cardId, registryEntry),
    identity: buildIdentity(fm, registryEntry),
    system_prompt: assembleSystemPrompt(prompts, fm, registryEntry),
    few_shot: [],
    lore: assembleLore(prompts),
    corrections: {},
    source_materials: [
      {
        type: "other",
        path: repo,
        description: `从 ${repo} 的 SKILL.md + prompts/*.md + package.json 导入`,
      },
    ],
    user_profile: {},
  };

  // 6. 写入文件
  console.log(`  [4/5] 写入 persona-card.json...`);
  const cardDir = path.join(CARDS_DIR, cardId);
  fs.mkdirSync(cardDir, { recursive: true });

  // 备份旧文件
  const cardPath = path.join(cardDir, "persona-card.json");
  if (fs.existsSync(cardPath)) {
    const backupPath = cardPath + ".bak";
    fs.copyFileSync(cardPath, backupPath);
    console.log(`  [INFO] 旧卡片已备份: ${backupPath}`);
  }

  fs.writeFileSync(cardPath, JSON.stringify(card, null, 2), "utf-8");

  // 同时保存原始 SKILL.md 和 prompts 以便后续参考
  if (skillMd) {
    fs.writeFileSync(path.join(cardDir, "SKILL.md"), skillMd, "utf-8");
  }
  for (const [key, content] of Object.entries(prompts)) {
    if (key === "skill_md") continue; // 已单独保存
    const ext = key === "manifest" ? "json" : "md";
    fs.writeFileSync(
      path.join(cardDir, `${key}.${ext}`),
      content,
      "utf-8"
    );
  }

  // 7. 打印摘要
  console.log(`  [5/5] 完成! 摘要:`);
  console.log(`    名称:       ${card.meta.name}`);
  console.log(`    版本:       ${card.meta.version}`);
  console.log(`    system_prompt: ${card.system_prompt.length.toLocaleString()} 字符`);
  console.log(`    prompt 文件:   ${Object.keys(prompts).filter(k => k !== "skill_md").length} 个`);
  console.log(`    输出:       ${path.relative(ROOT, cardPath)}`);

  return card;
}

// ── 批量导入 ──────────────────────────────────────────────────────────────

async function importFromRegistry(options = {}) {
  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error(`[ERROR] 找不到注册表: ${REGISTRY_PATH}`);
    return;
  }

  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
  const entries = registry.registry || [];
  console.log(`\n注册表共 ${entries.length} 条记录`);

  const results = [];
  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    const cardId = entry.id;
    const repo = entry.source;
    if (!repo) {
      console.log(`  [SKIP] ${cardId}: 缺少 source URL`);
      skipped++;
      continue;
    }

    // 跳过已有的非空壳卡片（有实际 system_prompt 内容的）
    const cardPath = path.join(CARDS_DIR, cardId, "persona-card.json");
    if (fs.existsSync(cardPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(cardPath, "utf-8"));
        const sp = existing.system_prompt || "";
        // 如果 system_prompt 超过 200 字符且不是自动生成的空壳
        if (sp.length > 200 && !sp.includes("请始终以") || existing.meta?.source === "imported-skill") {
          console.log(`  [SKIP] ${cardId}: 已有非空壳卡片 (${sp.length} chars)`);
          skipped++;
          continue;
        }
      } catch { /* 文件损坏，重新导入 */ }
    }

    try {
      console.log(`\n── ${entry.name} (${cardId}) ──`);
      await importSkill(repo, cardId, { ...options, registryEntry: entry });
      success++;
      results.push({ id: cardId, status: "ok" });
    } catch (e) {
      console.error(`  [FAIL] ${cardId}: ${e.message}`);
      failed++;
      results.push({ id: cardId, status: "fail", error: e.message });
    }

    // 避免 GitHub API 限流
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n=== 批量导入完毕 ===`);
  console.log(`  成功: ${success}`);
  console.log(`  跳过: ${skipped}`);
  console.log(`  失败: ${failed}`);
  return results;
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const token = process.env.GITHUB_TOKEN || null;

  let repo = null;
  let cardId = null;
  let useRegistry = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo" && args[i + 1]) {
      repo = args[++i];
    } else if (args[i] === "--id" && args[i + 1]) {
      cardId = args[++i];
    } else if (args[i] === "--registry") {
      useRegistry = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
用法:
  node scripts/import-skill-from-repo.mjs --repo <url> [--id <card-id>]
  node scripts/import-skill-from-repo.mjs --registry

示例:
  node scripts/import-skill-from-repo.mjs --repo https://github.com/cantian-ai/bazi-persona-skill
  node scripts/import-skill-from-repo.mjs --repo cantian-ai/bazi-persona-skill --id bazi-persona
  node scripts/import-skill-from-repo.mjs --registry  # 批量导入所有注册表条目

环境变量:
  GITHUB_TOKEN  可选，避免 API 限流
`);
      return;
    }
  }

  if (useRegistry) {
    await importFromRegistry({ token });
    return;
  }

  if (!repo) {
    console.error("[ERROR] 需要 --repo 或 --registry 参数");
    console.error("  node scripts/import-skill-from-repo.mjs --repo <url>");
    console.error("  node scripts/import-skill-from-repo.mjs --registry");
    process.exit(1);
  }

  // 自动生成 cardId
  if (!cardId) {
    let slug = repo;
    if (slug.startsWith("https://github.com/")) {
      slug = slug.replace("https://github.com/", "");
    }
    slug = slug.replace(/\.git$/, "");
    cardId = slug.split("/").pop();
  }

  try {
    await importSkill(repo, cardId, { token });
  } catch (e) {
    console.error(`[FATAL] ${e.message}`);
    process.exit(1);
  }
}

main();
