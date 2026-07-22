import asyncio
import importlib.util
import json
import struct
import unittest
from pathlib import Path


COMMON_PATH = Path(__file__).resolve().parents[1] / "scripts" / "local-realtime" / "common.py"
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


class LocalRealtimeEventTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.ws = FakeWebSocket()
        self.session = common.Session(self.ws)

    async def asyncTearDown(self):
        if self.session.reply_task:
            await self.session.reply_task

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
        try:
            await self.session._asr_then_maybe_reply(b"\x01\x00" * 1000, from_play_barge=True)
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
        try:
            await self.session._asr_then_maybe_reply(b"\x01\x00" * 1000, from_play_barge=True)
        finally:
            common.transcribe = original_transcribe
            common.is_valid_asr = original_validate

        messages = self.ws.json_messages()
        self.assertEqual(messages, [{"type": "speech_rejected", "reason": "voice_rejected"}])
        self.assertNotIn("幻觉文本", json.dumps(messages, ensure_ascii=False))

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
