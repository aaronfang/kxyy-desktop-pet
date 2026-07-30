// 发布版本地 Qwen3-TTS 音色清单。音频本体随 Tauri resources 发布；评测产物不进入前端。
export const LOCAL_VOICE_PRESETS = Object.freeze([
  Object.freeze({
    id: "top-01-utt_9627ec90ea95",
    label: "音色 01 · 最高相似度",
    referenceId: "utt_9627ec90ea95",
    score: 0.705453,
    source: "src_05",
  }),
  Object.freeze({
    id: "top-02-utt_6c1df874b5cf",
    label: "音色 02 · 高相似度",
    referenceId: "utt_6c1df874b5cf",
    score: 0.695162,
    source: "src_03",
  }),
  Object.freeze({
    id: "top-03-utt_5ddd742c7b76",
    label: "音色 03 · 高相似度",
    referenceId: "utt_5ddd742c7b76",
    score: 0.675161,
    source: "src_14",
  }),
  Object.freeze({
    id: "top-04-utt_556f6e551772",
    label: "音色 04 · 高相似度",
    referenceId: "utt_556f6e551772",
    score: 0.67356,
    source: "src_10",
  }),
  Object.freeze({
    id: "top-05-utt_b26b8f2ec4ac",
    label: "音色 05 · 高相似度",
    referenceId: "utt_b26b8f2ec4ac",
    score: 0.654834,
    source: "src_04",
  }),
  Object.freeze({
    id: "legacy-12s",
    label: "旧参考音 · 最早基线",
    referenceId: "control-current",
    score: null,
    source: "legacy",
    legacy: true,
  }),
]);

export function localVoicePresetById(id) {
  const wanted = String(id || "").trim();
  return LOCAL_VOICE_PRESETS.find((preset) => preset.id === wanted) || null;
}

export function localVoicePresetLabel(id) {
  return localVoicePresetById(id)?.label || "默认参考音";
}
