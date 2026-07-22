// Realtime PCM playback worklet.
//
// Input messages:
//   {type:"audio", pcm:ArrayBuffer} - PCM16 mono @ sourceRate
//   {type:"duck"}                   - 30ms fade-out, then pause consumption
//   {type:"resume"}                 - resume consumption with 60ms fade-in
//   {type:"clear"}                  - discard queued audio immediately
//
// The ring is intentionally bounded. During a long pause it preserves the
// earliest continuation and rejects overflow instead of growing without limit.

class PcmPlayback extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.sourceRate = Number(opts.sourceRate) || 24000;
    this.maxQueueMs = Math.max(250, Math.min(5000, Number(opts.maxQueueMs) || 3000));
    this.capacity = Math.max(2, Math.ceil((this.sourceRate * this.maxQueueMs) / 1000));
    this.ring = new Float32Array(this.capacity);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.size = 0;
    this.phase = 0;
    this.step = this.sourceRate / sampleRate;
    this.state = "playing";
    this.gain = 1;
    this.duckStep = 1 / Math.max(1, sampleRate * 0.03);
    this.resumeStep = 1 / Math.max(1, sampleRate * 0.06);
    this.underruns = 0;
    this.droppedSamples = 0;
    this.playedSamples = 0;
    this.outputFramesSinceStats = 0;
    this.wasAudible = false;

    this.port.onmessage = (event) => this._onMessage(event.data || {});
  }

  _queuedMs() {
    return (this.size * 1000) / this.sourceRate;
  }

  _post(type) {
    this.port.postMessage({
      type,
      queuedMs: this._queuedMs(),
      underruns: this.underruns,
      droppedSamples: this.droppedSamples,
      playedSamples: this.playedSamples,
      state: this.state,
    });
  }

  _onMessage(message) {
    switch (message.type) {
      case "audio":
        this._appendPcm(message.pcm);
        break;
      case "duck":
        if (this.state !== "paused") this.state = "ducking";
        break;
      case "resume":
        this.state = "resuming";
        if (this.gain > 1) this.gain = 1;
        break;
      case "clear":
        this.readIndex = 0;
        this.writeIndex = 0;
        this.size = 0;
        this.phase = 0;
        this.state = "playing";
        this.gain = 1;
        this.wasAudible = false;
        this._post("cleared");
        break;
      default:
        break;
    }
  }

  _appendPcm(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 2) return;
    const input = new Int16Array(buffer);
    let accepted = 0;
    for (let i = 0; i < input.length; i++) {
      if (this.size >= this.capacity) {
        this.droppedSamples += input.length - i;
        break;
      }
      this.ring[this.writeIndex] = input[i] / 0x8000;
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
      this.size += 1;
      accepted += 1;
    }
    if (accepted > 0) this._post("queued");
  }

  _readSample() {
    if (this.size === 0) return null;
    const a = this.ring[this.readIndex];
    const b = this.size > 1 ? this.ring[(this.readIndex + 1) % this.capacity] : a;
    const value = a + (b - a) * this.phase;
    this.phase += this.step;
    while (this.phase >= 1 && this.size > 0) {
      this.phase -= 1;
      this.readIndex = (this.readIndex + 1) % this.capacity;
      this.size -= 1;
      this.playedSamples += 1;
    }
    return value;
  }

  _nextGain() {
    if (this.state === "ducking") {
      this.gain = Math.max(0, this.gain - this.duckStep);
      if (this.gain === 0) this.state = "paused";
    } else if (this.state === "resuming") {
      this.gain = Math.min(1, this.gain + this.resumeStep);
      if (this.gain === 1) this.state = "playing";
    }
    return this.gain;
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    let audibleThisBlock = false;
    let underrunThisBlock = false;

    for (let i = 0; i < output.length; i++) {
      const gain = this._nextGain();
      if (this.state === "paused") {
        output[i] = 0;
        continue;
      }
      const sample = this._readSample();
      if (sample === null) {
        output[i] = 0;
        underrunThisBlock = this.wasAudible;
      } else {
        output[i] = sample * gain;
        audibleThisBlock = audibleThisBlock || gain > 0;
      }
    }

    if (audibleThisBlock && !this.wasAudible) this._post("started");
    if (underrunThisBlock) {
      this.underruns += 1;
      this._post("drained");
    }
    this.wasAudible = audibleThisBlock || (this.size > 0 && this.state !== "paused");

    this.outputFramesSinceStats += output.length;
    if (this.outputFramesSinceStats >= sampleRate / 2) {
      this.outputFramesSinceStats = 0;
      this._post("stats");
    }
    return true;
  }
}

registerProcessor("pcm-playback", PcmPlayback);
