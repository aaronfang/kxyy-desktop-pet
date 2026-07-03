// AudioWorklet 处理器：把麦克风音频重采样为 16kHz、转 Int16(s16le)，按帧 postMessage 回主线程。
// 放在 worklet 线程做转换，避免主线程卡顿；主线程再把 Int16 帧经 WS 上行给本地桥接。

class Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.inRate = sampleRate; // worklet 全局：输入采样率（通常 48000）
    this.ratio = this.inRate / this.targetRate;
    this._acc = 0; // 重采样相位累加
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
    // 线性插值降采样：按相位从输入取样。
    for (let i = 0; i < ch.length; i++) {
      this._acc += 1;
      while (this._acc >= this.ratio) {
        this._acc -= this.ratio;
        this._pushSample(ch[i]);
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", Capture);
