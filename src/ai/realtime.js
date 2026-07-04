// 实时语音通话控制器（前端）。
//
// 与本地 Rust 桥接（realtime.rs）的私有协议：
//   连上后先发 {type:"start", systemRole, botName}；随后：
//     上行 binary = 麦克风 PCM16 mono 16k（worklet 产出）；
//     下行 binary = 播放 PCM16 mono 24k；
//     下行 text  = 事件 JSON：
//       {type:"session",state} / {type:"asr_start"} /
//       {type:"asr",text,interim} / {type:"asr_end"} /
//       {type:"assistant",text} / {type:"assistant_end"} /
//       {type:"speaking"} / {type:"usage",...} / {type:"error",message}。
//   挂断发 {type:"hangup"}。
//
// 音频采集/播放放前端而非 Rust 的原因：getUserMedia 自带回声消除(AEC)/降噪/AGC，
// 桌宠是外放场景，没有 AEC 会自己听到自己造成啸叫与误打断。

import { getVoiceGain, onVoiceGainChange } from "./voice-volume.js";

const invoke = window.__TAURI__.core.invoke;

const OUTPUT_RATE = 24000; // 与 realtime.rs protocol::OUTPUT_SAMPLE_RATE 一致
const TARGET_RATE = 16000; // 上行目标采样率

/** 通话会话：封装 WS、麦克风采集、下行播放与打断。 */
export class RealtimeSession {
  constructor({
    onState,
    onAsrStart,
    onAsr,
    onAsrEnd,
    onAssistant,
    onAssistantEnd,
    onSpeaking,
    onUsage,
    onLevel,
    onError,
  } = {}) {
    this.cb = {
      onState,
      onAsrStart,
      onAsr,
      onAsrEnd,
      onAssistant,
      onAssistantEnd,
      onSpeaking,
      onUsage,
      onLevel,
      onError,
    };
    this.ws = null;
    this.micStream = null;
    this.audioCtx = null; // 采集+播放共用一个 AudioContext（WKWebView 解锁关键）
    this.workletNode = null;
    this.micSource = null;
    this.playHead = 0; // 下行播放调度游标
    this.stopped = false;
    this._micLevel = 0;
    this._playLevel = 0;
    this._levelRaf = 0;
    this._pendingPcm = []; // context 未 running 时暂存下行 PCM，避免排进「过去」
    this._resumingOut = false;
    this._bargeInTurn = false; // 本轮用户说话是否已打断过播报
    this._userTurnOpen = false; // asr_start…asr_end 之间为 true
    this._assistantActive = false; // 助手正在出字/出声
    this._keepAliveOsc = null;
    this._keepAliveGain = null;
    this._outGain = null; // 下行播放主音量
    this._unsubVol = null;
  }

  /**
   * 必须在电话按钮点击的同步栈内调用（任何 await 之前）。
   * 创建 AudioContext、播一帧静音、拉起 keep-alive，否则 WKWebView 首包 TTS 会静音。
   */
  prepareAudio() {
    this._initAudioCtx();
  }

  /** 开始通话：连桥接 → 发 start → 起麦克风与播放。 */
  async start({ systemRole, botName }) {
    // 若 chat.js 已在点击栈调用 prepareAudio，这里是幂等补齐。
    this._initAudioCtx();

    const base = await invoke("get_realtime_base");
    if (!base) throw new Error("实时语音服务未启动");

    await this._openSocket(base, { systemRole, botName });
    await this._resumeAudioCtx();
    await this._startMic();
    // 麦克风授权弹窗可能再次把 context 挂起，授权回来后再 resume 一次。
    await this._resumeAudioCtx();
    this._startLevelLoop();
  }

  _openSocket(base, startMsg) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(base);
      } catch (e) {
        reject(e);
        return;
      }
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      let opened = false;

      ws.onopen = () => {
        opened = true;
        ws.send(
          JSON.stringify({
            type: "start",
            systemRole: startMsg.systemRole || "",
            botName: startMsg.botName || "元元",
          }),
        );
        resolve();
      };
      ws.onmessage = (ev) => this._onMessage(ev);
      ws.onerror = () => {
        if (!opened) reject(new Error("连接实时语音服务失败"));
      };
      ws.onclose = () => {
        if (!this.stopped) this.cb.onState?.("ended");
      };
    });
  }

  _onMessage(ev) {
    if (typeof ev.data !== "string") {
      // 下行音频 PCM16 24k
      this._notePlayLevel(ev.data);
      this._enqueuePcm(ev.data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case "session":
        this.cb.onState?.(msg.state);
        break;
      case "asr_start":
        this._beginUserTurn();
        this.cb.onAsrStart?.();
        break;
      case "asr":
        // asr_end 之后的迟到识别（二遍 ASR 常见）必须忽略，
        // 否则会当成新一轮用户说话，把刚开始的助手语音整段 flush 掉 → 首句静音。
        if (!this._userTurnOpen) {
          if (this._assistantActive || this._hasPlayback()) return;
          this._beginUserTurn();
        }
        this.cb.onAsr?.(msg.text || "", { interim: msg.interim !== false });
        break;
      case "asr_end":
        this._userTurnOpen = false;
        this.cb.onAsrEnd?.();
        break;
      case "assistant":
        this._assistantActive = true;
        this.cb.onAssistant?.(msg.text || "");
        break;
      case "assistant_end":
        this._assistantActive = false;
        this.cb.onAssistantEnd?.();
        break;
      case "speaking":
        this._assistantActive = true;
        this.cb.onSpeaking?.();
        break;
      case "usage":
        this.cb.onUsage?.(msg);
        break;
      case "error":
        this.cb.onError?.(new Error(msg.message || "实时语音出错"));
        break;
      default:
        break;
    }
  }

  // ---- 电平：供声波可视化（麦克风 + 下行播放取较大值）----
  _rmsI16(arrayBuffer) {
    const i16 = new Int16Array(arrayBuffer);
    if (!i16.length) return 0;
    let sum = 0;
    // 抽样，避免每帧全量扫描。
    const step = Math.max(1, (i16.length / 64) | 0);
    let n = 0;
    for (let i = 0; i < i16.length; i += step) {
      const v = i16[i] / 0x8000;
      sum += v * v;
      n++;
    }
    return Math.sqrt(sum / Math.max(1, n));
  }

  _noteMicLevel(arrayBuffer) {
    const r = this._rmsI16(arrayBuffer);
    this._micLevel = Math.max(this._micLevel * 0.6, r);
  }

  _notePlayLevel(arrayBuffer) {
    const r = this._rmsI16(arrayBuffer);
    this._playLevel = Math.max(this._playLevel * 0.55, r);
  }

  _startLevelLoop() {
    const tick = () => {
      if (this.stopped) return;
      // 缓慢衰减，让波形有回落感。
      this._micLevel *= 0.88;
      this._playLevel *= 0.9;
      const level = Math.min(1, Math.max(this._micLevel, this._playLevel) * 2.4);
      this.cb.onLevel?.(level);
      this._levelRaf = requestAnimationFrame(tick);
    };
    this._levelRaf = requestAnimationFrame(tick);
  }

  // ---- 下行播放：把 24k PCM16 顺序调度到 AudioContext ----

  /** 在用户手势同步栈内创建 context（不要 await）。采集与播放共用。 */
  _initAudioCtx() {
    if (!this.audioCtx) {
      // 不强制采样率（部分 WebView 不允许任意值会抛错）；
      // createBuffer 里标记 24k，播放时由 Web Audio 自动重采样。
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const ctx = this.audioCtx;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    if (!this._outGain) {
      this._outGain = ctx.createGain();
      this._outGain.gain.value = getVoiceGain();
      this._outGain.connect(ctx.destination);
      this._unsubVol = onVoiceGainChange((g) => {
        if (this._outGain) this._outGain.gain.value = g;
      });
    }
    // 手势栈内播一帧近乎静音的缓冲，真正「解锁」WKWebView 音频会话。
    try {
      const n = Math.max(1, (ctx.sampleRate * 0.05) | 0);
      const buf = ctx.createBuffer(1, n, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      src.connect(g);
      g.connect(ctx.destination);
      src.start(0);
    } catch {
      /* ignore */
    }
    // 静音振荡器保活，避免通话中途 context 被自动挂起。
    if (!this._keepAliveOsc) {
      try {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        g.gain.value = 0;
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start();
        this._keepAliveOsc = osc;
        this._keepAliveGain = g;
      } catch {
        /* ignore */
      }
    }
    this.playHead = ctx.currentTime;
  }

  async _resumeAudioCtx() {
    if (!this.audioCtx || this.stopped) return;
    if (this.audioCtx.state === "suspended") {
      try {
        await this.audioCtx.resume();
      } catch {
        /* ignore */
      }
    }
    this.playHead = this.audioCtx.currentTime;
    this._flushPendingPcm();
  }

  _beginUserTurn() {
    // 仅在「新开一轮」时打断播报；同一轮内的重复 asr_start/asr 不再 flush。
    const alreadyOpen = this._userTurnOpen;
    this._userTurnOpen = true;
    this._assistantActive = false;
    if (alreadyOpen) return;
    this._bargeInTurn = true;
    this._flushPlayback();
  }

  _hasPlayback() {
    return (this._sources && this._sources.size > 0) || this._pendingPcm.length > 0;
  }

  _enqueuePcm(arrayBuffer) {
    if (!this.audioCtx || this.stopped) return;
    this._assistantActive = true;
    // context 尚未 running：先入队，resume 后再播，避免 start(过去时间) 整段静音。
    if (this.audioCtx.state !== "running") {
      this._pendingPcm.push(arrayBuffer.slice ? arrayBuffer.slice(0) : arrayBuffer);
      this._kickResumeOut();
      return;
    }
    this._flushPendingPcm();
    this._enqueuePcmNow(arrayBuffer);
  }

  _kickResumeOut() {
    if (!this.audioCtx || this._resumingOut || this.stopped) return;
    this._resumingOut = true;
    this.audioCtx
      .resume()
      .catch(() => {})
      .finally(() => {
        this._resumingOut = false;
        if (this.stopped || !this.audioCtx) return;
        if (this.audioCtx.state === "running") {
          this.playHead = this.audioCtx.currentTime;
          this._flushPendingPcm();
        }
      });
  }

  _flushPendingPcm() {
    if (!this._pendingPcm.length || !this.audioCtx || this.audioCtx.state !== "running") return;
    const pending = this._pendingPcm;
    this._pendingPcm = [];
    for (const chunk of pending) this._enqueuePcmNow(chunk);
  }

  _enqueuePcmNow(arrayBuffer) {
    const i16 = new Int16Array(arrayBuffer);
    if (!i16.length) return;
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;
    const buf = this.audioCtx.createBuffer(1, f32.length, OUTPUT_RATE);
    buf.getChannelData(0).set(f32);
    const src = this.audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this._outGain || this.audioCtx.destination);
    // 略加超前量，避免 now 与调度竞态导致首帧被跳过。
    const now = this.audioCtx.currentTime + 0.02;
    if (this.playHead < now) this.playHead = now;
    src.start(this.playHead);
    this.playHead += buf.duration;
    (this._sources ||= new Set()).add(src);
    src.onended = () => this._sources?.delete(src);
  }

  /** 打断：停掉所有排队中的播放源，重置游标。 */
  _flushPlayback() {
    this._pendingPcm = [];
    if (this._sources) {
      for (const s of this._sources) {
        try {
          s.stop();
        } catch {
          /* ignore */
        }
      }
      this._sources.clear();
    }
    if (this.audioCtx) this.playHead = this.audioCtx.currentTime;
    this._playLevel = 0;
  }

  // ---- 上行采集：麦克风 → worklet → WS（与播放共用 audioCtx）----
  async _startMic() {
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    const ctx = this.audioCtx;
    if (!ctx) throw new Error("音频上下文未初始化");
    if (ctx.state === "suspended") await ctx.resume();
    await ctx.audioWorklet.addModule("./ai/pcm-worklet.js");
    this.micSource = ctx.createMediaStreamSource(this.micStream);
    this.workletNode = new AudioWorkletNode(ctx, "pcm-capture", {
      processorOptions: { targetRate: TARGET_RATE },
    });
    this.workletNode.port.onmessage = (e) => {
      // e.data 是 Int16 PCM 的 ArrayBuffer，直接上行。
      this._noteMicLevel(e.data);
      if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.stopped) {
        this.ws.send(e.data);
      }
    };
    this.micSource.connect(this.workletNode);
    // 不接到 destination，避免把麦克风原声播出去。
  }

  /** 挂断并清理所有资源。 */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this._levelRaf) cancelAnimationFrame(this._levelRaf);
    this._levelRaf = 0;
    this.cb.onLevel?.(0);
    try {
      this._unsubVol?.();
    } catch {
      /* ignore */
    }
    this._unsubVol = null;
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "hangup" }));
      }
    } catch {
      /* ignore */
    }
    this._flushPlayback();
    try {
      this._keepAliveOsc?.stop();
    } catch {
      /* ignore */
    }
    this._keepAliveOsc = null;
    this._keepAliveGain = null;
    this._outGain = null;
    try {
      this.workletNode?.disconnect();
      this.micSource?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.micStream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    try {
      await this.audioCtx?.close();
    } catch {
      /* ignore */
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.micStream = null;
    this.audioCtx = null;
    this.workletNode = null;
    this.micSource = null;
  }
}
