import asyncio
import collections
import importlib.util
import io
import json
import os
import queue
import struct
import sys
import threading
import types
import unittest
import urllib.error
from pathlib import Path


COMMON_PATH = Path(__file__).resolve().parents[1] / "scripts" / "local-realtime" / "common.py"
TTS_COSYVOICE_PATH = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "local-realtime"
    / "tts_cosyvoice.py"
)
PCM_REPLAY_PATH = Path(__file__).resolve().parent / "fixtures" / "realtime-pcm-replay.json"
SPEC = importlib.util.spec_from_file_location("kxyy_local_realtime_common", COMMON_PATH)
common = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(common)

TTS_COSYVOICE_SPEC = importlib.util.spec_from_file_location(
    "kxyy_local_realtime_tts_cosyvoice", TTS_COSYVOICE_PATH
)
tts_cosyvoice = importlib.util.module_from_spec(TTS_COSYVOICE_SPEC)
assert TTS_COSYVOICE_SPEC and TTS_COSYVOICE_SPEC.loader
_previous_common_module = sys.modules.get("common")
sys.modules["common"] = common
try:
    TTS_COSYVOICE_SPEC.loader.exec_module(tts_cosyvoice)
finally:
    if _previous_common_module is None:
        sys.modules.pop("common", None)
    else:
        sys.modules["common"] = _previous_common_module


class FakeWebSocket:
    def __init__(self):
        self.messages = []

    async def send(self, message):
        self.messages.append(message)

    def json_messages(self):
        return [json.loads(message) for message in self.messages if isinstance(message, str)]


class ControlledLoop:
    def __init__(self, futures):
        self.futures = iter(futures)

    def run_in_executor(self, *_args):
        return next(self.futures)


class BlockingPcmWebSocket(FakeWebSocket):
    def __init__(self):
        super().__init__()
        self.pcm_entered = asyncio.Event()
        self.pcm_release = asyncio.Event()
        self.pcm_attempts = 0

    async def send(self, message):
        if isinstance(message, bytes):
            self.pcm_attempts += 1
            self.pcm_entered.set()
            await self.pcm_release.wait()
        self.messages.append(message)


class FakeCosyVoiceWebSocket(FakeWebSocket):
    def __init__(self, messages=()):
        super().__init__()
        self.incoming = collections.deque(messages)
        self.ready = asyncio.Event()
        if self.incoming:
            self.ready.set()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    def feed(self, message):
        self.incoming.append(message)
        self.ready.set()

    async def recv(self):
        while not self.incoming:
            self.ready.clear()
            await self.ready.wait()
        message = self.incoming.popleft()
        if not self.incoming:
            self.ready.clear()
        return message


class FakeCosyVoiceConnector:
    def __init__(self, messages=()):
        self.websocket = FakeCosyVoiceWebSocket(messages)
        self.calls = []

    def __call__(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.websocket


def cosyvoice_event(event, *, usage=None, error_message=None):
    header = {"event": event}
    if error_message is not None:
        header["error_message"] = error_message
    payload = {}
    if usage is not None:
        payload["usage"] = usage
    return json.dumps({"header": header, "payload": payload})


class CosyVoiceStreamingAdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.original_api_key = tts_cosyvoice._api_key
        self.original_voice = tts_cosyvoice._voice
        self.original_model = tts_cosyvoice._model
        tts_cosyvoice._api_key = "test-api-key"
        tts_cosyvoice._voice = "cosyvoice-test-voice"
        tts_cosyvoice._model = "cosyvoice-v3.5-flash"

    def tearDown(self):
        tts_cosyvoice._api_key = self.original_api_key
        tts_cosyvoice._voice = self.original_voice
        tts_cosyvoice._model = self.original_model

    def stream(self, connector):
        return tts_cosyvoice._synthesize_pcm_stream(
            "测试文本。",
            instruction="温柔一点。",
            rate=0.96,
            pitch=None,
            volume=None,
            connector=connector,
        )

    async def test_requests_pcm24k_with_bounded_receive_queue_and_yields_before_finish(self):
        connector = FakeCosyVoiceConnector(
            [
                cosyvoice_event("task-started"),
                b"\x01\x00" * common.MANAGED_AUDIO_CHUNK_MAX_SAMPLES,
            ]
        )
        stream = self.stream(connector)

        first = await anext(stream)
        self.assertEqual(
            first,
            {
                "type": "audio",
                "pcm": b"\x01\x00" * common.MANAGED_AUDIO_CHUNK_MAX_SAMPLES,
            },
        )
        self.assertEqual(len(connector.calls), 1)
        _, connect_kwargs = connector.calls[0]
        self.assertEqual(connect_kwargs["max_queue"], 2)

        sent = connector.websocket.json_messages()
        self.assertEqual(
            [message["header"]["action"] for message in sent],
            ["run-task", "continue-task", "finish-task"],
        )
        parameters = sent[0]["payload"]["parameters"]
        self.assertEqual(parameters["format"], "pcm")
        self.assertEqual(parameters["sample_rate"], 24000)

        connector.websocket.feed(
            cosyvoice_event("result-generated", usage={"characters": 12})
        )
        connector.websocket.feed(cosyvoice_event("task-finished"))
        done = await anext(stream)
        self.assertEqual(
            done,
            {"type": "done", "characters": 12, "provider": "CosyVoice"},
        )
        with self.assertRaises(StopAsyncIteration):
            await anext(stream)

    async def test_reassembles_odd_provider_boundaries_and_caps_output_chunks(self):
        provider_pcm = b"\x01" + b"\x02" + (b"\x03" * 3840)
        connector = FakeCosyVoiceConnector(
            [
                cosyvoice_event("task-started"),
                provider_pcm[:1],
                provider_pcm[1:],
                cosyvoice_event("task-finished", usage={"characters": 7}),
            ]
        )

        events = [event async for event in self.stream(connector)]
        audio = [event["pcm"] for event in events if event["type"] == "audio"]

        self.assertEqual(b"".join(audio), provider_pcm)
        self.assertEqual([len(chunk) // 2 for chunk in audio], [1920, 1])
        self.assertTrue(
            all(len(chunk) // 2 <= common.MANAGED_AUDIO_CHUNK_MAX_SAMPLES for chunk in audio)
        )
        self.assertEqual(
            events[-1],
            {"type": "done", "characters": 7, "provider": "CosyVoice"},
        )

    async def test_task_failed_is_terminal(self):
        connector = FakeCosyVoiceConnector(
            [
                cosyvoice_event("task-started"),
                cosyvoice_event("task-failed", error_message="provider detail"),
            ]
        )

        with self.assertRaisesRegex(RuntimeError, "streaming task failed"):
            [event async for event in self.stream(connector)]

    async def test_partial_pcm_sample_at_finish_is_rejected(self):
        connector = FakeCosyVoiceConnector(
            [
                cosyvoice_event("task-started"),
                b"\x01\x02\x03",
                cosyvoice_event("task-finished"),
            ]
        )

        with self.assertRaisesRegex(RuntimeError, "partial PCM sample"):
            [event async for event in self.stream(connector)]

    async def test_pcm_over_sixty_seconds_is_rejected_before_any_done_event(self):
        connector = FakeCosyVoiceConnector(
            [
                cosyvoice_event("task-started"),
                b"\x00\x00" * (common.TTS_SENTENCE_MAX_SAMPLES + 1),
            ]
        )

        events = []
        with self.assertRaisesRegex(RuntimeError, "sentence limit"):
            async for event in self.stream(connector):
                events.append(event)
        self.assertFalse(any(event["type"] == "done" for event in events))


class GenerationCancelScopeTests(unittest.IsolatedAsyncioTestCase):
    async def test_scope_lifecycle_and_monotonic_session_generations(self):
        scope = common.GenerationCancelScope(7, "asr")
        self.assertTrue(scope.active)
        scope.promote("response")
        self.assertEqual(scope.stage, "response")
        self.assertFalse(scope.inactive.is_set())
        scope.cancel("turn_detected")
        self.assertTrue(scope.inactive.is_set())
        scope.complete()
        scope.promote("pcm")
        self.assertFalse(scope.active)
        self.assertEqual(scope.state, "cancelled")
        self.assertEqual(scope.reason, "turn_detected")
        self.assertEqual(scope.stage, "response")

        session = common.Session(FakeWebSocket())
        first = session._new_scope("asr")
        second = session._new_scope("asr")
        self.assertEqual(second.generation, first.generation + 1)


class TextProviderAdapterTests(unittest.TestCase):
    def setUp(self):
        self.original_proxy_base = os.environ.get("KXYY_AI_PROXY_BASE")
        self.original_tts_secret = os.environ.get("KXYY_TTS_SECRET")
        self.original_load_settings = common.load_settings
        self.original_urlopen = common.urllib.request.urlopen
        os.environ["KXYY_AI_PROXY_BASE"] = "http://127.0.0.1:54321"
        os.environ["KXYY_TTS_SECRET"] = "managed-test-secret"

    def tearDown(self):
        if self.original_proxy_base is None:
            os.environ.pop("KXYY_AI_PROXY_BASE", None)
        else:
            os.environ["KXYY_AI_PROXY_BASE"] = self.original_proxy_base
        if self.original_tts_secret is None:
            os.environ.pop("KXYY_TTS_SECRET", None)
        else:
            os.environ["KXYY_TTS_SECRET"] = self.original_tts_secret
        common.load_settings = self.original_load_settings
        common.urllib.request.urlopen = self.original_urlopen

    def test_proxy_request_leaves_provider_model_and_keys_to_rust(self):
        payload = common.build_llm_proxy_payload(
            "角色设定",
            [{"role": "assistant", "content": "上一轮"}],
            "这一轮",
        )

        self.assertEqual(payload["provider"], "text")
        self.assertFalse("model" in payload)
        self.assertFalse("apiKey" in payload)
        self.assertFalse("thinking" in payload)
        self.assertFalse("temperature" in payload)
        self.assertTrue(payload["stream"])
        self.assertEqual(payload["messages"][-1]["content"], "这一轮")

    def test_llm_stream_uses_loopback_proxy_and_parses_deltas_and_usage(self):
        captured = {}

        class FakeResponse:
            headers = {
                "X-Kxyy-Text-Provider": "Ollama",
                "X-Kxyy-Thinking": "0",
            }
            lines = [
                b'data: {"choices":[{"delta":{"content":"\xe6\x9c\xac\xe5\x9c\xb0"}}]}\n',
                b'data: {"choices":[{"delta":{"content":"\xe5\x9b\x9e\xe5\xa4\x8d"}}]}\n',
                b'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}\n',
                b"data: [DONE]\n",
            ]

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def __iter__(self):
                return iter(self.lines)

        def fake_urlopen(request, *, timeout):
            captured["url"] = request.full_url
            captured["headers"] = dict(request.header_items())
            captured["payload"] = json.loads(request.data.decode("utf-8"))
            captured["timeout"] = timeout
            return FakeResponse()

        common.load_settings = lambda: (_ for _ in ()).throw(
            AssertionError("LLM adapter must not read settings.json")
        )
        common.urllib.request.urlopen = fake_urlopen

        events = list(common.iter_llm_stream("角色设定", [], "用户内容"))

        self.assertEqual([event["type"] for event in events], ["meta", "delta", "delta", "usage"])
        self.assertEqual("".join(e["text"] for e in events if e["type"] == "delta"), "本地回复")
        self.assertEqual(events[-1]["total"], 14)
        self.assertEqual(events[0]["provider"], "Ollama")
        self.assertEqual(captured["url"], "http://127.0.0.1:54321/api/chat")
        self.assertEqual(captured["payload"]["provider"], "text")
        self.assertNotIn("Authorization", captured["headers"])
        self.assertEqual(captured["headers"]["X-kxyy-internal-secret"], "managed-test-secret")
        self.assertEqual(captured["timeout"], 120)

    def test_reasoning_is_never_emitted_when_enabled(self):
        class FakeResponse:
            headers = {"X-Kxyy-Text-Provider": "DeepSeek", "X-Kxyy-Thinking": "1"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def __iter__(self):
                return iter(
                    [
                        b'data: {"choices":[{"delta":{"reasoning_content":"private"}}]}\n',
                        b'data: {"choices":[{"delta":{"content":"answer"}}]}\n',
                        b"data: [DONE]\n",
                    ]
                )

        common.urllib.request.urlopen = lambda *_args, **_kwargs: FakeResponse()
        events = list(common.iter_llm_stream("role", [], "user"))
        self.assertEqual(
            [event.get("text") for event in events if event["type"] == "delta"],
            ["answer"],
        )

    def test_reasoning_fallback_waits_for_end_and_only_when_content_is_empty(self):
        class FakeResponse:
            headers = {"X-Kxyy-Text-Provider": "Ollama", "X-Kxyy-Thinking": "0"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def __iter__(self):
                return iter(
                    [
                        b'data: {"choices":[{"delta":{"reasoning_content":"fallback "}}]}\n',
                        b'data: {"choices":[{"delta":{"reasoning":"reply"}}]}\n',
                    ]
                )

        common.urllib.request.urlopen = lambda *_args, **_kwargs: FakeResponse()
        events = list(common.iter_llm_stream("role", [], "user"))
        self.assertEqual(events[-1], {"type": "delta", "text": "fallback reply"})

    def test_disabled_thinking_discards_buffered_reasoning_when_content_arrives(self):
        class FakeResponse:
            headers = {"X-Kxyy-Text-Provider": "Ollama", "X-Kxyy-Thinking": "0"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def __iter__(self):
                return iter(
                    [
                        b'data: {"choices":[{"delta":{"reasoning_content":"private"}}]}\n',
                        b'data: {"choices":[{"delta":{"content":"public"}}]}\n',
                    ]
                )

        common.urllib.request.urlopen = lambda *_args, **_kwargs: FakeResponse()
        events = list(common.iter_llm_stream("role", [], "user"))
        self.assertEqual(
            [event.get("text") for event in events if event["type"] == "delta"],
            ["public"],
        )

    def test_proxy_url_rejects_non_loopback_destination(self):
        os.environ["KXYY_AI_PROXY_BASE"] = "https://example.com"
        with self.assertRaisesRegex(RuntimeError, "本地文字代理未就绪"):
            common._ai_proxy_chat_url()

        os.environ["KXYY_AI_PROXY_BASE"] = "http://127.0.0.1:not-a-port"
        with self.assertRaisesRegex(RuntimeError, "本地文字代理未就绪"):
            common._ai_proxy_chat_url()

    def test_proxy_error_uses_safe_message_without_detail(self):
        body = json.dumps(
            {"error": "未配置 DeepSeek API Key", "detail": "不得回显的完整请求内容"}
        ).encode("utf-8")

        def fake_urlopen(request, *, timeout):
            raise urllib.error.HTTPError(
                request.full_url,
                401,
                "Unauthorized",
                {},
                io.BytesIO(body),
            )

        common.urllib.request.urlopen = fake_urlopen
        with self.assertRaisesRegex(RuntimeError, "文字模型鉴权失败") as raised:
            list(common.iter_llm_stream("角色设定", [], "用户内容"))
        self.assertNotIn("完整请求内容", str(raised.exception))


class StableSentenceBufferTests(unittest.TestCase):
    def test_cross_delta_and_chinese_english_boundaries(self):
        buf = common.StableSentenceBuffer()
        self.assertEqual(buf.feed("这是跨越"), [])
        self.assertEqual(buf.feed("增量的一句。Next one!"), ["这是跨越增量的一句。", "Next one!"])

    def test_long_sentence_prefers_comma_then_hard_splits(self):
        buf = common.StableSentenceBuffer(soft_chars=12, hard_chars=18)
        self.assertEqual(buf.feed("一二三四五六，七八九十甲乙"), ["一二三四五六，"])
        self.assertLessEqual(buf.buffered_chars, 18)

        no_punctuation = common.StableSentenceBuffer(soft_chars=12, hard_chars=18)
        self.assertEqual(no_punctuation.feed("甲" * 18), ["甲" * 12])
        self.assertEqual(no_punctuation.buffered_chars, 6)
        self.assertEqual(no_punctuation.flush(), ["甲" * 6])

        late_period = common.StableSentenceBuffer(soft_chars=12, hard_chars=18)
        parts = late_period.feed("甲" * 18 + "。")
        self.assertEqual(parts, ["甲" * 12, "甲" * 6 + "。"])
        self.assertLessEqual(max(map(len, parts)), 18)
        self.assertTrue(all(any(char.isalnum() for char in part) for part in parts))
        self.assertEqual(late_period.flush(), [])

    def test_flush_and_cancel_are_terminal(self):
        buf = common.StableSentenceBuffer()
        buf.feed("短尾巴")
        self.assertEqual(buf.flush(), ["短尾巴"])
        self.assertEqual(buf.flush(), [])
        buf.feed("不会留下")
        buf.cancel()
        self.assertEqual(buf.feed("也不会新增。"), [])
        self.assertEqual(buf.flush(), [])


class ManagedAudioEnvelopeTests(unittest.TestCase):
    def test_frame_has_fixed_big_endian_identity_and_pcm16le_payload(self):
        pcm = struct.pack("<hhh", -1, 2, 300)
        frame = common.pack_managed_audio_frame(
            pcm,
            generation=0x01020304,
            segment_id=7,
            chunk_sequence=9,
        )
        header = common.MANAGED_AUDIO_HEADER.unpack(
            frame[: common.MANAGED_AUDIO_HEADER_BYTES]
        )

        self.assertEqual(
            header,
            (
                b"KXAU",
                1,
                0,
                24,
                0x01020304,
                7,
                9,
                3,
            ),
        )
        self.assertEqual(frame[common.MANAGED_AUDIO_HEADER_BYTES :], pcm)

    def test_frame_rejects_invalid_payload_and_ids(self):
        valid = {"generation": 1, "segment_id": 1, "chunk_sequence": 0}
        cases = [
            (b"", valid),
            (b"\x00", valid),
            (b"\x00\x00" * (common.MANAGED_AUDIO_CHUNK_MAX_SAMPLES + 1), valid),
            (b"\x00\x00", {**valid, "generation": -1}),
            (b"\x00\x00", {**valid, "segment_id": 0}),
            (
                b"\x00\x00",
                {
                    **valid,
                    "chunk_sequence": common.MANAGED_AUDIO_CHUNKS_PER_SEGMENT_MAX,
                },
            ),
        ]
        for pcm, kwargs in cases:
            with self.subTest(pcm_bytes=len(pcm), kwargs=kwargs):
                with self.assertRaises(ValueError):
                    common.pack_managed_audio_frame(pcm, **kwargs)


class AudibleHistoryTests(unittest.TestCase):
    def test_only_contiguous_completed_segments_enter_context(self):
        history = common.AudibleHistory(max_messages=6, max_pending_turns=2)
        self.assertEqual(history.begin_turn(1, "第一问"), [])
        self.assertTrue(history.add_segment(1, 1, "第一句。"))
        self.assertTrue(history.add_segment(1, 2, "第二句。"))

        history.acknowledge(1, 2, "completed")
        self.assertEqual(history.messages, [{"role": "user", "content": "第一问"}])
        history.acknowledge(1, 1, "completed")
        self.assertEqual(
            history.messages,
            [
                {"role": "user", "content": "第一问"},
                {"role": "assistant", "content": "第一句。第二句。"},
            ],
        )
        snapshot = history.begin_turn(2, "第二问")
        self.assertEqual(snapshot[-1]["content"], "第一句。第二句。")

    def test_unknown_receipts_and_ledgers_are_bounded(self):
        history = common.AudibleHistory(max_messages=4, max_pending_turns=2)
        for generation in range(1, 5):
            history.begin_turn(generation, f"问题{generation}")
        self.assertLessEqual(len(history.messages), 4)
        self.assertLessEqual(len(history._turns), 2)
        self.assertFalse(history.acknowledge(1, 1, "completed"))

    def test_cancelled_turn_rejects_late_segment_receipt(self):
        history = common.AudibleHistory()
        history.begin_turn(1, "用户输入")
        history.add_segment(1, 1, "不应越代写入。")
        history.cancel_turn(1)

        self.assertFalse(history.acknowledge(1, 1, "completed"))
        self.assertEqual(
            history.messages,
            [{"role": "user", "content": "用户输入"}],
        )

    def test_full_history_never_leaves_orphan_assistant_at_front(self):
        history = common.AudibleHistory(max_messages=4)
        for generation in (1, 2):
            history.begin_turn(generation, f"问题{generation}")
            history.add_segment(generation, 1, f"回答{generation}")
            history.acknowledge(generation, 1, "completed")
        history.begin_turn(3, "被打断的问题")
        history.cancel_turn(3)

        snapshot = history.begin_turn(4, "下一问")
        self.assertTrue(snapshot)
        self.assertEqual(snapshot[0]["role"], "user")
        self.assertLessEqual(len(snapshot), 4)


class BoundedLlmProducerTests(unittest.TestCase):
    def test_cancel_unblocks_full_event_queue(self):
        original_iter = common.iter_llm_stream
        scope = common.GenerationCancelScope(1, "response")
        events = queue.Queue(maxsize=1)
        events.put({"type": "occupied"})
        common.iter_llm_stream = lambda *_args: iter([{"type": "delta", "text": "late"}])
        try:
            thread = common.start_llm_stream_producer("role", [], "user", scope, events)
            self.assertIsNotNone(thread)
            scope.cancel("test")
            thread.join(timeout=1)
            self.assertFalse(thread.is_alive())
        finally:
            common.iter_llm_stream = original_iter

    def test_producer_slots_are_bounded_and_unknown_errors_are_sanitized(self):
        original_iter = common.iter_llm_stream
        common._llm_stream_slots = threading.BoundedSemaphore(
            common.LLM_STREAM_MAX_PRODUCERS
        )
        release = threading.Event()

        def blocking_iter(*_args):
            release.wait(timeout=1)
            return
            yield  # pragma: no cover - keeps this a generator

        common.iter_llm_stream = blocking_iter
        scopes = [common.GenerationCancelScope(i, "response") for i in (1, 2, 3)]
        queues = [queue.Queue(maxsize=4) for _ in scopes]
        threads = []
        try:
            threads.append(
                common.start_llm_stream_producer("role", [], "user", scopes[0], queues[0])
            )
            threads.append(
                common.start_llm_stream_producer("role", [], "user", scopes[1], queues[1])
            )
            third = common.start_llm_stream_producer(
                "role", [], "user", scopes[2], queues[2]
            )
            self.assertIsNone(third)
            self.assertIn("上一轮请求", queues[2].get_nowait()["message"])
        finally:
            scopes[0].cancel("test")
            scopes[1].cancel("test")
            release.set()
            for thread in threads:
                thread.join(timeout=1)
            common.iter_llm_stream = original_iter

        common._llm_stream_slots = threading.BoundedSemaphore(
            common.LLM_STREAM_MAX_PRODUCERS
        )
        common.iter_llm_stream = lambda *_args: (_ for _ in ()).throw(
            ValueError("raw upstream secret and full text")
        )
        scope = common.GenerationCancelScope(4, "response")
        events = queue.Queue(maxsize=4)
        try:
            thread = common.start_llm_stream_producer("role", [], "user", scope, events)
            thread.join(timeout=1)
            error = events.get_nowait()
            self.assertEqual(error["type"], "error")
            self.assertEqual(error["message"], "文字模型流式响应失败，请稍后重试")
            self.assertNotIn("secret", error["message"])
        finally:
            common.iter_llm_stream = original_iter


class HttpTtsAdmissionTests(unittest.TestCase):
    class ManualFuture:
        def __init__(self):
            self.callbacks = []
            self.finished = False

        def add_done_callback(self, callback):
            self.callbacks.append(callback)

        def result(self, timeout=None):
            if not self.finished:
                raise TimeoutError(f"not finished after {timeout}")
            return None

        def finish(self):
            self.finished = True
            callbacks, self.callbacks = self.callbacks, []
            for callback in callbacks:
                callback(self)

    class ManualPool:
        def __init__(self):
            self.futures = []
            self.fail_submit = False

        def submit(self, _synth, _text):
            if self.fail_submit:
                raise RuntimeError("fixed submit failure")
            future = HttpTtsAdmissionTests.ManualFuture()
            self.futures.append(future)
            return future

    def test_full_admission_rejects_until_actual_future_completion(self):
        slots = threading.BoundedSemaphore(2)
        pool = self.ManualPool()

        first = common._submit_bounded_http_tts(pool, object(), "first", slots=slots)
        second = common._submit_bounded_http_tts(pool, object(), "second", slots=slots)
        self.assertIsNotNone(first)
        self.assertIsNotNone(second)
        self.assertIsNone(
            common._submit_bounded_http_tts(pool, object(), "full", slots=slots)
        )

        # 模拟 HTTP 等待已经 timeout：future 还没完成，所以不得提前释放 admission。
        with self.assertRaises(TimeoutError):
            first.result(timeout=0)
        self.assertIsNone(
            common._submit_bounded_http_tts(pool, object(), "still-full", slots=slots)
        )
        first.finish()
        accepted = common._submit_bounded_http_tts(
            pool, object(), "after-completion", slots=slots
        )
        self.assertIsNotNone(accepted)
        self.assertEqual(len(pool.futures), 3)

    def test_submit_failure_releases_admission_immediately(self):
        slots = threading.BoundedSemaphore(1)
        pool = self.ManualPool()
        pool.fail_submit = True

        with self.assertRaisesRegex(RuntimeError, "fixed submit failure"):
            common._submit_bounded_http_tts(pool, object(), "private text", slots=slots)

        pool.fail_submit = False
        self.assertIsNotNone(
            common._submit_bounded_http_tts(pool, object(), "retry", slots=slots)
        )

    def test_busy_response_is_fixed_and_contains_no_request_content(self):
        self.assertEqual(common.HTTP_TTS_MAX_TASKS, 2)
        self.assertEqual(common.HTTP_TTS_BUSY_MESSAGE, "TTS 服务繁忙，请稍后重试")
        self.assertNotIn("private text", common.HTTP_TTS_BUSY_MESSAGE)


class BoundedOrderedTtsPipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_out_of_order_synthesis_still_plays_in_submit_order(self):
        gates = {
            1: asyncio.get_running_loop().create_future(),
            2: asyncio.get_running_loop().create_future(),
        }
        synth_started = []
        played = []
        active_play = 0
        max_active_play = 0

        async def synthesize(sequence, sentence):
            synth_started.append(sequence)
            return await gates[sequence]

        async def play(sequence, sentence, result):
            nonlocal active_play, max_active_play
            active_play += 1
            max_active_play = max(max_active_play, active_play)
            played.append((sequence, sentence, result))
            await asyncio.sleep(0)
            active_play -= 1

        pipeline = common.BoundedOrderedTtsPipeline(
            synthesize,
            play,
            parallelism=2,
        )
        await pipeline.submit("第一句。")
        await pipeline.submit("第二句。")
        finish = asyncio.create_task(pipeline.finish())
        for _ in range(10):
            if synth_started == [1, 2]:
                break
            await asyncio.sleep(0)
        self.assertEqual(synth_started, [1, 2])

        gates[2].set_result("audio-2")
        await asyncio.sleep(0)
        self.assertEqual(played, [])
        gates[1].set_result("audio-1")
        await finish

        self.assertEqual(
            played,
            [(1, "第一句。", "audio-1"), (2, "第二句。", "audio-2")],
        )
        self.assertEqual(max_active_play, 1)

    async def test_playback_overlaps_next_synthesis_and_queue_backpressures(self):
        first_synth = asyncio.Event()
        release_first_synth = asyncio.Event()
        first_play = asyncio.Event()
        release_first_play = asyncio.Event()
        second_synth = asyncio.Event()

        async def synthesize(sequence, _sentence):
            if sequence == 1:
                first_synth.set()
                await release_first_synth.wait()
            elif sequence == 2:
                second_synth.set()
            return sequence

        async def play(sequence, _sentence, _result):
            if sequence == 1:
                first_play.set()
                await release_first_play.wait()

        pipeline = common.BoundedOrderedTtsPipeline(
            synthesize,
            play,
            parallelism=1,
            queue_max=2,
        )
        await pipeline.submit("一")
        await first_synth.wait()
        await pipeline.submit("二")
        await pipeline.submit("三")
        blocked = asyncio.create_task(pipeline.submit("四"))
        await asyncio.sleep(0)
        self.assertFalse(blocked.done())
        self.assertLessEqual(pipeline.queue.qsize(), 2)

        release_first_synth.set()
        await first_play.wait()
        await asyncio.wait_for(second_synth.wait(), timeout=1)
        await asyncio.wait_for(blocked, timeout=1)
        release_first_play.set()
        await pipeline.finish()

    async def test_shared_asr_executor_backend_does_not_prefetch_during_playback(self):
        release_first_synth = asyncio.Event()
        first_play = asyncio.Event()
        release_first_play = asyncio.Event()
        second_synth = asyncio.Event()

        async def synthesize(sequence, _sentence):
            if sequence == 1:
                await release_first_synth.wait()
            else:
                second_synth.set()
            return sequence

        async def play(sequence, _sentence, _result):
            if sequence == 1:
                first_play.set()
                await release_first_play.wait()

        pipeline = common.BoundedOrderedTtsPipeline(
            synthesize,
            play,
            parallelism=1,
            prefetch_while_playing=False,
        )
        await pipeline.submit("一")
        await pipeline.submit("二")
        finish = asyncio.create_task(pipeline.finish())
        release_first_synth.set()
        await first_play.wait()
        await asyncio.sleep(0)
        self.assertFalse(second_synth.is_set())

        release_first_play.set()
        await asyncio.wait_for(second_synth.wait(), timeout=1)
        await finish

    async def test_cancel_stops_pending_playback_and_unblocks_submit(self):
        synth_gate = asyncio.Event()
        played = []

        async def synthesize(sequence, _sentence):
            await synth_gate.wait()
            return sequence

        async def play(sequence, _sentence, _result):
            played.append(sequence)

        pipeline = common.BoundedOrderedTtsPipeline(
            synthesize,
            play,
            parallelism=1,
            queue_max=1,
        )
        await pipeline.submit("一")
        await asyncio.sleep(0)
        await pipeline.submit("二")
        blocked = asyncio.create_task(pipeline.submit("三"))
        await asyncio.sleep(0)
        self.assertFalse(blocked.done())

        await pipeline.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await blocked
        synth_gate.set()
        await asyncio.sleep(0)
        self.assertEqual(played, [])
        self.assertTrue(pipeline.runner.done())

    async def test_synthesis_failure_propagates_and_cancels_remaining_work(self):
        second_started = asyncio.Event()
        second_cancelled = asyncio.Event()

        async def synthesize(sequence, _sentence):
            if sequence == 1:
                await second_started.wait()
                raise common.SafeRealtimeError("fixed safe error")
            try:
                second_started.set()
                await asyncio.Future()
            except asyncio.CancelledError:
                second_cancelled.set()
                raise

        async def play(_sequence, _sentence, _result):
            self.fail("failed synthesis must not play")

        pipeline = common.BoundedOrderedTtsPipeline(
            synthesize,
            play,
            parallelism=2,
        )
        await pipeline.submit("一")
        await pipeline.submit("二")
        with self.assertRaisesRegex(common.SafeRealtimeError, "fixed safe error"):
            await pipeline.finish()
        self.assertTrue(second_cancelled.is_set())

    async def test_segment_limit_rejects_without_growing_the_queue(self):
        played = []

        async def synthesize(sequence, _sentence):
            return sequence

        async def play(sequence, _sentence, _result):
            played.append(sequence)

        pipeline = common.BoundedOrderedTtsPipeline(
            synthesize,
            play,
            max_segments=2,
        )
        await pipeline.submit("一")
        await pipeline.submit("二")
        with self.assertRaisesRegex(common.SafeRealtimeError, "句段过多"):
            await pipeline.submit("三")
        self.assertLessEqual(pipeline.queue.qsize(), 2)
        await pipeline.finish()
        self.assertEqual(played, [1, 2])


class SoftEndpointTests(unittest.TestCase):
    def test_soft_end_reopens_before_deterministic_commit(self):
        endpoint = common.SoftEndpoint()
        events = []

        for _ in range(common.SOFT_END_MS // common.FRAME_MS):
            event = endpoint.observe(False, eligible=True)
            if event:
                events.append(event)
        for _ in range((900 - common.SOFT_END_MS) // common.FRAME_MS):
            event = endpoint.observe(False, eligible=True)
            if event:
                events.append(event)
        events.append(endpoint.observe(True, eligible=True))

        for _ in range(common.ENDPOINT_COMMIT_MS // common.FRAME_MS):
            event = endpoint.observe(False, eligible=True)
            if event:
                events.append(event)

        self.assertEqual(
            [event for event in events if event],
            ["soft_end", "reopened", "soft_end", "committed"],
        )


class InMemoryAsrTests(unittest.TestCase):
    class FakeArray(list):
        def astype(self, _dtype):
            return self

        def __truediv__(self, denominator):
            return self.__class__(value / denominator for value in self)

    def setUp(self):
        self.original_numpy = sys.modules.get("numpy")
        self.original_mlx = sys.modules.get("mlx_whisper")
        self.original_backend = common._asr_backend
        self.original_openai_model = common._openai_whisper_model

        fake_numpy = types.SimpleNamespace(
            float32="float32",
            frombuffer=lambda data, dtype: self.FakeArray(
                value[0] for value in struct.iter_unpack("<h", bytes(data))
            ),
        )
        sys.modules["numpy"] = fake_numpy

    def tearDown(self):
        if self.original_numpy is None:
            sys.modules.pop("numpy", None)
        else:
            sys.modules["numpy"] = self.original_numpy
        if self.original_mlx is None:
            sys.modules.pop("mlx_whisper", None)
        else:
            sys.modules["mlx_whisper"] = self.original_mlx
        common._asr_backend = self.original_backend
        common._openai_whisper_model = self.original_openai_model

    def test_mlx_receives_normalized_memory_audio_without_path(self):
        captured = {}

        def fake_transcribe(audio, **kwargs):
            captured["audio"] = audio
            captured["kwargs"] = kwargs
            return {
                "text": " 内存识别 ",
                "segments": [{"no_speech_prob": 0.2}],
            }

        sys.modules["mlx_whisper"] = types.SimpleNamespace(transcribe=fake_transcribe)
        common._asr_backend = "mlx"
        pcm = struct.pack("<hhh", -32768, 0, 32767) + b"\xff"

        text, no_speech_prob = common.transcribe(pcm)

        self.assertEqual(text, "内存识别")
        self.assertEqual(no_speech_prob, 0.2)
        self.assertFalse(isinstance(captured["audio"], (str, Path)))
        self.assertEqual(len(captured["audio"]), 3)
        self.assertAlmostEqual(captured["audio"][0], -1.0)
        self.assertAlmostEqual(captured["audio"][2], 32767 / 32768)
        self.assertEqual(captured["kwargs"]["language"], "zh")

    def test_openai_receives_the_same_memory_audio_contract(self):
        captured = {}

        class FakeModel:
            def transcribe(self, audio, **kwargs):
                captured["audio"] = audio
                captured["kwargs"] = kwargs
                return {
                    "text": "本地数组",
                    "segments": [
                        {"no_speech_prob": 0.1},
                        {"no_speech_prob": 0.3},
                    ],
                }

        common._asr_backend = "openai"
        common._openai_whisper_model = FakeModel()

        text, no_speech_prob = common.transcribe(struct.pack("<hh", 1000, -1000))

        self.assertEqual(text, "本地数组")
        self.assertAlmostEqual(no_speech_prob, 0.2)
        self.assertFalse(isinstance(captured["audio"], (str, Path)))
        self.assertEqual(captured["kwargs"]["initial_prompt"], common.WHISPER_PROMPT)


class RealtimePcmReplayTests(unittest.IsolatedAsyncioTestCase):
    async def test_fixed_synthetic_pcm_matrix(self):
        fixture = json.loads(PCM_REPLAY_PATH.read_text(encoding="utf-8"))
        self.assertEqual(fixture["schemaVersion"], 1)
        self.assertEqual(fixture["sampleRate"], common.INPUT_RATE)
        self.assertEqual(fixture["frameMs"], common.FRAME_MS)

        for scenario in fixture["scenarios"]:
            with self.subTest(scenario=scenario["id"]):
                ws = FakeWebSocket()
                session = common.Session(ws)
                commits = []

                async def capture_utterance(pcm, *, from_play_barge=False):
                    commits.append(
                        {
                            "bytes": len(pcm),
                            "fromPlayBarge": from_play_barge,
                        }
                    )
                    await session._emit_speech_rejected()

                session._handle_utterance = capture_utterance
                if scenario["mode"] == "playback":
                    session.playing = True
                    session.play_enabled = True

                for segment in scenario["segments"]:
                    amplitude = fixture["levels"][segment["level"]]
                    frame = struct.pack("<h", amplitude) * common.FRAME_SAMPLES
                    for _ in range(segment["frames"]):
                        await session._on_frame(frame)

                types = [message["type"] for message in ws.json_messages()]
                endpoint_types = [
                    event_type for event_type in types if event_type.startswith("endpoint_")
                ]
                expected = scenario["expect"]
                self.assertEqual(
                    types.count("speech_candidate"),
                    expected["candidateCount"],
                )
                self.assertEqual(len(commits), expected["commitCount"])
                self.assertEqual(endpoint_types, expected["endpointEvents"])


class LocalRealtimeEventTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.ws = FakeWebSocket()
        self.session = common.Session(self.ws)
        self.original_synth_tts = common._synth_tts
        self.original_synth_tts_stream = common._synth_tts_stream
        self.original_start_llm_stream = common.start_llm_stream_producer
        self.stream_events = []

        def fake_start(_role, _history, _text, _scope, out):
            for event in self.stream_events:
                out.put_nowait(dict(event))
            return None

        common.start_llm_stream_producer = fake_start
        common._tts_stream_slots = threading.BoundedSemaphore(common.TTS_STREAM_MAX_TASKS)

    async def asyncTearDown(self):
        if self.session.reply_task:
            await self.session.reply_task
        common._synth_tts = self.original_synth_tts
        common._synth_tts_stream = self.original_synth_tts_stream
        common.start_llm_stream_producer = self.original_start_llm_stream

    async def test_playback_voice_threshold_emits_one_candidate(self):
        self.session.playing = True
        self.session.play_enabled = True
        frame = struct.pack("<h", 10000) * common.FRAME_SAMPLES

        for _ in range(common.BARGE_IN_FRAMES_PLAY + 3):
            await self.session._on_frame(frame)

        types = [message["type"] for message in self.ws.json_messages()]
        self.assertEqual(types.count("speech_candidate"), 1)
        self.assertTrue(self.session.play_barge_pending)

    async def test_start_negotiates_managed_audio_and_old_client_stays_raw(self):
        async def unused_stream(_text):
            if False:
                yield None

        common._synth_tts_stream = unused_stream
        await self.session.on_start(
            {
                "systemRole": "角色",
                "botName": "元元",
                "downlinkAudio": [common.MANAGED_AUDIO_CAPABILITY],
                "ttsStream": [common.TTS_STREAMING_CAPABILITY],
                "interruptionHint": [common.INTERRUPTION_HINT_CAPABILITY],
            }
        )
        self.assertEqual(self.session.downlink_audio, common.MANAGED_AUDIO_CAPABILITY)
        self.assertEqual(
            self.session.interruption_hint,
            common.INTERRUPTION_HINT_CAPABILITY,
        )
        self.assertEqual(
            self.ws.json_messages()[-1]["downlinkAudio"],
            common.MANAGED_AUDIO_CAPABILITY,
        )
        self.assertEqual(self.session.tts_streaming, common.TTS_STREAMING_CAPABILITY)
        self.assertEqual(
            self.ws.json_messages()[-1]["ttsStream"],
            common.TTS_STREAMING_CAPABILITY,
        )
        self.assertEqual(
            self.ws.json_messages()[-1]["interruptionHint"],
            common.INTERRUPTION_HINT_CAPABILITY,
        )

        old_ws = FakeWebSocket()
        old_session = common.Session(old_ws)
        await old_session.on_start({"systemRole": "角色", "botName": "元元"})
        self.assertEqual(old_session.downlink_audio, "raw")
        self.assertEqual(old_session.tts_streaming, "none")
        self.assertEqual(old_session.interruption_hint, "none")
        self.assertEqual(old_ws.json_messages()[-1]["downlinkAudio"], "raw")
        self.assertEqual(old_ws.json_messages()[-1]["ttsStream"], "none")
        self.assertEqual(old_ws.json_messages()[-1]["interruptionHint"], "none")
        old_scope = old_session._new_scope("response")
        self.assertTrue(
            await old_session.send_downlink_pcm(
                b"\x01\x00",
                scope=old_scope,
                segment_id=1,
                chunk_sequence=0,
            )
        )
        self.assertEqual(old_ws.messages[-1], b"\x01\x00")

        no_adapter = common.Session(FakeWebSocket())
        common._synth_tts_stream = None
        await no_adapter.on_start(
            {
                "downlinkAudio": [common.MANAGED_AUDIO_CAPABILITY],
                "ttsStream": [common.TTS_STREAMING_CAPABILITY],
            }
        )
        self.assertEqual(no_adapter.tts_streaming, "none")

    async def test_candidate_ids_bind_thresholded_one_shot_interruption_receipts(self):
        await self.session.on_start(
            {"interruptionHint": [common.INTERRUPTION_HINT_CAPABILITY]}
        )
        self.session._audible_history.begin_turn(7, "上一轮用户输入")
        self.assertTrue(
            self.session._audible_history.add_segment(7, 1, "未播完的隐藏尾句")
        )

        await self.session._emit_speech_candidate()
        first_id = self.ws.json_messages()[-1]["candidateId"]
        self.session.on_playback_interruption(
            {
                "state": "confirmed",
                "candidateId": first_id,
                "generation": 7,
                "segmentId": 1,
                "playedSamples": common.INTERRUPTION_HINT_MIN_SAMPLES,
            }
        )
        self.assertFalse(self.session._candidate_receipt_event.is_set())
        confirmed_id = await self.session._emit_speech_confirmed()
        self.assertEqual(confirmed_id, first_id)
        self.session.on_playback_interruption(
            {
                "type": "playback_interruption",
                "state": "confirmed",
                "candidateId": first_id,
                "generation": 7,
                "segmentId": 1,
                "playedSamples": common.INTERRUPTION_HINT_MIN_SAMPLES - 1,
            }
        )
        self.assertFalse(await self.session._consume_interruption_hint(first_id))

        await self.session._emit_speech_candidate()
        second_id = self.ws.json_messages()[-1]["candidateId"]
        self.assertEqual(second_id, first_id + 1)
        confirmed_id = await self.session._emit_speech_confirmed()
        self.session.on_playback_interruption(
            {
                "type": "playback_interruption",
                "state": "confirmed",
                "candidateId": second_id,
                "generation": 7,
                "segmentId": 1,
                "playedSamples": common.INTERRUPTION_HINT_MIN_SAMPLES,
            }
        )
        self.session.on_playback_interruption(
            {
                "type": "playback_interruption",
                "state": "confirmed",
                "candidateId": second_id,
                "generation": 7,
                "segmentId": 1,
                "playedSamples": 0,
            }
        )
        self.assertTrue(await self.session._consume_interruption_hint(confirmed_id))
        self.assertFalse(await self.session._consume_interruption_hint(confirmed_id))

        await self.session._emit_speech_candidate()
        rejected_id = self.ws.json_messages()[-1]["candidateId"]
        await self.session._emit_speech_rejected()
        rejected = self.ws.json_messages()[-1]
        self.assertEqual(rejected["candidateId"], rejected_id)
        self.assertIsNone(self.session._candidate_id)

    async def test_interruption_hint_rejects_unknown_completed_and_timeout_receipts(self):
        await self.session.on_start(
            {"interruptionHint": [common.INTERRUPTION_HINT_CAPABILITY]}
        )
        self.session._audible_history.begin_turn(8, "上一轮用户输入")
        self.session._audible_history.add_segment(8, 1, "已经播完")
        self.session._audible_history.acknowledge(8, 1, "completed")
        await self.session._emit_speech_candidate()
        candidate_id = await self.session._emit_speech_confirmed()
        self.session.on_playback_interruption(
            {
                "state": "confirmed",
                "candidateId": candidate_id,
                "generation": 8,
                "segmentId": 1,
                "playedSamples": common.INTERRUPTION_HINT_MIN_SAMPLES,
            }
        )
        original_timeout = common.INTERRUPTION_RECEIPT_WAIT_SECONDS
        common.INTERRUPTION_RECEIPT_WAIT_SECONDS = 0.001
        try:
            self.assertFalse(await self.session._consume_interruption_hint(candidate_id))

            self.session._audible_history.begin_turn(9, "另一轮用户输入")
            self.session._audible_history.add_segment(9, 1, "已取消句段")
            self.session._audible_history.cancel_turn(9)
            await self.session._emit_speech_candidate()
            candidate_id = await self.session._emit_speech_confirmed()
            for payload in (
                {
                    "state": "confirmed",
                    "candidateId": candidate_id + 1,
                    "generation": 9,
                    "segmentId": 1,
                    "playedSamples": common.INTERRUPTION_HINT_MIN_SAMPLES,
                },
                {
                    "state": "confirmed",
                    "candidateId": candidate_id,
                    "generation": 999,
                    "segmentId": 1,
                    "playedSamples": common.INTERRUPTION_HINT_MIN_SAMPLES,
                },
                {
                    "state": "confirmed",
                    "candidateId": candidate_id,
                    "generation": 9,
                    "segmentId": 1,
                    "playedSamples": common.INTERRUPTION_HINT_MIN_SAMPLES,
                },
            ):
                self.session.on_playback_interruption(payload)
            self.assertFalse(self.session._candidate_receipt_event.is_set())
            self.assertFalse(await self.session._consume_interruption_hint(candidate_id))
        finally:
            common.INTERRUPTION_RECEIPT_WAIT_SECONDS = original_timeout

    async def test_interruption_hint_is_transient_and_never_enters_audible_history(self):
        captured_histories = []

        def capture_history(_role, history, _text, _scope, out):
            captured_histories.append([dict(message) for message in history])
            out.put_nowait({"type": "done"})
            return None

        common._synth_tts = lambda _text: b"unused"
        common.start_llm_stream_producer = capture_history
        first_scope = self.session._new_scope("response")
        self.session.response_scope = first_scope
        await self.session._reply_pipeline(
            "第一轮用户输入",
            first_scope,
            interruption_hint=True,
        )
        second_scope = self.session._new_scope("response")
        self.session.response_scope = second_scope
        await self.session._reply_pipeline("第二轮用户输入", second_scope)

        self.assertEqual(
            captured_histories[0],
            [{"role": "system", "content": common.INTERRUPTION_HINT_TEXT}],
        )
        self.assertFalse(
            any(
                message.get("content") == common.INTERRUPTION_HINT_TEXT
                for message in captured_histories[1]
            )
        )
        self.assertFalse(
            any(
                message.get("role") == "system"
                or message.get("content") == common.INTERRUPTION_HINT_TEXT
                for message in self.session.history
            )
        )

    async def test_valid_candidate_is_confirmed_before_asr_payload(self):
        original_transcribe = common.transcribe
        original_validate = common.is_valid_asr
        common.transcribe = lambda _pcm: ("确认插话", 0.01)
        common.is_valid_asr = lambda text, _nsp, _pcm: text

        async def no_reply(_text, _generation):
            return None

        self.session._reply_pipeline = no_reply
        self.session.candidate_emitted = True
        self.session.playing = True
        self.session.play_enabled = True
        scope = self.session._new_scope("asr")
        self.session.asr_scope = scope
        try:
            await self.session._asr_then_maybe_reply(
                b"\x01\x00" * 1000,
                scope,
                from_play_barge=True,
            )
            await asyncio.sleep(0)
        finally:
            common.transcribe = original_transcribe
            common.is_valid_asr = original_validate

        messages = self.ws.json_messages()
        types = [message["type"] for message in messages]
        self.assertEqual(
            types[:4],
            ["speech_confirmed", "asr_start", "asr", "asr_end"],
        )
        self.assertNotIn("error", types)
        self.assertFalse(self.session.candidate_emitted)

    async def test_invalid_candidate_is_rejected_without_user_text(self):
        original_transcribe = common.transcribe
        original_validate = common.is_valid_asr
        common.transcribe = lambda _pcm: ("幻觉文本", 0.9)
        common.is_valid_asr = lambda _text, _nsp, _pcm: None
        self.session.candidate_emitted = True
        scope = self.session._new_scope("asr")
        self.session.asr_scope = scope
        try:
            await self.session._asr_then_maybe_reply(
                b"\x01\x00" * 1000,
                scope,
                from_play_barge=True,
            )
        finally:
            common.transcribe = original_transcribe
            common.is_valid_asr = original_validate

        messages = self.ws.json_messages()
        self.assertEqual(
            messages,
            [
                {
                    "type": "speech_rejected",
                    "reason": "voice_rejected",
                    "generation": scope.generation,
                }
            ],
        )
        self.assertNotIn("幻觉文本", json.dumps(messages, ensure_ascii=False))

    async def test_cancelled_asr_scope_drops_late_result(self):
        future = asyncio.get_running_loop().create_future()
        self.session.loop = ControlledLoop([future])
        self.session.candidate_emitted = True
        scope = self.session._new_scope("asr")
        self.session.asr_scope = scope
        task = asyncio.create_task(
            self.session._asr_then_maybe_reply(b"\x01\x00" * 1000, scope)
        )
        self.session.asr_task = task

        await asyncio.sleep(0)
        scope.cancel("superseded")
        future.set_result(("迟到识别", 0.01))
        await task

        self.assertEqual(self.ws.messages, [])
        self.assertIsNone(self.session.reply_task)
        self.assertIsNone(self.session.asr_scope)

    async def test_cancelled_llm_scope_drops_late_text_and_history(self):
        common._synth_tts = lambda _text: b"unused"
        captured = {}

        def capture_queue(_role, _history, _text, _scope, out):
            captured["events"] = out
            return None

        common.start_llm_stream_producer = capture_queue
        scope = self.session._new_scope("response")
        self.session.response_scope = scope
        task = asyncio.create_task(self.session._reply_pipeline("用户输入", scope))
        self.session.reply_task = task

        await asyncio.sleep(0)
        scope.cancel("turn_detected")
        captured["events"].put_nowait({"type": "delta", "text": "迟到回复"})
        captured["events"].put_nowait({"type": "done"})
        await task

        self.assertEqual(
            self.session.history,
            [{"role": "user", "content": "用户输入"}],
        )
        self.assertEqual(self.ws.messages, [])
        self.assertIsNone(self.session.response_scope)

    async def test_cancelled_tts_scope_drops_late_audio_and_usage(self):
        common._synth_tts = lambda _text: b"unused"
        loop = asyncio.get_running_loop()
        tts_future = loop.create_future()
        self.stream_events = [
            {"type": "meta", "provider": "DeepSeek"},
            {"type": "delta", "text": "先完成的回复。"},
            {"type": "usage", "total": 4},
            {"type": "done"},
        ]
        self.session.loop = ControlledLoop([tts_future])
        scope = self.session._new_scope("response")
        self.session.response_scope = scope
        task = asyncio.create_task(self.session._reply_pipeline("用户输入", scope))
        self.session.reply_task = task

        await asyncio.sleep(0)
        await asyncio.sleep(0)
        scope.cancel("turn_detected")
        tts_future.set_result(b"\x01\x00" * common.OUTPUT_RATE)
        await task

        types = [message["type"] for message in self.ws.json_messages()]
        self.assertEqual(types, ["assistant", "tts_start"])
        self.assertFalse(any(isinstance(message, bytes) for message in self.ws.messages))
        self.assertNotIn("usage", types)
        self.assertNotIn("speaking", types)

    async def test_cancelled_background_tts_failure_is_drained_and_releases_slot(self):
        started = threading.Event()
        release = threading.Event()

        def failing_synth(_text):
            started.set()
            release.wait(timeout=1)
            raise RuntimeError("sensitive backend detail")

        common._synth_tts = failing_synth
        self.stream_events = [
            {"type": "delta", "text": "开始后台合成。"},
            {"type": "done"},
        ]
        scope = self.session._new_scope("response")
        self.session.response_scope = scope
        task = asyncio.create_task(self.session._reply_pipeline("用户输入", scope))
        self.session.reply_task = task
        for _ in range(100):
            if started.is_set():
                break
            await asyncio.sleep(0.01)
        self.assertTrue(started.is_set())

        loop = asyncio.get_running_loop()
        unhandled = []
        old_handler = loop.get_exception_handler()
        loop.set_exception_handler(lambda _loop, context: unhandled.append(context))
        scope.cancel("turn_detected")
        task.cancel()
        release.set()
        try:
            with self.assertRaises(asyncio.CancelledError):
                await task
            first = False
            second = False
            for _ in range(100):
                first = common._tts_stream_slots.acquire(blocking=False)
                if first:
                    second = common._tts_stream_slots.acquire(blocking=False)
                    if second:
                        common._tts_stream_slots.release()
                    common._tts_stream_slots.release()
                    if second:
                        break
                await asyncio.sleep(0.01)
            self.assertTrue(first and second)
            await asyncio.sleep(0)
            self.assertEqual(unhandled, [])
        finally:
            loop.set_exception_handler(old_handler)
            self.session.reply_task = None

    async def test_old_pipeline_cleanup_cannot_clear_new_response_state(self):
        common._synth_tts = lambda _text: b"unused"
        old_scope = self.session._new_scope("response")
        self.session.response_scope = old_scope
        old_task = asyncio.create_task(self.session._reply_pipeline("旧输入", old_scope))
        self.session.reply_task = old_task

        await asyncio.sleep(0)
        old_scope.cancel("turn_detected")
        new_scope = self.session._new_scope("response")
        self.session.response_scope = new_scope
        self.session.playing = True
        self.session.play_enabled = True
        await old_task

        self.assertIs(self.session.response_scope, new_scope)
        self.assertTrue(self.session.playing)
        self.assertTrue(self.session.play_enabled)
        self.assertTrue(new_scope.active)

    async def test_cancelled_scope_allows_only_in_flight_pcm_chunk(self):
        ws = BlockingPcmWebSocket()
        session = common.Session(ws)
        common._synth_tts = lambda _text: b"unused"
        loop = asyncio.get_running_loop()
        tts_future = loop.create_future()
        self.stream_events = [
            {"type": "delta", "text": "可以播放的回复。"},
            {"type": "usage", "total": 2},
            {"type": "done"},
        ]
        audio = b"\x01\x00" * (common.OUTPUT_RATE // 5)
        tts_future.set_result(audio)
        session.loop = ControlledLoop([tts_future])
        session.downlink_audio = common.MANAGED_AUDIO_CAPABILITY
        scope = session._new_scope("response")
        session.response_scope = scope
        task = asyncio.create_task(session._reply_pipeline("用户输入", scope))
        session.reply_task = task

        await ws.pcm_entered.wait()
        scope.cancel("turn_detected")
        ws.pcm_release.set()
        await task

        binary_messages = [message for message in ws.messages if isinstance(message, bytes)]
        self.assertEqual(ws.pcm_attempts, 1)
        self.assertEqual(len(binary_messages), 1)
        header = common.MANAGED_AUDIO_HEADER.unpack(
            binary_messages[0][: common.MANAGED_AUDIO_HEADER_BYTES]
        )
        self.assertEqual(header[4:7], (scope.generation, 1, 0))
        self.assertIsNone(session.response_scope)

    async def test_send_lock_rechecks_generation_before_queued_control_event(self):
        ws = BlockingPcmWebSocket()
        session = common.Session(ws)
        scope = session._new_scope("response")

        pcm_send = asyncio.create_task(session.send_pcm(b"\x01\x00", scope=scope))
        await ws.pcm_entered.wait()
        queued_json = asyncio.create_task(
            session.send_json({"type": "assistant", "text": "late"}, scope=scope)
        )
        await asyncio.sleep(0)
        scope.cancel("turn_detected")
        ws.pcm_release.set()

        self.assertFalse(await pcm_send)
        self.assertFalse(await queued_json)
        self.assertEqual(ws.messages, [b"\x01\x00"])

    async def test_streaming_pipeline_emits_deltas_and_synthesizes_stable_sentences(self):
        synthesized = []

        def synth(sentence):
            synthesized.append(sentence)
            return b"\x01\x00" * 40, {"characters": len(sentence), "provider": "CosyVoice"}

        common._synth_tts = synth
        self.stream_events = [
            {"type": "meta", "provider": "Ollama", "thinking": False},
            {"type": "delta", "text": "（开心）第一句已经完成。"},
            {"type": "delta", "text": "第二句尾巴"},
            {"type": "usage", "prompt": 10, "completion": 6, "total": 16},
            {"type": "done"},
        ]
        scope = self.session._new_scope("response")
        self.session.response_scope = scope

        await self.session._reply_pipeline("用户输入", scope)

        messages = self.ws.json_messages()
        assistant = [m["text"] for m in messages if m["type"] == "assistant"]
        self.assertEqual(assistant, ["（开心）第一句已经完成。", "第二句尾巴"])
        self.assertEqual([m["type"] for m in messages].count("assistant_end"), 1)
        self.assertEqual([m["type"] for m in messages].count("tts_end"), 1)
        self.assertEqual(synthesized, ["（开心）第一句已经完成。", "第二句尾巴"])
        self.assertEqual(
            self.session.history,
            [{"role": "user", "content": "用户输入"}],
        )
        segment_starts = [m for m in messages if m["type"] == "audio_segment_start"]
        self.assertEqual(
            [(m["segmentId"], m["text"]) for m in segment_starts],
            [(1, "第一句已经完成。"), (2, "第二句尾巴")],
        )
        self.session.on_playback_segment(
            {"generation": scope.generation, "segmentId": 1, "state": "completed"}
        )
        self.assertEqual(
            self.session.history[-1],
            {"role": "assistant", "content": "第一句已经完成。"},
        )
        self.session.on_playback_segment(
            {"generation": scope.generation, "segmentId": 2, "state": "completed"}
        )
        self.assertEqual(
            self.session.history,
            [
                {"role": "user", "content": "用户输入"},
                {"role": "assistant", "content": "第一句已经完成。第二句尾巴"},
            ],
        )
        usage = next(m for m in messages if m["type"] == "usage")
        self.assertEqual(usage["provider"], "Ollama+CosyVoice")
        self.assertEqual(usage["llm"]["total"], 16)
        self.assertEqual(usage["ttsCharacters"], len("（开心）第一句已经完成。第二句尾巴"))

    async def test_provider_pcm_stream_sends_first_audio_before_provider_finishes(self):
        provider_finish = asyncio.Event()

        async def fake_stream(_text):
            yield {"type": "audio", "pcm": b"\x01\x00" * 4}
            await provider_finish.wait()
            yield {"type": "audio", "pcm": b"\x02\x00" * 3}
            yield {"type": "done", "characters": 7, "provider": "CosyVoice"}

        common._synth_tts = lambda _text: b"buffered path must not run"
        common._synth_tts_stream = fake_stream
        await self.session.on_start(
            {
                "downlinkAudio": [common.MANAGED_AUDIO_CAPABILITY],
                "ttsStream": [common.TTS_STREAMING_CAPABILITY],
            }
        )
        self.stream_events = [
            {"type": "meta", "provider": "Ollama", "thinking": False},
            {"type": "delta", "text": "真流式句子已经完成。"},
            {"type": "done"},
        ]
        scope = self.session._new_scope("response")
        self.session.response_scope = scope
        task = asyncio.create_task(self.session._reply_pipeline("用户输入", scope))

        for _ in range(100):
            if any(isinstance(message, bytes) for message in self.ws.messages):
                break
            await asyncio.sleep(0)
        self.assertTrue(any(isinstance(message, bytes) for message in self.ws.messages))
        messages = self.ws.json_messages()
        start = next(m for m in messages if m["type"] == "audio_segment_start")
        self.assertTrue(start["streaming"])
        self.assertNotIn("samples", start)
        self.assertFalse(any(m["type"] == "audio_segment_end" for m in messages))

        provider_finish.set()
        await task
        messages = self.ws.json_messages()
        end = next(m for m in messages if m["type"] == "audio_segment_end")
        self.assertEqual(
            (end["status"], end["samples"], end["chunks"]),
            ("completed", 7, 2),
        )
        usage = next(m for m in messages if m["type"] == "usage")
        self.assertEqual(usage["ttsCharacters"], 7)

    async def test_provider_pcm_stream_failure_closes_dropped_segment_without_history(self):
        async def failing_stream(_text):
            yield {"type": "audio", "pcm": b"\x01\x00" * 4}
            raise RuntimeError("provider detail must stay private")

        common._synth_tts = lambda _text: b"unused"
        common._synth_tts_stream = failing_stream
        await self.session.on_start(
            {
                "downlinkAudio": [common.MANAGED_AUDIO_CAPABILITY],
                "ttsStream": [common.TTS_STREAMING_CAPABILITY],
            }
        )
        self.stream_events = [
            {"type": "delta", "text": "会在流中失败的句子。"},
            {"type": "done"},
        ]
        scope = self.session._new_scope("response")
        self.session.response_scope = scope

        await self.session._reply_pipeline("用户输入", scope)

        messages = self.ws.json_messages()
        end = next(m for m in messages if m["type"] == "audio_segment_end")
        self.assertEqual(end["status"], "failed")
        self.assertFalse(any(m["type"] == "tts_end" for m in messages))
        self.assertNotIn("provider detail", messages[-1].get("message", ""))
        self.session.on_playback_segment(
            {"generation": scope.generation, "segmentId": 1, "state": "completed"}
        )
        self.assertEqual(
            self.session.history,
            [{"role": "user", "content": "用户输入"}],
        )

    async def test_provider_pcm_stream_cancel_closes_generator_and_releases_slot(self):
        provider_wait = asyncio.Event()
        provider_closed = asyncio.Event()

        async def cancellable_stream(_text):
            try:
                yield {"type": "audio", "pcm": b"\x01\x00" * 4}
                await provider_wait.wait()
            finally:
                provider_closed.set()

        common._synth_tts = lambda _text: b"unused"
        common._synth_tts_stream = cancellable_stream
        await self.session.on_start(
            {
                "downlinkAudio": [common.MANAGED_AUDIO_CAPABILITY],
                "ttsStream": [common.TTS_STREAMING_CAPABILITY],
            }
        )
        self.stream_events = [
            {"type": "delta", "text": "等待取消的流式句子。"},
            {"type": "done"},
        ]
        scope = self.session._new_scope("response")
        self.session.response_scope = scope
        task = asyncio.create_task(self.session._reply_pipeline("用户输入", scope))
        for _ in range(100):
            if any(isinstance(message, bytes) for message in self.ws.messages):
                break
            await asyncio.sleep(0)
        self.assertTrue(any(isinstance(message, bytes) for message in self.ws.messages))

        scope.cancel("turn_detected")
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        self.assertTrue(provider_closed.is_set())
        self.assertTrue(common._tts_stream_slots.acquire(blocking=False))
        self.assertTrue(common._tts_stream_slots.acquire(blocking=False))
        self.assertFalse(common._tts_stream_slots.acquire(blocking=False))
        common._tts_stream_slots.release()
        common._tts_stream_slots.release()
        completed = [
            message
            for message in self.ws.json_messages()
            if message["type"] == "audio_segment_end"
            and message.get("status") == "completed"
        ]
        self.assertEqual(completed, [])

    async def test_provider_pcm_stream_releases_slot_when_aclose_raises(self):
        class ExplodingCloseStream:
            def __init__(self):
                self.count = 0

            def __aiter__(self):
                return self

            async def __anext__(self):
                self.count += 1
                if self.count == 1:
                    return {"type": "audio", "pcm": b"\x01\x00" * 4}
                raise RuntimeError("provider read failed")

            async def aclose(self):
                raise RuntimeError("provider cleanup failed")

        common._synth_tts = lambda _text: b"unused"
        common._synth_tts_stream = lambda _text: ExplodingCloseStream()
        await self.session.on_start(
            {
                "downlinkAudio": [common.MANAGED_AUDIO_CAPABILITY],
                "ttsStream": [common.TTS_STREAMING_CAPABILITY],
            }
        )
        self.stream_events = [
            {"type": "delta", "text": "清理也会失败的流式句子。"},
            {"type": "done"},
        ]
        scope = self.session._new_scope("response")
        self.session.response_scope = scope

        await self.session._reply_pipeline("用户输入", scope)

        self.assertTrue(common._tts_stream_slots.acquire(blocking=False))
        self.assertTrue(common._tts_stream_slots.acquire(blocking=False))
        self.assertFalse(common._tts_stream_slots.acquire(blocking=False))
        common._tts_stream_slots.release()
        common._tts_stream_slots.release()
        self.assertEqual(self.ws.json_messages()[-1]["type"], "error")
        self.assertNotIn("cleanup failed", self.ws.json_messages()[-1]["message"])

    async def test_managed_audio_chunks_are_identified_between_segment_markers(self):
        common._synth_tts = lambda _text: b"\x01\x00" * 4000
        self.session.downlink_audio = common.MANAGED_AUDIO_CAPABILITY
        self.stream_events = [
            {"type": "delta", "text": "按块发送的完整句子。"},
            {"type": "done"},
        ]
        scope = self.session._new_scope("response")
        self.session.response_scope = scope

        await self.session._reply_pipeline("用户输入", scope)

        decoded = []
        marker_order = []
        for message in self.ws.messages:
            if isinstance(message, bytes):
                header = common.MANAGED_AUDIO_HEADER.unpack(
                    message[: common.MANAGED_AUDIO_HEADER_BYTES]
                )
                decoded.append(header)
                marker_order.append("audio")
            else:
                event_type = json.loads(message).get("type")
                if event_type in {"audio_segment_start", "audio_segment_end"}:
                    marker_order.append(event_type)

        self.assertEqual(
            marker_order,
            ["audio_segment_start", "audio", "audio", "audio", "audio_segment_end"],
        )
        self.assertEqual([header[4] for header in decoded], [scope.generation] * 3)
        self.assertEqual([header[5] for header in decoded], [1, 1, 1])
        self.assertEqual([header[6] for header in decoded], [0, 1, 2])
        self.assertEqual([header[7] for header in decoded], [1920, 1920, 160])

    async def test_parallel_synthesis_keeps_wire_and_history_ordered(self):
        common._synth_tts = lambda _text: b"unused"
        loop = asyncio.get_running_loop()
        first = loop.create_future()
        second = loop.create_future()
        self.session.loop = ControlledLoop([first, second])
        self.session.tts_parallelism = 2
        self.stream_events = [
            {"type": "delta", "text": "第一句已经完成。"},
            {"type": "delta", "text": "第二句也完成了。"},
            {"type": "done"},
        ]
        scope = self.session._new_scope("response")
        self.session.response_scope = scope
        task = asyncio.create_task(self.session._reply_pipeline("用户输入", scope))

        for _ in range(20):
            types = [message["type"] for message in self.ws.json_messages()]
            if "assistant_end" in types:
                break
            await asyncio.sleep(0)
        self.assertIn("assistant_end", types)
        self.assertFalse(first.done())
        self.assertFalse(second.done())

        second.set_result(b"\x02\x00" * 40)
        await asyncio.sleep(0)
        self.assertFalse(
            any(m["type"] == "audio_segment_start" for m in self.ws.json_messages())
        )
        first.set_result(b"\x01\x00" * 40)
        await task

        starts = [
            (m["segmentId"], m["text"])
            for m in self.ws.json_messages()
            if m["type"] == "audio_segment_start"
        ]
        self.assertEqual(
            starts,
            [(1, "第一句已经完成。"), (2, "第二句也完成了。")],
        )
        self.session.on_playback_segment(
            {"generation": scope.generation, "segmentId": 2, "state": "completed"}
        )
        self.assertEqual(
            self.session.history,
            [{"role": "user", "content": "用户输入"}],
        )
        self.session.on_playback_segment(
            {"generation": scope.generation, "segmentId": 1, "state": "completed"}
        )
        self.assertEqual(
            self.session.history[-1]["content"],
            "第一句已经完成。第二句也完成了。",
        )

    async def test_invalid_sentence_pcm_is_rejected_before_segment_registration(self):
        common._synth_tts = lambda _text: b"unused"
        invalid_audio = [
            (b"\x01", "无效音频"),
            ("not-pcm", "无效音频"),
            (
                b"\x00\x00" * (common.TTS_SENTENCE_MAX_SAMPLES + 1),
                "单句语音过长",
            ),
        ]
        for index, (audio, expected_error) in enumerate(invalid_audio, start=1):
            with self.subTest(index=index):
                common._tts_stream_slots = threading.BoundedSemaphore(
                    common.TTS_STREAM_MAX_TASKS
                )
                ws = FakeWebSocket()
                session = common.Session(ws)
                tts_future = asyncio.get_running_loop().create_future()
                tts_future.set_result(audio)
                session.loop = ControlledLoop([tts_future])
                self.stream_events = [
                    {"type": "delta", "text": "需要校验的完整句子。"},
                    {"type": "done"},
                ]
                scope = session._new_scope("response")
                session.response_scope = scope
                await session._reply_pipeline("用户输入", scope)

                messages = ws.json_messages()
                self.assertFalse(
                    any(m["type"] == "audio_segment_start" for m in messages)
                )
                self.assertFalse(any(isinstance(m, bytes) for m in ws.messages))
                self.assertEqual(messages[-1]["type"], "error")
                self.assertIn(expected_error, messages[-1]["message"])
                self.assertNotIn("not-pcm", messages[-1]["message"])

    async def test_soft_endpoint_keeps_reopened_audio_in_one_utterance(self):
        handled = []

        async def capture_utterance(pcm, *, from_play_barge=False):
            handled.append((pcm, from_play_barge))

        self.session._handle_utterance = capture_utterance
        voice = struct.pack("<h", 5000) * common.FRAME_SAMPLES
        quiet = b"\x00\x00" * common.FRAME_SAMPLES

        for _ in range(20):
            await self.session._on_frame(voice)
        for _ in range(900 // common.FRAME_MS):
            await self.session._on_frame(quiet)
        await self.session._on_frame(voice)

        self.assertEqual(handled, [])
        self.assertTrue(self.session.in_speech)

        for _ in range(common.ENDPOINT_COMMIT_MS // common.FRAME_MS):
            await self.session._on_frame(quiet)

        endpoint_types = [
            message["type"]
            for message in self.ws.json_messages()
            if message["type"].startswith("endpoint_")
        ]
        self.assertEqual(
            endpoint_types,
            [
                "endpoint_soft_end",
                "endpoint_reopened",
                "endpoint_soft_end",
                "endpoint_committed",
            ],
        )
        self.assertEqual(len(handled), 1)
        self.assertFalse(self.session.in_speech)


if __name__ == "__main__":
    unittest.main()
