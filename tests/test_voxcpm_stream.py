import asyncio
import importlib.util
import sys
import threading
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch


SERVER_PATH = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "local-realtime"
    / "server_voxcpm.py"
)


def _load_server():
    fake_common = types.ModuleType("common")
    class RestartRequired(RuntimeError):
        pass

    fake_common.REPO = Path("/fake/repo")
    fake_common.OUTPUT_RATE = 24000
    fake_common.clip_speech_text = lambda text: text.strip()
    fake_common.text_for_speech = lambda text: text
    fake_common.chunk_pcm = lambda pcm, _milliseconds: (pcm,)
    fake_common.ensure_ref_wav = lambda: (Path("/fake/ref.wav"), "reference")
    fake_common.load_settings = lambda: {}
    fake_common.load_whisper_on_mlx_thread = lambda: None
    fake_common.log = lambda _message: None
    fake_common.run = lambda **_kwargs: None
    fake_common.VoiceServiceRestartRequired = RestartRequired
    fake_capability = types.SimpleNamespace(
        status="disabled",
        mode="disabled",
        pipeline_factory=lambda: None,
    )
    fake_silero = types.SimpleNamespace(
        capability_from_environment=lambda: fake_capability
    )

    spec = importlib.util.spec_from_file_location("kxyy_voxcpm_server", SERVER_PATH)
    server = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    previous_common = sys.modules.get("common")
    previous_silero = sys.modules.get("silero_shadow")
    sys.modules["common"] = fake_common
    sys.modules["silero_shadow"] = fake_silero
    try:
        spec.loader.exec_module(server)
    finally:
        if previous_common is None:
            sys.modules.pop("common", None)
        else:
            sys.modules["common"] = previous_common
        if previous_silero is None:
            sys.modules.pop("silero_shadow", None)
        else:
            sys.modules["silero_shadow"] = previous_silero
    return server


class VoxCpmStreamTests(unittest.IsolatedAsyncioTestCase):
    def test_windows_uses_realtime_streaming_steps_without_changing_macos_quality(self):
        server = _load_server()
        server._reference = lambda: (Path("/fake/ref.wav"), "reference")

        with patch.object(server.sys, "platform", "win32"):
            self.assertEqual(server._kwargs("hello")["inference_timesteps"], 6)

        with patch.object(server.sys, "platform", "darwin"):
            self.assertEqual(server._kwargs("hello")["inference_timesteps"], 10)

    async def test_cancelled_pull_releases_provider_for_the_next_response(self):
        server = _load_server()
        first_pull_started = threading.Event()
        release_first_pull = threading.Event()
        calls = 0

        def blocked_first_stream():
            first_pull_started.set()
            release_first_pull.wait(timeout=2)
            yield b"old"

        def ready_stream():
            yield b"new"

        class FakeModel:
            def generate_streaming(self, **_kwargs):
                nonlocal calls
                calls += 1
                return blocked_first_stream() if calls == 1 else ready_stream()

        pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="test-voxcpm")
        server._model = FakeModel()
        server._kwargs = lambda _text: {}
        server._to_pcm24 = lambda chunk: chunk
        server._gate = threading.BoundedSemaphore(1)
        server._pool = pool
        try:
            first = server._synth_stream("first")
            first_pull = asyncio.create_task(first.__anext__())
            while not first_pull_started.is_set():
                await asyncio.sleep(0.001)

            first_pull.cancel()
            for _ in range(20):
                if first_pull.done():
                    break
                await asyncio.sleep(0.001)

            second = server._synth_stream("second")
            second_pull = asyncio.create_task(second.__anext__())
            await asyncio.sleep(0.01)
            self.assertFalse(
                second_pull.done(),
                "the latest response should wait for cancelled provider cleanup",
            )
            release_first_pull.set()
            result = await asyncio.gather(first_pull, return_exceptions=True)
            self.assertIsInstance(result[0], asyncio.CancelledError)

            self.assertEqual(
                await second_pull,
                {"type": "audio", "pcm": b"new"},
            )
            with self.assertRaises(StopAsyncIteration):
                await second.__anext__()
        finally:
            release_first_pull.set()
            pool.shutdown(wait=True, cancel_futures=True)

    async def test_cleanup_timeout_requests_last_resort_service_recovery(self):
        server = _load_server()
        server._gate = threading.BoundedSemaphore(1)
        self.assertTrue(server._gate.acquire(blocking=False))
        server.PROVIDER_CLEANUP_WAIT_SECONDS = 0.01
        stream = server._synth_stream("latest")
        try:
            with self.assertRaises(server.common.VoiceServiceRestartRequired):
                await stream.__anext__()
        finally:
            server._gate.release()


if __name__ == "__main__":
    unittest.main()
