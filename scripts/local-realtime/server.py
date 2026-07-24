#!/usr/bin/env python3
"""本地语音 · Qwen3-TTS（跨平台，通话 WS :19876，朗读 HTTP :19976）。

后端按平台自动选择：
  - macOS(Apple Silicon)：mlx-audio（mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit）。
  - Windows / Linux：官方 PyTorch 包 qwen-tts（默认 Qwen/Qwen3-TTS-12Hz-1.7B-Base），
    见 tts_qwen3_torch.py。Windows 首次使用请先运行 scripts/windows/setup-qwen3-tts.ps1。

用法：
  <venv>/python scripts/local-realtime/server.py
  设置「语音后端」= 本地 Qwen3-TTS（朗读与通话共用）
"""

from __future__ import annotations

import asyncio
import inspect
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import common

PORT = 19876
# macOS MLX 量化权重（0.6B）；PyTorch 路径的模型见 tts_qwen3_torch.DEFAULT_MODEL。
TTS_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit"
MLX_STREAMING_INTERVAL = 0.32
MLX_STREAMING_MAX_TOKENS = 750
# Fail closed if an incompatible runtime ignores the requested interval.
MLX_STREAMING_RESULT_MAX_SAMPLES = 24000 * 2


def _mlx_available() -> bool:
    """仅 macOS 且已安装 mlx-audio 时用 MLX；否则回退 PyTorch（Windows/Linux）。"""
    if sys.platform != "darwin":
        return False
    try:
        import mlx_audio  # noqa: F401

        return True
    except Exception:
        return False


# ============================ MLX 路径（macOS）============================
_tts_model = None
_ref_text = ""
_ref_wav = None
_mlx_model_gate = threading.BoundedSemaphore(1)
_MLX_STREAM_DONE = object()


def _load_on_mlx() -> None:
    global _tts_model, _ref_text, _ref_wav
    _ref_wav, _ref_text = common.ensure_ref_wav()
    common.log(f"参考音已就绪 ({len(_ref_text)} chars)")
    common.log(f"加载 TTS {TTS_MODEL} …")
    from mlx_audio.tts.utils import load_model

    _tts_model = load_model(TTS_MODEL)
    common.load_whisper_on_mlx_thread()
    common.log("Qwen3-TTS 就绪 (mlx)")


def _prepare_mlx() -> None:
    common._mlx_pool.submit(_load_on_mlx).result()
    if _mlx_streaming_supported(_tts_model):
        common._synth_tts_stream = _synth_mlx_stream
        common.log("Qwen3-TTS provider PCM 流式已启用 (mlx)")
    else:
        # 旧 runtime 或非 24k 模型必须在会话协商前关闭 capability，安全回退整句。
        common._synth_tts_stream = None
        common.log("Qwen3-TTS provider PCM 流式不可用，回退整句合成")


def _mlx_streaming_supported(model) -> bool:
    if model is None or int(getattr(model, "sample_rate", 0) or 0) != common.OUTPUT_RATE:
        return False
    try:
        parameters = inspect.signature(model.generate).parameters
        decoder = model.speech_tokenizer.decoder
    except (AttributeError, TypeError, ValueError):
        return False
    return "stream" in parameters and callable(
        getattr(decoder, "reset_streaming_state", None)
    )


def _spoken_text(text: str) -> str:
    spoken = common.text_for_speech(text) or (text or "").strip()
    return common.clip_speech_text(spoken)


def _create_mlx_stream(spoken: str):
    return _tts_model.generate(
        text=spoken,
        ref_audio=str(_ref_wav),
        ref_text=_ref_text,
        stream=True,
        streaming_interval=MLX_STREAMING_INTERVAL,
        max_tokens=MLX_STREAMING_MAX_TOKENS,
    )


def _pull_mlx_stream(generator):
    """Pull one provider chunk and convert it on the MLX worker thread."""
    import numpy as np

    try:
        result = next(generator)
    except StopIteration:
        return _MLX_STREAM_DONE
    sample_rate = int(getattr(result, "sample_rate", 0) or 0)
    if sample_rate != common.OUTPUT_RATE:
        raise RuntimeError("Qwen3-TTS 流式输出采样率不受支持")
    declared_samples = int(getattr(result, "samples", 0) or 0)
    if declared_samples > MLX_STREAMING_RESULT_MAX_SAMPLES:
        raise RuntimeError("Qwen3-TTS 流式输出块过长")
    audio = np.asarray(result.audio, dtype=np.float32).reshape(-1)
    if audio.size == 0:
        return ()
    if audio.size > MLX_STREAMING_RESULT_MAX_SAMPLES:
        raise RuntimeError("Qwen3-TTS 流式输出块过长")
    if not bool(np.isfinite(audio).all()):
        raise RuntimeError("Qwen3-TTS 流式输出包含无效采样")
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    return tuple(common.chunk_pcm(pcm, 80))


def _close_mlx_stream(generator) -> None:
    """Close/reset on the same single worker that advances the stateful decoder."""
    try:
        generator.close()
    finally:
        try:
            _tts_model.speech_tokenizer.decoder.reset_streaming_state()
        finally:
            try:
                import mlx.core as mx

                mx.clear_cache()
            except ImportError:
                pass


async def _synth_mlx_stream(text: str):
    """Adapt mlx-audio's sync generator to the provider-neutral PCM iterator."""
    if _tts_model is None or _ref_wav is None:
        raise RuntimeError("Qwen3-TTS 未加载")
    spoken = _spoken_text(text)
    if not spoken:
        return
    if not _mlx_model_gate.acquire(blocking=False):
        raise RuntimeError("Qwen3-TTS 正忙，请稍后再试")

    loop = asyncio.get_running_loop()
    generator = None
    try:
        generator = _create_mlx_stream(spoken)
        while True:
            chunks = await loop.run_in_executor(
                common._mlx_pool, _pull_mlx_stream, generator
            )
            if chunks is _MLX_STREAM_DONE:
                break
            for chunk in chunks:
                yield {"type": "audio", "pcm": chunk}
    finally:
        if generator is None:
            _mlx_model_gate.release()
        else:
            # run_in_executor cannot kill an in-flight next(). Queue cleanup behind it,
            # and keep the model gate held until close/reset actually finishes.
            cleanup = loop.run_in_executor(common._mlx_pool, _close_mlx_stream, generator)
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
                    _mlx_model_gate.release()

            cleanup.add_done_callback(release_gate)
            await asyncio.shield(cleanup)
            # asyncio schedules done callbacks with call_soon; release synchronously
            # after a successful await so a completed stream is immediately reusable.
            release_gate(cleanup)


def _synth_mlx(text: str) -> bytes:
    import numpy as np

    spoken = _spoken_text(text)
    if not spoken:
        return b""
    if not _mlx_model_gate.acquire(blocking=False):
        raise RuntimeError("Qwen3-TTS 正忙，请稍后再试")
    try:
        results = list(
            _tts_model.generate(
                text=spoken,
                ref_audio=str(_ref_wav),
                ref_text=_ref_text,
            )
        )
    finally:
        _mlx_model_gate.release()
    if not results:
        return b""
    audio = np.array(results[0].audio, dtype=np.float32).reshape(-1)
    sr = int(
        getattr(results[0], "sample_rate", None)
        or getattr(_tts_model, "sample_rate", 24000)
    )
    if sr != common.OUTPUT_RATE and len(audio) > 1:
        duration = len(audio) / sr
        n = max(1, int(duration * common.OUTPUT_RATE))
        x_old = np.linspace(0.0, 1.0, num=len(audio), endpoint=False)
        x_new = np.linspace(0.0, 1.0, num=n, endpoint=False)
        audio = np.interp(x_new, x_old, audio).astype(np.float32)
    audio = np.clip(audio, -1.0, 1.0)
    return (audio * 32767.0).astype(np.int16).tobytes()


# ====================== 入口：按平台选择后端拉起服务 ======================
def _run_mlx() -> None:
    common.run(
        port=PORT,
        name="local-qwen",
        synth_tts=_synth_mlx,
        prepare=_prepare_mlx,
        tts_pool=common._mlx_pool,
        tts_parallelism=1,
        tts_prefetch_while_playing=False,
        synth_tts_stream=_synth_mlx_stream,
    )


def _run_torch() -> None:
    import tts_qwen3_torch as qwen3

    tts_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="qwen3")

    def prepare() -> None:
        qwen3.configure_from_settings()
        # 通话 ASR：Windows/Linux 用 openai-whisper（无 mlx-whisper）。缺失不阻断朗读。
        try:
            common._mlx_pool.submit(common.load_whisper_on_mlx_thread).result()
        except Exception as e:
            common.log(f"警告：Whisper 加载失败，实时通话 ASR 不可用：{e}")
            common.log("朗读 HTTP 仍可用（如需通话请安装 openai-whisper）。")
        common.log("Qwen3-TTS 本地服务就绪 (pytorch)")

    common.run(
        port=PORT,
        name="local-qwen",
        synth_tts=qwen3.synth_tts,
        synth_tts_http=qwen3.synth_tts_http,
        prepare=prepare,
        tts_pool=tts_pool,
        tts_parallelism=1,
        tts_prefetch_while_playing=True,
    )


if __name__ == "__main__":
    if _mlx_available():
        _run_mlx()
    else:
        _run_torch()
