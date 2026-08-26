# 全项目测试与审查报告 · 2026-08-24

> 本次审查按 [`testing-development-loop.md`](./testing-development-loop.md) 第 5 节的交付报告要求编写。
> 未实际执行的检查一律标注「未运行」及原因，不以静态审查代替执行证据。

## 环境

| 项 | 值 |
|---|---|
| commit | `183422a` (branch `main`) |
| App 版本 | 0.2.51（`package.json` / `package-lock.json` / `tauri.conf.json` / `Cargo.toml` 四处一致） |
| 平台 | macOS 26.5.2 · arm64 (Apple Silicon) |
| Node / Cargo | v24.19.0 / 1.96.1 |
| 工作区状态 | `AGENTS.md`、`README.md`、`package.json` 有未提交修改；`docs/testing-development-loop.md` 为未跟踪新增文件 |

## 1. 自动化门禁结果

执行命令：`npm test` → `npm run test:python` → `npm run test:resources` → `cargo test --lib` → `cargo check`
（等价于 `npm run test:gate` 的全部步骤）

| 层 | 命令 | 结果 |
|---|---|---|
| JS 行为测试 | `npm test` | **231 pass / 0 fail / 0 skip / 0 todo** |
| Python 纯状态与回放 | `npm run test:python` | **288 pass / 0 fail**（8 个文件） |
| VAD 资源合同 | `npm run test:resources` | **pass** |
| Rust 单元测试 | `cargo test --lib` | **103 pass / 0 fail / 1 ignored** |
| Rust 编译检查 | `cargo check` | **通过，7 warning** |

Python 各文件用例数：`test_local_realtime_events.py` 161、`test_vad_adapter.py` 38、
`test_qwen_mlx_stream.py` 30、`test_vad_evaluator.py` 19、`test_silero_shadow.py` 14、
`test_asr_adapter.py` 11、`test_sensevoice_runtime.py` 9、`test_voxcpm_stream.py` 6。

**门禁结论：全绿，无失败项。**

## 2. 实机验收（macOS）

`npm run dev` 启动并持续运行 32 分钟，无崩溃、无 panic。

已观察到的正常信号：

- Rust 侧构建完成并拉起 `target/debug/kxyy-desktop-pet`（pid 37784，CPU 2.7% / MEM 0.3%）。
- VoxCPM2 后端在 MPS 上加载完成，dtype 自动从 bfloat16 调整为 float32；参考音（106 字符）prompt cache 就绪。
- ASR 就绪 `active=sensevoice-sherpa-onnx status=active`，预热耗时 0.0s。
- TTS HTTP `http://127.0.0.1:19978/tts`、WS `ws://127.0.0.1:19878` 均监听成功。
- `GET /health` 持续返回 200，`voice-service` 状态为 `running`（pid 38022）。

**未运行的实机场景**（按 testing-loop 第 3 节要求必须记录）：

| 场景 | 状态 | 原因 |
|---|---|---|
| 真实语音通话全流程（拨号→对话→挂断） | 未运行 | 本次为静态与门禁审查，未驱动 UI |
| barge-in 打断与主动对话节奏 | 未运行 | 同上 |
| 通话中断线重连恢复 | 未运行 | 需注入网络故障，未执行 |
| 麦克风权限拒绝路径 | 未运行 | 需改动系统 TCC 状态，未执行 |
| 托盘 / 全局快捷键 / 点击穿透 | 未运行 | 未执行交互验收 |
| Windows 平台全部场景 | 未运行 | 无 Windows 环境；faster-qwen3-tts CUDA 路径、NSIS 安装包、WebView2 差异均未验证 |
| 安装包资源验收 | 未运行 | 本次仅 dev 模式，未构建安装包 |

**实机异常观察**：启动日志出现 `[setup] persona_card_id 为空，使用编译期默认人设`。
无法从代码判定这是首次运行的预期回退，还是配置丢失，需产品侧确认。

## 3. 审查方法与误报说明

本次使用 4 个并行子代理分别审查 Rust 后端、前端 JS、Python 服务、测试覆盖。
子代理报告的多数「高危」项经逐条查证为**误报**，不计入下方清单。典型误报及证伪证据：

| 子代理声称 | 查证结果 |
|---|---|
| `vadShadowSummary` 未脱敏即进诊断报告 | 证伪：`src/ai/realtime.js:1081` 与 `:1180` 均调用了 `sanitizeVadShadowSummary()` |
| `api.rs` 日志泄露 API key / 路径 | 证伪：`api.rs` 中 `eprintln!` / `println!` 出现次数为 0 |
| `stop()` 可能因等待 VAD 汇总而永久挂起 | 证伪：`_waitForFinalVadShadowSummary()` 内含 `setTimeout(..., VAD_SHADOW_FINAL_WAIT_MS)` 兜底 |
| Python TTS admission 槽位异常时泄漏 | 证伪：`common.py:4820` 有 `except: tts_slots.release(); raise`，`:5014` 有 `finally` 释放（含 draining 回调路径） |
| WebSocket 重连时旧连接消息会串入新会话 | 证伪：`realtime.js:822` `ws.onmessage` 首行即 `if (this.ws !== ws) return;`，`onclose`/`onerror` 同样有身份校验 |

**下方清单中的每一条均已独立查证并附证据。**

## 4. 问题清单（按优先级）

### P0 — 应立即处理

#### P0-1 `skill_import.rs` 未接入模块树，616 行代码从未被编译

- **证据**：`src-tauri/src/lib.rs:1-9` 的 `mod` 声明依次为 `api / fresh_topics / local_text / memory / memory_core / persona_assets / realtime / voice_service`，**无 `mod skill_import;`**。
  `cargo check` 完整输出中 `skill_import` 出现次数为 **0**——编译器从未读取该文件。
  `git log` 显示该文件自引入 commit `1d632e1` 起从未被 wire in。
- **影响**：该模块（从 registry 拉取 SKILL.md / prompts / package.json 导入人格卡）既不会因语法或类型错误而编译失败，也不在任何测试覆盖内，可无声腐烂至任意程度。当前状态比「没有该功能」更糟：代码存在造成功能已实现的假象。
- **建议**：二选一——① 声明 `mod skill_import;` 接入并按 testing-loop 补齐行为测试；② 删除该文件。
  接入前需注意其 `card_dir = cards_dir.join(card_id)`（`skill_import.rs:577`）存在与 P0-2 相同的遍历问题。

#### P0-2 人格卡导入存在路径遍历，`card_id` 无任何校验

- **证据链**：
  1. `src/settings.js:874` `deriveImportCardId(card)` 第一分支 `card?.meta?.card_id` **直接 `return`，不经任何正则清洗**（仅 name 兜底分支走 `replace(/[^a-z0-9一-鿿]+/gi, "-")`）。
  2. `src/settings.js:916` `invoke("import_persona_card", { cardId, jsonContent })`。
  3. `src-tauri/src/lib.rs:1508` `import_persona_card` 未做校验，透传至 `persona_assets::import_card_json`。
  4. `src-tauri/src/persona_assets.rs:138` `let card_dir = cards_dir.join(card_id);` 随后 `create_dir_all` + `fs::write`。
  5. 实测确认 `PathBuf::join` 不做规范化：`PathBuf::from("/tmp/cards").join("../../etc/x")` == `"/tmp/cards/../../etc/x"`，写入时会真实逃逸目录。
- **影响**：一张 `meta.card_id` 为 `../../../../tmp/pwn` 的 JSON 人格卡可导致任意路径的目录创建与文件写入。人格卡是设计上会被分享传播的内容，构成真实攻击面。
- **建议**：在 **Rust 侧**（前端校验可被绕过）`import_card_json` 入口强制 `card_id` 匹配 `^[a-zA-Z0-9_一-鿿-]{1,48}$`，并追加 `card_dir.starts_with(&cards_dir)` 断言。按 testing-loop 要求，先写复现该缺陷的失败测试再修复。

### P1 — 应尽快处理

#### P1-1 `local_text.rs`（537 行）测试数为 0

- **证据**（逐文件统计 `#[test]` / `#[tokio::test]`）：

  | 文件 | 行数 | 测试数 |
  |---|---|---|
  | `memory.rs` | 7539 | 36 |
  | `fresh_topics.rs` | 5881 | 33 |
  | `voice_service.rs` | 2485 | 12 |
  | `lib.rs` | 2771 | 11 |
  | `api.rs` | 1628 | 9 |
  | `realtime.rs` | 930 | 2 |
  | `memory_core.rs` | 84 | 1 |
  | **`local_text.rs`** | **537** | **0** |
  | **`persona_assets.rs`** | **304** | **0** |
  | `skill_import.rs` | 616 | 0（且未编译，见 P0-1） |

- **影响**：Ollama 探测、`ollama serve` 拉起、`pull_model` 的 NDJSON 逐行进度解析、`exceed_context_size_error` → 中文错误映射、thinking 开关下的 `max_tokens` 分支计算（关时 `max(in,512)`，开时 `(in*6).max(4096)`）——全部无自动化验证。这些恰恰是纯逻辑、极易表驱动测试的部分。
- **testing-loop 对照**：「异常输入」「依赖失败」两类场景在该模块完全空白。
- **建议**：优先补 NDJSON 解析、错误映射、`max_tokens` 计算三组表驱动单元测试，不需要真实 Ollama。

#### P1-2 `persona_assets.rs`（304 行）测试数为 0

- **证据**：同上表。该文件承载 XOR 解密与 P0-2 的导入写入路径。
- **建议**：修复 P0-2 时一并补齐边界测试（非法 `card_id`、缺 `identity`/`system_prompt` 字段、解密失败路径）。

#### P1-3 7 个常驻 dead_code warning 中 4 个未被文档认领

- **证据**：`cargo check` 输出的 7 个 warning 为：
  1. `SteamPopularSource` is never constructed — **已认领**（AGENTS.md:72）
  2. `steam_topic_from_detail` is never used — **已认领**
  3. `STEAM_POPULAR` is never used — **已认领**
  4. `MemoryProviderError` 的 `Unavailable` / `InvalidOutput` variant 从未被构造 — 未认领
  5. `voice_service::resolve_user_path` is never used — 未认领
  6. `voice_service::install_roots` is never used — 未认领
  7. `voice_service::pick_active_root` is never used — 未认领
- **影响**：两层。其一，`MemoryProviderError` 定义了两个从不构造的错误变体，暗示这两种失败情况在生产代码中未被识别与处理，值得独立核查。其二，7 个常驻 warning 会淹没未来**新增**的 warning，使编译告警失去信号价值。
- **建议**：确认保留的加 `#[allow(dead_code)]` + 说明注释，确认废弃的删除，把 warning 数压到 0。

### P2 — 可排期优化

#### P2-1 `pet-engine.js`（1134 行）与 `app.js`（273 行）无对应测试

- **证据**：`tests/` 下 19 个 `*.test.js` 与 `package.json` 的 `test` 脚本**完全匹配，无遗漏**（已逐一核对，这一点是健康的）。但 `src/` 侧 `app.js` 与 `pet-engine.js` 无任何对应测试文件。
- **风险点**：`src/app.js:110-131` 的 `pointOverPet()` 通过 `canvas.width / rect.width` 推算 dpr，并以 `(canvas.style.transform || "").includes("-1")` 硬编码判断翻转。多显示器 / 不同缩放下正确性可疑，且 CSS 变更会静默失效。该函数是纯函数，补测试成本低。
- **正面观察**：`startPolling()`（`app.js:145-163`）的自适应降频设计良好——指针远离 250ms、靠近 50ms，并在 `hidden`/`interactive` 时主动停止，CPU 开销可控（实测 2.7%）。

#### P2-2 两个长期跳过的测试

| 测试 | 位置 | 跳过条件 | 风险 |
|---|---|---|---|
| `live_default_sources_return_parseable_bounded_candidates` | `fresh_topics.rs:5597` | `#[ignore = "requires live network access"]` | AGENTS.md:72 已认领。但意味着 15 个固定中文源的解析器**永无 CI 覆盖**，上游改版式只能靠用户报障发现 |
| `RealRuntimeSmokeTests` | `tests/test_silero_shadow.py:459` | `skipUnless(KXYY_RUN_SILERO_SMOKE == "1")` | 真实 ONNX 推理烟测在门禁中从不执行。因 VAD shadow 为 opt-in 且仅观测用，风险可接受 |

- **建议**：增加 `npm run test:live` 脚本承载需联网的解析器验证，在发版前手动执行并记录；`KXYY_RUN_SILERO_SMOKE` 的手动运行方式写入文档。

#### P2-3 `chat.js` / `settings.js` / `realtime.js` 的生命周期场景覆盖偏薄

- **证据**：并非无覆盖——`tests/realtime-trace.test.js` 达 4123 行，诊断与协议层非常扎实。但覆盖集中于此：
  - `tests/chat-turn-error.test.js` 仅 34 行 ↔ `src/chat.js` 3385 行
  - `tests/settings-update-policy.test.js` 仅 76 行 ↔ `src/settings.js` 2527 行
- **缺口**：testing-loop 明确要求的「设置文件损坏后的恢复」「通话中断线重连」两个生命周期场景，无对应自动化用例。
- **建议**：需要 Tauri IPC mock 基础设施，成本较高，建议按需推进而非一次性补齐。优先级低于 P0/P1。

## 5. 结论

- 自动化门禁 **622 个测试全部通过**（231 JS + 288 Python + 103 Rust），无失败、无被跳过的 JS 用例。
- macOS dev 模式实机运行稳定，语音后端（VoxCPM2 + SenseVoice）完整就绪。
- 发现 **2 个 P0**（1 个未编译的死模块、1 个可被分享内容触发的路径遍历）、**3 个 P1**（2 个零测试模块、1 组未认领告警）、**3 个 P2**。
- **Windows 平台与全部真实通话场景本次未验证**，不得据本报告宣称跨平台通过。

## 6. 后续建议顺序

1. 判定 `skill_import.rs` 去留（P0-1）——决定是否需要连带修其内部的同类遍历问题。
2. 用失败测试复现 `card_id` 遍历，再在 Rust 侧修复并加断言（P0-2）。
3. 补 `local_text.rs` 与 `persona_assets.rs` 的表驱动单元测试（P1-1 / P1-2）。
4. 清零 dead_code warning，顺带核查 `MemoryProviderError` 两个未构造变体是否代表未处理的失败路径（P1-3）。
5. 排期实机验收：真实通话、断线重连、权限拒绝，以及 Windows 侧全量场景。
