"""Bounded, aggregate-only offline evaluation for injected VAD scorers.

The evaluator is deliberately disconnected from the realtime Session. PCM is
consumed immediately by ``NeuralVadPipeline`` and never retained or returned.
Reports contain only fixed counters, integer rates, and frame-bucket latency.
"""

from dataclasses import dataclass
import math

from vad_adapter import NeuralVadPipeline, VadFallback, VadObservation


FRAME_SAMPLES = 512
MAX_INPUT_FRAMES = 64
MAX_INPUT_BYTES = FRAME_SAMPLES * 2 * MAX_INPUT_FRAMES
COUNTER_MAX = (1 << 53) - 1
HARD_MAX_CASES = 64
HARD_MAX_TOTAL_FRAMES = 262_144
HARD_MAX_FRAMES_PER_CASE = 56_250
HARD_MAX_TRUTH_INTERVALS = 256
HARD_MAX_EVENTS_PER_CASE = 4096
HARD_MAX_MATCH_GRACE_FRAMES = 64
LATENCY_BUCKETS = (0, 1, 2, 3, 4, 5, 8, 12, 16, 24, 32, 64)
EVENT_NAMES = (
    "candidate",
    "confirmed",
    "rejected",
    "ended",
    "candidate_timeout",
)
REPORT_FORBIDDEN_WORDS = (
    "probability",
    "pcm",
    "path",
    "text",
    "persona",
    "transcript",
    "exception",
)


class VadEvaluationError(ValueError):
    """Fixed-reason evaluator error that never includes provider details."""


@dataclass(frozen=True)
class EvaluatorLimits:
    max_cases: int = 32
    max_total_frames: int = 262_144
    max_frames_per_case: int = 56_250
    max_truth_intervals: int = 256
    max_events_per_case: int = 4096
    match_grace_frames: int = 8


def _positive_int(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise VadEvaluationError(f"{name}-invalid")
    return value


def _bounded_add(value, increment=1):
    return min(COUNTER_MAX, value + increment)


def _ceil_frames(samples):
    return max(0, (samples + FRAME_SAMPLES - 1) // FRAME_SAMPLES)


class _LatencyHistogram:
    def __init__(self):
        self.counts = [0] * (len(LATENCY_BUCKETS) + 1)
        self.count = 0
        self.maximum = None

    def add(self, frames):
        frames = max(0, int(frames))
        self.count = _bounded_add(self.count)
        self.maximum = frames if self.maximum is None else max(self.maximum, frames)
        index = len(LATENCY_BUCKETS)
        for candidate, upper in enumerate(LATENCY_BUCKETS):
            if frames <= upper:
                index = candidate
                break
        self.counts[index] = _bounded_add(self.counts[index])

    def _percentile(self, percentile):
        if self.count == 0:
            return None
        rank = max(1, math.ceil(self.count * percentile / 100))
        seen = 0
        for index, count in enumerate(self.counts):
            seen += count
            if seen >= rank:
                if index < len(LATENCY_BUCKETS):
                    return LATENCY_BUCKETS[index]
                return "overflow"
        return "overflow"

    def safe_dict(self):
        return {
            "count": self.count,
            "p50": self._percentile(50),
            "p95": self._percentile(95),
            "max": self.maximum,
            "overLimit": self.counts[-1],
        }

    def merge(self, other):
        self.count = _bounded_add(self.count, other.count)
        if other.maximum is not None:
            self.maximum = (
                other.maximum
                if self.maximum is None
                else max(self.maximum, other.maximum)
            )
        for index, count in enumerate(other.counts):
            self.counts[index] = _bounded_add(self.counts[index], count)

    def clone(self):
        cloned = _LatencyHistogram()
        cloned.counts = list(self.counts)
        cloned.count = self.count
        cloned.maximum = self.maximum
        return cloned


def _new_totals():
    return {
        "cases": {"seen": 0, "evaluated": 0, "fallback": 0, "limited": 0, "tail": 0},
        "frames": {"evaluated": 0, "speech": 0, "nonSpeech": 0},
        "truth": {"segments": 0, "matched": 0, "missed": 0},
        "events": {name: 0 for name in EVENT_NAMES},
        "classification": {
            "falseCandidate": 0,
            "falseConfirmed": 0,
            "recoveredFalseCandidate": 0,
            "earlyEnd": 0,
            "missingEnd": 0,
        },
    }


class OfflineVadEvaluator:
    """Stream bounded cases through an injected scorer and state factory."""

    def __init__(self, scorer_factory, state_factory, *, limits=None):
        if not callable(scorer_factory) or not callable(state_factory):
            raise VadEvaluationError("factory-invalid")
        self.scorer_factory = scorer_factory
        self.state_factory = state_factory
        self.limits = limits or EvaluatorLimits()
        for name in (
            "max_cases",
            "max_total_frames",
            "max_frames_per_case",
            "max_truth_intervals",
            "max_events_per_case",
            "match_grace_frames",
        ):
            _positive_int(getattr(self.limits, name), name)
        hard_limits = {
            "max_cases": HARD_MAX_CASES,
            "max_total_frames": HARD_MAX_TOTAL_FRAMES,
            "max_frames_per_case": HARD_MAX_FRAMES_PER_CASE,
            "max_truth_intervals": HARD_MAX_TRUTH_INTERVALS,
            "max_events_per_case": HARD_MAX_EVENTS_PER_CASE,
            "match_grace_frames": HARD_MAX_MATCH_GRACE_FRAMES,
        }
        for name, hard_limit in hard_limits.items():
            if getattr(self.limits, name) > hard_limit:
                raise VadEvaluationError(f"{name}-limit")
        if self.limits.max_frames_per_case > self.limits.max_total_frames:
            raise VadEvaluationError("frame-limits-invalid")
        self._totals = _new_totals()
        self._latencies = {
            "candidate": _LatencyHistogram(),
            "confirmed": _LatencyHistogram(),
            "rejected": _LatencyHistogram(),
            "ended": _LatencyHistogram(),
        }
        self._reserved_frames = 0
        self._generation = 0
        self._case = None
        self._closed = False
        self._finished = False

    @staticmethod
    def _validate_intervals(intervals, total_samples, limit):
        if not isinstance(intervals, (tuple, list)) or len(intervals) > limit:
            raise VadEvaluationError("truth-invalid")
        normalized = []
        previous_end = None
        for interval in intervals:
            if (
                not isinstance(interval, (tuple, list))
                or len(interval) != 2
                or any(isinstance(value, bool) or not isinstance(value, int) for value in interval)
            ):
                raise VadEvaluationError("truth-invalid")
            start, end = interval
            if (
                start < 0
                or end <= start
                or end > total_samples
                or (previous_end is not None and start <= previous_end)
            ):
                raise VadEvaluationError("truth-invalid")
            normalized.append((start, end))
            previous_end = end
        return tuple(normalized)

    def _require_idle(self):
        if self._closed or self._finished:
            raise VadEvaluationError("evaluator-closed")
        if self._case is not None:
            raise VadEvaluationError("case-active")

    def begin_case(self, *, total_samples, speech_intervals):
        self._require_idle()
        total_samples = _positive_int(total_samples, "total-samples")
        planned_frames = _ceil_frames(total_samples)
        if planned_frames > self.limits.max_frames_per_case:
            raise VadEvaluationError("case-limit")
        if self._totals["cases"]["seen"] >= self.limits.max_cases:
            raise VadEvaluationError("case-limit")
        if self._reserved_frames + planned_frames > self.limits.max_total_frames:
            raise VadEvaluationError("total-limit")
        intervals = self._validate_intervals(
            speech_intervals, total_samples, self.limits.max_truth_intervals
        )

        self._reserved_frames += planned_frames
        self._totals["cases"]["seen"] = _bounded_add(
            self._totals["cases"]["seen"]
        )
        self._generation += 1
        case = {
            "totalSamples": total_samples,
            "expectedBytes": total_samples * 2,
            "fedBytes": 0,
            "intervals": intervals,
            "events": [],
            "frameEnds": [],
            "pipeline": None,
            "failure": None,
        }
        self._case = case
        scorer = None
        pipeline = None
        try:
            scorer = self.scorer_factory()
            state = self.state_factory()
            pipeline = NeuralVadPipeline(scorer, state)
            pipeline.reset(self._generation)
            case["pipeline"] = pipeline
        except Exception:
            case["failure"] = "fallback"
            if pipeline is not None:
                try:
                    pipeline.close()
                except Exception:
                    pass
            elif scorer is not None:
                try:
                    close = getattr(scorer, "close", None)
                    reset = getattr(scorer, "reset", None)
                    if callable(close):
                        close()
                    elif callable(reset):
                        reset()
                except Exception:
                    pass

    def _fail_case(self, reason):
        case = self._case
        if case is None or case["failure"] is not None:
            return
        case["failure"] = reason
        case["events"].clear()
        case["frameEnds"].clear()

    def feed(self, pcm):
        if self._case is None or self._closed or self._finished:
            raise VadEvaluationError("case-inactive")
        case = self._case
        if case["failure"] is not None:
            return
        if not isinstance(pcm, (bytes, bytearray, memoryview)):
            self._fail_case("limited")
            raise VadEvaluationError("input-invalid")
        input_bytes = memoryview(pcm).nbytes
        if input_bytes > MAX_INPUT_BYTES:
            self._fail_case("limited")
            raise VadEvaluationError("input-limit")
        if case["fedBytes"] + input_bytes > case["expectedBytes"]:
            self._fail_case("limited")
            raise VadEvaluationError("case-limit")
        case["fedBytes"] += input_bytes
        try:
            results = case["pipeline"].feed(pcm, generation=self._generation)
        except Exception:
            self._fail_case("fallback")
            return
        for result in results:
            if isinstance(result, VadFallback):
                self._fail_case("fallback")
                return
            if not isinstance(result, VadObservation):
                self._fail_case("fallback")
                return
            if len(case["events"]) + len(result.events) > self.limits.max_events_per_case:
                self._fail_case("limited")
                return
            case["frameEnds"].append(result.end_sample)
            case["events"].extend((event, result.end_sample) for event in result.events)

    @staticmethod
    def _inside_truth(sample, intervals, grace_samples=0):
        return any(start < sample <= end + grace_samples for start, end in intervals)

    def _merge_case(self, case):
        intervals = case["intervals"]
        events = case["events"]
        event_lists = {
            name: [sample for event, sample in events if event == name]
            for name in EVENT_NAMES
        }
        local = _new_totals()
        local_latencies = {
            name: _LatencyHistogram() for name in self._latencies
        }
        local["cases"]["evaluated"] = 1
        local["cases"]["tail"] = 1 if case.get("tail") else 0
        local["frames"]["evaluated"] = len(case["frameEnds"])
        local["truth"]["segments"] = len(intervals)
        for name, samples in event_lists.items():
            local["events"][name] = len(samples)

        for end_sample in case["frameEnds"]:
            frame_start = max(0, end_sample - FRAME_SAMPLES)
            speech = any(frame_start < end and end_sample > start for start, end in intervals)
            key = "speech" if speech else "nonSpeech"
            local["frames"][key] += 1

        used_candidates = set()
        used_confirmed = set()
        used_ended = set()
        grace = self.limits.match_grace_frames * FRAME_SAMPLES
        for truth_index, (start, end) in enumerate(intervals):
            next_start = (
                intervals[truth_index + 1][0]
                if truth_index + 1 < len(intervals)
                else case["totalSamples"] + grace
            )
            confirm_match = next(
                (
                    index
                    for index, sample in enumerate(event_lists["confirmed"])
                    if index not in used_confirmed
                    and start < sample <= end + grace
                    and sample < next_start
                ),
                None,
            )
            if confirm_match is None:
                local["truth"]["missed"] += 1
                continue
            used_confirmed.add(confirm_match)
            local["truth"]["matched"] += 1
            confirm_sample = event_lists["confirmed"][confirm_match]
            local_latencies["confirmed"].add(_ceil_frames(confirm_sample - start))

            candidate_match = next(
                (
                    index
                    for index, sample in enumerate(event_lists["candidate"])
                    if index not in used_candidates and start < sample <= confirm_sample
                ),
                None,
            )
            if candidate_match is not None:
                used_candidates.add(candidate_match)
                local_latencies["candidate"].add(
                    _ceil_frames(event_lists["candidate"][candidate_match] - start)
                )

            early = [
                (index, sample)
                for index, sample in enumerate(event_lists["ended"])
                if index not in used_ended and confirm_sample <= sample < end
            ]
            if early:
                index, _sample = early[0]
                used_ended.add(index)
                local["classification"]["earlyEnd"] += 1
            end_match = next(
                (
                    index
                    for index, sample in enumerate(event_lists["ended"])
                    if index not in used_ended and end <= sample <= next_start
                ),
                None,
            )
            if end_match is None:
                local["classification"]["missingEnd"] += 1
            else:
                used_ended.add(end_match)
                local_latencies["ended"].add(
                    _ceil_frames(event_lists["ended"][end_match] - end)
                )

        for index, sample in enumerate(event_lists["candidate"]):
            if index in used_candidates:
                continue
            if not self._inside_truth(sample, intervals, grace):
                local["classification"]["falseCandidate"] += 1
                later_terminal = next(
                    (
                        event
                        for event, event_sample in events
                        if event_sample >= sample
                        and event in ("confirmed", "rejected", "candidate_timeout")
                    ),
                    None,
                )
                if later_terminal in ("rejected", "candidate_timeout"):
                    local["classification"]["recoveredFalseCandidate"] += 1

        local["classification"]["falseConfirmed"] = max(
            0, len(event_lists["confirmed"]) - len(used_confirmed)
        )

        active_candidate = None
        for event, sample in events:
            if event == "candidate":
                active_candidate = sample
            elif event == "rejected" and active_candidate is not None:
                local_latencies["rejected"].add(
                    _ceil_frames(sample - active_candidate)
                )
                active_candidate = None
            elif event in ("confirmed", "candidate_timeout"):
                active_candidate = None

        next_totals = {
            group: dict(values) for group, values in self._totals.items()
        }
        next_latencies = {
            name: histogram.clone()
            for name, histogram in self._latencies.items()
        }
        for group in ("cases", "frames", "truth", "events", "classification"):
            for key, value in local[group].items():
                next_totals[group][key] = _bounded_add(
                    next_totals[group][key], value
                )
        for name, histogram in local_latencies.items():
            next_latencies[name].merge(histogram)
        self._totals = next_totals
        self._latencies = next_latencies

    def end_case(self):
        if self._case is None or self._closed or self._finished:
            raise VadEvaluationError("case-inactive")
        case = self._case
        pipeline = case["pipeline"]
        if case["failure"] is None and case["fedBytes"] != case["expectedBytes"]:
            self._fail_case("limited")
        tail = 0
        if pipeline is not None:
            tail = pipeline.assembler.pending_byte_count
            try:
                pipeline.close()
            except Exception:
                if case["failure"] is None:
                    self._fail_case("fallback")

        try:
            if case["failure"] == "fallback":
                self._totals["cases"]["fallback"] = _bounded_add(
                    self._totals["cases"]["fallback"]
                )
            elif case["failure"] == "limited":
                self._totals["cases"]["limited"] = _bounded_add(
                    self._totals["cases"]["limited"]
                )
            else:
                case["tail"] = bool(tail)
                try:
                    self._merge_case(case)
                except Exception:
                    self._totals["cases"]["fallback"] = _bounded_add(
                        self._totals["cases"]["fallback"]
                    )
        finally:
            self._case = None

    def abort_case(self):
        if self._case is None or self._closed or self._finished:
            raise VadEvaluationError("case-inactive")
        self._fail_case("limited")
        self.end_case()

    @staticmethod
    def _rate_ppm(numerator, denominator):
        if denominator <= 0:
            return None
        return min(1_000_000, (numerator * 1_000_000) // denominator)

    def finish(self):
        if self._case is not None:
            raise VadEvaluationError("case-active")
        if self._closed:
            raise VadEvaluationError("evaluator-closed")
        if self._finished:
            raise VadEvaluationError("evaluator-finished")
        self._finished = True
        cases = self._totals["cases"]
        truth = self._totals["truth"]
        events = self._totals["events"]
        classification = self._totals["classification"]
        report = {
            "schemaVersion": 1,
            "configRevision": "vad-eval-v1",
            "status": "partial" if cases["fallback"] or cases["limited"] else "complete",
            "cases": dict(cases),
            "frames": dict(self._totals["frames"]),
            "truth": dict(truth),
            "events": dict(events),
            "classification": dict(classification),
            "ratesPpm": {
                "segmentRecall": self._rate_ppm(truth["matched"], truth["segments"]),
                "falseConfirmed": self._rate_ppm(
                    classification["falseConfirmed"], events["confirmed"]
                ),
            },
            "latencyFrames": {
                name: histogram.safe_dict()
                for name, histogram in self._latencies.items()
            },
        }
        serialized_keys = " ".join(str(key).lower() for key in self._walk_keys(report))
        if any(word in serialized_keys for word in REPORT_FORBIDDEN_WORDS):
            raise VadEvaluationError("report-schema-invalid")
        return report

    @classmethod
    def _walk_keys(cls, value):
        if isinstance(value, dict):
            for key, child in value.items():
                yield key
                yield from cls._walk_keys(child)
        elif isinstance(value, (tuple, list)):
            for child in value:
                yield from cls._walk_keys(child)

    def close(self):
        if self._closed:
            return
        if self._case is not None:
            pipeline = self._case.get("pipeline")
            if pipeline is not None:
                try:
                    pipeline.close()
                except Exception:
                    pass
            self._case = None
        self._closed = True
