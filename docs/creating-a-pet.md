# 创建一张新的人格卡

> 从零制作一张角色人设卡，让桌宠变成你想要的任何角色。

## 最简流程（30 分钟）

### 1. 创建卡片目录

```bash
mkdir -p persona-cards/my-character
```

### 2. 写 persona-card.json

最低要求只有 3 个字段：

```json
{
  "meta": {
    "card_id": "my/character",
    "name": "我的角色",
    "version": "0.1.0",
    "created": "2026-07-11",
    "author": "你的名字",
    "schema_version": "1.0",
    "description": "一句话描述",
    "language": "zh-CN"
  },
  "identity": {
    "name": "角色名",
    "gender": "男/女",
    "age": "年龄或年龄段",
    "occupation": "职业",
    "personality": ["性格标签1", "性格标签2"],
    "background": "一两句话的背景故事"
  },
  "system_prompt": "你是一个... 你的说话风格是... 你的知识范围是..."
}
```

### 3. 校验

```bash
npm run validate-card -- persona-cards/my-character/persona-card.json
```

### 4. 打包到 App

```bash
npm run encrypt-assets -- --card persona-cards/my-character/persona-card.json
npm run tauri dev
```

## 完整字段参考

详见 `scripts/persona-distill/schema/persona-card.schema.json`。

| 字段 | 必需 | 说明 |
|---|---|---|
| `meta` | ✅ | 卡片元数据（ID、版本、作者、标签） |
| `identity` | ✅ | 角色身份 |
| `system_prompt` | ✅ | LLM system prompt，直接注入对话 |
| `few_shot` | | Few-shot 对话示例 |
| `lore` | | 世界观/背景知识（结构化） |
| `corrections` | | 事实修正列表 |
| `personality_dimensions` | | 9 维度蒸馏分析（需蒸馏管道产出） |
| `source_materials` | | 素材来源说明 |

## 利用蒸馏管道

如果有角色的直播/语音素材（WAV），可以用蒸馏管道自动提取说话特征：

```bash
# 安装依赖
cd scripts/persona-distill
.\setup.ps1

# 一键蒸馏
python tools/pack.py --input sample_wav/ --name my-character

# 整合到人格卡
npm run update-persona
```

## 角色模板

### 直播主播型（类似开心元元）

```json
"lore": {
  "schedule": { "open_time": "20:30", "close_time": "00:30" },
  "weekly_schedule": { "rest_day": "周一", "rest_day_note": "休息日说明" },
  "live_show_flow": {
    "stages": [
      { "name": "开场", "note": "..." },
      { "name": "唠嗑", "note": "..." }
    ]
  },
  "fans": { "nickname": "粉丝称呼" },
  "known_big_fans": []
}
```

### 日常陪伴型（虚拟朋友/助手）

```json
"lore": {
  "schedule": { "open_time": "全天", "note": "随时在线" }
}
```

不需要 `live_show_flow` 和 `weekly_schedule`，`computeLiveContext` 会自动跳过。

### 角色扮演型（游戏/动漫角色）

```json
"lore": {
  "world": "世界观描述",
  "faction": "所属阵营",
  "relationships": [
    { "name": "角色B", "relation": "关系描述" }
  ],
  "abilities": ["技能1", "技能2"]
}
```

`identity.background` 里写背景故事，`lore` 里放结构化世界设定。

## 测试

1. 先不打包进 App，用 chat.py 直连 DeepSeek 测试：

```bash
python scripts/chat.py --card persona-cards/my-character/persona-card.json
```

2. 确认对话风格符合预期后再打包。

## 常见问题

**Q: system_prompt 写多长合适？**  
A: 500-3000 字比较好。太短模型没特征，太长稀释关键指令。

**Q: 蒸馏维度是什么？必须加吗？**  
A: 不必须。它是从真人素材中自动提取的说话习惯（口头禅、句式、口吃等），没有真人素材就跳过。

**Q: 怎么切换人格卡？**  
A: 重新运行 `npm run encrypt-assets -- --card <path>` 然后重启 App。
（App 内动态切换功能开发中，见 `docs/roadmap-ai-roleplay.md`）
