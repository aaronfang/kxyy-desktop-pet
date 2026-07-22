import asyncio
import importlib.util
import io
import json
import os
import struct
import sys
import types
import unittest
import urllib.error
from pathlib import Path


COMMON_PATH = Path(__file__).resolve().parents[1] / "scripts" / "local-realtime" / "common.py"
PCM_REPLAY_PATH = Path(__file__).resolve().parent / "fixtures" / "realtime-pcm-replay.json"
SPEC = importlib.util.spec_from_file_location("kxyy_local_realtime_common", COMMON_PATH)
common = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(common)


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


class GenerationCancelScopeTests(unittest.IsolatedAsyncioTestCase):
    async def test_scope_lifecycle_and_monotonic_session_generations(self):
        scope = common.GenerationCancelScope(7, "asr")
        self.assertTrue(scope.active)
        scope.promote("response")
        self.assertEqual(scope.stage, "response")
        scope.cancel("turn_detected")
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
        self.original_load_settings = common.load_settings
        self.original_urlopen = common.urllib.request.urlopen
        os.environ["KXYY_AI_PROXY_BASE"] = "http://127.0.0.1:54321"

    def tearDown(self):
        if self.original_proxy_base is None:
            os.environ.pop("KXYY_AI_PROXY_BASE", None)
        else:
            os.environ["KXYY_AI_PROXY_BASE"] = self.original_proxy_base
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
        self.assertEqual(payload["messages"][-1]["content"], "这一轮")

    def test_chat_llm_uses_loopback_proxy_and_returns_provider_usage(self):
        captured = {}

        class FakeResponse:
            headers = {"X-Kxyy-Text-Provider": "Ollama"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps(
                    {
                        "choices": [{"message": {"content": "本地回复"}}],
                        "usage": {
                            "prompt_tokens": 10,
                            "completion_tokens": 4,
                            "total_tokens": 14,
                        },
                    }
                ).encode("utf-8")

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

        text, usage = common.chat_llm("角色设定", [], "用户内容")

        self.assertEqual(text, "本地回复")
        self.assertEqual(usage["total"], 14)
        self.assertEqual(usage["_provider"], "Ollama")
        self.assertEqual(captured["url"], "http://127.0.0.1:54321/api/chat")
        self.assertEqual(captured["payload"]["provider"], "text")
        self.assertNotIn("Authorization", captured["headers"])
        self.assertEqual(captured["timeout"], 120)

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
        with self.assertRaisesRegex(RuntimeError, "未配置 DeepSeek API Key") as raised:
            common.chat_llm("角色设定", [], "用户内容")
        self.assertNotIn("完整请求内容", str(raised.exception))


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

    async def asyncTearDown(self):
        if self.session.reply_task:
            await self.session.reply_task
        common._synth_tts = self.original_synth_tts

    async def test_playback_voice_threshold_emits_one_candidate(self):
        self.session.playing = True
        self.session.play_enabled = True
        frame = struct.pack("<h", 10000) * common.FRAME_SAMPLES

        for _ in range(common.BARGE_IN_FRAMES_PLAY + 3):
            await self.session._on_frame(frame)

        types = [message["type"] for message in self.ws.json_messages()]
        self.assertEqual(types.count("speech_candidate"), 1)
        self.assertTrue(self.session.play_barge_pending)

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
        future = asyncio.get_running_loop().create_future()
        self.session.loop = ControlledLoop([future])
        scope = self.session._new_scope("response")
        self.session.response_scope = scope
        task = asyncio.create_task(self.session._reply_pipeline("用户输入", scope))
        self.session.reply_task = task

        await asyncio.sleep(0)
        scope.cancel("turn_detected")
        future.set_result(("迟到回复", {"total": 3}))
        await task

        self.assertEqual(self.session.history, [])
        self.assertEqual(self.ws.messages, [])
        self.assertIsNone(self.session.response_scope)

    async def test_cancelled_tts_scope_drops_late_audio_and_usage(self):
        common._synth_tts = lambda _text: b"unused"
        loop = asyncio.get_running_loop()
        llm_future = loop.create_future()
        tts_future = loop.create_future()
        llm_future.set_result(("先完成的回复", {"total": 4}))
        self.session.loop = ControlledLoop([llm_future, tts_future])
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
        self.assertEqual(types, ["assistant", "assistant_end"])
        self.assertFalse(any(isinstance(message, bytes) for message in self.ws.messages))
        self.assertNotIn("usage", types)
        self.assertNotIn("speaking", types)

    async def test_old_pipeline_cleanup_cannot_clear_new_response_state(self):
        common._synth_tts = lambda _text: b"unused"
        future = asyncio.get_running_loop().create_future()
        self.session.loop = ControlledLoop([future])
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
        future.set_result(("迟到回复", {"total": 3}))
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
        llm_future = loop.create_future()
        tts_future = loop.create_future()
        llm_future.set_result(("回复", {"total": 2}))
        audio = b"\x01\x00" * (common.OUTPUT_RATE // 5)
        tts_future.set_result(audio)
        session.loop = ControlledLoop([llm_future, tts_future])
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
        self.assertIsNone(session.response_scope)

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
