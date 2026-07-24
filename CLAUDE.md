# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

元元桌宠 (kxyy-desktop-pet): a cross-platform (macOS / Windows) desktop pet built with **Tauri 2**. A web-based animation engine (ported from [webmeji](https://github.com/lars-rooij/webmeji)) runs in a transparent always-on-top WebView; a Rust main process handles the tray, windows, persistence, global shortcuts, and a local AI proxy. It also embeds an **AI chat** feature (DeepSeek text, Qwen-VL vision, Volcano TTS, and Volcano **realtime voice call**).

On macOS the app is a **menu-bar tray app** (no Dock icon). The app icon is a **head close-up of 苗疆元元** (`build/icon-square.png` → `npx tauri icon`), chosen so it stays legible at tray/small sizes.

Upstream sibling project is a web app named `kxyy_ai_clone`; the `ai/` logic modules, persona corpus, and pet/sticker assets are **synced from it** and must stay contract-compatible (see Sync below). Desktop-only modules (`realtime.js`, `pcm-worklet.js`, `playback-worklet.js`, `realtime-trace.js`, `voice-volume.js`) are **not** part of that sync.

## Commands

```bash
npm install
npm run dev          # tauri dev (predev auto-runs encrypt-assets)
npm run build        # current platform: encrypt-assets → strip plaintext → tauri build → restore
npm run build:win    # NSIS installer
npm run build:mac    # dmg
npm run encrypt-assets   # persona-assets.js → src-tauri/assets/persona-assets.enc (XOR)
npm run sync-assets      # pull pet frame art from kxyy_ai_clone into src/assets/pets
npm run sync-ai          # pull ai/*.js, persona corpus, stickers from kxyy_ai_clone
npm test                 # JS realtime trace / Worklet deterministic tests
npm run test:python      # local realtime pure-state / replay tests
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo check --manifest-path src-tauri/Cargo.toml
```

There is no linter configured. Realtime voice has deterministic JS/Python/Rust tests that do not require an account, microphone, or model. Build artifacts land in `src-tauri/target/release/bundle/`.

## Architecture

**Three windows** (defined in `src-tauri/tauri.conf.json`): `main` (transparent, decorationless, always-on-top, click-through pet), `chat` (AI bubble), `settings`. Each has an HTML/JS/CSS trio in `src/`.

**Frontend ↔ Rust IPC** goes through `window.__TAURI__.core.invoke` (see the `#[tauri::command]` handlers registered in `lib.rs` — `get_settings`, `set_ignore_cursor`, `cursor_pos`, `show_menu`, `get_api_base`, `get_realtime_base`, `toggle_chat_window`, `hide_chat`, `open_settings`, `set_ai_settings`) and `window.__TAURI__.event` (emit/listen — e.g. `apply-settings`, `pet-chat`).

**Click-through** is not OS event forwarding (Tauri lacks Electron's). Instead `src/app.js` polls the cursor at low frequency via `cursor_pos`, does pixel-level hit-testing against the pet, and toggles `set_ignore_cursor` only when the pointer is near the pet. Transparent regions always pass through.

**macOS Dock / tray**: the app must not occupy the Dock — only the menu-bar tray icon. Two layers enforce this:
- `src-tauri/Info.plist` sets `LSUIElement=true` (applies to packaged builds).
- `lib.rs` `setup` also calls `app.set_activation_policy(ActivationPolicy::Accessory)` so **dev mode** (`tauri dev`) hides the Dock too (plist alone does not cover that).

**Local AI proxy** (`src-tauri/src/api.rs`): a `tiny_http` loopback server started at runtime on a random port. The frontend calls `invoke("get_api_base")` → `http://127.0.0.1:<port>`. Routes replicate the upstream `/api/chat` (SSE streaming) contract so synced logic modules work unchanged:
- `GET/POST /api/chat` — proxies to DeepSeek (`deepseek-chat`/`deepseek-reasoner`) or, when an image is present, Qwen-VL (DashScope compatible-mode).
- `POST /api/tts` — Volcano TTS (returns `audio/mpeg`).
- `GET /api/assets` — decrypted persona corpus.

For `/api/chat`, ordinary WebView `stream:true` responses are deliberately buffered and returned with `Content-Length` for Windows WebView2 compatibility. Only the managed local realtime Python service may request direct SSE, using the App-managed internal secret and `provider:"text"`; do not add that secret header to the browser CORS allow-list or log/forward it.

**Realtime voice call** (`src-tauri/src/realtime.rs` + `src/ai/realtime.js`): full-duplex voice chat with Volcano's 端到端实时语音大模型 (RealtimeDialog). A phone button (`#call-btn`) at the left of the chat composer starts/ends a call; it turns red (`.in-call`) while active. Settings fields: `realtimeAppId`, `realtimeAccessKey`, optional `realtimeVoice` (empty → reuse TTS `ttsVoice`). Architecture:
- **Rust side** runs a second loopback server — a `tokio`/`tokio-tungstenite` WebSocket bridge on its own random port (`invoke("get_realtime_base")` → `ws://127.0.0.1:<port>`). It's needed because browser WebSockets can't set the `X-Api-*` auth headers Volcano requires; keys, the binary frame protocol, and gzip all stay in Rust. **All Volcano protocol constants (endpoint, resource id, event codes, frame layout) live in the `protocol` submodule and must be verified against your account's official docs** — they couldn't be fetched during implementation.
- **Frontend side** owns audio: `getUserMedia` (with AEC/noise-suppression — essential since the pet is a speaker/output scenario prone to echo-feedback), an AudioWorklet (`src/ai/pcm-worklet.js`) resampling mic to 16k s16le PCM upstream, and a fixed-capacity playback Worklet ring for 24k PCM downstream with duck/resume/clear. A source-node legacy fallback remains available.
- **Persona reuse**: the frontend assembles `system_role` via the *existing* `buildSystemPrompt` + `computeLiveContext` and sends it in a `{type:"start", systemRole, botName}` message, so Rust doesn't duplicate persona logic. Auth uses `realtimeAppId` + `realtimeAccessKey` (distinct from the TTS `x-api-key`).
- The private frontend protocol always sends raw 16k PCM upstream. Volcano and old local services return raw 24k PCM; local/CosyVoice may negotiate the project-private `managed-v1` envelope, whose numeric identity header precedes the same PCM16LE payload. Text carries control/event JSON. During a call the text input, image, and sticker controls are disabled (voice-only).
- macOS requires `NSMicrophoneUsageDescription` (`src-tauri/Info.plist`); wry 0.55 auto-grants the WebView `getUserMedia` permission, so the OS TCC prompt is the only gate.

**Local voice backends** (`src-tauri/src/voice_service.rs` + `scripts/local-realtime/*.py`): the app manages local Python TTS processes (one per backend, each with its own WS+HTTP port). The `local` backend (Qwen3-TTS) is cross-platform: macOS uses `mlx-audio` (auto-configured venv at `~/Library/Application Support/…/voice-runtime`, setup script `scripts/macos/setup-qwen3-tts.sh`); Windows/Linux uses the official PyTorch package `qwen-tts` (default model `Qwen/Qwen3-TTS-12Hz-1.7B-Base`, venv at `scripts/local-realtime/.venv-qwen3`, setup script `scripts/windows/setup-qwen3-tts.ps1`). `voice_service.rs` probes known Python install paths, spawns the right `server_*.py` with `CREATE_NO_WINDOW` + `PYTHONUTF8`, and health-checks via `GET /health` (must return `kxyy-voice`). `server.py` auto-dispatches MLX vs PyTorch by platform. A shared `KXYY_TTS_SECRET` env var authenticates `/tts` and the managed internal `/api/chat` SSE request between Rust and Python; `KXYY_AI_PROXY_BASE` must remain a strict loopback URL. Setup scripts ship as installer resources (see `tauri.conf.json` resources) and the NSIS `hooks.nsh` POSTINSTALL offers to run them.

Local realtime LLM output is SSE with a bounded 32-event Python queue and at most two blocking producers/TTS tasks. A pure `StableSentenceBuffer` feeds a bounded 4-sentence ordered TTS pipeline: Qwen synthesis parallelism stays 1, CosyVoice may use 2, and playback is always single-lane/in-order. macOS MLX must not prefetch TTS during playback because TTS and barge-in ASR share `_mlx_pool`; the separate Windows/Linux Qwen pool and CosyVoice may prefetch. Each whole-sentence PCM result is capped at 60 seconds; this is **not** true Qwen/CosyVoice audio streaming. Blocking socket/TTS calls cannot be force-killed, so every return/send boundary must re-check the generation CancelScope, and all new queues/admission paths must stay bounded.

Local/CosyVoice `managed-v1` is negotiated by `start.downlinkAudio` and the `session` response; if either side does not select it, downlink remains raw PCM for backward compatibility. Its fixed 24-byte big-endian `KXAU` v1 header carries generation, segment id, strict chunk sequence, and payload sample count; chunks are at most 80ms/1920 samples and a segment is at most 750 chunks/60s. The frontend accepts only the current generation and currently registered segment, sequence starting at zero with no reorder buffer, and an exact sample total at segment end. Invalid, stale, duplicate, gapped, overflowed, or mismatched segments never produce an audible completion receipt; all pending queues and segment ledgers remain bounded at their existing 64-item limits. The mirrored constants in `scripts/local-realtime/common.py` and `src/ai/realtime.js` must change together with deterministic tests on both sides. `KXAU` is not a Volcano constant: never infer from it or modify `realtime.rs::protocol` because of it.

Local/CosyVoice conversation history is playback-derived: each stable sentence gets a bounded `generation + segmentId`, and only a text-free completion receipt from the playback Worklet (or completed legacy sources) may add its cleaned spoken text to the next LLM context and chat recap. Candidate receipts stay deferred until rejection; cancellation, clear, overflow, unknown/old generations, or suspended-audio ordering failures must never make a segment audible. Keep the Python turn ledger (4), per-turn segments (64), frontend/Worklet segments (64), candidate segment-key snapshots (64), and suspended playback queue (64) bounded. Worklet-only local/CosyVoice may negotiate `start.interruptionHint` / `session.interruptionHint` as `candidate-snapshot-v1`: candidate/confirmed/rejected share a monotonic candidate id, the Worklet snapshots exact current `generation + segmentId + playedSamples`, and a confirmed text-free receipt can add one fixed temporary system hint to that LLM request only when the registered incomplete segment has played at least 24000 source samples (1 second). Python waits at most 50ms; the hint never enters history, recap, long-term memory, or logs. Managed chunk progress must not be used to infer partial spoken text or byte/phoneme position. Legacy playback, old services, and Volcano fall back to no hint; Volcano has no segment envelope and keeps its existing history behavior, so do not infer or modify its protocol constants. Never log envelope payloads, raw PCM, secrets, persona, or complete user/assistant text.

**Local text backend** (`src-tauri/src/local_text.rs`): offline fallback for text chat when there's no DeepSeek connectivity, built on **Ollama** (user installs it once; Ollama itself handles CUDA on Windows/NVIDIA and Metal on macOS — no per-platform binary/model bundling on our side). Settings fields: `textProvider` (`deepseek` default / `local`), `localTextModel` (Ollama tag, empty falls back to `local_text::DEFAULT_MODEL` = `qwen3:14b`, also recommended in the UI datalist alongside `qwen3:8b`/`qwen3:32b`). Unlike the voice backends, **Ollama is treated as a shared system service, not an App-owned child process**: `local_text::ensure()` only checks `GET /api/tags` and, if unreachable, tries to locate the `ollama` binary (PATH + known install dirs) and `spawn()`s `ollama serve` detached — no child handle is retained, and `RunEvent::Exit` never touches it. `api.rs`'s `proxy_chat` branches on `cfg.text_provider`: `local` routes to Ollama's OpenAI-compatible `http://127.0.0.1:11434/v1/chat/completions` (same `messages`/`stream`/`temperature`/`max_tokens` contract, Key check skipped) instead of DeepSeek. Model downloads go through `local_text::pull_model()` (`POST /api/pull`, NDJSON progress parsed line-by-line) with progress pushed to the settings UI via the `local-text-pull-progress` event; `local-text-status` pushes lifecycle state the same way `voice-service-status` does for voice. Settings `thinking` also applies to local Qwen3: `reasoning_effort` is `"medium"` / `"none"` (plus top-level `think`); local `max_tokens` is raised to `max(in, 512)` when thinking is off, and `(in * 6).max(4096)` when on. On ensure, Rust warms the model via **native** `POST /api/chat` with the persona system prompt (`keep_alive: 30m`, `num_ctx: 16384`) so `/v1`'s ignored `keep_alive` doesn't matter; each successful local chat also calls `touch_keep_alive()`. Context overflow (Ollama `exceed_context_size_error`) is mapped to a Chinese error. The chat frontend uses `LOCAL_MAX_TURNS=4` for local to leave more room under the context window (few-shot examples are still sent).

In `chat.js`, the global `fetch` is monkey-patched so relative `/api/...` calls made *inside* synced modules (`tts.js`, `persona.js`) get rewritten to `apiBase`, since `tauri://localhost` has no `/api` routes.

**Persona corpus encryption**: `src/ai/persona-assets.js` (dev plaintext) is XOR-encrypted by `scripts/encrypt-assets.mjs` into `src-tauri/assets/persona-assets.enc`, embedded at compile time (`build.rs` panics if missing), and decrypted at runtime by `src-tauri/src/persona_assets.rs`, served via `/api/assets`. The `.enc` is gitignored and generated on the fly; the plaintext never ships in the installer (`bundle-assets.mjs` strips it during `tauri build`, restores after).

**Settings** persist as `settings.json` in the platform app-config dir (`app_config_dir()`, see `settings_path`/`load_settings`/`save_settings` in `lib.rs`). Held in `AppState`; the `Settings`/`AiConfig` structs use `#[serde(rename_all = "camelCase")]`. Keys, persona, avatars stay local — never committed or uploaded. Saving re-registers the global shortcut and repositions the chat window live.

**Roster** (`shared/roster.json`) is the single source of pet ids/labels, shared between the Rust tray (embedded via `include_str!`) and the frontend. Current pets: `kxyy-cyber` (赛博元元), `kxyy-miaojiang` (苗疆元元, default).

## Animation engine

`src/pet-engine.js` is the ported webmeji `Creature`. `src/pet-config.js` registers each pet with `registerPet(id, { frames: {...}, ... })`. Frame counts **must match** the upstream `config.js`. Each pet needs these action dirs under `src/assets/pets/<id>/`: `walk / sit / dance / trip / forcethink / pet / drag / falling / fallen / climbSide / climbTop / hangstillSide / hangstillTop / jump`, each holding `<action>_NN.png`.

## Adding a pet

1. Add `{ "id", "label" }` to `shared/roster.json` `pets`.
2. `registerPet(...)` in `src/pet-config.js` with frame counts matching upstream.
3. Provide the action frame dirs above (or `npm run sync-assets`).

## Sync caveat

If upstream changes the `/api/chat` request/response contract, manually update **both** `src-tauri/src/api.rs` and `src/chat.js`. After `sync-ai` (which overwrites only `persona.js` / `tts.js` / `persona-assets.js` / `stickers.js` + sticker assets — **not** `realtime.js`, the audio Worklets, `realtime-trace.js`, `voice-volume.js`, or `avatars.js`), re-run `npm run encrypt-assets`.

## Release

Pushing a `vX.Y.Z` tag triggers `.github/workflows/release.yml` (Windows NSIS + macOS aarch64/x64 dmg). Bump version in **both** `package.json` and `src-tauri/tauri.conf.json` (and keep `Cargo.toml`/`Cargo.lock` in sync). App icons are generated via `npx tauri icon build/icon-square.png` (苗疆元元头部特写源图；`src-tauri/icons/` is the generated set — commit both when regenerating).
