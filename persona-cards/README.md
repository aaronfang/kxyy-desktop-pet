# 人格卡仓库 (Persona Cards)

> 本目录存放标准化的角色人设卡片（Persona Card），每张卡片是一个自包含的 JSON 文件，包含角色定义、对话示例、背景知识和可选的蒸馏分析数据。

## 目录结构

```
persona-cards/
├── README.md                        # 本文件
└── <card-id>/                       # 每张卡片一个子目录
    ├── persona-card.json            # 人格卡主文件（JSON Schema v1）
    ├── README.md                    # 卡片说明（作者、来源、使用方法）
    └── voiceprint/                  # （可选）声纹参考音频
        └── reference.wav
```

## 人格卡格式

每张人格卡遵循 `scripts/persona-distill/schema/persona-card.schema.json` 定义的 JSON Schema v1。

### 核心字段

| 字段 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `meta` | object | ✅ | 卡片元数据（ID、版本、作者、标签等） |
| `identity` | object | ✅ | 角色身份（姓名、性别、年龄、职业等） |
| `system_prompt` | string | ✅ | 完整的 LLM system prompt，可直接注入 |
| `few_shot` | array | | Few-shot 对话示例 `[{role, content}]` |
| `lore` | object | | 世界观/背景知识（结构化） |
| `corrections` | object | | 事实修正列表 |
| `personality_dimensions` | object | | 9 维度蒸馏分析数据（可选） |
| `voiceprint` | object | | 声纹参考信息（可选） |
| `source_materials` | array | | 素材来源列表 |

### personality_dimensions（蒸馏管道产出）

| 维度 | 说明 |
|------|------|
| `catchphrases` | 口头禅/高频用语及出现次数 |
| `sentence_style` | 句式风格（句长、结构偏好、节奏、连接词、填充词） |
| `emotional_pattern` | 情绪表达模式（开心/生气/害羞/感动/调侃/安慰） |
| `interaction_pattern` | 互动模式（被夸/被怼/隐私/冷场/熟客vs新人） |
| `dialect_features` | 方言特征（方言词、语法、发音） |
| `self_reference` | 自我指称方式（自称变化、自嘲模式） |
| `audience_address` | 对观众/粉丝的称呼模式 |
| `stuttering_patterns` | 口吃/重复模式及模仿建议 |
| `topic_preference` | 话题偏好（高频话题、切换模式、回避） |

## 如何使用人格卡

### 创建人格卡

**方法一：手工编写**

直接按 Schema 创建 JSON 文件，至少填写 `meta`、`identity`、`system_prompt`，然后用校验工具检查：

```bash
python scripts/persona-distill/tools/validate_card.py persona-cards/my-character/persona-card.json
```

**方法二：从现有 persona-assets.js 转换**

如果你的项目已有 `persona-assets.js`（类似本项目的格式），使用转换工具：

```bash
python scripts/persona-distill/tools/convert_from_assets.py
```

**方法三：从直播回放蒸馏生成**

准备 WAV 音频素材后，一键蒸馏+打包：

```bash
python scripts/persona-distill/tools/pack.py --input sample_wav/ --name my-character
```

### 在校验卡片

```bash
# 校验单张
python scripts/persona-distill/tools/validate_card.py persona-cards/my-character/persona-card.json

# 批量校验
python scripts/persona-distill/tools/validate_card.py --all persona-cards/
```

### 在 App 中使用人格卡

> **注意**：当前 App 尚不支持动态加载人格卡（规划中）。以下为未来集成路径。

1. **加载**：App 读取 `persona-card.json` → 提取 `system_prompt` + `few_shot` + `lore` + `corrections`
2. **注入**：替换 LLM 调用的 messages[0].content
3. **切换**：用户可在设置中选择不同人格卡，无需重新编译

详细集成方案见 `docs/roadmap-ai-roleplay.md` 第 8 节。

## 分享人格卡

人格卡是自包含的 JSON 文件。分享时只需打包整个卡片目录：

```
my-character/
├── persona-card.json    # 所有内容在此文件中
└── README.md            # 说明文档
```

接收方将目录放入自己的 `persona-cards/` 即可使用。

## Schema 版本

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0 | 2026-07-11 | 初始版本，9 维度 personality_dimensions |

## 相关文档

- [JSON Schema 定义](../scripts/persona-distill/schema/persona-card.schema.json)
- [蒸馏管道参考文档](../docs/roadmap-ai-roleplay.md#8-人设蒸馏管道参考文档)
- [转换工具](../scripts/persona-distill/tools/convert_from_assets.py)
- [校验工具](../scripts/persona-distill/tools/validate_card.py)
- [打包工具](../scripts/persona-distill/tools/pack.py)
