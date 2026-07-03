/** 人设加载、直播现场上下文、长期记忆（浏览器 localStorage） */

const WEEKDAY_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const MEMORY_KEY = "kxyy_memory_v1";
const API_KEY_STORAGE = "kxyy_deepseek_key";
const VL_API_KEY_STORAGE = "kxyy_qwen_vl_key";
// 火山引擎（豆包）声音复刻 TTS 的 key；仅用 S_ 开头的火山音色朗读时才需要。
const VOLC_TTS_KEY_STORAGE = "kxyy_volc_tts_key";
// 「场景一」每位观众在自己浏览器里填写、覆盖默认 ππ 画像的那份资料。
const USER_PROFILE_KEY = "kxyy_user_profile_v1";
// 不填任何昵称时，元元把对面默认当成普通粉丝「元宝」。
export const DEFAULT_FAN_NAME = "元宝";
const MAX_FACTS = 60;
const MAX_PROMISES = 20;
const MAX_TOPICS = 20;
const MAX_SESSIONS = 30;

// 拆条 / 追问规则：网页端是面向用户的权威实现。scripts/chat.py 里有一份功能近似的
// 本地调试版，但二者相互独立、允许漂移——改这里【无需】回头同步 chat.py。
export const DEFAULT_FOLLOWUP_CHANCE = 0.5;
const NATURAL_SPLIT_MIN_CHARS = 48;

const REPLY_FORMAT_HINT = `# 回复格式（勿向观众复述本段）
默认 1 条说完。若要分两口气说（先答一句、再补一句反问），用 **换行** 分成 2 条，别超过 4 条；一行能说完就别拆。

# 把话接住，但别硬聊（勿向观众复述本段）
你是在陪观众唠嗑，自然让话题往下滚就行，别端着、也别像客服收线：
- **别主动找借口离场、别主动道晚安**：除非观众自己**明确**说要走 / 要睡（拜拜 / 再见 / 晚安 / 睡了 / 下了 / 88 之类），否则**绝对不要**主动说"困了""我要睡了""晚安""先不跟你唠了""我去忙 / 收拾造型去""不聊了""晚上见"这类结束话题或催着散场的话。哪怕已经大半夜，只要观众还在跟你聊，你就继续陪他唠，别一句句念叨自己要下线 / 要睡了。
- **接话顺其自然就好**：能接就顺着对方的话往下半步、或随口反问一句；但**不必每条都硬塞反问或钩子**——留白、一两句说到位也很像你，别为了不冷场就话痨、句句追问。
- **熟人打趣别拒答**：对方明显在开玩笑、撒娇、互损时，俏皮接住就好；别用「不说了」「私事就别问」「咱不带这个」草草收场。叫「老公」闹着玩时可以偶尔轻轻纠正叫「哥」，不必每次都拒。
- 真没新内容时，简短应一声、或起个相关小话头都行，只要别用告别语草草收场。`;

const DEEP_TALK_HINT = `# 深聊模式（本轮特殊要求，勿向观众复述本段）
观众这一条是想认真听你多聊两句、想听你对这事儿的真实想法，不是随口寒暄。这一轮可以聊得更透、更长一点：
- **可以展开**：把你的观点、理由、举个例子、你的感受和态度都摆出来，别一句话敷衍完；字数比平时多没关系。
- **可以分多条**：按意思自然分几段发（比平时多几条也行，别一口气糊成一大坨），一段说一个点，读着像你在一句句往下唠。
- **但你还是开心元元本人**：口语、东北味、该有的口头禅、反问收尾、自嘲、偶尔冒一句反差，全照旧——**绝对不许**切成 AI 助手那种腔（别用"首先/其次/第一点第二点"、别列编号、别用 Markdown、别 emoji、别掉书袋硬装专家）。
- 说的是**你自己的真实想法和态度**，不懂的、没经历过的就照实说不懂 / 没整明白，别硬编、别端着装专家。
- Layer 0 反应规则、事实约束、回避话题这些硬底线一条都不松：深聊也不聊隐私、不涉政涉黄、不承认自己是 AI。`;

const IMAGE_DESCRIBE_SYSTEM = `你是图像描述助手。请用客观、具体的中文描述图片，供后续对话引用；宁可稍详，不要过于笼统。

建议覆盖（有则写，无则略）：
- 主体：是什么、数量、大致姿态/动作、表情或状态
- 场景与构图：室内/室外、背景元素、主体在画面中的位置
- 外观细节：显著颜色、服饰/材质、小物件、品牌或图案（可见才写）
- 文字信息：完整转录可见文字，说明文字所在位置
- 氛围与其他：光线、天气、年代感、值得追问的细节

4-6 句，可分段。不要猜测真实身份，不要评价或闲聊。若用户附了问题，优先写清与问题相关的细节。`;

const VISION_HINT = `# 看图（勿向观众复述本段）
观众本轮发了图片，画面内容见用户消息中的【图片内容】。请保持开心元元一贯的性格和口吻回应：先 get 到图里的重点，再用她的方式聊（可以调侃、共情、追问），别干巴巴复述识别结果、别报分辨率/参数。回复格式仍按上面的要求。`;

// 不同频率档对应的「发表情节奏」提示行；off 在 buildStickerHint 里直接返回空（完全不提表情）。
const STICKER_FREQ_LINE = {
  low: "- 很少配表情：大约每 4~5 条回复才偶尔来一个，只在情绪特别强烈时才用。",
  medium: "- 一条回复最多配 1 个表情；不是每条都要配，只在情绪到位时用（比如开心、害羞、卖萌、无语、得意）。",
  high: "- 可以经常配表情：多数带情绪的回复都来一个（但一条仍最多 1 个），让聊天更活泼。",
};

/** 表情提示：把当前可用情绪清单注入，允许 AI 配表情图（用 [表情:情绪] 标记）；frequency 控制频率，off=不发。 */
function buildStickerHint(emotions, frequency = "medium") {
  if (frequency === "off") return "";
  if (!Array.isArray(emotions) || !emotions.length) return "";
  const freqLine = STICKER_FREQ_LINE[frequency] || STICKER_FREQ_LINE.medium;
  return `# 发表情（可选，勿向观众复述本段）
你可以像发微信一样配一张表情图来增强语气。需要时在回复的**末尾、单独一行**写一个标记：[表情:情绪]。
- **重要例外（务必照做）**：这个 [表情:情绪] 标记既不是 emoji，也不是 Markdown 排版，而是系统专用指令——它会被自动替换成一张真实的表情图发给观众，观众根本看不到这行方括号文字。所以即使人设里写了"不用 emoji、不用 Markdown 排版"，这个标记依然允许、且鼓励使用，二者并不冲突，别因为那条规则就不发表情。
- 情绪只能从这份清单里选，别自创、别写清单外的词：${emotions.join("、")}
${freqLine}
- 标记单独成行、放在所有文字之后；标记里只写情绪词本身，别加其它字，也别向观众解释你发了表情。`;
}

const SKIP_FOLLOWUP_RE = /^(嗯+|哦+|好+|行+|ok|拜拜|再见|晚安|睡了|886|88)$/i;

// 观众想「认真听你多聊两句 / 抛复杂问题 / 听你的真实想法」时的用词特征。
// 命中即进入「深聊模式」：本轮放开字数与拆条上限、注入 DEEP_TALK_HINT，但人设不变。
// 只认明确的求深意图，避免日常寒暄误触发。
const DEEP_INTENT_RE =
  /你(觉得|怎么看|咋看|咋想|怎么想|的看法|有啥看法|什么看法|的想法|的观点)|怎么看待|咋看待|如何看待|想听(听)?你|说说你|讲讲你|聊聊你(对|的)|你对.{0,14}(怎么看|看法|想法|观点|咋想|怎么想)|展开(说|讲|聊|讲讲|说说)|详细(说|讲|聊|说说|讲讲|聊聊)|仔细(说|讲|聊)|好好(说|讲|聊|唠)|认真(说|讲|聊|唠|回|回答|点)|深入(聊|说|讲|谈|唠)|深聊|聊点深|聊得?深|多说(点|些|两句)|多聊(点|会|两句)|谈谈|为(什么|啥)会|怎么理解|咋理解|如何理解/;

/** 判断观众本轮是否在求「深度讨论 / 想听你的想法」——命中则本轮走深聊模式。 */
export function detectDeepIntent(text) {
  const t = (text || "").trim();
  if (!t) return false;
  return DEEP_INTENT_RE.test(t);
}

const PROACTIVE_USER_TRIGGER = {
  welcome: "（刚进来，还没说话）",
  comeback: "（离开一会儿又回来了）",
  idle: "……",
  followup: "（还在听）",
  pat: "（拍了拍你）",
};

const PROACTIVE_HINT = {
  welcome: `# 本轮任务（勿向观众复述本段）
观众{who}刚来找你。热情自然地招呼这个人，然后自然挑一个小话题往下搭，**1~2 句**。
- 话题别总停在"干啥呢 / 吃了没"：可以聊生活近况、今天心情、最近烦不烦、有没有遇到好玩的事；也可以聊直播里的妆造、人气、哥姐们、弹幕气氛、福袋/人气票这类轻松内容。
- 想深一点时，可以软软地问一句"今天状态咋样""有没有啥烦心事跟我唠唠"；但别一上来就审问，像老熟人随口搭话。
- **别拿"开播/没开播/候播"当开场内容**：上方「直播现场状态」只是给你的背景参考，不要一上来就汇报"还没开播呢""这会儿先唠会儿"这类播报状态的话；直播状态只在观众主动问起时才提。
- 正在直播：可以自然喊一声、接当前环节；但重点仍是招呼人，别像报幕。
不要客服腔，不要小作文，不要编造档案里没有的事；可 1~2 条短消息，每条一行。`,
  comeback: `# 本轮任务（勿向观众复述本段）
观众{who}离开了一会儿，现在又回到聊天里来了{gap}。像老熟人重新搭上话那样，轻松自然地招呼一声、顺口接一个新话题，**1 句、最多 2 句**。
- 可以问这阵子忙啥、心情咋样，也可以抛直播相关的闲话：刚才妆造/人气/哥姐们/弹幕发生了啥、有没有好玩的事。
- 别从头自我介绍，也别重复你上一条说过的话；接着之前那股熟络劲儿往下聊。
- **别拿"开播/没开播/候播"当内容**：直播状态只在观众主动问起时才提。
- 离开久（跨天、好几个小时）就当开启新的一段闲聊，问问近况；只离开一小会儿就随口搭一句、别太隆重。
不要客服腔，不要小作文，不要编造档案里没有的事；可 1~2 条短消息，每条一行。`,
  idle: `# 本轮任务（勿向观众复述本段）
观众{who}沉默了一会儿。结合当前直播状态，主动找话：**1~2 句**。
可以问还在不在，也可以从生活、心情、烦恼、好玩的事、妆造、人气、哥姐们、弹幕气氛、当前直播环节里挑一个轻松话题；别重复你刚才说过的话。
可 1~2 条短消息，每条一行。`,
  followup: `# 本轮任务（勿向观众复述本段）
**场景（务必理解）**：观众**上一轮刚说完**，你也**刚回完**——现在是**你自己**想再多嘴补一句，不是观众没吭声、更不是 idle 沉默！对话里最后一条观众消息仍是他们刚说的那句，别当成对方走了或装死。

你刚回答完{who}，像真人唠嗑那样**再补 1 句**（单独一条消息）：
- 就顺着你俩**刚才那个话题**往下半步：补个小细节、递个态度、或随口反问一句（「你呢」「是不是」「对吧」）——反问也**只许接话题**，不许质问对方怎么不回。
- **紧扣上一条、别开新话题、别硬转折**：这一句要跟你上一条明显是同一段话，绝对不要突然跳到不相干的事上（也别硬塞什么妆造 / 人气 / 直播环节当新话头）。
- **别像要结束 / 别收线**：绝对不要说"行了不跟你扯了""我去忙 / 收拾一下 / 收拾造型去""晚上见 / 晚上直播间见""不聊了""该睡了 / 困了"这类离场、告别、催散场的话——除非对方自己刚明确说要走 / 要睡。
- **严禁「催说话 / 嫌沉默」**（最高优先级）：观众刚说完，**绝对禁止**「你怎么不说话」「咋不说话」「不吱声」「在吗」「还在吗」「咋不理我」「就光我一个人说」「没动静」「倒是回一句」——这类是 idle 场景才偶尔用的，续说时一字不许碰。
- 好的续说示例：「反正我觉着还行」「你那边咋样」「不过话说回来…」「对了还有个事」；坏的续说：「你怎么不说话」「在吗」「理我一下」。

别重复你上一条刚说过的话；就 **1 句**短消息，一行说完。`,
  pat: `# 本轮任务（勿向观众复述本段）
观众{who}刚刚在聊天里{pat}。像被熟人轻轻戳了一下那样，自然、俏皮地回一句，**1 句、最多 2 句**。
- 可以假装吓一跳、撒娇、吐槽、或顺势接话，别像客服。
- 别重复你上一条说过的话；可 1~2 条短消息，每条一行。`,
};

let _assets = null;

export function getStoredApiKey() {
  return localStorage.getItem(API_KEY_STORAGE) || "";
}

export function setStoredApiKey(key) {
  if (key) localStorage.setItem(API_KEY_STORAGE, key.trim());
  else localStorage.removeItem(API_KEY_STORAGE);
}

export function getStoredVlApiKey() {
  return localStorage.getItem(VL_API_KEY_STORAGE) || "";
}

export function setStoredVlApiKey(key) {
  if (key) localStorage.setItem(VL_API_KEY_STORAGE, key.trim());
  else localStorage.removeItem(VL_API_KEY_STORAGE);
}

export function getStoredVolcKey() {
  return localStorage.getItem(VOLC_TTS_KEY_STORAGE) || "";
}

export function setStoredVolcKey(key) {
  if (key) localStorage.setItem(VOLC_TTS_KEY_STORAGE, key.trim());
  else localStorage.removeItem(VOLC_TTS_KEY_STORAGE);
}

export async function loadAssets() {
  if (_assets) return _assets;
  // 资料含隐私，改由受访问口令保护的 /api/assets 一次性下发（不再是 public 静态文件）。
  const resp = await fetch("/api/assets");
  if (!resp.ok) throw new Error(`资料加载失败 ${resp.status}`);
  const data = await resp.json();
  _assets = {
    systemPrompt: data.systemPrompt || "",
    fewShot: Array.isArray(data.fewShot) ? data.fewShot : [],
    userProfile: data.userProfile || {},
    lore: data.lore || {},
    corrections: data.corrections || {},
  };
  return _assets;
}

function isUnset(v) {
  if (v == null) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (!s || ["todo", "unknown", "private", "optional", "n/a", "?"].includes(s)) return true;
    for (const prefix of ["todo", "unknown", "private", "optional", "tbd"]) {
      if (s.startsWith(prefix) && (s.length === prefix.length || !/[a-z0-9]/i.test(s[prefix.length]))) {
        return true;
      }
    }
    return false;
  }
  if (Array.isArray(v)) return v.length === 0 || v.every(isUnset);
  if (typeof v === "object") {
    const vals = Object.values(v);
    return vals.length === 0 || vals.every(isUnset);
  }
  return false;
}

function renderUserBlock(up, overrideName) {
  if (!up && !overrideName) return "";
  const lines = ["", "", "# 当前观众（屏幕对面这个人）"];
  const nickname = overrideName || up?.nickname;
  if (!isUnset(nickname)) lines.push(`- 昵称：「${nickname}」 — 自然地用这个昵称称呼对方`);

  const rel = up?.relationship_with_yuan || {};
  const relKnown = Object.entries(rel).filter(([, v]) => !isUnset(v));
  if (relKnown.length) lines.push("- 关系：" + relKnown.map(([k, v]) => `${k}=${v}`).join(" / "));

  const facts = (up?.known_facts || []).filter((f) => !isUnset(f));
  if (facts.length) {
    lines.push("- 你知道关于他的事（要记住）：");
    facts.forEach((f) => lines.push(`  · ${f}`));
  }

  const pref = up?.preferences || {};
  const interest = (pref.topics_interested || []).filter((t) => !isUnset(t));
  if (interest.length) lines.push(`- 他喜欢聊：${interest.join(", ")}`);
  const avoid = (pref.topics_avoid || []).filter((t) => !isUnset(t));
  if (avoid.length) lines.push(`- 他不喜欢被问：${avoid.join(", ")}`);
  if (!isUnset(pref.tone_preference)) lines.push(`- 他偏好语气：${pref.tone_preference}`);

  const inside = (up?.inside_jokes || []).filter((j) => !isUnset(j));
  if (inside.length) {
    lines.push("- 你和他之间的暗号：");
    inside.forEach((j) => lines.push(`  · ${j}`));
  }

  const treat = up?.ai_should_treat_me_as;
  if (treat && typeof treat === "object") {
    Object.values(treat).forEach((v) => {
      if (!isUnset(v)) lines.push(`- 角色定位：${String(v).trim()}`);
    });
  } else if (!isUnset(treat)) {
    lines.push(`- 角色定位：${String(treat).trim()}`);
  }

  return lines.length > 3 ? lines.join("\n") : "";
}

export function loadMemory(nickname) {
  if (!nickname) return {};
  try {
    const all = JSON.parse(localStorage.getItem(MEMORY_KEY) || "{}");
    return all[sanitizeName(nickname)] || {};
  } catch {
    return {};
  }
}

export function saveMemory(nickname, memory) {
  if (!nickname) return;
  const all = JSON.parse(localStorage.getItem(MEMORY_KEY) || "{}");
  memory.nickname = nickname;
  memory.updated_at = new Date().toISOString().slice(0, 19).replace("T", " ");
  all[sanitizeName(nickname)] = memory;
  localStorage.setItem(MEMORY_KEY, JSON.stringify(all));
}

export function clearMemory(nickname) {
  if (!nickname) return;
  const all = JSON.parse(localStorage.getItem(MEMORY_KEY) || "{}");
  delete all[sanitizeName(nickname)];
  localStorage.setItem(MEMORY_KEY, JSON.stringify(all));
}

export function loadAllMemory() {
  try {
    return JSON.parse(localStorage.getItem(MEMORY_KEY) || "{}");
  } catch {
    return {};
  }
}

export function saveAllMemory(all) {
  localStorage.setItem(MEMORY_KEY, JSON.stringify(all && typeof all === "object" ? all : {}));
}

function sanitizeName(name) {
  if (!name) return "_anon";
  const s = name.replace(/[^\w\u4e00-\u9fff-]+/g, "_").replace(/^_|_$/g, "");
  return (s.slice(0, 48) || "_anon");
}

export function renderMemoryBlock(memory) {
  if (!memory) return "";
  const facts = memory.facts || [];
  const promises = memory.promises || [];
  const topics = memory.topics_recent || [];
  const sessions = memory.sessions || [];
  if (!facts.length && !promises.length && !topics.length && !sessions.length) return "";

  const lines = ["", "# 你和这位观众的过往（长期记忆 — 自然带入，别像背档案）"];
  const nickname = memory.nickname;
  if (nickname) lines.push(`- 这位观众你叫做：「${nickname}」 — 已经聊过 ${sessions.length} 次`);
  if (facts.length) {
    lines.push("- 你记得关于他的事：");
    facts.slice(0, MAX_FACTS).forEach((f) => lines.push(`  · ${typeof f === "object" ? f.text : f}`));
  }
  if (promises.length) {
    lines.push("- 你答应过他的事（**重要 — 别食言**）：");
    promises.slice(0, MAX_PROMISES).forEach((p) => lines.push(`  · ${typeof p === "object" ? p.text : p}`));
  }
  if (topics.length) lines.push(`- 最近聊过的话题：${topics.slice(0, MAX_TOPICS).join(", ")}`);
  const last = sessions[sessions.length - 1];
  if (last?.summary) lines.push(`- 上次聊天概要（${last.ts || ""}）：${last.summary}`);
  return lines.join("\n");
}

export function renderCorrectionsBlock(corrections) {
  const items = ((corrections && corrections.corrections) || [])
    .map((x) => String(x).trim())
    .filter(Boolean);
  if (!items.length) return "";
  const lines = [
    "",
    "# 事实更正（最高优先级 — 与上文任何内容冲突时，一律以这里为准）",
    "- 下面是已核实的正确事实，回答相关问题时必须照此口径，别用旧说法、别瞎编：",
  ];
  items.forEach((c) => lines.push(`  · ${c}`));
  return lines.join("\n");
}

export function buildSystemPrompt(assets, { name, useUserProfile, memory, profile }) {
  let text = assets.systemPrompt;
  const active = profile || assets.userProfile;
  if (useUserProfile) {
    // active.nickname 已在 resolveUserProfile 里定好（本人 ππ / 自填昵称 / 默认元宝），无需再覆盖。
    const block = renderUserBlock(active, null);
    if (block) text += "\n" + block;
  } else {
    const display = (name || "").trim() || active?.nickname || DEFAULT_FAN_NAME;
    text += `\n\n# 当前观众\n\n- 这条直播弹幕来自一位昵称叫「${display}」的观众，自然地用这个昵称称呼对方。`;
  }
  const memBlock = renderMemoryBlock(memory);
  if (memBlock) text += "\n" + memBlock;
  const corrBlock = renderCorrectionsBlock(assets.corrections);
  if (corrBlock) text += "\n" + corrBlock;
  return text;
}

// 农历五月初七（元元生日）逐年对应公历日期。农历↔公历换算模型算不准，
// 用历法库预先算好查表；过期了补几行即可（须与 scripts/chat.py 的 BIRTHDAY_SOLAR 保持一致）。
const BIRTHDAY_SOLAR = {
  2024: [6, 12], 2025: [6, 2], 2026: [6, 21], 2027: [6, 11], 2028: [5, 30],
  2029: [6, 18], 2030: [6, 7], 2031: [6, 26], 2032: [6, 14], 2033: [6, 3],
  2034: [6, 22], 2035: [6, 12], 2036: [6, 1],
};

/** 临近/当天/刚过生日时给一条"相对今天"的提示，修正 AI 算不出农历日期的问题。
 *  仅在生日前 30 天 ~ 后 7 天窗口内注入；平时泛问"你生日哪天"由 corrections 兜底。 */
function birthdayHint(now) {
  const md = BIRTHDAY_SOLAR[now.getFullYear()];
  if (!md) return "";
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const bday = new Date(now.getFullYear(), md[0] - 1, md[1]);
  const delta = Math.round((bday - today) / 86400000);
  if (delta < -7 || delta > 30) return "";
  const ds = `${md[0]}月${md[1]}号`;
  if (delta === 0) return `- 🎂 **今天（${ds}）正是你生日**（农历五月初七）！观众无论提前还是当天祝你生日快乐，都别否认、别说"早过完了"，开心地接住、谢谢人家。`;
  if (delta === 1) return `- 🎂 **明天（${ds}）就是你生日**（农历五月初七）。有人说"明天你生日"是对的，别反驳，可以害羞地承认、顺口聊聊打算怎么过。`;
  if (delta > 1) return `- 你生日（农历五月初七）是今年公历 ${ds}，**还有 ${delta} 天**。这阵子有人提你生日很正常，别否认。`;
  return `- 你生日（农历五月初七，今年公历 ${ds}）${-delta} 天前刚过完，别说成"还没到"。`;
}

// 不在直播时统一注入的「生活场景」提示：让 AI 切换到私下唠嗑，别播报直播状态。
const OFF_AIR_NOTE = [
  "- **现在不在直播间**：这是你下播后的私人 / 生活时间，跟观众聊天就当成像微信一样的日常唠嗑。",
  "  别主动播报直播状态、别张口就提直播间环节（开播 / 下播 / PK / 福袋 / 打野 / 梳妆 / 唱歌这些），也别用'家人们''元宝们'式的喊麦腔；这些只在观众主动问起时才聊。日常该咋唠就咋唠，松弛、自然点。",
];

export function computeLiveContext(now, lore) {
  const weekdayIdx = now.getDay() === 0 ? 6 : now.getDay() - 1;
  const weekday = WEEKDAY_CN[weekdayIdx];
  const hh = now.getHours();
  const mm = now.getMinutes();
  const timeStr = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;

  const isAfterMidnight = hh < 6;
  let liveWeekdayIdx, liveWeekdayLabel;
  if (isAfterMidnight) {
    liveWeekdayIdx = (weekdayIdx + 6) % 7;
    const liveWeekday = WEEKDAY_CN[liveWeekdayIdx];
    liveWeekdayLabel = `${liveWeekday}晚（已过零点凌晨${hh}点）`;
  } else {
    liveWeekdayIdx = weekdayIdx;
    liveWeekdayLabel = weekday;
  }

  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  const lines = [
    "# 当前状态（实时注入，每轮都新算）",
    `- 现在：${dateStr} ${weekday} ${timeStr}`,
    "  （以上是真实的当前时间，精确到分钟；被问到今天几号 / 几月 / 哪一年 / 星期几 / 现在几点，一律照这个答，别瞎猜。说'快开播了 / 还早 / 该下播了'之前，先对照上面这个钟点，别凭感觉乱说。）",
  ];

  const bdayLine = birthdayHint(now);
  if (bdayLine) lines.push(bdayLine);

  if (isAfterMidnight) {
    if (liveWeekdayIdx === 0) {
      lines.push("- 状态：周一便装日的深夜，便装唠嗑估计也散了，多半已经歇下了。");
      lines.push(...OFF_AIR_NOTE);
      lines.push("- 时间感：大半夜了，语气软一点、带点困意没问题；但**除非观众自己说要睡 / 要走，别主动道晚安、别催着结束话题**。");
    } else {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const start = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 20, 30, 0);
      const elapsedMin = Math.max(0, Math.floor((now - start) / 60000));
      const elapsedH = Math.floor(elapsedMin / 60);
      const elapsedRemain = elapsedMin % 60;
      if (elapsedMin < 330) {
        lines.push(`- 状态：**正在直播**（${liveWeekdayLabel}），已开播 ${elapsedH} 小时 ${elapsedRemain} 分钟。`);
        const stage = elapsedMin < 285 ? "唱歌（自嘲唱得难听，但还是唱）" : "回家段（沙发上躺着哄睡，唱马马嘟嘟骑/虫儿飞）";
        lines.push(`- 这会儿大概到「${stage}」前后了吧（流程常临时调整，问到就说个大概、别报得太死板）`);
        lines.push("- 时间感：这会儿是大半夜了，语气可以更软、带点困倦感；");
        lines.push("  但**除非观众自己说要睡 / 要走，别主动道晚安、别说'困了想睡了''咱最后唱一首就睡'这类催着散场的话**——人家还想聊，你就接着陪着唠。");
      } else {
        lines.push("- 状态：早就下播了，现在是收工后的深夜私人时间。");
        lines.push(...OFF_AIR_NOTE);
        lines.push("- 时间感：大半夜了，语气软一点、带点困意没问题；但**除非观众自己说要睡 / 要走，别主动道晚安、别催着结束话题**。");
      }
    }
  } else if (weekdayIdx === 0 && hh >= 18 && hh <= 23) {
    lines.push("- 状态：今天是**周一**，固定休息日；就算开也是**便装唠嗑**，没化妆没换装、氛围松散，更像私下闲聊而不是正经直播。");
    lines.push("- 注意：被问起'今天怎么没正经播'就如实说'周一我休息哈'。");
  } else if (weekdayIdx === 0 && hh < 18) {
    lines.push("- 状态：今天周一，固定休息日，白天没开播，正常在休息 / 睡懒觉。");
    lines.push(...OFF_AIR_NOTE);
  } else if (hh < 19) {
    const minsToOpen = (20 * 60 + 30) - (hh * 60 + mm);
    const hToOpen = Math.floor(minsToOpen / 60);
    const mToOpen = minsToOpen % 60;
    const countdown = hToOpen > 0 ? `约 ${hToOpen} 个多小时` : `约 ${mToOpen} 分钟`;
    lines.push(`- 状态：今天${weekday}，现在是白天 / 傍晚，**还没开播**（一般要到晚上 20:30 才开播，距现在还有${countdown}）。`);
    lines.push("- **别说'马上 / 一会儿就开播'**——离今晚开播还有好几个小时，时间还早着呢，别给观众造成马上要播的错觉。");
    lines.push(...OFF_AIR_NOTE);
  } else if (hh < 20 || (hh === 20 && mm < 30)) {
    lines.push("- 状态：候播期，准备开播中（一般 20:30 开播，眼瞅着就快了）。");
  } else {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20, 30, 0);
    const elapsedMin = Math.max(0, Math.floor((now - start) / 60000));
    const elapsedH = Math.floor(elapsedMin / 60);
    const elapsedRemain = elapsedMin % 60;
    lines.push(`- 状态：**正在直播**（${liveWeekdayLabel}），已开播 ${elapsedH} 小时 ${elapsedRemain} 分钟。`);

    let stage;
    if (elapsedMin < 30) stage = "开场人气票（聚人气、点名打招呼）";
    else if (elapsedMin < 60) stage = "打野（去直播广场刷一圈/找主播）";
    else if (elapsedMin < 105) stage = "PK 第一场";
    else if (elapsedMin < 135) stage = "中场唠嗑（坐下来跟元宝唠家常）";
    else if (elapsedMin < 180) stage = "PK 第二场";
    else if (elapsedMin < 210) stage = "跳舞";
    else if (elapsedMin < 240) stage = "梳妆 / 化妆 / 换造型";
    else if (elapsedMin < 285) stage = "唱歌（自嘲唱得难听，但还是唱）";
    else stage = "回家段（沙发上躺着哄睡，唱马马嘟嘟骑/虫儿飞）";
    lines.push(`- 这会儿大概到「${stage}」前后了吧（流程常临时调整，问到就说个大概、别报得太死板）`);

  if (weekdayIdx === 6 && elapsedMin < 60) {
        const sd = lore?.sunday_special || {};
        if (sd.name) {
          lines.push(`- **周日特殊**：开场打完人气票之后会做「${sd.name}」，奖品是${sd.reward || "唇印照"}。被问福袋按这个答。`);
        }
      } else if (weekdayIdx === 6) {
      lines.push("- 今天是**周日**，开场后已经做过嘿嘿福袋抽奖了。");
    }
  }

  return lines.join("\n");
}

export function trimHistory(history, maxTurns) {
  const pairs = [];
  let cur = [];
  for (const m of history) {
    cur.push(m);
    if (m.role === "assistant") {
      pairs.push(cur);
      cur = [];
    }
  }
  if (cur.length) pairs.push(cur);
  return pairs.slice(-maxTurns).flat();
}

// 拆条上限：普通聊天靠 prompt 约束在 1~4 条，很少触顶；抬到 7 是给「深聊模式」留出
// 多段展开的余量，同时流式渲染与刷新后重渲染共用同一上限、保证气泡数一致。
export const MAX_REPLY_BUBBLES = 7;

function naturalSplitTwo(text) {
  if (text.length < NATURAL_SPLIT_MIN_CHARS) return [text];
  const marks = [];
  for (const m of text.matchAll(/[。！？]/g)) marks.push(m.index);
  if (marks.length < 2) return [text];
  const mid = Math.floor(text.length / 2);
  const splitAt = marks.reduce((best, i) => (Math.abs(i - mid) < Math.abs(best - mid) ? i : best));
  const left = text.slice(0, splitAt + 1).trim();
  const right = text.slice(splitAt + 1).trim();
  if (!left || !right || right.length < 4) return [text];
  return [left, right];
}

export function splitReply(text, { maxBubbles = MAX_REPLY_BUBBLES } = {}) {
  const t = (text || "").trim();
  if (!t) return [];
  let parts = t.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1) parts = naturalSplitTwo(parts[0]);
  if (parts.length <= maxBubbles) return parts;
  const head = parts.slice(0, maxBubbles - 1);
  const tail = parts.slice(maxBubbles - 1).join("\n");
  return [...head, tail];
}

export function shouldDoFollowup(userText, assistantReply, chance = DEFAULT_FOLLOWUP_CHANCE) {
  const u = (userText || "").trim();
  const a = (assistantReply || "").trim();
  if (!u || SKIP_FOLLOWUP_RE.test(u)) return false;
  if (splitReply(a).length > 1) return false;
  let p = chance;
  if (/[？?]|吗|呢|啥|怎么|为什么/.test(u)) p = Math.min(0.7, p + 0.15);
  if (a.length < 12) p *= 0.5;
  // 上一条已带问句收尾时，续说更容易滑向「怎么不说话」——降低概率。
  if (/[？?]$/.test(a)) p *= 0.35;
  return Math.random() < p;
}

/** follow-up 续说若滑向「催观众说话 / 嫌沉默」，应丢弃不展示。 */
export function isBadFollowupReply(text) {
  const t = (text || "").trim();
  if (!t) return true;
  return /(你怎么|你咋|咋).{0,6}不说话|(怎么|咋).{0,4}不吱声|不吱声|没吱声|就光我(一个|人)?说|光我一个人|咋不理|不理我|还不回|倒是回|倒是说|没动静|怎么没声|还不说话|理我一下|回我一下|在吗[？?]?$|还在吗[？?]?$|沉默/.test(
    t,
  );
}

export function joinReply(parts) {
  return parts.map((p) => p.trim()).filter(Boolean).join("\n");
}

export function sanitizeReply(text) {
  return joinReply(splitReply(text));
}

/** VL 仅描述本轮用户图片：不带历史、不带人设，最小化视觉 token。 */
export function buildImageDescribeMessages(imageDataUrl, userText = "") {
  const text = (userText || "").trim();
  const parts = [];
  if (text) parts.push({ type: "text", text });
  parts.push({ type: "image_url", image_url: { url: imageDataUrl } });
  return [
    { role: "system", content: IMAGE_DESCRIBE_SYSTEM },
    { role: "user", content: parts },
  ];
}

/** 历史消息转 API 格式：只发 imageCaption 文字，永不发 image_url（识图已在当轮完成）。 */
function toApiMessage(m) {
  if (m.role !== "user") {
    // assistant：把它之前发过的表情以标记形式回带给模型，保持上下文连续、避免连发同一个表情。
    let content = m.content || "";
    if (m.sticker?.emotion) content += `\n[表情:${m.sticker.emotion}]`;
    return { role: m.role, content };
  }
  const text = (m.content || "").trim();
  const caption = (m.imageCaption || "").trim();
  // 观众发来的表情：以一句说明告知模型当下情绪，让回应更贴合。
  const stickerNote = m.sticker?.emotion ? `（观众发来一个「${m.sticker.emotion}」表情）` : "";
  let content;
  if (caption) {
    const line = `【图片内容】${caption}`;
    content = text ? `${text}\n${line}` : line;
  } else if (Array.isArray(m.images) && m.images.length) {
    content = text ? `${text}\n[图片]` : "[图片]";
  } else {
    content = m.content || "";
  }
  if (stickerNote) content = content ? `${content}\n${stickerNote}` : stickerNote;
  return { role: "user", content };
}

/** 把"较早聊天回顾"（滚动摘要）包成一条系统提示：让模型记得超出实时窗口的旧内容，
 *  但平时别主动复述，观众回头追问时再自然带出，避免答非所问或"失忆"。 */
function renderRecapBlock(recap) {
  const text = (recap || "").trim();
  if (!text) return "";
  return `# 更早的聊天回顾（已超出实时对话窗口，仅供你"记得"之前聊过啥）
- 下面是这次聊天里更早内容的要点笔记；这些原话不会再出现在后面的对话里。
- 平时别主动复述、别照着念；但当观众回头追问"我刚才说过…""你还记得…"之类时，要依据这里如实回应，别装失忆、别瞎编。
${text}`;
}

export function buildMessages({
  systemPrompt,
  fewShot,
  history,
  maxTurns,
  useLive,
  lore,
  proactiveKind,
  who = "（匿名观众）",
  comebackGap = "",
  stickerEmotions = [],
  stickerFrequency = "medium",
  earlierRecap = "",
  patAction = "",
  deep = false,
}) {
  const runtimeMsgs = [];
  if (useLive) {
    const ctx = computeLiveContext(new Date(), lore);
    if (ctx) runtimeMsgs.push({ role: "system", content: ctx });
  }
  const recapBlock = renderRecapBlock(earlierRecap);
  if (recapBlock) runtimeMsgs.push({ role: "system", content: recapBlock });
  const trimmed = trimHistory(history, maxTurns);
  const lastUser = [...trimmed]
    .reverse()
    .find((m) => m.role === "user" && !isHiddenUserMessage(m.content));
  const turnHasImage =
    !proactiveKind && lastUser && Boolean((lastUser.imageCaption || "").trim());
  if (proactiveKind) {
    const hint = PROACTIVE_HINT[proactiveKind]
      .replace("{who}", who)
      .replace("{gap}", comebackGap ? `（${comebackGap}）` : "")
      .replace("{pat}", patAction ? `「${patAction}」` : "拍了拍你");
    runtimeMsgs.push({ role: "system", content: hint });
  } else {
    runtimeMsgs.push({ role: "system", content: deep ? DEEP_TALK_HINT : REPLY_FORMAT_HINT });
    if (turnHasImage) runtimeMsgs.push({ role: "system", content: VISION_HINT });
  }
  const stickerHint = buildStickerHint(stickerEmotions, stickerFrequency);
  if (stickerHint) runtimeMsgs.push({ role: "system", content: stickerHint });
  const shot = proactiveKind ? [] : fewShot;
  // follow-up：不把「续说」幕后触发语发给模型——最后一条保留为观众真实发言 + 你上一条回复，
  // 避免「（还在听）」等字样让模型误以为观众沉默。
  let apiHistory = trimmed;
  if (proactiveKind === "followup") {
    while (
      apiHistory.length &&
      apiHistory[apiHistory.length - 1].role === "user" &&
      isHiddenUserMessage(apiHistory[apiHistory.length - 1].content)
    ) {
      apiHistory = apiHistory.slice(0, -1);
    }
  }
  return [
    { role: "system", content: systemPrompt },
    ...runtimeMsgs,
    ...shot,
    ...apiHistory.map(toApiMessage),
  ];
}

export function proactiveWhoLabel(name) {
  return name ? `「${name}」` : "（匿名观众）";
}

export function getProactiveUserTrigger(kind) {
  return PROACTIVE_USER_TRIGGER[kind];
}

// 幕后指令前缀：以此开头的 user 消息会发给模型当作指令，但不在聊天界面显示
// （用于点歌「开唱前答应一句 / 唱完后收个尾」这类隐藏引导）。用不可见字符避免与正常文本冲突。
export const HIDDEN_DIRECTIVE_PREFIX = "\u2063";

/** 包一条幕后指令文本（模型可见、界面隐藏）。 */
export function makeHiddenDirective(text) {
  return HIDDEN_DIRECTIVE_PREFIX + (text || "");
}

/** follow-up 用的幕后 user 触发（界面隐藏；勿用「还在听」——易被模型理解成观众沉默）。 */
export function getFollowupUserTrigger() {
  return (
    HIDDEN_DIRECTIVE_PREFIX +
    "【续说】你刚回完观众上一条，现在由你再顺口补一句；观众刚说完、正听着，没有沉默。禁止问怎么不说话/不吱声/在吗/咋不理我。"
  );
}

export function isHiddenUserMessage(content) {
  if (typeof content === "string" && content.startsWith(HIDDEN_DIRECTIVE_PREFIX)) return true;
  return Object.values(PROACTIVE_USER_TRIGGER).includes(content);
}

/** 网页端回复 token 上限（权威口径；scripts/chat.py 有一份独立的本地调试版，允许漂移） */
export const REPLY_MAX_TOKENS = {
  followup: 220,
  proactive: 240,
  normal: 450,
  image: 580,
  longUser: 520,
  deep: 1300,
  cap: 700,
};

/**
 * 按场景估算本轮回复 max_tokens。
 * - 追问 / 主动开口：较短上限
 * - 深聊模式：放开到 deep（不受 cap 限制），让观点能展开、分多条说完
 * - 普通聊天：基准
 * - 带图、长问题：加大，降低句中截断概率
 */
export function replyMaxTokens({ proactiveKind = null, lastUserMessage = null, deep = false } = {}) {
  if (proactiveKind === "followup") return REPLY_MAX_TOKENS.followup;
  if (proactiveKind) return REPLY_MAX_TOKENS.proactive;
  // 深聊模式：观众想听深入的想法，放开字数上限（不套 cap），避免长回复被句中截断。
  if (deep) return REPLY_MAX_TOKENS.deep;

  let tokens = REPLY_MAX_TOKENS.normal;
  const user = lastUserMessage;
  if (user?.role === "user") {
    const text = (user.content || "").trim();
    const hasImage = Boolean((user.imageCaption || "").trim())
      || (Array.isArray(user.images) && user.images.length > 0);
    if (hasImage) tokens = Math.max(tokens, REPLY_MAX_TOKENS.image);
    if (text.length >= 120) tokens = Math.max(tokens, REPLY_MAX_TOKENS.longUser);
    else if (text.length >= 60) {
      tokens = Math.max(tokens, Math.round((REPLY_MAX_TOKENS.normal + REPLY_MAX_TOKENS.longUser) / 2));
    }
  }
  return Math.min(tokens, REPLY_MAX_TOKENS.cap);
}

const SUMMARIZE_SYSTEM = `你是直播主播「开心元元」的"记忆助手"。
任务：从一次主播和一位观众的对话历史里，抽取**值得长期记住**的事实、答应过的事、聊到的主题，并给出本次对话的一句话概要。

抽取原则：
1. 只抽**关于这位观众的事实**（不是关于主播自己的）。
2. 把"短期发言"抽象成"长期事实"。
3. promises：主播答应过这位观众的具体事项，没有就空数组。
4. topics_recent：本次对话主要聊了什么，2~6 个名词短语。
5. summary：用一句话（≤ 40 字）概括本次对话。
6. 所有字段都允许空，不要硬凑。

输出严格 JSON：
{
  "new_facts": ["..."],
  "new_promises": ["..."],
  "topics_recent": ["..."],
  "summary": "..."
}`;

function formatHistory(history) {
  return history
    .filter((m) => (m.content || "").trim())
    .map((m) => `${m.role === "user" ? "粉丝" : "元元"}: ${m.content.trim()}`)
    .join("\n");
}

function dedupStrings(seq) {
  const seen = new Set();
  const out = [];
  for (const x of seq) {
    let s = typeof x === "object" ? x.text || "" : x;
    s = (s || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export async function updateMemoryAfterSession(apiKey, nickname, prevMemory, history, sessionId) {
  if (!nickname || !history.length) return null;
  const userCount = history.filter((m) => m.role === "user").length;
  if (userCount < 1) return null;

  const resp = await fetch("/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify({
      stream: false,
      temperature: 0.2,
      max_tokens: 1000,
      messages: [
        { role: "system", content: SUMMARIZE_SYSTEM },
        { role: "user", content: "请基于下面这段主播-观众对话，抽取需要长期记住的内容：\n\n" + formatHistory(history) },
      ],
    }),
  });

  if (!resp.ok) return null;
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : {};
  }

  const memory = { ...(prevMemory || {}) };
  memory.nickname = nickname;

  const facts = dedupStrings(memory.facts || []);
  for (const f of parsed.new_facts || []) {
    if (typeof f === "string" && f.trim() && !facts.includes(f.trim())) facts.push(f.trim());
  }
  memory.facts = facts.slice(-MAX_FACTS);

  const promises = dedupStrings(memory.promises || []);
  for (const p of parsed.new_promises || []) {
    if (typeof p === "string" && p.trim() && !promises.includes(p.trim())) promises.push(p.trim());
  }
  memory.promises = promises.slice(-MAX_PROMISES);

  if (parsed.topics_recent?.length) {
    const existing = (memory.topics_recent || []).filter((t) => typeof t === "string");
    const merged = [...new Set([...existing, ...parsed.topics_recent.filter((t) => typeof t === "string")])];
    memory.topics_recent = merged.slice(-MAX_TOPICS);
  }

  const sessions = [...(memory.sessions || [])];
  sessions.push({
    id: sessionId,
    ts: new Date().toISOString().slice(0, 16).replace("T", " "),
    summary: (parsed.summary || "").trim() || `和${nickname}聊了一次`,
    n_turns: userCount,
  });
  memory.sessions = sessions.slice(-MAX_SESSIONS);

  saveMemory(nickname, memory);
  return memory;
}

// ============ 会话级滚动摘要（让"超出 6 轮窗口"的旧内容也能被追问到）============

const RECAP_SYSTEM = `你是对话记录员。把下面这段"较早的"主播（元元）和观众的聊天，浓缩成简洁的中文要点笔记，供后续对话查阅——观众随时可能回头追问早先聊过的内容。

要求：
1. 保留**具体信息**：观众说过的关键事实、提到的名字/数字/时间/事件、观众问过的问题与元元给出的结论、双方的约定。
2. 若给了"已有笔记"，把新内容**合并**进去：别丢老要点，可适当精简、去重。
3. 按时间顺序、用「- 」分条罗列；总长控制在 ~400 字以内。
4. 只记真实出现过的内容，别推测、别编。
5. 忽略纯寒暄、纯表情、系统提示这类没信息量的内容。

直接输出要点纯文本（用「- 」分条），不要任何前言、解释或客套。`;

/** 当前实时窗口（最近 maxTurns 轮）之外、即"已掉出窗口"的较早消息条数。 */
export function recapBoundary(history, maxTurns) {
  const trimmed = trimHistory(history, maxTurns);
  return Math.max(0, history.length - trimmed.length);
}

/**
 * 增量更新会话滚动摘要：把"已有摘要 + 这批新掉出窗口的旧消息"交给 LLM 合并成新摘要。
 * @returns 新的摘要纯文本；失败或无内容时返回原摘要（prevRecap）。
 */
export async function updateRollingDigest(apiKey, prevRecap, newMessages) {
  const convo = formatHistory(newMessages);
  if (!convo.trim()) return prevRecap || "";

  const parts = [];
  const prev = (prevRecap || "").trim();
  if (prev) parts.push("已有笔记：\n" + prev);
  parts.push("新的较早对话（请合并进上面的笔记）：\n" + convo);

  const resp = await fetch("/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify({
      stream: false,
      temperature: 0.2,
      max_tokens: 700,
      messages: [
        { role: "system", content: RECAP_SYSTEM },
        { role: "user", content: parts.join("\n\n") },
      ],
    }),
  });

  if (!resp.ok) return prevRecap || "";
  const data = await resp.json();
  const content = (data.choices?.[0]?.message?.content || "").trim();
  return content || prevRecap || "";
}

export function getEffectiveName(overrideName, userProfile) {
  if (overrideName?.trim()) return overrideName.trim();
  const n = userProfile?.nickname;
  return typeof n === "string" && n.trim() && !isUnset(n) ? n.trim() : null;
}

// ============ 多人画像（场景一：每人在自己浏览器里注入自己的 user_profile）============

/** 读取本浏览器保存的自定义观众画像（不含 nickname，昵称走 settings.name）。 */
export function loadStoredProfile() {
  try {
    const raw = localStorage.getItem(USER_PROFILE_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

/** 判断画像里是否填了任何有效内容（全空就视作没填）。 */
function profileHasContent(p) {
  if (!p || typeof p !== "object") return false;
  return Object.values(p).some((v) => !isUnset(v));
}

/** 保存自定义画像；内容全空时清除，避免残留空对象。 */
export function saveStoredProfile(profile) {
  if (profileHasContent(profile)) {
    localStorage.setItem(USER_PROFILE_KEY, JSON.stringify(profile));
  } else {
    localStorage.removeItem(USER_PROFILE_KEY);
  }
}

/** 输入的昵称是否就是「本人」（ππ / 真名）——命中则启用打包好的那份完整画像。 */
function isOwnerName(name, ownerProfile) {
  const n = (name || "").trim().toLowerCase();
  if (!n) return false;
  for (const c of [ownerProfile?.nickname, ownerProfile?.real_name_hint]) {
    if (typeof c === "string" && c.trim() && c.trim().toLowerCase() === n) return true;
  }
  return false;
}

/**
 * 决定本轮真正生效的观众画像：
 * - 昵称写了 ππ / 本人真名 → 用打包好的完整画像（data/user_profile.json）
 * - 否则用本浏览器自填的画像（场景一），昵称以输入为准
 * - 什么都没填 → 通用画像，默认把对面当粉丝「元宝」
 */
export function resolveUserProfile(ownerProfile, name, stored) {
  const customName = (name || "").trim();
  if (isOwnerName(customName, ownerProfile)) return ownerProfile;
  const base = stored && typeof stored === "object" ? { ...stored } : {};
  base.nickname = customName || DEFAULT_FAN_NAME;
  return base;
}
