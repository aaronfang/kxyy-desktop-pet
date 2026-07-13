"""
Step 2: 说话人分离与元元识别
使用 FSMN-VAD 检测语音段 + CAM++ 提取说话人嵌入向量 + 余弦相似度匹配。

策略:
1. 如果有 reference_wav: 提取参考声纹 -> 逐段比对 -> 保留元元的段
2. 如果没有 reference_wav: 逐段聚类 -> 最大类 = 元元

输出: 只包含元元语音的 WAV 文件 + 时间段元数据 JSON
"""

import json
import warnings
from pathlib import Path
from typing import Optional, List, Dict, Tuple

import numpy as np
import soundfile as sf
from sklearn.cluster import KMeans
from sklearn.metrics.pairwise import cosine_similarity


def load_funasr_model(model_name: str, device: str = "cuda", **kwargs):
    """延迟加载 FunASR 模型，避免导入时触发模型下载"""
    from funasr import AutoModel
    return AutoModel(model=model_name, device=device, **kwargs)


def extract_vad_segments(
    audio_path: Path,
    device: str = "cuda",
    max_segment_ms: int = 30000,
) -> List[Dict]:
    """
    使用 FSMN-VAD 检测语音片段。

    Returns:
        List[Dict]: 每个元素包含 start_ms, end_ms, duration_ms
    """
    print(f"[diarize] Loading FSMN-VAD model...")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        vad = load_funasr_model(
            "fsmn-vad", device, disable_update=True
        )

    result = vad.generate(
        input=str(audio_path),
        max_single_segment_time=max_segment_ms,
    )

    if not result or not result[0].get("value"):
        print("[diarize] WARNING: No speech segments detected")
        return []

    segments = []
    for seg in result[0]["value"]:
        # Handle both list [start, end] and dict formats
        if isinstance(seg, (list, tuple)):
            start_ms, end_ms = int(seg[0]), int(seg[1])
        elif isinstance(seg, dict):
            start_ms = int(seg.get("start", 0))
            end_ms = int(seg.get("end", 0))
        else:
            continue

        segments.append({
            "start_ms": start_ms,
            "end_ms": end_ms,
            "duration_ms": end_ms - start_ms,
        })

    total_duration = sum(s["duration_ms"] for s in segments)
    print(
        f"[diarize] Found {len(segments)} speech segments "
        f"(total {total_duration / 1000:.1f}s)"
    )
    return segments


def read_audio_segment(
    audio_path: Path, start_ms: int, end_ms: int, target_sr: int = 16000
) -> Tuple[np.ndarray, int]:
    """读取音频文件的指定片段，并重采样到 target_sr"""
    # Get actual file sample rate first
    info = sf.info(str(audio_path))
    file_sr = info.samplerate

    # Convert ms to sample indices using the file's ACTUAL sample rate
    start_sample = int(start_ms * file_sr / 1000)
    end_sample = int(end_ms * file_sr / 1000)

    data, actual_sr = sf.read(str(audio_path), start=start_sample, stop=end_sample)
    if len(data.shape) > 1:
        data = data.mean(axis=1)  # mono

    # Resample if needed
    if actual_sr != target_sr:
        try:
            import librosa
            data = librosa.resample(data.astype(np.float64), orig_sr=actual_sr, target_sr=target_sr)
        except ImportError:
            from scipy import signal
            data = signal.resample(data, int(len(data) * target_sr / actual_sr))
    return data.astype(np.float32), target_sr


def extract_speaker_embeddings(
    audio_path: Path,
    segments: List[Dict],
    device: str = "cuda",
) -> np.ndarray:
    """
    为每个语音段提取 CAM++ 说话人嵌入向量。

    Returns:
        np.ndarray: shape (n_segments, embedding_dim)
    """
    print(f"[diarize] Loading CAM++ speaker embedding model...")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        spk_model = load_funasr_model(
            "cam++", device, disable_update=True
        )

    embeddings = []
    for i, seg in enumerate(segments):
        if seg["duration_ms"] < 500:  # skip very short segments
            embeddings.append(None)
            continue

        try:
            audio, sr = read_audio_segment(
                audio_path, seg["start_ms"], seg["end_ms"]
            )
            # CAM++ expects 16k mono
            if sr != 16000:
                import librosa
                audio = librosa.resample(audio, orig_sr=sr, target_sr=16000)

            result = spk_model.generate(input=audio)
            if result and len(result) > 0:
                # funasr 1.3.14 CAM++ returns [{'spk_embedding': tensor}]
                item = result[0]
                if isinstance(item, dict):
                    emb = item.get("spk_embedding")
                    if emb is not None:
                        if hasattr(emb, "cpu"):
                            emb = emb.cpu().numpy()
                        embeddings.append(np.array(emb).flatten())
                    else:
                        embeddings.append(None)
                elif isinstance(item, (list, np.ndarray)):
                    embeddings.append(np.array(item).flatten())
                else:
                    embeddings.append(None)
        except Exception as e:
            print(f"[diarize] WARNING: Failed to extract embedding for segment {i}: {e}")
            embeddings.append(None)

    valid = [e for e in embeddings if e is not None]
    if not valid:
        raise RuntimeError("No valid speaker embeddings extracted")

    # Pad None entries with mean embedding (fallback)
    # Use `is None` check instead of `in` to avoid numpy ambiguity
    if any(e is None for e in embeddings):
        mean_emb = np.mean(valid, axis=0)
        embeddings = [e if e is not None else mean_emb for e in embeddings]

    embeddings = np.array(embeddings)
    print(f"[diarize] Extracted {len(embeddings)} speaker embeddings "
          f"(dim={embeddings.shape[1]})")
    return embeddings


def identify_yuanyuan(
    segments: List[Dict],
    embeddings: np.ndarray,
    reference_emb: Optional[np.ndarray] = None,
    threshold: float = 0.6,
    fallback_strategy: str = "largest_cluster",
) -> List[int]:
    """
    识别哪些语音段属于元元。

    Args:
        segments: VAD 语音段列表
        embeddings: 说话人嵌入矩阵 (n_segments, dim)
        reference_emb: 元元参考声纹（可选）
        threshold: 余弦相似度阈值
        fallback_strategy: 无参考声纹时的策略

    Returns:
        List[int]: 元元语音段的索引列表
    """
    n = len(segments)
    if n <= 1:
        return list(range(n))

    if reference_emb is not None:
        # 策略 A: 声纹匹配
        ref = reference_emb.reshape(1, -1)
        sims = cosine_similarity(embeddings, ref).flatten()
        yuanyuan_idx = [i for i, s in enumerate(sims) if s >= threshold]
        print(
            f"[diarize] Voiceprint matching: {len(yuanyuan_idx)}/{n} segments "
            f"matched (threshold={threshold})"
        )
        for i in range(n):
            label = "元元" if i in yuanyuan_idx else "其他"
            print(f"  seg {i}: sim={sims[i]:.3f} -> {label}")
        return yuanyuan_idx

    # 策略 B: 聚类（默认）
    print(f"[diarize] No reference voiceprint -> using clustering")
    
    n_clusters = min(5, n)
    if n < 3:
        return list(range(n))

    # Use KMeans on embeddings directly (cosine distance via normalization)
    from sklearn.preprocessing import normalize
    embeddings_norm = normalize(embeddings, norm='l2')
    clustering = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
    labels = clustering.fit_predict(embeddings_norm)

    # Find the largest cluster -> 元元
    from collections import Counter
    cluster_counts = Counter(labels)
    largest_cluster = cluster_counts.most_common(1)[0][0]
    yuanyuan_idx = [i for i, lbl in enumerate(labels) if lbl == largest_cluster]

    total_duration_yy = sum(segments[i]["duration_ms"] for i in yuanyuan_idx) / 1000
    total_duration_all = sum(s["duration_ms"] for s in segments) / 1000

    print(f"[diarize] Clustered into {n_clusters} speakers")
    print(f"  Speaker distribution: {dict(cluster_counts)}")
    print(
        f"  Largest cluster (元元): {len(yuanyuan_idx)} segments "
        f"({total_duration_yy:.1f}s / {total_duration_all:.1f}s)"
    )
    return yuanyuan_idx


def build_yuanyuan_wav(
    audio_path: Path,
    segments: List[Dict],
    yuanyuan_idx: List[int],
    output_path: Path,
    target_sr: int = 16000,
) -> Tuple[Path, List[Dict]]:
    """
    从原始音频中拼接元元的语音段，输出为单个 WAV 文件。

    Returns:
        (output_wav_path, metadata_list)
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Read full audio
    data, sr = sf.read(str(audio_path))
    if len(data.shape) > 1:
        data = data.mean(axis=1)

    if sr != target_sr:
        import librosa
        data = librosa.resample(data, orig_sr=sr, target_sr=target_sr)
        sr = target_sr

    # Concatenate 元元's segments
    yuanyuan_audio = []
    metadata = []
    for idx in sorted(yuanyuan_idx):
        seg = segments[idx]
        start_sample = int(seg["start_ms"] * sr / 1000)
        end_sample = int(seg["end_ms"] * sr / 1000)
        chunk = data[start_sample:end_sample]
        yuanyuan_audio.append(chunk)

        metadata.append({
            "segment_index": idx,
            "start_ms": seg["start_ms"],
            "end_ms": seg["end_ms"],
            "duration_ms": seg["duration_ms"],
        })

    combined = np.concatenate(yuanyuan_audio)
    sf.write(str(output_path), combined, sr)
    duration = len(combined) / sr

    print(
        f"[diarize] 元元 WAV saved: {output_path} "
        f"({len(yuanyuan_idx)} segments, {duration:.1f}s)"
    )

    # Save metadata
    meta_path = output_path.with_suffix(".diarize.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump({
            "source": str(audio_path),
            "total_segments": len(segments),
            "yuanyuan_segments": len(yuanyuan_idx),
            "total_duration_s": len(data) / sr,
            "yuanyuan_duration_s": duration,
            "segments": metadata,
        }, f, ensure_ascii=False, indent=2)

    return output_path, metadata


def get_reference_embedding(
    reference_path: Optional[Path],
    device: str = "cuda",
) -> Optional[np.ndarray]:
    """从参考音频提取元元声纹"""
    if reference_path is None or not Path(reference_path).exists():
        return None

    print(f"[diarize] Extracting reference voiceprint from: {reference_path}")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        spk_model = load_funasr_model(
            "cam++", device, disable_update=True
        )

    # Read and resample if needed
    data, sr = sf.read(str(reference_path))
    if len(data.shape) > 1:
        data = data.mean(axis=1)
    if sr != 16000:
        import librosa
        data = librosa.resample(data, orig_sr=sr, target_sr=16000)

    result = spk_model.generate(input=data.astype(np.float32))
    if result and len(result) > 0:
        item = result[0]
        if isinstance(item, dict):
            emb = item.get("spk_embedding")
            if emb is not None:
                if hasattr(emb, "cpu"):
                    emb = emb.cpu().numpy()
                emb = np.array(emb).flatten()
                print(f"[diarize] Reference embedding dim={len(emb)}")
                return emb
        elif isinstance(item, np.ndarray):
            emb = np.array(item).flatten()
            print(f"[diarize] Reference embedding dim={len(emb)}")
            return emb
    return None
