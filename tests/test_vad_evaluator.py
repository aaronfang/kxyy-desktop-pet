import json
import math
from dataclasses import replace
from pathlib import Path
import struct
import sys
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
LOCAL_REALTIME = ROOT / "scripts" / "local-realtime"
if str(LOCAL_REALTIME) not in sys.path:
    sys.path.insert(0, str(LOCAL_REALTIME))


import vad_adapter as vad
import vad_evaluator as evaluator


def new_state(**overrides):
    config = {
        "speech_threshold": 0.7,
        "release_threshold": 0.3,
        "confirm_frames": 3,
        "reject_frames": 2,
        "end_frames": 3,
        "candidate_max_frames": 8,
    }
    config.update(overrides)
    return vad.ProbabilityVadState(**config)


def constant_pcm(amplitude, frames, tail_samples=0):
    sample = struct.pack("<h", amplitude)
    return sample * (frames * evaluator.FRAME_SAMPLES + tail_samples)


def split_bytes(data, pattern):
    chunks = []
    offset = 0
    index = 0
    while offset < len(data):
        size = pattern[index % len(pattern)]
        chunks.append(data[offset : offset + size])
        offset += size
        index += 1
    return chunks


class AmplitudeScorer:
    def __call__(self, frame):
        first = struct.unpack_from("<h", frame)[0]
        magnitude = abs(first)
        if magnitude >= 5000:
            return 0.9
        if magnitude >= 1000:
            return 0.5
        return 0.1

    def reset(self):
        pass

    def close(self):
        pass


class SequenceScorer:
    def __init__(self, values):
        self.values = iter(values)

    def __call__(self, _frame):
        value = next(self.values)
        if isinstance(value, Exception):
            raise value
        return value

    def reset(self):
        pass

    def close(self):
        pass


class TrackedScorer:
    def __init__(self, *, fail_reset=False):
        self.fail_reset = fail_reset
        self.reset_count = 0
        self.close_count = 0

    def __call__(self, _frame):
        return 0.1

    def reset(self):
        self.reset_count += 1
        if self.fail_reset:
            raise RuntimeError("private reset detail")

    def close(self):
        self.close_count += 1


class ResetFaultState(vad.ProbabilityVadState):
    def __init__(self):
        self._armed = False
        super().__init__(
            speech_threshold=0.7,
            release_threshold=0.3,
            confirm_frames=3,
            reject_frames=2,
            end_frames=3,
            candidate_max_frames=8,
        )
        self._armed = True

    def reset(self):
        if self._armed:
            raise RuntimeError("private state reset detail")
        super().reset()


def evaluate_case(pcm, intervals, *, pattern=(1024,), state_factory=new_state):
    run = evaluator.OfflineVadEvaluator(AmplitudeScorer, state_factory)
    run.begin_case(total_samples=len(pcm) // 2, speech_intervals=intervals)
    for chunk in split_bytes(pcm, pattern):
        run.feed(chunk)
    run.end_case()
    return run.finish()


def evaluate_cases(cases):
    run = evaluator.OfflineVadEvaluator(AmplitudeScorer, new_state)
    for pcm, intervals in cases:
        run.begin_case(total_samples=len(pcm) // 2, speech_intervals=intervals)
        for chunk in split_bytes(pcm, (960, 1024, 7)):
            run.feed(chunk)
        run.end_case()
    return run.finish()


class OfflineVadEvaluatorTests(unittest.TestCase):
    def test_configured_limits_can_only_shrink_fixed_hard_caps(self):
        base = evaluator.EvaluatorLimits(
            max_cases=evaluator.HARD_MAX_CASES,
            max_total_frames=evaluator.HARD_MAX_TOTAL_FRAMES,
            max_frames_per_case=evaluator.HARD_MAX_FRAMES_PER_CASE,
            max_truth_intervals=evaluator.HARD_MAX_TRUTH_INTERVALS,
            max_events_per_case=evaluator.HARD_MAX_EVENTS_PER_CASE,
            match_grace_frames=evaluator.HARD_MAX_MATCH_GRACE_FRAMES,
        )
        evaluator.OfflineVadEvaluator(AmplitudeScorer, new_state, limits=base)

        hard_limits = {
            "max_cases": evaluator.HARD_MAX_CASES,
            "max_total_frames": evaluator.HARD_MAX_TOTAL_FRAMES,
            "max_frames_per_case": evaluator.HARD_MAX_FRAMES_PER_CASE,
            "max_truth_intervals": evaluator.HARD_MAX_TRUTH_INTERVALS,
            "max_events_per_case": evaluator.HARD_MAX_EVENTS_PER_CASE,
            "match_grace_frames": evaluator.HARD_MAX_MATCH_GRACE_FRAMES,
        }
        for name, hard_limit in hard_limits.items():
            with self.subTest(name=name):
                accepted = replace(base, **{name: hard_limit})
                evaluator.OfflineVadEvaluator(
                    AmplitudeScorer, new_state, limits=accepted
                )
                rejected = replace(base, **{name: hard_limit + 1})
                with self.assertRaisesRegex(
                    evaluator.VadEvaluationError, f"^{name}-limit$"
                ):
                    evaluator.OfflineVadEvaluator(
                        AmplitudeScorer, new_state, limits=rejected
                    )

    def test_per_feed_hard_cap_accepts_64_frames_and_limits_65(self):
        accepted_pcm = constant_pcm(0, evaluator.MAX_INPUT_FRAMES)
        accepted = evaluate_case(accepted_pcm, ())
        self.assertEqual(accepted["cases"]["evaluated"], 1)
        self.assertEqual(
            accepted["frames"]["evaluated"], evaluator.MAX_INPUT_FRAMES
        )

        rejected_pcm = constant_pcm(0, evaluator.MAX_INPUT_FRAMES + 1)
        run = evaluator.OfflineVadEvaluator(AmplitudeScorer, new_state)
        run.begin_case(total_samples=len(rejected_pcm) // 2, speech_intervals=())
        with self.assertRaisesRegex(evaluator.VadEvaluationError, "^input-limit$"):
            run.feed(rejected_pcm)
        run.end_case()
        rejected = run.finish()
        self.assertEqual(rejected["cases"]["limited"], 1)
        self.assertEqual(rejected["cases"]["fallback"], 0)
        self.assertEqual(rejected["frames"]["evaluated"], 0)

    def test_clean_speech_produces_fixed_aggregate_latency(self):
        pcm = constant_pcm(0, 2) + constant_pcm(6000, 5) + constant_pcm(0, 4)
        start = 2 * evaluator.FRAME_SAMPLES
        end = 7 * evaluator.FRAME_SAMPLES
        report = evaluate_case(pcm, ((start, end),))

        self.assertEqual(report["status"], "complete")
        self.assertEqual(report["cases"]["evaluated"], 1)
        self.assertEqual(report["frames"], {"evaluated": 11, "speech": 5, "nonSpeech": 6})
        self.assertEqual(report["truth"], {"segments": 1, "matched": 1, "missed": 0})
        self.assertEqual(report["events"]["candidate"], 1)
        self.assertEqual(report["events"]["confirmed"], 1)
        self.assertEqual(report["events"]["ended"], 1)
        self.assertEqual(report["latencyFrames"]["candidate"]["max"], 1)
        self.assertEqual(report["latencyFrames"]["confirmed"]["max"], 3)
        self.assertEqual(report["latencyFrames"]["ended"]["max"], 3)
        self.assertEqual(report["ratesPpm"]["segmentRecall"], 1_000_000)

    def test_false_candidate_recovery_and_timeout_stay_distinct(self):
        impulse = constant_pcm(6000, 1) + constant_pcm(0, 3)
        rejected = evaluate_case(impulse, ())
        self.assertEqual(rejected["events"]["candidate"], 1)
        self.assertEqual(rejected["events"]["rejected"], 1)
        self.assertEqual(rejected["events"]["candidate_timeout"], 0)
        self.assertEqual(rejected["classification"]["falseCandidate"], 1)
        self.assertEqual(rejected["classification"]["recoveredFalseCandidate"], 1)
        self.assertEqual(rejected["latencyFrames"]["rejected"]["max"], 2)

        timeout_pcm = constant_pcm(6000, 1) + constant_pcm(2000, 7)
        timed_out = evaluate_case(timeout_pcm, ())
        self.assertEqual(timed_out["events"]["candidate_timeout"], 1)
        self.assertEqual(timed_out["events"]["rejected"], 0)
        self.assertEqual(timed_out["classification"]["recoveredFalseCandidate"], 1)

    def test_miss_and_sustained_false_confirmation_are_scenario_level(self):
        missed_pcm = constant_pcm(0, 1) + constant_pcm(6000, 2) + constant_pcm(0, 3)
        missed = evaluate_case(
            missed_pcm,
            ((evaluator.FRAME_SAMPLES, 3 * evaluator.FRAME_SAMPLES),),
        )
        self.assertEqual(missed["truth"]["missed"], 1)
        self.assertEqual(missed["ratesPpm"]["segmentRecall"], 0)

        false_alarm_pcm = constant_pcm(6000, 4) + constant_pcm(0, 3)
        false_alarm = evaluate_case(false_alarm_pcm, ())
        self.assertEqual(false_alarm["classification"]["falseConfirmed"], 1)
        self.assertEqual(false_alarm["ratesPpm"]["falseConfirmed"], 1_000_000)

    def test_event_on_truth_start_is_not_matched_to_that_segment(self):
        pcm = constant_pcm(6000, 4) + constant_pcm(0, 4)
        truth_start = 3 * evaluator.FRAME_SAMPLES
        report = evaluate_case(
            pcm,
            ((truth_start, 4 * evaluator.FRAME_SAMPLES),),
        )
        self.assertEqual(report["events"]["confirmed"], 1)
        self.assertEqual(report["truth"]["matched"], 0)
        self.assertEqual(report["truth"]["missed"], 1)
        self.assertEqual(report["classification"]["falseConfirmed"], 1)

    def test_adjacent_truth_intervals_are_rejected(self):
        run = evaluator.OfflineVadEvaluator(AmplitudeScorer, new_state)
        with self.assertRaisesRegex(evaluator.VadEvaluationError, "^truth-invalid$"):
            run.begin_case(
                total_samples=1024,
                speech_intervals=((0, 512), (512, 1024)),
            )

    def test_false_confirmation_rate_uses_confirmed_events(self):
        pcm = (
            constant_pcm(6000, 4)
            + constant_pcm(0, 3)
            + constant_pcm(6000, 4)
            + constant_pcm(0, 3)
        )
        report = evaluate_case(
            pcm,
            ((0, 4 * evaluator.FRAME_SAMPLES),),
        )
        self.assertEqual(report["events"]["confirmed"], 2)
        self.assertEqual(report["classification"]["falseConfirmed"], 1)
        self.assertEqual(report["ratesPpm"]["falseConfirmed"], 500_000)

    def test_pcm_chunk_boundaries_do_not_change_the_report(self):
        pcm = constant_pcm(0, 2) + constant_pcm(6000, 5) + constant_pcm(0, 4)
        intervals = ((2 * evaluator.FRAME_SAMPLES, 7 * evaluator.FRAME_SAMPLES),)
        fixed = evaluate_case(pcm, intervals, pattern=(1024,))
        frontend = evaluate_case(pcm, intervals, pattern=(960,))
        odd = evaluate_case(pcm, intervals, pattern=(1, 3, 511, 1023, 7, 999))
        self.assertEqual(frontend, fixed)
        self.assertEqual(odd, fixed)

    def test_faulted_case_is_transactional_and_next_case_recovers(self):
        factories = iter(
            (
                lambda: SequenceScorer(
                    (0.9, RuntimeError("secret-key /Users persona full text"))
                ),
                lambda: SequenceScorer((0.1, 0.1)),
            )
        )
        run = evaluator.OfflineVadEvaluator(lambda: next(factories)(), new_state)

        run.begin_case(total_samples=1024, speech_intervals=())
        run.feed(bytes(2048))
        run.end_case()
        run.begin_case(total_samples=1024, speech_intervals=())
        run.feed(bytes(2048))
        run.end_case()
        report = run.finish()

        self.assertEqual(report["status"], "partial")
        self.assertEqual(report["cases"]["seen"], 2)
        self.assertEqual(report["cases"]["fallback"], 1)
        self.assertEqual(report["cases"]["evaluated"], 1)
        self.assertEqual(report["events"]["candidate"], 0)
        serialized = json.dumps(report, sort_keys=True)
        for forbidden in ("secret-key", "/Users", "persona", "full text"):
            self.assertNotIn(forbidden, serialized)

    def test_setup_failures_close_every_created_scorer(self):
        scenarios = (
            (lambda: (_ for _ in ()).throw(RuntimeError("state secret")), False),
            (lambda: object(), False),
            (ResetFaultState, False),
            (new_state, True),
        )
        for state_factory, fail_reset in scenarios:
            with self.subTest(
                state_factory=getattr(state_factory, "__name__", "failure"),
                fail_reset=fail_reset,
            ):
                scorer = TrackedScorer(fail_reset=fail_reset)
                run = evaluator.OfflineVadEvaluator(lambda: scorer, state_factory)
                run.begin_case(total_samples=512, speech_intervals=())
                run.feed(bytes(1024))
                run.end_case()
                report = run.finish()
                self.assertEqual(report["cases"]["fallback"], 1)
                self.assertEqual(scorer.close_count, 1)

    def test_merge_failure_rolls_back_case_aggregates_and_latencies(self):
        clean_pcm = (
            constant_pcm(0, 2)
            + constant_pcm(6000, 5)
            + constant_pcm(0, 4)
        )
        fault_pcm = clean_pcm + constant_pcm(0, 0, tail_samples=7)
        intervals = ((2 * evaluator.FRAME_SAMPLES, 7 * evaluator.FRAME_SAMPLES),)
        run = evaluator.OfflineVadEvaluator(AmplitudeScorer, new_state)

        run.begin_case(total_samples=len(clean_pcm) // 2, speech_intervals=intervals)
        run.feed(clean_pcm)
        run.end_case()

        merge_calls = 0

        original_merge = evaluator._LatencyHistogram.merge

        def fail_after_partial_merge(histogram, other):
            nonlocal merge_calls
            merge_calls += 1
            if merge_calls == 3:
                raise RuntimeError("transaction injection")
            return original_merge(histogram, other)

        run.begin_case(total_samples=len(fault_pcm) // 2, speech_intervals=intervals)
        run.feed(fault_pcm)
        with mock.patch.object(
            evaluator._LatencyHistogram,
            "merge",
            autospec=True,
            side_effect=fail_after_partial_merge,
        ):
            run.end_case()

        run.begin_case(total_samples=len(clean_pcm) // 2, speech_intervals=intervals)
        run.feed(clean_pcm)
        run.end_case()
        report = run.finish()

        self.assertEqual(merge_calls, 3)
        self.assertEqual(report["cases"]["seen"], 3)
        self.assertEqual(report["cases"]["fallback"], 1)
        self.assertEqual(report["cases"]["evaluated"], 2)
        self.assertEqual(report["frames"]["evaluated"], 22)
        self.assertEqual(report["truth"], {"segments": 2, "matched": 2, "missed": 0})
        self.assertEqual(report["events"]["candidate"], 2)
        self.assertEqual(report["events"]["confirmed"], 2)
        self.assertEqual(report["events"]["ended"], 2)
        self.assertEqual(report["cases"]["tail"], 0)
        self.assertEqual(report["latencyFrames"]["candidate"]["count"], 2)
        self.assertEqual(report["latencyFrames"]["confirmed"]["count"], 2)
        self.assertEqual(report["latencyFrames"]["ended"]["count"], 2)

    def test_case_order_does_not_change_aggregates_or_leak_tail_state(self):
        clean = (
            constant_pcm(0, 2)
            + constant_pcm(6000, 5)
            + constant_pcm(0, 4),
            ((2 * evaluator.FRAME_SAMPLES, 7 * evaluator.FRAME_SAMPLES),),
        )
        tail = (constant_pcm(0, 1, tail_samples=7), ())
        self.assertEqual(evaluate_cases((clean, tail)), evaluate_cases((tail, clean)))

    def test_event_limit_overflow_is_limited_not_fallback(self):
        limits = evaluator.EvaluatorLimits(max_events_per_case=1)
        run = evaluator.OfflineVadEvaluator(
            AmplitudeScorer,
            lambda: new_state(confirm_frames=1),
            limits=limits,
        )
        run.begin_case(total_samples=512, speech_intervals=())
        run.feed(constant_pcm(6000, 1))
        run.end_case()
        report = run.finish()
        self.assertEqual(report["cases"]["limited"], 1)
        self.assertEqual(report["cases"]["fallback"], 0)
        self.assertEqual(report["events"]["candidate"], 0)

    def test_invalid_scorer_output_is_a_fixed_fallback(self):
        for value in (math.nan, math.inf, -0.1, 1.1, True):
            with self.subTest(value=value):
                run = evaluator.OfflineVadEvaluator(
                    lambda: SequenceScorer((value,)), new_state
                )
                run.begin_case(total_samples=512, speech_intervals=())
                run.feed(bytes(1024))
                run.end_case()
                report = run.finish()
                self.assertEqual(report["cases"]["fallback"], 1)
                self.assertEqual(report["frames"]["evaluated"], 0)

    def test_tail_bounds_and_lifecycle_fail_closed(self):
        pcm = constant_pcm(0, 1, tail_samples=88)
        report = evaluate_case(pcm, ())
        self.assertEqual(report["cases"]["tail"], 1)
        self.assertEqual(report["frames"]["evaluated"], 1)

        limits = evaluator.EvaluatorLimits(max_cases=1)
        run = evaluator.OfflineVadEvaluator(AmplitudeScorer, new_state, limits=limits)
        with self.assertRaises(evaluator.VadEvaluationError):
            run.begin_case(total_samples=0, speech_intervals=())
        with self.assertRaises(evaluator.VadEvaluationError):
            run.begin_case(total_samples=512, speech_intervals=((0, 513),))
        run.begin_case(total_samples=512, speech_intervals=())
        with self.assertRaises(evaluator.VadEvaluationError):
            run.feed(bytes(1025))
        run.end_case()
        partial = run.finish()
        self.assertEqual(partial["cases"]["limited"], 1)
        with self.assertRaises(evaluator.VadEvaluationError):
            run.begin_case(total_samples=512, speech_intervals=())
        run.close()
        run.close()

    def test_abort_finish_and_close_active_have_fixed_lifecycle_semantics(self):
        aborted = evaluator.OfflineVadEvaluator(AmplitudeScorer, new_state)
        aborted.begin_case(total_samples=512, speech_intervals=())
        aborted.abort_case()
        report = aborted.finish()
        self.assertEqual(report["cases"]["limited"], 1)
        with self.assertRaisesRegex(
            evaluator.VadEvaluationError, "^evaluator-finished$"
        ):
            aborted.finish()

        scorer = TrackedScorer()
        closed = evaluator.OfflineVadEvaluator(lambda: scorer, new_state)
        closed.begin_case(total_samples=512, speech_intervals=())
        closed.close()
        closed.close()
        self.assertEqual(scorer.close_count, 1)
        with self.assertRaisesRegex(
            evaluator.VadEvaluationError, "^evaluator-closed$"
        ):
            closed.finish()

    def test_report_schema_is_constant_size_and_privacy_safe(self):
        report = evaluate_case(constant_pcm(0, 2), ())
        serialized = json.dumps(report, sort_keys=True, separators=(",", ":"))
        self.assertLess(len(serialized), 4096)
        lowered = serialized.lower()
        for forbidden in evaluator.REPORT_FORBIDDEN_WORDS:
            self.assertNotIn(forbidden, lowered)
        self.assertNotIn("[]", serialized)

    def test_max_case_count_report_stays_fixed_and_small(self):
        limits = evaluator.EvaluatorLimits(max_cases=evaluator.HARD_MAX_CASES)
        run = evaluator.OfflineVadEvaluator(AmplitudeScorer, new_state, limits=limits)
        for _ in range(evaluator.HARD_MAX_CASES):
            run.begin_case(total_samples=512, speech_intervals=())
            run.feed(bytes(1024))
            run.end_case()
        report = run.finish()
        serialized = json.dumps(report, sort_keys=True, separators=(",", ":"))
        self.assertEqual(report["cases"]["seen"], evaluator.HARD_MAX_CASES)
        self.assertEqual(report["cases"]["evaluated"], evaluator.HARD_MAX_CASES)
        self.assertLess(len(serialized), 4096)
        lowered = serialized.lower()
        for forbidden in evaluator.REPORT_FORBIDDEN_WORDS:
            self.assertNotIn(forbidden, lowered)


if __name__ == "__main__":
    unittest.main()
