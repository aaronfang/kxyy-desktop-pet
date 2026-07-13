"""
Step 1.5: 声源隔离 - 细粒度子段匹配版

核心改进：
- 对长 VAD 段（>5s）切分成 3s 子窗口做逐段声纹匹配
- 匹配的子窗口保留，不匹配的静音 → 解决 "同一段内主播+背景歌混合" 问题
- 滑动窗口 1.5s hop 做平滑过渡
- 支持干净参考声纹模式和 KMeans 回退模式

用法:
  # 参考声纹模式（推荐）
  python isolation.py <vocals.wav> <output.wav> --reference <clean_ref.wav> --device cuda --threshold 0.38

  # KMeans 回退模式
  python isolation.py <vocals.wav> <output.wav> --device cuda

输出:
  - filtered_xxx.wav: 过滤后的完整时间线音频
  - filtered_xxx.labels.json: 每个段的标签
  - filtered_xxx.subchunks.json: 子段级别匹配详情（仅参考模式）
  - filtered_xxx.isolation.json: 整体统计
"""

import json
import warnings
import argparse
import sys
from pathlib import Path
from typing import List, Dict, Optional, Tuple
from collections import Counter

import numpy as np
import soundfile as sf
from sklearn.cluster import KMeans

sys.path.insert(0, str(Path(__file__).parent.parent))
from steps import diarize


# ---------------------------------------------------------------------------
# Sub-chunk matching (fine-grained within VAD segments)
# ---------------------------------------------------------------------------

def _split_into_chunks(
    start_ms: int, end_ms: int,
    chunk_ms: int = 3000, hop_ms: int = 1500,
) -> List[Dict]:
    """将时间段切分为重叠子窗口"""
    chunks = []
    t = start_ms
    while t < end_ms:
        ce = min(t + chunk_ms, end_ms)
        if ce - t < 500:  # skip tiny tail
            chunks[-1]["end_ms"] = end_ms
            break
        chunks.append({
            "start_ms": t, "end_ms": ce,
            "duration_ms": ce - t,
        })
        t += hop_ms
    if not chunks:
        chunks.append({
            "start_ms": start_ms, "end_ms": end_ms,
            "duration_ms": end_ms - start_ms,
        })
    return chunks


def label_speakers_subchunk(
    vocals_path: Path,
    device: str = "cuda",
    reference_wav: Optional[Path] = None,
    similarity_threshold: float = 0.38,
    n_clusters: int = 5,
    min_segment_ms: int = 500,
    max_segment_ms: int = 30000,
    long_segment_threshold_ms: int = 5000,
    chunk_ms: int = 3000,
    hop_ms: int = 1500,
    force_kmeans: bool = False,
) -> List[Dict]:
    """
    VAD + 子段级 CAM++ 声纹匹配 → 精细标签。

    策略:
    1. 短段（< long_segment_threshold_ms）: 整段取嵌入 → 整段匹配
    2. 长段: 切分 3s 子窗口 → 逐窗口匹配 → 仅保留匹配窗口
    3. force_kmeans: 跳过子段匹配，直接用 KMeans + 参考声纹选聚类
    
    Returns labeled segments with optional sub_chunks field.
    """
    # --- VAD ---
    print("[label] Running VAD...")
    segments = diarize.extract_vad_segments(
        vocals_path, device=device, max_segment_ms=max_segment_ms
    )
    segments = [s for s in segments if s["duration_ms"] >= min_segment_ms]
    n_seg = len(segments)
    voice_dur = sum(s["duration_ms"] for s in segments) / 1000
    print(f"[label] {n_seg} speech segments, total {voice_dur:.1f}s")

    if n_seg == 0:
        return []

    # --- Reference embedding ---
    ref_emb = diarize.get_reference_embedding(reference_wav, device=device)

    # Decide strategy
    use_subchunk = (ref_emb is not None) and (not force_kmeans)
    
    if use_subchunk:
        print(f"[label] Reference mode + sub-chunk matching "
              f"(threshold={similarity_threshold}, chunk={chunk_ms}ms, hop={hop_ms}ms)")
        
        # Build all sub-chunks
        all_subchunks = []  # list of (parent_seg_idx, chunk_dict)
        short_seg_indices = set()
        
        for i, seg in enumerate(segments):
            dur = seg["duration_ms"]
            if dur < long_segment_threshold_ms:
                # Short: treat as one chunk
                all_subchunks.append((i, {
                    "start_ms": seg["start_ms"], "end_ms": seg["end_ms"],
                    "duration_ms": dur,
                }))
                short_seg_indices.add(i)
            else:
                # Long: split into sub-chunks
                chunks = _split_into_chunks(
                    seg["start_ms"], seg["end_ms"],
                    chunk_ms=chunk_ms, hop_ms=hop_ms,
                )
                for ch in chunks:
                    all_subchunks.append((i, ch))
        
        print(f"[label] {len(all_subchunks)} sub-chunks "
              f"({len(short_seg_indices)} short segments, "
              f"{n_seg - len(short_seg_indices)} long segments split)")

        # Extract CAM++ for all sub-chunks
        chunk_dicts = [c for _, c in all_subchunks]
        print(f"[label] Extracting CAM++ embeddings for {len(chunk_dicts)} sub-chunks...")
        embeddings = diarize.extract_speaker_embeddings(
            vocals_path, chunk_dicts, device=device
        )

        # Match against reference
        ref_norm = ref_emb / (np.linalg.norm(ref_emb) + 1e-8)
        
        # Per-subchunk matching
        subchunk_matches = []  # (parent_idx, start_ms, end_ms, sim, is_match)
        for j, ((parent_idx, ch), emb) in enumerate(zip(all_subchunks, embeddings)):
            emb_norm = emb / (np.linalg.norm(emb) + 1e-8)
            sim = float(np.dot(emb_norm, ref_norm))
            is_match = sim >= similarity_threshold
            subchunk_matches.append({
                "parent_seg": parent_idx,
                "start_ms": ch["start_ms"],
                "end_ms": ch["end_ms"],
                "duration_ms": ch["duration_ms"],
                "similarity": sim,
                "is_yuanyuan": is_match,
            })

        # Build labeled segments from sub-chunk matches
        labeled = []
        for i, seg in enumerate(segments):
            seg_matches = [m for m in subchunk_matches if m["parent_seg"] == i]
            if not seg_matches:
                labeled.append({
                    "start_ms": seg["start_ms"],
                    "end_ms": seg["end_ms"],
                    "duration_ms": seg["duration_ms"],
                    "is_yuanyuan": False,
                    "sub_chunks": [],
                })
                continue

            # If short segment: whole match
            if i in short_seg_indices:
                sc = seg_matches[0]
                labeled.append({
                    "start_ms": seg["start_ms"],
                    "end_ms": seg["end_ms"],
                    "duration_ms": seg["duration_ms"],
                    "is_yuanyuan": sc["is_yuanyuan"],
                    "similarity": sc["similarity"],
                    "sub_chunks": seg_matches,
                })
            else:
                # Long segment: build keep ranges from matched sub-chunks
                matched = [m for m in seg_matches if m["is_yuanyuan"]]
                
                # Merge overlapping matched sub-chunks into keep ranges
                keep_ranges = []
                for m in sorted(matched, key=lambda x: x["start_ms"]):
                    if keep_ranges and m["start_ms"] - keep_ranges[-1][1] <= hop_ms:
                        keep_ranges[-1] = (keep_ranges[-1][0], m["end_ms"])
                    else:
                        keep_ranges.append((m["start_ms"], m["end_ms"]))
                
                # Overall is_yuanyuan if any sub-chunk matched
                has_match = len(matched) > 0
                avg_sim = np.mean([m["similarity"] for m in seg_matches])
                
                labeled.append({
                    "start_ms": seg["start_ms"],
                    "end_ms": seg["end_ms"],
                    "duration_ms": seg["duration_ms"],
                    "is_yuanyuan": has_match,
                    "avg_similarity": float(avg_sim),
                    "keep_ranges": keep_ranges,  # finer than whole segment
                    "sub_chunks": seg_matches,
                })
    else:
        # --- KMeans fallback (with optional reference-guided cluster selection) ---
        print(f"[label] KMeans clustering (n_clusters={n_clusters}" +
              (", reference-guided" if ref_emb is not None else ", largest-wins") +
              ")")
        embeddings = diarize.extract_speaker_embeddings(
            vocals_path, segments, device=device
        )
        
        nc = min(n_clusters, max(2, n_seg))
        if n_seg < 3:
            yuanyuan_set = set(range(n_seg))
        else:
            from sklearn.preprocessing import normalize
            embs_norm = normalize(embeddings, norm='l2')
            km = KMeans(n_clusters=nc, random_state=42, n_init=10)
            kmeans_labels = km.fit_predict(embs_norm)
            counts = Counter(kmeans_labels)

            # --- 选择目标聚类 ---
            if ref_emb is not None:
                # 参考声纹引导：比较每个聚类的质心与参考的相似度
                ref_norm = ref_emb / (np.linalg.norm(ref_emb) + 1e-8)
                best_cluster = -1
                best_sim = -1.0
                for lbl in range(nc):
                    cluster_embs = embs_norm[kmeans_labels == lbl]
                    if len(cluster_embs) == 0:
                        continue
                    centroid = np.mean(cluster_embs, axis=0)
                    centroid = centroid / (np.linalg.norm(centroid) + 1e-8)
                    sim = float(np.dot(centroid, ref_norm))
                    print(f"[label]   cluster_{lbl} centroid sim={sim:.4f} "
                          f"(n={len(cluster_embs)}, "
                          f"dominant ratio={counts[lbl]/n_seg:.1%})")
                    if sim > best_sim:
                        best_sim = sim
                        best_cluster = lbl
                yuanyuan_set = set(i for i, lbl in enumerate(kmeans_labels)
                                   if lbl == best_cluster)
                print(f"[label] reference-guided → cluster_{best_cluster} "
                      f"(sim={best_sim:.4f}, "
                      f"{counts[best_cluster]}/{n_seg} = {counts[best_cluster]/n_seg:.1%})")
            else:
                # 无参考：选最大聚类
                largest = counts.most_common(1)[0][0]
                yuanyuan_set = set(i for i, lbl in enumerate(kmeans_labels) if lbl == largest)
                print(f"[label] largest-wins → cluster_{largest} "
                      f"({counts[largest]}/{n_seg} = {counts[largest]/n_seg:.1%})")
        
        labeled = []
        for i, seg in enumerate(segments):
            labeled.append({
                "start_ms": seg["start_ms"],
                "end_ms": seg["end_ms"],
                "duration_ms": seg["duration_ms"],
                "is_yuanyuan": i in yuanyuan_set,
            })

    # --- Summary ---
    yy_dur = sum(s["duration_ms"] for s in labeled if s["is_yuanyuan"]) / 1000
    other_dur = sum(s["duration_ms"] for s in labeled if not s["is_yuanyuan"]) / 1000
    total = yy_dur + other_dur
    print(f"[label] Host: {yy_dur:.1f}s, Others: {other_dur:.1f}s "
          f"({100 * yy_dur / max(1, total):.1f}%)")

    return labeled


# ---------------------------------------------------------------------------
# Streaming build (supports sub-chunk keep_ranges)
# ---------------------------------------------------------------------------

def build_filtered_audio(
    vocals_path: Path,
    labeled_segments: List[Dict],
    output_path: Path,
    fade_ms: int = 10,
    buffer_mb: float = 200.0,
):
    """流式构建过滤音频，支持子段级 keep_ranges"""
    output_path.parent.mkdir(parents=True, exist_ok=True)

    info = sf.info(str(vocals_path))
    sr = info.samplerate
    channels = info.channels
    total_frames = info.frames

    # Build keep ranges at frame level
    # For segments with sub_chunks/keep_ranges, use those instead of whole segment
    def ms2f(ms): return int(ms * sr / 1000)
    
    merge_gap_ms = 500

    # Collect raw keep ranges from labels
    raw_ranges = []
    for seg in labeled_segments:
        if not seg.get("is_yuanyuan"):
            continue
        if "keep_ranges" in seg and seg["keep_ranges"]:
            # Fine-grained keep ranges from sub-chunk matching
            for s_ms, e_ms in seg["keep_ranges"]:
                raw_ranges.append((ms2f(s_ms), ms2f(e_ms)))
        else:
            # Whole segment
            raw_ranges.append((ms2f(seg["start_ms"]), ms2f(seg["end_ms"])))

    # Merge nearby ranges
    raw_ranges.sort()
    keep_ranges = []
    merge_gap_frames = ms2f(merge_gap_ms)
    for s, e in raw_ranges:
        if keep_ranges and (s - keep_ranges[-1][1]) < merge_gap_frames:
            keep_ranges[-1] = (keep_ranges[-1][0], max(keep_ranges[-1][1], e))
        else:
            keep_ranges.append((s, e))

    total_keep = sum(e - s for s, e in keep_ranges)
    print(f"[build] {len(keep_ranges)} keep ranges, "
          f"{total_keep / sr:.1f}s retained "
          f"({100 * total_keep / max(1, total_frames):.1f}%)")

    # Fade curves
    fade_frames = ms2f(fade_ms)
    fade_in = np.linspace(0.0, 1.0, fade_frames, dtype=np.float32) if fade_frames > 0 else None
    fade_out = np.linspace(1.0, 0.0, fade_frames, dtype=np.float32) if fade_frames > 0 else None

    bytes_per_frame = channels * 2
    chunk_frames = int(buffer_mb * 1024 * 1024 / bytes_per_frame)
    chunk_frames = min(chunk_frames, 20 * sr)

    with sf.SoundFile(str(vocals_path), 'r') as src:
        with sf.SoundFile(
            str(output_path), 'w',
            samplerate=sr, channels=channels, subtype='PCM_16',
        ) as dst:
            pos = 0
            while pos < total_frames:
                end = min(pos + chunk_frames, total_frames)
                chunk = src.read(end - pos)
                chunk_len = len(chunk)

                # Build mask
                mask = np.zeros(chunk_len, dtype=np.float32)
                for ks, ke in keep_ranges:
                    if ke <= pos or ks >= end:
                        continue
                    ls = max(0, ks - pos)
                    le = min(chunk_len, ke - pos)
                    mask[ls:le] = 1.0

                # Apply fades at transitions
                if fade_frames > 0 and np.any(mask > 0):
                    diff = np.diff(mask, prepend=0)
                    for fi in np.where(diff > 0.5)[0]:
                        fl = min(fade_frames, chunk_len - fi)
                        mask[fi:fi + fl] = np.minimum(mask[fi:fi + fl], fade_in[:fl])
                    for fo in np.where(np.diff(mask, append=0) < -0.5)[0]:
                        fl = min(fade_frames, chunk_len - fo)
                        mask[fo:fo + fl] = np.minimum(mask[fo:fo + fl], fade_out[:fl])

                # Apply mask
                chunk_f = chunk.astype(np.float64)
                if channels > 1:
                    chunk_f[:, 0] *= mask
                    chunk_f[:, 1] *= mask
                else:
                    chunk_f *= mask

                # Float [-1,1] → int16
                out = np.clip(chunk_f * 32767, -32768, 32767).astype(np.int16)
                dst.write(out)
                pos = end

    size_mb = output_path.stat().st_size / 1024 / 1024
    print(f"[build] Saved: {output_path} ({size_mb:.1f} MB)")

    # Stats
    stats = {
        "total_duration_s": total_frames / sr,
        "sample_rate": sr, "channels": channels,
        "total_segments": len(labeled_segments),
        "yuanyuan_segments": sum(1 for s in labeled_segments if s["is_yuanyuan"]),
        "keep_ranges": len(keep_ranges),
        "keep_duration_s": total_keep / sr,
        "fade_ms": fade_ms,
        "output_size_bytes": output_path.stat().st_size,
    }

    meta_path = output_path.with_suffix(".isolation.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)

    return stats


# ---------------------------------------------------------------------------
# Convenience wrapper (for pipeline.py compatibility)
# ---------------------------------------------------------------------------

def isolate_speaker(
    vocals_path: Path,
    output_path: Path,
    reference_wav: Optional[Path] = None,
    device: str = "cuda",
    similarity_threshold: float = 0.38,
    n_clusters: int = 5,
    max_segment_ms: int = 30000,
    min_segment_ms: int = 500,
    fade_ms: int = 15,
):
    """一站式隔离：子段级标注 + 构建过滤音频"""
    labeled = label_speakers_subchunk(
        vocals_path,
        device=device,
        reference_wav=reference_wav,
        similarity_threshold=similarity_threshold,
        n_clusters=n_clusters,
        min_segment_ms=min_segment_ms,
        max_segment_ms=max_segment_ms,
    )
    if not labeled:
        print("[isolate_speaker] No speech segments found")
        return output_path, {"error": "no_segments"}

    stats = build_filtered_audio(
        vocals_path, labeled, output_path, fade_ms=fade_ms,
    )
    stats["method"] = "reference_subchunk" if reference_wav else "kmeans"
    return output_path, stats


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description="声源隔离 (子段匹配 / KMeans)")
    p.add_argument("vocals", type=Path)
    p.add_argument("output", type=Path)
    p.add_argument("--reference", "-r", type=Path, default=None,
                   help="目标说话人参考 WAV")
    p.add_argument("--device", "-d", default="cuda")
    p.add_argument("--threshold", "-t", type=float, default=0.38)
    p.add_argument("--n-clusters", type=int, default=5)
    p.add_argument("--fade-ms", type=int, default=10)
    p.add_argument("--labels-only", action="store_true",
                   help="只保存标签 JSON，不构建音频")

    args = p.parse_args()
    if not args.vocals.exists():
        print(f"ERROR: {args.vocals} not found")
        sys.exit(1)

    # Label
    print("=" * 60)
    print("Step 1: Speaker Labeling (sub-chunk mode)")
    print("=" * 60)
    labels_path = args.output.with_suffix(".labels.json")
    if labels_path.exists():
        print(f"[main] Loading cached labels: {labels_path}")
        labeled = json.load(open(labels_path, "r", encoding="utf-8"))
    else:
        labeled = label_speakers_subchunk(
            args.vocals,
            device=args.device,
            reference_wav=args.reference,
            similarity_threshold=args.threshold,
            n_clusters=args.n_clusters,
        )
        with open(labels_path, "w", encoding="utf-8") as f:
            json.dump(labeled, f, ensure_ascii=False, indent=2)
        print(f"[main] Labels saved: {labels_path}")

    if not labeled:
        print("[main] No segments found.")
        sys.exit(1)

    if args.labels_only:
        print("[main] Labels-only: done.")
        return

    # Build
    print()
    print("=" * 60)
    print("Step 2: Build Filtered Audio")
    print("=" * 60)
    stats = build_filtered_audio(
        args.vocals, labeled, args.output, fade_ms=args.fade_ms,
    )
    stats["method"] = "reference_subchunk" if args.reference else "kmeans"

    print()
    print("=" * 60)
    print("Done!")
    print("=" * 60)
    for k, v in stats.items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
