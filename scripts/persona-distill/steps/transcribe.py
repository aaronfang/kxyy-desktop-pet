"""
Step 3: SenseVoice 语音识别
对说话人分离后的元元语音进行 ASR 转录。

SenseVoice 特性:
- 170x 实时（GPU），CPU 也可用
- 支持 50+ 语言
- 内建情感识别和音频事件检测
- 内建逆文本正则化 (ITN)

输出: 带时间戳的转录 JSON + 纯文本
"""

import json
import warnings
from pathlib import Path
from typing import List, Dict, Optional


def transcribe_with_sensevoice(
    audio_path: Path,
    output_dir: Path,
    model_name: str = "iic/SenseVoiceSmall",
    device: str = "cuda",
    language: str = "zh",
    itn: bool = True,
) -> Dict:
    """
    使用 SenseVoice 对音频进行语音识别。

    Args:
        audio_path: 输入音频文件（元元的语音段）
        output_dir: 输出目录
        model_name: SenseVoice 模型名
        device: cuda/cpu
        language: 语言偏好 (zh/en/auto)
        itn: 是否启用逆文本正则化

    Returns:
        Dict: 包含转录结果的字典
    """
    from funasr import AutoModel

    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"[transcribe] Loading SenseVoice model: {model_name}")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        model = AutoModel(
            model=model_name,
            device=device,
            # SenseVoice 支持 VAD 重采样
            vad_model="fsmn-vad",
            vad_kwargs={"max_single_segment_time": 30000},
        )

    print(f"[transcribe] Transcribing: {audio_path}")
    result = model.generate(
        input=str(audio_path),
        language=language,
        use_itn=itn,
        ban_emo_uncertainty_threshold=0.0,  # keep all emotion labels
    )

    if not result:
        raise RuntimeError("SenseVoice returned empty result")

    # Parse SenseVoice output
    # Format: [{'key': '...', 'text': '...', 'timestamp': [[start, end], ...]}]
    raw = result[0]
    full_text = raw.get("text", "")
    timestamps = raw.get("timestamp", [])

    # SenseVoice may output emotion tags like <|HAPPY|>text<|/HAPPY|>
    # We strip these for clean text but keep them in metadata
    import re
    emotion_tags = re.findall(r'<\|([A-Z]+)\|>', full_text)
    clean_text = re.sub(r'<\|[^|]+\|>', '', full_text).strip()

    # Build segments
    segments = []
    if timestamps and isinstance(timestamps, list):
        for ts in timestamps:
            if isinstance(ts, (list, tuple)) and len(ts) >= 2:
                segments.append({
                    "start_ms": int(ts[0]),
                    "end_ms": int(ts[1]),
                    "text": "",  # SenseVoice doesn't return per-segment text with timestamps
                })

    output = {
        "source": str(audio_path),
        "model": model_name,
        "full_text": clean_text,
        "text_with_emotion": full_text,
        "emotion_tags": list(set(emotion_tags)),  # unique emotion labels found
        "char_count": len(clean_text),
        "duration_s": _get_audio_duration(audio_path),
        "segments": segments,
    }

    # Save results
    # 1. Pure text file
    text_path = output_dir / f"{audio_path.stem}.txt"
    with open(text_path, "w", encoding="utf-8") as f:
        f.write(clean_text)
    print(f"[transcribe] Text saved: {text_path} ({len(clean_text)} chars)")

    # 2. Full JSON
    json_path = output_dir / f"{audio_path.stem}.transcript.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"[transcribe] JSON saved: {json_path}")

    return output


def _get_audio_duration(audio_path: Path) -> float:
    """获取音频时长（秒）"""
    import soundfile as sf
    info = sf.info(str(audio_path))
    return info.duration


def batch_transcribe(
    wav_dir: Path,
    output_dir: Path,
    model_name: str = "iic/SenseVoiceSmall",
    device: str = "cuda",
    language: str = "zh",
    itn: bool = True,
) -> List[Dict]:
    """
    批量转录目录中的 WAV 文件（已做说话人分离后的元元语音）。

    Returns:
        List[Dict]: 每个文件的转录结果
    """
    wav_files = sorted(wav_dir.glob("*.wav"))
    if not wav_files:
        print(f"[transcribe] No WAV files found in {wav_dir}")
        return []

    results = []
    for wav_path in wav_files:
        print(f"\n[transcribe] Processing: {wav_path.name}")
        try:
            result = transcribe_with_sensevoice(
                wav_path, output_dir, model_name, device, language, itn
            )
            results.append(result)
        except Exception as e:
            print(f"[transcribe] ERROR on {wav_path.name}: {e}")
            results.append({"source": str(wav_path), "error": str(e)})

    # Save batch summary
    summary = {
        "total_files": len(wav_files),
        "successful": sum(1 for r in results if "error" not in r),
        "failed": sum(1 for r in results if "error" in r),
        "total_chars": sum(r.get("char_count", 0) for r in results),
    }
    summary_path = output_dir / "batch_summary.json"
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(f"\n[transcribe] Batch summary: {summary}")

    return results
