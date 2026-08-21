const TAU = Math.PI * 2;

const LAYERS = [
  {
    alpha: .72,
    curves: [
      { offset: -3.2, width: 2.5, speed: .86, phase: .3, amplitude: .74, direction: 1 },
      { offset: 1.8, width: 1.55, speed: 1.08, phase: 2.1, amplitude: .92, direction: -1 },
      { offset: 4.1, width: 2.2, speed: .72, phase: 4.4, amplitude: .66, direction: 1 },
    ],
  },
  {
    alpha: .78,
    curves: [
      { offset: -4.4, width: 1.8, speed: .96, phase: 1.2, amplitude: .78, direction: -1 },
      { offset: -.5, width: 2.75, speed: .78, phase: 3.5, amplitude: 1, direction: 1 },
      { offset: 3.4, width: 1.7, speed: 1.14, phase: 5.3, amplitude: .72, direction: -1 },
    ],
  },
  {
    alpha: .76,
    curves: [
      { offset: -2.7, width: 1.4, speed: 1.1, phase: 2.7, amplitude: .82, direction: 1 },
      { offset: 1.1, width: 2.35, speed: .82, phase: 4.8, amplitude: .94, direction: -1 },
      { offset: 4.7, width: 1.6, speed: .92, phase: .7, amplitude: .7, direction: 1 },
    ],
  },
  {
    alpha: .7,
    curves: [
      { offset: -4.8, width: 2.2, speed: .74, phase: 4, amplitude: .62, direction: -1 },
      { offset: -.9, width: 1.65, speed: 1.04, phase: .9, amplitude: .88, direction: 1 },
      { offset: 3, width: 2.6, speed: .88, phase: 3.1, amplitude: .76, direction: -1 },
    ],
  },
];

export const SIRIWAVE_STATES = Object.freeze([
  "idle",
  "listening",
  "candidate",
  "thinking",
  "speaking",
  "error",
]);

const PALETTES = Object.freeze({
  idle: [[45, 226, 166], [37, 168, 255], [105, 92, 255], [235, 67, 181]],
  listening: [[41, 232, 186], [26, 203, 224], [43, 139, 255], [96, 99, 255]],
  candidate: [[255, 225, 82], [255, 178, 45], [255, 121, 42], [241, 79, 72]],
  thinking: [[98, 239, 176], [39, 205, 139], [39, 184, 190], [76, 151, 241]],
  speaking: [[255, 106, 151], [244, 65, 156], [211, 68, 220], [255, 103, 92]],
  error: [[255, 92, 86], [238, 56, 65], [210, 40, 73], [255, 129, 52]],
});

function normalizeState(state) {
  return Object.hasOwn(PALETTES, state) ? state : "idle";
}

function mixColor(from, to, amount) {
  return from.map((channel, index) => Math.round(channel + (to[index] - channel) * amount));
}

function attenuation(x) {
  return Math.pow(4 / (4 + x * x), 4);
}

export function createSiriWaveModernRenderer(canvas, options = {}) {
  const ctx = canvas?.getContext?.("2d");
  let filteredLevel = 0;
  let level = 0;
  let phase = 0;
  let lastFrame = null;
  let visible = false;
  let state = normalizeState(options.state);
  let palette = PALETTES[state].map((color) => [...color]);
  let paletteFrom = palette.map((color) => [...color]);
  let paletteTarget = palette.map((color) => [...color]);
  let paletteChangedAt = null;

  function relativeY(t, layer, activity) {
    const graphX = (t - .5) * 25;
    let y = 0;
    for (const curve of layer.curves) {
      const localX = graphX / curve.width - curve.offset * 1.7;
      const wave = Math.sin(curve.direction * localX - phase * curve.speed + curve.phase);
      y += Math.abs(curve.amplitude * wave * attenuation(localX));
    }
    return Math.min(
      1,
      y / layer.curves.length * attenuation((t - .5) * 4) * activity * 4.8,
    );
  }

  function drawShape(width, center, maxAmplitude, layer, color, activity) {
    ctx.beginPath();
    ctx.moveTo(0, center);
    for (let x = 0; x <= width; x += 2) {
      const y = relativeY(x / width, layer, activity) * maxAmplitude;
      ctx.lineTo(x, center - y);
    }
    for (let x = width; x >= 0; x -= 2) {
      const y = relativeY(x / width, layer, activity) * maxAmplitude;
      ctx.lineTo(x, center + y);
    }
    ctx.closePath();
    ctx.fillStyle = `rgba(${color.join(", ")}, ${layer.alpha})`;
    ctx.fill();
  }

  function setState(nextState, now = performance.now()) {
    const normalized = normalizeState(nextState);
    if (normalized === state) return state;
    state = normalized;
    paletteFrom = palette.map((color) => [...color]);
    paletteTarget = PALETTES[state].map((color) => [...color]);
    paletteChangedAt = now;
    return state;
  }

  function draw(inputLevel = 0, _waveform = null, now = performance.now()) {
    if (!ctx || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.round(rect.width * dpr));
    const pixelHeight = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }

    const elapsed = lastFrame === null ? 16.67 : Math.max(0, Math.min(50, now - lastFrame));
    lastFrame = now;
    if (paletteChangedAt !== null) {
      const progress = Math.min(1, Math.max(0, (now - paletteChangedAt) / 200));
      const eased = 1 - Math.pow(1 - progress, 3);
      palette = paletteFrom.map((color, index) => mixColor(color, paletteTarget[index], eased));
      if (progress === 1) paletteChangedAt = null;
    }
    const rawLevel = Math.min(1, Math.max(0, Number(inputLevel) || 0));
    const speechOnset = filteredLevel < .08 && rawLevel > .14;
    const inputResponseMs = speechOnset ? 5 : 60;
    filteredLevel += (rawLevel - filteredLevel) * (1 - Math.exp(-elapsed / inputResponseMs));
    const responseMs = filteredLevel > level ? (speechOnset ? 12 : 45) : 120;
    level += (filteredLevel - level) * (1 - Math.exp(-elapsed / responseMs));
    if (visible ? level < .012 : level > .028) visible = !visible;
    const phaseSpeed = .0034 + Math.sqrt(level) * .0028;
    phase = (phase + elapsed * phaseSpeed) % TAU;

    const width = rect.width;
    const center = rect.height / 2;
    const maxAmplitude = Math.max(2.5, center - 2);
    const activity = visible ? Math.min(1.62, Math.pow(level, .68) * 2.9) : 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, rect.height);
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = .82;
    for (let index = 0; index < LAYERS.length; index++) {
      drawShape(width, center, maxAmplitude, LAYERS[index], palette[index], activity);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    const baseline = ctx.createLinearGradient(0, 0, width, 0);
    baseline.addColorStop(0, "rgba(255,255,255,0)");
    const baselineColor = palette[1];
    baseline.addColorStop(.1, `rgba(${baselineColor.join(",")},.5)`);
    baseline.addColorStop(.9, `rgba(${baselineColor.join(",")},.5)`);
    baseline.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = baseline;
    ctx.fillRect(0, center - .35, width, .7);
  }

  function reset() {
    filteredLevel = 0;
    level = 0;
    phase = 0;
    lastFrame = null;
    visible = false;
    if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  return { draw, reset, setState, getState: () => state };
}
