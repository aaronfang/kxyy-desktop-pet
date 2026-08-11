#!/usr/bin/env python3
"""Experimental Higgs Audio v3 local realtime backend (macOS/Apple Silicon)."""

from __future__ import annotations

import asyncio
import os
import platform
import re
import sys
import threading
from pathlib import Path

import common
import silero_shadow

PORT = 19879
MODEL_ID = "bosonai/higgs-audio-v3-tts-4b"
DEFAULT_REF = common.REPO / "scripts/local-realtime/assets/kxyy-yuanyuan/ref.wav"
DEFAULT_REF_TEXT = common.REPO / "scripts/local-realtime/assets/kxyy-yuanyuan/ref.txt"
TEMPERATURE = float(os.environ.get("KXYY_HIGGS_TEMPERATURE", "0.3"))
MAX_NEW_TOKENS = 1024
REALTIME_PIECE_MAX_CHARS = 18
REALTIME_MIN_NEW_TOKENS = 64
REALTIME_MAX_NEW_TOKENS = 384
REALTIME_PREFETCH_CHUNKS = 32  # 2.56s at the fixed 80ms managed chunk size.
REALTIME_CONTINUATION_PREFETCH_CHUNKS = 16  # 1.28s between natural clauses.
STREAM_EMIT_FRAMES = 16  # Higgs codec frames are 40ms: first decode at about 640ms.
STREAM_DECODE_WINDOW_FRAMES = 64
HIGGS_CODEC_SAMPLES_PER_FRAME = 960
# Keep enough non-causal decoder context while still releasing 240ms from the
# first nine decoded frames, so the Worklet can satisfy its startup reservoir.
STREAM_OVERLAP_MS = 120
STREAM_RESULT_MAX_SAMPLES = common.OUTPUT_RATE * 2
_STREAM_DONE = object()

_model = None
_ref_wav: Path | None = None
_ref_text = ""
_ref_codes = None
_gate = threading.BoundedSemaphore(1)


class _PrefixPcmEmitter:
    """Turn repeatedly decoded audio prefixes into continuous PCM chunks."""

    def __init__(self, sample_rate: int, overlap_ms: int) -> None:
        import numpy as np

        self._np = np
        self._overlap_samples = max(1, sample_rate * overlap_ms // 1000)
        self._fade_in_samples = max(1, sample_rate * 5 // 1000)
        self._fade_out_samples = max(1, sample_rate * 5 // 1000)
        self._overlap_tail = None
        self._emitted_samples = 0

    def emit(self, pcm, *, window_start_samples: int = 0, final: bool):
        np = self._np
        values = np.asarray(pcm, dtype=np.float32).reshape(-1).copy()
        if values.size == 0 or not bool(np.isfinite(values).all()):
            raise RuntimeError("Higgs 流式解码返回了无效音频")
        if window_start_samples < 0:
            raise RuntimeError("Higgs 流式解码窗口无效")

        overlap = self._overlap_samples
        if self._overlap_tail is None:
            if window_start_samples != 0:
                raise RuntimeError("Higgs 首个流式解码窗口必须从零开始")
            fade = min(self._fade_in_samples, values.size)
            values[:fade] *= np.linspace(0.0, 1.0, fade, dtype=np.float32)
            if final:
                self._fade_out(values)
                self._emitted_samples = values.size
                return values
            if values.size <= overlap:
                return np.empty(0, dtype=np.float32)
            self._overlap_tail = values[-overlap:].copy()
            self._emitted_samples = window_start_samples + values.size - overlap
            return values[:-overlap].copy()

        start = self._emitted_samples - window_start_samples
        if start < 0 or values.size < start + overlap:
            raise RuntimeError("Higgs 流式解码窗口未覆盖待拼接音频")
        current_overlap = values[start : start + overlap]
        fade_out = np.linspace(1.0, 0.0, overlap, dtype=np.float32)
        fade_in = np.linspace(0.0, 1.0, overlap, dtype=np.float32)
        crossfaded = self._overlap_tail * fade_out + current_overlap * fade_in

        if final:
            tail = values[start + overlap :].copy()
            self._fade_out(tail)
            self._emitted_samples = window_start_samples + values.size
            self._overlap_tail = None
            return np.concatenate((crossfaded, tail))

        middle_end = values.size - overlap
        middle = values[start + overlap : middle_end].copy()
        self._overlap_tail = values[-overlap:].copy()
        self._emitted_samples = window_start_samples + middle_end
        return np.concatenate((crossfaded, middle))

    def _fade_out(self, values) -> None:
        np = self._np
        fade = min(self._fade_out_samples, values.size)
        values[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)


def _reference() -> tuple[Path, str]:
    """Use an explicit env/settings reference, otherwise the Higgs Legacy preset."""
    env_wav = os.environ.get("KXYY_HIGGS_REF_WAV", "").strip()
    env_text = os.environ.get("KXYY_HIGGS_REF_TEXT", "").strip()
    settings = common.load_settings()
    configured = str(settings.get("localRefWav", "") or "").strip()
    if env_wav or configured:
        wav = Path(env_wav or configured).expanduser()
        if not wav.is_absolute():
            wav = (common.REPO / wav).resolve()
        text = env_text or str(settings.get("localRefText", "") or "").strip()
        if not text and wav.with_suffix(".txt").is_file():
            text = wav.with_suffix(".txt").read_text(encoding="utf-8").strip()
        if not wav.is_file() or not text:
            raise SystemExit("Higgs 参考音频或逐字文案不存在；请设置 KXYY_HIGGS_REF_WAV/KXYY_HIGGS_REF_TEXT")
        return wav, text
    if not DEFAULT_REF.is_file() or not DEFAULT_REF_TEXT.is_file():
        raise SystemExit("缺少 Higgs Legacy 参考音：ref.wav/ref.txt")
    return DEFAULT_REF, DEFAULT_REF_TEXT.read_text(encoding="utf-8").strip()


def _spoken_text(raw: str) -> str:
    spoken = common.text_for_speech(raw) or (raw or "").strip()
    return common.clip_speech_text(spoken)


def _higgs_controls(raw: str, spoken: str) -> str:
    """Apply only controls that passed the YuanYuan listening gate.

    Surprise is intentionally left as plain text: the token itself changes
    the speaker identity in the current MLX zero-shot path.
    """
    emotion = common.detect_emotion(raw)
    if emotion == "excited" and re.search(r"哈哈|好笑|笑死|逗笑|忍不住", spoken):
        return "<|emotion:amusement|>"
    if re.search(r"想一想|想想|换一个角度|考虑一下|思考一下|让我想", spoken):
        return "<|emotion:contemplation|><|prosody:speed_slow|>"
    return ""


def _prepare() -> None:
    global _model, _ref_wav, _ref_text, _ref_codes
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise SystemExit("Higgs MLX 实验后端只支持 Apple Silicon macOS")
    _ref_wav, _ref_text = _reference()
    model_id = os.environ.get("KXYY_HIGGS_MODEL", MODEL_ID).strip() or MODEL_ID
    common.log(f"Higgs 参考音已就绪 ({len(_ref_text)} chars, legacy-safe)")
    common.log(f"加载 Higgs Audio v3 {model_id} …")
    from mlx_audio.tts import load

    _model = load(model_id, model_type="higgs_audio_v3")
    _ref_codes = _model.encode_reference_audio(str(_ref_wav))
    common.load_whisper_on_mlx_thread()
    if _streaming_supported(_model):
        common._synth_tts_stream = _synth_higgs_stream
        mode = "provider-pcm-v1"
    else:
        common._synth_tts_stream = None
        mode = "sentence-buffered"
    common.log(f"Higgs Audio v3 就绪 (24kHz, temperature={TEMPERATURE}, {mode})")


def _streaming_supported(model) -> bool:
    # Buffered generation monopolizes the shared MLX worker for tens of
    # seconds, which also blocks barge-in Whisper. Realtime therefore defaults
    # to bounded provider chunks; the switch remains for diagnostic fallback.
    if os.environ.get("KXYY_HIGGS_STREAMING", "1").strip().lower() in {
        "0",
        "false",
        "off",
    }:
        return False
    required = (
        "_normalize_references",
        "_build_prompt_embeddings",
        "_audio_logits",
        "_embed_audio_codes",
        "_decode_audio",
    )
    return (
        model is not None
        and int(getattr(model, "sample_rate", 0) or 0) == common.OUTPUT_RATE
        and getattr(model, "backbone", None) is not None
        and all(callable(getattr(model, name, None)) for name in required)
    )


def _split_realtime_text(text: str) -> list[str]:
    """Split Higgs requests at natural boundaries without dropping text."""
    value = str(text or "")
    if not value:
        return []
    parts: list[str] = []
    start = 0
    strong = frozenset("。！？!?；;\n")
    weak = frozenset("，,、：:")
    while start < len(value):
        upper = min(len(value), start + REALTIME_PIECE_MAX_CHARS)
        cut = None
        for index in range(start, upper):
            if value[index] in strong and index + 1 - start >= 4:
                cut = index + 1
                break
        if cut is None and upper < len(value):
            for index in range(upper - 1, start + 3, -1):
                if value[index] in weak:
                    cut = index + 1
                    break
        cut = cut or upper
        parts.append(value[start:cut])
        start = cut
    return [part for part in parts if part]


def _max_realtime_tokens(text: str) -> int:
    """Bound pathological held vowels while leaving normal clauses headroom."""
    return max(
        REALTIME_MIN_NEW_TOKENS,
        min(REALTIME_MAX_NEW_TOKENS, 32 + len(str(text or "")) * 16),
    )


def _decode_window_start(total_rows: int, max_rows: int) -> int:
    if total_rows < 0 or max_rows < 1:
        raise ValueError("invalid Higgs decode window")
    return max(0, total_rows - max_rows)


def _iter_higgs_prefixes(target: str, *, max_new_tokens: int = MAX_NEW_TOKENS):
    """Generate Higgs codec rows once and decode a bounded rolling window."""
    import mlx.core as mx
    import numpy as np
    from mlx_audio.tts.models.higgs_audio_v3.generation import HiggsSamplerState, step
    from mlx_lm.models.cache import make_prompt_cache

    references = _model._normalize_references(
        ref_text=_ref_text,
        ref_audio_codes=_ref_codes,
    )
    prompt_embeds, _prompt_tokens = _model._build_prompt_embeddings(target, references)
    mx.eval(prompt_embeds)
    cache = make_prompt_cache(_model)
    dummy = mx.zeros((1, prompt_embeds.shape[1]), dtype=mx.int32)
    hidden = _model.backbone(dummy, cache=cache, input_embeddings=prompt_embeds)
    last_hidden = hidden[:, -1, :]
    mx.eval(last_hidden)

    state = HiggsSamplerState(num_codebooks=_model.config.audio_num_codebooks)
    delayed_rows = []
    emitter = _PrefixPcmEmitter(common.OUTPUT_RATE, STREAM_OVERLAP_MS)
    last_emit = 0
    final_emitted = False

    for _ in range(max_new_tokens):
        logits = _model._audio_logits(last_hidden)[0]
        codes = step(
            logits,
            state,
            temperature=TEMPERATURE,
            top_p=None,
            top_k=None,
            boc_id=_model.config.audio_boc_token_id,
            eoc_id=_model.config.audio_eoc_token_id,
        )
        delayed_rows.append(codes)
        should_emit = state.generation_done or len(delayed_rows) - last_emit >= STREAM_EMIT_FRAMES
        if should_emit and len(delayed_rows) >= _model.config.audio_num_codebooks:
            window_start = _decode_window_start(
                len(delayed_rows),
                STREAM_DECODE_WINDOW_FRAMES,
            )
            audio = _model._decode_audio(delayed_rows[window_start:])
            mx.eval(audio)
            chunk = emitter.emit(
                np.asarray(audio),
                window_start_samples=(
                    window_start * HIGGS_CODEC_SAMPLES_PER_FRAME
                ),
                final=state.generation_done,
            )
            last_emit = len(delayed_rows)
            if chunk.size:
                yield chunk
            if state.generation_done:
                final_emitted = True
                break
        if state.generation_done:
            break
        next_embed = _model._embed_audio_codes(codes)[None]
        decode_dummy = mx.zeros((1, 1), dtype=mx.int32)
        hidden = _model.backbone(
            decode_dummy,
            cache=cache,
            input_embeddings=next_embed,
        )
        last_hidden = hidden[:, -1, :]

    if delayed_rows and not final_emitted:
        window_start = _decode_window_start(
            len(delayed_rows),
            STREAM_DECODE_WINDOW_FRAMES,
        )
        audio = _model._decode_audio(delayed_rows[window_start:])
        mx.eval(audio)
        chunk = emitter.emit(
            np.asarray(audio),
            window_start_samples=window_start * HIGGS_CODEC_SAMPLES_PER_FRAME,
            final=True,
        )
        if chunk.size:
            yield chunk


def _pull_higgs_stream(generator):
    import numpy as np

    try:
        audio = next(generator)
    except StopIteration:
        return _STREAM_DONE
    values = np.asarray(audio, dtype=np.float32).reshape(-1)
    if values.size == 0:
        return ()
    if values.size > STREAM_RESULT_MAX_SAMPLES:
        raise RuntimeError("Higgs 流式输出块过长")
    if not bool(np.isfinite(values).all()):
        raise RuntimeError("Higgs 流式输出包含无效采样")
    pcm = (np.clip(values, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    return tuple(common.chunk_pcm(pcm, 80))


def _close_higgs_stream(generator) -> None:
    close = getattr(generator, "close", None)
    if callable(close):
        close()


async def _synth_higgs_stream(text: str):
    if _model is None or _ref_codes is None:
        raise RuntimeError("Higgs TTS 未加载")
    spoken = _spoken_text(text)
    if not spoken:
        return
    if not _gate.acquire(blocking=False):
        raise RuntimeError("Higgs TTS 正忙，请稍后再试")

    loop = asyncio.get_running_loop()
    try:
        for piece_index, piece in enumerate(_split_realtime_text(spoken)):
            target = f"{_higgs_controls(piece, piece)}{piece}"
            generator = _iter_higgs_prefixes(
                target,
                max_new_tokens=_max_realtime_tokens(piece),
            )
            try:
                # Pull a bounded reservoir before the sender starts its 1x
                # pacing clock. Higgs MLX is slightly slower than realtime on
                # longer clauses; this absorbs that deficit without calling
                # ``next()`` concurrently with paced transport.
                prefetched: list[bytes] = []
                prefetch_limit = (
                    REALTIME_PREFETCH_CHUNKS
                    if piece_index == 0
                    else REALTIME_CONTINUATION_PREFETCH_CHUNKS
                )
                while True:
                    chunks = await loop.run_in_executor(
                        common._mlx_pool,
                        _pull_higgs_stream,
                        generator,
                    )
                    if chunks is _STREAM_DONE:
                        break
                    prefetched.extend(chunks)
                    if len(prefetched) >= prefetch_limit:
                        break
                for chunk in prefetched:
                    yield {"type": "audio", "pcm": chunk}
                if chunks is _STREAM_DONE:
                    continue
                while True:
                    chunks = await loop.run_in_executor(
                        common._mlx_pool,
                        _pull_higgs_stream,
                        generator,
                    )
                    if chunks is _STREAM_DONE:
                        break
                    for chunk in chunks:
                        yield {"type": "audio", "pcm": chunk}
            finally:
                cleanup = loop.run_in_executor(
                    common._mlx_pool,
                    _close_higgs_stream,
                    generator,
                )
                try:
                    await asyncio.shield(cleanup)
                except asyncio.CancelledError:
                    # Executor work cannot be killed. Do not release the model
                    # gate until the old generator has really closed.
                    await cleanup
                    raise
    finally:
        _gate.release()


def _synth(text: str) -> bytes:
    import numpy as np

    if _model is None or _ref_wav is None or _ref_codes is None:
        raise RuntimeError("Higgs TTS 未加载")
    spoken = _spoken_text(text)
    if not spoken:
        return b""
    control = _higgs_controls(text, spoken)
    target = f"{control}{spoken}"
    if not _gate.acquire(blocking=False):
        raise RuntimeError("Higgs TTS 正忙，请稍后再试")
    try:
        results = list(
            _model.generate(
                text=target,
                ref_text=_ref_text,
                ref_audio_codes=_ref_codes,
                temperature=TEMPERATURE,
                max_new_tokens=MAX_NEW_TOKENS,
            )
        )
    finally:
        _gate.release()
    if not results:
        return b""
    result = results[0]
    audio = np.asarray(result.audio, dtype=np.float32).reshape(-1)
    sample_rate = int(getattr(result, "sample_rate", 0) or 0)
    if sample_rate != common.OUTPUT_RATE:
        raise RuntimeError("Higgs 输出采样率不是 24kHz")
    if audio.size == 0 or not bool(np.isfinite(audio).all()):
        raise RuntimeError("Higgs 输出为空或包含无效采样")
    return (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def _synth_http(text: str) -> tuple[bytes, str]:
    pcm = _synth(text)
    if not pcm:
        raise RuntimeError("Higgs TTS 未返回音频")
    return common.pcm16_to_browser_wav(pcm, common.OUTPUT_RATE), "audio/wav"


if __name__ == "__main__":
    capability = silero_shadow.capability_from_environment()
    common.run(
        port=PORT,
        name="local-higgs",
        synth_tts=_synth,
        synth_tts_http=_synth_http,
        prepare=_prepare,
        tts_pool=common._mlx_pool,
        tts_parallelism=1,
        tts_prefetch_while_playing=False,
        synth_tts_stream=_synth_higgs_stream,
        vad_shadow_pipeline_factory=capability.pipeline_factory(),
        vad_shadow_start_status=capability.status,
        vad_shadow_mode=capability.mode,
        vad_shadow_config_revision=getattr(capability, "config_revision", "none"),
    )
