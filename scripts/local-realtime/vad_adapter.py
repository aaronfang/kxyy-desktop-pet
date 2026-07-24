"""Pure, bounded foundations for an optional neural VAD adapter.

This module deliberately has no model/runtime dependency and is not wired into the
live Session yet.  It owns only PCM framing, probability hysteresis, generation
isolation, and fail-closed fallback signalling.  It never logs or retains emitted
PCM frames.
"""

from dataclasses import dataclass
from collections import deque
import math
import queue
import threading
import time
from typing import Callable, Optional, Tuple, Union


PCM16_BYTES_PER_SAMPLE = 2
DEFAULT_FRAME_SAMPLES = 512
DEFAULT_MAX_INPUT_FRAMES = 64
MAX_FRAME_SAMPLES = 16000
MAX_INPUT_FRAMES = 64
VAD_EVENTS = frozenset(("candidate", "confirmed", "rejected", "ended"))
SHADOW_QUEUE_CAPACITY = 1
SHADOW_LATENCY_SAMPLES = 64
SHADOW_COUNTER_MAX = (1 << 53) - 1
SHADOW_MAX_INPUT_BYTES = (
    DEFAULT_FRAME_SAMPLES * PCM16_BYTES_PER_SAMPLE * DEFAULT_MAX_INPUT_FRAMES
)
VAD_SHADOW_ADMISSION = threading.BoundedSemaphore(1)
_SHADOW_STOP = object()


def _positive_int(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _generation(value):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("generation must be a non-negative integer")
    return value


class Pcm16FrameAssembler:
    """Reassembles arbitrary PCM16LE chunks into fixed-size frames.

    A single input is capped, returned frames are capped by the same limit, and the
    only retained audio is an incomplete remainder shorter than one frame.
    """

    def __init__(
        self,
        frame_samples=DEFAULT_FRAME_SAMPLES,
        max_input_frames=DEFAULT_MAX_INPUT_FRAMES,
    ):
        self.frame_samples = _positive_int(frame_samples, "frame_samples")
        self.max_input_frames = _positive_int(
            max_input_frames, "max_input_frames"
        )
        if self.frame_samples > MAX_FRAME_SAMPLES:
            raise ValueError("frame_samples exceeds the fixed hard limit")
        if self.max_input_frames > MAX_INPUT_FRAMES:
            raise ValueError("max_input_frames exceeds the fixed hard limit")
        self.frame_bytes = self.frame_samples * PCM16_BYTES_PER_SAMPLE
        self.max_input_bytes = self.frame_bytes * self.max_input_frames
        self._pending = bytearray()

    @property
    def pending_byte_count(self):
        return len(self._pending)

    @property
    def pending_sample_count(self):
        return len(self._pending) // PCM16_BYTES_PER_SAMPLE

    def _coerce_input(self, pcm):
        if not isinstance(pcm, (bytes, bytearray, memoryview)):
            raise TypeError("pcm must be bytes-like")
        input_bytes = memoryview(pcm).nbytes
        if input_bytes > self.max_input_bytes:
            raise ValueError("pcm input exceeds the fixed per-call limit")
        return bytes(pcm)

    def validate_input(self, pcm):
        """Validate a chunk without changing or retaining assembler state."""

        return self._coerce_input(pcm)

    def push(self, pcm):
        data = self._coerce_input(pcm)
        if not data:
            return ()

        joined = bytes(self._pending) + data
        complete_bytes = (len(joined) // self.frame_bytes) * self.frame_bytes
        frames = tuple(
            joined[offset : offset + self.frame_bytes]
            for offset in range(0, complete_bytes, self.frame_bytes)
        )
        self._pending.clear()
        self._pending.extend(joined[complete_bytes:])
        return frames

    def reset(self):
        self._pending.clear()


class ProbabilityVadState:
    """Pure probability hysteresis with explicit tuning inputs and no defaults."""

    def __init__(
        self,
        *,
        speech_threshold,
        release_threshold,
        confirm_frames,
        reject_frames,
        end_frames,
    ):
        if isinstance(speech_threshold, (bool, str, bytes)) or isinstance(
            release_threshold, (bool, str, bytes)
        ):
            raise ValueError("VAD thresholds must be numeric")
        try:
            speech_threshold = float(speech_threshold)
            release_threshold = float(release_threshold)
        except (TypeError, ValueError) as error:
            raise ValueError("VAD thresholds must be numeric") from error
        if not (
            math.isfinite(release_threshold)
            and math.isfinite(speech_threshold)
            and 0.0 <= release_threshold < speech_threshold <= 1.0
        ):
            raise ValueError("VAD thresholds must satisfy 0 <= release < speech <= 1")

        self.speech_threshold = speech_threshold
        self.release_threshold = release_threshold
        self.confirm_frames = _positive_int(confirm_frames, "confirm_frames")
        self.reject_frames = _positive_int(reject_frames, "reject_frames")
        self.end_frames = _positive_int(end_frames, "end_frames")
        self.reset()

    @staticmethod
    def _probability(value):
        if isinstance(value, (bool, str, bytes)):
            raise ValueError("probability must be finite and between 0 and 1")
        try:
            probability = float(value)
        except (TypeError, ValueError) as error:
            raise ValueError(
                "probability must be finite and between 0 and 1"
            ) from error
        if not math.isfinite(probability) or not 0.0 <= probability <= 1.0:
            raise ValueError("probability must be finite and between 0 and 1")
        return probability

    def reset(self):
        self._phase = "idle"
        self._high_streak = 0
        self._low_streak = 0

    def update(self, value):
        probability = self._probability(value)
        is_high = probability >= self.speech_threshold
        is_low = probability <= self.release_threshold
        events = []

        if self._phase == "idle":
            self._low_streak = 0
            if is_high:
                self._phase = "candidate"
                self._high_streak = 1
                events.append("candidate")
                if self._high_streak >= self.confirm_frames:
                    self._phase = "confirmed"
                    self._high_streak = 0
                    events.append("confirmed")
            else:
                self._high_streak = 0
            return tuple(events)

        if is_high:
            self._low_streak = 0
            if self._phase == "candidate":
                self._high_streak = min(
                    self.confirm_frames, self._high_streak + 1
                )
                if self._high_streak >= self.confirm_frames:
                    self._phase = "confirmed"
                    self._high_streak = 0
                    events.append("confirmed")
        elif is_low:
            self._high_streak = 0
            if self._phase == "candidate":
                self._low_streak = min(self.reject_frames, self._low_streak + 1)
                if self._low_streak >= self.reject_frames:
                    self._phase = "idle"
                    self._low_streak = 0
                    events.append("rejected")
            elif self._phase == "confirmed":
                self._low_streak = min(self.end_frames, self._low_streak + 1)
                if self._low_streak >= self.end_frames:
                    self._phase = "idle"
                    self._low_streak = 0
                    events.append("ended")
        else:
            # The hysteresis band retains the phase but breaks consecutive runs.
            self._high_streak = 0
            self._low_streak = 0

        return tuple(events)


@dataclass(frozen=True)
class VadObservation:
    generation: int
    end_sample: int
    probability: float
    events: Tuple[str, ...]
    status: str = "ready"


@dataclass(frozen=True)
class VadFallback:
    generation: int
    reason: str = "provider-unavailable"
    status: str = "fallback"


VadPipelineResult = Union[VadObservation, VadFallback]


class NeuralVadPipeline:
    """Injectable synchronous scorer wrapper with bounded state and epoch isolation.

    ``scorer`` is a callable accepting exactly one 512-sample PCM16LE frame and
    returning a probability.  A real model is intentionally not bundled yet.
    """

    def __init__(
        self,
        scorer: Optional[Callable[[bytes], float]],
        state: ProbabilityVadState,
        *,
        frame_samples=DEFAULT_FRAME_SAMPLES,
        max_input_frames=DEFAULT_MAX_INPUT_FRAMES,
    ):
        if not isinstance(state, ProbabilityVadState):
            raise TypeError("state must be ProbabilityVadState")
        if scorer is not None and not callable(scorer):
            raise TypeError("scorer must be callable or None")
        self.scorer = scorer
        self.state = state
        self.assembler = Pcm16FrameAssembler(frame_samples, max_input_frames)
        self.generation = None
        self._last_generation = None
        self._end_sample = 0
        self._disabled = scorer is None
        self._fallback_emitted = False
        self._feeding = False
        self._reentrant_fault = False
        self._transitioning = False

    def _reset_scorer(self):
        reset = getattr(self.scorer, "reset", None)
        if callable(reset):
            reset()

    def reset(self, generation):
        generation = _generation(generation)
        if self._transitioning:
            raise RuntimeError("VAD pipeline transition is already active")
        if self._last_generation is not None and generation <= self._last_generation:
            raise ValueError("generation must increase on reset")

        self._transitioning = True
        try:
            self.assembler.reset()
            self.state.reset()
            self._end_sample = 0
            self._fallback_emitted = False
            self._disabled = self.scorer is None
            self._reentrant_fault = False
            if not self._disabled:
                try:
                    self._reset_scorer()
                except Exception:
                    self._disabled = True
            self.generation = generation
            self._last_generation = generation
        finally:
            self._transitioning = False

    def close(self):
        """Idempotently clear retained state at hangup/disconnect boundaries."""

        if self._transitioning:
            raise RuntimeError("VAD pipeline transition is already active")
        self._transitioning = True
        try:
            self.generation = None
            self.assembler.reset()
            self.state.reset()
            self._end_sample = 0
            self._disabled = True
            self._fallback_emitted = True
            self._reentrant_fault = False
            try:
                self._reset_scorer()
            except Exception:
                pass
        finally:
            self._transitioning = False

    def _fallback(self, generation):
        if self._fallback_emitted:
            return ()
        self._fallback_emitted = True
        return (VadFallback(generation=generation),)

    def _disable(self, generation):
        self._disabled = True
        self.assembler.reset()
        self.state.reset()
        self._end_sample = 0
        self._transitioning = True
        try:
            try:
                self._reset_scorer()
            except Exception:
                pass
        finally:
            self._transitioning = False
        return self._fallback(generation)

    def feed(self, pcm, *, generation):
        generation = _generation(generation)
        if self._transitioning:
            return ()
        if self.generation is None:
            raise RuntimeError("reset(generation) must be called before feed")
        if generation != self.generation:
            return ()
        if self._feeding:
            # The outer feed owns the only result channel, so it reports fallback.
            self._reentrant_fault = True
            return ()
        data = self.assembler.validate_input(pcm)
        if self._disabled:
            return self._fallback(generation)

        self._feeding = True
        self._reentrant_fault = False
        try:
            frames = self.assembler.push(data)
            observations = []
            epoch = self.generation
            for frame in frames:
                try:
                    probability = self.state._probability(self.scorer(frame))
                except Exception:
                    if self.generation != epoch:
                        return ()
                    return self._disable(generation)

                if self._reentrant_fault:
                    return self._disable(generation)
                # A scorer may be replaced by an asynchronous adapter later.  This
                # second epoch check also rejects deterministic re-entrant resets.
                if self.generation != epoch:
                    return ()
                events = self.state.update(probability)
                self._end_sample += self.assembler.frame_samples
                observations.append(
                    VadObservation(
                        generation=generation,
                        end_sample=self._end_sample,
                        probability=probability,
                        events=events,
                    )
                )
            return tuple(observations)
        finally:
            self._feeding = False


def _saturating_add(value, amount=1):
    return min(SHADOW_COUNTER_MAX, value + max(0, int(amount)))


def _percentile(values, percentile):
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil((percentile / 100.0) * len(ordered)) - 1)
    return round(ordered[index], 3)


class VadShadowWorker:
    """Single-lane, queue=1 shadow runner that never owns live VAD decisions.

    The factory, scorer, pipeline state, and PCM assembly are touched only by the
    daemon worker.  Producers never wait.  Overflow advances an epoch and replaces
    the waiting job so discontinuous PCM can never share recurrent/model state.
    """

    def __init__(self, pipeline_factory, admission, monotonic):
        self._pipeline_factory = pipeline_factory
        self._admission = admission
        self._monotonic = monotonic
        self._queue = queue.Queue(maxsize=SHADOW_QUEUE_CAPACITY)
        self._lock = threading.Lock()
        self._closed = False
        self._epoch = 0
        self._status = "starting"
        self._offered = 0
        self._accepted = 0
        self._dropped = 0
        self._processed_jobs = 0
        self._processed_frames = 0
        self._stale_results = 0
        self._fallbacks = 0
        self._faults = 0
        self._max_queue_depth = 0
        self._event_counts = {event: 0 for event in VAD_EVENTS}
        self._latencies_ms = deque(maxlen=SHADOW_LATENCY_SAMPLES)
        self._ready = threading.Event()
        self._terminated = threading.Event()
        self._thread = threading.Thread(
            target=self._run,
            name="kxyy-vad-shadow",
            daemon=True,
        )

    @classmethod
    def try_start(
        cls,
        pipeline_factory,
        *,
        admission=None,
        monotonic=time.perf_counter,
    ):
        if pipeline_factory is None or not callable(pipeline_factory):
            return None
        admission = admission or VAD_SHADOW_ADMISSION
        try:
            acquired = admission.acquire(blocking=False)
        except Exception:
            return None
        if not acquired:
            return None
        worker = cls(pipeline_factory, admission, monotonic)
        try:
            worker._thread.start()
        except Exception:
            admission.release()
            return None
        return worker

    def _increment(self, name, amount=1):
        setattr(self, name, _saturating_add(getattr(self, name), amount))

    def _drain_waiting_locked(self):
        removed = 0
        while True:
            try:
                item = self._queue.get_nowait()
            except queue.Empty:
                break
            if item is not _SHADOW_STOP:
                removed += 1
        if removed:
            self._increment("_dropped", removed)
        return removed

    def begin_epoch(self):
        with self._lock:
            if self._closed or self._terminated.is_set():
                return self._epoch
            self._epoch += 1
            self._drain_waiting_locked()
            if self._status not in ("starting", "unavailable"):
                self._status = "active"
            return self._epoch

    def offer(self, pcm):
        if not isinstance(pcm, (bytes, bytearray, memoryview)):
            input_size = -1
        else:
            input_size = memoryview(pcm).nbytes

        if input_size == 0:
            return False
        valid = 0 < input_size <= SHADOW_MAX_INPUT_BYTES
        data = bytes(pcm) if valid else None
        with self._lock:
            if self._closed or self._terminated.is_set():
                return False
            self._increment("_offered")
            if not valid:
                self._epoch += 1
                self._drain_waiting_locked()
                self._increment("_dropped")
                self._status = "overloaded"
                return False
            job = (self._epoch, data)
            try:
                self._queue.put_nowait(job)
            except queue.Full:
                self._epoch += 1
                self._drain_waiting_locked()
                self._status = "overloaded"
                job = (self._epoch, data)
                try:
                    self._queue.put_nowait(job)
                except queue.Full:
                    self._increment("_dropped")
                    return False
            self._increment("_accepted")
            self._max_queue_depth = max(
                self._max_queue_depth,
                min(SHADOW_QUEUE_CAPACITY, self._queue.qsize()),
            )
            return True

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._epoch += 1
            self._drain_waiting_locked()
            self._status = "closed"
            try:
                self._queue.put_nowait(_SHADOW_STOP)
            except queue.Full:
                # The queue was drained while holding the same producer lock.
                pass

    def wait_ready(self, timeout=None):
        return self._ready.wait(timeout)

    def wait_closed(self, timeout=None):
        return self._terminated.wait(timeout)

    def snapshot(self):
        with self._lock:
            latencies = tuple(self._latencies_ms)
            return {
                "mode": "shadow-v1",
                "status": self._status,
                "epoch": self._epoch,
                "queueCapacity": SHADOW_QUEUE_CAPACITY,
                "maxQueueDepth": self._max_queue_depth,
                "offered": self._offered,
                "accepted": self._accepted,
                "dropped": self._dropped,
                "processedJobs": self._processed_jobs,
                "processedFrames": self._processed_frames,
                "staleResults": self._stale_results,
                "fallbacks": self._fallbacks,
                "faults": self._faults,
                "candidateEvents": self._event_counts["candidate"],
                "confirmedEvents": self._event_counts["confirmed"],
                "rejectedEvents": self._event_counts["rejected"],
                "endedEvents": self._event_counts["ended"],
                "latencySamples": len(latencies),
                "inferenceP50Ms": _percentile(latencies, 50),
                "inferenceP95Ms": _percentile(latencies, 95),
            }

    def _mark_fault(self, epoch):
        with self._lock:
            if self._closed or epoch != self._epoch:
                self._increment("_stale_results")
                return
            self._increment("_faults")
            self._increment("_fallbacks")
            self._status = "faulted"

    def _run(self):
        pipeline = None
        pipeline_epoch = None
        fault_epoch = None
        try:
            try:
                pipeline = self._pipeline_factory()
            except Exception:
                with self._lock:
                    if not self._closed:
                        self._status = "unavailable"
                    self._drain_waiting_locked()
                self._ready.set()
                return

            with self._lock:
                if not self._closed:
                    self._status = "active"
            self._ready.set()

            while True:
                job = self._queue.get()
                if job is _SHADOW_STOP:
                    break
                epoch, pcm = job
                with self._lock:
                    if self._closed or epoch != self._epoch:
                        self._increment("_stale_results")
                        continue
                if fault_epoch == epoch:
                    with self._lock:
                        self._increment("_dropped")
                    continue
                if pipeline_epoch != epoch:
                    try:
                        pipeline.reset(epoch)
                    except Exception:
                        fault_epoch = epoch
                        self._mark_fault(epoch)
                        continue
                    pipeline_epoch = epoch
                    fault_epoch = None

                try:
                    started = self._monotonic()
                    results = pipeline.feed(pcm, generation=epoch)
                    finished = self._monotonic()
                except Exception:
                    fault_epoch = epoch
                    self._mark_fault(epoch)
                    continue

                with self._lock:
                    if self._closed or epoch != self._epoch:
                        self._increment("_stale_results")
                        continue
                    self._increment("_processed_jobs")
                    elapsed_ms = (finished - started) * 1000.0
                    if math.isfinite(elapsed_ms) and elapsed_ms >= 0:
                        self._latencies_ms.append(elapsed_ms)
                    observations = 0
                    fallback_seen = False
                    for result in results:
                        if isinstance(result, VadObservation):
                            observations += 1
                            for event in result.events:
                                if event in self._event_counts:
                                    self._event_counts[event] = _saturating_add(
                                        self._event_counts[event]
                                    )
                        elif isinstance(result, VadFallback):
                            fallback_seen = True
                        else:
                            fallback_seen = True
                    self._increment("_processed_frames", observations)
                    if fallback_seen:
                        self._increment("_fallbacks")
                        self._increment("_faults")
                        self._status = "faulted"
                        fault_epoch = epoch
                    else:
                        self._status = "active"
        finally:
            if pipeline is not None:
                try:
                    pipeline.close()
                except Exception:
                    pass
            try:
                self._admission.release()
            except Exception:
                pass
            self._terminated.set()
