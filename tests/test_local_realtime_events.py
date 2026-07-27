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
import time
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
import vad_adapter as vad

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


def last_json_of_type(ws, message_type):
    return next(
        message
        for message in reversed(ws.json_messages())
        if message.get("type") == message_type
    )


VAD_SHADOW_SUMMARY_KEYS = {
    "schemaVersion",
    "configRevision",
    "mode",
    "status",
    "complete",
    "outstanding",
    "queueCapacity",
    "maxQueueDepth",
    "offered",
    "accepted",
    "dropped",
    "processedJobs",
    "processedFrames",
    "staleResults",
    "fallbacks",
    "faults",
    "candidateEvents",
    "confirmedEvents",
    "rejectedEvents",
    "candidateTimeoutEvents",
    "endedEvents",
    "latencySamples",
    "inferenceP50Ms",
    "inferenceP95Ms",
}


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
        self.original_style = dict(tts_cosyvoice._style)
        tts_cosyvoice._api_key = "test-api-key"
        tts_cosyvoice._voice = "cosyvoice-test-voice"
        tts_cosyvoice._model = "cosyvoice-v3.5-flash"

    def tearDown(self):
        tts_cosyvoice._api_key = self.original_api_key
        tts_cosyvoice._voice = self.original_voice
        tts_cosyvoice._model = self.original_model
        tts_cosyvoice._style = self.original_style

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

    async def test_realtime_wrapper_keeps_neutral_rate_and_instruction_across_sentences(self):
        captured = []
        original = tts_cosyvoice._synthesize_pcm_stream
        tts_cosyvoice._style = {"suggested_rate": 0.94}

        async def fake_stream(text, **kwargs):
            captured.append((text, kwargs))
            yield {"type": "done", "characters": len(text), "provider": "CosyVoice"}

        tts_cosyvoice._synthesize_pcm_stream = fake_stream
        try:
            for sentence in ("（开心）第一句！", "（难过）第二句。"):
                events = [event async for event in tts_cosyvoice.synth_tts_stream(sentence)]
                self.assertEqual(events[-1]["type"], "done")
        finally:
            tts_cosyvoice._synthesize_pcm_stream = original

        self.assertEqual([item[0] for item in captured], ["第一句！", "第二句。"])
        for _text, kwargs in captured:
            self.assertEqual(kwargs["instruction"], "")
            self.assertEqual(kwargs["rate"], 0.94)

    def test_buffered_realtime_fallback_is_neutral_but_http_keeps_emotion(self):
        captured = []
        original_once = tts_cosyvoice._synth_mp3_once
        original_convert = common.mp3_to_pcm24k

        def fake_once(spoken, *, emotion):
            captured.append((spoken, emotion))
            return b"mp3", len(spoken)

        tts_cosyvoice._synth_mp3_once = fake_once
        common.mp3_to_pcm24k = lambda data: b"\x01\x00" if data else b""
        try:
            pcm, _usage = tts_cosyvoice.synth_tts("（开心）实时回复！")
            self.assertEqual(pcm, b"\x01\x00")
            self.assertEqual(captured[-1][1], "neutral")

            tts_cosyvoice.synth_tts_mp3("（开心）普通朗读！")
            self.assertEqual(captured[-1][1], "excited")
        finally:
            tts_cosyvoice._synth_mp3_once = original_once
            common.mp3_to_pcm24k = original_convert

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

    def test_realtime_minimum_coalesces_short_sentences_into_one_clone_request(self):
        buf = common.StableSentenceBuffer(min_chars=common.REALTIME_TTS_MIN_CHARS)
        self.assertEqual(buf.feed("第一句很短。"), [])
        self.assertEqual(buf.feed("第二句也会和前句一起合成。"), [])
        self.assertEqual(
            buf.feed("第三句正好补足稳定长度。"),
            ["第一句很短。第二句也会和前句一起合成。第三句正好补足稳定长度。"],
        )

        boundary = common.StableSentenceBuffer(min_chars=common.REALTIME_TTS_MIN_CHARS)
        sentence = "甲" * (common.REALTIME_TTS_MIN_CHARS - 1) + "。"
        self.assertEqual(boundary.feed(sentence), [sentence])

        short_only = common.StableSentenceBuffer(min_chars=common.REALTIME_TTS_MIN_CHARS)
        self.assertEqual(short_only.feed("只有一句。"), [])
        self.assertEqual(short_only.flush(), ["只有一句。"])

    def test_realtime_minimum_reduces_medium_sentence_clone_requests(self):
        buf = common.StableSentenceBuffer(min_chars=common.REALTIME_TTS_MIN_CHARS)
        first = "甲" * 19 + "。"
        second = "乙" * 19 + "。"
        third = "丙" * 19 + "。"

        self.assertEqual(buf.feed(first), [])
        self.assertEqual(buf.feed(second), [first + second])
        self.assertEqual(buf.feed(third), [])
        self.assertEqual(buf.flush(), [third])


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
    def test_pause_tolerance_presets_are_fixed_and_frame_aligned(self):
        self.assertEqual(common.normalize_turn_pause_tolerance(" fast "), "fast")
        self.assertEqual(common.normalize_turn_pause_tolerance("long"), "long")
        for value in (None, "", "custom", "2250"):
            self.assertEqual(
                common.normalize_turn_pause_tolerance(value),
                "standard",
            )

        expected_commit_ms = {
            "fast": 1050,
            "standard": 1650,
            "long": 2250,
        }
        for preset, commit_ms in expected_commit_ms.items():
            reopen_ms = common.TURN_PAUSE_REOPEN_MS[preset]
            self.assertEqual(common.SOFT_END_MS + reopen_ms, commit_ms)
            self.assertEqual(reopen_ms % common.FRAME_MS, 0)

    def test_each_pause_tolerance_commits_at_its_fixed_deadline(self):
        for preset, reopen_ms in common.TURN_PAUSE_REOPEN_MS.items():
            endpoint = common.SoftEndpoint(reopen_ms=reopen_ms)
            events = []
            commit_ms = common.SOFT_END_MS + reopen_ms
            for _ in range(commit_ms // common.FRAME_MS):
                event = endpoint.observe(False, eligible=True)
                if event:
                    events.append(event)
            self.assertEqual(events, ["soft_end", "committed"], preset)

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
        self.original_adapter = common._asr_adapter_instance
        common._asr_adapter_instance = None

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
        common._asr_adapter_instance = self.original_adapter

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

        result = common.transcribe(pcm)

        self.assertEqual(result.text, "内存识别")
        self.assertEqual(result.no_speech_prob, 0.2)
        self.assertFalse(isinstance(captured["audio"], (str, Path)))
        self.assertEqual(len(captured["audio"]), 3)
        self.assertAlmostEqual(captured["audio"][0], -1.0)
        self.assertAlmostEqual(captured["audio"][2], 32767 / 32768)
        self.assertEqual(captured["kwargs"]["language"], "zh")
        self.assertIs(captured["kwargs"]["condition_on_previous_text"], False)

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

        result = common.transcribe(struct.pack("<hh", 1000, -1000))

        self.assertEqual(result.text, "本地数组")
        self.assertAlmostEqual(result.no_speech_prob, 0.2)
        self.assertFalse(isinstance(captured["audio"], (str, Path)))
        self.assertEqual(captured["kwargs"]["initial_prompt"], common.WHISPER_PROMPT)
        self.assertIs(captured["kwargs"]["condition_on_previous_text"], False)

    def test_asr_runtime_summary_is_fixed_shape_and_fixed_enums(self):
        original = common._asr_runtime
        try:
            common._asr_runtime = {
                "requested": "/private/provider",
                "active": "secret-provider-error",
                "status": "raw exception /Users/private",
                "extra": "must-not-cross-wire",
            }
            self.assertEqual(
                common.asr_runtime_summary(),
                {
                    "requested": "whisper",
                    "active": "none",
                    "status": "unavailable",
                },
            )
            common._asr_runtime = {
                "requested": "sensevoice",
                "active": "whisper-mlx",
                "status": "fallback",
            }
            self.assertEqual(
                common.asr_runtime_summary(),
                {
                    "requested": "sensevoice",
                    "active": "whisper-mlx",
                    "status": "fallback",
                },
            )
        finally:
            common._asr_runtime = original

    def test_long_repetition_hallucinations_are_rejected_without_harming_short_emphasis(self):
        voiced = struct.pack("<h", 5000) * common.FRAME_SAMPLES
        rejected = (
            "乖" * 40,
            "乱，" * 40,
            "你好" * 20,
            "不要乱跑" * 8,
        )
        for text in rejected:
            with self.subTest(text_length=len(text)):
                self.assertIsNone(common.is_valid_asr(text, 0.1, voiced))

        accepted = (
            "好好好，我马上就来。",
            "我真的真的真的很喜欢这个设计。",
            "今天我们一起出去散步吧。",
        )
        for text in accepted:
            with self.subTest(text=text):
                self.assertEqual(common.is_valid_asr(text, 0.1, voiced), text)

    def test_asr_text_length_is_fail_closed_at_fixed_boundary(self):
        voiced = struct.pack("<h", 5000) * common.FRAME_SAMPLES
        phrase = "今天一起讨论新功能和测试安排，也要认真检查所有边界条件。"
        normal = phrase * (common.ASR_TEXT_MAX_CHARS // len(phrase) + 1)
        within_limit = normal[: common.ASR_TEXT_MAX_CHARS]
        over_limit = within_limit + "啊"
        self.assertLessEqual(len(within_limit), common.ASR_TEXT_MAX_CHARS)
        self.assertEqual(common.is_valid_asr(within_limit, 0.1, voiced), within_limit)
        self.assertIsNone(common.is_valid_asr(over_limit, 0.1, voiced))


class RealtimePcmReplayTests(unittest.IsolatedAsyncioTestCase):
    def test_vad_shadow_summary_schema_bounds_and_privacy_are_fixed(self):
        raw = {
            "mode": "silero-onnx-shadow-v1",
            "configRevision": vad.SILERO_VAD_CONFIG_REVISION,
            "status": "active",
            "complete": True,
            "outstanding": 0,
            "queueCapacity": 999,
            "maxQueueDepth": 1,
            **{
                name: vad.SHADOW_COUNTER_MAX
                for name in common.VAD_SHADOW_SUMMARY_COUNTERS
            },
            "latencySamples": vad.SHADOW_LATENCY_SAMPLES,
            "inferenceP50Ms": 12.34567,
            "inferenceP95Ms": 45.67891,
            "epoch": 99,
            "rawPcm": "secret-key persona /Users/private transcript",
        }
        summary = common.sanitize_vad_shadow_summary(raw)
        self.assertEqual(set(summary), VAD_SHADOW_SUMMARY_KEYS)
        self.assertEqual(summary["schemaVersion"], 1)
        self.assertEqual(
            summary["configRevision"], vad.SILERO_VAD_CONFIG_REVISION
        )
        self.assertEqual(summary["mode"], "silero-onnx-shadow-v1")
        self.assertEqual(summary["status"], "active")
        self.assertIs(summary["complete"], True)
        self.assertEqual(summary["outstanding"], 0)
        self.assertEqual(summary["queueCapacity"], 1)
        self.assertEqual(summary["maxQueueDepth"], 1)
        self.assertEqual(summary["latencySamples"], vad.SHADOW_LATENCY_SAMPLES)
        self.assertEqual(summary["inferenceP50Ms"], 12.346)
        self.assertEqual(summary["inferenceP95Ms"], 45.679)
        serialized = json.dumps(summary, sort_keys=True)
        for forbidden in (
            "secret-key",
            "persona",
            "/Users",
            "transcript",
            "rawPcm",
            "epoch",
        ):
            self.assertNotIn(forbidden, serialized)
        self.assertLess(len(serialized), 2048)

        poisoned = dict(raw)
        poisoned.update(
            {
                "mode": "future-mode",
                "configRevision": "private-revision",
                "status": "future-status",
                "complete": True,
                "outstanding": True,
                "maxQueueDepth": 2,
                "offered": -1,
                "accepted": vad.SHADOW_COUNTER_MAX + 1,
                "latencySamples": vad.SHADOW_LATENCY_SAMPLES + 1,
                "inferenceP50Ms": float("nan"),
                "inferenceP95Ms": float("inf"),
            }
        )
        fallback = common.sanitize_vad_shadow_summary(
            poisoned,
            fallback_mode="unavailable",
            fallback_status="not-reported",
            fallback_config_revision="none",
        )
        self.assertEqual(set(fallback), VAD_SHADOW_SUMMARY_KEYS)
        self.assertEqual(fallback["mode"], "unavailable")
        self.assertEqual(fallback["configRevision"], "none")
        self.assertEqual(fallback["status"], "not-reported")
        self.assertIs(fallback["complete"], False)
        self.assertEqual(fallback["outstanding"], 0)
        self.assertEqual(fallback["maxQueueDepth"], 0)
        self.assertEqual(fallback["offered"], 0)
        self.assertEqual(fallback["accepted"], 0)
        self.assertEqual(fallback["latencySamples"], 0)
        self.assertIsNone(fallback["inferenceP50Ms"])
        self.assertIsNone(fallback["inferenceP95Ms"])

    def test_service_release_captures_before_unlock_and_isolates_next_lease(self):
        calls = []

        class DeterministicWorker:
            def __init__(self):
                self.service = None
                self.owner = 0
                self.counters = 0

            def wait_ready(self, _timeout):
                return True

            def begin_lease(self):
                calls.append(("begin_lease", self.service._leased))
                self.owner += 1
                self.counters = 0
                return True

            def begin_epoch(self):
                calls.append(("begin_epoch", self.service._leased))
                return self.owner

            def snapshot(self):
                calls.append(("snapshot", self.service._leased))
                return {
                    "mode": "silero-onnx-shadow-v1",
                    "configRevision": vad.SILERO_VAD_CONFIG_REVISION,
                    "status": "active",
                    "complete": True,
                    "outstanding": 0,
                    "queueCapacity": 1,
                    "offered": self.counters,
                }

            def offer(self, _pcm):
                self.counters += 1
                return True

            def close(self):
                pass

        worker = DeterministicWorker()
        service = common.VadShadowService(
            worker,
            "silero-onnx-shadow-v1",
            "warming",
            vad.SILERO_VAD_CONFIG_REVISION,
        )
        worker.service = service

        first, first_status = service.acquire()
        self.assertEqual(first_status, "silero-onnx-shadow-v1")
        self.assertIsNotNone(first)
        self.assertTrue(first.offer(bytes(1024)))
        captured = service.release(first)
        self.assertEqual(captured["offered"], 1)
        self.assertEqual(calls[-2:], [("begin_epoch", True), ("snapshot", True)])
        self.assertFalse(service._leased)
        self.assertFalse(first.offer(bytes(1024)))
        self.assertFalse(first.begin_epoch())

        second, second_status = service.acquire()
        self.assertEqual(second_status, "silero-onnx-shadow-v1")
        self.assertIsNotNone(second)
        self.assertEqual(second.snapshot()["offered"], 0)
        service.release(first)
        self.assertTrue(second.offer(bytes(1024)))
        self.assertEqual(second.snapshot()["offered"], 1)
        service.release(second)

    async def test_shadow_summary_wire_is_fixed_for_disabled_and_old_services(self):
        disabled_ws = FakeWebSocket()
        disabled = common.Session(disabled_ws)
        await disabled.on_start({})
        disabled_messages = disabled_ws.json_messages()
        self.assertEqual(
            [message["type"] for message in disabled_messages],
            ["session"],
        )
        disabled_summary = disabled_messages[-1]["vadShadowSummary"]
        self.assertEqual(set(disabled_summary), VAD_SHADOW_SUMMARY_KEYS)
        self.assertEqual(disabled_summary["configRevision"], "none")
        self.assertEqual(disabled_summary["status"], "disabled")
        self.assertIs(disabled_summary["complete"], False)

        class OldLease:
            def snapshot(self):
                raise RuntimeError("secret-key persona /Users/private transcript")

            def begin_epoch(self):
                return True

            def offer(self, _pcm):
                return True

        class OldService:
            mode = "silero-onnx-shadow-v1"
            config_revision = vad.SILERO_VAD_CONFIG_REVISION

            def __init__(self):
                self.lease = OldLease()
                self.release_count = 0

            def acquire(self):
                return self.lease, self.mode

            def release(self, lease):
                self.release_count += 1
                self.asserted_lease = lease
                return None

        old_service = OldService()
        old_ws = FakeWebSocket()
        old = common.Session(
            old_ws,
            vad_shadow_service=old_service,
            vad_shadow_start_status="warming",
            vad_shadow_mode="silero-onnx-shadow-v1",
            vad_shadow_config_revision=vad.SILERO_VAD_CONFIG_REVISION,
        )
        await old.on_start({})
        old_start = last_json_of_type(old_ws, "session")["vadShadowSummary"]
        self.assertEqual(set(old_start), VAD_SHADOW_SUMMARY_KEYS)
        self.assertEqual(old_start["status"], "unavailable")
        self.assertEqual(
            old_start["configRevision"],
            vad.SILERO_VAD_CONFIG_REVISION,
        )

        await old.cancel_all("hangup")
        await old.send_vad_shadow_summary(final=True)
        final = last_json_of_type(old_ws, "vad_shadow_summary")
        self.assertIs(final["final"], True)
        self.assertEqual(set(final["summary"]), VAD_SHADOW_SUMMARY_KEYS)
        self.assertEqual(final["summary"]["status"], "unavailable")
        self.assertEqual(old_service.release_count, 1)
        serialized = json.dumps(old_ws.json_messages(), sort_keys=True)
        for forbidden in (
            "secret-key",
            "persona",
            "/Users",
            "transcript",
        ):
            self.assertNotIn(forbidden, serialized)
        self.assertLess(len(json.dumps(final, sort_keys=True)), 2048)

    async def test_shadow_summary_piggybacks_without_an_observer_send(self):
        ws = FakeWebSocket()
        session = common.Session(ws)
        committed = []

        async def capture_utterance(pcm, *, from_play_barge=False):
            committed.append((bytes(pcm), from_play_barge))

        session._handle_utterance = capture_utterance
        await session.on_start({})
        start = last_json_of_type(ws, "session")
        self.assertEqual(
            set(start["vadShadowSummary"]), VAD_SHADOW_SUMMARY_KEYS
        )

        voice = struct.pack("<h", 6000) * common.FRAME_SAMPLES
        quiet = bytes(common.FRAME_SAMPLES * 2)
        for _ in range(20):
            await session._on_frame(voice)
        commit_frames = common.ENDPOINT_COMMIT_MS // common.FRAME_MS
        for _ in range(commit_frames - 1):
            await session._on_frame(quiet)
        self.assertEqual(
            sum(
                message.get("type") == "vad_shadow_summary"
                for message in ws.json_messages()
            ),
            0,
        )

        await session._on_frame(quiet)
        self.assertEqual(len(committed), 1)
        session.asr_started = True
        await session._emit_asr_end_only()
        asr_end = last_json_of_type(ws, "asr_end")
        self.assertEqual(set(asr_end["vadShadowSummary"]), VAD_SHADOW_SUMMARY_KEYS)
        self.assertEqual(asr_end["vadShadowSummary"]["status"], "disabled")

    async def test_rms_commit_never_sends_a_standalone_observer_message(self):
        ws = FakeWebSocket()
        session = common.Session(ws)
        committed = []

        async def capture_utterance(pcm, *, from_play_barge=False):
            committed.append((bytes(pcm), from_play_barge))

        session._handle_utterance = capture_utterance
        await session.on_start({})

        voice = struct.pack("<h", 6000) * common.FRAME_SAMPLES
        quiet = bytes(common.FRAME_SAMPLES * 2)
        for _ in range(20):
            await session._on_frame(voice)
        for _ in range(common.ENDPOINT_COMMIT_MS // common.FRAME_MS):
            await session._on_frame(quiet)

        self.assertEqual(len(committed), 1)
        self.assertEqual(
            sum(
                message.get("type") == "vad_shadow_summary"
                for message in ws.json_messages()
            ),
            0,
        )

    async def test_blocked_shadow_final_summary_is_nonblocking_and_incomplete(self):
        entered = threading.Event()
        scorer_release = threading.Event()

        class BlockingPipeline:
            def reset(self, _generation):
                pass

            def feed(self, _pcm, *, generation):
                entered.set()
                scorer_release.wait(2)
                return (vad.VadObservation(generation, 512, 0.9, ()),)

            def close(self):
                pass

        service = common.VadShadowService.prepare(
            BlockingPipeline,
            mode="silero-onnx-shadow-v1",
            config_revision=vad.SILERO_VAD_CONFIG_REVISION,
            admission=threading.BoundedSemaphore(1),
        )
        self.assertTrue(service._worker.wait_ready(1))
        ws = FakeWebSocket()
        session = common.Session(
            ws,
            vad_shadow_service=service,
            vad_shadow_start_status="warming",
            vad_shadow_mode="silero-onnx-shadow-v1",
            vad_shadow_config_revision=vad.SILERO_VAD_CONFIG_REVISION,
        )
        await session.on_start({})
        self.assertTrue(session._vad_shadow.offer(bytes(1024)))
        self.assertTrue(entered.wait(1))

        async def finish_without_waiting_for_scorer():
            await session.cancel_all("hangup")
            await session.send_vad_shadow_summary(final=True)

        # The timeout is only a deadlock guard. The scorer barrier remains closed
        # until both release and fixed-summary capture have completed.
        await asyncio.wait_for(finish_without_waiting_for_scorer(), timeout=1)
        final = last_json_of_type(ws, "vad_shadow_summary")
        self.assertIs(final["final"], True)
        self.assertEqual(set(final["summary"]), VAD_SHADOW_SUMMARY_KEYS)
        self.assertEqual(final["summary"]["outstanding"], 1)
        self.assertIs(final["summary"]["complete"], False)
        self.assertEqual(final["summary"]["processedJobs"], 0)
        self.assertEqual(final["summary"]["latencySamples"], 0)

        contender, contender_status = service.acquire()
        self.assertIsNone(contender)
        self.assertEqual(contender_status, "busy")
        scorer_release.set()
        service.close()
        self.assertTrue(service._worker.wait_closed(1))

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

    async def test_shadow_reassembles_frontend_chunks_without_changing_rms_path(self):
        class RecordingScorer:
            def __init__(self):
                self.frames = []

            def __call__(self, frame):
                self.frames.append(frame)
                return 0.9

            def reset(self):
                pass

        scorer = RecordingScorer()

        def pipeline_factory():
            return vad.NeuralVadPipeline(
                scorer,
                vad.ProbabilityVadState(
                    speech_threshold=0.7,
                    release_threshold=0.3,
                    confirm_frames=3,
                    reject_frames=2,
                    end_frames=3,
                    candidate_max_frames=8,
                ),
            )

        shadow_ws = FakeWebSocket()
        baseline_ws = FakeWebSocket()
        shadow = common.Session(
            shadow_ws,
            vad_shadow_pipeline_factory=pipeline_factory,
            vad_shadow_admission=threading.BoundedSemaphore(1),
        )
        baseline = common.Session(baseline_ws)
        await shadow.on_start({"systemRole": "角色", "botName": "元元"})
        await baseline.on_start({"systemRole": "角色", "botName": "元元"})
        self.assertEqual(shadow_ws.json_messages()[0]["vadShadow"], "shadow-v1")
        self.assertEqual(baseline_ws.json_messages()[0]["vadShadow"], "disabled")

        source = b"".join(struct.pack("<h", index % 20) for index in range(2560))
        for chunk_index, offset in enumerate(range(0, len(source), 640), 1):
            chunk = source[offset : offset + 640]
            await shadow.on_pcm(chunk)
            await baseline.on_pcm(chunk)
            deadline = asyncio.get_running_loop().time() + 1
            while shadow.vad_shadow_snapshot().get("processedJobs", 0) < chunk_index:
                self.assertLess(asyncio.get_running_loop().time(), deadline)
                await asyncio.sleep(0.001)

        self.assertEqual(len(scorer.frames), 5)
        self.assertEqual(b"".join(scorer.frames), source)
        self.assertEqual(bytes(shadow.pcm_buf), bytes(baseline.pcm_buf))
        state_fields = (
            "in_speech",
            "silence_ms",
            "speech_ms",
            "barge_loud_frames",
            "play_barge_pending",
            "candidate_emitted",
        )
        self.assertEqual(
            tuple(getattr(shadow, field) for field in state_fields),
            tuple(getattr(baseline, field) for field in state_fields),
        )
        shadow_events = [
            {
                key: value
                for key, value in message.items()
                if key not in ("vadShadow", "vadShadowSummary")
            }
            for message in shadow_ws.json_messages()
            if message.get("type") != "vad_shadow_summary"
        ]
        baseline_events = [
            {
                key: value
                for key, value in message.items()
                if key not in ("vadShadow", "vadShadowSummary")
            }
            for message in baseline_ws.json_messages()
            if message.get("type") != "vad_shadow_summary"
        ]
        self.assertEqual(shadow_events, baseline_events)
        shadow_worker = shadow._vad_shadow
        await shadow.cancel_all("hangup")
        await shadow.cancel_all("disconnect")
        self.assertTrue(shadow_worker.wait_closed(1))

    async def test_shadow_high_probability_never_changes_synthetic_rms_replay(self):
        fixture = json.loads(PCM_REPLAY_PATH.read_text(encoding="utf-8"))

        class ConstantScorer:
            def __call__(self, _frame):
                return 1.0

            def reset(self):
                pass

        def pipeline_factory():
            return vad.NeuralVadPipeline(
                ConstantScorer(),
                vad.ProbabilityVadState(
                    speech_threshold=0.7,
                    release_threshold=0.3,
                    confirm_frames=3,
                    reject_frames=2,
                    end_frames=3,
                    candidate_max_frames=8,
                ),
            )

        for scenario in fixture["scenarios"]:
            with self.subTest(scenario=scenario["id"]):
                baseline_ws = FakeWebSocket()
                shadow_ws = FakeWebSocket()
                baseline = common.Session(baseline_ws)
                shadow = common.Session(
                    shadow_ws,
                    vad_shadow_pipeline_factory=pipeline_factory,
                    vad_shadow_admission=threading.BoundedSemaphore(1),
                )
                baseline_commits = []
                shadow_commits = []

                async def capture_baseline(pcm, *, from_play_barge=False):
                    baseline_commits.append((bytes(pcm), from_play_barge))
                    await baseline._emit_speech_rejected()

                async def capture_shadow(pcm, *, from_play_barge=False):
                    shadow_commits.append((bytes(pcm), from_play_barge))
                    await shadow._emit_speech_rejected()

                baseline._handle_utterance = capture_baseline
                shadow._handle_utterance = capture_shadow
                if scenario["mode"] == "playback":
                    baseline.playing = baseline.play_enabled = True
                    shadow.playing = shadow.play_enabled = True
                await baseline.on_start({})
                await shadow.on_start({})

                offered_frames = 0
                for segment in scenario["segments"]:
                    amplitude = fixture["levels"][segment["level"]]
                    frame = struct.pack("<h", amplitude) * common.FRAME_SAMPLES
                    for _ in range(segment["frames"]):
                        await baseline.on_pcm(frame)
                        await shadow.on_pcm(frame)
                        offered_frames += 1
                        if offered_frames <= 2:
                            deadline = asyncio.get_running_loop().time() + 1
                            expected_key = (
                                "processedJobs" if offered_frames == 1 else "processedFrames"
                            )
                            while shadow.vad_shadow_snapshot().get(expected_key, 0) < 1:
                                self.assertLess(
                                    asyncio.get_running_loop().time(), deadline
                                )
                                await asyncio.sleep(0.001)

                def controls(ws):
                    return [
                        {
                            key: value
                            for key, value in message.items()
                            if key not in ("vadShadow", "vadShadowSummary")
                        }
                        for message in ws.json_messages()
                        if message.get("type") != "vad_shadow_summary"
                    ]

                self.assertEqual(controls(shadow_ws), controls(baseline_ws))
                self.assertEqual(shadow_commits, baseline_commits)
                self.assertEqual(shadow.endpoint.state, baseline.endpoint.state)
                self.assertEqual(shadow.in_speech, baseline.in_speech)
                self.assertGreater(
                    shadow.vad_shadow_snapshot().get("processedFrames", 0), 0
                )
                shadow_worker = shadow._vad_shadow
                await shadow.cancel_all("hangup")
                self.assertTrue(shadow_worker.wait_closed(1))

    async def test_shadow_factory_failure_reports_unavailable_without_leaking_details(self):
        def fail_factory():
            raise RuntimeError("secret-key persona /Users/private/path")

        ws = FakeWebSocket()
        session = common.Session(
            ws,
            vad_shadow_pipeline_factory=fail_factory,
            vad_shadow_admission=threading.BoundedSemaphore(1),
        )

        await session.on_start({})
        self.assertEqual(last_json_of_type(ws, "session")["vadShadow"], "unavailable")
        self.assertIsNone(session._vad_shadow)

        loud_frame = struct.pack("<h", 10000) * common.FRAME_SAMPLES
        await session.on_pcm(loud_frame)
        self.assertTrue(session.in_speech)

        await session.on_start({})
        self.assertEqual(last_json_of_type(ws, "session")["vadShadow"], "unavailable")
        serialized = json.dumps(ws.json_messages())
        self.assertNotIn("secret-key", serialized)
        self.assertNotIn("persona", serialized)
        self.assertNotIn("/Users", serialized)

    async def test_terminal_cleanup_closes_shadow_when_cancellation_raises(self):
        class QuietPipeline:
            def reset(self, _generation):
                pass

            def feed(self, _pcm, *, generation):
                return ()

            def close(self):
                pass

        for failing_method in ("cancel_asr", "cancel_reply"):
            with self.subTest(failing_method=failing_method):
                admission = threading.BoundedSemaphore(1)
                session = common.Session(
                    FakeWebSocket(),
                    vad_shadow_pipeline_factory=QuietPipeline,
                    vad_shadow_admission=admission,
                )
                await session.on_start({})
                self.assertEqual(
                    session.vad_shadow_snapshot()["status"], "active"
                )
                worker = session._vad_shadow
                completed = []

                async def succeed(reason):
                    completed.append(reason)

                async def fail(_reason):
                    raise RuntimeError("synthetic cancellation failure")

                session.cancel_asr = fail if failing_method == "cancel_asr" else succeed
                session.cancel_reply = fail if failing_method == "cancel_reply" else succeed

                with self.assertRaisesRegex(RuntimeError, "synthetic cancellation"):
                    await session.cancel_all("hangup")
                self.assertEqual(completed, ["hangup"])
                self.assertTrue(worker.wait_closed(1))

                replacement = vad.VadShadowWorker.try_start(
                    QuietPipeline,
                    admission=admission,
                )
                self.assertIsNotNone(replacement)
                replacement.close()
                self.assertTrue(replacement.wait_closed(1))

    async def test_prepared_shadow_service_never_blocks_warming_handshake(self):
        factory_entered = threading.Event()
        factory_release = threading.Event()

        class QuietPipeline:
            def reset(self, _generation):
                pass

            def feed(self, _pcm, *, generation):
                return ()

            def close(self):
                pass

        def slow_factory():
            factory_entered.set()
            factory_release.wait(2)
            return QuietPipeline()

        service = common.VadShadowService.prepare(
            slow_factory,
            mode="silero-onnx-shadow-v1",
            admission=threading.BoundedSemaphore(1),
        )
        self.assertTrue(factory_entered.wait(1))
        warming = common.Session(
            FakeWebSocket(),
            vad_shadow_service=service,
            vad_shadow_start_status="warming",
            vad_shadow_mode="silero-onnx-shadow-v1",
        )
        started = asyncio.get_running_loop().time()
        await warming.on_start({})
        self.assertLess(asyncio.get_running_loop().time() - started, 0.05)
        self.assertEqual(
            last_json_of_type(warming.ws, "session")["vadShadow"], "warming"
        )

        factory_release.set()
        self.assertTrue(service._worker.wait_ready(1))
        active = common.Session(
            FakeWebSocket(),
            vad_shadow_service=service,
            vad_shadow_start_status="warming",
            vad_shadow_mode="silero-onnx-shadow-v1",
        )
        await active.on_start({})
        self.assertEqual(
            last_json_of_type(active.ws, "session")["vadShadow"],
            "silero-onnx-shadow-v1",
        )
        await active.cancel_all("hangup")
        service.close()
        self.assertTrue(service._worker.wait_closed(1))

    async def test_prepared_service_releases_lease_when_terminal_cancellation_raises(self):
        class QuietPipeline:
            def reset(self, _generation):
                pass

            def feed(self, _pcm, *, generation):
                return ()

            def close(self):
                pass

        for failing_method in ("cancel_asr", "cancel_reply"):
            with self.subTest(failing_method=failing_method):
                admission = threading.BoundedSemaphore(1)
                service = common.VadShadowService.prepare(
                    QuietPipeline,
                    mode="silero-onnx-shadow-v1",
                    admission=admission,
                )
                self.assertTrue(service._worker.wait_ready(1))
                session = common.Session(
                    FakeWebSocket(),
                    vad_shadow_service=service,
                    vad_shadow_start_status="warming",
                    vad_shadow_mode="silero-onnx-shadow-v1",
                )
                await session.on_start({})

                async def succeed(_reason):
                    pass

                async def fail(_reason):
                    raise RuntimeError("synthetic cancellation failure")

                session.cancel_asr = fail if failing_method == "cancel_asr" else succeed
                session.cancel_reply = fail if failing_method == "cancel_reply" else succeed
                with self.assertRaisesRegex(RuntimeError, "synthetic cancellation"):
                    await session.cancel_all("hangup")
                self.assertIsNone(session._vad_shadow)

                replacement_lease, status = service.acquire()
                self.assertEqual(status, "silero-onnx-shadow-v1")
                self.assertIsNotNone(replacement_lease)
                service.release(replacement_lease)
                self.assertIsNone(
                    vad.VadShadowWorker.try_start(QuietPipeline, admission=admission)
                )
                service.close()
                self.assertTrue(service._worker.wait_closed(1))
                replacement_worker = vad.VadShadowWorker.try_start(
                    QuietPipeline,
                    admission=admission,
                )
                self.assertIsNotNone(replacement_worker)
                replacement_worker.close()
                self.assertTrue(replacement_worker.wait_closed(1))

    async def test_repeated_start_resets_prepared_shadow_epoch_and_pcm_remainder(self):
        class CountingPipeline:
            def __init__(self):
                self.pipeline = vad.NeuralVadPipeline(
                    lambda _frame: 0.1,
                    vad.ProbabilityVadState(
                        speech_threshold=0.7,
                        release_threshold=0.3,
                        confirm_frames=3,
                        reject_frames=3,
                        end_frames=8,
                        candidate_max_frames=16,
                    ),
                )

            def reset(self, generation):
                self.pipeline.reset(generation)

            def feed(self, pcm, *, generation):
                return self.pipeline.feed(pcm, generation=generation)

            def close(self):
                self.pipeline.close()

        service = common.VadShadowService.prepare(
            CountingPipeline,
            mode="silero-onnx-shadow-v1",
            admission=threading.BoundedSemaphore(1),
        )
        self.assertTrue(service._worker.wait_ready(1))
        session = common.Session(
            FakeWebSocket(),
            vad_shadow_service=service,
            vad_shadow_start_status="warming",
            vad_shadow_mode="silero-onnx-shadow-v1",
        )
        await session.on_start({})
        first_epoch = session.vad_shadow_snapshot()["epoch"]
        self.assertTrue(session._vad_shadow.offer(bytes(480 * 2)))
        deadline = asyncio.get_running_loop().time() + 1
        while session.vad_shadow_snapshot().get("processedJobs", 0) < 1:
            self.assertLess(asyncio.get_running_loop().time(), deadline)
            await asyncio.sleep(0.001)
        self.assertEqual(session.vad_shadow_snapshot()["processedFrames"], 0)

        await session.on_start({})
        self.assertGreater(session.vad_shadow_snapshot()["epoch"], first_epoch)
        self.assertTrue(session._vad_shadow.offer(bytes(32 * 2)))
        deadline = asyncio.get_running_loop().time() + 1
        while session.vad_shadow_snapshot().get("processedJobs", 0) < 2:
            self.assertLess(asyncio.get_running_loop().time(), deadline)
            await asyncio.sleep(0.001)
        self.assertEqual(session.vad_shadow_snapshot()["processedFrames"], 0)
        await session.cancel_all("hangup")
        service.close()
        self.assertTrue(service._worker.wait_closed(1))

    async def test_prepared_shadow_leases_reject_busy_and_stale_owners(self):
        entered = threading.Event()
        release = threading.Event()

        class BlockingPipeline:
            def reset(self, _generation):
                pass

            def feed(self, _pcm, *, generation):
                entered.set()
                release.wait(2)
                return (vad.VadObservation(generation, 512, 0.9, ()),)

            def close(self):
                pass

        service = common.VadShadowService.prepare(
            BlockingPipeline,
            mode="silero-onnx-shadow-v1",
            admission=threading.BoundedSemaphore(1),
        )
        self.assertTrue(service._worker.wait_ready(1))
        first, first_status = service.acquire()
        self.assertEqual(first_status, "silero-onnx-shadow-v1")
        self.assertIsNotNone(first)
        contender, contender_status = service.acquire()
        self.assertIsNone(contender)
        self.assertEqual(contender_status, "busy")

        self.assertTrue(first.offer(bytes(1024)))
        self.assertTrue(entered.wait(1))
        service.release(first)
        service.release(first)
        self.assertFalse(first.offer(bytes(1024)))
        self.assertFalse(first.begin_epoch())
        while_busy, while_busy_status = service.acquire()
        self.assertIsNone(while_busy)
        self.assertEqual(while_busy_status, "busy")

        release.set()
        deadline = asyncio.get_running_loop().time() + 1
        second = None
        while second is None:
            self.assertLess(asyncio.get_running_loop().time(), deadline)
            second, second_status = service.acquire()
            if second is None:
                self.assertEqual(second_status, "busy")
                await asyncio.sleep(0.001)
        self.assertEqual(second_status, "silero-onnx-shadow-v1")
        service.release(first)
        self.assertTrue(second.offer(bytes(1024)))
        service.release(second)
        service.close()
        self.assertTrue(service._worker.wait_closed(1))


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
                "memoryContext": [
                    common.MEMORY_CONTEXT_CAPABILITY,
                    common.TURN_MEMORY_CAPABILITY,
                ],
            }
        )
        self.assertEqual(self.session.downlink_audio, common.MANAGED_AUDIO_CAPABILITY)
        self.assertEqual(
            self.session.interruption_hint,
            common.INTERRUPTION_HINT_CAPABILITY,
        )
        self.assertEqual(
            last_json_of_type(self.ws, "session")["downlinkAudio"],
            common.MANAGED_AUDIO_CAPABILITY,
        )
        self.assertEqual(self.session.tts_streaming, common.TTS_STREAMING_CAPABILITY)
        self.assertEqual(
            last_json_of_type(self.ws, "session")["ttsStream"],
            common.TTS_STREAMING_CAPABILITY,
        )
        self.assertEqual(
            last_json_of_type(self.ws, "session")["interruptionHint"],
            common.INTERRUPTION_HINT_CAPABILITY,
        )
        self.assertEqual(self.session.memory_context, common.TURN_MEMORY_CAPABILITY)
        self.assertEqual(
            last_json_of_type(self.ws, "session")["memoryContext"],
            common.TURN_MEMORY_CAPABILITY,
        )

        old_ws = FakeWebSocket()
        old_session = common.Session(old_ws)
        await old_session.on_start({"systemRole": "角色", "botName": "元元"})
        self.assertEqual(old_session.downlink_audio, "raw")
        self.assertEqual(old_session.tts_streaming, "none")
        self.assertEqual(old_session.interruption_hint, "none")
        self.assertEqual(old_session.memory_context, "none")
        old_started = last_json_of_type(old_ws, "session")
        self.assertEqual(old_started["downlinkAudio"], "raw")
        self.assertEqual(old_started["ttsStream"], "none")
        self.assertEqual(old_started["interruptionHint"], "none")
        self.assertEqual(old_started["memoryContext"], "none")
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

    async def test_turn_memory_wait_is_bounded_and_rejects_stale_generation(self):
        await self.session.on_start(
            {
                "memoryContext": [common.TURN_MEMORY_CAPABILITY],
            }
        )
        scope = common.GenerationCancelScope(4, "asr")
        pending = asyncio.create_task(self.session._request_turn_memory(scope))
        await asyncio.sleep(0)
        request = last_json_of_type(self.ws, "memory_context_request")
        self.assertEqual(request["generation"], 4)
        self.session.on_memory_context(
            {
                "generation": 3,
                "items": [{"kind": "fact", "text": "过期"}],
            }
        )
        self.session.on_memory_context(
            {
                "generation": 4,
                "items": [
                    {"kind": "commitment", "text": "下次提醒我", "uncertain": True},
                    {"kind": "fact", "text": "忽略这条未知字段", "extra": "drop"},
                ],
            }
        )
        context = await pending
        self.assertIn("下次提醒我", context)
        self.assertIn("[不确定]", context)
        self.assertNotIn("extra", context)

        started = time.perf_counter()
        timeout_scope = common.GenerationCancelScope(5, "asr")
        self.assertEqual(await self.session._request_turn_memory(timeout_scope), "")
        self.assertLess(time.perf_counter() - started, common.TURN_MEMORY_WAIT_SECONDS + 0.08)

    async def test_session_asr_runtime_never_exports_paths_or_raw_state(self):
        original = common._asr_runtime
        common._asr_runtime = {
            "requested": "sensevoice",
            "active": "/Users/private/model.onnx",
            "status": "provider secret exception",
            "rawError": "credential",
        }
        try:
            await self.session.on_start({})
        finally:
            common._asr_runtime = original

        session = last_json_of_type(self.ws, "session")
        self.assertEqual(
            session["asrRuntime"],
            {
                "requested": "sensevoice",
                "active": "none",
                "status": "unavailable",
            },
        )
        serialized = json.dumps(session, ensure_ascii=False)
        self.assertNotIn("/Users/private", serialized)
        self.assertNotIn("credential", serialized)

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

    async def test_turn_memory_is_an_ephemeral_observation_in_llm_history(self):
        captured_histories = []

        def capture_history(_role, history, _text, _scope, out):
            captured_histories.append([dict(message) for message in history])
            out.put_nowait({"type": "done"})
            return None

        common._synth_tts = lambda _text: b"unused"
        common.start_llm_stream_producer = capture_history
        scope = self.session._new_scope("response")
        self.session.response_scope = scope
        context = common.format_turn_memory_context(
            [{"kind": "fact", "text": "用户下周有面试", "uncertain": False}]
        )
        await self.session._reply_pipeline(
            "我有点紧张",
            scope,
            memory_context=context,
        )
        self.assertEqual(len(captured_histories), 1)
        self.assertIn("用户下周有面试", captured_histories[0][-1]["content"])
        self.assertNotIn("用户下周有面试", " ".join(message["content"] for message in self.session.history))

    async def test_valid_candidate_is_confirmed_before_asr_payload(self):
        original_transcribe = common.transcribe
        original_validate = common.is_valid_asr
        common.transcribe = lambda _pcm: common.asr_adapter.AsrResult(
            "确认插话", 0.01, language="zh"
        )
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
        common.transcribe = lambda _pcm: common.asr_adapter.AsrResult(
            "幻觉文本", 0.9, language="zh"
        )
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
        original_submit = common.submit_asr
        common.submit_asr = lambda _loop, _pcm: future
        self.session.candidate_emitted = True
        scope = self.session._new_scope("asr")
        self.session.asr_scope = scope
        task = asyncio.create_task(
            self.session._asr_then_maybe_reply(b"\x01\x00" * 1000, scope)
        )
        self.session.asr_task = task

        try:
            await asyncio.sleep(0)
            scope.cancel("superseded")
            future.set_result(
                common.asr_adapter.AsrResult("迟到识别", 0.01, language="zh")
            )
            await task
        finally:
            common.submit_asr = original_submit

        self.assertEqual(self.ws.messages, [])
        self.assertIsNone(self.session.reply_task)
        self.assertIsNone(self.session.asr_scope)

    async def test_submit_asr_releases_admission_only_after_worker_really_finishes(self):
        original_pool = common._mlx_pool
        original_transcribe = common.transcribe
        pool = common.ThreadPoolExecutor(max_workers=1, thread_name_prefix="asr-test")
        slots = threading.BoundedSemaphore(1)
        started = threading.Event()
        release = threading.Event()

        def blocking_transcribe(_pcm):
            started.set()
            release.wait(2)
            return common.asr_adapter.AsrResult("完成", 0.01, language="zh")

        common._mlx_pool = pool
        common.transcribe = blocking_transcribe
        first = None
        second = None
        try:
            loop = asyncio.get_running_loop()
            first = common.submit_asr(loop, b"first", slots=slots)
            self.assertIsNotNone(first)
            self.assertTrue(await asyncio.to_thread(started.wait, 1))
            first.cancel()
            await asyncio.sleep(0)
            self.assertIsNone(
                common.submit_asr(loop, b"must-not-queue", slots=slots),
                "async wrapper cancellation must not release native admission",
            )

            release.set()
            for _ in range(100):
                second = common.submit_asr(loop, b"second", slots=slots)
                if second is not None:
                    break
                await asyncio.sleep(0.01)
            self.assertIsNotNone(second)
            result = await second
            self.assertEqual(result.text, "完成")
        finally:
            release.set()
            if first is not None:
                await asyncio.gather(first, return_exceptions=True)
            if second is not None and not second.done():
                await asyncio.gather(second, return_exceptions=True)
            pool.shutdown(wait=True)
            common._mlx_pool = original_pool
            common.transcribe = original_transcribe

    async def test_asr_exception_is_replaced_by_fixed_log_and_wire_error(self):
        original_submit = common.submit_asr
        original_log = common.log
        future = asyncio.get_running_loop().create_future()
        private_error = "provider secret /Users/private/model.onnx 完整用户文本"
        future.set_exception(RuntimeError(private_error))
        common.submit_asr = lambda _loop, _pcm: future
        logs = []
        common.log = logs.append
        self.session.candidate_emitted = True
        scope = self.session._new_scope("asr")
        self.session.asr_scope = scope
        try:
            await self.session._asr_then_maybe_reply(b"\x01\x00" * 1000, scope)
        finally:
            common.submit_asr = original_submit
            common.log = original_log

        messages = self.ws.json_messages()
        self.assertIn(
            {
                "type": "error",
                "message": common.ASR_FAILURE_MESSAGE,
                "generation": scope.generation,
            },
            messages,
        )
        exported = json.dumps({"logs": logs, "messages": messages}, ensure_ascii=False)
        self.assertNotIn(private_error, exported)
        self.assertNotIn("/Users/private", exported)
        self.assertNotIn("完整用户文本", exported)

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

    async def test_unplayed_response_is_discarded_only_before_tts_admission(self):
        scope = self.session._new_scope("response")
        self.session.response_scope = scope
        self.session._response_generated = True
        self.session._response_tts_admitted = False
        self.session._response_started_at = common.time.perf_counter()

        self.assertTrue(await self.session.cancel_reply("turn_detected"))
        self.assertIn(
            {
                "type": "assistant_discarded",
                "generation": scope.generation,
            },
            self.ws.json_messages(),
        )

        admitted = self.session._new_scope("response")
        self.session.response_scope = admitted
        self.session._response_generated = True
        self.session._response_tts_admitted = True
        self.session._response_started_at = common.time.perf_counter()
        before = len(self.ws.json_messages())
        self.assertFalse(await self.session.cancel_reply("turn_detected"))
        self.assertEqual(len(self.ws.json_messages()), before)

        expired = self.session._new_scope("response")
        self.session.response_scope = expired
        self.session._response_generated = True
        self.session._response_tts_admitted = False
        self.session._response_started_at = (
            common.time.perf_counter() - common.CONTINUATION_WINDOW_SECONDS - 0.1
        )
        self.assertFalse(await self.session.cancel_reply("turn_detected"))
        self.assertEqual(len(self.ws.json_messages()), before)

    async def test_continuation_hint_is_one_request_only_and_not_history(self):
        captured = []

        def capture(_role, history, _text, _scope, out):
            captured.append([dict(message) for message in history])
            out.put_nowait({"type": "done"})

        common.start_llm_stream_producer = capture
        common._synth_tts = lambda _text: b"unused"
        scope = self.session._new_scope("response")
        self.session.response_scope = scope
        await self.session._reply_pipeline(
            "继续补充",
            scope,
            continuation_hint=True,
        )

        self.assertEqual(
            captured,
            [[{"role": "system", "content": common.CONTINUATION_HINT_TEXT}]],
        )
        self.assertFalse(
            any(
                message.get("content") == common.CONTINUATION_HINT_TEXT
                for message in self.session.history
            )
        )

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
        self.assertEqual(types, ["assistant", "assistant_end", "tts_start"])
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
        self.assertEqual(synthesized, ["（开心）第一句已经完成。第二句尾巴"])
        self.assertEqual(
            self.session.history,
            [{"role": "user", "content": "用户输入"}],
        )
        segment_starts = [m for m in messages if m["type"] == "audio_segment_start"]
        self.assertEqual(
            [(m["segmentId"], m["text"]) for m in segment_starts],
            [(1, "第一句已经完成。第二句尾巴")],
        )
        self.session.on_playback_segment(
            {"generation": scope.generation, "segmentId": 1, "state": "completed"}
        )
        self.assertEqual(
            self.session.history[-1],
            {"role": "assistant", "content": "第一句已经完成。第二句尾巴"},
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

    async def test_reply_keeps_playing_until_frontend_segment_receipt(self):
        common._synth_tts = lambda _text: (
            b"\x01\x00" * 40,
            {"characters": 8, "provider": "CosyVoice"},
        )
        self.stream_events = [
            {"type": "delta", "text": "尾部不能提前结束。"},
            {"type": "done"},
        ]
        scope = self.session._new_scope("response")
        self.session.response_scope = scope

        await self.session._reply_pipeline("用户输入", scope)

        self.assertTrue(self.session.playing)
        self.assertTrue(self.session.play_enabled)
        self.assertEqual(
            self.session._pending_playback_segments,
            {(scope.generation, 1)},
        )
        self.session.on_playback_segment(
            {"generation": scope.generation, "segmentId": 1, "state": "completed"}
        )
        self.assertFalse(self.session.playing)
        self.assertFalse(self.session.play_enabled)

        self.session.playing = True
        self.session.on_playback_reset()
        self.assertFalse(self.session.playing)
        self.assertFalse(self.session.play_enabled)

    async def test_tts_chunk_sequence_is_independent_of_text_provider_metadata(self):
        first = "甲" * 19 + "。"
        second = "乙" * 19 + "。"
        third = "丙" * 19 + "。"

        async def run_pipeline(provider):
            synthesized = []

            def synth(sentence):
                synthesized.append(sentence)
                return b"\x01\x00" * 4

            common._synth_tts = synth
            self.stream_events = [
                {"type": "meta", "provider": provider, "thinking": False},
                {"type": "delta", "text": first},
                {"type": "delta", "text": second},
                {"type": "delta", "text": third},
                {"type": "done"},
            ]
            session = common.Session(FakeWebSocket())
            scope = session._new_scope("response")
            session.response_scope = scope
            await session._reply_pipeline("用户输入", scope)
            return synthesized

        deepseek_chunks = await run_pipeline("DeepSeek")
        ollama_chunks = await run_pipeline("Ollama")

        self.assertEqual(deepseek_chunks, [first + second, third])
        self.assertEqual(ollama_chunks, deepseek_chunks)

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
        first_text = "第一句已经完成，而且内容足够长，可以独立合成并验证并行顺序稳定。"
        second_text = "第二句也已经完成，而且同样足够长，可以独立合成并验证并行顺序稳定。"
        self.stream_events = [
            {"type": "delta", "text": first_text},
            {"type": "delta", "text": second_text},
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
            [(1, first_text), (2, second_text)],
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
            first_text + second_text,
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
