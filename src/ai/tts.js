/** 前端朗读：把文本发给 /api/tts 合成为 mp3 并播放。
 *  全局只允许一个音频在放，重复点击同一段会停止（toggle）。
 *
 *  移动端（手机 Chrome / Safari）自动播放策略（实测要点）：
 *   - 浏览器只允许「曾在用户手势内成功 play() 过」的媒体元素，之后用脚本 play()。
 *     若每次都 new Audio()，新元素从未被手势加持，经过 await fetch（合成等待）后
 *     再 play() 会被静默拦截 —— 这正是「点按钮能放、自动朗读不放」且只在手机复现的原因。
 *   - 解法：全局复用「同一个」<audio> 元素，并在首次用户手势内播一小段静音把它「加持」，
 *     此后无论自动还是手动朗读都只换 src 复用它，绕过自动播放限制。
 *   - 选用 <audio>（HTMLMediaElement）而非 Web Audio：iOS 上 Web Audio 会被侧边
 *     静音/响铃物理开关静音，而 <audio> 当作媒体播放、静音开关打开时照样出声，
 *     对「朗读」场景体验更稳。 */

import { getStoredVlApiKey, getStoredVolcKey } from "./persona.js";
import { getVoiceGain, onVoiceGainChange } from "./voice-volume.js";

// ── 播放状态 ──
let currentToken = null; // 标记当前正在播放/请求的来源，用于 toggle 判断
let playing = false;     // 是否有音频正在播放
let playGen = 0;         // 播放代号：每次停止/重放自增，让旧回调失效
let speechBlobSettle = null; // 当前 playSpeechBlob 的 done 解析器：被外部 stopSpeak 打断时用它收尾，避免队列卡死

// ── 合成进度（供 debug 进度条）──
// phase: idle | synth | done | error
const ttsProgressListeners = new Set();
let ttsProgressTick = 0;
let ttsProgressSeq = 0;

/** @param {(ev: { phase: string, chars?: number, elapsedMs?: number, cached?: boolean, bytes?: number, billedChars?: number, provider?: string, error?: string }) => void} fn */
export function onTtsProgress(fn) {
  if (typeof fn !== "function") return () => {};
  ttsProgressListeners.add(fn);
  return () => ttsProgressListeners.delete(fn);
}

function emitTtsProgress(ev) {
  for (const fn of ttsProgressListeners) {
    try {
      fn(ev);
    } catch {
      /* ignore */
    }
  }
}

function beginSynthProgress(chars) {
  const seq = ++ttsProgressSeq;
  const t0 = performance.now();
  if (ttsProgressTick) clearInterval(ttsProgressTick);
  emitTtsProgress({ phase: "synth", chars, elapsedMs: 0, cached: false });
  ttsProgressTick = setInterval(() => {
    if (seq !== ttsProgressSeq) return;
    emitTtsProgress({
      phase: "synth",
      chars,
      elapsedMs: performance.now() - t0,
      cached: false,
    });
  }, 50);
  return {
    seq,
    t0,
    end(extra = {}) {
      if (seq !== ttsProgressSeq) return;
      if (ttsProgressTick) {
        clearInterval(ttsProgressTick);
        ttsProgressTick = 0;
      }
      emitTtsProgress({
        phase: extra.phase || "done",
        chars,
        elapsedMs: performance.now() - t0,
        ...extra,
      });
    },
  };
}

// ── 播放音量（Web Audio GainNode，支持 >100%）──
let outCtx = null;
let outGain = null;
let outSource = null;
let volUnsub = null;

/** 解析（结束）当前 playSpeechBlob 的等待 Promise，并清空引用。 */
function resolveSpeechBlob() {
  if (speechBlobSettle) {
    const s = speechBlobSettle;
    speechBlobSettle = null;
    s();
  }
}

// ── 共享 <audio> 元素 ──
let sharedAudio = null;
let currentUrl = null;
let blessed = false;     // 共享元素是否已在用户手势内被「加持」（可自动播放）
let silentUrl = null;    // 加持用的静音音频 URL（懒生成）

function getSharedAudio() {
  if (!sharedAudio) {
    sharedAudio = new Audio();
    sharedAudio.preload = "auto";
    sharedAudio.setAttribute("playsinline", ""); // iOS 必须，避免尝试全屏/被拦
  }
  return sharedAudio;
}

/** 把共享 <audio> 接到 GainNode，使设置里的音量（含 >100%）生效。 */
function ensurePlaybackGain() {
  const audio = getSharedAudio();
  const g = getVoiceGain();
  if (outGain) {
    outGain.gain.value = g;
    if (outCtx?.state === "suspended") outCtx.resume().catch(() => {});
    return;
  }
  try {
    outCtx = new (window.AudioContext || window.webkitAudioContext)();
    outSource = outCtx.createMediaElementSource(audio);
    outGain = outCtx.createGain();
    outGain.gain.value = g;
    outSource.connect(outGain);
    outGain.connect(outCtx.destination);
    audio.volume = 1;
    volUnsub = onVoiceGainChange((next) => {
      if (outGain) outGain.gain.value = next;
    });
    if (outCtx.state === "suspended") outCtx.resume().catch(() => {});
  } catch {
    // 回退：HTMLMediaElement.volume 只能 0–1，无法放大。
    audio.volume = Math.min(1, g);
    if (!volUnsub) {
      volUnsub = onVoiceGainChange((next) => {
        if (!outGain && sharedAudio) sharedAudio.volume = Math.min(1, next);
      });
    }
  }
}

/** 生成一段极短静音 WAV 的 object URL，仅用于在用户手势内「加持」共享元素。 */
function silentWavUrl() {
  const sampleRate = 8000;
  const numSamples = Math.floor(sampleRate * 0.05); // ~0.05s 静音
  const dataSize = numSamples * 2; // 16-bit mono
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

/** 在用户手势（点击/发送/按键等）的同步栈内调用，「加持」共享 <audio> 元素，
 *  使后续脱离手势的自动朗读也能成功 play()。多次调用安全：加持成功后即空转返回，
 *  也不会打断正在进行的真实朗读。 */
export function unlockAudio() {
  if (blessed) return;
  const a = getSharedAudio();
  // 已经在放真实音频时不要抢占元素；等下次手势再加持（极少发生）。
  if (playing) return;
  try {
    ensurePlaybackGain();
    if (!silentUrl) silentUrl = silentWavUrl();
    a.src = silentUrl; // 静音 WAV，无需 mute，播放也听不见
    const p = a.play();
    const done = () => {
      blessed = true;
      try {
        a.pause();
        a.currentTime = 0;
      } catch { /* ignore */ }
      // 不清空 src：避免某些浏览器把「清 src」视为新一轮、丢掉加持态。
    };
    if (p && typeof p.then === "function") {
      p.then(done).catch(() => { /* 无有效手势：下次手势再试 */ });
    } else {
      done();
    }
  } catch { /* ignore */ }
}

// 合成结果缓存：同一「音色|model|文本」只请求上游一次，重复回放直接复用，省额度。
// 只在当前页面会话内有效（刷新即清空），用 Blob 存。
const audioCache = new Map();
const MAX_CACHE = 40;

function cacheKey(text, voice, model, params, instruction, emotion) {
  const p = params ? `${params.rate}/${params.pitch}/${params.volume}` : "";
  return `${voice || ""}|${model || ""}|${p}|${instruction || ""}|${emotion || ""}|${text}`;
}

function putCache(map, key, val) {
  map.set(key, val);
  if (map.size > MAX_CACHE) {
    map.delete(map.keys().next().value); // 丢最旧的
  }
}

// 外部音频（如点歌）注册的「停止」回调：朗读开始前调用，保证全局只有一个声音在放。
let externalStop = null;

/** 注册一个外部停止回调（点歌模块用它把「停歌」交给朗读模块调用）。 */
export function setExternalStop(fn) {
  externalStop = typeof fn === "function" ? fn : null;
}

/** 停掉共享 <audio> 元素并释放上一个 blob URL（保留加持态，不销毁元素）。 */
function stopAudio() {
  if (sharedAudio) {
    // 先摘掉事件处理器再清 src：否则清 src 会让浏览器对元素抛 error，误触发 onError。
    try {
      sharedAudio.onended = null;
      sharedAudio.onerror = null;
      sharedAudio.pause();
    } catch { /* ignore */ }
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
}

/** 停止当前朗读。 */
export function stopSpeak() {
  stopAudio();
  playGen++; // 使上一段播放挂的回调失效
  playing = false;
  currentToken = null;
  // 打断进行中的合成计时（下一次 synth 会开新 seq）。
  const wasSynth = !!ttsProgressTick;
  ttsProgressSeq++;
  if (ttsProgressTick) {
    clearInterval(ttsProgressTick);
    ttsProgressTick = 0;
  }
  if (wasSynth) emitTtsProgress({ phase: "idle" });
  resolveSpeechBlob(); // 让等待该次播放结束的队列任务收尾，避免被外部打断后卡住
}

/** 是否正在朗读（可选传 token，仅当该来源在放时返回 true）。 */
export function isSpeaking(token) {
  if (!playing) return false;
  return token == null ? true : currentToken === token;
}

/** 朗读文本上限（码点）。过长合成慢且易糊，与本地服务 HTTP_TTS_MAX_CHARS 对齐。 */
const MAX_SPEECH_CHARS = 160;

/** 把回复文本整理成更适合朗读的纯文本：
 *  - 去掉括号内的动作/神态/语气描述（中文（）、英文()、【】、*星号*），避免被逐字念出；
 *    保留正常文字与标点，让模型自行按语境推断语气。
 *  - 关键：按行保留「句末语调」。换行不再一律压成逗号，而是行尾若没有句末标点就补「。」，
 *    让模型在句子之间有真正的停顿与语调收束——否则整段被读成「逗号流水句」，
 *    听起来平、语速均匀、机械。省略号「……」、波浪号「~」保留，自带迟疑/延音的起伏。
 *  - 超长截断到句末，避免单次合成拖到几十秒且后半段失真。 */
export function textForSpeech(text) {
  const stripped = (text || "")
    .replace(/（[^（）]*）/g, "") // 中文括号
    .replace(/\([^()]*\)/g, "")  // 英文括号
    .replace(/【[^【】]*】/g, "") // 方括号
    .replace(/\*[^*]+\*/g, "");   // *动作* 这类星号包裹

  // 逐行拼接：行尾已是句末/停顿标点则保留，否则补「。」形成句末语调。
  const lines = stripped
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  const joined = lines
    .map((line, i) =>
      i === lines.length - 1 || /[。.!！?？…~～—、，,；;：:]$/.test(line)
        ? line
        : line + "。",
    )
    .join("");

  let out = joined
    .replace(/[ \t]+/g, " ")
    .replace(/([，,。.！!？?、；;：:])\1+/g, "$1") // 合并删括号后产生的重复标点（不动「……」）
    .replace(/^[，,、。.！!？?；;\s]+/, "")          // 去掉开头多余标点
    .trim();

  const chars = [...out];
  if (chars.length > MAX_SPEECH_CHARS) {
    let cut = chars.slice(0, MAX_SPEECH_CHARS).join("");
    const seps = ["。", "！", "？", "；", "，", ",", " "];
    let best = -1;
    for (const sep of seps) {
      const i = cut.lastIndexOf(sep);
      if (i >= Math.floor(MAX_SPEECH_CHARS / 3) && i > best) best = i;
    }
    out = best >= 0 ? cut.slice(0, best + 1) : `${cut}…`;
  }
  return out;
}

/** 朗读情绪 → CosyVoice 的 rate(语速) / pitch(音调) / volume(音量) 预设。
 *  目的：让不同情绪的回复在语速/音调/音量上拉开差距，制造「情绪起伏」，
 *  避免全程一个调读得机械。数值保持温和——拉太猛 CosyVoice 会破音失真。 */
const EMOTION_PRESETS = {
  excited: { rate: 1.12, pitch: 1.1, volume: 60 }, // 开心 / 兴奋
  angry: { rate: 1.14, pitch: 1.04, volume: 66 },  // 生气 / 不满
  sad: { rate: 0.88, pitch: 0.92, volume: 44 },    // 难过 / 委屈
  gentle: { rate: 0.92, pitch: 1.05, volume: 48 }, // 温柔 / 安慰 / 撒娇
  shy: { rate: 0.94, pitch: 1.03, volume: 42 },    // 害羞 / 小声
  neutral: { rate: 1.0, pitch: 1.0, volume: 50 },  // 中性
};

/** 从「原始回复文本」（含括号里的神态/动作描述与标点）推断情绪标签。
 *  注意要用原始文本判断——textForSpeech 会把神态描述删掉，那是情绪的重要线索。 */
export function detectEmotion(raw) {
  const t = String(raw || "");
  // 括号/方括号/星号里的神态描述权重最高（如「（生气）」「*小声*」）。
  const cues = (t.match(/（[^（）]*）|\([^()]*\)|【[^【】]*】|\*[^*]+\*/g) || []).join(" ");
  const hay = `${cues} ${t}`;
  const has = (re) => re.test(hay);
  if (has(/生气|愤怒|哼|讨厌|可恶|不许|不准|凶|烦死|气死/)) return "angry";
  if (has(/难过|伤心|委屈|呜+|哭|失落|叹气|对不起|抱歉|心疼/)) return "sad";
  if (has(/害羞|脸红|小声|不好意思|羞|嘀咕|扭捏/)) return "shy";
  if (has(/温柔|抱抱|乖|安慰|轻声|摸摸|别怕|没事的|来嘛|乖乖/)) return "gentle";
  const bangs = (t.match(/[!！]/g) || []).length;
  if (
    has(/开心|高兴|兴奋|哈哈+|嘿嘿|耶+|太好了|好耶|哇+|嘻嘻|冲鸭|棒/) ||
    bangs >= 2 ||
    /[~～]/.test(t)
  )
    return "excited";
  return "neutral";
}

/** 朗读情绪 → CosyVoice v3 的自然语言情感指令（instruction）。
 *  这是「情绪起伏强烈」的真正主力：v3 复刻音色能听懂自然语言把情绪演出来，
 *  比单纯调 rate/pitch/volume（只是机械地变快变高）自然得多。
 *  约束：指令 ≤100 字符（汉字按 2 计），只描述语气/情绪，不复述正文。
 *  注意：仅 v3.5-plus / v3.5-flash / v3-flash 的复刻音色支持任意指令；
 *        v3-plus 复刻音色不支持指令控制——是否下发由后端按 model 白名单决定。 */
const EMOTION_INSTRUCTIONS = {
  excited:
    "用非常兴奋雀跃的语气说，语调大幅上扬、起伏明显，语速明显加快，关键词重读，情绪饱满外放。",
  angry:
    "用非常生气的语气说，语气重、急促有力、咬字用力，重点词狠狠加重，毫不客气。",
  sad: "用非常难过哽咽的语气说，声音低沉发颤、又轻又慢，句间带停顿和叹息，尾音下沉。",
  gentle:
    "用极其温柔宠溺的语气说，又软又慢、轻声细语，尾音上扬带撒娇感，满是安抚心疼。",
  shy: "用非常害羞扭捏的语气说，声音很小、断断续续、犹豫迟疑，时常停顿，越说越小声。",
  neutral: "", // 中性不下发指令，用默认语气
};

/** 用共享 <audio> 元素播放（已被手势加持后，自动朗读也能 play）。 */
async function playAudio(blob, myGen, { onStart, onEnd, onError }) {
  const url = URL.createObjectURL(blob);
  const audio = getSharedAudio();
  ensurePlaybackGain();
  currentUrl = url;
  audio.src = url;

  audio.onended = () => {
    if (myGen !== playGen) return; // 已被替换/停止，忽略
    stopAudio();
    playing = false;
    currentToken = null;
    onEnd?.();
  };
  audio.onerror = () => {
    if (myGen !== playGen) return; // 拆除/换源触发的 error，忽略
    stopAudio();
    playing = false;
    currentToken = null;
    onError?.(new Error("音频播放失败"));
  };

  await audio.play();
  playing = true;
  onStart?.();
  return true;
}

/** 真正向上游请求合成（带会话缓存）：同一「音色|model|参数|指令|情绪|文本」只请求一次。 */
async function synthOnce(clean, voice, model, params, instruction, emotion) {
  const key = cacheKey(clean, voice, model, params, instruction, emotion);
  const chars = [...clean].length;
  const cached = audioCache.get(key);
  if (cached) {
    emitTtsProgress({
      phase: "done",
      chars,
      elapsedMs: 0,
      cached: true,
      bytes: cached.size || 0,
      // 缓存命中不重复计费。
      billedChars: 0,
    });
    return cached;
  }

  const prog = beginSynthProgress(chars);
  try {
    // 未命中缓存才真正请求上游合成（会消耗额度）。
    // 自带 key 时随请求带上：CosyVoice 用通义千问/DashScope key（x-vl-api-key），
    // 火山(豆包)音色用火山 TTS key（x-volc-tts-api-key）；服务器配了 env 则可留空。
    const vlKey = getStoredVlApiKey();
    const volcKey = getStoredVolcKey();
    const resp = await fetch("/api/tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(vlKey ? { "x-vl-api-key": vlKey } : {}),
        ...(volcKey ? { "x-volc-tts-api-key": volcKey } : {}),
      },
      body: JSON.stringify({
        text: clean,
        params,
        emotion, // 火山分支据此选 audio.emotion；CosyVoice 分支忽略（它走 instruction）
        ...(instruction ? { instruction } : {}),
        ...(voice ? { voice } : {}),
        ...(model ? { model } : {}),
      }),
    });
    if (!resp.ok) {
      let msg = `TTS 请求失败 ${resp.status}`;
      try {
        const j = await resp.json();
        // detail 里是上游（火山/CosyVoice）真正的错误码与原因，带出来便于定位。
        msg = j.error ? (j.detail ? `${j.error}：${j.detail}` : j.error) : msg;
      } catch { /* ignore */ }
      throw new Error(msg);
    }
    // CosyVoice / 火山：代理透传计费字符（按字，非 LLM token）。
    const billedChars = Number(resp.headers.get("X-Tts-Usage-Characters")) || 0;
    const provider = (resp.headers.get("X-Tts-Usage-Provider") || "").trim();
    const blob = await resp.blob();
    putCache(audioCache, key, blob);
    prog.end({
      phase: "done",
      cached: false,
      bytes: blob.size || 0,
      billedChars,
      provider,
    });
    return blob;
  } catch (e) {
    prog.end({
      phase: "error",
      cached: false,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

/** 推导一段文本的合成参数（情绪 → instruction / params）。 */
function speechMeta(text) {
  const emotion = detectEmotion(text);
  const params = EMOTION_PRESETS[emotion] || EMOTION_PRESETS.neutral;
  const instruction = EMOTION_INSTRUCTIONS[emotion] || "";
  return { emotion, params, instruction };
}

/** 仅合成、不播放：把文本合成为音频 Blob 并返回（复用会话缓存与情绪逻辑）。
 *  空文本返回 null。用于「先合成、后顺序播放」的自动朗读队列，让下一条能提前合成。 */
export async function synthesizeSpeech(text, { voice = null, model = null } = {}) {
  const clean = textForSpeech(text);
  if (!clean) return null;
  const { emotion, params, instruction } = speechMeta(text);
  return synthOnce(clean, voice, model, params, instruction, emotion);
}

/** 播放一段已合成的音频 Blob，返回一个在「播放结束 / 出错 / 被外部停止」时 resolve 的 Promise。
 *  与 speak 共用同一个被加持的 <audio> 元素，会抢占当前播放——专供自动朗读队列顺序播放。
 *  @param onStart 真正开始播放的回调，参数为音频时长（秒，可能为 NaN）。 */
export function playSpeechBlob(blob, { onStart, onError } = {}) {
  stopSpeak();      // 抢占之前的播放（也会 resolve 上一条的等待 Promise）
  externalStop?.(); // 朗读开始前，先停掉正在放的歌，避免两个声音叠在一起
  currentToken = "auto";
  const myGen = playGen;
  const url = URL.createObjectURL(blob);
  const audio = getSharedAudio();
  ensurePlaybackGain();
  currentUrl = url;
  audio.src = url;

  return new Promise((resolve) => {
    speechBlobSettle = resolve; // 供外部 stopSpeak 打断时收尾
    const finish = (err) => {
      audio.onended = null;
      audio.onerror = null;
      if (myGen === playGen) {
        stopAudio();
        playing = false;
        currentToken = null;
      }
      if (err) onError?.(err);
      if (speechBlobSettle === resolve) speechBlobSettle = null;
      resolve();
    };
    audio.onended = () => finish(null);
    // 被换源/拆除触发的 error（已被新播放抢占）不当作真错误。
    audio.onerror = () => finish(myGen === playGen ? new Error("音频播放失败") : null);
    audio
      .play()
      .then(() => {
        if (myGen !== playGen) return;
        playing = true;
        onStart?.(audio.duration);
      })
      .catch((e) => finish(e instanceof Error ? e : new Error(String(e))));
  });
}

/**
 * 朗读一段文本。
 * @param {string} text
 * @param {object} opts
 *   token     来源标识；再次用同一 token 调用且正在放 → 停止（toggle）
 *   voice     指定音色 voice_id（留空则用服务器默认 TTS_VOICE_ID）
 *   model     指定合成模型（留空则后端按 voice_id 自动推导）
 *   onStart   开始播放回调
 *   onEnd     播放结束/被替换回调
 *   onError   出错回调
 * @returns {Promise<boolean>} 是否真正开始了播放（toggle 关闭时返回 false）
 */
export async function speak(text, { token = null, voice = null, model = null, onStart, onEnd, onError } = {}) {
  const clean = textForSpeech(text);
  if (!clean) return false;
  // 用「原始文本」（含神态描述/标点）判情绪：
  //  - instruction：v3 自然语言情感指令，制造情绪起伏的主力；
  //  - params：rate/pitch/volume 兜底，给不支持指令的音色（如 v3-plus 复刻）兜底，
  //    也能与 instruction 叠加增强起伏。
  const { emotion, params, instruction } = speechMeta(text);

  // 同一来源正在播放 → 视作"关闭"。
  if (token != null && currentToken === token && playing) {
    stopSpeak();
    onEnd?.();
    return false;
  }

  stopSpeak();
  externalStop?.(); // 朗读开始前，先停掉正在放的歌，避免两个声音叠在一起
  currentToken = token;
  const myGen = playGen; // 本次播放代号；被新的播放/停止抢占后回调即失效

  try {
    const blob = await synthOnce(clean, voice, model, params, instruction, emotion);

    // 请求/缓存取出后再次确认未被抢占。
    if (myGen !== playGen) return false;

    return await playAudio(blob, myGen, { onStart, onEnd, onError });
  } catch (e) {
    if (currentToken === token) {
      currentToken = null;
      playing = false;
    }
    onError?.(e instanceof Error ? e : new Error(String(e)));
    return false;
  }
}
