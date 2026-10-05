#!/usr/bin/env python3
import os
from pathlib import Path
import socket
import sys
import threading
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "local-realtime"))

import common  # noqa: E402
from test_voxcpm_stream import _load_server  # noqa: E402


class TtsHttpStreamTests(unittest.TestCase):
    def _start_server(self, synth_stream, synth_http_stream=None):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            http_port = probe.getsockname()[1]
        old_stream = common._synth_tts_stream
        old_http_stream = common._synth_tts_http_stream
        old_secret = os.environ.pop("KXYY_TTS_SECRET", None)
        common._synth_tts_stream = synth_stream
        common._synth_tts_http_stream = synth_http_stream
        server = common.start_tts_http(http_port - 100)
        return http_port, server, old_stream, old_http_stream, old_secret

    def _stop_server(self, server, old_stream, old_http_stream, old_secret):
        server.shutdown()
        server.server_close()
        common._synth_tts_stream = old_stream
        common._synth_tts_http_stream = old_http_stream
        if old_secret is not None:
            os.environ["KXYY_TTS_SECRET"] = old_secret

    def test_stream_flushes_first_pcm_before_generation_finishes(self):
        gate = threading.Event()

        async def synth_stream(_text):
            yield {"type": "audio", "pcm": b"\x01\x00\x02\x00"}
            await __import__("asyncio").get_running_loop().run_in_executor(None, gate.wait)
            yield {"type": "audio", "pcm": b"\x03\x00\x04\x00"}

        http_port, server, old_stream, old_http_stream, old_secret = self._start_server(synth_stream)
        try:
            request = urllib.request.Request(
                f"http://127.0.0.1:{http_port}/tts-stream",
                data=b'{"text":"hello"}',
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=3) as response:
                self.assertEqual(response.headers.get_content_type(), "audio/l16")
                self.assertEqual(response.read(4), b"\x01\x00\x02\x00")
                self.assertFalse(gate.is_set())
                gate.set()
                self.assertEqual(response.read(), b"\x03\x00\x04\x00")
        finally:
            gate.set()
            self._stop_server(server, old_stream, old_http_stream, old_secret)

    def test_stream_failure_after_headers_does_not_append_a_second_http_response(self):
        async def synth_stream(_text):
            yield {"type": "audio", "pcm": b"\x01\x00\x02\x00"}
            raise RuntimeError("generation failed")

        http_port, server, old_stream, old_http_stream, old_secret = self._start_server(synth_stream)
        try:
            request = urllib.request.Request(
                f"http://127.0.0.1:{http_port}/tts-stream",
                data=b'{"text":"hello"}',
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=3) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), b"\x01\x00\x02\x00")
        finally:
            self._stop_server(server, old_stream, old_http_stream, old_secret)

    def test_stream_admission_rejects_overlap_and_recovers_after_completion(self):
        release_first = threading.Event()
        first_started = threading.Event()
        calls_lock = threading.Lock()
        calls = 0

        async def synth_stream(_text):
            nonlocal calls
            with calls_lock:
                calls += 1
                call = calls
            yield {"type": "audio", "pcm": b"\x01\x00\x02\x00"}
            if call == 1:
                first_started.set()
                await __import__("asyncio").get_running_loop().run_in_executor(None, release_first.wait)

        http_port, server, old_stream, old_http_stream, old_secret = self._start_server(synth_stream)

        def request_stream():
            request = urllib.request.Request(
                f"http://127.0.0.1:{http_port}/tts-stream",
                data=b'{"text":"hello"}',
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            return urllib.request.urlopen(request, timeout=3)

        first_done = threading.Event()

        def consume_first():
            try:
                with request_stream() as response:
                    response.read()
            finally:
                first_done.set()

        first_thread = threading.Thread(target=consume_first)
        first_thread.start()
        try:
            self.assertTrue(first_started.wait(2))
            with self.assertRaises(urllib.error.HTTPError) as overlap:
                request_stream()
            self.assertEqual(overlap.exception.code, 503)
            overlap.exception.close()

            release_first.set()
            self.assertTrue(first_done.wait(2))
            with request_stream() as recovered:
                self.assertEqual(recovered.status, 200)
                self.assertEqual(recovered.read(), b"\x01\x00\x02\x00")
        finally:
            release_first.set()
            first_thread.join(timeout=2)
            self._stop_server(server, old_stream, old_http_stream, old_secret)

    def test_http_stream_passes_only_the_allowlisted_companion_latency_mode(self):
        modes = []

        async def realtime_stream(_text):
            raise AssertionError("HTTP should use its scoped stream adapter")
            yield

        async def http_stream(_text, latency_mode):
            modes.append(latency_mode)
            yield {"type": "audio", "pcm": b"\x01\x00"}

        http_port, server, old_stream, old_http_stream, old_secret = self._start_server(
            realtime_stream,
            http_stream,
        )
        try:
            for requested, expected in (("companion", "companion"), ("fastest", "default")):
                request = urllib.request.Request(
                    f"http://127.0.0.1:{http_port}/tts-stream",
                    data=(f'{{"text":"hello","latencyMode":"{requested}"}}').encode(),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=3) as response:
                    self.assertEqual(response.read(), b"\x01\x00")
                self.assertEqual(modes[-1], expected)
        finally:
            self._stop_server(server, old_stream, old_http_stream, old_secret)

    def test_voxcpm_cleanup_survives_finished_http_request_loop(self):
        provider = _load_server()
        cleanup_started = threading.Event()
        release_cleanup = threading.Event()
        pool = ThreadPoolExecutor(max_workers=1)
        provider._pool = pool
        provider._gate = threading.BoundedSemaphore(1)
        provider._provider_stream = lambda _text, _mode: iter((b"\x01\x00",))
        provider._to_pcm24 = lambda chunk, **_kwargs: chunk
        provider.PROVIDER_CLEANUP_WAIT_SECONDS = 0.02

        def close_stream(_generator):
            cleanup_started.set()
            if not release_cleanup.wait(timeout=2):
                raise RuntimeError("test cleanup release timed out")

        provider._close_stream = close_stream
        http_port, server, old_stream, old_http_stream, old_secret = self._start_server(
            provider._synth_stream, provider._synth_http_stream
        )

        def request_stream():
            request = urllib.request.Request(
                f"http://127.0.0.1:{http_port}/tts-stream",
                data=b'{"text":"hello"}',
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=3) as response:
                self.assertEqual(response.status, 200)
                return response.read()

        try:
            self.assertEqual(request_stream(), b"\x01\x00")
            self.assertTrue(cleanup_started.wait(2))
            release_cleanup.set()
            pool.submit(lambda: None).result(timeout=2)
            self.assertEqual(request_stream(), b"\x01\x00")
        finally:
            release_cleanup.set()
            self._stop_server(server, old_stream, old_http_stream, old_secret)
            pool.shutdown(wait=True)


if __name__ == "__main__":
    unittest.main()
