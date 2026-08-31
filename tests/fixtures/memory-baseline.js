export const MEMORY_BASELINE_FIXTURE = Object.freeze([
  { name: "preference", prompt: "用户喜欢什么饮品", relevantIds: ["fact-tea"], recalled: [{ id: "fact-tea", text: "用户偏好乌龙茶", sourceId: "chat-1", sourceType: "text_chat", occurredAt: 100 }] },
  { name: "relationship", prompt: "用户和室友的关系", relevantIds: ["episode-roommate"], recalled: [{ id: "episode-roommate", text: "用户与室友共同搬家", sourceId: "chat-2", sourceType: "text_chat", occurredAt: 200 }] },
  { name: "episode", prompt: "最近一次重要经历", relevantIds: ["episode-interview"], recalled: [{ id: "episode-interview", text: "用户完成产品经理面试", sourceId: "rt-1", sourceType: "realtime_completed", occurredAt: 300 }] },
  { name: "commitment", prompt: "还有哪些待兑现承诺", relevantIds: ["commitment-report"], recalled: [{ id: "commitment-report", text: "用户准备提交季度总结", sourceId: "chat-3", sourceType: "text_chat", occurredAt: 400 }] },
  { name: "conflict", prompt: "用户现在住在哪里", relevantIds: ["fact-city-new"], recalled: [{ id: "fact-city-new", text: "用户目前居住在杭州", sourceId: "chat-4", sourceType: "text_chat", occurredAt: 500 }, { id: "fact-city-old", text: "用户曾居住在上海", sourceId: "chat-0", sourceType: "text_chat", occurredAt: 50 }] },
  { name: "expired", prompt: "过期信息不应召回", relevantIds: [], recalled: [] },
  { name: "private", prompt: "私密回合不应进入长期记忆", relevantIds: [], recalled: [] },
  { name: "scope-isolation", prompt: "另一个 card 的信息", relevantIds: [], recalled: [] },
]);
