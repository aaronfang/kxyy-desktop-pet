// AudioWorklet 处理器：把麦克风音频重采样为 16kHz、转 Int16(s16le)，按帧 postMessage 回主线程。
// 放在 worklet 线程做转换，避免主线程卡顿；主线程再把 Int16 帧经 WS 上行给本地桥接。

class Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.inRate = sampleRate; // worklet 全局：输入采样率（通常 48000）
    this.ratio = this.inRate / this.targetRate;
    this._inputIndex = 0;
    this._nextOutputAt = 0;
    this._previous = 0;
    this._filtered = 0;
    this._initialized = false;
    // 降采样前做一阶低通，抑制目标 Nyquist 以上的明显混叠；状态跨 render quantum 保留。
    const cutoff = Math.min(this.targetRate * 0.45, this.inRate * 0.45);
    this._lowpassAlpha = 1 - Math.exp((-2 * Math.PI * cutoff) / this.inRate);
    // 上行帧长：约 20ms @16k = 320 样本；攒满一帧再发，降低消息频率。
    this.frameSamples = 320;
    this._buf = new Int16Array(this.frameSamples);
    this._len = 0;
  }

  _pushSample(f) {
    // Float32 [-1,1] → Int16
    let s = Math.max(-1, Math.min(1, f));
    this._buf[this._len++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this._len >= this.frameSamples) {
      // 拷贝出去（transfer 底层 buffer，避免复制开销）。
      const out = this._buf.slice(0, this._len);
      this.port.postMessage(out.buffer, [out.buffer]);
      this._buf = new Int16Array(this.frameSamples);
      this._len = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0]; // 单声道
    if (this.ratio === 1) {
      for (let i = 0; i < ch.length; i++) this._pushSample(ch[i]);
      return true;
    }
    // 有状态低通 + 线性插值；支持 48k、44.1k 等整数/非整数采样率，
    // 且 render quantum 边界不会重置相位。
    for (let i = 0; i < ch.length; i++) {
      const raw = ch[i];
      this._filtered += this._lowpassAlpha * (raw - this._filtered);
      if (!this._initialized) {
        this._previous = this._filtered;
        this._initialized = true;
      }

      const currentAt = this._inputIndex;
      while (this._nextOutputAt <= currentAt) {
        const intervalStart = Math.max(0, currentAt - 1);
        const fraction = Math.max(0, Math.min(1, this._nextOutputAt - intervalStart));
        this._pushSample(this._previous + (this._filtered - this._previous) * fraction);
        this._nextOutputAt += this.ratio;
      }
      this._previous = this._filtered;
      this._inputIndex += 1;
    }
    return true;
  }
}

registerProcessor("pcm-capture", Capture);
