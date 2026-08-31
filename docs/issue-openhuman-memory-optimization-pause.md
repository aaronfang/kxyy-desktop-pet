# Issue: 暂缓 OpenHuman 记忆体优化

状态：Paused  
创建日期：2026-08-31  
封存分支：`codex/openhuman-memory-pause`  
封存提交：`1216f4c`

## 背景

本轮工作借鉴 OpenHuman 的记忆组织思路，扩展了 Goal/TODO、Memory SourceCard、确定性分块、实体与主题索引、摘要适配器、解释性展示，以及聊天和实时语音的来源写入边界。

用户决定暂时搁置这条优化路线，不将这些修改合入 `main`。

## 已封存内容

- Goal/TODO 状态机、scope、revision、提醒 gate 和设置页管理入口
- Memory v3 来源卡、分块、chunk job、实体 alias、walk、summary、daily digest 和 explainability 基础
- 普通聊天完整回合与实时语音播放完成 receipt 的 SourceCard 接入
- 对应的 JS、Python、Rust 自动化测试与 todo 跟踪
- Goal 持久化失败时的内存/磁盘一致性修复

## 当前状态

- 所有上述改动仅存在于 `codex/openhuman-memory-pause`
- `main` 不包含本轮未提交的 OpenHuman 改动
- 最近验证：JS、Python、资源校验、Rust 测试和 `cargo check` 均通过
- 工作区保留一个未纳入提交的既有文件：`scripts/voice-ab/__pycache__/synth_volc.cpython-314.pyc`

## 恢复方式

恢复时从 `codex/openhuman-memory-pause` 继续评估，不要直接把整条分支无审查合入主干。优先重新审查：

1. Goal 与 Memory 的跨事务恢复和 scope 展示
2. 文档/外部来源是否需要产品化入口
3. entity/summary/digest 的 card/user 灰度开关
4. 后台调度、批量筛选、导出预览和真实 App 验收

恢复前重新运行 `npm run test:gate`，并确认主干期间的数据库 schema、设置合同和上游同步没有变化。
