"""Pure, bounded foundations for an optional neural VAD adapter.

This module deliberately has no model/runtime dependency and is not wired into the
live Session yet.  It owns only PCM framing, probability hysteresis, generation
isolation, and fail-closed fallback signalling.  It never logs or retains emitted
PCM frames.
"""

from dataclasses import dataclass
import math
from typing import Callable, Optional, Tuple, Union


PCM16_BYTES_PER_SAMPLE = 2
DEFAULT_FRAME_SAMPLES = 512
DEFAULT_MAX_INPUT_FRAMES = 64
MAX_FRAME_SAMPLES = 16000
MAX_INPUT_FRAMES = 64
VAD_EVENTS = frozenset(("candidate", "confirmed", "rejected", "ended"))


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
