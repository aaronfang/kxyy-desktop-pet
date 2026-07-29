#!/usr/bin/env python3
"""Qwen3-TTS PyTorch 后端（跨平台，面向 Windows / Linux）。

macOS(Apple Silicon) 走 mlx-audio（见 server.py）；本模块用阿里官方 `qwen-tts`
（PyTorch）提供整句兼容路径。Windows + CUDA 优先使用公开的
`faster-qwen3-tts` CUDA-graph iterator，在模型生成期间逐块返回音频；依赖缺失时
才回退官方整句 API。Windows/Linux 默认使用经固定中文 A/B 验证的 1.7B Base，
用于零样本语音克隆。

准备（建议独立 venv：scripts/local-realtime/.venv-qwen3）：
  1. 按 https://pytorch.org 安装匹配的 torch（NVIDIA 选对应 CUDA 版本；无 GPU 亦可 CPU，较慢）
  2. pip install -U faster-qwen3-tts qwen-tts soundfile websockets certifi openai-whisper
     （openai-whisper 仅实时通话的 ASR 需要；仅朗读可不装）
  也可直接运行 scripts/windows/setup-qwen3-tts.ps1 自动配置。

settings.json（可选）：
  qwen3ModelDir   本地权重目录，或 HF/ModelScope 模型 id（空值使用平台默认）
  qwen3Language   合成语言（Auto / Chinese / English …），默认 Auto

参考音：优先 settings.localRefWav / localRefText；留空则按 settings.personaCardId
从 scripts/local-realtime/assets/<cardId>/ref.* 加载（默认卡 kxyy-yuanyuan）。
"""

from __future__ import annotations

from collections import deque
import os
import sys
from concurrent.futures import Executor
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from threading import BoundedSemaphore

import common

# Windows 实时通话优先降低 TTFA；Linux 保持既有默认，避免无明确请求时
# 改变其质量/资源取舍。只有 faster-qwen3-tts 公开 iterator 可用时才宣告真流式。
WINDOWS_DEFAULT_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
LINUX_DEFAULT_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
DEFAULT_MODEL = WINDOWS_DEFAULT_MODEL if sys.platform == "win32" else LINUX_DEFAULT_MODEL

_model = None
_prompt = None
_ref_wav: "Path | None" = None
_ref_text = ""
_language = "Auto"
_faster_streaming = False
_tts_executor: "Executor | None" = None
_model_gate = BoundedSemaphore(1)

FASTER_STREAMING_CHUNK_STEPS = 24
FASTER_MAX_NEW_TOKENS = 750
FASTER_STREAMING_RESULT_MAX_SAMPLES = common.OUTPUT_RATE * 2
FASTER_RUNTIME_VERSION = "0.3.2"
FASTER_PARITY_MODE = False
FASTER_WARMUP_CHUNK_STEPS = FASTER_STREAMING_CHUNK_STEPS
FASTER_WARMUP_MAX_NEW_TOKENS = 32
FASTER_STREAM_MIN_SECONDS = 20
FASTER_STREAM_SECONDS_PER_CHAR = 0.75
FASTER_STREAM_RAW_MAX_SECONDS = 60
FASTER_LEADING_RMS_THRESHOLD = 0.006
FASTER_LEADING_PREROLL_CHUNKS = 2
_FASTER_STREAM_DONE = object()

# 朗读文本清洗（去神态括号、规范省略号）与 common 共用；Base 模型不支持情绪指令，
# 故仅做文本清洗，不注入情绪描述。
text_for_speech = common.text_for_speech


def _resolve_model() -> str:
    """settings.qwen3ModelDir / 环境变量 → 本地目录（绝对路径）或 HF/ModelScope 模型 id。"""
    s = common.load_settings()
    raw = (s.get("qwen3ModelDir") or os.environ.get("QWEN3_TTS_MODEL") or "").strip()
    if not raw:
        return DEFAULT_MODEL
    p = Path(raw).expanduser()
    if not p.is_absolute():
        cand = (common.REPO / p)
        if cand.exists():
            return str(cand.resolve())
    if p.exists():
        return str(p)
    # 既非现存本地目录，则按模型 id 交给 from_pretrained 自动下载。
    return raw


def configure_from_settings(tts_executor: "Executor | None" = None) -> None:
    global _model, _prompt, _ref_wav, _ref_text, _language
    global _faster_streaming, _tts_executor
    s = common.load_settings()
    _tts_executor = tts_executor
    _faster_streaming = False
    _prompt = None
    _language = (
        (s.get("qwen3Language") or os.environ.get("QWEN3_TTS_LANG") or "Auto").strip()
        or "Auto"
    )

    try:
        import torch
    except ImportError as e:
        raise SystemExit(
            "未安装 Qwen3-TTS 的 PyTorch 依赖（torch）。\n"
            "请在语音 venv 里执行：\n"
            "  pip install -U faster-qwen3-tts qwen-tts soundfile websockets certifi\n"
            "并按 https://pytorch.org 安装匹配的 torch（NVIDIA 选对应 CUDA 版本）。\n"
            "或直接运行 scripts/windows/setup-qwen3-tts.ps1 自动配置。\n"
            f"原始错误：{e}"
        ) from e

    model_id = _resolve_model()
    _ref_wav, _ref_text = common.ensure_ref_wav()
    common.log(f"参考音已就绪 ({len(_ref_text)} chars)")

    has_cuda = bool(getattr(torch, "cuda", None) and torch.cuda.is_available())
    if has_cuda:
        device_map = "cuda:0"
        dtype = torch.bfloat16
    else:
        device_map = "cpu"
        dtype = torch.float32
        common.log("警告：未检测到 CUDA，Qwen3-TTS 将在 CPU 上运行（速度较慢）。")

    # flash-attn 在 Windows 上难装，默认用 sdpa；可用 QWEN3_TTS_ATTN 覆盖。
    attn = (os.environ.get("QWEN3_TTS_ATTN", "sdpa") or "sdpa").strip()

    if sys.platform == "win32" and has_cuda:
        try:
            if version("faster-qwen3-tts") != FASTER_RUNTIME_VERSION:
                raise RuntimeError("faster-qwen3-tts 版本未经验证")
            from faster_qwen3_tts import FasterQwen3TTS

            common.log(
                f"加载 Qwen3-TTS {model_id}（faster CUDA graph "
                f"{FASTER_STREAMING_CHUNK_STEPS}-step, "
                f"device={device_map} dtype={dtype} attn={attn}）…"
            )
            _model = FasterQwen3TTS.from_pretrained(
                model_id,
                device=device_map,
                dtype=dtype,
                attn_implementation=attn,
                backend="torch",
            )
            stream_method = getattr(_model, "generate_voice_clone_streaming", None)
            if not callable(stream_method):
                raise RuntimeError("faster-qwen3-tts 缺少公开流式 API")
            _warm_faster_reference_cache(_model)
            _prompt = None
            _faster_streaming = True
            common.log(
                "Qwen3-TTS 就绪 (faster CUDA graph "
                f"{FASTER_STREAMING_CHUNK_STEPS}-step streaming) "
                f"model={model_id} lang={_language}"
            )
            return
        except (ImportError, PackageNotFoundError):
            common.log("faster-qwen3-tts 未安装，回退官方整句 Qwen3-TTS")
        except Exception as e:
            common.log(
                "faster-qwen3-tts 初始化失败，回退官方整句 Qwen3-TTS "
                f"reason={type(e).__name__}"
            )
            # from_pretrained may have completed before CUDA-graph warmup failed.
            # Drop that model before loading the official fallback so two copies do
            # not temporarily coexist in VRAM and turn a recoverable fallback into OOM.
            _model = None
            try:
                import gc

                gc.collect()
                torch.cuda.empty_cache()
            except Exception:
                pass

    try:
        from qwen_tts import Qwen3TTSModel
    except ImportError as e:
        raise SystemExit(
            "未安装官方 qwen-tts 整句回退依赖。请重新运行 "
            "scripts/windows/setup-qwen3-tts.ps1。"
        ) from e

    common.log(f"加载 Qwen3-TTS {model_id}（official, device={device_map} dtype={dtype} attn={attn}）…")
    try:
        _model = Qwen3TTSModel.from_pretrained(
            model_id,
            device_map=device_map,
            dtype=dtype,
            attn_implementation=attn,
        )
    except Exception as e:
        # 某些环境不支持 sdpa / flash_attention_2，回退到库默认注意力实现。
        common.log(f"attn_implementation={attn} 加载失败（{e}），回退默认实现重试…")
        _model = Qwen3TTSModel.from_pretrained(
            model_id,
            device_map=device_map,
            dtype=dtype,
        )

    # 预构建参考音 prompt，避免每次合成重复提取说话人特征。
    try:
        _prompt = _model.create_voice_clone_prompt(
            ref_audio=str(_ref_wav),
            ref_text=_ref_text,
            x_vector_only_mode=not bool(_ref_text),
        )
        common.log("参考音 prompt 就绪")
    except Exception as e:
        _prompt = None
        common.log(f"预构建参考音 prompt 失败（改为每次合成时传参）：{e}")

    common.log(f"Qwen3-TTS 就绪 (official buffered) model={model_id} lang={_language}")


def _warm_faster_reference_cache(model) -> None:
    """Prime reference extraction and fully drain one short same-mode generation."""
    generator = model.generate_voice_clone_streaming(
        text="你好",
        language=_language,
        ref_audio=str(_ref_wav),
        ref_text=_ref_text,
        max_new_tokens=FASTER_WARMUP_MAX_NEW_TOKENS,
        non_streaming_mode=True,
        chunk_size=FASTER_WARMUP_CHUNK_STEPS,
        parity_mode=FASTER_PARITY_MODE,
    )
    try:
        audio_chunks = 0
        while True:
            chunks = _pull_faster_stream(generator)
            if chunks is _FASTER_STREAM_DONE:
                break
            audio_chunks += len(chunks)
        if audio_chunks < 1:
            raise RuntimeError("Qwen3-TTS 参考音预热未返回音频")
    finally:
        _close_faster_stream(generator)


def _wav_to_pcm24k(audio, sr: int) -> bytes:
    """模型输出（float 波形 + 采样率）→ 24k 单声道 PCM16 bytes。"""
    import numpy as np

    a = np.asarray(audio, dtype=np.float32).reshape(-1)
    if a.size == 0:
        return b""
    if sr != common.OUTPUT_RATE and a.size > 1:
        n = max(1, int(round(a.size * common.OUTPUT_RATE / sr)))
        x_old = np.linspace(0.0, 1.0, num=a.size, endpoint=False)
        x_new = np.linspace(0.0, 1.0, num=n, endpoint=False)
        a = np.interp(x_new, x_old, a).astype(np.float32)
    a = np.clip(a, -1.0, 1.0)
    return (a * 32767.0).astype("<i2").tobytes()


def streaming_supported() -> bool:
    return bool(
        _faster_streaming
        and _model is not None
        and _tts_executor is not None
        and callable(getattr(_model, "generate_voice_clone_streaming", None))
    )


def _voice_clone_kwargs(spoken: str) -> dict:
    kwargs = dict(text=spoken, language=_language)
    if _faster_streaming:
        kwargs.update(
            ref_audio=str(_ref_wav),
            ref_text=_ref_text,
            max_new_tokens=FASTER_MAX_NEW_TOKENS,
            non_streaming_mode=True,
        )
    elif _prompt is not None:
        kwargs["voice_clone_prompt"] = _prompt
    else:
        kwargs["ref_audio"] = str(_ref_wav)
        kwargs["ref_text"] = _ref_text
    return kwargs


def synth_tts(text: str) -> bytes:
    if _model is None or _ref_wav is None:
        raise RuntimeError("Qwen3-TTS 未加载")
    spoken = text_for_speech(text) or (text or "").strip()
    spoken = common.clip_speech_text(spoken)
    if not spoken:
        return b""

    if not _model_gate.acquire(blocking=False):
        raise RuntimeError("Qwen3-TTS 正忙，请稍后再试")
    try:
        common.log(f"Qwen3-TTS chars={len(spoken)} lang={_language}")
        wavs, sr = _model.generate_voice_clone(**_voice_clone_kwargs(spoken))
    finally:
        _model_gate.release()
    if not wavs:
        return b""
    return _wav_to_pcm24k(wavs[0], int(sr))


def _create_faster_stream(spoken: str):
    kwargs = _voice_clone_kwargs(spoken)
    kwargs["chunk_size"] = FASTER_STREAMING_CHUNK_STEPS
    kwargs["parity_mode"] = FASTER_PARITY_MODE
    return _model.generate_voice_clone_streaming(**kwargs)


def _stream_sample_limit(spoken: str) -> int:
    seconds = max(
        FASTER_STREAM_MIN_SECONDS,
        len(spoken) * FASTER_STREAM_SECONDS_PER_CHAR,
    )
    return min(common.OUTPUT_RATE * 60, int(common.OUTPUT_RATE * seconds))


class _LeadingAudioGate:
    """Drop a provider's silent prefix while retaining 160ms before onset."""

    def __init__(self) -> None:
        self._pending: "deque[bytes]" = deque(maxlen=FASTER_LEADING_PREROLL_CHUNKS)
        self.started = False

    def push(self, chunk: bytes) -> tuple[bytes, ...]:
        if self.started:
            return (chunk,)
        if common.pcm16_rms(chunk) < FASTER_LEADING_RMS_THRESHOLD:
            self._pending.append(chunk)
            return ()
        self.started = True
        ready = (*self._pending, chunk)
        self._pending.clear()
        return ready

    def finish(self) -> None:
        if not self.started:
            self._pending.clear()
            raise RuntimeError("Qwen3-TTS 流式输出未检测到有效语音")


def _convert_faster_chunk(audio, sample_rate: int) -> tuple[bytes, ...]:
    import numpy as np

    if int(sample_rate) <= 0:
        raise RuntimeError("Qwen3-TTS 流式输出采样率无效")
    values = np.asarray(audio, dtype=np.float32).reshape(-1)
    if values.size == 0:
        return ()
    if not bool(np.isfinite(values).all()):
        raise RuntimeError("Qwen3-TTS 流式输出包含无效采样")
    # 24-step provider 块约 2 秒；2 秒上限用于拒绝把整句波形
    # 伪装成 provider chunk 的不兼容 runtime。
    source_limit = max(
        1,
        int(
            round(
                FASTER_STREAMING_RESULT_MAX_SAMPLES
                * sample_rate
                / common.OUTPUT_RATE
            )
        ),
    )
    if values.size > source_limit:
        raise RuntimeError("Qwen3-TTS 流式输出块过长")
    pcm = _wav_to_pcm24k(values, int(sample_rate))
    if len(pcm) // 2 > FASTER_STREAMING_RESULT_MAX_SAMPLES:
        raise RuntimeError("Qwen3-TTS 流式输出块过长")
    return tuple(chunk for chunk in common.chunk_pcm(pcm, 80) if chunk)


def _pull_faster_stream(generator):
    try:
        result = next(generator)
    except StopIteration:
        return _FASTER_STREAM_DONE
    if not isinstance(result, tuple) or len(result) < 2:
        raise RuntimeError("Qwen3-TTS 流式输出格式无效")
    return _convert_faster_chunk(result[0], int(result[1]))


def _close_faster_stream(generator) -> None:
    close = getattr(generator, "close", None)
    if callable(close):
        close()


async def synth_tts_stream(text: str):
    """Pull the public faster-qwen3-tts iterator one provider chunk at a time."""
    import asyncio

    if not streaming_supported() or _ref_wav is None:
        raise RuntimeError("Qwen3-TTS 流式输出当前不可用")
    spoken = text_for_speech(text) or (text or "").strip()
    spoken = common.clip_speech_text(spoken)
    if not spoken:
        return
    if not _model_gate.acquire(blocking=False):
        raise RuntimeError("Qwen3-TTS 正忙，请稍后再试")

    loop = asyncio.get_running_loop()
    generator = None
    samples_yielded = 0
    raw_samples_seen = 0
    sample_limit = _stream_sample_limit(spoken)
    leading_gate = _LeadingAudioGate()
    try:
        generator = _create_faster_stream(spoken)
        while True:
            chunks = await loop.run_in_executor(
                _tts_executor, _pull_faster_stream, generator
            )
            if chunks is _FASTER_STREAM_DONE:
                break
            for chunk in chunks:
                raw_samples_seen += len(chunk) // 2
                if raw_samples_seen > common.OUTPUT_RATE * FASTER_STREAM_RAW_MAX_SECONDS:
                    raise RuntimeError("Qwen3-TTS 流式输出时长异常")
                for audible_chunk in leading_gate.push(chunk):
                    chunk_samples = len(audible_chunk) // 2
                    if samples_yielded + chunk_samples > sample_limit:
                        raise RuntimeError("Qwen3-TTS 流式输出时长异常")
                    samples_yielded += chunk_samples
                    yield {"type": "audio", "pcm": audible_chunk}
        leading_gate.finish()
    finally:
        if generator is None:
            _model_gate.release()
        else:
            # Executor futures cannot kill an in-flight CUDA generation step. Queue
            # close behind it and retain the gate until the real worker is quiescent.
            cleanup = loop.run_in_executor(
                _tts_executor, _close_faster_stream, generator
            )
            gate_released = False

            def release_gate(future) -> None:
                nonlocal gate_released
                if gate_released:
                    return
                gate_released = True
                try:
                    if not future.cancelled():
                        future.exception()
                finally:
                    _model_gate.release()

            cleanup.add_done_callback(release_gate)
            await asyncio.shield(cleanup)
            release_gate(cleanup)


def synth_tts_http(text: str) -> "tuple[bytes, str]":
    pcm = synth_tts(text)
    if not pcm:
        raise RuntimeError("Qwen3-TTS 未返回音频")
    return common.pcm16_to_browser_wav(pcm, common.OUTPUT_RATE), "audio/wav"
