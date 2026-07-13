"""
Step 1: 背景音乐/音效去除
使用 Demucs (Hybrid Transformer Demucs) 分离人声与背景音。

输入: WAV 文件（直播回放）
输出: vocals.wav（纯人声，用于后续 ASR 和说话人识别）

Demucs 默认分离 4 轨: vocals, drums, bass, other
对于直播场景，我们只需 vocals 轨。
"""

import subprocess
import os
import sys
import tempfile
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf


_DEMUCS_NATIVE_SR = 44100


def run_demucs(
    input_path: Path,
    output_dir: Path,
    model: str = "htdemucs",
    device: str = "cuda",
    segment: int = 8,
    overlap: float = 0.25,
) -> Path:
    """
    运行 Demucs 分离人声。

    htdemucs 被设计用于 44.1kHz 音频。如果输入采样率低于 40kHz，
    会自动上采样到 44.1kHz 后再送入 Demucs，避免频谱失真。

    Args:
        input_path: 输入 WAV 文件
        output_dir: 输出目录
        model: demucs 模型名
        device: cuda/cpu/mps
        segment: 分片长度(秒)
        overlap: 重叠比例

    Returns:
        Path: 分离后的人声文件路径

    Raises:
        RuntimeError: Demucs 执行失败
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    # ── 幂等：如果已有输出则跳过 ──
    stem = input_path.stem
    vocals_path = output_dir / model / stem / "vocals.wav"
    if vocals_path.exists():
        print(f"[denoise] SKIP (already exists): {vocals_path}")
        return vocals_path

    # ── 自动上采样: Demucs 需要 ≥44.1kHz 输入 ──
    actual_input = input_path
    tmp_file = None
    try:
        info = sf.info(str(input_path))
        if info.samplerate < 40000:
            import torch
            import torchaudio.functional as F

            print(f"[denoise] Input sr={info.samplerate}Hz < 40kHz, "
                  f"upsampling to {_DEMUCS_NATIVE_SR}Hz for Demucs...")
            data, orig_sr = sf.read(str(input_path))
            if data.ndim == 1:
                data = data[:, np.newaxis]
            t = torch.from_numpy(data.astype(np.float32)).T  # (ch, samples)
            t = F.resample(t, orig_sr, _DEMUCS_NATIVE_SR)
            data_up = t.T.cpu().numpy()  # (samples, ch)

            tmp_file = tempfile.NamedTemporaryFile(
                suffix=".wav", delete=False, dir=output_dir
            )
            tmp_path = Path(tmp_file.name)
            sf.write(str(tmp_path), data_up, _DEMUCS_NATIVE_SR)
            actual_input = tmp_path
            print(f"[denoise] Upsampled temp file: {tmp_path} "
                  f"({len(data_up) / _DEMUCS_NATIVE_SR:.1f}s)")
    except Exception as e:
        print(f"[denoise] WARNING: Upsampling failed ({e}), trying raw input")
        actual_input = input_path

    cmd = [
        sys.executable, "-m", "demucs",
        "--two-stems", "vocals",
        "-n", model,
        "-d", device,
        "--segment", str(segment),
        "--overlap", str(overlap),
        "-o", str(output_dir),
        str(actual_input),
    ]

    print(f"[denoise] Running: {' '.join(cmd)}")
    # torchaudio 2.11+ cu128 requires torchcodec for saving,
    # but torchcodec DLLs may fail to load. Monkey-patch torchaudio.save
    # to use soundfile instead via PYTHONSTARTUP.
    env = os.environ.copy()
    patch_script = Path(__file__).parent / "_patch_torchaudio.py"
    env["PYTHONSTARTUP"] = str(patch_script)
    result = subprocess.run(cmd, capture_output=True, text=True, env=env)

    # Cleanup temp upsampled file
    if tmp_file is not None:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass

    if result.returncode != 0:
        # Print stdout and stderr for debugging
        print(f"[denoise] STDOUT:\n{result.stdout[-2000:]}")
        print(f"[denoise] STDERR:\n{result.stderr[-2000:]}")
        raise RuntimeError(f"Demucs failed with code {result.returncode}")

    # Demucs output structure: <output_dir>/<model>/<input_stem>/vocals.wav
    # When upsampled, output uses temp file stem; rename to original stem
    raw_stem = actual_input.stem
    raw_vocals_path = output_dir / model / raw_stem / "vocals.wav"
    vocals_path = output_dir / model / stem / "vocals.wav"
    no_vocals_path = output_dir / model / stem / "no_vocals.wav"

    if not raw_vocals_path.exists():
        raise RuntimeError(
            f"Demucs completed but vocals file not found at {raw_vocals_path}"
        )

    # Rename output dir if upsampled (temp stem → original stem)
    if actual_input != input_path:
        if vocals_path.parent.exists():
            import shutil
            shutil.rmtree(vocals_path.parent)
            print(f"[denoise] Removed existing output at {vocals_path.parent}")
        raw_vocals_path.parent.rename(vocals_path.parent)
        print(f"[denoise] Renamed output: {raw_vocals_path.parent} → {vocals_path.parent}")

    print(f"[denoise] Vocals extracted: {vocals_path} "
          f"(sr={sf.info(str(vocals_path)).samplerate}Hz)")
    print(f"[denoise] Background isolated: {no_vocals_path}")
    return vocals_path


def check_demucs() -> bool:
    """检查 Demucs 是否可用"""
    try:
        result = subprocess.run(
            [sys.executable, "-m", "demucs", "--help"],
            capture_output=True, text=True, timeout=30
        )
        return result.returncode == 0
    except Exception:
        return False
