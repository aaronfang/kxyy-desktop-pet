# OpenHuman 借鉴能力实施路线图

日期：2026-08-30  
状态：P0–P6 基础实现完成，P7/P8 待发布候选验收  
适用范围：元元桌宠的可靠性、记忆管理、后台任务和可观察性改进  
参考研究：[research-openhuman-reuse-2026-08-27.md](./research-openhuman-reuse-2026-08-27.md)

## 0. 目标与执行方式

本路线图把 OpenHuman 中值得借鉴的机制，改造成适合当前 Tauri + Rust + Web 前端 + Python 语音服务的独立实现。目标不是复制 OpenHuman，也不是一次性接入完整 Agent Harness，而是最终交付一个用户可以直接上手测试的稳定版本。

执行规则：

- 每个阶段都是一个可独立验证的纵向切片，但默认连续完成，不要求用户在阶段之间手动测试。
- 每个切片遵循 Red → Green：先写行为测试并确认失败，再实现最小改动，再运行受影响测试和完整 `npm run test:gate`。
- 现有 Memory、实时语音、persona、fresh-topic 和 provider 协议保持向后兼容；除非本路线图明确列出，否则不改其行为。
- 所有新增持久化数据必须有 schema version、幂等键、删除/清空路径和损坏恢复测试。
- 所有新增前端状态必须有 Rust IPC/事件合同测试；所有跨进程状态必须有旧消息、迟到消息、取消、重启和重复请求测试。
- 只借鉴设计，独立实现；不链接或复制 OpenHuman 的 GPL-3.0-only 代码和依赖。

## 1. 最终用户可感知的目标

完成路线图后，用户应能看到以下变化：

1. 关闭或重启应用后，正在处理的聊天/记忆任务会显示为已中断，并可安全重试。
2. 后台任务、服务启动、记忆整理和失败原因进入可查看的 Activity 收件箱，不再只依赖一次性 toast。
3. 设置升级不会丢失旧字段；损坏配置可以回滚或从备份恢复。
4. 语音、记忆、文本 provider 和 fresh-topic 状态统一显示“未安装/启动中/可用/忙碌/故障/关闭”等能力状态。
5. 重试和重连不会重复执行设置写入、语音控制或后台任务。
6. 日常聊天、深度分析、图片理解、记忆压缩可以按任务类型选择 provider，而不把具体模型名散落在业务逻辑中。
7. 失败的自动化测试会留下脱敏截图、DOM/状态快照和 mock 请求，便于无需用户复现即可定位问题。

## 2. 阶段总览与依赖

```text
P0 基线与公共合同
  ├─ P1 结构化错误 + 幂等键
  ├─ P2 配置迁移、备份与回滚
  └─ P3 回合/任务状态快照
        ├─ P4 Activity 收件箱与后台调度门
        └─ P5 能力注册表 + 任务型模型路由
                └─ P6 目标/待办看板
                        └─ P7 可选沙箱、导出与外部审批
                                └─ P8 发布候选整体验收
```

P1、P2、P3 可在 P0 后并行设计，但实现时建议按编号顺序，以便先稳定公共错误和持久化合同。P6/P7 不得阻塞前面可靠性能力的发布。

## 3. P0：基线、合同和测试夹具

### 目标

建立公共类型和测试工具，避免后续每个模块各自发明状态、错误和幂等规则。

### 实施内容

- 定义 provider-neutral `OperationError`：`kind`、`retryable`、`userAction`、`operationId`，禁止前端依赖错误字符串。
- 定义统一 `OperationId`/`IdempotencyKey` 生成和校验规则；敏感内容不得进入 key。
- 定义 `CapabilityStatus` 和 `CapabilitySnapshot`：driver、status、contractVersion、capabilities、fallbackReason（去敏）。
- 定义持久任务最小状态：`pending/running/succeeded/failed/cancelled/interrupted`。
- 增加隔离临时 workspace、可控时钟、可控 UUID 和故障注入测试夹具。
- 为前端 IPC、Rust command/event、Python 本地服务各准备旧版本/未知字段 fixture。

### 自动验收

- Rust：错误序列化、未知枚举、默认值、敏感字段剥离、幂等 key 稳定性。
- JS：错误到 UI 文案/动作的映射，旧 payload 兼容，未知状态安全降级。
- Python：任务状态和取消边界纯逻辑测试。
- `npm run test:gate` 必须保持全绿。

### 完成门槛

没有模块继续使用“匹配错误字符串决定行为”；公共合同文档和测试夹具已可被后续阶段复用。

## 4. P1：结构化错误与幂等重试

### 目标

让重复请求、迟到消息、断线重连和 provider 暂时失败可安全处理。

### 实施内容

- 将设置保存、Memory job、语音控制、服务启动/停止、fresh-topic refresh 的错误归一化到 P0 合同。
- 对写操作增加幂等 key；重复请求返回第一次结果，不重复副作用。
- 将错误分成参数/权限/资源不存在/暂时不可用/超时/取消/内部故障。
- 为 retryable 错误提供固定退避和次数上限；不可重试错误不自动循环。
- 前端显示“重试/打开设置/恢复备份/忽略”中的正确动作。

### 自动验收

- 正常、重复、乱序、超时、取消、旧 generation、服务退出后重连。
- 同一设置写入只产生一次落盘；同一语音控制只产生一次状态变更。
- Memory job 重试不产生重复 episode/fact/commitment。
- 运行 JS/Python/Rust 受影响测试后运行 `npm run test:gate`。

## 5. P2：配置 schema 迁移、备份与回滚

### 目标

新增设置字段时不丢用户配置；坏配置不会让应用无法启动。

### 实施内容

- 给 `settings.json` 增加独立 schema version 和顺序迁移 runner。
- 每个迁移必须幂等、可测试、只在成功保存后提升版本。
- 保存采用临时文件 + 原子替换；保留上一份可恢复副本。
- 对非法值执行 allow-list 归一化，对未知字段按兼容策略保留或忽略。
- 提供设置页最小恢复入口：查看版本、创建备份、恢复上一份、导出脱敏设置。
- 明确 API key、模型路径和缓存的迁移边界：可迁移数据与必须重新输入的数据分离。

### 自动验收

- 从当前旧版本 fixture 逐版本迁移到最新版本，再重复迁移结果不变。
- 中途写入失败、磁盘满、畸形 JSON、未知版本、高版本配置均有安全结果。
- 恢复前自动备份；恢复失败自动回滚；恢复后 `get_settings` 与前端状态一致。
- 运行 Rust settings 测试、前端设置测试、资源合同测试和 `npm run test:gate`。

## 6. P3：回合/任务状态快照与冷启动恢复

### 目标

让用户知道应用重启前进行到哪一步，并能安全恢复。

### 实施内容

- 新增本地原子快照存储，按 operation/thread 保存当前阶段、进度摘要、generation、更新时间和可恢复动作。
- 只在 iteration/tool/job 边界刷盘，避免实时流式音频或文本造成频繁写盘。
- 启动时把非终态快照标记为 `interrupted`；完成快照短期保留用于回放。
- 快照只保存脱敏状态和 text-free 摘要；不保存 API key、PCM、完整 persona 或敏感原文。
- 聊天、Memory consolidation、本地语音服务生命周期各接入一个最小 adapter。
- 前端增加“处理中/已中断/可重试/已完成”状态展示和清除入口。

### 自动验收

- 正常完成、窗口关闭、进程退出、重启恢复、重复重试、取消、过期 generation。
- 快照原子写入；半文件、损坏 JSON、并发写入不会破坏旧快照。
- 清除 thread/user 时同步清除快照，不能留下跨用户状态。
- 运行 Rust/JS 生命周期测试、现有 realtime tests 和 `npm run test:gate`。

## 7. P4：Activity 收件箱与后台调度门

### 目标

统一呈现后台发生的事情，并避免后台工作抢占通话、前台交互或电池。

### 实施内容

- 新增 SQLite-backed activity 表：category、status、operationId、createdAt、updatedAt、retryable、redacted summary、deep link。
- 事件先持久化再广播；应用关闭期间产生的事件在下次启动可读取。
- 去重窗口和上限固定；支持 unread/read/acted/dismissed/expired。
- 增加单一 scheduler gate：通话中、用户忙碌、低电量或资源不足时延后低优先级任务。
- 将 Memory consolidation、fresh-topic refresh、VAD shadow、voice warmup 接入 gate；不得改变实时 RMS/ASR 决策。
- 设置页增加最小 Activity 列表、重试、忽略、清理过期项。

### 自动验收

- 事件持久化后广播；广播失败不丢数据库记录。
- 重复事件折叠；达到容量上限只删除最旧项。
- gate 在通话、低电量、忙碌和恢复后正确暂停/放行。
- retry 只能触发一次 operation；通知不自动变成语音主动发言。
- 运行 Rust SQLite/调度测试、前端状态测试、跨模块 IPC 测试和 `npm run test:gate`。

## 8. P5：能力注册表与任务型模型路由

### 目标

让 provider 选择按任务类型配置，并真实反映当前能力。

### 实施内容

- 定义 allow-listed task hints：`chat-fast`、`reasoning`、`vision`、`memory-summary`、`local-offline`、`voice`。
- 将 hint 映射到 DeepSeek/Ollama/本地服务配置；业务逻辑只请求 hint，不直接写具体模型名。
- 路由前校验 provider 是否支持文本、图片、embedding、流式等能力。
- 所有 provider 状态汇总到 `capability_snapshot`，前端展示固定枚举和 fallback 原因。
- 旧设置字段继续兼容，未知 hint 使用安全默认，不把敏感语音自动切到云端。

### 自动验收

- 每个 hint 正常映射、空配置 fallback、provider 不支持能力、模型不存在、网络失败。
- 图片请求不能路由到不支持 vision 的模型；local 模式不能产生网络请求。
- 状态快照不泄露模型密钥、URL、路径或原始错误。
- 运行 JS provider tests、Rust capability tests、Python service handshake tests 和 `npm run test:gate`。

## 9. P6：长期目标、会话目标与轻量待办

### 目标

把“用户长期想做什么”和“当前这次要完成什么”分开，提升陪伴连续性。

### 实施内容

- 在现有 Memory commitments 之上增加目标/任务视图，不复制第二套事实库。
- 第一版只提供 `todo/in_progress/done/blocked/cancelled`，固定上限和过期策略。
- 每个会话最多一个 active objective；任务卡可带验收条件、阻塞原因、来源和 operationId。
- 语音主动行为只读取用户明确允许的目标/承诺；不能因为任务存在就自动发言。
- 设置页提供列表、状态更新、删除和“不要再提醒”。

### 自动验收

- 创建/编辑/完成/取消/过期、重复提交、跨 card/user 隔离、重启恢复。
- 删除目标后 recall、活动通知和主动语音队列均不再引用它。
- 任务状态变化不修改 persona/system/skill 规则。
- 运行 Memory/JS/Rust 集成测试和 `npm run test:gate`。

## 10. P7：可选外部操作审批、文件沙箱与 Markdown 导出

这是增强阶段，只有 P1–P6 稳定后才实施。

### 10.1 外部操作审批

只为明确的外部副作用建立 pending action：发送消息、写用户指定目录、执行命令。默认 deny；重启后不能自动恢复执行。审批记录必须脱敏、有 TTL、有审计结果，并与实时语音状态机隔离。

### 10.2 子进程目录沙箱

只有在产品真正允许脚本/文件工具后才接入。审批解决“用户是否同意”，沙箱解决“进程实际能看到什么”；两者不能互相替代。macOS/Windows 必须分别做真实验证。

### 10.3 Markdown/Obsidian 导出

作为 Memory 备份和可读导出，不作为第二事实库。导出前执行 card/user scope、敏感等级、删除和 retention 规则；导入必须走显式用户操作和幂等 ingest。

### 自动验收

- approve/deny/timeout/restart/重复决定。
- 沙箱路径穿越、符号链接、只读目录、进程退出。
- 导出脱敏、导出后删除、重复导入不重复记忆。
- 运行 Rust 安全测试、资源测试、平台 E2E；失败不得通过放宽权限解决。

## 11. P8：发布候选整体验收

### 自动门禁

每个阶段完成时运行窄测试、受影响集成测试，然后运行：

```bash
npm run test:gate
```

发布候选还必须运行：

```bash
npm test
npm run test:python
npm run test:resources
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo check --manifest-path src-tauri/Cargo.toml
npm run build
```

所有输出、版本号、schema version、commit 和构建产物路径写入发布记录。测试失败必须修复后重新跑完整受影响门禁，不能只重跑到偶然通过。

### 最小人工验收

自动测试完成后，只保留必须由真实应用/OS 验证的场景：

- macOS：托盘、透明宠物、聊天窗口、设置窗口、权限拒绝、重启恢复、Activity 列表和一次本地语音通话。
- Windows：NSIS 安装包、WebView2、设置迁移、服务启动恢复、语音通话和窗口生命周期。
- 两个平台：断网/服务退出、重试不重复、诊断无敏感信息、升级后旧设置保留。

人工验收不是逐阶段介入，而是所有自动阶段完成后的单次发布候选检查。当前机器无法运行的 Windows 场景必须标记为“未运行”，不能用 macOS 结果代替。

## 12. 阶段完成记录模板

每个阶段完成后在 PR/发布记录中填写：

- 阶段编号与版本号；
- 新增行为测试及正常/边界/异常/取消/恢复覆盖；
- 实际运行的窄测试、集成测试和 `npm run test:gate` 结果；
- 是否涉及 macOS/Windows/打包资源，以及实际运行的平台；
- 数据迁移、删除、脱敏和回滚验证结果；
- 未运行项目、原因和发布前补测命令；
- 已知风险和下一阶段入口。

## 13. 明确不纳入本路线图

完整 OpenHuman/TinyAgents/TinyMemory 依赖、100+ OAuth、17 消息渠道、MCP/Skills marketplace、tiny.place/x402、远程 agent economy、会议接入、默认连续屏幕/系统音频观察，以及任何会绕过当前 persona、Memory scope、实时音频和隐私边界的自动化功能，都不属于本次改进目标。
