import copy
import hashlib
import importlib.util
import json
import math
import random
import struct
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VAD_PATH = ROOT / "scripts" / "local-realtime" / "vad_adapter.py"
MANIFEST_MODULE_PATH = (
    ROOT / "scripts" / "local-realtime" / "acoustic_manifest.py"
)
MANIFEST_PATH = ROOT / "tests" / "fixtures" / "realtime-acoustic-manifest.json"


def _load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


vad = _load_module("kxyy_vad_adapter", VAD_PATH)
acoustic = _load_module("kxyy_acoustic_manifest", MANIFEST_MODULE_PATH)


def pcm_samples(count, start=0):
    values = ((start + index) % 65536 - 32768 for index in range(count))
    return b"".join(struct.pack("<h", value) for value in values)


def new_state(**overrides):
    config = {
        "speech_threshold": 0.7,
        "release_threshold": 0.3,
        "confirm_frames": 3,
        "reject_frames": 2,
        "end_frames": 3,
    }
    config.update(overrides)
    return vad.ProbabilityVadState(**config)


class Pcm16FrameAssemblerTests(unittest.TestCase):
    def test_reassembles_480_sample_chunks_without_loss(self):
        assembler = vad.Pcm16FrameAssembler()
        source = pcm_samples(16 * 480)
        frames = []
        for chunk_index, offset in enumerate(range(0, len(source), 480 * 2), 1):
            frames.extend(assembler.push(source[offset : offset + 480 * 2]))
            self.assertEqual(len(frames), (chunk_index * 480) // 512)
            self.assertEqual(
                assembler.pending_byte_count,
                2 * ((chunk_index * 480) % 512),
            )

        self.assertEqual(len(frames), 15)
        self.assertEqual(assembler.pending_byte_count, 0)
        self.assertEqual(b"".join(frames), source)
        self.assertTrue(all(len(frame) == 1024 for frame in frames))

    def test_arbitrary_and_odd_byte_splits_match_fixed_chunks(self):
        source = pcm_samples(6000)

        suffix = bytes((index % 251) + 1 for index in range(288))

        def assemble(sizes):
            assembler = vad.Pcm16FrameAssembler()
            frames = []
            offset = 0
            for size in sizes:
                frames.extend(assembler.push(source[offset : offset + size]))
                offset += size
            frames.extend(assembler.push(source[offset:]))
            self.assertLess(assembler.pending_byte_count, 1024)
            frames.extend(assembler.push(suffix))
            self.assertEqual(assembler.pending_byte_count, 0)
            return tuple(frames)

        fixed = assemble([960] * (len(source) // 960))
        odd = assemble([1, 3, 511, 1023, 7, 999, 5, 513])
        rng = random.Random(20260724)
        sizes = []
        remaining = len(source)
        while remaining:
            size = min(remaining, rng.randint(1, 1100))
            sizes.append(size)
            remaining -= size
        random_split = assemble(sizes)

        self.assertEqual(odd, fixed)
        self.assertEqual(random_split, fixed)
        self.assertEqual(b"".join(fixed), source + suffix)

    def test_empty_push_and_input_limit_are_atomic(self):
        assembler = vad.Pcm16FrameAssembler(max_input_frames=2)
        assembler.push(b"\x7f")
        self.assertEqual(assembler.push(b""), ())
        self.assertEqual(assembler.pending_byte_count, 1)

        accepted = assembler.push(b"\x22" * 2048)
        self.assertEqual(len(accepted), 2)
        self.assertEqual(assembler.pending_byte_count, 1)
        with self.assertRaisesRegex(ValueError, "fixed per-call limit"):
            assembler.push(bytes(2049))
        self.assertEqual(assembler.pending_byte_count, 1)
        final = assembler.push(b"\x33" * 1023)
        self.assertEqual(final, (b"\x22" + b"\x33" * 1023,))

    def test_reset_prevents_cross_generation_half_frame_reuse(self):
        assembler = vad.Pcm16FrameAssembler()
        self.assertEqual(assembler.push(bytes(960)), ())
        assembler.reset()
        self.assertEqual(assembler.push(bytes(64)), ())
        self.assertEqual(assembler.pending_byte_count, 64)

    def test_constructor_rejects_non_positive_and_bool_limits(self):
        for value in (0, -1, True):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    vad.Pcm16FrameAssembler(frame_samples=value)
        with self.assertRaisesRegex(ValueError, "hard limit"):
            vad.Pcm16FrameAssembler(frame_samples=16001)
        with self.assertRaisesRegex(ValueError, "hard limit"):
            vad.Pcm16FrameAssembler(max_input_frames=65)


class ProbabilityVadStateTests(unittest.TestCase):
    def test_candidate_confirm_end_and_reject_are_deterministic(self):
        state = new_state()
        self.assertEqual(state.update(0.7), ("candidate",))
        self.assertEqual(state.update(0.8), ())
        self.assertEqual(state.update(0.9), ("confirmed",))
        self.assertEqual(state.update(0.3), ())
        self.assertEqual(state.update(0.2), ())
        self.assertEqual(state.update(0.1), ("ended",))
        self.assertEqual(state.update(0.1), ())

        self.assertEqual(state.update(0.9), ("candidate",))
        self.assertEqual(state.update(0.3), ())
        self.assertEqual(state.update(0.3), ("rejected",))
        self.assertEqual(state.update(0.3), ())

    def test_hysteresis_band_breaks_streak_but_retains_latch(self):
        state = new_state()
        self.assertEqual(state.update(0.8), ("candidate",))
        self.assertEqual(state.update(0.8), ())
        self.assertEqual(state.update(0.5), ())
        self.assertEqual(state.update(0.8), ())
        self.assertEqual(state.update(0.8), ())
        self.assertEqual(state.update(0.8), ("confirmed",))

        self.assertEqual(state.update(0.2), ())
        self.assertEqual(state.update(0.5), ())
        self.assertEqual(state.update(0.2), ())
        self.assertEqual(state.update(0.2), ())
        self.assertEqual(state.update(0.2), ("ended",))

    def test_invalid_probability_preserves_state(self):
        invalid = (
            None,
            True,
            "bad",
            "0.8",
            math.nan,
            math.inf,
            -math.inf,
            -0.01,
            1.01,
        )
        for value in invalid:
            state = new_state()
            self.assertEqual(state.update(0.8), ("candidate",))
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    state.update(value)
            self.assertEqual(state.update(0.8), ())
            self.assertEqual(state.update(0.8), ("confirmed",))

    def test_configuration_validation(self):
        invalid_thresholds = ((0.5, 0.5), (0.4, 0.5), (1.1, 0.2), (0.5, -0.1))
        for speech, release in invalid_thresholds:
            with self.subTest(speech=speech, release=release):
                with self.assertRaises(ValueError):
                    new_state(speech_threshold=speech, release_threshold=release)
        for field in ("confirm_frames", "reject_frames", "end_frames"):
            with self.subTest(field=field):
                with self.assertRaises(ValueError):
                    new_state(**{field: True})

    def test_reset_replays_the_same_event_sequence(self):
        probabilities = (0.8, 0.8, 0.8, 0.2, 0.2, 0.2)
        state = new_state()
        first = tuple(state.update(value) for value in probabilities)
        state.reset()
        second = tuple(state.update(value) for value in probabilities)
        self.assertEqual(second, first)

    def test_high_and_middle_band_break_low_streaks(self):
        candidate = new_state()
        self.assertEqual(candidate.update(0.8), ("candidate",))
        self.assertEqual(candidate.update(0.2), ())
        self.assertEqual(candidate.update(0.8), ())
        self.assertEqual(candidate.update(0.2), ())
        self.assertEqual(candidate.update(0.5), ())
        self.assertEqual(candidate.update(0.2), ())
        self.assertEqual(candidate.update(0.2), ("rejected",))

        confirmed = new_state()
        for value in (0.8, 0.8, 0.8):
            confirmed.update(value)
        confirmed.update(0.2)
        confirmed.update(0.8)
        self.assertEqual(confirmed.update(0.2), ())
        self.assertEqual(confirmed.update(0.2), ())
        self.assertEqual(confirmed.update(0.2), ("ended",))

    def test_one_frame_confirmation_emits_ordered_events(self):
        state = new_state(confirm_frames=1, reject_frames=1, end_frames=1)
        self.assertEqual(state.update(0.8), ("candidate", "confirmed"))
        self.assertEqual(state.update(0.2), ("ended",))


class FakeScorer:
    def __init__(self, probabilities):
        self.probabilities = iter(probabilities)
        self.frames = []
        self.reset_count = 0

    def __call__(self, frame):
        self.frames.append(frame)
        value = next(self.probabilities)
        if isinstance(value, Exception):
            raise value
        return value

    def reset(self):
        self.reset_count += 1


class NeuralVadPipelineTests(unittest.TestCase):
    def test_scores_only_complete_frames_and_preserves_offsets(self):
        scorer = FakeScorer([0.8, 0.8, 0.8])
        pipeline = vad.NeuralVadPipeline(scorer, new_state())
        pipeline.reset(1)
        source = pcm_samples(1536)

        self.assertEqual(pipeline.feed(source[:960], generation=1), ())
        first = pipeline.feed(source[960:2048], generation=1)
        rest = pipeline.feed(source[2048:], generation=1)

        observations = first + rest
        self.assertEqual(tuple(item.end_sample for item in observations), (512, 1024, 1536))
        self.assertEqual(observations[0].events, ("candidate",))
        self.assertEqual(observations[-1].events, ("confirmed",))
        self.assertEqual(b"".join(scorer.frames), source)

    def test_scorer_failure_emits_one_fixed_fallback_per_generation(self):
        scorer = FakeScorer([RuntimeError("sensitive provider details"), 0.9])
        pipeline = vad.NeuralVadPipeline(scorer, new_state())
        pipeline.reset(1)

        first = pipeline.feed(bytes(1024), generation=1)
        self.assertEqual(first, (vad.VadFallback(generation=1),))
        self.assertNotIn("sensitive", repr(first))
        self.assertEqual(pipeline.feed(bytes(1024), generation=1), ())
        self.assertEqual(len(scorer.frames), 1)

        pipeline.reset(2)
        recovered = pipeline.feed(bytes(1024), generation=2)
        self.assertEqual(len(recovered), 1)
        self.assertEqual(recovered[0].status, "ready")

    def test_batch_failure_discards_partial_observations_and_resets_state(self):
        scorer = FakeScorer([0.8, 0.8, RuntimeError("private"), 0.9])
        pipeline = vad.NeuralVadPipeline(scorer, new_state())
        pipeline.reset(1)
        self.assertEqual(
            pipeline.feed(bytes(1024), generation=1)[0].events,
            ("candidate",),
        )
        self.assertEqual(
            pipeline.feed(bytes(2048), generation=1),
            (vad.VadFallback(generation=1),),
        )
        self.assertEqual(pipeline.assembler.pending_byte_count, 0)
        self.assertEqual(pipeline.feed(bytes(1024), generation=1), ())

        pipeline.reset(2)
        recovered = pipeline.feed(bytes(1024), generation=2)
        self.assertEqual(recovered[0].end_sample, 512)
        self.assertEqual(recovered[0].events, ("candidate",))
        self.assertEqual(scorer.reset_count, 3)

    def test_invalid_probability_fails_closed_and_unavailable_is_stable(self):
        for invalid in (math.nan, math.inf, -0.1, 1.1):
            scorer = FakeScorer([invalid])
            pipeline = vad.NeuralVadPipeline(scorer, new_state())
            pipeline.reset(5)
            with self.subTest(invalid=invalid):
                self.assertEqual(
                    pipeline.feed(bytes(1024), generation=5),
                    (vad.VadFallback(generation=5),),
                )

        unavailable = vad.NeuralVadPipeline(None, new_state())
        unavailable.reset(6)
        self.assertEqual(
            unavailable.feed(b"\x01", generation=6),
            (vad.VadFallback(generation=6),),
        )
        self.assertEqual(unavailable.assembler.pending_byte_count, 0)
        self.assertEqual(unavailable.feed(bytes(1024), generation=6), ())

    def test_oversized_input_is_not_misreported_as_provider_fallback(self):
        pipeline = vad.NeuralVadPipeline(None, new_state(), max_input_frames=1)
        pipeline.reset(1)
        with self.assertRaises(ValueError):
            pipeline.feed(bytes(1025), generation=1)
        self.assertEqual(
            pipeline.feed(bytes(1024), generation=1),
            (vad.VadFallback(generation=1),),
        )

    def test_stale_frames_and_reentrant_late_results_are_discarded(self):
        scorer = FakeScorer([0.8, 0.8, 0.8, 0.8])
        pipeline = vad.NeuralVadPipeline(scorer, new_state())
        pipeline.reset(1)
        pipeline.feed(b"\xaa" * 960, generation=1)
        pipeline.reset(2)
        self.assertEqual(pipeline.feed(b"\x11" * 64, generation=2), ())
        self.assertEqual(pipeline.feed(b"\x33" * 1000000, generation=1), ())
        current = pipeline.feed(b"\x22" * 960, generation=2)
        self.assertEqual(len(current), 1)
        self.assertEqual(scorer.frames, [b"\x11" * 64 + b"\x22" * 960])

        class ReentrantScorer:
            def __init__(self):
                self.pipeline = None
                self.calls = 0

            def __call__(self, _frame):
                self.calls += 1
                if self.calls == 1:
                    self.pipeline.reset(4)
                return 0.9

            def reset(self):
                pass

        reentrant = ReentrantScorer()
        pipeline = vad.NeuralVadPipeline(reentrant, new_state())
        reentrant.pipeline = pipeline
        pipeline.reset(3)
        self.assertEqual(pipeline.feed(bytes(2048), generation=3), ())
        self.assertEqual(pipeline.generation, 4)

        fresh = tuple(
            item.events
            for item in pipeline.feed(bytes(3072), generation=4)
        )
        self.assertEqual(fresh, (("candidate",), (), ("confirmed",)))

    def test_reentrant_feed_fails_closed_through_the_outer_result(self):
        class ReentrantFeedScorer:
            def __init__(self):
                self.pipeline = None

            def __call__(self, _frame):
                self.asserted = self.pipeline.feed(bytes(1024), generation=7)
                return 0.9

        scorer = ReentrantFeedScorer()
        pipeline = vad.NeuralVadPipeline(scorer, new_state())
        scorer.pipeline = pipeline
        pipeline.reset(7)
        self.assertEqual(
            pipeline.feed(bytes(1024), generation=7),
            (vad.VadFallback(generation=7),),
        )
        self.assertEqual(scorer.asserted, ())

    def test_close_is_idempotent_and_requires_a_new_explicit_reset(self):
        pipeline = vad.NeuralVadPipeline(FakeScorer([0.9]), new_state())
        pipeline.reset(1)
        pipeline.feed(bytes(960), generation=1)
        pipeline.close()
        pipeline.close()
        self.assertEqual(pipeline.assembler.pending_byte_count, 0)
        with self.assertRaises(RuntimeError):
            pipeline.feed(bytes(64), generation=1)
        for old_generation in (0, 1):
            with self.assertRaises(ValueError):
                pipeline.reset(old_generation)
        pipeline.reset(2)

    def test_scorer_reset_callback_cannot_feed_during_transition(self):
        class ResetCallbackScorer:
            def __init__(self):
                self.pipeline = None
                self.feed_result = None

            def __call__(self, _frame):
                return 0.9

            def reset(self):
                if self.pipeline is not None:
                    self.feed_result = self.pipeline.feed(
                        bytes(1024), generation=3
                    )

        scorer = ResetCallbackScorer()
        pipeline = vad.NeuralVadPipeline(scorer, new_state())
        scorer.pipeline = pipeline
        pipeline.reset(3)
        self.assertEqual(scorer.feed_result, ())
        self.assertEqual(pipeline.assembler.pending_byte_count, 0)
        observation = pipeline.feed(bytes(1024), generation=3)
        self.assertEqual(observation[0].end_sample, 512)
        self.assertEqual(observation[0].events, ("candidate",))

    def test_generation_contract_is_explicit_and_monotonic(self):
        pipeline = vad.NeuralVadPipeline(None, new_state())
        with self.assertRaises(RuntimeError):
            pipeline.feed(b"", generation=0)
        for invalid in (True, -1):
            with self.assertRaises(ValueError):
                pipeline.reset(invalid)
        pipeline.reset(2)
        for invalid in (1, 2):
            with self.assertRaises(ValueError):
                pipeline.reset(invalid)


class AcousticManifestTests(unittest.TestCase):
    def test_repository_manifest_validates_without_exposing_content(self):
        result = acoustic.validate_acoustic_manifest(MANIFEST_PATH, ROOT)
        self.assertEqual(result["schemaVersion"], 1)
        self.assertEqual(result["artifactCount"], 1)
        self.assertEqual(result["artifacts"][0]["id"], "realtime-pcm-replay-v1")
        self.assertNotIn("scenarioTags", result["artifacts"][0])

    def _fixture(self):
        temp = tempfile.TemporaryDirectory()
        root = Path(temp.name)
        artifact = root / "fixtures" / "sample.json"
        artifact.parent.mkdir(parents=True)
        artifact.write_bytes(b'{"synthetic":true}\n')
        data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        entry = data["artifacts"][0]
        entry["relativePath"] = "fixtures/sample.json"
        entry["byteLength"] = artifact.stat().st_size
        entry["sha256"] = hashlib.sha256(artifact.read_bytes()).hexdigest()
        manifest = root / "manifest.json"
        manifest.write_text(json.dumps(data), encoding="utf-8")
        return temp, root, manifest, data

    def test_hash_path_license_and_schema_whitelist_fail_closed(self):
        mutations = (
            lambda entry, data: entry.update(sha256="A" * 64),
            lambda entry, data: entry.update(relativePath="../outside.json"),
            lambda entry, data: entry["license"].update(spdxId="CC-BY-NC-4.0"),
            lambda entry, data: entry["license"].update(commercialUseAllowed=False),
            lambda entry, data: entry.update(transcript="forbidden complete text"),
            lambda entry, data: entry.update(kind="public-recording"),
            lambda entry, data: entry.update(containsRecordedAudio=True),
        )
        for mutate in mutations:
            temp, root, manifest, original = self._fixture()
            self.addCleanup(temp.cleanup)
            data = copy.deepcopy(original)
            mutate(data["artifacts"][0], data)
            manifest.write_text(json.dumps(data), encoding="utf-8")
            with self.subTest(mutate=mutate):
                with self.assertRaises(acoustic.AcousticManifestError):
                    acoustic.validate_acoustic_manifest(manifest, root)

    def test_duplicate_ids_and_explicit_synthetic_only_status_are_required(self):
        temp, root, manifest, data = self._fixture()
        self.addCleanup(temp.cleanup)
        data["artifacts"].append(copy.deepcopy(data["artifacts"][0]))
        manifest.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaisesRegex(acoustic.AcousticManifestError, "unique"):
            acoustic.validate_acoustic_manifest(manifest, root)

        data["artifacts"] = data["artifacts"][:1]
        data["recordingContent"] = "contains-recordings"
        manifest.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaisesRegex(acoustic.AcousticManifestError, "no recorded audio"):
            acoustic.validate_acoustic_manifest(manifest, root)


if __name__ == "__main__":
    unittest.main()
