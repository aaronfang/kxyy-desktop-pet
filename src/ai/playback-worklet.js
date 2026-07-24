// Realtime PCM playback worklet.
//
// Input messages:
//   {type:"audio", pcm:ArrayBuffer, generation?, segmentId?} - PCM16 mono @ sourceRate
//   {type:"segment_start|segment_end", generation, segmentId}
//   {type:"candidate_snapshot", candidateId} - exact current-segment playback snapshot
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
    this.spans = [];
    this.segments = new Map();
    this.maxSpans = 128;
    this.maxSegments = 64;
    this.activeSegmentKey = null;

    this.port.onmessage = (event) => this._onMessage(event.data || {});
  }

  _queuedMs() {
    return (this.size * 1000) / this.sourceRate;
  }

  _post(type, extra = {}) {
    this.port.postMessage({
      type,
      queuedMs: this._queuedMs(),
      underruns: this.underruns,
      droppedSamples: this.droppedSamples,
      playedSamples: this.playedSamples,
      state: this.state,
      ...extra,
    });
  }

  _segmentKey(generation, segmentId) {
    return `${generation}:${segmentId}`;
  }

  _segmentMeta(message) {
    const generation = message.generation;
    const segmentId = message.segmentId;
    if (
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      !Number.isSafeInteger(segmentId) ||
      segmentId < 1
    )
      return null;
    return { generation, segmentId, key: this._segmentKey(generation, segmentId) };
  }

  _ensureSegment(meta) {
    if (!meta) return null;
    let segment = this.segments.get(meta.key);
    if (segment) return segment;
    if (this.segments.size >= this.maxSegments) return null;
    segment = {
      generation: meta.generation,
      segmentId: meta.segmentId,
      pending: 0,
      played: 0,
      started: false,
      ended: false,
      dropped: false,
    };
    this.segments.set(meta.key, segment);
    return segment;
  }

  _completeSegment(meta, segment) {
    if (!segment || !segment.ended || segment.pending > 0) return;
    this.segments.delete(meta.key);
    if (!segment.dropped && segment.played > 0) {
      this._post("segment_completed", {
        generation: segment.generation,
        segmentId: segment.segmentId,
        playedSamples: segment.played,
      });
    }
  }

  _onMessage(message) {
    switch (message.type) {
      case "audio":
        this._appendPcm(message);
        break;
      case "segment_start": {
        const meta = this._segmentMeta(message);
        this._ensureSegment(meta);
        break;
      }
      case "segment_end": {
        const meta = this._segmentMeta(message);
        const segment = meta ? this.segments.get(meta.key) : null;
        if (segment) {
          segment.ended = true;
          this._completeSegment(meta, segment);
        }
        break;
      }
      case "candidate_snapshot": {
        const candidateId = message.candidateId;
        if (
          !Number.isSafeInteger(candidateId) ||
          candidateId < 1 ||
          candidateId > 0xffffffff
        )
          break;
        const segment = this.activeSegmentKey
          ? this.segments.get(this.activeSegmentKey)
          : null;
        if (segment && !segment.dropped && segment.pending > 0) {
          this._post("candidate_snapshot", {
            candidateId,
            generation: segment.generation,
            segmentId: segment.segmentId,
            playedSamples: segment.played,
            inProgress: true,
          });
        } else {
          this._post("candidate_snapshot", {
            candidateId,
            playedSamples: 0,
            inProgress: false,
          });
        }
        break;
      }
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
        this.spans = [];
        this.segments.clear();
        this.activeSegmentKey = null;
        this.state = "playing";
        this.gain = 1;
        this.wasAudible = false;
        this._post("cleared");
        break;
      default:
        break;
    }
  }

  _appendPcm(message) {
    const buffer = message.pcm;
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 2) return;
    const input = new Int16Array(buffer);
    const meta = this._segmentMeta(message);
    const segment = this._ensureSegment(meta);
    const spanKey = meta?.key || null;
    const lastSpan = this.spans[this.spans.length - 1];
    const canMergeSpan = Boolean(lastSpan && lastSpan.key === spanKey);
    let accepted = 0;
    if (!canMergeSpan && this.spans.length >= this.maxSpans) {
      this.droppedSamples += input.length;
      if (segment) segment.dropped = true;
      this._post("queued");
      return;
    }
    for (let i = 0; i < input.length; i++) {
      if (this.size >= this.capacity) {
        this.droppedSamples += input.length - i;
        if (segment) segment.dropped = true;
        break;
      }
      this.ring[this.writeIndex] = input[i] / 0x8000;
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
      this.size += 1;
      accepted += 1;
    }
    if (accepted > 0) {
      if (canMergeSpan) lastSpan.remaining += accepted;
      else this.spans.push({ key: spanKey, remaining: accepted });
      if (segment) segment.pending += accepted;
    }
    if (accepted > 0) this._post("queued");
  }

  _consumeSpanSample() {
    while (this.spans.length && this.spans[0].remaining <= 0) this.spans.shift();
    const span = this.spans[0];
    if (!span) return;
    span.remaining -= 1;
    if (!span.key) return;
    const segment = this.segments.get(span.key);
    if (!segment) return;
    this.activeSegmentKey = span.key;
    segment.pending = Math.max(0, segment.pending - 1);
    segment.played += 1;
    if (!segment.started) {
      segment.started = true;
      this._post("segment_started", {
        generation: segment.generation,
        segmentId: segment.segmentId,
      });
    }
    if (segment.pending === 0 && segment.ended) {
      this._completeSegment(
        {
          generation: segment.generation,
          segmentId: segment.segmentId,
          key: span.key,
        },
        segment,
      );
    }
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
      this._consumeSpanSample();
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
