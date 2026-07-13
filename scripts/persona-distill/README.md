# 元元人设蒸馏管道

从直播回放 WAV → 结构化人格配置的本地全链路蒸馏工具。

## 架构

```
WAV (直播回放, 1.5h/条)
  │
  ├─ Step 1: [Demucs] 去除背景音乐 → vocals.wav
  │
  ├─ Step 2: [FSMN-VAD + CAM++] 说话人分离 → 元元语音段
  │    策略: 声纹匹配（需参考样本）或聚类（最多发言者=元元）
  │
  ├─ Step 3: [SenseVoice] ASR 转录 → 带时间戳的文本
  │    输出: .txt (纯文本) + .transcript.json (含情感标签)
  │
  ├─ Step 4: [LLM] 8 维度人格模式提取
  │    口头禅 | 句式 | 情感表达 | 互动模式 | 方言 | 自称 | 对粉丝称呼 | 话题偏好
  │
  └─ Step 5: [编译] 结构化 persona profile + 对比报告
       输出: persona_profile.json + comparison_report.json
```

## 快速开始

### 1. 环境安装

```powershell
cd scripts/persona-distill
powershell -ExecutionPolicy Bypass -File setup.ps1
```

一键完成：Python 3.11 venv → torch (cu128 for RTX 5080) → funasr → demucs → llama-cpp-python。

### 2. 准备输入数据

```powershell
# 把直播回放 WAV 放入此目录
cp your_live_stream.wav sample_wav/

# 可选：放入元元纯净语音样本（10-30秒，尽量无BGM无他人声音）
cp yuanyuan_clean.wav voiceprint/
```

### 3. 编辑 config.yaml（如需要）

```yaml
paths:
  # 如果有元元参考声纹
  reference_wav: "voiceprint/yuanyuan_clean.wav"

distill:
  llama_cpp:
    # 下载 Qwen3-14B GGUF 后填写路径
    model_path: "C:/models/Qwen3-14B-Q4_K_M.gguf"
```

### 4. 一键运行

```powershell
# 处理单个文件
.venv-distill/Scripts/python.exe pipeline.py run --input sample_wav/live_001.wav

# 批量处理整个目录
.venv-distill/Scripts/python.exe pipeline.py run --dir sample_wav/

# 逐步运行（调试）
.venv-distill/Scripts/python.exe pipeline.py denoise --input sample_wav/live_001.wav
.venv-distill/Scripts/python.exe pipeline.py diarize --input output/vocals/htdemucs/live_001/vocals.wav
# ... 依此类推

# 查看进度
.venv-distill/Scripts/python.exe pipeline.py status
```

### 5. 查看结果

```
output/
├── vocals/            ← Demucs 分离后的人声
├── speaker/           ← 元元语音段 WAV + JSON 元数据
├── transcript/        ← SenseVoice 转录文本
├── distillation/      ← LLM 提取的 8 个维度结果
│   ├── catchphrases.txt
│   ├── sentence_style.txt
│   ├── emotional_pattern.txt
│   ├── interaction.txt
│   ├── dialect.txt
│   ├── self_reference.txt
│   ├── audience_address.txt
│   ├── topic_preference.txt
│   └── distillation_result.json
└── compile/
    ├── persona_profile.json     ← **最终产物**：结构化人设配置
    └── comparison_report.json   ← 蒸馏结果 vs 当前 system prompt 对比
```

---

## 关键技术选型

### 多说话人处理：如何从直播中分离元元？

直播回放有两个干扰源：**背景音乐** 和 **非元元说话者**。

| 步骤 | 工具 | 解决的问题 |
|---|---|---|
| 背景音乐去除 | **Demucs** (htdemucs) | 分离人声轨，去除 BGM/音效。基于 U-Net + Transformer，SDR 9.20 dB，当前业界最好 |
| 说话人分离 | **CAM++** (FunASR) | 为每个语音段提取 512 维说话人嵌入向量 → 余弦相似度聚类 → 最大类 = 元元 |
| 声纹验证 (可选) | **CAM++** | 如果提供元元纯净语音样本，逐段匹配声纹，比聚类更准 |

**SenseVoice 本身不包含说话人分离**，但 FunASR 生态的 CAM++ 模型完美解决这个问题，且两者共享 torch 后端，零额外依赖。

### 为什么不直接用 Whisper？

| 维度 | Whisper large-v3 | SenseVoice |
|---|---|---|
| 中文准确率 | 好 | **更好的中文优化** |
| 速度 (GPU) | ~10x 实时 | **~170x 实时** |
| 情感检测 | ❌ | ✅ 内建 8 种情感标签 |
| 音频事件检测 | ❌ | ✅ 可识别掌声/笑声/音乐 |
| 模型大小 | 3GB+ | ~300MB |
| 逆文本正则化 (ITN) | ❌ | ✅ 自动标准化数字/标点 |

对于中文直播场景，SenseVoice 各方面都更优。

### LLM 蒸馏：用什么模型？

| 模型 | 运行位置 | 内存需求 | 蒸馏质量 | 推荐度 |
|---|---|---|---|---|
| **Qwen3-14B Q4_K_M** | RTX 5080 (16GB) | ~10GB VRAM | 很好 | ⭐⭐⭐ 推荐 |
| **Qwen3-32B Q4_K_M** | MBP M4 (48GB) via MLX/Metal | ~19GB 统一内存 | 极好 | ⭐⭐ 质量更高但慢 |
| Ollama qwen3:14b | RTX 5080 | ~10GB | 好 | ⭐ 最简单但灵活性低 |

**推荐方案**：Qwen3-14B Q4_K_M 在 RTX 5080 上。需要下载：

```powershell
# 从 HuggingFace 下载
huggingface-cli download Qwen/Qwen3-14B-GGUF Qwen3-14B-Q4_K_M.gguf --local-dir C:/models
```

---

## 资源预估

### 单条 1.5 小时直播回放的处理时间（RTX 5080）

| 步骤 | 时间 | 说明 |
|---|---|---|
| Demucs 降噪 | ~10 分钟 | htdemucs, segment=8s |
| VAD + 说话人分离 | ~3 分钟 | FSMN-VAD + CAM++ |
| SenseVoice ASR | ~2 分钟 | 仅转写元元部分（~60 分钟语音） |
| LLM 蒸馏 | ~15 分钟 | Qwen3-14B, 分块提取 8 维度 |
| **单条总计** | **~30 分钟** | |
| **660 条总计** | **~330 小时** | 可分批发，跑几天即可 |

### 显存需求

| 组件 | 显存占用 (RTX 5080 16GB) |
|---|---|
| Demucs (htdemucs, segment=8) | ~6-8 GB |
| CAM++ 说话人嵌入 | ~2 GB |
| SenseVoice-small | ~2 GB |
| Qwen3-14B Q4_K_M llama.cpp | ~10 GB |
| **峰值** | **~12 GB**（Demucs + SenseVoice 不同时运行） |

---

## 配置调优

### 说话人分离阈值

```yaml
diarize:
  similarity_threshold: 0.6  # 调高 → 更严格匹配元元，可能漏掉；调低 → 更多段被识别为元元
```

建议先跑一条，查看 `.diarize.json` 中的说话人分布和相似度分数，再调整。

### LLM 提取维度的增删

在 `config.yaml` 中修改 `distill.dimensions` 列表，去掉不需要的维度，或在 `prompts/extraction.yaml` 中添加自定义维度。

### 不使用 Demucs 降噪

如果回放本身没有背景音乐，可以跳过：

```yaml
denoise:
  enabled: false
```

---

## 输出格式说明

`persona_profile.json` 的结构：

```json
{
  "meta": {
    "version": "1.0",
    "dimensions_extracted": ["catchphrases", "sentence_style", ...]
  },
  "persona": {
    "catchphrases": {
      "raw": "LLM 原始输出",
      "structured": {
        "phrases": [
          {"phrase": "咱就是说", "count": 47}
        ]
      }
    },
    "sentence_style": { "raw": "...", "structured": {...} },
    ...
  }
}
```

这个格式可以直接替换 `persona-assets.js` 中的 `systemPrompt` 字段，也可以作为后续 structured prompt（方案 C）的基础数据。

---

## 常见问题

**Q: Demucs 报 CUDA out of memory?**
A: 减小 `config.yaml` 中的 `denoise.segment` 参数（从 8 → 4）。

**Q: SenseVoice 模型下载失败？**
A: 模型下载到 `~/.cache/modelscope/`，首次运行需要网络。可用 `export MODELSCOPE_CACHE=/path/to/cache` 指定缓存目录。

**Q: llama-cpp-python 安装失败？**
A: 确保安装了 CMake 和 MSVC 构建工具。或者改用 Ollama 模式（在 `config.yaml` 中设置 `distill.engine: "ollama"`）。

**Q: 想在后端再加一个说话人确认步骤？**
A: 可以。在 `voiceprint/` 目录放入干净的元元语音样本，pipeline 自动启用声纹匹配。
