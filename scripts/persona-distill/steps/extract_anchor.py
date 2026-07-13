"""
Step 2 (增强版): 提取主播干净语音 — 完整工作流
================================================

将 Demucs 分离后的 vocals.wav 转化为只包含目标说话人（主播）的干净语音。

管线:
  1. VAD + CAM++ sub-chunk 声纹匹配 → keep_ranges（主播语音的时间区间）
  2. 从 keep_ranges 提取音频、拼接为紧凑工作区（跳过静音与他人声）
  3. 分块送入 MossFormer2_SS_16K 语音分离（每块 ~5min）
  4. CAM++ 选取主播音轨 → 拼接
  5. margin trim 后处理（裁剪边界残留）

对比旧的 diarize 步骤:
  - diarize: 简单 VAD + KMeans 聚类 → 拼接原始人声（仍含背景歌声）
  - extract_anchor: VAD + CAM++ + MossFormer2 分离 → 干净主播语音

用法:
  from steps.extract_anchor import extract_anchor_speech

  output_wav = extract_anchor_speech(
      vocals_path=Path("output/vocals/htdemucs/live_001/vocals.wav"),
      output_dir=Path("output/anchor"),
      reference_wav=Path("sample_wav/kxyy-vocal-sample/kxyy-vocal-sample-12s.wav"),
  )
"""

import io
import json
import sys
import time
import warnings
from pathlib import Path
from typing import List, Dict, Optional, Tuple

import numpy as np
import soundfile as sf
import torch

sys.path.insert(0, str(Path(__file__).parent.parent))
from steps import diarize, isolation


# ---------------------------------------------------------------------------
# 公共入口
# ---------------------------------------------------------------------------

def extract_anchor_speech(
    vocals_path: Path,
    output_dir: Path,
    reference_wav: Optional[Path] = None,
    device: str = "cuda",
    similarity_threshold: float = 0.38,
    chunk_duration_s: float = 300.0,
    margin_ms: int = 300,
    fade_ms: int = 15,
    force: bool = False,
    keep_intermediates: bool = False,
    name: Optional[str] = None,
) -> Path:
    """
    一站式提取主播干净语音。

    Args:
        vocals_path: Demucs 分离后的 vocals.wav
        output_dir: 输出目录（存放中间结果和最终产物）
        reference_wav: 目标说话人参考音频（10-30s，无BGM/他人声）
        device: 推理设备
        similarity_threshold: CAM++ 余弦相似度阈值（0-1）
        chunk_duration_s: 每个处理块的时长（秒），控制显存
        margin_ms: 最终后处理的边界裁剪毫秒数
        fade_ms: 段间过渡淡化毫秒数
        force: 忽略缓存重新处理
        keep_intermediates: 保留中间 WAV 文件（调试用）
        name: 输出文件前缀（用于区分不同直播回放），默认使用 vocals_path.stem

    Returns:
        Path: 最终干净主播语音 WAV 文件
    """
    stem = name if name else vocals_path.stem
    output_dir.mkdir(parents=True, exist_ok=True)

    labels_cache = output_dir / f"{stem}_labels.json"
    final_output = output_dir / f"{stem}_anchor.wav"

    # 缓存：如果最终输出存在且不强制重算，直接返回
    if final_output.exists() and not force:
        print(f"[extract_anchor] Cached result: {final_output}")
        return final_output

    t_total = time.time()

    # ── Step 1: Isolation labeling ──────────────────────────────────
    print(f"\n{'='*60}")
    print(f"[1/5] Speaker labeling (VAD + CAM++ sub-chunk)")
    print(f"{'='*60}")

    if labels_cache.exists() and not force:
        print(f"[extract_anchor] Loading cached labels: {labels_cache}")
        with open(labels_cache, "r", encoding="utf-8") as f:
            labels = json.load(f)
    else:
        labels = isolation.label_speakers_subchunk(
            vocals_path,
            device=device,
            reference_wav=reference_wav,
            similarity_threshold=similarity_threshold,
        )

        # 自动回退：如果 CAM++ 参考匹配率太低，切换到 "分离所有" 模式
        # 不再用 KMeans（Demucs vocals 上 CAM++ 嵌入不可靠），
        # 而是把所有人声送入 MossFormer2，让它在干净分离后做 CAM++ 选轨
        yy_dur = sum(s.get("duration_ms", 0) for s in labels if s.get("is_yuanyuan")) / 1000
        total_dur = sum(s.get("duration_ms", 0) for s in labels) / 1000
        match_ratio = yy_dur / max(1, total_dur)
        _FALLBACK_RATIO = 0.02  # 低于 2% → CAM++ 子段匹配完全失效

        if len(labels) > 0 and match_ratio < _FALLBACK_RATIO:
            print(f"[extract_anchor] CAM++ ref-match: {yy_dur:.1f}s / {total_dur:.1f}s "
                  f"({match_ratio:.1%}) < {_FALLBACK_RATIO:.0%} — "
                  f"enhance all {total_dur:.1f}s speech with FRCRN (single-speaker mode)")
            # 标记所有 VAD 段为 yuanyuan，全部送入 FRCRN 增强
            labels = [{**s, "is_yuanyuan": True} for s in labels]

        with open(labels_cache, "w", encoding="utf-8") as f:
            json.dump(labels, f, ensure_ascii=False, indent=2)
        print(f"[extract_anchor] Labels saved: {labels_cache}")

    if not labels:
        print("[extract_anchor] ERROR: No speech segments found!")
        return None

    # 收集 keep_ranges
    keep_ranges = _collect_keep_ranges(labels)
    if not keep_ranges:
        print("[extract_anchor] ERROR: No anchor keep_ranges!")
        return None

    total_anchor_s = sum(e - s for s, e in keep_ranges) / 1000
    print(f"[extract_anchor] {len(keep_ranges)} keep_ranges, "
          f"{total_anchor_s:.1f}s anchor speech")

    # ── Step 2: Extract & build processing chunks ────────────────────
    print(f"\n{'='*60}")
    print(f"[2/5] Building processing chunks (target ~{chunk_duration_s:.0f}s each)")
    print(f"{'='*60}")

    chunks = _build_chunks(keep_ranges, chunk_duration_s)
    print(f"[extract_anchor] {len(chunks)} chunk(s)")

    # ── Step 3-4: Voice processing per chunk ────────────────────────
    separate_all_mode = all(s.get("is_yuanyuan") for s in labels) if labels else False
    if separate_all_mode:
        print(f"\n{'='*60}")
        print(f"[3/5] FRCRN speech enhancement per chunk (single-speaker mode)")
        print(f"{'='*60}")
    else:
        print(f"\n{'='*60}")
        print(f"[3/5] MossFormer2 voice separation per chunk")
        print(f"{'='*60}")

    anchor_tracks = []
    for ci, chunk_ranges in enumerate(chunks):
        chunk_label = f"chunk_{ci:03d}"
        chunk_input = output_dir / f"{stem}_{chunk_label}_input.wav"
        chunk_anchor = output_dir / f"{stem}_{chunk_label}_anchor.wav"

        if chunk_anchor.exists() and not force:
            print(f"\n  [{chunk_label}] Cached, loading...")
            a, _ = sf.read(str(chunk_anchor))
            anchor_tracks.append(a.astype(np.float32))
            continue

        # Extract chunk audio
        t0 = time.time()
        _extract_chunk_audio(vocals_path, chunk_ranges, chunk_input)
        dur = _audio_duration_s(chunk_input)
        print(f"\n  [{chunk_label}] {len(chunk_ranges)} ranges, "
              f"{dur:.1f}s — extracting took {time.time()-t0:.1f}s")

        if separate_all_mode:
            # FRCRN speech enhancement (single output, no track selection needed)
            t1 = time.time()
            anchor_audio = _enhance_with_frcrn(chunk_input, device=device)
            print(f"  [{chunk_label}] FRCRN enhancement: "
                  f"{len(anchor_audio)/16000:.1f}s in {time.time()-t1:.1f}s")
        else:
            # MossFormer2 separation → CAM++ track selection
            t1 = time.time()
            tracks = _separate_with_mossformer(chunk_input, device=device)
            print(f"  [{chunk_label}] Separation: {len(tracks)} tracks in "
                  f"{time.time()-t1:.1f}s")

            t2 = time.time()
            best_idx, sim = _select_anchor_track(
                tracks, reference_wav, device=device, fallback_to_vad=True,
            )
            anchor_audio = tracks[best_idx]
            print(f"  [{chunk_label}] Anchor: track {best_idx}, "
                  f"sim={sim:.4f} in {time.time()-t2:.1f}s")

        # Save
        sf.write(str(chunk_anchor), anchor_audio, 16000)
        anchor_tracks.append(anchor_audio.astype(np.float32))

        # Cleanup
        if not keep_intermediates and chunk_input.exists():
            chunk_input.unlink()

    # ── Step 4: Concatenate ────────────────────────────────────────
    print(f"\n{'='*60}")
    print(f"[4/5] Concatenating {len(anchor_tracks)} anchor tracks...")
    print(f"{'='*60}")

    if len(anchor_tracks) == 1:
        combined = anchor_tracks[0]
    else:
        combined = np.concatenate(anchor_tracks)
    combined_s = len(combined) / 16000
    print(f"[extract_anchor] Combined: {combined_s:.1f}s")

    # ── Step 5: Post-process ───────────────────────────────────────
    print(f"\n{'='*60}")
    all_yy = all(s.get("is_yuanyuan") for s in labels) if labels else False
    if all_yy:
        # separate-all / single-speaker 模式：
        # 用 VAD 裁剪静音段（原始标签全是 yuanyuan 无 trim 意义）
        print(f"[5/5] VAD-based silence trim")
        print(f"{'='*60}")
        trimmed, active_dur = _vad_trim(combined, device=device)
    else:
        print(f"[5/5] Post-process margin trim ({margin_ms}ms)")
        print(f"{'='*60}")
        # 重新从完整标签构建 mask 以保留时间线精度
        trimmed, active_dur = _apply_margin_trim(combined, labels, margin_ms, fade_ms)

    sf.write(str(final_output), trimmed.astype(np.float32), 16000)
    final_mb = final_output.stat().st_size / 1024 / 1024
    print(f"[extract_anchor] Final: {active_dur:.1f}s active ({final_mb:.1f} MB)")

    # Summary
    elapsed = time.time() - t_total
    removed = combined_s - active_dur
    print(f"\n{'='*60}")
    print(f"Extract Anchor Complete! ({elapsed/60:.1f} min)")
    print(f"{'='*60}")
    print(f"  Input:       {vocals_path}")
    print(f"  Output:      {final_output}")
    print(f"  Raw anchor:  {total_anchor_s:.1f}s (keep_ranges total)")
    print(f"  After TSE:   {combined_s:.1f}s")
    print(f"  After trim:  {active_dur:.1f}s (-{removed:.1f}s margin)")
    print(f"{'='*60}")

    return final_output


# ---------------------------------------------------------------------------
# 内部工具函数
# ---------------------------------------------------------------------------

def _collect_keep_ranges(labels: List[Dict]) -> List[Tuple[int, int]]:
    """从 labels 中提取所有 keep_ranges（毫秒）。"""
    ranges = []
    for seg in labels:
        if not seg.get("is_yuanyuan"):
            continue
        if "keep_ranges" in seg and seg["keep_ranges"]:
            for s_ms, e_ms in seg["keep_ranges"]:
                ranges.append((int(s_ms), int(e_ms)))
        else:
            ranges.append((int(seg["start_ms"]), int(seg["end_ms"])))
    return ranges


def _build_chunks(
    keep_ranges: List[Tuple[int, int]],
    target_duration_s: float = 300,
) -> List[List[Tuple[int, int]]]:
    """将 keep_ranges 按目标时长分组为处理块。"""
    target_ms = target_duration_s * 1000
    chunks = []
    current_chunk = []
    current_dur = 0

    for s, e in keep_ranges:
        dur = e - s
        if current_chunk and current_dur + dur > target_ms:
            chunks.append(current_chunk)
            current_chunk = [(s, e)]
            current_dur = dur
        else:
            current_chunk.append((s, e))
            current_dur += dur

    if current_chunk:
        chunks.append(current_chunk)

    return chunks


def _extract_chunk_audio(
    vocals_path: Path,
    ranges: List[Tuple[int, int]],
    output_path: Path,
    target_sr: int = 16000,
):
    """
    从原始 vocals 中流式提取 keep_ranges 音频，紧密拼接保存。

    用 soundfile 的 seek-read 避免一次性加载整个大文件。
    不添加段间 padding，保持与 keep_ranges 长度严格对齐，
    以便后续 margin_trim 能精确对应。
    """
    info = sf.info(str(vocals_path))
    file_sr = info.samplerate
    channels = info.channels

    def ms2smp(ms, sr):
        return int(ms * sr / 1000)

    # 预计算每段信息
    segments = []
    total_out = 0
    for s_ms, e_ms in ranges:
        fs = ms2smp(s_ms, file_sr)
        fe = ms2smp(e_ms, file_sr)
        out_len = int((e_ms - s_ms) * target_sr / 1000)
        segments.append((fs, fe, out_len))
        total_out += out_len

    # 预分配输出
    output = np.zeros(total_out, dtype=np.float32)
    out_pos = 0

    with sf.SoundFile(str(vocals_path), 'r') as src:
        for fs, fe, out_len in segments:
            src.seek(fs)
            chunk = src.read(fe - fs)

            if channels > 1:
                chunk = chunk.mean(axis=1)

            if file_sr != target_sr:
                import torchaudio.functional as F
                t = torch.from_numpy(chunk.astype(np.float32)).unsqueeze(0)
                t = F.resample(t, file_sr, target_sr)
                chunk = t.squeeze(0).numpy()
                chunk = chunk[:out_len]
                if len(chunk) < out_len:
                    chunk = np.pad(chunk, (0, out_len - len(chunk)))

            output[out_pos:out_pos + len(chunk)] = chunk.astype(np.float32)
            out_pos += len(chunk)

    if output_path.exists():
        output_path.unlink()
    sf.write(str(output_path), output.astype(np.float32), target_sr)


def _separate_with_mossformer(
    audio_path: Path,
    device: str = "cuda",
) -> List[np.ndarray]:
    """MossFormer2_SS_16K 语音分离，返回各音轨 (mono float32)。"""
    from clearvoice import ClearVoice

    cv = ClearVoice(task="speech_separation", model_names=["MossFormer2_SS_16K"])
    outputs = cv(input_path=str(audio_path), online_write=False)

    tracks = []
    for i, track in enumerate(outputs):
        f32 = np.asarray(track, dtype=np.float32)
        mono = f32[0] if f32.ndim >= 2 and f32.shape[0] >= 2 else f32.flatten()
        tracks.append(mono)

    return tracks


def _enhance_with_frcrn(
    audio_path: Path,
    device: str = "cuda",
) -> np.ndarray:
    """FRCRN_SE_16K 语音增强，返回增强后的 mono float32 音频。

    与 MossFormer2_SS_16K 不同，FRCRN 是增强模型而非分离模型，
    适用于单个说话人场景 —— 不会产生多轨分离导致的失真。
    """
    from clearvoice import ClearVoice

    cv = ClearVoice(task="speech_enhancement", model_names=["FRCRN_SE_16K"])
    output = cv(input_path=str(audio_path), online_write=False)

    # FRCRN returns a single numpy array
    audio = np.asarray(output, dtype=np.float32).flatten()
    return audio


def _select_anchor_track(
    tracks: List[np.ndarray],
    reference_wav: Optional[Path],
    device: str = "cuda",
    sim_threshold: float = 0.35,
    fallback_to_vad: bool = False,
) -> Tuple[int, float]:
    """CAM++ 声纹匹配，选出主播音轨。

    当 CAM++ sim < sim_threshold 且 fallback_to_vad=True 时，
    回退为 VAD 语音时长比较 —— 对于单人直播场景，说话最多的音轨 = 主播。
    """
    from funasr import AutoModel

    # 参考声纹
    if reference_wav is None:
        # 无参考：选 RMS 能量最大的音轨
        rms_values = [np.sqrt(np.mean(t.astype(np.float64)**2)) for t in tracks]
        best = int(np.argmax(rms_values))
        print(f"    [no reference] using RMS-based fallback: track {best} "
              f"(rms={rms_values[best]:.4f})")
        return best, 1.0

    # 加载 CAM++
    cam = AutoModel(model="cam++", device=device, disable_update=True)

    def get_emb(wav_data: np.ndarray):
        res = cam.generate(
            input=wav_data.astype(np.float32),
            input_len=len(wav_data),
        )
        e = res[0]["spk_embedding"]
        return e.cpu().numpy() if hasattr(e, "cpu") else np.array(e)

    # 参考嵌入
    ref_data, ref_sr = sf.read(str(reference_wav))
    if ref_data.ndim > 1:
        ref_data = ref_data.mean(axis=1)
    if ref_sr != 16000:
        import torchaudio.functional as F
        t = torch.from_numpy(ref_data.astype(np.float32)).unsqueeze(0)
        t = F.resample(t, ref_sr, 16000)
        ref_data = t.squeeze(0).numpy()
    ref_emb = get_emb(ref_data).flatten()

    # 逐轨匹配
    best_idx, best_sim = 0, -1.0
    for i, track in enumerate(tracks):
        trk_emb = get_emb(track).flatten()
        sim = float(np.dot(ref_emb, trk_emb) /
                    (np.linalg.norm(ref_emb) * np.linalg.norm(trk_emb) + 1e-8))
        label = "anchor" if sim >= sim_threshold else "other"
        print(f"    track {i}: sim={sim:.4f} → {label}")
        if sim > best_sim:
            best_sim, best_idx = sim, i

    # 自动回退：CAM++ 匹配不可靠时，track 0 通常是 MossFormer2 的主说话人
    if best_sim < sim_threshold and fallback_to_vad:
        print(f"    CAM++ unreliable (max sim={best_sim:.4f} < {sim_threshold}), "
              f"defaulting to track 0 (primary speaker)")
        best_idx = 0
        best_sim = max(0.0, best_sim)

    return best_idx, best_sim


def _apply_margin_trim(
    audio: np.ndarray,
    labels: List[Dict],
    margin_ms: int = 300,
    fade_ms: int = 15,
) -> Tuple[np.ndarray, float]:
    """
    对分离后的拼接音频做 margin trim。
    
    注意：拼接后已失去原始时间线，这里基于 keep_ranges 的相对偏移量做 trim。
    每个 keep_range 向内收缩 margin_ms。
    
    Returns: (masked_audio, active_duration_seconds)
    """
    sr = 16000

    # 收集原始 keep_ranges
    raw_ranges = _collect_keep_ranges(labels)
    if not raw_ranges:
        return audio

    # 对每段 trim
    trimmed_ranges = []
    for s_ms, e_ms in raw_ranges:
        ns, ne = s_ms + margin_ms, e_ms - margin_ms
        if ne - ns >= 500:  # >= 0.5s
            trimmed_ranges.append((ns, ne))

    if not trimmed_ranges:
        print("[trim] WARNING: all ranges trimmed to zero!")
        return audio.astype(np.float32), len(audio) / sr

    # 构建相对偏移的 mask
    total_frames = len(audio)
    mask = np.zeros(total_frames, dtype=np.float64)
    pos = 0

    for s_ms, e_ms in trimmed_ranges:
        dur = e_ms - s_ms
        seg_frames = int(dur * sr / 1000)
        end_pos = min(pos + seg_frames, total_frames)
        mask[pos:end_pos] = 1.0
        pos = end_pos

    # Fade
    fade_frames = max(1, int(fade_ms * sr / 1000))
    fade_in = np.linspace(0.0, 1.0, fade_frames, dtype=np.float64)
    fade_out = np.linspace(1.0, 0.0, fade_frames, dtype=np.float64)

    diff = np.diff(mask, prepend=0)
    for fi in np.where(diff > 0.5)[0]:
        fl = min(fade_frames, total_frames - fi)
        mask[fi:fi + fl] = np.minimum(mask[fi:fi + fl], fade_in[:fl])
    for fo in np.where(np.diff(mask, append=0) < -0.5)[0]:
        fl = min(fade_frames, total_frames - fo)
        mask[fo:fo + fl] = np.minimum(mask[fo:fo + fl], fade_out[:fl])

    result = audio.astype(np.float64) * mask
    active = np.sum(mask > 0) / sr

    raw_total = sum(e - s for s, e in raw_ranges) / 1000
    trim_total = sum(e - s for s, e in trimmed_ranges) / 1000
    n_removed = len(raw_ranges) - len(trimmed_ranges)

    # 真正截断首尾 mask=0 段，保留中间 keep_range 之间的间隔
    nz = np.where(np.abs(result) > 1e-6)[0]
    if len(nz) == 0:
        print("[trim] WARNING: result is all zero!")
        return result.astype(np.float32), 0.0
    head_trim_s = nz[0] / sr
    tail_trim_s = (len(result) - nz[-1] - 1) / sr
    if head_trim_s > 0.01 or tail_trim_s > 0.01:
        result = result[nz[0]:nz[-1] + 1]
        print(f"[trim] {len(trimmed_ranges)} ranges, {trim_total:.1f}s total "
              f"(active: {active:.1f}s, removed: {raw_total-trim_total:.1f}s, "
              f"{n_removed} too-short dropped, "
              f"head_trim={head_trim_s:.1f}s, tail_trim={tail_trim_s:.1f}s)")
        return result.astype(np.float32), len(result) / sr

    print(f"[trim] {len(trimmed_ranges)} ranges, {trim_total:.1f}s total "
          f"(active: {active:.1f}s, removed: {raw_total-trim_total:.1f}s, "
          f"{n_removed} too-short dropped)")
    return result.astype(np.float32), active


def _audio_duration_s(path: Path) -> float:
    return sf.info(str(path)).duration


def _vad_trim(
    audio: np.ndarray,
    device: str = "cuda",
    min_duration_ms: int = 500,
    padding_ms: int = 200,
    fade_ms: int = 15,
) -> Tuple[np.ndarray, float]:
    """
    对 MossFormer2 分离后的音频做 VAD-based 裁剪，
    只保留语音段，移除长静音。

    用于 separate-all 模式：MossFormer2 输出可能包含段间静音，
    VAD 找到实际语音边界并提取。

    Returns: (trimmed_audio, active_duration_seconds)
    """
    sr = 16000
    import tempfile

    # 写入临时文件以复用 diarize 的 FSMN-VAD
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmpf:
        tmp_path = Path(tmpf.name)
        sf.write(str(tmp_path), audio.astype(np.float32), sr)

    try:
        segments = diarize.extract_vad_segments(
            tmp_path, device=device, max_segment_ms=30000
        )
    finally:
        tmp_path.unlink(missing_ok=True)

    speech_ts = [(s["start_ms"], s["end_ms"]) for s in segments
                 if s["duration_ms"] >= min_duration_ms]

    if not speech_ts:
        print("[vad_trim] WARNING: VAD found no speech after separation!")
        return audio.astype(np.float32), len(audio) / sr

    # 加 padding
    pad_smp = int(padding_ms * sr / 1000)
    total_frames = len(audio)
    mask = np.zeros(total_frames, dtype=np.float64)

    for s_ms, e_ms in speech_ts:
        s = max(0, int(s_ms * sr / 1000) - pad_smp)
        e = min(total_frames, int(e_ms * sr / 1000) + pad_smp)
        mask[s:e] = 1.0

    # Fade in/out
    fade_frames = max(1, int(fade_ms * sr / 1000))
    fade_in = np.linspace(0.0, 1.0, fade_frames, dtype=np.float64)
    fade_out = np.linspace(1.0, 0.0, fade_frames, dtype=np.float64)

    diff = np.diff(mask, prepend=0)
    for fi in np.where(diff > 0.5)[0]:
        fl = min(fade_frames, total_frames - fi)
        mask[fi:fi + fl] = np.minimum(mask[fi:fi + fl], fade_in[:fl])
    for fo in np.where(np.diff(mask, append=0) < -0.5)[0]:
        fl = min(fade_frames, total_frames - fo)
        mask[fo:fo + fl] = np.minimum(mask[fo:fo + fl], fade_out[:fl])

    result = audio.astype(np.float64) * mask
    active = np.sum(mask > 0) / sr

    voice_total = sum(e - s for s, e in speech_ts) / 1000
    print(f"[vad_trim] {len(speech_ts)} speech segments, "
          f"{voice_total:.1f}s voice → {active:.1f}s with padding")

    # 真正截断首尾 mask=0 段
    nz = np.where(np.abs(result) > 1e-6)[0]
    if len(nz) > 0 and (nz[0] > 0 or nz[-1] < len(result) - 1):
        head_trim_s = nz[0] / sr
        tail_trim_s = (len(result) - nz[-1] - 1) / sr
        result = result[nz[0]:nz[-1] + 1]
        print(f"[vad_trim] head_trim={head_trim_s:.1f}s, "
              f"tail_trim={tail_trim_s:.1f}s → final {len(result)/sr:.1f}s")
        return result.astype(np.float32), len(result) / sr

    return result.astype(np.float32), active
